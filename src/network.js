// Private network per customer (one VNet per customer, on every cluster where they have servers).
//
//   customer 1 ──▶ VNet cu0001  10.100.1.0/24  gw .1  DHCP .100-.250 ─┐
//   customer 2 ──▶ VNet cu0002  10.100.2.0/24  gw .1  DHCP .100-.250 ─┼─ SNAT ─▶ internet
//   ...                                                                ┘
//
// All VNets live in one SDN "simple" zone. The host routes between them, so
// isolation comes from the Proxmox VM firewall that the panel configures on
// every server it creates: traffic from other customer networks is dropped,
// and an IP filter pins each server to its own subnet (no spoofing).

import { db } from './db.js';
import { config } from './config.js';
import { pve, waitTask, serial, locateGuest, guestPath, clusterGuests } from './pve.js';

const { zone, prefix, dns } = config.network;
const ALL_CUSTOMERS = `${prefix}.0.0/16`;

const byUser = db.prepare('SELECT * FROM networks WHERE user_id = ?');

function describe(row) {
  const base = `${prefix}.${row.idx}`;
  return {
    idx: row.idx,
    vpnSubnet: `${config.vpn.prefix}.${row.idx}.0/24`,
    vnet: row.vnet,
    subnet: `${base}.0/24`,
    gateway: `${base}.1`,
    dhcpRange: [`${base}.100`, `${base}.250`],
  };
}

/** The customer's network, or null if they don't have one yet. */
export function networkOf(userId) {
  if (!config.network.enabled) return null;
  const row = byUser.get(userId);
  return row ? describe(row) : null;
}

export function allNetworks() {
  return db.prepare(`
    SELECT n.*, u.email FROM networks n LEFT JOIN users u ON u.id = n.user_id ORDER BY n.idx
  `).all().map((row) => ({ ...describe(row), email: row.email ?? null, userId: row.user_id }));
}

async function ensureZone(api) {
  const zones = await api.get('/cluster/sdn/zones');
  if (zones.some((z) => z.zone === zone)) return;
  await api.post('/cluster/sdn/zones', { zone, type: 'simple', ipam: 'pve', dhcp: 'dnsmasq' });
}

// Several Proxmox clusters: a customer's VNet is created on each cluster where
// they have servers (same name and subnet; each cluster is its own segment, and
// the VPN gateway reaches the main cluster's).
const onCluster = (vnet, clusterId) => !!db.prepare('SELECT 1 FROM network_clusters WHERE vnet = ? AND cluster_id = ?').get(vnet, clusterId);
const clustersOf = (vnet) => db.prepare('SELECT cluster_id AS id FROM network_clusters WHERE vnet = ? ORDER BY cluster_id').all(vnet).map((r) => r.id);

/**
 * Returns the customer's network, creating the VNet + subnet and applying the
 * SDN configuration the first time. Safe to retry after a partial failure.
 */
export async function ensureNetwork(userId, clusterId = 0) {
  const existing = byUser.get(userId);
  if (existing && onCluster(existing.vnet, clusterId)) return describe(existing);

  // SDN changes are applied cluster-wide in one go; never run two at once.
  return serial(async () => {
    const again = byUser.get(userId);
    if (again && onCluster(again.vnet, clusterId)) return describe(again);
    const api = pve.on(clusterId);

    await ensureZone(api);

    let net;
    if (again) {
      net = describe(again);
    } else {
      const used = new Set(db.prepare('SELECT idx FROM networks').all().map((r) => r.idx));
      let idx = 1;
      while (used.has(idx)) idx += 1;
      if (idx > 254) throw new Error('All customer networks are in use. Ask your provider to free one up.');
      net = describe({ vnet: `cu${String(idx).padStart(4, '0')}`, idx });
    }

    const vnets = await api.get('/cluster/sdn/vnets');
    if (!vnets.some((v) => v.vnet === net.vnet)) {
      await api.post('/cluster/sdn/vnets', { vnet: net.vnet, zone, alias: vnetAlias(userId) });
    }
    const subnets = await api.get(`/cluster/sdn/vnets/${net.vnet}/subnets`);
    if (!subnets.some((sn) => sn.cidr === net.subnet || String(sn.subnet ?? '').endsWith(net.subnet.replace('/', '-')))) {
      await api.post(`/cluster/sdn/vnets/${net.vnet}/subnets`, {
        subnet: net.subnet,
        type: 'subnet',
        gateway: net.gateway,
        snat: 1,
        'dhcp-range': `start-address=${net.dhcpRange[0]},end-address=${net.dhcpRange[1]}`,
        'dhcp-dns-server': dns,
      });
    }

    // Apply pending SDN changes (creates the bridge, gateway, NAT and DHCP).
    await waitTask(null, await api.put('/cluster/sdn'));

    if (!again) db.prepare('INSERT INTO networks (vnet, user_id, idx) VALUES (?, ?, ?)').run(net.vnet, userId, net.idx);
    db.prepare('INSERT OR IGNORE INTO network_clusters (vnet, cluster_id) VALUES (?, ?)').run(net.vnet, clusterId);
    return net;
  });
}

/**
 * VNet alias shown in Proxmox: the customer's user name, e.g. "lena (example.com)"
 * for lena@example.com. Only letters, digits, space and . _ - ( ) are used, which
 * Proxmox accepts in an alias.
 */
export function vnetAlias(userId) {
  const email = db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email ?? '';
  const [local, domain] = email.split('@');
  const clean = (t) => (t ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const alias = domain ? `${clean(local)} (${clean(domain)})` : clean(local);
  return (alias || `customer ${userId}`).slice(0, 200);
}

/** "virtio=BC:24:..,bridge=vmbr0,firewall=1" -> "virtio" (keeps e1000 etc. for Windows) */
export function nicModel(net0) {
  return /^([a-z0-9]+)(=|,|$)/i.exec(net0 ?? '')?.[1] ?? 'virtio';
}

/**
 * Locks a server into its customer's network with the Proxmox VM firewall.
 * Requires the datacenter firewall to be enabled (see the documentation: https://hawaianblue21.github.io/pve-panel).
 */
export async function isolateGuest(path, net) {
  await pve.put(`${path}/firewall/options`, {
    enable: 1,
    ipfilter: 1,     // only addresses from the ipfilter-net0 set may be used
    macfilter: 1,    // only the NIC's own MAC address
    policy_in: 'ACCEPT',
    policy_out: 'ACCEPT',
  });

  // A clone copies the template's firewall config; start from a clean set.
  await pve.del(`${path}/firewall/ipset/ipfilter-net0`, { force: 1 }).catch(() => {});
  await pve.post(`${path}/firewall/ipset`, { name: 'ipfilter-net0', comment: 'Managed by the panel' });
  await pve.post(`${path}/firewall/ipset/ipfilter-net0`, { cidr: net.subnet });

  await ensureVpnRules(path, net);
  await ensureEgressRules(path, net);

  // Both at position 0, so the ACCEPT for the own network ends up above the DROP.
  await pve.post(`${path}/firewall/rules`, {
    type: 'in', action: 'DROP', source: ALL_CUSTOMERS, enable: 1, pos: 0,
    comment: 'panel: block other customer networks',
  });
  await pve.post(`${path}/firewall/rules`, {
    type: 'in', action: 'ACCEPT', source: net.subnet, enable: 1, pos: 0,
    comment: 'panel: allow own network',
  });
}

/**
 * VPN devices come from <vpn prefix>.<n>.0/24 via the central gateway. The
 * gateway already restricts them, but each server also accepts only its own
 * customer's VPN range (defence in depth). Idempotent: used for new servers
 * and to add the rules to servers created before VPN was switched on.
 */
export async function ensureVpnRules(path, net) {
  const rules = await pve.get(`${path}/firewall/rules`);
  if (rules.some((r) => r.comment === 'panel: allow own VPN devices')) return;
  await pve.post(`${path}/firewall/rules`, {
    type: 'in', action: 'DROP', source: `${config.vpn.prefix}.0.0/16`, enable: 1, pos: 0,
    comment: 'panel: block other customers\' VPN devices',
  });
  await pve.post(`${path}/firewall/rules`, {
    type: 'in', action: 'ACCEPT', source: net.vpnSubnet, enable: 1, pos: 0,
    comment: 'panel: allow own VPN devices',
  });
}

// ---- Outgoing traffic ---------------------------------------------------------

/** Is this IPv4 address inside one of the CIDRs? */
function inAny(ip, cidrs) {
  const n = (a) => a.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
  return cidrs.some((c) => {
    const [base, bits] = c.split('/');
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return ((n(ip) & mask) >>> 0) === ((n(base) & mask) >>> 0);
  });
}

/**
 * Customer servers may reach the internet, their own network and their own VPN
 * devices, but nothing internal: the host NATs everything it can route, which
 * includes your LAN and any private network behind it. The IP filter (see
 * isolateGuest) pins the source address, so this can't be bypassed from inside.
 * Idempotent: used for new servers and re-applied to existing ones at startup.
 */
export async function ensureEgressRules(path, net) {
  const rules = await pve.get(`${path}/firewall/rules`);
  if (rules.some((r) => r.comment === 'panel: egress allow own network')) return;

  const post = (rule) => pve.post(`${path}/firewall/rules`, { type: 'out', enable: 1, pos: 0, ...rule });

  // Inserted bottom-up at position 0, so the ACCEPTs end up above the DROPs.
  for (const cidr of [...config.network.blockedNets].reverse()) {
    await post({ action: 'DROP', dest: cidr, comment: `panel: egress block ${cidr}` });
  }
  if (inAny(dns, config.network.blockedNets)) {
    // An internal DNS server configured for customers must stay reachable.
    await post({ action: 'ACCEPT', dest: `${dns}/32`, proto: 'udp', dport: '53', comment: 'panel: egress allow DNS (udp)' });
    await post({ action: 'ACCEPT', dest: `${dns}/32`, proto: 'tcp', dport: '53', comment: 'panel: egress allow DNS (tcp)' });
  }
  await post({ action: 'ACCEPT', dest: net.vpnSubnet, comment: 'panel: egress allow own VPN devices' });
  await post({ action: 'ACCEPT', dest: net.subnet, comment: 'panel: egress allow own network' });
}

/**
 * Brings every customer-created server up to the current isolation rules
 * (e.g. servers created before a rule existed). Runs once at startup.
 */
export async function reapplyIsolation(log) {
  if (!config.network.enabled) return;
  const rows = db.prepare(`
    SELECT v.vmid, v.user_id FROM vms v
    JOIN networks n ON n.user_id = v.user_id
    WHERE v.created_by_customer = 1 AND v.state = 'ready'
  `).all();
  let updated = 0;
  for (const row of rows) {
    const net = networkOf(row.user_id);
    const guest = await locateGuest(row.vmid).catch(() => null);
    if (!net || !guest) continue;
    try {
      const path = guestPath(guest);
      await ensureVpnRules(path, net);
      await ensureEgressRules(path, net);
      updated += 1;
    } catch (err) {
      log.warn(`Isolation rules for VM ${row.vmid} not updated: ${err.message}`);
    }
  }
  if (rows.length) log.info(`Isolation rules checked on ${updated} of ${rows.length} customer servers`);
}

// ---- Removing a network and keeping aliases current ---------------------------

/**
 * Deletes a customer's VNet (subnets first), applies SDN, and frees the /24.
 * Run after their servers are gone: Proxmox refuses to remove a VNet in use.
 */
/**
 * VMs whose network cards are connected to this VNet (any netN), e.g. a server
 * reassigned to someone else that still sits in the customer's network.
 */
export async function guestsUsingVnet(vnet) {
  const guests = [...(await clusterGuests(true)).values()].filter((g) => !g.template);
  const using = [];
  for (const g of guests) {
    try {
      const cfg = await pve.get(`${guestPath(g)}/config`);
      const hit = Object.entries(cfg).some(([k, v]) => /^net\d+$/.test(k)
        && new RegExp(`(^|,)bridge=${vnet}(,|$)`).test(String(v)));
      if (hit) using.push({ vmid: Number(g.vmid), name: g.name ?? '' });
    } catch {
      // not readable with the panel's rights: Proxmox's own check still applies
    }
  }
  return using;
}

export async function removeNetwork(userId) {
  const row = byUser.get(userId);
  if (!row) return false;
  return serial(async () => {
    // Check first, so nothing is half-removed when a VM still uses the network.
    const using = await guestsUsingVnet(row.vnet);
    if (using.length) {
      const list = using.map((g) => `${g.vmid}${g.name ? ` (${g.name})` : ''}`).join(', ');
      const e = new Error(`The private network ${row.vnet} is still used by ${list}. Move ${using.length > 1 ? 'these servers' : 'this server'} `
        + 'to another network or delete it, or delete the customer with "Keep the private network".');
      e.statusCode = 409;
      throw e;
    }
    const where = clustersOf(row.vnet);
    for (const clusterId of where.length ? where : [0]) {
      const api = pve.on(clusterId);
      const vnets = await api.get('/cluster/sdn/vnets');
      if (vnets.some((v) => v.vnet === row.vnet)) {
        const subnets = await api.get(`/cluster/sdn/vnets/${row.vnet}/subnets`);
        for (const sn of subnets) {
          // Subnet ids look like "<zone>-10.100.1.0-24"
          const id = sn.subnet ?? sn.id ?? `${sn.zone ?? zone}-${String(sn.cidr).replace('/', '-')}`;
          await api.del(`/cluster/sdn/vnets/${row.vnet}/subnets/${encodeURIComponent(id)}`);
        }
        try {
          await api.del(`/cluster/sdn/vnets/${row.vnet}`);
        } catch (err) {
          const e = new Error(`The private network ${row.vnet} could not be removed: ${err.message}. `
            + 'Its subnet is already removed (not yet applied). Fix the cause in Proxmox, then retry to finish.');
          e.statusCode = err.statusCode;
          throw e;
        }
        await waitTask(null, await api.put('/cluster/sdn'));
      }
      db.prepare('DELETE FROM network_clusters WHERE vnet = ? AND cluster_id = ?').run(row.vnet, clusterId);
    }
    db.prepare('DELETE FROM network_clusters WHERE vnet = ?').run(row.vnet);
    db.prepare('DELETE FROM networks WHERE vnet = ?').run(row.vnet);
    return true;
  });
}

/**
 * Gives every customer VNet the customer's name as alias (also VNets created
 * before aliases carried names). Applies SDN once if anything changed.
 */
export async function syncVnetAliases(log) {
  if (!config.network.enabled) return;
  const rows = db.prepare('SELECT * FROM networks WHERE user_id IS NOT NULL').all();
  if (!rows.length) return;
  let changed = 0;
  const clusterIds = [...new Set(db.prepare('SELECT DISTINCT cluster_id AS id FROM network_clusters').all().map((r) => r.id))];
  for (const clusterId of clusterIds.length ? clusterIds : [0]) {
    const api = pve.on(clusterId);
    const vnets = new Map((await api.get('/cluster/sdn/vnets')).map((v) => [v.vnet, v]));
    let here = 0;
    await serial(async () => {
      for (const row of rows) {
        const current = vnets.get(row.vnet);
        const alias = vnetAlias(row.user_id);
        if (!current || current.alias === alias) continue;
        await api.put(`/cluster/sdn/vnets/${row.vnet}`, { alias });
        here += 1;
      }
      if (here) await waitTask(null, await api.put('/cluster/sdn'));
    });
    changed += here;
  }
  if (changed) log.info(`VNet aliases updated for ${changed} customer network(s)`);
}
