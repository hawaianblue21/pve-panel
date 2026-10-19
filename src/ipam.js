// IP address management: public IPv4 pools per datacenter and their assignment to
// customer servers, with anti-spoofing, billing and optional reverse DNS.
//
// A pool is a subnet routed to a Proxmox bridge (optionally a VLAN), e.g.
// 203.0.113.0/26 on vmbr1 tag 40 with gateway 203.0.113.1. Assigning an address
// to a server adds a NIC on that bridge (netN, N ≥ 1) and:
//   VM with cloud-init  ipconfigN = ip=<addr>/<bits>,gw=<gateway>  → active after a restart
//                       (the public NIC then carries the default route)
//   container (LXC)     ip= and gw= on the NIC itself              → active at once
//   VM without it       the customer configures the address by hand (shown in the panel)
// and pins the address with the Proxmox firewall IP filter (ipset ipfilter-netN),
// so a server can't send from addresses it was not given.
//
// Released addresses cool down (default 24 h) before they are handed out again, so
// traffic and reputation meant for the previous holder don't reach the next one.
// Reverse DNS: a PTR per address, pushed to PowerDNS when it is set up.

import { db, audit } from './db.js';
import { pve, clusterGuests, guestPath, guestMayBeHidden, HiddenGuestError } from './pve.js';
import { seal, open } from './secrets.js';
import { datacenterOfNode, datacenterById, checkPoolCapacity } from './pools.js';

const KEY = 'ipam';
const PURPOSE = 'ipam-powerdns';
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const NICS = [1, 2, 3, 4, 5, 6, 7];

// ---- IPv4 ---------------------------------------------------------------------------------

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const toInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

export function parseCidr(cidr) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(cidr ?? '').trim());
  if (!m || !IPV4.test(m[1])) throw fail(400, 'Subnet: an IPv4 network like 203.0.113.0/26');
  const bits = Number(m[2]);
  if (bits < 22 || bits > 30) throw fail(400, 'Subnet size: from /22 (1022 addresses) to /30');
  const mask = (~0 << (32 - bits)) >>> 0;
  const base = (toInt(m[1]) & mask) >>> 0;
  if (base !== toInt(m[1])) throw fail(400, `Subnet: ${m[1]} is not the network address (that is ${toIp(base)})`);
  return { base, bits, first: base + 1, last: ((base | ~mask) >>> 0) - 1, cidr: `${toIp(base)}/${bits}` };   // >>> 0: unsigned
}
const inside = (ip, net) => { const n = toInt(ip); return n >= net.first && n <= net.last; };

// ---- Settings ------------------------------------------------------------------------------

const DEFAULTS = { enabled: false, maxPerServer: 2, cooldownHours: 24, powerdns: { url: '', apiKey: null, serverId: 'localhost' } };
function stored() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  const s = row ? JSON.parse(row.value) : {};
  return { ...DEFAULTS, ...s, powerdns: { ...DEFAULTS.powerdns, ...(s.powerdns ?? {}) } };
}
const reveal = (v) => { try { return v ? open(PURPOSE, v) : ''; } catch { return ''; } };

export function ipamSettings() {
  const s = stored();
  return { ...s, powerdns: { url: s.powerdns.url, serverId: s.powerdns.serverId, hasApiKey: !!reveal(s.powerdns.apiKey) } };
}

export function saveIpamSettings(input) {
  const s = stored();
  if (typeof input.enabled === 'boolean') s.enabled = input.enabled;
  if (input.maxPerServer !== undefined) {
    const n = Number(input.maxPerServer);
    if (!Number.isInteger(n) || n < 1 || n > NICS.length) throw fail(400, `Addresses per server: 1 to ${NICS.length}`);
    s.maxPerServer = n;
  }
  if (input.cooldownHours !== undefined) {
    const n = Number(input.cooldownHours);
    if (!Number.isInteger(n) || n < 0 || n > 24 * 90) throw fail(400, 'Cool-down: 0 to 2160 hours');
    s.cooldownHours = n;
  }
  if (input.powerdns) {
    const p = input.powerdns;
    if (typeof p.url === 'string') {
      const u = p.url.trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s/]+(\/.*)?$/.test(u)) throw fail(400, 'PowerDNS API address: http(s)://host:8081');
      s.powerdns.url = u;
    }
    if (typeof p.serverId === 'string' && p.serverId.trim()) {
      if (!/^[\w.-]{1,64}$/.test(p.serverId.trim())) throw fail(400, 'PowerDNS server ID: letters, digits, dots, dashes');
      s.powerdns.serverId = p.serverId.trim();
    }
    if (typeof p.apiKey === 'string' && p.apiKey) s.powerdns.apiKey = seal(PURPOSE, p.apiKey.trim());
  }
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(s));
  return ipamSettings();
}

// ---- Pools (admin) ---------------------------------------------------------------------------

function poolPub(p) {
  const counts = db.prepare(`SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN state = 'assigned' THEN 1 END) AS assigned,
      COUNT(CASE WHEN state = 'reserved' THEN 1 END) AS reserved,
      COUNT(CASE WHEN state = 'cooldown' THEN 1 END) AS cooldown,
      COUNT(CASE WHEN state = 'held' THEN 1 END) AS held
    FROM ip_addresses WHERE pool_id = ?`).get(p.id);
  return {
    id: p.id, name: p.name, cidr: p.cidr, gateway: p.gateway, bridge: p.bridge, vlan: p.vlan, dns: p.dns ? p.dns.split(',') : [],
    datacenterId: p.datacenter_id, datacenter: p.datacenter_id ? datacenterById(p.datacenter_id)?.name ?? null : null,
    priceMonthly: p.price_monthly, reverseZone: p.reverse_zone, createdAt: p.created_at,
    ...counts, free: counts.total - counts.assigned - counts.reserved - counts.cooldown - counts.held,
  };
}

export const listIpPools = () => db.prepare('SELECT * FROM ip_pools ORDER BY name').all().map(poolPub);

function poolInput(input, current = null) {
  const out = {};
  const name = String(input.name ?? current?.name ?? '').trim();
  if (!name || name.length > 60) throw fail(400, 'Name: up to 60 characters');
  out.name = name;
  const net = current ? parseCidr(current.cidr) : parseCidr(input.cidr);
  out.cidr = net.cidr;
  const gw = String(input.gateway ?? current?.gateway ?? '').trim();
  if (!IPV4.test(gw) || !inside(gw, net)) throw fail(400, `Gateway: an address inside ${net.cidr}`);
  out.gateway = gw;
  const bridge = String(input.bridge ?? current?.bridge ?? '').trim();
  if (!/^[A-Za-z][\w.-]{0,15}$/.test(bridge)) throw fail(400, 'Bridge: a Proxmox bridge or SDN VNet name like vmbr1');
  out.bridge = bridge;
  const vlan = input.vlan === undefined ? current?.vlan ?? null : input.vlan === null || input.vlan === '' ? null : Number(input.vlan);
  if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)) throw fail(400, 'VLAN tag: 1 to 4094, or empty');
  out.vlan = vlan;
  const dns = input.dns === undefined ? (current?.dns ?? '') : (Array.isArray(input.dns) ? input.dns : String(input.dns).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
  const dnsList = Array.isArray(dns) ? dns : dns.split(',').filter(Boolean);
  if (dnsList.length > 3 || dnsList.some((d) => !IPV4.test(d))) throw fail(400, 'DNS servers: up to 3 IPv4 addresses');
  out.dns = dnsList.join(',');
  const dc = input.datacenterId === undefined ? current?.datacenter_id ?? null : input.datacenterId || null;
  if (dc !== null && !datacenterById(Number(dc))) throw fail(400, 'Datacenter not found');
  out.datacenter_id = dc === null ? null : Number(dc);
  const price = input.priceMonthly === undefined ? current?.price_monthly ?? 0 : Number(input.priceMonthly);
  if (!Number.isInteger(price) || price < 0 || price > 100_000_000) throw fail(400, 'Price per address: whole rupiah');
  out.price_monthly = price;
  const zone = String(input.reverseZone ?? current?.reverse_zone ?? '').trim().toLowerCase();
  if (zone && !/^([0-9]{1,3}\.){1,3}in-addr\.arpa\.?$/.test(zone)) throw fail(400, 'Reverse zone: like 113.0.203.in-addr.arpa');
  out.reverse_zone = zone ? zone.replace(/\.?$/, '.') : null;
  return { out, net };
}

export function createIpPool(req, input) {
  const { out, net } = poolInput(input);
  const overlap = db.prepare('SELECT name, cidr FROM ip_pools').all().find((p) => {
    const o = parseCidr(p.cidr);
    return net.base <= o.last + 1 && o.base <= net.last + 1;
  });
  if (overlap) throw fail(409, `Overlaps the pool ${overlap.name} (${overlap.cidr})`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = Number(db.prepare(`INSERT INTO ip_pools (name, cidr, gateway, bridge, vlan, dns, datacenter_id, price_monthly, reverse_zone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(out.name, out.cidr, out.gateway, out.bridge, out.vlan, out.dns, out.datacenter_id, out.price_monthly, out.reverse_zone).lastInsertRowid);
    const ins = db.prepare("INSERT INTO ip_addresses (pool_id, address, state, note) VALUES (?, ?, ?, ?)");
    const gw = toInt(out.gateway);
    for (let n = net.first; n <= net.last; n += 1) {
      ins.run(id, toIp(n), n === gw ? 'reserved' : 'free', n === gw ? 'Gateway' : null);
    }
    db.exec('COMMIT');
    audit(req, null, 'admin_ip_pool_create', { id, ...out });
    return poolPub(db.prepare('SELECT * FROM ip_pools WHERE id = ?').get(id));
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function updateIpPool(req, id, input) {
  const cur = db.prepare('SELECT * FROM ip_pools WHERE id = ?').get(id);
  if (!cur) throw fail(404, 'Pool not found');
  if (input.cidr !== undefined && input.cidr !== cur.cidr) throw fail(400, 'The subnet of a pool can\'t change; create a new pool');
  const { out } = poolInput(input, cur);
  if (out.gateway !== cur.gateway) {
    const a = db.prepare('SELECT state FROM ip_addresses WHERE pool_id = ? AND address = ?').get(id, out.gateway);
    if (a && !['free', 'reserved'].includes(a.state)) throw fail(409, `${out.gateway} is in use and can't become the gateway`);
    db.prepare("UPDATE ip_addresses SET state = 'free', note = NULL WHERE pool_id = ? AND address = ? AND note = 'Gateway'").run(id, cur.gateway);
    db.prepare("UPDATE ip_addresses SET state = 'reserved', note = 'Gateway' WHERE pool_id = ? AND address = ?").run(id, out.gateway);
  }
  db.prepare(`UPDATE ip_pools SET name = ?, gateway = ?, bridge = ?, vlan = ?, dns = ?, datacenter_id = ?, price_monthly = ?, reverse_zone = ? WHERE id = ?`)
    .run(out.name, out.gateway, out.bridge, out.vlan, out.dns, out.datacenter_id, out.price_monthly, out.reverse_zone, id);
  audit(req, null, 'admin_ip_pool_update', { id, ...out });
  return poolPub(db.prepare('SELECT * FROM ip_pools WHERE id = ?').get(id));
}

export function deleteIpPool(req, id) {
  const p = db.prepare('SELECT * FROM ip_pools WHERE id = ?').get(id);
  if (!p) throw fail(404, 'Pool not found');
  const used = db.prepare("SELECT COUNT(*) AS n FROM ip_addresses WHERE pool_id = ? AND state IN ('assigned', 'held')").get(id).n;
  if (used) throw fail(409, `${used} address${used === 1 ? ' is' : 'es are'} still in use`);
  db.prepare('DELETE FROM ip_pools WHERE id = ?').run(id);
  audit(req, null, 'admin_ip_pool_delete', { id, name: p.name, cidr: p.cidr });
  return { deleted: true };
}

export function poolAddresses(id, { state = '', q = '' } = {}) {
  if (!db.prepare('SELECT 1 FROM ip_pools WHERE id = ?').get(id)) throw fail(404, 'Pool not found');
  const where = ['a.pool_id = ?'];
  const args = [id];
  if (state) { where.push('a.state = ?'); args.push(state); }
  if (q) { where.push("(a.address LIKE ? OR u.email LIKE ? OR CAST(a.vmid AS TEXT) = ? OR a.ptr LIKE ?)"); args.push(`%${q}%`, `%${q}%`, q, `%${q}%`); }
  return db.prepare(`SELECT a.*, u.email, v.label AS server FROM ip_addresses a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN vms v ON v.vmid = a.vmid
    WHERE ${where.join(' AND ')} ORDER BY a.id LIMIT 1100`).all(...args).map((a) => ({
    id: a.id, address: a.address, state: a.state, email: a.email, userId: a.user_id, vmid: a.vmid, server: a.server, nic: a.nic,
    mac: a.mac, ptr: a.ptr, note: a.note, assignedAt: a.assigned_at, releasedAt: a.released_at,
  }));
}

/** Admin: reserve a free address (with a note), make a reserved, cooling or held address free again. */
export function setAddressState(req, id, { state, note = null }) {
  const a = db.prepare('SELECT * FROM ip_addresses WHERE id = ?').get(id);
  if (!a) throw fail(404, 'Address not found');
  const pool = db.prepare('SELECT gateway FROM ip_pools WHERE id = ?').get(a.pool_id);
  if (a.address === pool.gateway) throw fail(409, 'This is the gateway of the pool');
  if (state === 'reserved') {
    if (a.state !== 'free' && a.state !== 'cooldown') throw fail(409, 'Only a free address can be reserved');
    db.prepare("UPDATE ip_addresses SET state = 'reserved', note = ? WHERE id = ?").run(String(note ?? '').slice(0, 200) || null, id);
  } else if (state === 'free') {
    if (!['reserved', 'cooldown', 'held'].includes(a.state)) throw fail(409, 'Only reserved, cooling-down or held addresses can be freed');
    db.prepare("UPDATE ip_addresses SET state = 'free', note = NULL, user_id = NULL, vmid = NULL, nic = NULL, mac = NULL, ptr = NULL WHERE id = ?").run(id);
  } else {
    throw fail(400, 'State: reserved or free');
  }
  audit(req, a.vmid, 'admin_ip_state', { address: a.address, from: a.state, to: state, note });
  return { id, address: a.address, state };
}

// ---- Customer ---------------------------------------------------------------------------------

const hasCloudInit = (cfg) => Object.values(cfg).some((v) => typeof v === 'string' && /cloudinit/.test(v));

function addrPub(a, p) {
  const net = parseCidr(p.cidr);
  return {
    id: a.id, address: a.address, prefix: net.bits, netmask: toIp((~0 << (32 - net.bits)) >>> 0), gateway: p.gateway,
    dns: p.dns ? p.dns.split(',') : [], nic: a.nic, mac: a.mac, ptr: a.ptr, apply: a.apply, monthly: p.price_monthly, pool: p.name,
  };
}

async function guestOf(account, vmid) {
  const row = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?').get(vmid, account.id);
  if (!row) throw fail(404, 'Server not found');
  const guest = (await clusterGuests(true)).get(vmid);
  if (!guest) throw fail(404, 'Server not found in Proxmox');
  return { row, guest, path: guestPath(guest) };
}

/** Pools a server can take an address from: its datacenter's (or any datacenter's). */
function poolsFor(node) {
  const dc = datacenterOfNode(node);
  return db.prepare('SELECT * FROM ip_pools WHERE datacenter_id IS NULL OR datacenter_id = ? ORDER BY datacenter_id IS NULL, id').all(dc?.id ?? -1);
}

const availableSql = `pool_id = ? AND (state = 'free' OR (state = 'cooldown' AND released_at <= ?))`;

export async function serverIps(account, vmid) {
  const s = stored();
  if (!s.enabled) return { enabled: false };
  const { guest } = await guestOf(account, vmid);
  const rows = db.prepare('SELECT a.*, p.* , a.id AS id FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.vmid = ? AND a.state = \'assigned\' ORDER BY a.id').all(vmid);
  const addresses = rows.map((r) => addrPub(r, { ...r, id: r.pool_id }));
  const until = new Date(Date.now() - s.cooldownHours * 3_600_000).toISOString();
  const pools = poolsFor(guest.node);
  const free = pools.reduce((n, p) => n + db.prepare(`SELECT COUNT(*) AS n FROM ip_addresses WHERE ${availableSql}`).get(p.id, until).n, 0);
  const price = pools.find((p) => db.prepare(`SELECT 1 FROM ip_addresses WHERE ${availableSql}`).get(p.id, until))?.price_monthly ?? null;
  return {
    enabled: true, addresses, maxPerServer: s.maxPerServer, available: free > 0, priceMonthly: price,
    canAssign: free > 0 && addresses.length < s.maxPerServer, type: guest.type, reverseDns: true,
  };
}

const busy = new Set();

export async function assignIp(req, vmid) {
  const s = stored();
  if (!s.enabled) throw fail(404, 'Public IP addresses are not available');
  if (busy.has(vmid)) throw fail(409, 'Another address change on this server is still running');
  busy.add(vmid);
  let claimed = null;
  try {
    const { row, guest, path } = await guestOf(req.account, vmid);
    if (row.state !== 'ready') throw fail(409, 'Wait until the current operation on this server has finished');
    if (row.expired_at) throw fail(403, 'This server has expired. Renew it first.');
    const count = db.prepare("SELECT COUNT(*) AS n FROM ip_addresses WHERE vmid = ? AND state = 'assigned'").get(vmid).n;
    if (count >= s.maxPerServer) throw fail(409, `A server can have at most ${s.maxPerServer} public address${s.maxPerServer === 1 ? '' : 'es'}`);
    await checkPoolCapacity(req.account.id, { publicIps: 1 });
    const cfg = await pve.get(`${path}/config`);
    const n = NICS.find((i) => cfg[`net${i}`] === undefined);
    if (n === undefined) throw fail(409, 'This server has no free network slot');

    // claim one address atomically (cooled-down addresses count as free)
    const until = new Date(Date.now() - s.cooldownHours * 3_600_000).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of poolsFor(guest.node)) {
        const a = db.prepare(`SELECT * FROM ip_addresses WHERE ${availableSql} ORDER BY state = 'cooldown', id LIMIT 1`).get(p.id, until);
        if (a) {
          db.prepare("UPDATE ip_addresses SET state = 'assigned', user_id = ?, vmid = ?, nic = ?, mac = NULL, ptr = NULL, note = NULL, assigned_at = datetime('now'), released_at = NULL WHERE id = ?")
            .run(req.account.id, vmid, `net${n}`, a.id);
          claimed = { ...a, pool: p };
          break;
        }
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    if (!claimed) throw fail(409, 'No public address is free in this server\'s datacenter. Please contact support.');

    const apply = await configureNic(path, guest.type, cfg, n, claimed.address, claimed.pool, null);
    db.prepare('UPDATE ip_addresses SET mac = ?, apply = ? WHERE id = ?').run(apply.mac, apply.how, claimed.id);
    audit(req, vmid, 'ip_assigned', { address: claimed.address, pool: claimed.pool.name, nic: `net${n}`, apply: apply.how });
    const out = addrPub({ ...claimed, nic: `net${n}`, mac: apply.mac, ptr: null, apply: apply.how }, claimed.pool);
    claimed = null;
    return out;
  } catch (err) {
    if (claimed) {
      db.prepare("UPDATE ip_addresses SET state = 'free', user_id = NULL, vmid = NULL, nic = NULL, assigned_at = NULL WHERE id = ?").run(claimed.id);
      audit(req, vmid, 'ip_assign_failed', { address: claimed.address, error: String(err.message).slice(0, 300) });
      if (!err.statusCode) throw fail(502, `Proxmox could not add the address: ${err.message}`);
    }
    throw err;
  } finally {
    busy.delete(vmid);
  }
}

/**
 * Adds NIC netN on the pool's bridge with the address, and the IP filter for it.
 * Returns { mac, how }: 'restart' (cloud-init, active after a restart), 'live'
 * (container) or 'manual' (VM without cloud-init).
 */
async function configureNic(path, type, cfg, n, address, pool, mac) {
  const bits = parseCidr(pool.cidr).bits;
  const tag = pool.vlan ? `,tag=${pool.vlan}` : '';
  let how;
  if (type === 'lxc') {
    await pve.put(`${path}/config`, { [`net${n}`]: `name=eth${n},bridge=${pool.bridge}${tag},firewall=1,ip=${address}/${bits},gw=${pool.gateway}${mac ? `,hwaddr=${mac}` : ''}` });
    how = 'live';
  } else {
    const model = /^([a-z0-9]+)(=|,|$)/i.exec(cfg.net0 ?? '')?.[1] ?? 'virtio';
    const params = { [`net${n}`]: `${model}${mac ? `=${mac}` : ''},bridge=${pool.bridge}${tag},firewall=1` };
    if (hasCloudInit(cfg)) {
      // The public NIC carries the default route (a static route wins over the DHCP one on
      // net0), so answers leave from the public address; the private network stays
      // reachable through its own subnet route.
      params[`ipconfig${n}`] = `ip=${address}/${bits},gw=${pool.gateway}`;
      if (pool.dns && !cfg.nameserver) params.nameserver = pool.dns.split(',').join(' ');
      how = 'restart';
    } else {
      how = 'manual';
    }
    await pve.put(`${path}/config`, params);
  }
  const after = await pve.get(`${path}/config`);
  const got = /([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(after[`net${n}`] ?? '')?.[1]?.toUpperCase() ?? mac;
  // anti-spoofing: only this address may be used on netN (with the firewall's ipfilter on)
  const set = `ipfilter-net${n}`;
  await pve.del(`${path}/firewall/ipset/${set}`, { force: 1 }).catch(() => {});
  await pve.post(`${path}/firewall/ipset`, { name: set, comment: 'Managed by the panel: public address' }).catch(() => {});
  await pve.post(`${path}/firewall/ipset/${set}`, { cidr: `${address}/32` }).catch(() => {});
  return { mac: got, how };
}

export async function releaseIp(req, id) {
  const a = db.prepare("SELECT a.*, p.reverse_zone FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.id = ? AND a.user_id = ? AND a.state = 'assigned'").get(id, req.account.id);
  if (!a) throw fail(404, 'Address not found');
  if (busy.has(a.vmid)) throw fail(409, 'Another address change on this server is still running');
  busy.add(a.vmid);
  try {
    const guest = (await clusterGuests(true)).get(a.vmid);
    if (!guest && guestMayBeHidden()) throw new HiddenGuestError();
    if (guest) {
      const path = guestPath(guest);
      const cfg = await pve.get(`${path}/config`);
      const n = a.nic.slice(3);
      const del = [a.nic, ...(cfg[`ipconfig${n}`] !== undefined ? [`ipconfig${n}`] : [])];
      await pve.put(`${path}/config`, { delete: del.join(',') });
      await pve.del(`${path}/firewall/ipset/ipfilter-${a.nic}`, { force: 1 }).catch(() => {});
    }
    if (a.ptr) await pushPtr(a.address, a.reverse_zone, null).catch(() => {});
    db.prepare("UPDATE ip_addresses SET state = 'cooldown', user_id = NULL, vmid = NULL, nic = NULL, mac = NULL, ptr = NULL, apply = NULL, released_at = ? WHERE id = ?")
      .run(new Date().toISOString(), a.id);
    audit(req, a.vmid, 'ip_released', { address: a.address });
    return { released: true };
  } finally {
    busy.delete(a.vmid);
  }
}

// ---- Reverse DNS ---------------------------------------------------------------------------------

const HOST = /^(?=.{1,253}\.?$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]\.?$/i;
const ptrName = (ip) => `${ip.split('.').reverse().join('.')}.in-addr.arpa.`;

async function pushPtr(address, zone, hostname) {
  const s = stored();
  const key = reveal(s.powerdns.apiKey);
  if (!s.powerdns.url || !key || !zone) return false;
  const rrset = hostname
    ? { name: ptrName(address), type: 'PTR', ttl: 3600, changetype: 'REPLACE', records: [{ content: hostname.replace(/\.?$/, '.'), disabled: false }] }
    : { name: ptrName(address), type: 'PTR', changetype: 'DELETE' };
  const url = `${s.powerdns.url}/api/v1/servers/${encodeURIComponent(s.powerdns.serverId)}/zones/${encodeURIComponent(zone)}`;
  let res;
  try {
    res = await fetch(url, { method: 'PATCH', headers: { 'X-API-Key': key, 'content-type': 'application/json' }, body: JSON.stringify({ rrsets: [rrset] }), signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw fail(502, `The DNS server can't be reached (${err.cause?.code ?? err.name})`);
  }
  if (!res.ok) throw fail(502, `The DNS server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export async function setPtr(req, id, hostname) {
  const a = db.prepare("SELECT a.*, p.reverse_zone FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.id = ? AND a.user_id = ? AND a.state = 'assigned'").get(id, req.account.id);
  if (!a) throw fail(404, 'Address not found');
  const h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (h && !HOST.test(h)) throw fail(400, 'Reverse DNS: a full host name like mail.example.com');
  const pushed = await pushPtr(a.address, a.reverse_zone, h || null);
  db.prepare('UPDATE ip_addresses SET ptr = ? WHERE id = ?').run(h || null, a.id);
  audit(req, a.vmid, 'ip_ptr_set', { address: a.address, ptr: h || null, dns: pushed });
  return { id: a.id, ptr: h || null, published: pushed };
}

// ---- Lifecycle hooks -------------------------------------------------------------------------------

/** After a reinstall (the VM is recreated): put the server's public addresses back. */
export async function applyRecordedIps(path, vmid, { onlyMissing = false } = {}) {
  const rows = db.prepare("SELECT a.*, p.* , a.id AS aid FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.vmid = ? AND a.state = 'assigned'").all(vmid);
  if (!rows.length) return;
  const type = /\/lxc\//.test(path) ? 'lxc' : 'qemu';
  for (const r of rows) {
    const cfg = await pve.get(`${path}/config`);
    if (onlyMissing && cfg[r.nic] !== undefined) continue;     // after a rollback: only what the snapshot lacked
    const n = Number(r.nic.slice(3));
    const apply = await configureNic(path, type, cfg, n, r.address, { ...r, id: r.pool_id }, r.mac);
    db.prepare('UPDATE ip_addresses SET mac = ?, apply = ? WHERE id = ?').run(apply.mac, apply.how === 'restart' ? 'live' : apply.how, r.aid);
  }
}

/** A server destroyed by the panel: its addresses cool down. */
export function releaseIpsOfDeletedServer(vmid) {
  // remove reverse DNS in the background (best effort): the next holder starts clean
  for (const r of db.prepare("SELECT a.address, a.ptr, p.reverse_zone FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.vmid = ? AND a.state = 'assigned' AND a.ptr IS NOT NULL").all(vmid)) {
    pushPtr(r.address, r.reverse_zone, null).catch(() => {});
  }
  db.prepare("UPDATE ip_addresses SET state = 'cooldown', user_id = NULL, vmid = NULL, nic = NULL, mac = NULL, ptr = NULL, apply = NULL, released_at = ? WHERE vmid = ? AND state = 'assigned'")
    .run(new Date().toISOString(), vmid);
}

/** Billing: public addresses of a server and their monthly price. */
export function ipsOfServer(vmid) {
  return db.prepare("SELECT a.address, p.price_monthly AS monthly FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.vmid = ? AND a.state = 'assigned' ORDER BY a.id").all(vmid);
}

/** Resource pools: assigned public addresses of these customers. */
export function publicIpsOfUsers(ids) {
  if (!ids.length) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM ip_addresses WHERE state = 'assigned' AND user_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
}
