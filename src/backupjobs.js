// Backup runs: the scheduler, manual backups, monitoring and the clean-up of backups
// whose server is gone (see backups.js for servers, storages, keys and policies).
//
//   Window     scheduled backups start only inside the backup window (panel time zone).
//              A window belongs to the date it started on (window_key), so a window
//              of 22:00 to 04:00 is one run per server, not two.
//   Due        a server with a policy (plan, add-on or default; not excluded) and no
//              successful or running scheduled run in this window; weekly policies on
//              their day only. A failed run is tried once more in the same window.
//   Load       at most parallelPerNode backups per node at a time; bandwidth per job.
//   Retention  Proxmox prunes after each backup (prune-backups from the policy).
//   Orphans    backups on a customer's storage of a server that is no longer theirs:
//              removed keepAfterDeleteDays (default 14) after the panel first saw them.

import { db, audit } from './db.js';
import { pve, clusterGuests } from './pve.js';
import { partsIn } from './clock.js';
import { backupSettings, storageFor, policyOfServer, pruneOf } from './backups.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const RETRIES = 1;
const RETRY_DELAY_MS = Number(process.env.BACKUP_RETRY_DELAY_SECONDS ?? 900) * 1000;
const LOST_AFTER_MS = 12 * 3600_000;          // a run Proxmox can't tell us about any more
const pad = (n) => String(n).padStart(2, '0');
const nowIso = () => new Date().toISOString();
const short = (m) => String(m ?? 'unknown error').slice(0, 300);

// ---- Window -------------------------------------------------------------------------------

/** The window open at `date` ({ key: 'YYYY-MM-DD' of its start, wd }) or null. */
export function openWindow(s, date = new Date()) {
  const { h } = partsIn(date);
  const a = s.windowStart; const b = s.windowEnd;
  const inside = b > a ? h >= a && h < b : h >= a || h < b;
  if (!inside) return null;
  const start = b < a && h < b ? new Date(date.getTime() - 24 * 3600_000) : date;
  const p = partsIn(start);
  return { key: `${p.y}-${pad(p.m)}-${pad(p.d)}`, wd: p.wd };
}

// ---- Starting a run ------------------------------------------------------------------------

const insertRun = (r) => Number(db.prepare(`INSERT INTO backup_runs
  (vmid, user_id, cluster_id, node, storage, policy_id, kind, window_key, state, upid, error, started_by, started_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.vmid, r.userId, r.clusterId, r.node ?? null, r.storage ?? null, r.policyId ?? null,
  r.kind, r.windowKey ?? null, r.state, r.upid ?? null, r.error ?? null, r.startedBy ?? null, nowIso(), r.state === 'failed' ? nowIso() : null).lastInsertRowid);

/** Starts vzdump for a server; records the run (failed straight away if it can't start). */
export async function startRun(row, guest, policy, { kind, windowKey = null, startedBy = null }) {
  const clusterId = Number(guest.cluster ?? 0);
  const base = { vmid: row.vmid, userId: row.user_id, clusterId, node: guest.node, policyId: policy?.id ?? null, kind, windowKey, startedBy };
  let storage = null;
  try {
    ({ storage } = await storageFor(row.user_id, clusterId));
    const s = backupSettings();
    const params = {
      vmid: row.vmid, storage, mode: 'snapshot', 'notes-template': '{{guestname}}',
      'prune-backups': policy ? pruneOf(policy) : 'keep-all=1',
      ...(s.bwlimitMBs ? { bwlimit: s.bwlimitMBs * 1024 } : {}),      // KiB/s
    };
    const upid = await pve.on(clusterId).post(`/nodes/${encodeURIComponent(guest.node)}/vzdump`, params);
    const id = insertRun({ ...base, storage, state: 'running', upid });
    return db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id);
  } catch (err) {
    const id = insertRun({ ...base, storage, state: 'failed', error: short(err.message) });
    audit({ account: { id: row.user_id }, ip: 'backup' }, row.vmid, 'backup_failed', { kind, error: short(err.message) });
    return db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id);
  }
}

/** The customer's own backups of a server in the last 24 hours (not administrators'). */
export const manualUsed = (row) => db.prepare("SELECT COUNT(*) AS n FROM backup_runs WHERE vmid = ? AND kind = 'manual' AND started_by = ? AND state != 'failed' AND started_at >= ?")
  .get(row.vmid, row.user_id, new Date(Date.now() - 24 * 3600_000).toISOString()).n;

const running = (vmid) => db.prepare("SELECT 1 FROM backup_runs WHERE vmid = ? AND state = 'running'").get(vmid);

/**
 * A backup outside the schedule. Customers: limited to manualPerDay per server (a day =
 * the last 24 hours) and only with a policy. Administrators: no limit; without a
 * policy nothing is pruned.
 */
export async function backupNow(req, row, { byCustomer = false } = {}) {
  const s = backupSettings();
  if (!s.enabled) throw fail(409, 'Backups are switched off');
  if (row.state !== 'ready') throw fail(409, 'The server is busy (being set up or changed)');
  if (row.expired_at) throw fail(409, 'The server has expired');
  const policy = policyOfServer(row);
  if (byCustomer && !policy) throw fail(409, 'This server has no backup plan');
  if (running(row.vmid)) throw fail(409, 'A backup of this server is running already');
  if (byCustomer) {
    const n = manualUsed(row);
    if (n >= s.manualPerDay) throw fail(429, s.manualPerDay ? `Up to ${s.manualPerDay} backups of your own per server a day` : 'Backups of your own are not offered');
  }
  const guest = (await clusterGuests(true)).get(row.vmid);
  if (!guest) throw fail(404, 'The server was not found');
  const run = await startRun(row, guest, policy, { kind: 'manual', startedBy: req.account?.id ?? null });
  audit(req, row.vmid, byCustomer ? 'backup_manual' : 'admin_backup_manual', { run: run.id, state: run.state });
  if (run.state === 'failed') throw fail(409, `The backup could not start: ${run.error}`);
  return pubRun(run);
}

// ---- Following runs --------------------------------------------------------------------------

export async function follow(run) {
  const node = String(run.upid).split(':')[1] ?? run.node;
  const api = pve.on(run.cluster_id);
  let st;
  try {
    st = await api.get(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(run.upid)}/status`);
  } catch (err) {
    if (Date.now() - Date.parse(run.started_at) < LOST_AFTER_MS) return;
    st = { status: 'stopped', exitstatus: `Lost track of the task: ${err.message}` };
  }
  if (st.status !== 'stopped') return;
  const exit = String(st.exitstatus ?? '');
  if (exit === 'OK' || exit.startsWith('WARNINGS')) {
    let newest = null;
    try {
      const list = await api.get(`/nodes/${encodeURIComponent(run.node)}/storage/${encodeURIComponent(run.storage)}/content`, { vmid: run.vmid });
      newest = (list ?? []).filter((b) => b.content === 'backup' || !b.content).sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0))[0] ?? null;
    } catch { /* the run counts; the volume shows up in the list later */ }
    db.prepare("UPDATE backup_runs SET state = 'ok', volid = ?, size = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(newest?.volid ?? null, newest?.size ?? null, exit.startsWith('WARNINGS') ? exit : null, nowIso(), run.id);
    audit({ account: { id: run.user_id }, ip: 'backup' }, run.vmid, 'backup_done', { run: run.id, kind: run.kind, volid: newest?.volid ?? null });
  } else {
    db.prepare("UPDATE backup_runs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(short(exit || 'failed'), nowIso(), run.id);
    audit({ account: { id: run.user_id }, ip: 'backup' }, run.vmid, 'backup_failed', { run: run.id, kind: run.kind, error: short(exit) });
  }
}

// ---- Scheduler ------------------------------------------------------------------------------

/** Servers due in this window, with their policy (oldest last success first). */
function dueServers(win) {
  const out = [];
  const rows = db.prepare("SELECT * FROM vms WHERE backup_excluded = 0 AND state = 'ready' AND expired_at IS NULL ORDER BY vmid").all();
  for (const row of rows) {
    const policy = policyOfServer(row);
    if (!policy) continue;
    if (policy.frequency === 'weekly' && policy.weekday !== win.wd) continue;
    const runs = db.prepare("SELECT state, finished_at FROM backup_runs WHERE vmid = ? AND kind = 'scheduled' AND window_key = ?").all(row.vmid, win.key);
    if (runs.some((r) => r.state === 'ok' || r.state === 'running')) continue;
    const failed = runs.filter((r) => r.state === 'failed');
    if (failed.length > RETRIES) continue;
    if (failed.length && Date.now() - Math.max(...failed.map((r) => Date.parse(r.finished_at) || 0)) < RETRY_DELAY_MS) continue;
    if (running(row.vmid)) continue;                       // a manual one is on
    const last = db.prepare("SELECT MAX(finished_at) AS at FROM backup_runs WHERE vmid = ? AND state = 'ok'").get(row.vmid).at;
    out.push({ row, policy, last: last ?? '' });
  }
  return out.sort((a, b) => a.last.localeCompare(b.last));
}

let busy = false;
let lastPurge = 0;
export async function tickBackups(log, now = new Date()) {
  if (busy) return;
  busy = true;
  try {
    for (const run of db.prepare("SELECT * FROM backup_runs WHERE state = 'running'").all()) {
      await follow(run).catch((err) => log?.warn(`Backup run ${run.id}: ${err.message}`));
    }
    const s = backupSettings();
    if (!s.enabled) return;
    const win = openWindow(s, now);
    if (!win) return;
    const due = dueServers(win);
    if (due.length) {
      const guests = await clusterGuests(true);
      const load = new Map();
      for (const r of db.prepare("SELECT cluster_id, node, COUNT(*) AS n FROM backup_runs WHERE state = 'running' GROUP BY cluster_id, node").all()) load.set(`${r.cluster_id}/${r.node}`, r.n);
      for (const { row, policy } of due) {
        const guest = guests.get(row.vmid);
        if (!guest || guest.template) continue;
        const k = `${Number(guest.cluster ?? 0)}/${guest.node}`;
        if ((load.get(k) ?? 0) >= s.parallelPerNode) continue;
        const run = await startRun(row, guest, policy, { kind: 'scheduled', windowKey: win.key });
        if (run.state === 'running') load.set(k, (load.get(k) ?? 0) + 1);
        else log?.warn(`Backup of ${row.vmid} could not start: ${run.error}`);
      }
    }
    if (Date.now() - lastPurge > PURGE_EVERY_MS) {
      lastPurge = Date.now();
      await purgeOrphans(log).catch((err) => log?.warn(`Backup clean-up: ${err.message}`));
    }
  } finally {
    busy = false;
  }
}

export function startBackupScheduler(log) {
  // restores cut short by a restart: the server needs a look
  const cut = db.prepare("UPDATE vms SET state = 'failed', progress = NULL, error = 'Restoring was interrupted (the panel restarted); restore again or ask support' WHERE state = 'restoring'").run().changes;
  db.prepare("UPDATE backup_restores SET state = 'failed', error = 'Interrupted (the panel restarted)', finished_at = ? WHERE state = 'running'").run(nowIso());
  if (cut) log?.warn(`${cut} restore(s) were interrupted by a restart`);
  const every = Math.max(1, Number(process.env.BACKUP_TICK_SECONDS || 60)) * 1000;
  setInterval(() => { tickBackups(log).catch((err) => log?.warn(`Backups: ${err.message}`)); }, every).unref();
}

// ---- Orphans ----------------------------------------------------------------------------------

const PURGE_EVERY_MS = Number(process.env.BACKUP_PURGE_SECONDS ?? 3600) * 1000;

async function onlineNode(clusterId) {
  const nodes = await pve.on(clusterId).get('/nodes');
  return (nodes ?? []).find((n) => n.status === 'online')?.node ?? null;
}

/** Records backups whose server is no longer the customer's; removes them after the grace period. */
export async function purgeOrphans(log) {
  const s = backupSettings();
  const storages = db.prepare('SELECT ps.* FROM pbs_storages ps JOIN pbs_servers p ON p.id = ps.pbs_id WHERE p.enabled = 1').all();
  const owned = db.prepare('SELECT 1 FROM vms WHERE vmid = ? AND user_id = ?');
  let removed = 0;
  for (const st of storages) {
    const node = await onlineNode(st.cluster_id).catch(() => null);
    if (!node) continue;
    const base = `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(st.storage)}/content`;
    const list = await pve.on(st.cluster_id).get(base).catch(() => null);
    if (!list) continue;
    const byVm = new Map();
    for (const b of list) if (b.vmid) byVm.set(Number(b.vmid), [...(byVm.get(Number(b.vmid)) ?? []), b]);
    // servers that came back, or whose backups are all gone, leave the list
    for (const o of db.prepare('SELECT vmid FROM backup_orphans WHERE storage = ?').all(st.storage)) {
      if (!byVm.has(o.vmid) || owned.get(o.vmid, st.user_id)) db.prepare('DELETE FROM backup_orphans WHERE storage = ? AND vmid = ?').run(st.storage, o.vmid);
    }
    for (const [vmid, items] of byVm) {
      if (owned.get(vmid, st.user_id)) continue;
      db.prepare('INSERT INTO backup_orphans (storage, cluster_id, vmid, user_id, first_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(st.storage, st.cluster_id, vmid, st.user_id, nowIso());
      const o = db.prepare('SELECT first_seen FROM backup_orphans WHERE storage = ? AND vmid = ?').get(st.storage, vmid);
      if (Date.now() - Date.parse(o.first_seen) < s.keepAfterDeleteDays * 86_400_000) continue;
      let n = 0;
      for (const b of items) {
        const path = `${base}/${encodeURIComponent(b.volid)}`;
        try {
          if (Number(b.protected)) await pve.on(st.cluster_id).put(path, { protected: 0 });
          await pve.on(st.cluster_id).del(path);
          n += 1;
        } catch (err) {
          log?.warn(`Removing ${b.volid}: ${err.message}`);
        }
      }
      if (n === items.length) db.prepare('DELETE FROM backup_orphans WHERE storage = ? AND vmid = ?').run(st.storage, vmid);
      removed += n;
      audit({ account: { id: st.user_id }, ip: 'backup' }, vmid, 'backup_purged', { storage: st.storage, removed: n, of: items.length, afterDays: s.keepAfterDeleteDays });
    }
  }
  return { removed };
}

// ---- Views --------------------------------------------------------------------------------------

export const pubRun = (r) => ({
  id: r.id, vmid: r.vmid, userId: r.user_id, clusterId: r.cluster_id, node: r.node, storage: r.storage, kind: r.kind,
  windowKey: r.window_key, state: r.state, volid: r.volid, size: r.size, error: r.error,
  startedAt: r.started_at, finishedAt: r.finished_at, label: r.label ?? null, email: r.email ?? null,
});

export function listRuns({ state = null, vmid = null, limit = 200 } = {}) {
  const where = []; const args = [];
  if (state) { where.push('r.state = ?'); args.push(state); }
  if (vmid) { where.push('r.vmid = ?'); args.push(vmid); }
  return db.prepare(`SELECT r.*, v.label, u.email FROM backup_runs r LEFT JOIN vms v ON v.vmid = r.vmid LEFT JOIN users u ON u.id = r.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ?`).all(...args, limit).map(pubRun);
}

/**
 * Coverage of every customer server: protected (a recent successful backup), or the reason
 * it is not (no policy, excluded, never backed up, failing, out of date).
 */
export function coverage() {
  const rows = db.prepare("SELECT v.*, u.email FROM vms v LEFT JOIN users u ON u.id = v.user_id WHERE v.state != 'deleting' ORDER BY v.vmid").all();
  const lastOk = db.prepare("SELECT MAX(finished_at) AS at FROM backup_runs WHERE vmid = ? AND state = 'ok'");
  const lastRun = db.prepare('SELECT state, error, finished_at FROM backup_runs WHERE vmid = ? ORDER BY id DESC LIMIT 1');
  const list = rows.map((row) => {
    const policy = policyOfServer(row);
    const ok = lastOk.get(row.vmid).at;
    const last = lastRun.get(row.vmid);
    let status;
    if (row.backup_excluded) status = 'excluded';
    else if (!policy) status = 'no-policy';
    else if (last?.state === 'failed') status = 'failing';
    else if (!ok) status = 'pending';
    else if (Date.now() - Date.parse(ok) > (policy.frequency === 'weekly' ? 8 : 2) * 86_400_000) status = 'stale';
    else status = 'protected';
    return {
      vmid: row.vmid, label: row.label, email: row.email, policyId: policy?.id ?? null, policy: policy?.name ?? null,
      override: row.backup_policy_id ?? null, excluded: !!row.backup_excluded, lastOk: ok, lastError: last?.state === 'failed' ? last.error : null, status,
    };
  });
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const day = db.prepare('SELECT state, COUNT(*) AS n, SUM(size) AS bytes FROM backup_runs WHERE started_at >= ? GROUP BY state').all(since);
  const pick = (st) => day.find((d) => d.state === st) ?? { n: 0, bytes: 0 };
  return {
    servers: list,
    counts: Object.fromEntries(['protected', 'pending', 'stale', 'failing', 'no-policy', 'excluded'].map((k) => [k, list.filter((x) => x.status === k).length])),
    last24h: { ok: pick('ok').n, failed: pick('failed').n, running: db.prepare("SELECT COUNT(*) AS n FROM backup_runs WHERE state = 'running'").get().n, bytes: pick('ok').bytes ?? 0 },
    orphans: db.prepare('SELECT o.*, u.email FROM backup_orphans o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.first_seen').all()
      .map((o) => ({ storage: o.storage, vmid: o.vmid, userId: o.user_id, email: o.email, firstSeen: o.first_seen })),
  };
}

/** Admin: a server's own policy (add-on/override; null = the plan's) or excluded from backups. */
export function setServerBackup(req, vmid, input) {
  const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
  if (!row) throw fail(404, 'Server not found');
  let policyId = row.backup_policy_id;
  if (input.policyId !== undefined) {
    policyId = input.policyId === null ? null : Number(input.policyId);
    if (policyId !== null && !db.prepare('SELECT 1 FROM backup_policies WHERE id = ?').get(policyId)) throw fail(400, 'Policy not found');
  }
  const excluded = typeof input.excluded === 'boolean' ? input.excluded : !!row.backup_excluded;
  db.prepare('UPDATE vms SET backup_policy_id = ?, backup_excluded = ? WHERE vmid = ?').run(policyId, excluded ? 1 : 0, vmid);
  audit(req, vmid, 'admin_server_backup', { policyId, excluded });
  return coverage().servers.find((s) => s.vmid === vmid);
}
