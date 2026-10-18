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
//
// Jobs: a read-only view of background work: servers being created, reinstalled
// or deleted (and failed ones), update runs, rollouts, and recent finished work
// from the activity log.

import { db, audit } from './db.js';
import { clusterGuests, guestPath, pve } from './pve.js';
import { startUpdates } from './winupdate.js';
import { emailConfigured, sendMail, rolloutNoticeMessage } from './mail.js';

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
      flag: !w ? 'never' : !FINAL_RUN.includes(w.state) ? 'running' : w.state === 'failed' ? 'failed'
        : now - finished > 30 * DAY ? 'stale' : 'ok',
    };
  });
  const patchable = servers.filter((x) => x.patchable);
  return {
    servers,
    kpis: {
      servers: servers.length, patchable: patchable.length,
      ok: patchable.filter((x) => x.flag === 'ok').length, never: patchable.filter((x) => x.flag === 'never').length,
      stale: patchable.filter((x) => x.flag === 'stale').length, failed: patchable.filter((x) => x.flag === 'failed').length,
      running: patchable.filter((x) => x.flag === 'running').length,
      runsWeek: db.prepare("SELECT COUNT(*) AS n FROM winupdates WHERE started_at >= datetime('now', '-7 days')").get().n,
    },
  };
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
export function createRollout(req, { name, vmids, rings = [10, 30, 60], scope = 'security', snapshot = true, autoRestart = true, maxFailPct = 2 }) {
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
    const id = Number(db.prepare(`INSERT INTO rollouts (name, scope, snapshot, auto_restart, max_fail_pct, state, created_by)
      VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(n, scope === 'all' ? 'all' : 'security', snapshot ? 1 : 0, autoRestart ? 1 : 0, pct, req.account.id).lastInsertRowid);
    const ins = db.prepare("INSERT INTO rollout_items (rollout_id, vmid, ring, state) VALUES (?, ?, ?, 'pending')");
    let k = 0;
    sizes.forEach((size, ring) => { for (let j = 0; j < size; j += 1) ins.run(id, order[k++], ring + 1); });
    db.exec('COMMIT');
    audit(req, null, 'admin_rollout_created', { id, name: n, servers: ids.length, rings: sizes, scope, snapshot: !!snapshot, maxFailPct: pct });
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
};

/** Background work: running and failed first, then recent finished. filter: all | running | failed | done */
export async function jobs({ filter = 'all' } = {}) {
  const out = [];
  const users = new Map(db.prepare('SELECT id, email FROM users').all().map((u) => [u.id, u.email]));
  // servers being set up, reinstalled or deleted, or failed
  for (const v of db.prepare("SELECT vmid, label, user_id, state, progress, error, spec FROM vms WHERE state IN ('creating', 'deleting', 'failed')").all()) {
    const spec = v.spec ? JSON.parse(v.spec) : {};
    const what = v.state === 'deleting' ? 'Delete server' : spec.reinstalledAt ? 'Reinstall' : 'Create server';
    out.push({
      id: `vm-${v.vmid}`, kind: 'server', action: what, target: v.label || spec.hostname || `server ${v.vmid}`, vmid: v.vmid, by: users.get(v.user_id) ?? null,
      state: v.state === 'failed' ? 'failed' : 'running', detail: v.state === 'failed' ? v.error : v.progress, at: spec.reinstalledAt ?? null,
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
      state, detail: state === 'failed' ? (d.error ?? 'Failed') : (d.label ?? d.address ?? ''), at: e.created_at });
  }
  const counts = { running: out.filter((j) => j.state === 'running').length, failed: out.filter((j) => j.state === 'failed').length, done: out.filter((j) => j.state === 'done').length };
  const rank = { running: 0, failed: 1, done: 2 };
  const list = out.filter((j) => filter === 'all' || j.state === filter)
    .sort((a, b) => rank[a.state] - rank[b.state] || (utc(b.at) || 0) - (utc(a.at) || 0)).slice(0, 300);
  return { jobs: list, counts };
}
