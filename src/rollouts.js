// Fleet updates and the job list.
//
// Fleet: every customer server with its OS and its last update run (Windows or
// Linux, see winupdate.js), so an administrator sees what was never patched,
// what failed, and what is running now.
//
// Rollouts: an administrator picks servers and installs updates in rings, e.g.
// 10 % first, then 30 %, then the rest. A ring starts only when the previous one
// has finished and fewer than max_fail_pct of its runs failed; otherwise the
// rollout pauses for a decision (resume or cancel). Each run is an ordinary
// update run (snapshot first if chosen, same checks as when a customer starts
// it); servers that can't run (stopped, no agent, switched off, expired) are
// skipped with the reason. Customers get an email when their server is updated.
// An optional maintenance window (days and hours in the panel's time zone) limits
// when runs start; outside it the rollout waits (runs already started finish).
//
// Jobs: background work: servers being created, reinstalled or deleted (and failed
// ones), update runs, rollouts, and recent finished work from the activity log.
// Some failures can be retried from there: a failed deletion, the latest failed
// update run of a server, the latest failed automatic snapshot. A failed creation or
// reinstall can't: it needs the customer's sign-in details, so the customer
// reinstalls or deletes the server.
//
// Check now: counts pending updates inside servers (nothing is installed), so an
// administrator sees what a rollout would bring.

import { db, audit } from './db.js';
import { can } from './rbac.js';
import { clusterGuests, guestPath, pve } from './pve.js';
import { startUpdates, checkPending, activeRun } from './winupdate.js';
import { runSchedule } from './snapschedule.js';
import { deleteServer } from './provision.js';
import { emailConfigured, sendMail, rolloutNoticeMessage } from './mail.js';
import { insideWindow, windowText, TZ } from './clock.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const FINAL_RUN = ['done', 'failed'];
const DAY = 86_400_000;
const utc = (d) => (d ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(d) ? d : `${String(d).replace(' ', 'T')}Z`) : NaN);

// ---- Fleet --------------------------------------------------------------------------------------

const family = (ostype) => (!ostype ? null : /^w/.test(ostype) ? 'windows' : /^l2/.test(ostype) ? 'linux' : 'other');

export async function fleet() {
  let guests = new Map();
  try { guests = await clusterGuests(); } catch { /* list without live state */ }
  const rows = db.prepare(`SELECT v.vmid, v.label, v.state, v.expired_at, v.ostype, u.email FROM vms v JOIN users u ON u.id = v.user_id
    WHERE v.state = 'ready' ORDER BY v.vmid`).all();
  // learn unknown OS types once (they are kept in vms.ostype)
  await Promise.all(rows.filter((r) => !r.ostype && guests.get(r.vmid)?.type === 'qemu').map(async (r) => {
    try {
      const t = (await pve.get(`${guestPath(guests.get(r.vmid))}/config`)).ostype ?? null;
      if (t) { r.ostype = t; db.prepare('UPDATE vms SET ostype = ? WHERE vmid = ?').run(t, r.vmid); }
    } catch { /* unknown */ }
  }));
  const last = new Map(db.prepare('SELECT * FROM winupdates WHERE id IN (SELECT MAX(id) FROM winupdates GROUP BY vmid)').all().map((w) => [w.vmid, w]));
  const checks = new Map(db.prepare('SELECT * FROM update_checks').all().map((c) => [c.vmid, c]));
  const now = Date.now();
  const servers = rows.map((r) => {
    const g = guests.get(r.vmid);
    const w = last.get(r.vmid);
    const s = w?.status_json ? JSON.parse(w.status_json) : {};
    const os = g?.type === 'lxc' ? 'container' : family(r.ostype);
    const finished = utc(w?.finished_at);
    return {
      vmid: r.vmid, name: r.label || g?.name || `server ${r.vmid}`, email: r.email, os, status: g?.status ?? 'unknown', expired: !!r.expired_at,
      lastRun: w ? {
        state: w.state, scope: w.scope, startedAt: w.started_at, finishedAt: w.finished_at,
        installed: Array.isArray(s.installed) ? s.installed.length : 0, failed: Array.isArray(s.failed) ? s.failed.length : 0,
        rebootRequired: s.rebootRequired === true,
      } : null,
      patchable: ['windows', 'linux'].includes(os),
      check: checks.has(r.vmid) ? (({ state, pending, security, reboot_required: reboot, error, checked_at: at }) => ({
        state, pending, security, rebootRequired: !!reboot, error, checkedAt: at,
      }))(checks.get(r.vmid)) : null,
      flag: !w ? 'never' : !FINAL_RUN.includes(w.state) ? 'running' : w.state === 'failed' ? 'failed'
        : now - finished > 30 * DAY ? 'stale' : 'ok',
    };
  });
  const patchable = servers.filter((x) => x.patchable);
  return {
    servers, timeZone: TZ,
    kpis: {
      servers: servers.length, patchable: patchable.length,
      ok: patchable.filter((x) => x.flag === 'ok').length, never: patchable.filter((x) => x.flag === 'never').length,
      stale: patchable.filter((x) => x.flag === 'stale').length, failed: patchable.filter((x) => x.flag === 'failed').length,
      running: patchable.filter((x) => x.flag === 'running').length,
      runsWeek: db.prepare("SELECT COUNT(*) AS n FROM winupdates WHERE started_at >= datetime('now', '-7 days')").get().n,
    },
  };
}

// ---- Check now: pending updates per server ---------------------------------------------------------

const CHECK_PARALLEL = 4;
const checkQueue = [];
let checking = 0;

function pumpChecks() {
  while (checking < CHECK_PARALLEL && checkQueue.length) {
    const vmid = checkQueue.shift();
    checking += 1;
    (async () => {
      try {
        const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
        if (!row) return;
        const c = await checkPending(row);
        db.prepare("UPDATE update_checks SET state = 'done', pending = ?, security = ?, reboot_required = ?, error = NULL, checked_at = datetime('now') WHERE vmid = ?")
          .run(c.pending, c.security, c.rebootRequired ? 1 : 0, vmid);
      } catch (err) {
        db.prepare("UPDATE update_checks SET state = 'failed', error = ?, checked_at = datetime('now') WHERE vmid = ?").run(String(err.message).slice(0, 300), vmid);
      } finally {
        checking -= 1;
        pumpChecks();
      }
    })();
  }
}

/** Counts pending updates on these servers in the background (4 at a time). */
export function startChecks(req, vmids) {
  const ids = [...new Set((vmids ?? []).map(Number))];
  if (!ids.length || ids.length > 1000) throw fail(400, 'Choose 1 to 1000 servers');
  const rows = db.prepare(`SELECT vmid FROM vms WHERE vmid IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.vmid);
  const queued = [];
  for (const vmid of rows) {
    const cur = db.prepare('SELECT state FROM update_checks WHERE vmid = ?').get(vmid);
    if (cur?.state === 'checking') continue;
    db.prepare(`INSERT INTO update_checks (vmid, state, checked_at) VALUES (?, 'checking', datetime('now'))
      ON CONFLICT(vmid) DO UPDATE SET state = 'checking', error = NULL, checked_at = excluded.checked_at`).run(vmid);
    checkQueue.push(vmid);
    queued.push(vmid);
  }
  if (queued.length) audit(req, null, 'admin_updates_check', { servers: queued.length });
  pumpChecks();
  return { queued: queued.length, skipped: ids.length - queued.length };
}

// ---- Rollouts -----------------------------------------------------------------------------------

function pubRollout(r) {
  const items = db.prepare(`SELECT i.*, v.label FROM rollout_items i LEFT JOIN vms v ON v.vmid = i.vmid WHERE i.rollout_id = ? ORDER BY i.ring, i.vmid`).all(r.id);
  const rings = [...new Set(items.map((i) => i.ring))].map((ring) => {
    const its = items.filter((i) => i.ring === ring);
    const c = (st) => its.filter((i) => i.state === st).length;
    return { ring, total: its.length, pending: c('pending'), running: c('started'), done: c('done'), failed: c('failed'), skipped: c('skipped') };
  });
  return {
    id: r.id, name: r.name, scope: r.scope, snapshot: !!r.snapshot, autoRestart: !!r.auto_restart, maxFailPct: r.max_fail_pct,
    state: r.state, reason: r.reason, createdAt: r.created_at, finishedAt: r.finished_at, rings,
    window: r.window_json ? { ...JSON.parse(r.window_json), text: windowText(JSON.parse(r.window_json)) } : null,
    items: items.map((i) => ({ vmid: i.vmid, name: i.label || `server ${i.vmid}`, ring: i.ring, state: i.state, note: i.note })),
  };
}

export const listRollouts = () => db.prepare('SELECT * FROM rollouts ORDER BY id DESC LIMIT 30').all().map(pubRollout);
export function getRollout(id) {
  const r = db.prepare('SELECT * FROM rollouts WHERE id = ?').get(id);
  if (!r) throw fail(404, 'Rollout not found');
  return pubRollout(r);
}

/** rings: percentages of the servers per ring, e.g. [10, 30, 60] (they add up to 100). */
/** A maintenance window from input, or null: { days: [0..6], start: 0..23, end: 0..23 }. */
function windowInput(w) {
  if (w === null || w === undefined) return null;
  const days = [...new Set((w.days ?? []).map(Number))].sort((a, b) => a - b);
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw fail(400, 'Maintenance window: choose at least one day');
  const start = Number(w.start);
  const end = Number(w.end);
  if (![start, end].every((h) => Number.isInteger(h) && h >= 0 && h <= 23) || start === end) throw fail(400, 'Maintenance window: start and end hours 0 to 23, not the same');
  return { days, start, end };
}

export function createRollout(req, { name, vmids, rings = [10, 30, 60], scope = 'security', snapshot = true, autoRestart = true, maxFailPct = 2, window = null }) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 80) throw fail(400, 'Name: up to 80 characters, e.g. "October security updates"');
  const ids = [...new Set((vmids ?? []).map(Number))];
  if (!ids.length || ids.length > 1000) throw fail(400, 'Choose 1 to 1000 servers');
  const known = new Set(db.prepare(`SELECT vmid FROM vms WHERE vmid IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.vmid));
  const unknown = ids.filter((v) => !known.has(v));
  if (unknown.length) throw fail(400, `Not customer servers: ${unknown.slice(0, 10).join(', ')}`);
  if (!Array.isArray(rings) || !rings.length || rings.length > 5 || rings.some((p) => !Number.isInteger(p) || p < 1 || p > 100)
    || rings.reduce((a, p) => a + p, 0) !== 100) throw fail(400, 'Rings: 1 to 5 whole percentages that add up to 100');
  const pct = Number(maxFailPct);
  if (!Number.isInteger(pct) || pct < 0 || pct > 50) throw fail(400, 'Failure limit: 0 to 50 %');
  const win = windowInput(window);
  if (db.prepare("SELECT 1 FROM rollouts WHERE state IN ('running', 'paused')").get()) throw fail(409, 'Another rollout is still running or paused. Finish or cancel it first.');

  // ring sizes: rounded up, at least one server per ring while servers are left
  const order = [...ids].sort((a, b) => a - b);
  const sizes = [];
  let left = order.length;
  rings.forEach((p, i) => {
    const size = i === rings.length - 1 ? left : Math.min(left, Math.max(1, Math.ceil((order.length * p) / 100)));
    sizes.push(size); left -= size;
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = Number(db.prepare(`INSERT INTO rollouts (name, scope, snapshot, auto_restart, max_fail_pct, state, created_by, window_json)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`).run(n, scope === 'all' ? 'all' : 'security', snapshot ? 1 : 0, autoRestart ? 1 : 0, pct, req.account.id, win ? JSON.stringify(win) : null).lastInsertRowid);
    const ins = db.prepare("INSERT INTO rollout_items (rollout_id, vmid, ring, state) VALUES (?, ?, ?, 'pending')");
    let k = 0;
    sizes.forEach((size, ring) => { for (let j = 0; j < size; j += 1) ins.run(id, order[k++], ring + 1); });
    db.exec('COMMIT');
    audit(req, null, 'admin_rollout_created', { id, name: n, servers: ids.length, rings: sizes, scope, snapshot: !!snapshot, maxFailPct: pct, window: win });
    setImmediate(() => tick().catch(() => {}));
    return getRollout(id);
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function controlRollout(req, id, action) {
  const r = db.prepare('SELECT * FROM rollouts WHERE id = ?').get(id);
  if (!r) throw fail(404, 'Rollout not found');
  if (action === 'pause' && r.state === 'running') db.prepare("UPDATE rollouts SET state = 'paused', reason = 'Paused by an administrator' WHERE id = ?").run(id);
  else if (action === 'resume' && r.state === 'paused') {
    // resuming after a failure pause lets the next ring start despite the failures
    const next = db.prepare("SELECT MIN(ring) AS ring FROM rollout_items WHERE rollout_id = ? AND state = 'pending'").get(id).ring;
    db.prepare("UPDATE rollouts SET state = 'running', reason = NULL, allow_ring = ? WHERE id = ?").run(next, id);
  }
  else if (action === 'cancel' && ['running', 'paused'].includes(r.state)) {
    // runs already started finish inside their servers; nothing new starts
    db.prepare("UPDATE rollout_items SET state = 'skipped', note = 'Rollout cancelled' WHERE rollout_id = ? AND state = 'pending'").run(id);
    db.prepare("UPDATE rollouts SET state = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(id);
  } else throw fail(409, `Can't ${action} a rollout that is ${r.state}`);
  audit(req, null, `admin_rollout_${action}`, { id, name: r.name });
  if (action === 'resume') setImmediate(() => tick().catch(() => {}));
  return getRollout(id);
}

/** Moves running rollouts on: syncs item states, checks the ring, starts the next one. */
let ticking = false;
export async function tick(log) {
  if (ticking) return;
  ticking = true;
  try {
    for (const r of db.prepare("SELECT * FROM rollouts WHERE state = 'running'").all()) {
      // results of started runs
      for (const i of db.prepare("SELECT i.*, w.state AS run_state, w.error AS run_error, w.status_json FROM rollout_items i LEFT JOIN winupdates w ON w.id = i.run_id WHERE i.rollout_id = ? AND i.state = 'started'").all(r.id)) {
        if (i.run_state === 'done') db.prepare("UPDATE rollout_items SET state = 'done' WHERE rollout_id = ? AND vmid = ?").run(r.id, i.vmid);
        else if (i.run_state === 'failed' || !i.run_state) {
          const why = (i.status_json ? JSON.parse(i.status_json).error : null) ?? i.run_error ?? 'The run failed';
          db.prepare("UPDATE rollout_items SET state = 'failed', note = ? WHERE rollout_id = ? AND vmid = ?").run(String(why).slice(0, 300), r.id, i.vmid);
        }
      }
      const ring = db.prepare("SELECT MIN(ring) AS ring FROM rollout_items WHERE rollout_id = ? AND state IN ('pending', 'started')").get(r.id).ring;
      if (ring == null) {
        db.prepare("UPDATE rollouts SET state = 'done', finished_at = datetime('now') WHERE id = ?").run(r.id);
        audit({ account: { id: r.created_by }, ip: 'rollout' }, null, 'admin_rollout_done', { id: r.id, name: r.name });
        continue;
      }
      // before a new ring starts: check the previous rings' failure rate
      const pendingOnly = !db.prepare("SELECT 1 FROM rollout_items WHERE rollout_id = ? AND ring = ? AND state <> 'pending'").get(r.id, ring);
      if (pendingOnly && ring > 1) {
        const prev = db.prepare(`SELECT COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed, COUNT(CASE WHEN state IN ('done', 'failed') THEN 1 END) AS ran
          FROM rollout_items WHERE rollout_id = ? AND ring < ?`).get(r.id, ring);
        if (prev.ran && (prev.failed / prev.ran) * 100 > r.max_fail_pct && r.allow_ring !== ring) {
          db.prepare("UPDATE rollouts SET state = 'paused', reason = ? WHERE id = ?")
            .run(`${prev.failed} of ${prev.ran} updated servers failed (more than ${r.max_fail_pct} %). Check them, then resume or cancel.`, r.id);
          continue;
        }
      }
      // outside the maintenance window nothing new starts (runs already started go on)
      const win = r.window_json ? JSON.parse(r.window_json) : null;
      const waitNote = win ? `Waiting for the maintenance window (${windowText(win)})` : null;
      if (win && !insideWindow(win)) {
        if (r.reason !== waitNote) db.prepare('UPDATE rollouts SET reason = ? WHERE id = ?').run(waitNote, r.id);
        continue;
      }
      if (waitNote && r.reason === waitNote) db.prepare('UPDATE rollouts SET reason = NULL WHERE id = ?').run(r.id);
      // start what is pending in this ring
      for (const i of db.prepare("SELECT * FROM rollout_items WHERE rollout_id = ? AND ring = ? AND state = 'pending'").all(r.id, ring)) {
        const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(i.vmid);
        const skip = (note) => db.prepare("UPDATE rollout_items SET state = 'skipped', note = ? WHERE rollout_id = ? AND vmid = ?").run(note.slice(0, 300), r.id, i.vmid);
        if (!row) { skip('The server is gone'); continue; }
        try {
          const run = await startUpdates({ account: { id: r.created_by }, ip: 'rollout' }, row, { scope: r.scope, snapshot: !!r.snapshot, autoRestart: !!r.auto_restart });
          db.prepare("UPDATE rollout_items SET state = 'started', run_id = ?, note = NULL WHERE rollout_id = ? AND vmid = ?").run(run.id, r.id, i.vmid);
          if (emailConfigured()) {
            const u = db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id);
            if (u) sendMail({ to: u.email, ...rolloutNoticeMessage({ ...row, name: row.label || `server ${row.vmid}` }, { scope: r.scope, snapshot: !!r.snapshot, autoRestart: !!r.auto_restart }) }).catch(() => {});
          }
        } catch (err) {
          skip(err.expose || err.statusCode ? err.message : `Could not start: ${err.message}`);
        }
      }
      // pause after a ring with every run failed/skipped is handled at the next ring's start
    }
  } catch (err) {
    log?.warn(`Rollouts: ${err.message}`);
  } finally {
    ticking = false;
  }
}

export function startRolloutEngine(log) {
  // checks that were running when the panel stopped never finish
  db.prepare("UPDATE update_checks SET state = 'failed', error = 'Interrupted by a panel restart' WHERE state = 'checking'").run();
  const every = Math.max(2, Number(process.env.ROLLOUT_INTERVAL_SECONDS || 30)) * 1000;
  setInterval(() => { tick(log).catch(() => {}); }, every).unref();
}

// ---- Jobs -----------------------------------------------------------------------------------------

const FINISHED = {
  server_created: ['Create server', 'done'], server_create_failed: ['Create server', 'failed'],
  server_reinstalled: ['Reinstall', 'done'], server_reinstall_failed: ['Reinstall', 'failed'],
  server_deleted: ['Delete server', 'done'], server_resized: ['Resize', 'done'],
  volume_created: ['Create volume', 'done'], volume_create_failed: ['Create volume', 'failed'],
  ip_assigned: ['Add public IP', 'done'], ip_assign_failed: ['Add public IP', 'failed'],
  admin_rollout_done: ['Update rollout', 'done'],
  snapshot_auto: ['Automatic snapshot', 'done'], snapshot_auto_failed: ['Automatic snapshot', 'failed'],
};

/** Background work: running and failed first, then recent finished. filter: all | running | failed | done */
export async function jobs({ filter = 'all' } = {}) {
  const out = [];
  const users = new Map(db.prepare('SELECT id, email FROM users').all().map((u) => [u.id, u.email]));
  const latestRun = new Map(db.prepare('SELECT vmid, MAX(id) AS id FROM winupdates GROUP BY vmid').all().map((r) => [r.vmid, r.id]));
  const latestSnap = new Map(db.prepare("SELECT vmid, MAX(id) AS id FROM audit_log WHERE action IN ('snapshot_auto', 'snapshot_auto_failed') GROUP BY vmid").all().map((r) => [r.vmid, r.id]));
  const ready = new Set(db.prepare("SELECT vmid FROM vms WHERE state = 'ready'").all().map((r) => r.vmid));
  const schedules = new Set(db.prepare('SELECT vmid FROM snapshot_schedules').all().map((r) => r.vmid));
  // servers being set up, reinstalled or deleted, or failed
  for (const v of db.prepare("SELECT vmid, label, user_id, state, progress, error, spec FROM vms WHERE state IN ('creating', 'deleting', 'failed')").all()) {
    const spec = v.spec ? JSON.parse(v.spec) : {};
    const what = v.state === 'deleting' ? 'Delete server' : spec.reinstalledAt ? 'Reinstall' : 'Create server';
    out.push({
      id: `vm-${v.vmid}`, kind: 'server', action: what, target: v.label || spec.hostname || `server ${v.vmid}`, vmid: v.vmid, by: users.get(v.user_id) ?? null,
      state: v.state === 'failed' ? 'failed' : 'running', detail: v.state === 'failed' ? v.error : v.progress, at: spec.reinstalledAt ?? null,
      ...(v.state === 'failed' ? (/^Deleting failed/.test(v.error ?? '') ? { retry: 'delete' }
        : { retry: null, retryNote: 'Needs the customer\'s sign-in details: the customer reinstalls or deletes the server' }) : {}),
    });
  }
  // update runs in the last 14 days
  for (const w of db.prepare("SELECT w.*, v.label FROM winupdates w LEFT JOIN vms v ON v.vmid = w.vmid WHERE w.started_at >= datetime('now', '-14 days') ORDER BY w.id DESC LIMIT 200").all()) {
    const s = w.status_json ? JSON.parse(w.status_json) : {};
    out.push({
      id: `run-${w.id}`, kind: 'updates', action: `${w.os === 'linux' ? 'Linux' : 'Windows'} updates (${w.scope})`, target: w.label || `server ${w.vmid}`, vmid: w.vmid,
      by: users.get(w.user_id) ?? null, state: w.state === 'done' ? 'done' : w.state === 'failed' ? 'failed' : 'running',
      detail: w.state === 'failed' ? (s.error ?? w.error ?? 'Failed') : w.state === 'done' ? `${Array.isArray(s.installed) ? s.installed.length : 0} installed` : (s.message ?? w.state),
      at: w.started_at,
      ...(w.state === 'failed' && latestRun.get(w.vmid) === w.id && ready.has(w.vmid) ? { retry: 'updates' } : {}),
    });
  }
  // rollouts in progress
  for (const r of db.prepare("SELECT * FROM rollouts WHERE state IN ('running', 'paused')").all()) {
    const p = pubRollout(r);
    const total = p.items.length;
    const finished = p.items.filter((i) => ['done', 'failed', 'skipped'].includes(i.state)).length;
    out.push({ id: `rollout-${r.id}`, kind: 'rollout', action: 'Update rollout', target: r.name, by: users.get(r.created_by) ?? null,
      state: r.state === 'paused' ? 'failed' : 'running', detail: r.state === 'paused' ? `Paused: ${r.reason}` : `${finished} of ${total} servers`, at: r.created_at, rolloutId: r.id });
  }
  // finished work from the activity log (last 7 days)
  const keys = Object.keys(FINISHED);
  for (const e of db.prepare(`SELECT * FROM audit_log WHERE action IN (${keys.map(() => '?').join(',')}) AND created_at >= datetime('now', '-7 days') ORDER BY id DESC LIMIT 200`).all(...keys)) {
    const [action, state] = FINISHED[e.action];
    const d = e.detail ? JSON.parse(e.detail) : {};
    out.push({ id: `log-${e.id}`, kind: 'log', action, target: e.vmid ? `server ${e.vmid}` : (d.name ?? d.label ?? ''), vmid: e.vmid, by: users.get(e.user_id) ?? null,
      state, detail: state === 'failed' ? (d.error ?? 'Failed') : (d.label ?? d.address ?? ''), at: e.created_at,
      ...(e.action === 'snapshot_auto_failed' && latestSnap.get(e.vmid) === e.id && schedules.has(e.vmid) && ready.has(e.vmid) ? { retry: 'snapshot' } : {}) });
  }
  const counts = { running: out.filter((j) => j.state === 'running').length, failed: out.filter((j) => j.state === 'failed').length, done: out.filter((j) => j.state === 'done').length };
  const rank = { running: 0, failed: 1, done: 2 };
  const list = out.filter((j) => filter === 'all' || j.state === filter)
    .sort((a, b) => rank[a.state] - rank[b.state] || (utc(b.at) || 0) - (utc(a.at) || 0)).slice(0, 300);
  return { jobs: list, counts };
}

const RETRY_PERMISSION = { delete: 'servers.delete', updates: 'updates.write', snapshot: 'servers.manage' };

/** Retries a failed job of the list (see jobs()); returns { retried, message }. */
export async function retryJob(req, jobId) {
  const job = (await jobs({ filter: 'failed' })).jobs.find((j) => j.id === jobId);
  if (!job) throw fail(404, 'That job is not in the list of failed jobs any more');
  if (!job.retry) throw fail(409, job.retryNote ?? 'This job can\'t be retried');
  const need = RETRY_PERMISSION[job.retry];
  if (!can(req.account, need)) throw fail(403, `Retrying this needs the permission ${need}`);
  const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(job.vmid);
  if (!row) throw fail(404, 'The server is gone');
  if (job.retry === 'delete') {
    db.prepare("UPDATE vms SET state = 'ready', error = NULL WHERE vmid = ?").run(row.vmid);
    try {
      const r = await deleteServer(req, { ...row, state: 'ready', error: null });
      audit(req, row.vmid, 'admin_job_retried', { job: jobId, what: 'delete' });
      return { retried: true, message: r.removed ? 'The server record was removed' : 'Deleting again' };
    } catch (err) {
      db.prepare("UPDATE vms SET state = 'failed', error = ? WHERE vmid = ?").run(row.error, row.vmid);
      throw err;
    }
  }
  if (job.retry === 'updates') {
    if (activeRun(row.vmid)) throw fail(409, 'Updates are already being installed on this server');
    const w = db.prepare('SELECT * FROM winupdates WHERE id = ?').get(Number(jobId.slice(4)));
    // as the server's owner would (same checks), recorded as the administrator's action
    await startUpdates(req, row, { scope: w.scope, snapshot: !!w.snapshot, autoRestart: !!w.auto_restart });
    audit(req, row.vmid, 'admin_job_retried', { job: jobId, what: 'updates' });
    return { retried: true, message: 'Update run started again' };
  }
  const s = db.prepare('SELECT * FROM snapshot_schedules WHERE vmid = ?').get(row.vmid);
  if (!s) throw fail(409, 'Automatic snapshots are switched off for this server');
  try {
    await runSchedule(s);
    db.prepare("UPDATE snapshot_schedules SET last_run_at = ?, last_status = 'ok', last_error = NULL WHERE vmid = ?").run(new Date().toISOString(), row.vmid);
  } catch (err) {
    db.prepare("UPDATE snapshot_schedules SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE vmid = ?").run(new Date().toISOString(), String(err.message).slice(0, 300), row.vmid);
    throw fail(409, `The snapshot failed again: ${err.message}`);
  }
  audit(req, row.vmid, 'admin_job_retried', { job: jobId, what: 'snapshot' });
  return { retried: true, message: 'Automatic snapshot taken' };
}
