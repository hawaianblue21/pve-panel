// Datacenters and resource allocation pools.
//
// Datacenter: a named location (e.g. "Jakarta DC1") made of Proxmox nodes, with
// an optional target storage. New servers in a datacenter are cloned onto one of
// its nodes.
//
// Resource pool: a shared envelope several customers draw from (one tenant
// organisation, a department, a reseller). It caps the TOTAL of its members:
// vCPU, memory, disk, public IPv4 addresses, GPUs, object storage buckets and
// gigabytes, and lists the datacenters and GPU profiles its members may use.
// The per-customer limits still apply inside it.
//   vCPU, memory, disk, public IPs, object storage GB: NULL = no cap at pool level
//   GPUs and object storage buckets are opt-in: NULL or 0 = not included

import { db } from './db.js';
import { usageOf } from './provision.js';
import { clusterOfNode } from './pve.js';

export class PoolError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

const json = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

// ---- Datacenters -----------------------------------------------------------------

const dcRow = (r) => r && ({
  id: r.id, key: r.key, name: r.name, location: r.location ?? '', nodes: json(r.nodes, []),
  storage: r.storage ?? '', createdAt: r.created_at,
});

export const listDatacenters = () => db.prepare('SELECT * FROM datacenters ORDER BY name').all().map(dcRow);
export const datacenterById = (id) => dcRow(db.prepare('SELECT * FROM datacenters WHERE id = ?').get(id));

const DC_KEY = /^[a-z0-9][a-z0-9-]{0,30}$/;
const NODE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;

function cleanDatacenter(input, current = {}) {
  const next = { ...current, ...input };
  if (!DC_KEY.test(next.key ?? '')) throw new PoolError(400, 'Key: 1-31 lowercase letters, digits or dashes (e.g. jkt-dc1)');
  if (!next.name?.trim()) throw new PoolError(400, 'Give the datacenter a name');
  const nodes = [...new Set((next.nodes ?? []).map((n) => String(n).trim()).filter(Boolean))];
  if (!nodes.length) throw new PoolError(400, 'Add at least one Proxmox node');
  const bad = nodes.find((n) => !NODE.test(n));
  if (bad) throw new PoolError(400, `"${bad}" is not a valid Proxmox node name`);
  if (next.storage && !/^[A-Za-z][A-Za-z0-9._-]{0,99}$/.test(next.storage)) throw new PoolError(400, 'Storage: a Proxmox storage id');
  return { key: next.key, name: next.name.trim(), location: (next.location ?? '').trim(), nodes, storage: next.storage?.trim() || null };
}

export function createDatacenter(input) {
  const d = cleanDatacenter(input);
  if (db.prepare('SELECT 1 FROM datacenters WHERE key = ?').get(d.key)) throw new PoolError(409, 'A datacenter with this key exists');
  const taken = nodesInOtherDatacenters(null, d.nodes);
  if (taken) throw new PoolError(409, taken);
  const { lastInsertRowid } = db.prepare('INSERT INTO datacenters (key, name, location, nodes, storage) VALUES (?, ?, ?, ?, ?)')
    .run(d.key, d.name, d.location, JSON.stringify(d.nodes), d.storage);
  return datacenterById(Number(lastInsertRowid));
}

export function updateDatacenter(id, input) {
  const current = datacenterById(id);
  if (!current) throw new PoolError(404, 'Datacenter not found');
  const d = cleanDatacenter(input, current);
  const taken = nodesInOtherDatacenters(id, d.nodes);
  if (taken) throw new PoolError(409, taken);
  db.prepare('UPDATE datacenters SET key = ?, name = ?, location = ?, nodes = ?, storage = ? WHERE id = ?')
    .run(d.key, d.name, d.location, JSON.stringify(d.nodes), d.storage, id);
  return datacenterById(id);
}

/** A node belongs to one datacenter only. */
function nodesInOtherDatacenters(id, nodes) {
  for (const dc of listDatacenters()) {
    if (dc.id === id) continue;
    const both = dc.nodes.filter((n) => nodes.includes(n));
    if (both.length) return `Node ${both.join(', ')} already belongs to ${dc.name}`;
  }
  return null;
}

export function deleteDatacenter(id) {
  if (!datacenterById(id)) throw new PoolError(404, 'Datacenter not found');
  const servers = db.prepare('SELECT COUNT(*) AS n FROM vms WHERE datacenter_id = ?').get(id).n;
  if (servers) throw new PoolError(409, `${servers} server(s) were created in this datacenter. Keep it, or rename it instead.`);
  for (const p of listPools()) {
    if (p.datacenters.includes(id)) throw new PoolError(409, `Resource pool "${p.name}" uses this datacenter. Remove it there first.`);
  }
  db.prepare('DELETE FROM datacenters WHERE id = ?').run(id);
}

/** Datacenter a node belongs to (null if none). */
export function datacenterOfNode(node) {
  return listDatacenters().find((d) => d.nodes.includes(node)) ?? null;
}

// ---- Pools ---------------------------------------------------------------------------

export const LIMIT_FIELDS = {
  maxCores: 'max_cores', maxMemoryMb: 'max_memory_mb', maxDiskGb: 'max_disk_gb', maxPublicIps: 'max_public_ips',
  maxGpus: 'max_gpus', maxS3Buckets: 'max_s3_buckets', maxS3Gb: 'max_s3_gb',
};

const poolRow = (r) => r && ({
  id: r.id, name: r.name, description: r.description ?? '',
  ...Object.fromEntries(Object.entries(LIMIT_FIELDS).map(([k, col]) => [k, r[col]])),
  datacenters: json(r.datacenters, []), gpuProfiles: json(r.gpu_profiles, []), createdAt: r.created_at,
});

export const listPools = () => db.prepare('SELECT * FROM resource_pools ORDER BY name').all().map(poolRow);
export const poolById = (id) => poolRow(db.prepare('SELECT * FROM resource_pools WHERE id = ?').get(id));

/** Pool of a customer, or null. */
export function poolOfUser(userId) {
  const r = db.prepare('SELECT resource_pool_id AS id FROM users WHERE id = ?').get(userId);
  return r?.id ? poolById(r.id) : null;
}

function cleanPool(input, current = {}) {
  const next = { ...current, ...input };
  if (!next.name?.trim()) throw new PoolError(400, 'Give the pool a name');
  const dcs = [...new Set(next.datacenters ?? [])];
  const missing = dcs.find((id) => !datacenterById(id));
  if (missing) throw new PoolError(400, `Datacenter ${missing} doesn't exist`);
  const gpus = [...new Set(next.gpuProfiles ?? [])];
  const noProfile = gpus.find((id) => !db.prepare('SELECT 1 FROM gpu_profiles WHERE id = ?').get(id));
  if (noProfile) throw new PoolError(400, `GPU profile ${noProfile} doesn't exist`);
  for (const k of Object.keys(LIMIT_FIELDS)) {
    if (next[k] !== null && next[k] !== undefined && (!Number.isInteger(next[k]) || next[k] < 0)) {
      throw new PoolError(400, `${k} must be a whole number of 0 or more, or empty for no cap`);
    }
  }
  return { ...next, name: next.name.trim(), description: (next.description ?? '').trim(), datacenters: dcs, gpuProfiles: gpus };
}

const poolValues = (p) => [
  p.name, p.description, ...Object.keys(LIMIT_FIELDS).map((k) => p[k] ?? null),
  JSON.stringify(p.datacenters), JSON.stringify(p.gpuProfiles),
];

export function createPool(input) {
  const p = cleanPool(input);
  if (db.prepare('SELECT 1 FROM resource_pools WHERE name = ?').get(p.name)) throw new PoolError(409, 'A pool with this name exists');
  const cols = Object.values(LIMIT_FIELDS);
  const { lastInsertRowid } = db.prepare(`INSERT INTO resource_pools (name, description, ${cols.join(', ')}, datacenters, gpu_profiles)
    VALUES (${['?', '?', ...cols.map(() => '?'), '?', '?'].join(', ')})`).run(...poolValues(p));
  return poolById(Number(lastInsertRowid));
}

export function updatePool(id, input) {
  const current = poolById(id);
  if (!current) throw new PoolError(404, 'Pool not found');
  const p = cleanPool(input, current);
  const sets = ['name = ?', 'description = ?', ...Object.values(LIMIT_FIELDS).map((c) => `${c} = ?`), 'datacenters = ?', 'gpu_profiles = ?'];
  db.prepare(`UPDATE resource_pools SET ${sets.join(', ')} WHERE id = ?`).run(...poolValues(p), id);
  return poolById(id);
}

export function deletePool(id) {
  if (!poolById(id)) throw new PoolError(404, 'Pool not found');
  const members = db.prepare('SELECT COUNT(*) AS n FROM users WHERE resource_pool_id = ?').get(id).n;
  if (members) throw new PoolError(409, `${members} customer(s) are in this pool. Move them out first.`);
  db.prepare('DELETE FROM resource_pools WHERE id = ?').run(id);
}

export function setPoolMember(poolId, userId, member = true) {
  if (member && !poolById(poolId)) throw new PoolError(404, 'Pool not found');
  const user = db.prepare('SELECT id, email, is_admin, resource_pool_id FROM users WHERE id = ?').get(userId);
  if (!user) throw new PoolError(404, 'Customer not found');
  if (member) {
    db.prepare('UPDATE users SET resource_pool_id = ? WHERE id = ?').run(poolId, userId);
  } else if (user.resource_pool_id === poolId) {
    db.prepare('UPDATE users SET resource_pool_id = NULL WHERE id = ?').run(userId);
  }
  return user;
}

export const poolMembers = (poolId) =>
  db.prepare('SELECT id, email FROM users WHERE resource_pool_id = ? AND deleting = 0 ORDER BY email').all(poolId);

/** What the members of a pool use together. */
export async function poolUsage(poolId) {
  const members = poolMembers(poolId);
  const total = { members: members.length, servers: 0, cores: 0, memoryMb: 0, diskGb: 0, gpus: 0, publicIps: 0, s3Buckets: 0, s3Gb: 0 };
  const per = await Promise.all(members.map((m) => usageOf(m.id).catch(() => null)));
  for (const u of per.filter(Boolean)) {
    total.servers += u.servers;
    total.cores += u.cores;
    total.memoryMb += u.memoryMb;
    total.diskGb += u.diskGb;
  }
  if (members.length) {
    const ids = members.map((m) => m.id);
    const marks = ids.map(() => '?').join(',');
    total.gpus = db.prepare(`SELECT COUNT(*) AS n FROM gpu_assignments WHERE user_id IN (${marks})`).get(...ids).n;
    const b = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(quota_gb), 0) AS gb FROM s3_buckets WHERE user_id IN (${marks})`).get(...ids);
    total.s3Buckets = b.n;
    total.s3Gb = b.gb;
    total.publicIps = db.prepare(`SELECT COUNT(*) AS n FROM ip_addresses WHERE state = 'assigned' AND user_id IN (${marks})`).get(...ids).n;
  }
  return total;
}

const FRIENDLY = {
  maxCores: ['cores', (v) => `${v} vCPU`], maxMemoryMb: ['memoryMb', (v) => `${+(v / 1024).toFixed(1)} GB memory`],
  maxDiskGb: ['diskGb', (v) => `${v} GB disk`], maxGpus: ['gpus', (v) => `${v} GPU(s)`],
  maxS3Buckets: ['s3Buckets', (v) => `${v} bucket(s)`], maxS3Gb: ['s3Gb', (v) => `${v} GB object storage`],
  maxPublicIps: ['publicIps', (v) => `${v} public IPv4 address(es)`],
};

/**
 * Throws 409 if adding `delta` (cores, memoryMb, diskGb, gpus, s3Buckets, s3Gb)
 * would take the customer's pool over one of its caps. No pool: nothing to check.
 */
export async function checkPoolCapacity(userId, delta) {
  const pool = poolOfUser(userId);
  if (!pool) return null;
  const used = await poolUsage(pool.id);
  const over = [];
  for (const [limitKey, [usageKey, show]] of Object.entries(FRIENDLY)) {
    const cap = pool[limitKey];
    const add = delta[usageKey] ?? 0;
    if (cap === null || cap === undefined || add <= 0) continue;
    if (used[usageKey] + add > cap) over.push(`${show(Math.max(0, cap - used[usageKey]))} left`);
  }
  if (over.length) throw new PoolError(409, `This exceeds the resource pool "${pool.name}": ${over.join(', ')}`);
  return pool;
}

/** Datacenters a customer may create servers in ([] when none are defined). */
export function datacentersFor(userId) {
  const all = listDatacenters();
  const pool = poolOfUser(userId);
  if (!pool || !pool.datacenters.length) return all;
  return all.filter((d) => pool.datacenters.includes(d.id));
}

/**
 * Where a new server goes: { datacenter, node, storage } or null (no
 * datacenters defined: the template's node, as before).
 */
export function placement(userId, datacenterId, templateNode, { cluster = null, image = 'This image' } = {}) {
  const allowed = datacentersFor(userId);
  if (!listDatacenters().length) return null;
  let dc;
  if (datacenterId) {
    dc = allowed.find((d) => d.id === datacenterId);
    if (!dc) throw new PoolError(403, 'That datacenter is not available for your account');
  } else if (allowed.length === 1) {
    dc = allowed[0];
  } else if (!allowed.length) {
    throw new PoolError(403, 'No datacenter is available for your account');
  } else {
    // Several to choose from and none chosen: the template's own datacenter if allowed
    dc = allowed.find((d) => d.nodes.includes(templateNode)) ?? allowed[0];
  }
  // nodes in maintenance (Hosts tab) get no new servers
  const off = new Set(db.prepare('SELECT node FROM node_settings WHERE maintenance = 1').all().map((r) => r.node));
  // several Proxmox clusters: only nodes of the image's cluster (a clone can't cross clusters)
  const inCluster = cluster === null ? dc.nodes : dc.nodes.filter((n) => clusterOfNode(n) === cluster);
  if (!inCluster.length) throw new PoolError(400, `${image} is not available in ${dc.name}. Choose an image offered there.`);
  const nodes = inCluster.filter((n) => !off.has(n));
  if (!nodes.length) throw new PoolError(409, `No host in ${dc.name} takes new servers right now (maintenance). Please try again later or choose another datacenter.`);
  const node = nodes.includes(templateNode) ? templateNode : nodes[0];
  return { datacenter: dc, node, storage: dc.storage || null };
}
