// Backups for customers: the restore points of a server, protecting one, a backup of
// their own, the add-on policy, and restores.
//
//   Files      browse a backup and download a file or a folder (zip) through the panel;
//              Proxmox reads the backup (file-restore), the server keeps running.
//   New        a new server from the backup, next to the original (same node and plan):
//              counts against the customer's limits and is billed like a new server
//              of that plan. Only the system disk is kept; public addresses, GPUs and
//              block storage volumes of the original stay with the original.
//   Replace    the server itself goes back to the backup: it must be shut down and may
//              hold no block storage volumes. Optionally a fresh backup first, so the
//              step can be undone. Public addresses are put back as they are now.
//
// Each restore is recorded in backup_restores (admin history).

import { db, audit } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests, guestPath, waitTask, bootDiskKey, diskSizeGb, serial, invalidateGuestCache, rawDownload } from './pve.js';
import { TZ } from './clock.js';
import { backupSettings, pbsForCluster, policyOfServer, listPolicies } from './backups.js';
import { backupNow, startRun, follow, pubRun, manualUsed } from './backupjobs.js';
import { limitsOf, usageOf } from './provision.js';
import { checkPoolCapacity } from './pools.js';
import { ensureNetwork, isolateGuest } from './network.js';
import { expiryForNewServer } from './expiry.js';
import { planRow } from './plans.js';
import { planIsBilled, chargeOrder, completeOrder, refundInvoice } from './billing.js';
import { syncAfterRollback } from './snapschedule.js';
import { volumesOfServer } from './volumes.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
export const PROTECT_MAX = 3;
export const BACKUP_ID = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const DISK = /^(scsi|virtio|sata|ide)\d+$/;
const nowIso = () => new Date().toISOString();
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const restoring = new Set();                        // vmids with a restore going on

// ---- Where a server's backups are ----------------------------------------------------------

async function placeOf(row) {
  const guest = (await clusterGuests()).get(row.vmid) ?? (await clusterGuests(true)).get(row.vmid);
  if (!guest) throw fail(404, 'The server was not found');
  const clusterId = Number(guest.cluster ?? 0);
  const pbs = pbsForCluster(clusterId);
  const st = pbs ? db.prepare('SELECT storage FROM pbs_storages WHERE pbs_id = ? AND user_id = ? AND cluster_id = ?').get(pbs.id, row.user_id, clusterId) : null;
  return { guest, clusterId, api: pve.on(clusterId), storage: st?.storage ?? null };
}

const contentPath = (p) => `/nodes/${encodeURIComponent(p.guest.node)}/storage/${encodeURIComponent(p.storage)}/content`;

async function restorePoints(p, vmid) {
  if (!p.storage) return [];
  const list = await p.api.get(contentPath(p), { vmid });
  return (list ?? []).filter((b) => Number(b.vmid) === vmid && String(b.volid).includes(`backup/vm/${vmid}/`))
    .map((b) => ({
      id: String(b.volid).split('/').pop(), volid: b.volid, time: b.ctime ? new Date(b.ctime * 1000).toISOString() : null, size: b.size ?? null,
      protected: !!Number(b.protected), verified: b.verification ? b.verification.state === 'ok' : null, notes: b.notes ?? '',
    }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

/** A restore point of this server by its id (the time stamp in the volume name). */
async function pointOf(row, id) {
  if (!BACKUP_ID.test(String(id))) throw fail(404, 'Backup not found');
  const p = await placeOf(row);
  const point = (await restorePoints(p, row.vmid)).find((x) => x.id === id);
  if (!point) throw fail(404, 'Backup not found');
  return { p, point };
}

// ---- The customer's view -----------------------------------------------------------------------

const addonPolicies = () => listPolicies().filter((x) => x.addonPrice != null)
  .map((x) => ({ id: x.id, name: x.name, frequency: x.frequency, weekday: x.weekday, keepDaily: x.keepDaily, keepWeekly: x.keepWeekly, keepMonthly: x.keepMonthly, addonPrice: x.addonPrice }));
const pubPolicy = (x) => (x ? { id: x.id, name: x.name, frequency: x.frequency, weekday: x.weekday, keepDaily: x.keep_daily, keepWeekly: x.keep_weekly, keepMonthly: x.keep_monthly, addonPrice: x.addon_price } : null);

export async function customerBackups(row) {
  const s = backupSettings();
  if (!s.enabled) return { enabled: false };
  const p = await placeOf(row);
  const policy = policyOfServer(row);
  const own = row.backup_policy_id ? db.prepare('SELECT * FROM backup_policies WHERE id = ?').get(row.backup_policy_id) : null;
  const planPolicyId = db.prepare('SELECT backup_policy_id FROM plans WHERE id = ?').get(row.plan_id ?? -1)?.backup_policy_id ?? s.defaultPolicyId;
  const points = await restorePoints(p, row.vmid).catch(() => []);
  const used = manualUsed(row);
  const last = db.prepare('SELECT * FROM backup_runs WHERE vmid = ? ORDER BY id DESC LIMIT 1').get(row.vmid);
  const restore = db.prepare("SELECT * FROM backup_restores WHERE vmid = ? AND mode != 'files' ORDER BY id DESC LIMIT 1").get(row.vmid);
  return {
    enabled: true,
    policy: pubPolicy(policy), excluded: !!row.backup_excluded,
    planPolicy: pubPolicy(planPolicyId ? db.prepare('SELECT * FROM backup_policies WHERE id = ?').get(planPolicyId) : null),
    addon: own && own.addon_price != null ? pubPolicy(own) : null,
    setBySupport: !!own && own.addon_price == null,
    addons: addonPolicies(),
    window: `${hh(s.windowStart)}–${hh(s.windowEnd)} ${TZ}`, encrypted: s.encrypt,
    manual: { perDay: s.manualPerDay, used, left: Math.max(0, s.manualPerDay - used) },
    running: last?.state === 'running', lastRun: last ? pubRun(last) : null,
    restoring: restoring.has(row.vmid) || row.state === 'restoring',
    lastRestore: restore ? { mode: restore.mode, state: restore.state, error: restore.error, targetVmid: restore.target_vmid, at: restore.started_at } : null,
    protectMax: PROTECT_MAX,
    hasVolumes: volumesOfServer(row.vmid).length > 0,
    points,
  };
}

export async function customerBackupNow(req, row) {
  if (row.backup_excluded) throw fail(409, 'Backups are switched off for this server');
  return backupNow(req, row, { byCustomer: true });
}

export async function setProtected(req, row, id, value) {
  const { p, point } = await pointOf(row, id);
  if (value && !point.protected) {
    const n = (await restorePoints(p, row.vmid)).filter((x) => x.protected).length;
    if (n >= PROTECT_MAX) throw fail(409, `Up to ${PROTECT_MAX} protected backups per server. Unprotect one first.`);
  }
  await p.api.put(`${contentPath(p)}/${encodeURIComponent(point.volid)}`, { protected: value ? 1 : 0 });
  audit(req, row.vmid, value ? 'backup_protected' : 'backup_unprotected', { backup: id });
  return { id, protected: value };
}

/** The add-on policy of a server (null: back to the plan's). Billed with the next renewal. */
export function setAddon(req, row, policyId) {
  const cur = row.backup_policy_id ? db.prepare('SELECT * FROM backup_policies WHERE id = ?').get(row.backup_policy_id) : null;
  if (cur && cur.addon_price == null) throw fail(409, 'The backup plan of this server is set by support; ask them to change it');
  if (row.backup_excluded) throw fail(409, 'Backups are switched off for this server');
  if (policyId !== null) {
    const x = db.prepare('SELECT * FROM backup_policies WHERE id = ?').get(policyId);
    if (!x || x.addon_price == null) throw fail(400, 'That backup option is not offered');
  }
  db.prepare('UPDATE vms SET backup_policy_id = ? WHERE vmid = ?').run(policyId, row.vmid);
  audit(req, row.vmid, policyId ? 'backup_addon_on' : 'backup_addon_off', { policyId });
  return { policyId };
}

// ---- Files -------------------------------------------------------------------------------------------

const b64 = (s) => Buffer.from(s).toString('base64');
const cleanPath = (s) => {
  const x = `/${String(s ?? '/').replace(/^\/+/, '')}`;
  if (x.length > 1024 || x.split('/').some((seg) => seg === '..') || /[\0\n\r]/.test(x)) throw fail(400, 'Invalid path');
  return x;
};

export async function listFiles(row, id, path) {
  const { p, point } = await pointOf(row, id);
  const fp = cleanPath(path);
  const list = await p.api.get(`/nodes/${encodeURIComponent(p.guest.node)}/storage/${encodeURIComponent(p.storage)}/file-restore/list`, { volume: point.volid, filepath: b64(fp) });
  return {
    path: fp,
    entries: (list ?? []).map((e) => {
      const full = Buffer.from(String(e.filepath ?? ''), 'base64').toString();
      return { name: e.text ?? full.split('/').pop(), path: full.startsWith('/') ? full : `/${full}`, type: e.type === 'f' || e.leaf ? 'file' : 'folder', size: e.size ?? null };
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1)),
  };
}

/** A file (or a folder as zip) from a backup: the response of Proxmox, streamed. */
export async function downloadFile(req, row, id, path, { folder = false } = {}) {
  const { p, point } = await pointOf(row, id);
  const fp = cleanPath(path);
  if (fp === '/') throw fail(400, 'Choose a file or a folder');
  const res = await rawDownload(p.api.cluster, `/nodes/${encodeURIComponent(p.guest.node)}/storage/${encodeURIComponent(p.storage)}/file-restore/download`,
    { volume: point.volid, filepath: b64(fp), ...(folder ? { tar: 0 } : {}) });
  db.prepare("INSERT INTO backup_restores (vmid, user_id, mode, volid, path, state, started_by, started_at, finished_at) VALUES (?, ?, 'files', ?, ?, 'ok', ?, ?, ?)")
    .run(row.vmid, row.user_id, point.volid, fp, req.account?.id ?? null, nowIso(), nowIso());
  audit(req, row.vmid, 'backup_files_downloaded', { backup: id, path: fp });
  const name = (fp.split('/').filter(Boolean).pop() || 'download').replace(/[^\w.-]/g, '_');
  return { res, name: folder ? `${name}.zip` : name };
}

// ---- Restores --------------------------------------------------------------------------------------

const recordRestore = (row, mode, volid, by) => Number(db.prepare(`INSERT INTO backup_restores (vmid, user_id, mode, volid, state, started_by, started_at)
  VALUES (?, ?, ?, ?, 'running', ?, ?)`).run(row.vmid, row.user_id, mode, volid, by, nowIso()).lastInsertRowid);
const finishRestore = (id, state, { error = null, target = null } = {}) => db.prepare('UPDATE backup_restores SET state = ?, error = ?, target_vmid = COALESCE(?, target_vmid), finished_at = ? WHERE id = ?')
  .run(state, error ? String(error).slice(0, 300) : null, target, nowIso(), id);

async function waitRun(run) {
  for (let i = 0; i < 24 * 3600; i += 1) {
    const r = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(run.id);
    if (r.state !== 'running') return r;
    await follow(r);
    const again = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(run.id);
    if (again.state !== 'running') return again;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error('The backup took too long');
}

/** The server itself goes back to the backup (must be shut down). Runs in the background. */
export async function restoreInPlace(req, row, id, { backupFirst = false } = {}) {
  if (restoring.has(row.vmid)) throw fail(409, 'A restore of this server is running already');
  if (volumesOfServer(row.vmid).length) throw fail(409, 'This server holds block storage volumes: restore the backup as a new server instead');
  if (db.prepare("SELECT 1 FROM backup_runs WHERE vmid = ? AND state = 'running'").get(row.vmid)) throw fail(409, 'A backup of this server is running; wait until it has finished');
  const { p, point } = await pointOf(row, id);
  const live = await p.api.get(`${guestPath(p.guest)}/status/current`);
  if (live.status !== 'stopped') throw fail(409, 'Shut down the server first');
  const rid = recordRestore(row, 'replace', point.volid, req.account?.id ?? null);
  restoring.add(row.vmid);
  db.prepare("UPDATE vms SET state = 'restoring', progress = ? WHERE vmid = ?").run(backupFirst ? 'Backing up first' : 'Restoring from backup', row.vmid);
  audit(req, row.vmid, 'backup_restore_started', { mode: 'replace', backup: id, backupFirst });
  const actor = { account: { id: req.account?.id ?? row.user_id }, ip: req.ip };
  (async () => {
    if (backupFirst) {
      // not one of the customer's own backups of the day
      const run = await startRun(row, p.guest, policyOfServer(row), { kind: 'manual', startedBy: null });
      const done = run.state === 'running' ? await waitRun(run) : run;
      if (done.state !== 'ok') throw new Error(`The backup before restoring failed: ${done.error ?? 'unknown error'}`);
      db.prepare('UPDATE vms SET progress = ? WHERE vmid = ?').run('Restoring from backup', row.vmid);
    }
    const upid = await p.api.post(`/nodes/${encodeURIComponent(p.guest.node)}/qemu`, { vmid: row.vmid, archive: point.volid, force: 1 });
    await waitTask(p.guest.node, upid, 6 * 3600_000);
    invalidateGuestCache();
    await syncAfterRollback(row.vmid).catch(() => {});
    db.prepare("UPDATE vms SET state = 'ready', progress = NULL, error = NULL WHERE vmid = ?").run(row.vmid);
    finishRestore(rid, 'ok');
    audit(actor, row.vmid, 'backup_restored', { mode: 'replace', backup: id });
  })().catch((err) => {
    db.prepare("UPDATE vms SET state = 'failed', progress = NULL, error = ? WHERE vmid = ?").run(`Restoring failed: ${err.message}`.slice(0, 500), row.vmid);
    finishRestore(rid, 'failed', { error: err.message });
    audit(actor, row.vmid, 'backup_restore_failed', { mode: 'replace', backup: id, error: String(err.message).slice(0, 300) });
  }).finally(() => restoring.delete(row.vmid));
  return { restoring: true };
}

/** A new server from the backup, on the original's node and plan. Returns the new VMID. */
export async function restoreAsNew(req, row, id, { hostname }) {
  const account = req.account;
  if (!account.can_create) throw fail(403, 'Creating servers is not enabled for your account');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(String(hostname ?? ''))) throw fail(400, 'Name: lowercase letters, digits and dashes');
  const { p, point } = await pointOf(row, id);
  const cfg = await p.api.get(`${guestPath(p.guest)}/config`);
  const spec = { cores: Number(cfg.cores ?? 1) * Number(cfg.sockets ?? 1), memoryMb: Number(cfg.memory ?? 1024), diskGb: Math.ceil(diskSizeGb(cfg[bootDiskKey(cfg)] ?? '')) };
  const limits = limitsOf(account);
  const usage = await usageOf(account.id);
  const over = [];
  if (usage.servers + 1 > limits.servers) over.push(`servers (${limits.servers} allowed)`);
  if (usage.cores + spec.cores > limits.cores) over.push(`CPU cores (${limits.cores - usage.cores} left)`);
  if (usage.memoryMb + spec.memoryMb > limits.memoryMb) over.push(`memory (${((limits.memoryMb - usage.memoryMb) / 1024).toFixed(1)} GB left)`);
  if (usage.diskGb + spec.diskGb > limits.diskGb) over.push(`disk (${limits.diskGb - usage.diskGb} GB left)`);
  if (over.length) throw fail(409, `This exceeds your plan: ${over.join(', ')}`);
  await checkPoolCapacity(account.id, { ...spec, gpus: 0 });
  const net = config.network.enabled ? await ensureNetwork(account.id, p.clusterId) : null;

  const plan = row.plan_id ? planRow(row.plan_id) : null;
  const inv = plan && planIsBilled(plan) ? chargeOrder(req, plan, 1) : null;
  let vmid;
  let upid;
  try {
    ({ vmid, upid } = await serial(async () => {
      const known = db.prepare('SELECT 1 FROM vms WHERE vmid = ?');
      let nid = Number(await pve.get('/cluster/nextid'));
      for (let tries = 0; ; tries += 1, nid += 1) {
        if (tries > 1000) throw new Error('No free VM ID found');
        if (known.get(nid)) continue;
        try { await pve.get('/cluster/nextid', { vmid: nid }); break; } catch { /* taken */ }
      }
      const task = await p.api.post(`/nodes/${encodeURIComponent(p.guest.node)}/qemu`, { vmid: nid, archive: point.volid, unique: 1, pool: config.pve.pool });
      return { vmid: nid, upid: task };
    }));
  } catch (err) {
    if (inv) refundInvoice(inv.id, 'the backup could not be restored');
    throw err;
  }
  db.prepare(`INSERT INTO vms (vmid, user_id, type, label, state, created_by_customer, spec, progress, expires_at, expiry_set_at, datacenter_id, plan_id)
    VALUES (?, ?, 'qemu', ?, 'creating', 1, ?, 'Restoring from backup', ?, ?, ?, ?)`)
    .run(vmid, account.id, hostname, JSON.stringify({ ...spec, hostname, restoredFrom: { vmid: row.vmid, backup: id } }),
      expiryForNewServer(account.id), nowIso(), row.datacenter_id ?? null, row.plan_id ?? null);
  if (inv) completeOrder(inv.id, vmid, 1);
  const rid = recordRestore(row, 'new', point.volid, account.id);
  db.prepare('UPDATE backup_restores SET target_vmid = ? WHERE id = ?').run(vmid, rid);
  audit(req, vmid, 'backup_restore_started', { mode: 'new', from: row.vmid, backup: id, hostname });

  const actor = { account: { id: account.id }, ip: req.ip };
  (async () => {
    await waitTask(p.guest.node, upid, 6 * 3600_000);
    const path = `/nodes/${encodeURIComponent(p.guest.node)}/qemu/${vmid}`;
    const c = await p.api.get(`${path}/config`);
    // keep the system disk; public addresses, GPUs and volumes belong to the original
    const boot = bootDiskKey(c);
    const drop = Object.keys(c).filter((k) => /^hostpci\d+$/.test(k) || /^(net|ipconfig)[1-9]\d*$/.test(k)
      || (DISK.test(k) && k !== boot && !/media=cdrom|cloudinit/.test(String(c[k])))).sort();
    await p.api.put(`${path}/config`, { name: hostname, ...(drop.length ? { delete: drop.join(',') } : {}) });
    const unused = Object.keys(await p.api.get(`${path}/config`)).filter((k) => /^unused\d+$/.test(k));
    if (unused.length) await p.api.put(`${path}/config`, { delete: unused.join(',') });
    if (net) await isolateGuest(path, net).catch(() => {});
    invalidateGuestCache();
    db.prepare("UPDATE vms SET state = 'ready', progress = NULL WHERE vmid = ?").run(vmid);
    finishRestore(rid, 'ok', { target: vmid });
    audit(actor, vmid, 'server_created', { label: hostname, restoredFrom: row.vmid });
  })().catch((err) => {
    db.prepare("UPDATE vms SET state = 'failed', progress = NULL, error = ? WHERE vmid = ?").run(`Restoring failed: ${err.message}`.slice(0, 500), vmid);
    if (inv) refundInvoice(inv.id, 'the backup could not be restored');
    finishRestore(rid, 'failed', { error: err.message, target: vmid });
    audit(actor, vmid, 'backup_restore_failed', { mode: 'new', from: row.vmid, error: String(err.message).slice(0, 300) });
  });
  return { vmid };
}

/** Admin: the latest restores (files, new, replace). */
export function listRestores(limit = 50) {
  return db.prepare(`SELECT r.*, u.email, v.label FROM backup_restores r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN vms v ON v.vmid = r.vmid
    ORDER BY r.id DESC LIMIT ?`).all(limit).map((r) => ({
    id: r.id, vmid: r.vmid, label: r.label, email: r.email, mode: r.mode, backup: String(r.volid).split('/').pop(), targetVmid: r.target_vmid,
    path: r.path, state: r.state, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
  }));
}
