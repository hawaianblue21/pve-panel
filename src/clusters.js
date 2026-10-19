// Further Proxmox clusters (owner, Hosts tab). The main cluster stays in the
// environment (PVE_URL); added clusters are kept here with the API token secret
// sealed. Before a cluster is added it is tested: the API answers with the token,
// its node names are new, and VMIDs that also exist elsewhere are reported (those
// guests stay out of the panel until renumbered, because servers are keyed by VMID).
//
// TLS: verify against the system CAs, or pin the SHA-256 fingerprint of a
// self-signed Proxmox certificate (shown by the test, confirmed by the owner).

import tls from 'node:tls';
import { db, audit } from './db.js';
import { seal, open } from './secrets.js';
import { config } from './config.js';
import {
  CLUSTER_PURPOSE, allClusters, clusterById, invalidateClusters, rawRequest, dispatcherFor, clusterGuests, refreshNodeMap, vmidCollisions, pve,
} from './pve.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });

/** SHA-256 fingerprint of the certificate a https URL presents (not verified). */
function fingerprintOf(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return Promise.resolve(null);
  return new Promise((resolve) => {
    const sock = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, rejectUnauthorized: false, timeout: 8000 }, () => {
      const fp = sock.getPeerCertificate()?.fingerprint256 ?? null;
      sock.end();
      resolve(fp);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

function check(input) {
  const url = String(input.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(url)) throw fail(400, 'Address: https://host:8006 (no path)');
  const tokenId = String(input.tokenId ?? '').trim();
  if (!/^[\w.-]+@[\w.-]+![\w.-]+$/.test(tokenId)) throw fail(400, 'API token ID: user@realm!tokenname');
  return { url, tokenId };
}

/** Connects with the given settings; returns what the panel would see. */
export async function testCluster(input, { existingId = null } = {}) {
  const { url, tokenId } = check(input);
  const old = existingId ? db.prepare('SELECT * FROM clusters WHERE id = ?').get(existingId) : null;
  let secret = String(input.tokenSecret ?? '').trim();
  if (!secret && old) { try { secret = open(CLUSTER_PURPOSE, old.token_secret); } catch { secret = ''; } }
  if (!secret) throw fail(400, 'Enter the API token secret');
  const verifyTls = input.verifyTls !== false;
  const fingerprint = input.fingerprint ? String(input.fingerprint).trim() : null;
  const seen = await fingerprintOf(url);
  if (url.startsWith('https:') && !verifyTls && !fingerprint) {
    return { ok: false, fingerprint: seen, error: 'Self-signed certificate: confirm the fingerprint below (compare it with the one shown on the Proxmox host: pvenode cert info).' };
  }
  const c = { id: -1, name: 'test', url, auth: `PVEAPIToken=${tokenId}=${secret}`, dispatcher: dispatcherFor({ url, verifyTls, fingerprint }) };
  let version;
  let nodes;
  let guests;
  try {
    [version, nodes, guests] = await Promise.all([
      rawRequest(c, 'GET', '/version'), rawRequest(c, 'GET', '/nodes'), rawRequest(c, 'GET', '/cluster/resources', { type: 'vm' }),
    ]);
  } catch (err) {
    return { ok: false, fingerprint: seen, error: err.statusCode === 401 ? 'The API token was refused (ID or secret wrong, or no rights)' : err.message };
  }
  // conflicts with the other clusters
  const otherNodes = new Map();
  const otherIds = new Set();
  for (const k of allClusters().filter((x) => x.id !== existingId)) {
    try {
      for (const n of await rawRequest(k, 'GET', '/nodes')) otherNodes.set(n.node, k.name);
      for (const g of await rawRequest(k, 'GET', '/cluster/resources', { type: 'vm' })) otherIds.add(Number(g.vmid));
    } catch { /* unreachable: can't compare */ }
  }
  const nodeConflicts = nodes.filter((n) => otherNodes.has(n.node)).map((n) => `${n.node} (also in ${otherNodes.get(n.node)})`);
  const vmidConflicts = guests.filter((g) => otherIds.has(Number(g.vmid))).map((g) => ({ vmid: Number(g.vmid), name: g.name ?? '' }));
  return {
    ok: !nodeConflicts.length, version: version?.version ?? null, fingerprint: seen,
    nodes: nodes.map((n) => ({ node: n.node, status: n.status })), guests: guests.filter((g) => !g.template).length,
    templates: guests.filter((g) => g.template).length, nodeConflicts, vmidConflicts,
    ...(nodeConflicts.length ? { error: `Node names must be unique across clusters: ${nodeConflicts.join(', ')}` } : {}),
  };
}

export async function listClusters() {
  let guests = new Map();
  try { guests = await clusterGuests(true); } catch { /* unreachable */ }
  const servers = db.prepare('SELECT vmid FROM vms').all().map((r) => r.vmid);
  const status = await Promise.all(allClusters().map((c) => pve.on(c.id).get('/cluster/status').catch(() => null)));
  return {
    clusters: [
      { id: 0, key: 'main', name: allClusters()[0].name, url: config.pve.url, main: true, enabled: true },
      ...db.prepare('SELECT * FROM clusters ORDER BY id').all().map((r) => ({
        id: r.id, key: r.key, name: r.name, url: r.url, tokenId: r.token_id, verifyTls: !!r.verify_tls, fingerprint: r.fingerprint, enabled: !!r.enabled, main: false, createdAt: r.created_at,
      })),
    ].map((c) => {
      const i = allClusters().findIndex((x) => x.id === c.id);
      const st = i >= 0 ? status[i] : null;
      const q = st?.find?.((x) => x.type === 'cluster');
      return {
        ...c, reachable: c.enabled ? !!st : null, quorate: q ? !!q.quorate : (st ? true : null),
        nodes: st ? st.filter((x) => x.type === 'node').map((x) => x.name) : [],
        servers: servers.filter((v) => (guests.get(v)?.cluster ?? -1) === c.id).length,
        guests: [...guests.values()].filter((g) => g.cluster === c.id && !g.template).length,
      };
    }),
    collisions: vmidCollisions().map((x) => ({ ...x, clusterName: clusterById(x.cluster)?.name ?? `#${x.cluster}` })),
  };
}

export async function addCluster(req, input) {
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(key) || key === 'main') throw fail(400, 'Key: lowercase letters, digits and hyphens (not "main")');
  if (db.prepare('SELECT 1 FROM clusters WHERE key = ?').get(key)) throw fail(409, `A cluster ${key} exists already`);
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) throw fail(400, 'Name: up to 60 characters');
  const { url, tokenId } = check(input);
  const t = await testCluster(input);
  if (!t.ok) throw fail(409, t.error ?? 'The connection test failed');
  const id = Number(db.prepare('INSERT INTO clusters (key, name, url, token_id, token_secret, verify_tls, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(key, name, url, tokenId, seal(CLUSTER_PURPOSE, String(input.tokenSecret).trim()), input.verifyTls !== false ? 1 : 0, input.fingerprint || null).lastInsertRowid);
  invalidateClusters();
  await refreshNodeMap(true);
  audit(req, null, 'admin_cluster_added', { id, key, name, url, tokenId, nodes: t.nodes.map((n) => n.node), vmidConflicts: t.vmidConflicts.length });
  return { id, test: t };
}

export async function updateCluster(req, id, input) {
  const row = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!row) throw fail(404, 'Cluster not found');
  const name = input.name !== undefined ? String(input.name).trim() : row.name;
  if (!name || name.length > 60) throw fail(400, 'Name: up to 60 characters');
  const connectionChanged = ['url', 'tokenId', 'tokenSecret', 'verifyTls', 'fingerprint'].some((k) => input[k] !== undefined);
  let url = row.url;
  let tokenId = row.token_id;
  if (connectionChanged) {
    const merged = {
      url: input.url ?? row.url, tokenId: input.tokenId ?? row.token_id, tokenSecret: input.tokenSecret,
      verifyTls: input.verifyTls ?? !!row.verify_tls, fingerprint: input.fingerprint === undefined ? row.fingerprint : input.fingerprint,
    };
    ({ url, tokenId } = check(merged));
    const t = await testCluster(merged, { existingId: id });
    if (!t.ok) throw fail(409, t.error ?? 'The connection test failed');
    db.prepare('UPDATE clusters SET url = ?, token_id = ?, verify_tls = ?, fingerprint = ? WHERE id = ?')
      .run(url, tokenId, merged.verifyTls ? 1 : 0, merged.fingerprint || null, id);
    if (input.tokenSecret) db.prepare('UPDATE clusters SET token_secret = ? WHERE id = ?').run(seal(CLUSTER_PURPOSE, String(input.tokenSecret).trim()), id);
  }
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : !!row.enabled;
  db.prepare('UPDATE clusters SET name = ?, enabled = ? WHERE id = ?').run(name, enabled ? 1 : 0, id);
  invalidateClusters();
  audit(req, null, 'admin_cluster_updated', { id, name, enabled, connectionChanged });
  return { id, name, enabled };
}

export async function removeCluster(req, id) {
  const row = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!row) throw fail(404, 'Cluster not found');
  const guests = await clusterGuests(true).catch(() => new Map());
  const used = db.prepare('SELECT vmid FROM vms').all().filter((r) => guests.get(r.vmid)?.cluster === id).map((r) => r.vmid);
  if (used.length) throw fail(409, `${used.length} panel server${used.length === 1 ? ' runs' : 's run'} on this cluster (${used.slice(0, 8).join(', ')}). Unassign or delete them first, or disable the cluster.`);
  const tpl = db.prepare('SELECT vmid FROM templates').all().filter((r) => guests.get(r.vmid)?.cluster === id).map((r) => r.vmid);
  if (tpl.length) throw fail(409, `Templates ${tpl.join(', ')} of this cluster are offered. Withdraw them first.`);
  db.prepare('DELETE FROM network_clusters WHERE cluster_id = ?').run(id);
  db.prepare('DELETE FROM clusters WHERE id = ?').run(id);
  invalidateClusters();
  audit(req, null, 'admin_cluster_removed', { id, key: row.key, name: row.name });
  return { removed: true };
}
