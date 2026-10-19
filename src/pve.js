import fs from 'node:fs';
import { Agent, buildConnector, fetch } from 'undici';
import { config } from './config.js';
import { db } from './db.js';
import { open } from './secrets.js';

// ---- Clusters ---------------------------------------------------------------------------------
// The main cluster comes from PVE_URL / PVE_TOKEN_*; further clusters are added
// by an owner in the Hosts tab (table `clusters`). Requests are routed:
//   /nodes/<node>/…        to the cluster that has that node
//   GET /cluster/resources merged from all clusters (each item gets `cluster`)
//   /cluster/nextid        an ID free in every cluster (VMIDs stay unique)
//   other /cluster/…       the main cluster, or the one chosen with pve.on(id)
// Node names and VMIDs must be unique across clusters: the panel keys servers by
// VMID. A guest whose VMID exists in an earlier cluster is left out (and listed
// in vmidCollisions()).

const ca = config.pve.caFile ? fs.readFileSync(config.pve.caFile) : undefined;

export const tlsOptions = { rejectUnauthorized: config.pve.verifyTls, ca };
export const authHeader = `PVEAPIToken=${config.pve.tokenId}=${config.pve.tokenSecret}`;
export const CLUSTER_PURPOSE = 'pve-cluster-token';

const MAIN = { id: 0, key: 'main', name: process.env.PVE_CLUSTER_NAME || 'Main', url: config.pve.url, auth: authHeader, dispatcher: new Agent({ connect: tlsOptions }), main: true };

/** TLS: system CA (verify), or a pinned SHA-256 certificate fingerprint (self-signed Proxmox). */
export function dispatcherFor({ url, verifyTls, fingerprint }) {
  if (!url.startsWith('https:') || verifyTls || !fingerprint) return new Agent({ connect: { rejectUnauthorized: verifyTls !== false } });
  const pin = fingerprint.replace(/:/g, '').toLowerCase();
  const base = buildConnector({ rejectUnauthorized: false });
  return new Agent({
    connect: (opts, cb) => base(opts, (err, socket) => {
      if (err) return cb(err);
      const got = socket.getPeerCertificate?.().fingerprint256?.replace(/:/g, '').toLowerCase();
      if (got !== pin) { socket.destroy(); return cb(new Error('TLS certificate fingerprint does not match the pinned one')); }
      return cb(null, socket);
    }),
  });
}

let extra = null;          // cached added clusters
export function invalidateClusters() { extra = null; nodeMap = { at: 0, map: new Map() }; cache.at = 0; }
function extraClusters() {
  if (extra) return extra;
  let rows = [];
  try { rows = db.prepare('SELECT * FROM clusters WHERE enabled = 1 ORDER BY id').all(); } catch { rows = []; }
  extra = rows.map((r) => {
    let secret = '';
    try { secret = open(CLUSTER_PURPOSE, r.token_secret); } catch { /* re-enter the secret */ }
    return {
      id: r.id, key: r.key, name: r.name, url: r.url.replace(/\/+$/, ''), auth: `PVEAPIToken=${r.token_id}=${secret}`,
      dispatcher: dispatcherFor({ url: r.url, verifyTls: !!r.verify_tls, fingerprint: r.fingerprint }), main: false,
      verifyTls: !!r.verify_tls, fingerprint: r.fingerprint ? r.fingerprint.replace(/:/g, '').toLowerCase() : null,
    };
  });
  return extra;
}
export const allClusters = () => [MAIN, ...extraClusters()];

/** For a direct WebSocket (console): address, auth header, TLS options and a fingerprint to check. */
export function connectionOf(clusterId) {
  const c = clusterById(clusterId ?? 0) ?? MAIN;
  if (c.main) return { url: c.url, auth: c.auth, tls: tlsOptions, pin: null };
  const pinned = c.url.startsWith('https:') && !c.verifyTls && c.fingerprint;
  return { url: c.url, auth: c.auth, tls: { rejectUnauthorized: !pinned && c.verifyTls !== false }, pin: pinned ? c.fingerprint : null };
}
export const clusterById = (id) => allClusters().find((c) => c.id === Number(id)) ?? null;

export class PveError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.name = 'PveError';
    this.statusCode = status;
    this.errors = errors;
  }
}

/** One request to one cluster. */
export async function rawRequest(cluster, method, path, params) {
  const url = new URL(`${cluster.url}/api2/json${path}`);
  const init = { method, headers: { Authorization: cluster.auth }, dispatcher: cluster.dispatcher };

  if (params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      // Array parameters (e.g. agent exec "command") are sent as repeated keys.
      if (Array.isArray(v)) v.forEach((item) => body.append(k, String(item)));
      else body.append(k, String(v));
    }
    if (method === 'GET' || method === 'DELETE') {
      url.search = body.toString();
    } else {
      init.body = body.toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Network/TLS failure: log the cause server-side, keep details out of the response.
    console.error(`Proxmox ${cluster.main ? '' : `(${cluster.name}) `}unreachable:`, err.cause?.code || err.cause?.message || err.message);
    throw new PveError(503, 'The server platform is unreachable right now. Try again in a minute.');
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    // Proxmox puts the human-readable reason in the status text,
    // e.g. "VM 101 not running".
    const message = json?.message || res.statusText || text || 'Proxmox request failed';
    throw new PveError(res.status, message.trim(), json?.errors);
  }
  return json?.data;
}

// ---- Node → cluster ------------------------------------------------------------------------------

let nodeMap = { at: 0, map: new Map() };
let clustersDown = new Set();

/**
 * A guest that isn't listed is really gone only if every cluster answered and
 * none is disabled; otherwise it may just be out of sight. Code that would drop
 * a server's record (and free its addresses) for a missing guest asks first.
 */
export function guestMayBeHidden() {
  if (clustersDown.size) return true;
  try { return !!db.prepare('SELECT 1 FROM clusters WHERE enabled = 0').get(); } catch { return false; }
}
export class HiddenGuestError extends Error {
  constructor() {
    super('This server can\'t be reached right now (one of the Proxmox clusters is unreachable or disabled). Try again later.');
    this.statusCode = 409; this.expose = true;
  }
}
export async function refreshNodeMap(force = false) {
  if (!extraClusters().length) return nodeMap.map;
  if (!force && Date.now() - nodeMap.at < 30_000) return nodeMap.map;
  const map = new Map();
  await Promise.all(allClusters().map(async (c) => {
    try {
      for (const n of await rawRequest(c, 'GET', '/nodes')) if (!map.has(n.node)) map.set(n.node, c.id);
    } catch { /* unreachable: keep what we knew */
      for (const [n, id] of nodeMap.map) if (id === c.id) map.set(n, id);
    }
  }));
  nodeMap = { at: Date.now(), map };
  return map;
}
/** The cluster id of a node as last seen (0 when unknown or only one cluster). */
export const clusterOfNode = (node) => nodeMap.map.get(node) ?? 0;

async function clusterFor(path) {
  if (!extraClusters().length) return MAIN;
  const m = /^\/nodes\/([^/]+)/.exec(path);
  if (!m) return MAIN;
  const node = decodeURIComponent(m[1]);
  if (!nodeMap.map.has(node)) await refreshNodeMap(true);
  return clusterById(nodeMap.map.get(node) ?? 0) ?? MAIN;
}

async function routed(method, path, params) {
  if (!extraClusters().length) {
    const data = await rawRequest(MAIN, method, path, params);
    return path === '/cluster/resources' && Array.isArray(data) ? data.map((r) => ({ ...r, cluster: 0 })) : data;
  }
  if (method === 'GET' && path === '/cluster/resources') {
    const results = await Promise.allSettled(allClusters().map((c) => rawRequest(c, 'GET', path, params).then((list) => list.map((r) => ({ ...r, cluster: c.id })))));
    clustersDown = new Set(allClusters().filter((c, i) => results[i].status === 'rejected').map((c) => c.id));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }
  if (method === 'GET' && path === '/cluster/nextid') {
    if (params?.vmid) {
      // free in every cluster, or the error of the first one where it is taken
      await Promise.all(allClusters().map((c) => rawRequest(c, 'GET', path, params)));
      return String(params.vmid);
    }
    const ids = await Promise.allSettled(allClusters().map((c) => rawRequest(c, 'GET', path)));
    const ok = ids.filter((r) => r.status === 'fulfilled').map((r) => Number(r.value));
    if (!ok.length) throw ids[0].reason;
    return String(Math.max(...ok));
  }
  return rawRequest(await clusterFor(path), method, path, params);
}

export const pve = {
  get: (path, params) => routed('GET', path, params),
  post: (path, params) => routed('POST', path, params),
  put: (path, params) => routed('PUT', path, params),
  del: (path, params) => routed('DELETE', path, params),
  /** Requests to one cluster (cluster-wide settings such as SDN, status). */
  on(clusterId) {
    const c = clusterById(clusterId) ?? MAIN;
    return {
      cluster: c,
      get: (path, params) => rawRequest(c, 'GET', path, params),
      post: (path, params) => rawRequest(c, 'POST', path, params),
      put: (path, params) => rawRequest(c, 'PUT', path, params),
      del: (path, params) => rawRequest(c, 'DELETE', path, params),
    };
  },
};

// ---- Guest lookup -------------------------------------------------------
// Guests can migrate between nodes, so the node is resolved on demand
// from /cluster/resources instead of being stored in our database.

let cache = { at: 0, byId: new Map(), collisions: [] };

export async function clusterGuests(force = false) {
  if (!force && Date.now() - cache.at < 5000) return cache.byId;
  const list = await pve.get('/cluster/resources', { type: 'vm' });
  const byId = new Map();
  const collisions = [];
  for (const r of list) {
    const id = Number(r.vmid);
    if (byId.has(id)) { collisions.push({ vmid: id, cluster: r.cluster, node: r.node, name: r.name ?? '', keptCluster: byId.get(id).cluster }); continue; }
    byId.set(id, r);
    if (r.node && r.cluster !== undefined && !nodeMap.map.has(r.node)) nodeMap.map.set(r.node, r.cluster);
  }
  cache = { at: Date.now(), byId, collisions };
  return byId;
}
/** Guests left out because their VMID is used in another cluster too. */
export const vmidCollisions = () => cache.collisions;

export async function locateGuest(vmid) {
  let guest = (await clusterGuests()).get(vmid);
  if (!guest) guest = (await clusterGuests(true)).get(vmid);
  if (!guest || guest.template) {
    const err = new Error('Server not found');
    err.statusCode = 404;
    throw err;
  }
  return guest; // { vmid, node, type: 'qemu' | 'lxc', name, status, cluster, ... }
}

export function guestPath(guest) {
  return `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}`;
}

export function invalidateGuestCache() {
  cache.at = 0;
}

export async function locateTemplate(vmid) {
  let guest = (await clusterGuests()).get(vmid);
  if (!guest) guest = (await clusterGuests(true)).get(vmid);
  if (!guest || !guest.template || guest.type !== 'qemu') {
    const err = new Error('Template not found');
    err.statusCode = 404;
    throw err;
  }
  return guest;
}

// ---- Tasks ----------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a Proxmox task (UPID) to finish; throws if it didn't end OK. */
export async function waitTask(node, upid, timeoutMs = 30 * 60_000) {
  if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return; // synchronous call
  node = node ?? upid.split(':')[1];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await pve.get(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`
    );
    if (s.status === 'stopped') {
      const exit = s.exitstatus ?? '';
      if (exit === 'OK' || exit.startsWith('WARNINGS')) return exit;
      throw new Error(`Proxmox task failed: ${exit || 'unknown error'}`);
    }
    await sleep(2000);
  }
  throw new Error('Proxmox task did not finish in time');
}

// ---- Disk helpers -----------------------------------------------------------

/** Finds the key of the boot disk in a VM config, e.g. "scsi0". */
export function bootDiskKey(cfg) {
  const order = /order=([^,\s]+)/.exec(cfg.boot ?? '')?.[1]?.split(';') ?? [];
  const candidates = [...order, cfg.bootdisk, 'scsi0', 'virtio0', 'sata0', 'ide0'].filter(Boolean);
  for (const key of candidates) {
    const value = cfg[key];
    if (typeof value === 'string' && !value.includes('media=cdrom') && !value.includes('cloudinit')) {
      return key;
    }
  }
  return null;
}

/** "local-lvm:vm-101-disk-0,size=32G" -> 32 */
export function diskSizeGb(value) {
  const m = /size=(\d+(?:\.\d+)?)([KMGT]?)/.exec(value ?? '');
  if (!m) return 0;
  const n = Number(m[1]);
  return { K: n / 1024 ** 2, M: n / 1024, G: n, T: n * 1024, '': n / 1024 ** 3 }[m[2]];
}

// ---- Serialisation ----------------------------------------------------------
// "Get next free VMID" and "start clone" must not interleave between two
// requests, or both would get the same ID.
let chain = Promise.resolve();
export function serial(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}
