// Automatic snapshots: per server, daily or weekly at a chosen hour, keeping the
// last N automatic snapshots (auto_YYYYMMDDHHMMSS). They count against the plan's
// snapshot limit like the customer's own; only automatic snapshots are ever
// deleted to make room, never the customer's own.
//
// Proxmox snapshots the whole VM: system disk and attached block volumes
// (detached volumes, kept as unusedN, are not included). A rollback restores
// the VM configuration of that moment, so afterwards the panel brings its own
// records in line (syncAfterRollback): volumes attached or detached as in the
// restored configuration, public addresses put back on their network cards and
// network cards of addresses that were released since removed.
//
// The hour is in the panel's time zone (PANEL_TIMEZONE, default UTC).

import { db, audit } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests, guestPath, waitTask } from './pve.js';
import { activeRun } from './winupdate.js';
import { applyRecordedIps } from './ipam.js';
import { TZ, partsIn } from './clock.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const AUTO = /^auto_\d{14}$/;

// ---- Time ---------------------------------------------------------------------------------------

/** The next run after `from`: the next full hour `hour` (on `weekday` for weekly). */
export function nextRun({ frequency, hour, weekday }, from = new Date()) {
  // step hour by hour (at most 8 days): simple and correct across DST changes
  const t = new Date(from);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8 + 2; i += 1) {
    t.setUTCHours(t.getUTCHours() + 1);
    const p = partsIn(t);
    if (p.h === hour && p.min === 0 && (frequency === 'daily' || p.wd === weekday)) return t.toISOString();
  }
  return null;
}

const stamp = (d) => {
  const p = partsIn(d);
  return `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}${String(p.h).padStart(2, '0')}${String(p.min).padStart(2, '0')}${String(p.s).padStart(2, '0')}`;
};

// ---- Schedules -----------------------------------------------------------------------------------

const pub = (r) => (r ? {
  frequency: r.frequency, hour: r.hour, weekday: r.weekday, keep: r.keep, nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at, lastStatus: r.last_status, lastError: r.last_error,
} : null);

export function getSchedule(vmid) {
  return { schedule: pub(db.prepare('SELECT * FROM snapshot_schedules WHERE vmid = ?').get(vmid)), maxSnapshots: config.limits.maxSnapshots, timeZone: TZ };
}

export function setSchedule(req, row, input) {
  if (input.frequency === 'off') {
    db.prepare('DELETE FROM snapshot_schedules WHERE vmid = ?').run(row.vmid);
    audit(req, row.vmid, 'snapshot_schedule_off');
    return getSchedule(row.vmid);
  }
  if (!['daily', 'weekly'].includes(input.frequency)) throw fail(400, 'Frequency: off, daily or weekly');
  const hour = Number(input.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw fail(400, 'Hour: 0 to 23');
  const weekday = input.frequency === 'weekly' ? Number(input.weekday) : null;
  if (input.frequency === 'weekly' && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw fail(400, 'Day of the week: 0 (Sunday) to 6');
  const keep = Number(input.keep);
  if (!Number.isInteger(keep) || keep < 1 || keep > config.limits.maxSnapshots) throw fail(400, `Keep: 1 to ${config.limits.maxSnapshots} (your plan's snapshot limit)`);
  const next = nextRun({ frequency: input.frequency, hour, weekday });
  db.prepare(`INSERT INTO snapshot_schedules (vmid, frequency, hour, weekday, keep, next_run_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vmid) DO UPDATE SET frequency = excluded.frequency, hour = excluded.hour, weekday = excluded.weekday, keep = excluded.keep, next_run_at = excluded.next_run_at`)
    .run(row.vmid, input.frequency, hour, weekday, keep, next);
  audit(req, row.vmid, 'snapshot_schedule_set', { frequency: input.frequency, hour, weekday, keep, timeZone: TZ });
  return getSchedule(row.vmid);
}

// ---- Engine -------------------------------------------------------------------------------------

/** One automatic snapshot for a server, pruning older automatic ones. Returns 'ok' or throws. */
export async function runSchedule(s) {
  const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(s.vmid);
  if (!row) return 'gone';
  if (row.state !== 'ready') throw new Error('The server is busy (being set up or changed)');
  if (row.expired_at) throw new Error('The server has expired');
  if (activeRun(row.vmid)) throw new Error('Updates are being installed');
  const guest = (await clusterGuests(true)).get(row.vmid);
  if (!guest) throw new Error('The server was not found');
  const path = guestPath(guest);
  const list = (await pve.get(`${path}/snapshot`)).filter((x) => x.name !== 'current').sort((a, b) => (a.snaptime ?? 0) - (b.snaptime ?? 0));
  const autos = list.filter((x) => AUTO.test(x.name));
  // make room: keep-1 automatic ones, and stay within the plan's limit
  const own = list.length - autos.length;
  const allowAuto = Math.min(s.keep, config.limits.maxSnapshots - own);
  if (allowAuto < 1) throw new Error(`All ${config.limits.maxSnapshots} snapshot slots are used by your own snapshots`);
  const drop = autos.slice(0, Math.max(0, autos.length - (allowAuto - 1)));
  for (const x of drop) await waitTask(guest.node, await pve.del(`${path}/snapshot/${x.name}`), 30 * 60_000);
  const name = `auto_${stamp(new Date())}`;
  await waitTask(guest.node, await pve.post(`${path}/snapshot`, { snapname: name, description: 'Automatic snapshot (panel)' }), 60 * 60_000);
  audit({ account: { id: row.user_id }, ip: 'schedule' }, row.vmid, 'snapshot_auto', { name, removed: drop.map((x) => x.name) });
  return 'ok';
}

let running = false;
export async function tickSchedules(log) {
  if (running) return;
  running = true;
  try {
    const due = db.prepare('SELECT * FROM snapshot_schedules WHERE next_run_at IS NOT NULL AND next_run_at <= ?').all(new Date().toISOString());
    for (const s of due) {
      const next = nextRun(s);
      try {
        const r = await runSchedule(s);
        if (r === 'gone') { db.prepare('DELETE FROM snapshot_schedules WHERE vmid = ?').run(s.vmid); continue; }
        db.prepare("UPDATE snapshot_schedules SET last_run_at = ?, last_status = 'ok', last_error = NULL, next_run_at = ? WHERE vmid = ?").run(new Date().toISOString(), next, s.vmid);
      } catch (err) {
        db.prepare("UPDATE snapshot_schedules SET last_run_at = ?, last_status = 'failed', last_error = ?, next_run_at = ? WHERE vmid = ?")
          .run(new Date().toISOString(), String(err.message).slice(0, 300), next, s.vmid);
        const owner = db.prepare('SELECT user_id FROM vms WHERE vmid = ?').get(s.vmid)?.user_id ?? null;
        audit({ account: owner ? { id: owner } : null, ip: 'schedule' }, s.vmid, 'snapshot_auto_failed', { error: String(err.message).slice(0, 300) });
        log?.warn(`Automatic snapshot of ${s.vmid} failed: ${err.message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startSnapshotSchedules(log) {
  const every = Math.max(2, Number(process.env.SNAPSHOT_SCHEDULE_SECONDS || 300)) * 1000;
  setInterval(() => { tickSchedules(log).catch(() => {}); }, every).unref();
}

// ---- After a rollback -------------------------------------------------------------------------------

/** Brings volumes and public addresses in line with the configuration a rollback restored. */
export async function syncAfterRollback(vmid) {
  const guest = (await clusterGuests(true)).get(vmid);
  if (!guest) return;
  const path = guestPath(guest);
  const cfg = await pve.get(`${path}/config`);
  const volid = (v) => String(v ?? '').split(',')[0];
  // volumes: attached where the restored config has them, detached otherwise. A volume
  // created after the snapshot is no longer referenced at all: a rescan lists it as unusedN.
  const vols = db.prepare('SELECT * FROM volumes WHERE vmid = ?').all(vmid);
  const referenced = (c, v) => Object.keys(c).some((k) => /^(scsi|virtio|sata|unused)\d+$/.test(k) && volid(c[k]) === v.volid);
  if (vols.some((v) => !referenced(cfg, v)) && guest.type === 'qemu') {
    await waitTask(guest.node, await pve.post(`/nodes/${encodeURIComponent(guest.node)}/qemu/${vmid}/rescan`).catch(() => null)).catch(() => {});
  }
  for (const v of vols) {
    const slot = Object.keys(cfg).find((k) => /^(scsi|virtio|sata)\d+$/.test(k) && volid(cfg[k]) === v.volid) ?? null;
    if (slot !== v.slot) db.prepare('UPDATE volumes SET slot = ? WHERE id = ?').run(slot, v.id);
  }
  // public addresses: NICs of released addresses go, assigned ones come back
  const assigned = db.prepare("SELECT nic, mac FROM ip_addresses WHERE vmid = ? AND state = 'assigned'").all(vmid);
  const bridges = new Set(db.prepare('SELECT bridge FROM ip_pools').all().map((r) => r.bridge));
  const stale = Object.keys(cfg).filter((k) => /^net[1-9]\d*$/.test(k)
    && [...bridges].some((b) => new RegExp(`(^|,)bridge=${b}(,|$)`).test(cfg[k]))
    && !assigned.some((a) => a.nic === k && cfg[k].toUpperCase().includes(String(a.mac ?? '').toUpperCase())));
  if (stale.length) {
    const del = stale.flatMap((k) => [k, ...(cfg[`ipconfig${k.slice(3)}`] !== undefined ? [`ipconfig${k.slice(3)}`] : [])]);
    await pve.put(`${path}/config`, { delete: del.join(',') });
  }
  // assigned addresses the snapshot didn't have yet: put their cards back (same MAC)
  await applyRecordedIps(path, vmid, { onlyMissing: true });
}
