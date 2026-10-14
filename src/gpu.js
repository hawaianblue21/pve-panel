// GPU compute: whole GPUs (PCI passthrough) and shared GPUs (NVIDIA vGPU / mdev).
//
// The panel builds on Proxmox's PCI resource mappings (Datacenter > Resource
// Mappings > PCI Devices, Proxmox VE 8+): a mapping names one or more physical
// devices across nodes, so a guest is configured with `hostpciN: mapping=<id>`
// instead of a node-specific PCI address and can still migrate between the
// mapped nodes. A GPU profile in the panel points at one mapping:
//   passthrough  the guest gets a whole device of the mapping
//   mdev         the guest gets a mediated device of `mdev_type` (vGPU slice);
//                the mapping must have "Use with Mediated Devices" enabled.
//
// Proxmox permissions for the panel's token: Mapping.Audit + Mapping.Use on
// /mapping/pci (or per mapping), Sys.Audit on /nodes (hardware list) and
// VM.Config.HWType on the guests (already part of self-service provisioning).

import { db, audit } from './db.js';
import { pve, locateGuest, guestPath, invalidateGuestCache } from './pve.js';
import { checkPoolCapacity } from './pools.js';

export class GpuError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

const MAX_SLOTS = 16; // hostpci0 … hostpci15

// ---- Proxmox side --------------------------------------------------------------

/** "node=pve1,path=0000:01:00.0,id=10de:2684,iommugroup=14" -> { node, path, id, iommugroup } */
export function parseMapEntry(entry) {
  const out = {};
  for (const part of String(entry).split(',')) {
    const [k, ...v] = part.split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  }
  return out;
}

/** PCI resource mappings, each with its devices per node. */
export async function pciMappings() {
  const list = await pve.get('/cluster/mapping/pci');
  return (list ?? []).map((m) => ({
    id: m.id,
    description: m.description ?? '',
    mdev: !!Number(m.mdev ?? 0),
    devices: [].concat(m.map ?? []).map(parseMapEntry).filter((d) => d.node && d.path),
  }));
}

/** Display controllers (PCI class 0x03) on a node. */
export async function nodeGpus(node) {
  const list = await pve.get(`/nodes/${encodeURIComponent(node)}/hardware/pci`);
  return (list ?? [])
    .filter((d) => String(d.class ?? '').startsWith('0x03'))
    .map((d) => ({
      path: d.id, vendor: d.vendor_name ?? d.vendor ?? '', device: d.device_name ?? d.device ?? '',
      iommugroup: d.iommugroup ?? null, mdevCapable: !!d.mdev,
    }));
}

/** Mediated device types a device offers, with how many are still free. */
export async function mdevTypes(node, path) {
  const list = await pve.get(`/nodes/${encodeURIComponent(node)}/hardware/pci/${encodeURIComponent(path)}/mdev`);
  return (list ?? []).map((t) => ({
    type: t.type, name: t.name ?? t.type, description: t.description ?? '', available: Number(t.available ?? 0),
  }));
}

// ---- Profiles ---------------------------------------------------------------------

const profileRow = (r) => r && ({
  id: r.id, key: r.key, name: r.name, mode: r.mode, mapping: r.mapping, mdevType: r.mdev_type ?? null,
  vramGb: r.vram_gb ?? null, description: r.description ?? '', createdAt: r.created_at,
});

export const listProfiles = () => db.prepare('SELECT * FROM gpu_profiles ORDER BY name').all().map(profileRow);
export const profileById = (id) => profileRow(db.prepare('SELECT * FROM gpu_profiles WHERE id = ?').get(id));

const PROFILE_KEY = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MAPPING_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const MDEV_TYPE = /^[A-Za-z0-9_.-]{1,64}$/;

async function cleanProfile(input, current = {}) {
  const p = { ...current, ...input };
  if (!PROFILE_KEY.test(p.key ?? '')) throw new GpuError(400, 'Key: 1-31 lowercase letters, digits or dashes (e.g. rtx4090)');
  if (!p.name?.trim()) throw new GpuError(400, 'Give the profile a name');
  if (!['passthrough', 'mdev'].includes(p.mode)) throw new GpuError(400, 'Mode is passthrough or mdev');
  if (!MAPPING_ID.test(p.mapping ?? '')) throw new GpuError(400, 'Choose a Proxmox PCI resource mapping');
  if (p.mode === 'mdev' && !MDEV_TYPE.test(p.mdevType ?? '')) throw new GpuError(400, 'Choose the mediated device type (e.g. nvidia-660)');
  if (p.vramGb !== undefined && p.vramGb !== null && (!Number.isInteger(p.vramGb) || p.vramGb < 0)) {
    throw new GpuError(400, 'Video memory is a whole number of GB');
  }
  // The mapping must exist in Proxmox (and allow mdev when the profile is mdev).
  const mapping = (await pciMappings()).find((m) => m.id === p.mapping);
  if (!mapping) throw new GpuError(400, `Proxmox has no PCI resource mapping "${p.mapping}"`);
  if (p.mode === 'mdev' && !mapping.mdev) {
    throw new GpuError(400, `Mapping "${p.mapping}" isn't set to "Use with Mediated Devices" in Proxmox`);
  }
  return {
    key: p.key, name: p.name.trim(), mode: p.mode, mapping: p.mapping,
    mdevType: p.mode === 'mdev' ? p.mdevType : null, vramGb: p.vramGb ?? null, description: (p.description ?? '').trim(),
  };
}

export async function createProfile(input) {
  const p = await cleanProfile(input);
  if (db.prepare('SELECT 1 FROM gpu_profiles WHERE key = ?').get(p.key)) throw new GpuError(409, 'A profile with this key exists');
  const { lastInsertRowid } = db.prepare(`INSERT INTO gpu_profiles (key, name, mode, mapping, mdev_type, vram_gb, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.key, p.name, p.mode, p.mapping, p.mdevType, p.vramGb, p.description);
  return profileById(Number(lastInsertRowid));
}

export async function updateProfile(id, input) {
  const current = profileById(id);
  if (!current) throw new GpuError(404, 'Profile not found');
  const p = await cleanProfile(input, current);
  const used = db.prepare('SELECT COUNT(*) AS n FROM gpu_assignments WHERE profile_id = ?').get(id).n;
  if (used && (p.mapping !== current.mapping || p.mode !== current.mode || p.mdevType !== current.mdevType)) {
    throw new GpuError(409, `${used} server(s) use this profile; its mapping and mode can't change. Create a new profile instead.`);
  }
  db.prepare('UPDATE gpu_profiles SET key = ?, name = ?, mode = ?, mapping = ?, mdev_type = ?, vram_gb = ?, description = ? WHERE id = ?')
    .run(p.key, p.name, p.mode, p.mapping, p.mdevType, p.vramGb, p.description, id);
  return profileById(id);
}

export function deleteProfile(id) {
  if (!profileById(id)) throw new GpuError(404, 'Profile not found');
  const used = db.prepare('SELECT COUNT(*) AS n FROM gpu_assignments WHERE profile_id = ?').get(id).n;
  if (used) throw new GpuError(409, `${used} server(s) still have a GPU of this profile. Detach them first.`);
  for (const r of db.prepare('SELECT name, gpu_profiles FROM resource_pools').all()) {
    if (JSON.parse(r.gpu_profiles || '[]').includes(id)) throw new GpuError(409, `Resource pool "${r.name}" offers this profile. Remove it there first.`);
  }
  db.prepare('DELETE FROM gpu_profiles WHERE id = ?').run(id);
}

// ---- Capacity -----------------------------------------------------------------------

/**
 * How many more GPUs of a profile can be handed out.
 * passthrough: devices in the mapping minus devices the panel has given out
 *              (guests configured directly in Proxmox aren't counted).
 * mdev:        free instances of the mdev type, as Proxmox reports them.
 */
export async function profileCapacity(profile, mappings = null) {
  const mapping = (mappings ?? await pciMappings()).find((m) => m.id === profile.mapping);
  if (!mapping) return { total: 0, used: 0, free: 0, problem: `Mapping "${profile.mapping}" no longer exists in Proxmox` };
  const used = db.prepare(`SELECT COUNT(*) AS n FROM gpu_assignments a JOIN gpu_profiles p ON p.id = a.profile_id
    WHERE p.mapping = ? AND p.mode = ?`).get(profile.mapping, profile.mode).n;
  if (profile.mode === 'passthrough') {
    const total = mapping.devices.length;
    return { total, used, free: Math.max(0, total - used), problem: null };
  }
  let free = 0;
  let problem = null;
  for (const d of mapping.devices) {
    try {
      free += (await mdevTypes(d.node, d.path)).find((t) => t.type === profile.mdevType)?.available ?? 0;
    } catch (err) {
      problem = `Could not read mediated devices on ${d.node}: ${err.message}`;
    }
  }
  // Reserved at creation but not yet in a VM config: Proxmox still counts them as available
  const reserved = db.prepare(`SELECT COUNT(*) AS n FROM gpu_assignments a JOIN gpu_profiles p ON p.id = a.profile_id
    WHERE p.mapping = ? AND p.mode = 'mdev' AND p.mdev_type = ? AND a.slot = -1`).get(profile.mapping, profile.mdevType).n;
  free = Math.max(0, free - reserved);
  return { total: used + free, used, free, problem };
}

// GPUs being handed out right now (checked, not yet recorded in gpu_assignments).
// Check and claim happen in one synchronous step, so two requests can't both
// take the last free GPU while the first one is still cloning its server.
const claiming = new Map();
const claimKey = (p) => `${p.mapping}|${p.mode}|${p.mdevType ?? ''}`;

/**
 * Claims one GPU of the profile. Returns a release function (call it once the
 * assignment row exists, or on failure), or null when none is free.
 */
export async function claimGpu(profile) {
  const cap = await profileCapacity(profile);
  const key = claimKey(profile);
  const busy = claiming.get(key) ?? 0;
  if (cap.free - busy < 1) return null;
  claiming.set(key, busy + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (claiming.get(key) ?? 1) - 1;
    if (n > 0) claiming.set(key, n); else claiming.delete(key);
  };
}

/** Everything the GPU tab shows. */
export async function gpuInventory() {
  const mappings = await pciMappings().catch((err) => { throw new GpuError(502, `Proxmox resource mappings: ${err.message}`); });
  // Mediated device types offered by the first device of each mdev mapping
  await Promise.all(mappings.filter((m) => m.mdev && m.devices.length).map(async (m) => {
    m.mdevTypes = await mdevTypes(m.devices[0].node, m.devices[0].path).catch(() => []);
  }));
  const nodes = [...new Set(mappings.flatMap((m) => m.devices.map((d) => d.node)))];
  const devices = {};
  await Promise.all(nodes.map(async (node) => {
    devices[node] = await nodeGpus(node).catch(() => []);
  }));
  const profiles = await Promise.all(listProfiles().map(async (p) => ({ ...p, capacity: await profileCapacity(p, mappings) })));
  const assignments = db.prepare(`
    SELECT a.vmid, a.slot, a.profile_id AS profileId, a.created_at AS createdAt, u.email AS owner, v.label
    FROM gpu_assignments a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN vms v ON v.vmid = a.vmid
    ORDER BY a.vmid, a.slot
  `).all();
  return { mappings, devices, profiles, assignments };
}

// ---- Attach / detach ------------------------------------------------------------------

/** hostpci value for a profile, e.g. "mapping=a16,mdev=nvidia-660,pcie=1". */
export function hostpciValue(profile, cfg) {
  const parts = [`mapping=${profile.mapping}`];
  if (profile.mode === 'mdev') parts.push(`mdev=${profile.mdevType}`);
  // PCIe needs the q35 machine type; changing the machine type of an existing
  // guest can break its OS, so the panel never does that on its own.
  if (/q35/.test(cfg.machine ?? '')) parts.push('pcie=1');
  return parts.join(',');
}

export function freeSlot(cfg) {
  for (let i = 0; i < MAX_SLOTS; i += 1) if (!cfg[`hostpci${i}`]) return i;
  return null;
}

/** Profiles a customer may use (through their resource pool). */
export function profilesForUser(userId) {
  const pool = db.prepare(`SELECT p.* FROM resource_pools p JOIN users u ON u.resource_pool_id = p.id WHERE u.id = ?`).get(userId);
  if (!pool || !(pool.max_gpus > 0)) return []; // GPUs are opt-in per pool
  const allowed = JSON.parse(pool.gpu_profiles || '[]');
  return listProfiles().filter((p) => !allowed.length || allowed.includes(p.id));
}

/**
 * Writes the GPU into a (stopped) guest's configuration and records it.
 * `path` is the guest's API path; `userId` the owner the GPU counts against.
 */
export async function attachToConfig(path, vmid, profile, userId) {
  const cfg = await pve.get(`${path}/config`);
  const slot = freeSlot(cfg);
  if (slot === null) throw new GpuError(409, 'This server has no free PCI slot left');
  await pve.put(`${path}/config`, { [`hostpci${slot}`]: hostpciValue(profile, cfg) });
  db.prepare('INSERT INTO gpu_assignments (vmid, slot, profile_id, user_id) VALUES (?, ?, ?, ?)').run(vmid, slot, profile.id, userId);
  return slot;
}

/** Admin: give an assigned, stopped server a GPU of a profile. */
export async function attachGpu(req, vmid, profileId) {
  const profile = profileById(profileId);
  if (!profile) throw new GpuError(404, 'GPU profile not found');
  const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
  if (!row) throw new GpuError(404, 'Only servers assigned to a customer can get a GPU here');
  const guest = await locateGuest(vmid);
  if (guest.type !== 'qemu') throw new GpuError(400, 'Containers (LXC) can\'t use PCI passthrough or vGPU');
  if (guest.status !== 'stopped') throw new GpuError(409, 'Shut the server down first; GPUs are attached to stopped servers');
  const release = await claimGpu(profile);
  if (!release) throw new GpuError(409, `No ${profile.name} is free right now`);
  let slot;
  try {
    await checkPoolCapacity(row.user_id, { gpus: 1 });
    slot = await attachToConfig(guestPath(guest), vmid, profile, row.user_id);
  } finally {
    release();
  }
  invalidateGuestCache();
  audit(req, vmid, 'admin_gpu_attach', { profile: profile.key, slot });
  return { vmid, slot, profile: profile.key };
}

export async function detachGpu(req, vmid, slot) {
  const a = db.prepare('SELECT * FROM gpu_assignments WHERE vmid = ? AND slot = ?').get(vmid, slot);
  if (!a) throw new GpuError(404, 'This server has no GPU in that slot');
  const guest = await locateGuest(vmid);
  if (guest.status !== 'stopped') throw new GpuError(409, 'Shut the server down first');
  await pve.put(`${guestPath(guest)}/config`, { delete: `hostpci${slot}` });
  db.prepare('DELETE FROM gpu_assignments WHERE vmid = ? AND slot = ?').run(vmid, slot);
  invalidateGuestCache();
  audit(req, vmid, 'admin_gpu_detach', { slot });
}

export const gpusOfServer = (vmid) => db.prepare(`
  SELECT a.slot, p.id AS profileId, p.key, p.name, p.mode, p.vram_gb AS vramGb
  FROM gpu_assignments a JOIN gpu_profiles p ON p.id = a.profile_id WHERE a.vmid = ? ORDER BY a.slot
`).all(vmid);

/**
 * Writes the GPUs the panel has recorded for a server into its configuration:
 * a GPU reserved at creation (slot -1) gets a free slot; after a reinstall
 * (fresh clone) the recorded slots are written again. Runs before first start.
 */
export async function applyRecordedGpus(path, vmid) {
  const rows = db.prepare(`SELECT a.slot, p.* FROM gpu_assignments a JOIN gpu_profiles p ON p.id = a.profile_id
    WHERE a.vmid = ? ORDER BY a.slot DESC`).all(vmid);
  if (!rows.length) return [];
  const cfg = await pve.get(`${path}/config`);
  const params = {};
  const slots = [];
  for (const r of rows) {
    let { slot } = r;
    if (slot < 0) {
      slot = freeSlot({ ...cfg, ...params });
      if (slot === null) throw new GpuError(409, 'The server has no free PCI slot for its GPU');
      db.prepare('UPDATE gpu_assignments SET slot = ? WHERE vmid = ? AND slot = -1').run(slot, vmid);
    }
    params[`hostpci${slot}`] = hostpciValue(profileRow(r), cfg);
    slots.push(slot);
  }
  await pve.put(`${path}/config`, params);
  return slots;
}
