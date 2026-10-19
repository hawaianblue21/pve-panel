// Block storage: extra disks ("volumes") customers create, attach, detach, move
// between their servers, enlarge and delete.
//
// Proxmox has no free-standing disks, so a volume always belongs to one VM:
//   attached   a scsiN entry in the VM config (hot-plugged into a running VM)
//   detached   parked as unusedN on the same VM: data kept, not visible to the guest
//   moved      POST .../move_disk with target-vmid reassigns the disk to another VM
//              (same Proxmox node only)
//   deleted    removing the unusedN entry destroys the volume
// Detaching needs the server to be shut down (a disk pulled from a running system
// can lose data). Deleting or reinstalling a server is refused while it holds
// volumes, because Proxmox destroys a VM's disks with it.
//
// Tiers map to Proxmox storages (e.g. NVMe on ceph-nvme, archive on an HDD pool),
// each with a price per GB per month; the volumes of a server are billed with it.

import { db, audit } from './db.js';
import { pve, clusterGuests, guestPath, waitTask, invalidateGuestCache, guestMayBeHidden, HiddenGuestError } from './pve.js';
import { limitsOf, usageOf } from './provision.js';
import { checkPoolCapacity } from './pools.js';

const KEY = 'volumes';
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const SLOTS = Array.from({ length: 30 }, (_, i) => `scsi${i + 1}`);       // scsi0 is the system disk

const DEFAULTS = {
  enabled: false,
  maxSizeGb: 2048,
  maxPerServer: 8,
  tiers: [{ id: 'standard', name: 'Standard', description: 'General use', storage: '', pricePerGb: 1500 }],
};

// ---- Settings ------------------------------------------------------------------------

export function volumeSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  const s = row ? JSON.parse(row.value) : {};
  return { ...DEFAULTS, ...s, tiers: s.tiers?.length ? s.tiers : DEFAULTS.tiers };
}

const int = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${what}: a whole number from ${min} to ${max}`);
  return n;
};

export function saveVolumeSettings(input) {
  const s = volumeSettings();
  if (typeof input.enabled === 'boolean') s.enabled = input.enabled;
  if (input.maxSizeGb !== undefined) s.maxSizeGb = int(input.maxSizeGb, 1, 65_536, 'Largest volume (GB)');
  if (input.maxPerServer !== undefined) s.maxPerServer = int(input.maxPerServer, 1, 30, 'Volumes per server');
  if (input.tiers !== undefined) {
    if (!Array.isArray(input.tiers) || !input.tiers.length || input.tiers.length > 6) throw fail(400, 'Give 1 to 6 tiers');
    const ids = new Set();
    s.tiers = input.tiers.map((t, i) => {
      const id = String(t.id ?? '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(id)) throw fail(400, `Tier ${i + 1}: ID of lowercase letters, digits and hyphens`);
      if (ids.has(id)) throw fail(400, `Tier ID "${id}" is used twice`);
      ids.add(id);
      const name = String(t.name ?? '').trim();
      if (!name || name.length > 40) throw fail(400, `Tier ${id}: a name of up to 40 characters`);
      const storage = String(t.storage ?? '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$|^$/.test(storage)) throw fail(400, `Tier ${id}: not a valid Proxmox storage ID`);
      return {
        id, name, storage, description: String(t.description ?? '').trim().slice(0, 120),
        pricePerGb: int(t.pricePerGb ?? 0, 0, 10_000_000, `Tier ${id}: price per GB`),
      };
    });
    // a tier still used by volumes can't disappear
    const used = db.prepare('SELECT DISTINCT tier FROM volumes').all().map((r) => r.tier).filter((t) => !ids.has(t));
    if (used.length) throw fail(409, `Tier ${used.join(', ')} still has volumes; keep it (you can raise its price or rename it)`);
  }
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(s));
  return volumeSettings();
}

const tierOf = (id, s = volumeSettings()) => s.tiers.find((t) => t.id === id) ?? null;

// ---- Reading ---------------------------------------------------------------------------

function pub(v, guests, s = volumeSettings()) {
  const tier = tierOf(v.tier, s);
  const g = guests?.get(v.vmid);
  return {
    id: v.id, label: v.label, tier: v.tier, tierName: tier?.name ?? v.tier, sizeGb: v.size_gb,
    vmid: v.vmid, server: db.prepare('SELECT label FROM vms WHERE vmid = ?').get(v.vmid)?.label || g?.name || `server ${v.vmid}`,
    node: g?.node ?? null, attached: !!v.slot, slot: v.slot,
    device: v.slot ? `/dev/sd${String.fromCharCode(97 + Number(v.slot.slice(4)))}` : null,   // scsi1 → /dev/sdb (typical)
    monthly: (tier?.pricePerGb ?? 0) * v.size_gb, createdAt: v.created_at,
  };
}

/** GB of a customer's detached volumes: not in any VM's active config, still theirs. */
export const detachedGbOf = (userId) => db.prepare('SELECT COALESCE(SUM(size_gb), 0) AS gb FROM volumes WHERE user_id = ? AND slot IS NULL').get(userId).gb;

/** Monthly price and size of the volumes a server holds (billing.js). */
export function volumesOfServer(vmid, s = volumeSettings()) {
  const rows = db.prepare('SELECT * FROM volumes WHERE vmid = ? ORDER BY id').all(vmid);
  return rows.map((v) => ({ label: v.label, sizeGb: v.size_gb, tier: tierOf(v.tier, s)?.name ?? v.tier, monthly: (tierOf(v.tier, s)?.pricePerGb ?? 0) * v.size_gb }));
}

export async function customerVolumes(account) {
  const s = volumeSettings();
  if (!s.enabled) return { enabled: false };
  let guests = null;
  try { guests = await clusterGuests(); } catch { /* Proxmox unreachable: list without nodes */ }
  const volumes = db.prepare('SELECT * FROM volumes WHERE user_id = ? ORDER BY label').all(account.id).map((v) => pub(v, guests, s));
  const servers = db.prepare("SELECT vmid, label, expired_at FROM vms WHERE user_id = ? AND state = 'ready' ORDER BY vmid").all(account.id)
    .map((r) => ({ vmid: r.vmid, name: r.label || guests?.get(r.vmid)?.name || `server ${r.vmid}`, node: guests?.get(r.vmid)?.node ?? null,
      type: guests?.get(r.vmid)?.type ?? 'qemu', status: guests?.get(r.vmid)?.status ?? null, expired: !!r.expired_at }))
    .filter((r) => r.type === 'qemu');
  const limits = limitsOf(account);
  let usedGb = null;
  try { usedGb = (await usageOf(account.id)).diskGb; } catch { /* unknown right now */ }
  return {
    enabled: true, volumes, servers, maxSizeGb: s.maxSizeGb, maxPerServer: s.maxPerServer,
    tiers: s.tiers.map(({ id, name, description, pricePerGb }) => ({ id, name, description, pricePerGb })),
    disk: { usedGb, limitGb: limits.diskGb },
  };
}

// ---- Changing ----------------------------------------------------------------------------

const busy = new Set();          // vmids with a volume operation running
async function exclusive(vmids, fn) {
  if (vmids.some((v) => busy.has(v))) throw fail(409, 'Another storage change on this server is still running. Try again in a moment.');
  vmids.forEach((v) => busy.add(v));
  try { return await fn(); } finally { vmids.forEach((v) => busy.delete(v)); invalidateGuestCache(); }
}

/** A server of this customer that volumes may be attached to. */
async function usableServer(account, vmid, { what = 'attach volumes to' } = {}) {
  const row = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?').get(vmid, account.id);
  if (!row) throw fail(404, 'Server not found');
  if (row.state !== 'ready') throw fail(409, 'Wait until the current operation on this server has finished');
  if (row.expired_at) throw fail(403, 'This server has expired. Renew it first.');
  const guest = (await clusterGuests(true)).get(vmid);
  if (!guest) throw fail(404, 'Server not found in Proxmox');
  if (guest.type !== 'qemu') throw fail(400, `You can only ${what} virtual machines, not containers`);
  const cfg = await pve.get(`${guestPath(guest)}/config`);
  return { row, guest, cfg, path: guestPath(guest) };
}

const freeSlot = (cfg) => SLOTS.find((k) => cfg[k] === undefined) ?? null;
const attachedCount = (vmid) => db.prepare('SELECT COUNT(*) AS n FROM volumes WHERE vmid = ? AND slot IS NOT NULL').get(vmid).n;
const volumeRow = (account, id) => {
  const v = db.prepare('SELECT * FROM volumes WHERE id = ? AND user_id = ?').get(id, account.id);
  if (!v) throw fail(404, 'Volume not found');
  return v;
};

/** Quota (customer limit and resource pool) for `extraGb` more disk. */
async function checkRoom(account, extraGb) {
  const limits = limitsOf(account);
  const used = (await usageOf(account.id)).diskGb;          // includes detached volumes
  if (used + extraGb > limits.diskGb) {
    throw fail(409, `This exceeds your disk limit: ${Math.max(0, limits.diskGb - used)} GB left of ${limits.diskGb} GB`);
  }
  await checkPoolCapacity(account.id, { diskGb: extraGb });
}

function cleanLabel(label) {
  const l = String(label ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/i.test(l)) throw fail(400, 'Name: letters, digits and hyphens, up to 40 characters');
  return l;
}

export async function createVolume(req, { label, tier: tierId, sizeGb, vmid }) {
  const s = volumeSettings();
  if (!s.enabled) throw fail(404, 'Block storage is not available');
  const account = req.account;
  const name = cleanLabel(label);
  if (db.prepare('SELECT 1 FROM volumes WHERE user_id = ? AND label = ?').get(account.id, name)) throw fail(409, `You already have a volume called ${name}`);
  const tier = tierOf(tierId, s);
  if (!tier) throw fail(400, 'Choose a storage tier');
  const size = int(sizeGb, 1, s.maxSizeGb, 'Size (GB)');
  return exclusive([vmid], async () => {
    const { guest, cfg, path } = await usableServer(account, vmid);
    if (attachedCount(vmid) >= s.maxPerServer) throw fail(409, `A server can have at most ${s.maxPerServer} volumes attached`);
    const slot = freeSlot(cfg);
    if (!slot) throw fail(409, 'This server has no free disk slot');
    await checkRoom(account, size);
    // the tier's storage, or the one the system disk is on
    const storage = tier.storage || String(cfg.scsi0 ?? cfg.virtio0 ?? cfg.sata0 ?? '').split(':')[0];
    if (!storage) throw fail(500, 'No storage for the volume: set one on the tier');
    try {
      await waitTask(guest.node, await pve.post(`${path}/config`, { [slot]: `${storage}:${size},discard=on` }), 10 * 60_000);
    } catch (err) {
      audit(req, vmid, 'volume_create_failed', { label: name, tier: tier.id, sizeGb: size, error: String(err.message).slice(0, 300) });
      throw fail(502, `Proxmox could not create the volume: ${err.message}`);
    }
    const after = await pve.get(`${path}/config`);
    const volid = String(after[slot] ?? '').split(',')[0];
    if (!volid) throw fail(502, 'Proxmox did not report the new volume');
    const id = Number(db.prepare('INSERT INTO volumes (user_id, vmid, label, tier, size_gb, volid, slot) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(account.id, vmid, name, tier.id, size, volid, slot).lastInsertRowid);
    audit(req, vmid, 'volume_created', { id, label: name, tier: tier.id, sizeGb: size, slot, volid });
    return pub(db.prepare('SELECT * FROM volumes WHERE id = ?').get(id), await clusterGuests(), s);
  });
}

export async function detachVolume(req, id) {
  const v = volumeRow(req.account, id);
  if (!v.slot) throw fail(409, 'This volume is not attached');
  return exclusive([v.vmid], async () => {
    const guest = (await clusterGuests(true)).get(v.vmid);
    if (!guest) throw fail(404, 'Server not found in Proxmox');
    if (guest.status !== 'stopped') throw fail(409, 'Shut the server down first, so no data is lost (unmount the volume inside the server before that)');
    const path = guestPath(guest);
    const cfg = await pve.get(`${path}/config`);
    if (String(cfg[v.slot] ?? '').split(',')[0] !== v.volid) throw fail(409, 'The server configuration changed; ask support to check this volume');
    await pve.put(`${path}/config`, { delete: v.slot });                 // Proxmox keeps it as unusedN
    db.prepare('UPDATE volumes SET slot = NULL WHERE id = ?').run(v.id);
    audit(req, v.vmid, 'volume_detached', { id: v.id, label: v.label, slot: v.slot });
    return pub(db.prepare('SELECT * FROM volumes WHERE id = ?').get(v.id), await clusterGuests());
  });
}

const unusedKeyOf = (cfg, volid) => Object.keys(cfg).find((k) => /^unused\d+$/.test(k) && String(cfg[k]).split(',')[0] === volid) ?? null;

export async function attachVolume(req, id, targetVmid) {
  const s = volumeSettings();
  const v = volumeRow(req.account, id);
  if (v.slot) throw fail(409, 'This volume is attached; detach it first');
  return exclusive([...new Set([v.vmid, targetVmid])], async () => {
    const target = await usableServer(req.account, targetVmid);
    if (attachedCount(targetVmid) >= s.maxPerServer) throw fail(409, `A server can have at most ${s.maxPerServer} volumes attached`);
    const slot = freeSlot(target.cfg);
    if (!slot) throw fail(409, 'That server has no free disk slot');
    const holder = (await clusterGuests()).get(v.vmid);
    if (!holder) throw fail(404, 'The server holding this volume is not found in Proxmox');
    const holderCfg = await pve.get(`${guestPath(holder)}/config`);
    const unused = unusedKeyOf(holderCfg, v.volid);
    if (!unused) throw fail(409, 'The volume was not found on its server; ask support to check it');
    let volid = v.volid;
    if (targetVmid === v.vmid) {
      await pve.put(`${target.path}/config`, { [slot]: `${v.volid},discard=on` });
    } else {
      if (holder.node !== target.guest.node) {
        throw fail(409, `Volumes can only move between servers on the same host (${holder.node}); ${target.row.label || `server ${targetVmid}`} runs on ${target.guest.node}`);
      }
      try {
        await waitTask(holder.node, await pve.post(`${guestPath(holder)}/move_disk`, { disk: unused, 'target-vmid': targetVmid, 'target-disk': slot }), 10 * 60_000);
      } catch (err) {
        throw fail(502, `Proxmox could not move the volume: ${err.message}`);
      }
      volid = String((await pve.get(`${target.path}/config`))[slot] ?? '').split(',')[0];
      if (!volid) throw fail(502, 'Proxmox did not report the moved volume');
    }
    db.prepare('UPDATE volumes SET vmid = ?, slot = ?, volid = ? WHERE id = ?').run(targetVmid, slot, volid, v.id);
    audit(req, targetVmid, 'volume_attached', { id: v.id, label: v.label, slot, from: v.vmid });
    return pub(db.prepare('SELECT * FROM volumes WHERE id = ?').get(v.id), await clusterGuests(), s);
  });
}

export async function resizeVolume(req, id, sizeGb) {
  const s = volumeSettings();
  const v = volumeRow(req.account, id);
  const size = int(sizeGb, 1, s.maxSizeGb, 'Size (GB)');
  if (size <= v.size_gb) throw fail(400, `Volumes can only grow; this one has ${v.size_gb} GB`);
  if (!v.slot) throw fail(409, 'Attach the volume to a server to enlarge it');
  return exclusive([v.vmid], async () => {
    const { guest, cfg, path } = await usableServer(req.account, v.vmid, { what: 'enlarge volumes on' });
    if (String(cfg[v.slot] ?? '').split(',')[0] !== v.volid) throw fail(409, 'The server configuration changed; ask support to check this volume');
    await checkRoom(req.account, size - v.size_gb);
    try {
      await waitTask(guest.node, await pve.put(`${path}/resize`, { disk: v.slot, size: `${size}G` }), 10 * 60_000);
    } catch (err) {
      throw fail(502, `Proxmox could not enlarge the volume: ${err.message}`);
    }
    db.prepare('UPDATE volumes SET size_gb = ? WHERE id = ?').run(size, v.id);
    audit(req, v.vmid, 'volume_resized', { id: v.id, label: v.label, from: v.size_gb, to: size });
    return pub(db.prepare('SELECT * FROM volumes WHERE id = ?').get(v.id), await clusterGuests(), s);
  });
}

export function renameVolume(req, id, label) {
  const v = volumeRow(req.account, id);
  const name = cleanLabel(label);
  if (db.prepare('SELECT 1 FROM volumes WHERE user_id = ? AND label = ? AND id <> ?').get(req.account.id, name, v.id)) throw fail(409, `You already have a volume called ${name}`);
  db.prepare('UPDATE volumes SET label = ? WHERE id = ?').run(name, v.id);
  audit(req, v.vmid, 'volume_renamed', { id: v.id, from: v.label, to: name });
  return { id: v.id, label: name };
}

export async function deleteVolume(req, id) {
  const v = volumeRow(req.account, id);
  if (v.slot) throw fail(409, 'Detach the volume before deleting it');
  return exclusive([v.vmid], async () => {
    const holder = (await clusterGuests(true)).get(v.vmid);
    if (!holder && guestMayBeHidden()) throw new HiddenGuestError();
    if (holder) {
      const path = guestPath(holder);
      const unused = unusedKeyOf(await pve.get(`${path}/config`), v.volid);
      // removing the unusedN entry destroys the volume
      if (unused) await pve.put(`${path}/config`, { delete: unused });
    }
    db.prepare('DELETE FROM volumes WHERE id = ?').run(v.id);
    audit(req, v.vmid, 'volume_deleted', { id: v.id, label: v.label, sizeGb: v.size_gb, volid: v.volid });
    return { deleted: true };
  });
}

// ---- Administration ------------------------------------------------------------------------

export async function adminVolumes() {
  let guests = null;
  try { guests = await clusterGuests(); } catch { /* list without nodes */ }
  const s = volumeSettings();
  const rows = db.prepare('SELECT v.*, u.email FROM volumes v JOIN users u ON u.id = v.user_id ORDER BY u.email, v.label').all();
  return {
    settings: s,
    volumes: rows.map((v) => ({ ...pub(v, guests, s), email: v.email, userId: v.user_id, volid: v.volid })),
    totals: s.tiers.map((t) => ({ tier: t.id, name: t.name, count: rows.filter((v) => v.tier === t.id).length, gb: rows.filter((v) => v.tier === t.id).reduce((a, v) => a + v.size_gb, 0) })),
  };
}
