// Proxmox hosts: the nodes of the cluster the panel manages, their load, version
// and maintenance mode, and the administrator's overview dashboard.
//
// Live data comes from /cluster/resources (nodes, storages), /cluster/status
// (quorum) and /nodes/<node>/status (version, kernel). Each answer is kept as the
// node's last snapshot, so an unreachable node still shows what it last reported.
// Maintenance mode is the panel's own flag: new servers are not placed on such a
// node (pools.js placement); running servers are not touched.

import { db, audit } from './db.js';
import { pve, clusterGuests, allClusters, clusterById } from './pve.js';
import { datacenterOfNode } from './pools.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const NODE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;

export const maintenanceNodes = () => new Set(db.prepare('SELECT node FROM node_settings WHERE maintenance = 1').all().map((r) => r.node));

function snapshot(node, data) {
  db.prepare(`INSERT INTO node_snapshots (node, data, seen_at) VALUES (?, ?, ?)
    ON CONFLICT(node) DO UPDATE SET data = excluded.data, seen_at = excluded.seen_at`).run(node, JSON.stringify(data), new Date().toISOString());
}
const lastSnapshot = (node) => {
  const r = db.prepare('SELECT data, seen_at FROM node_snapshots WHERE node = ?').get(node);
  return r ? { ...JSON.parse(r.data), seenAt: r.seen_at } : null;
};

/** Nodes with live load (or their last snapshot), datacenter, version and maintenance flag. */
export async function hostsOverview() {
  let nodes;
  let storages = [];
  let status = [];
  try {
    [nodes, storages, status] = await Promise.all([
      pve.get('/cluster/resources', { type: 'node' }),
      pve.get('/cluster/resources', { type: 'storage' }).catch(() => []),
      pve.get('/cluster/status').catch(() => []),
    ]);
  } catch (err) {
    throw fail(502, `Proxmox can't be reached: ${err.message}`);
  }
  // further clusters: their status, and the last known nodes of one that can't be reached
  const extra = allClusters().filter((c) => !c.main);
  const extraStatus = await Promise.all(extra.map((c) => pve.on(c.id).get('/cluster/status').catch(() => null)));
  extra.forEach((c, i) => {
    if (extraStatus[i]) return;
    for (const r of db.prepare('SELECT node, data FROM node_snapshots').all()) {
      if (JSON.parse(r.data).cluster === c.id && !nodes.some((n) => n.node === r.node)) nodes.push({ node: r.node, status: 'unknown', cluster: c.id });
    }
  });
  let guests = new Map();
  try { guests = await clusterGuests(); } catch { /* counts stay 0 */ }
  const settings = new Map(db.prepare('SELECT * FROM node_settings').all().map((r) => [r.node, r]));
  const versions = await Promise.all(nodes.map((n) => (n.status === 'online'
    ? pve.get(`/nodes/${encodeURIComponent(n.node)}/status`).catch(() => null) : Promise.resolve(null))));

  const out = nodes.map((n, i) => {
    const v = versions[i];
    const online = n.status === 'online';
    const own = storages.filter((s) => s.node === n.node && s.status === 'available' && Number(s.maxdisk) > 0);
    const live = online ? {
      cpu: Number(n.cpu ?? 0), cores: Number(n.maxcpu ?? 0), memUsed: Number(n.mem ?? 0), memTotal: Number(n.maxmem ?? 0),
      uptime: Number(n.uptime ?? 0),
      pveVersion: v?.pveversion ? String(v.pveversion).split('/')[1] ?? null : null,
      kernel: v?.kversion ? (/Linux (\S+)/.exec(v.kversion)?.[1] ?? null) : null,
      cpuModel: v?.cpuinfo?.model ?? null,
      storage: own.map((s) => ({ storage: s.storage, used: Number(s.disk ?? 0), total: Number(s.maxdisk ?? 0), shared: !!Number(s.shared ?? 0) })),
      cluster: n.cluster ?? 0,
    } : null;
    if (live) snapshot(n.node, live);
    const last = live ?? lastSnapshot(n.node);
    const vms = [...guests.values()].filter((g) => g.node === n.node && !g.template);
    const set = settings.get(n.node);
    return {
      node: n.node, online, stale: !online, lastSeen: online ? new Date().toISOString() : last?.seenAt ?? null,
      clusterId: n.cluster ?? 0, clusterName: clusterById(n.cluster ?? 0)?.name ?? null,
      datacenter: datacenterOfNode(n.node)?.name ?? null,
      maintenance: !!set?.maintenance, note: set?.note ?? null,
      guests: vms.length, running: vms.filter((g) => g.status === 'running').length,
      ...(last ?? {}),
    };
  });
  const cluster = status.find((s) => s.type === 'cluster');
  const clusters = [
    { id: 0, name: clusterById(0).name, reachable: true, quorate: cluster ? !!cluster.quorate : true },
    ...extra.map((c, i) => {
      const q = extraStatus[i]?.find((x) => x.type === 'cluster');
      return { id: c.id, name: c.name, reachable: !!extraStatus[i], quorate: extraStatus[i] ? (q ? !!q.quorate : true) : null };
    }),
  ];
  return {
    cluster: cluster ? { name: cluster.name, quorate: !!cluster.quorate, nodes: cluster.nodes } : null,
    clusters,
    nodes: out.sort((a, b) => a.node.localeCompare(b.node)),
  };
}

export function setMaintenance(req, node, { maintenance, note = null }) {
  if (!NODE.test(String(node))) throw fail(400, 'Not a node name');
  const n = note == null ? null : String(note).trim().slice(0, 200) || null;
  db.prepare(`INSERT INTO node_settings (node, maintenance, note, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(node) DO UPDATE SET maintenance = excluded.maintenance, note = excluded.note, updated_at = excluded.updated_at`)
    .run(node, maintenance ? 1 : 0, n);
  audit(req, null, maintenance ? 'admin_node_maintenance_on' : 'admin_node_maintenance_off', { node, note: n });
  return { node, maintenance: !!maintenance, note: n };
}

// ---- Dashboard ---------------------------------------------------------------------------------

const pct = (a, b) => (b > 0 ? a / b : 0);

/**
 * The administrator's overview, limited to what the viewer may see:
 * servers.read → guests, nodes, alerts; billing.read → money; support.read → tickets;
 * network.read → public IPv4; audit.read → latest activity.
 */
export async function dashboard(perms) {
  const can = (p) => perms.has(p);
  const out = { kpis: {}, alerts: [], generatedAt: new Date().toISOString() };

  if (can('servers.read')) {
    try {
      const h = await hostsOverview();
      out.nodes = h.nodes;
      out.clusters = h.clusters;
      out.cluster = h.cluster;
      const guests = [...(await clusterGuests()).values()].filter((g) => !g.template);
      out.kpis.guests = { total: guests.length, running: guests.filter((g) => g.status === 'running').length };
      out.kpis.nodes = { total: h.nodes.length, online: h.nodes.filter((n) => n.online).length, maintenance: h.nodes.filter((n) => n.maintenance).length };
      for (const c of h.clusters.filter((x) => !x.reachable)) out.alerts.push({ level: 'bad', title: `Cluster ${c.name} unreachable`, sub: 'Its servers show their last known state; actions on them fail until it is back', tab: 'hosts' });
      if (h.cluster && !h.cluster.quorate) out.alerts.push({ level: 'bad', title: 'The cluster has no quorum', sub: 'Proxmox blocks most changes until enough nodes are back' });
      for (const n of h.nodes) {
        if (!n.online) out.alerts.push({ level: 'bad', title: `${n.node} unreachable`, sub: n.lastSeen ? `Last seen ${n.lastSeen}; ${n.guests} guest(s) on it` : `${n.guests} guest(s) on it` });
        else if (pct(n.memUsed, n.memTotal) >= 0.85) out.alerts.push({ level: 'warn', title: `${n.node} memory at ${Math.round(pct(n.memUsed, n.memTotal) * 100)}%`, sub: n.maintenance ? 'In maintenance' : 'Consider maintenance mode so new servers go elsewhere' });
        for (const s of n.storage ?? []) {
          if (pct(s.used, s.total) >= 0.85) out.alerts.push({ level: 'warn', title: `Storage ${s.storage} on ${n.node} at ${Math.round(pct(s.used, s.total) * 100)}%`, sub: 'Volumes and new servers need room' });
        }
      }
    } catch (err) {
      out.alerts.push({ level: 'bad', title: 'Proxmox can\'t be reached', sub: err.message });
    }
    const failed = db.prepare("SELECT COUNT(*) AS n FROM vms WHERE state = 'failed'").get().n;
    if (failed) out.alerts.push({ level: 'warn', title: `${failed} server${failed === 1 ? '' : 's'} failed to set up`, sub: 'See Servers', tab: 'servers' });
  }

  if (can('network.read')) {
    const ip = db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN state = 'assigned' THEN 1 END) AS assigned,
      COUNT(CASE WHEN state = 'held' THEN 1 END) AS held, COUNT(CASE WHEN state = 'free' THEN 1 END) AS free FROM ip_addresses`).get();
    if (ip.total) {
      out.kpis.publicIps = ip;
      if (ip.held) out.alerts.push({ level: 'warn', title: `${ip.held} public address${ip.held === 1 ? '' : 'es'} held`, sub: 'Their server left the panel: check and free them', tab: 'ipam' });
      for (const p of db.prepare(`SELECT p.name, COUNT(*) AS total, COUNT(CASE WHEN a.state = 'free' THEN 1 END) AS free
        FROM ip_pools p JOIN ip_addresses a ON a.pool_id = p.id GROUP BY p.id`).all()) {
        if (p.total && p.free / p.total < 0.1) out.alerts.push({ level: 'warn', title: `Pool ${p.name}: ${p.free} of ${p.total} addresses free`, sub: 'Add a pool before it runs out', tab: 'ipam' });
      }
    }
  }

  if (can('billing.read')) {
    const now = new Date().toISOString();
    const month = now.slice(0, 7);
    const b = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN status = 'paid' AND purpose <> 'topup' AND substr(paid_at, 1, 7) = ? THEN total END), 0) AS revenueMonth,
        COALESCE(SUM(CASE WHEN status = 'unpaid' THEN total END), 0) AS unpaid,
        COUNT(CASE WHEN status = 'unpaid' AND due_at < ? THEN 1 END) AS overdue,
        COALESCE(SUM(CASE WHEN status = 'unpaid' AND due_at < ? THEN total END), 0) AS overdueAmount,
        COUNT(CASE WHEN status = 'unpaid' AND customer_ref IS NOT NULL THEN 1 END) AS reported
      FROM invoices`).get(month, now, now);
    out.kpis.billing = b;
    if (b.reported) out.alerts.push({ level: 'warn', title: `${b.reported} bank transfer${b.reported === 1 ? '' : 's'} to confirm`, sub: 'Customers reported a payment', tab: 'billing' });
    if (b.overdue) out.alerts.push({ level: 'warn', title: `${b.overdue} overdue invoice${b.overdue === 1 ? '' : 's'}`, sub: `Rp ${b.overdueAmount.toLocaleString('id-ID')} outstanding`, tab: 'billing' });
  }

  if (can('support.read')) {
    const t = db.prepare(`SELECT COUNT(CASE WHEN status = 'open' THEN 1 END) AS open, COUNT(CASE WHEN status = 'open' AND assignee_id IS NULL THEN 1 END) AS unassigned,
      COUNT(CASE WHEN status = 'open' AND priority = 'urgent' THEN 1 END) AS urgent FROM tickets`).get();
    out.kpis.tickets = t;
    if (t.urgent) out.alerts.push({ level: 'bad', title: `${t.urgent} urgent ticket${t.urgent === 1 ? '' : 's'} open`, sub: 'Waiting for the support team', tab: 'tickets' });
  }

  if (can('audit.read')) {
    out.activity = db.prepare(`SELECT a.id, a.vmid, a.action, a.detail, a.created_at AS createdAt, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 8`).all();
  }
  return out;
}
