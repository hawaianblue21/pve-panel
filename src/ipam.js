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
//
// IPv6 (optional, switched on in the settings): a pool may carry an IPv6 prefix
// (e.g. 2001:db8:100::/48). Every IPv4 address of the pool maps to a fixed /64 in it
// (the n-th address of the subnet → the n-th /64), so there is nothing to allocate:
// the /64 follows its IPv4 address through assignment, cool-down and release. The
// customer switches IPv6 on per address; the server gets <prefix>::1/64 on the same
// card (cloud-init ip6=/gw6=, container ip6=/gw6=) and the IP filter admits the whole
// /64 (Proxmox adds the card's link-local address itself). The router must deliver
// each /64 on the bridge (the pool prefix on-link, or a route per /64).

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

// ---- IPv6 -----------------------------------------------------------------------------------

/** IPv6 text → BigInt, or null. No zone index, no embedded IPv4. */
export function parse6(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s || s.length > 39 || !/^[0-9a-f:]+$/.test(s)) return null;
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (parts.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...tail].reduce((a, g) => (a << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** BigInt → IPv6 text in the short form (RFC 5952). */
export function fmt6(n) {
  const g = [];
  for (let i = 7; i >= 0; i -= 1) g.push(Number((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== '0') { i += 1; continue; }
    let j = i;
    while (j < 8 && g[j] === '0') j += 1;
    if (j - i > len) { best = i; len = j - i; }
    i = j;
  }
  if (len < 2) return g.join(':');
  return `${g.slice(0, best).join(':')}::${g.slice(best + len).join(':')}`;
}

export function parseCidr6(cidr) {
  const m = /^([0-9a-fA-F:]+)\/(\d{1,3})$/.exec(String(cidr ?? '').trim());
  const ip = m && parse6(m[1]);
  if (ip === null || ip === undefined || !m) throw fail(400, 'IPv6 prefix: a network like 2001:db8:100::/48');
  const bits = Number(m[2]);
  if (bits < 32 || bits > 63) throw fail(400, 'IPv6 prefix size: from /32 to /63 (each address gets a /64 of it)');
  const host = (1n << BigInt(128 - bits)) - 1n;
  if (ip & host) throw fail(400, `IPv6 prefix: ${fmt6(ip)} is not the network address (that is ${fmt6(ip & ~host & ((1n << 128n) - 1n))})`);
  return { base: ip, bits, cidr: `${fmt6(ip)}/${bits}` };
}
const isLinkLocal = (n) => (n >> 118n) === 0x3fan;

/** The /64 of an IPv4 address of a pool with an IPv6 prefix, or null. */
function v6Of(pool, address) {
  if (!pool.ipv6_cidr) return null;
  const net4 = parseCidr(pool.cidr);
  const net6 = parseCidr6(pool.ipv6_cidr);
  const base = net6.base + (BigInt(toInt(address) - net4.base) << 64n);
  return { prefix: `${fmt6(base)}/64`, address: fmt6(base + 1n), bits: 64, gateway: pool.ipv6_gateway, network: base };
}

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

const DEFAULTS = { enabled: false, ipv6Enabled: false, maxPerServer: 2, cooldownHours: 24, powerdns: { url: '', apiKey: null, serverId: 'localhost' } };
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
  if (typeof input.ipv6Enabled === 'boolean') s.ipv6Enabled = input.ipv6Enabled;
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
    ipv6: p.ipv6_cidr ? { cidr: p.ipv6_cidr, gateway: p.ipv6_gateway, reverseZone: p.ipv6_reverse_zone, priceMonthly: p.ipv6_price_monthly } : null,
    ipv6On: db.prepare("SELECT COUNT(*) AS n FROM ip_addresses WHERE pool_id = ? AND ipv6_on = 1").get(p.id).n,
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

  // optional IPv6 prefix: one /64 per IPv4 address of the subnet
  const v6 = input.ipv6Cidr === undefined ? current?.ipv6_cidr ?? '' : String(input.ipv6Cidr ?? '').trim();
  if (v6) {
    const net6 = parseCidr6(v6);
    if (64 - net6.bits < 32 - net.bits) throw fail(400, `IPv6 prefix: ${net.cidr} has ${2 ** (32 - net.bits)} addresses, so the prefix needs at least as many /64s (/${64 - (32 - net.bits)} or larger)`);
    out.ipv6_cidr = net6.cidr;
    const gwText = input.ipv6Gateway === undefined ? current?.ipv6_gateway ?? '' : String(input.ipv6Gateway ?? '').trim();
    const gw = parse6(gwText);
    if (gw === null) throw fail(400, 'IPv6 gateway: the router\'s address, e.g. fe80::1');
    if (!isLinkLocal(gw) && (gw >> 64n) !== (net6.base >> 64n)) throw fail(400, `IPv6 gateway: a link-local address (fe80::1) or one in the first /64 of the prefix (${fmt6(net6.base)}/64, which is never handed out)`);
    out.ipv6_gateway = fmt6(gw);
    const z6 = String(input.ipv6ReverseZone ?? current?.ipv6_reverse_zone ?? '').trim().toLowerCase();
    if (z6 && !/^([0-9a-f]\.){1,31}ip6\.arpa\.?$/.test(z6)) throw fail(400, 'IPv6 reverse zone: like 0.0.1.0.8.b.d.0.1.0.0.2.ip6.arpa');
    if (z6) {
      // the zone must cover the prefix: its nibbles, read backwards, start the prefix
      const nibbles = z6.replace(/\.?ip6\.arpa\.?$/, '').split('.').reverse().join('');
      const hex = net6.base.toString(16).padStart(32, '0');
      if (nibbles.length * 4 > net6.bits || !hex.startsWith(nibbles)) throw fail(400, `IPv6 reverse zone: it must cover ${net6.cidr}, e.g. ${hex.slice(0, Math.floor(net6.bits / 4)).split('').reverse().join('.')}.ip6.arpa`);
    }
    out.ipv6_reverse_zone = z6 ? z6.replace(/\.?$/, '.') : null;
    const p6 = input.ipv6PriceMonthly === undefined ? current?.ipv6_price_monthly ?? 0 : Number(input.ipv6PriceMonthly);
    if (!Number.isInteger(p6) || p6 < 0 || p6 > 100_000_000) throw fail(400, 'IPv6 price: whole rupiah');
    out.ipv6_price_monthly = p6;
  } else {
    Object.assign(out, { ipv6_cidr: null, ipv6_gateway: null, ipv6_reverse_zone: null, ipv6_price_monthly: 0 });
  }
  return { out, net };
}

export function createIpPool(req, input) {
  const { out, net } = poolInput(input);
  const overlap = db.prepare('SELECT name, cidr FROM ip_pools').all().find((p) => {
    const o = parseCidr(p.cidr);
    return net.base <= o.last + 1 && o.base <= net.last + 1;
  });
  if (overlap) throw fail(409, `Overlaps the pool ${overlap.name} (${overlap.cidr})`);
  overlap6(out.ipv6_cidr, null);
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = Number(db.prepare(`INSERT INTO ip_pools (name, cidr, gateway, bridge, vlan, dns, datacenter_id, price_monthly, reverse_zone, ipv6_cidr, ipv6_gateway, ipv6_reverse_zone, ipv6_price_monthly)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(out.name, out.cidr, out.gateway, out.bridge, out.vlan, out.dns, out.datacenter_id, out.price_monthly, out.reverse_zone,
      out.ipv6_cidr, out.ipv6_gateway, out.ipv6_reverse_zone, out.ipv6_price_monthly).lastInsertRowid);
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

/** IPv6 prefixes of pools must not overlap. */
function overlap6(cidr, exceptId) {
  if (!cidr) return;
  const a = parseCidr6(cidr);
  const endOf = (n) => n.base + (1n << BigInt(128 - n.bits)) - 1n;
  const hit = db.prepare('SELECT id, name, ipv6_cidr FROM ip_pools WHERE ipv6_cidr IS NOT NULL').all().find((p) => {
    if (p.id === exceptId) return false;
    const b = parseCidr6(p.ipv6_cidr);
    return a.base <= endOf(b) && b.base <= endOf(a);
  });
  if (hit) throw fail(409, `The IPv6 prefix overlaps the pool ${hit.name} (${hit.ipv6_cidr})`);
}

export function updateIpPool(req, id, input) {
  const cur = db.prepare('SELECT * FROM ip_pools WHERE id = ?').get(id);
  if (!cur) throw fail(404, 'Pool not found');
  if (input.cidr !== undefined && input.cidr !== cur.cidr) throw fail(400, 'The subnet of a pool can\'t change; create a new pool');
  // servers using IPv6 of this pool lock its prefix and gateway (checked before anything else)
  const v6Used = db.prepare('SELECT COUNT(*) AS n FROM ip_addresses WHERE pool_id = ? AND ipv6_on = 1').get(id).n;
  const same = (given, stored, norm) => { if (given === undefined) return true; try { return norm(given) === stored; } catch { return false; } };
  const locked = () => fail(409, `${v6Used} server${v6Used === 1 ? ' uses' : 's use'} IPv6 from this pool; the IPv6 prefix and gateway can't change until it is switched off there`);
  if (v6Used && (!same(input.ipv6Cidr, cur.ipv6_cidr, (x) => parseCidr6(x).cidr) || !same(input.ipv6Gateway, cur.ipv6_gateway, (x) => fmt6(parse6(x))))) throw locked();
  const { out } = poolInput(input, cur);
  if (v6Used && (out.ipv6_cidr !== cur.ipv6_cidr || out.ipv6_gateway !== cur.ipv6_gateway)) throw locked();
  overlap6(out.ipv6_cidr, id);
  if (out.gateway !== cur.gateway) {
    const a = db.prepare('SELECT state FROM ip_addresses WHERE pool_id = ? AND address = ?').get(id, out.gateway);
    if (a && !['free', 'reserved'].includes(a.state)) throw fail(409, `${out.gateway} is in use and can't become the gateway`);
    db.prepare("UPDATE ip_addresses SET state = 'free', note = NULL WHERE pool_id = ? AND address = ? AND note = 'Gateway'").run(id, cur.gateway);
    db.prepare("UPDATE ip_addresses SET state = 'reserved', note = 'Gateway' WHERE pool_id = ? AND address = ?").run(id, out.gateway);
  }
  db.prepare(`UPDATE ip_pools SET name = ?, gateway = ?, bridge = ?, vlan = ?, dns = ?, datacenter_id = ?, price_monthly = ?, reverse_zone = ?,
      ipv6_cidr = ?, ipv6_gateway = ?, ipv6_reverse_zone = ?, ipv6_price_monthly = ? WHERE id = ?`)
    .run(out.name, out.gateway, out.bridge, out.vlan, out.dns, out.datacenter_id, out.price_monthly, out.reverse_zone,
      out.ipv6_cidr, out.ipv6_gateway, out.ipv6_reverse_zone, out.ipv6_price_monthly, id);
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
  const pool = db.prepare('SELECT * FROM ip_pools WHERE id = ?').get(id);
  if (!pool) throw fail(404, 'Pool not found');
  const where = ['a.pool_id = ?'];
  const args = [id];
  if (state) { where.push('a.state = ?'); args.push(state); }
  if (q) { where.push("(a.address LIKE ? OR u.email LIKE ? OR CAST(a.vmid AS TEXT) = ? OR a.ptr LIKE ?)"); args.push(`%${q}%`, `%${q}%`, q, `%${q}%`); }
  return db.prepare(`SELECT a.*, u.email, v.label AS server FROM ip_addresses a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN vms v ON v.vmid = a.vmid
    WHERE ${where.join(' AND ')} ORDER BY a.id LIMIT 1100`).all(...args).map((a) => ({
    id: a.id, address: a.address, state: a.state, email: a.email, userId: a.user_id, vmid: a.vmid, server: a.server, nic: a.nic,
    mac: a.mac, ptr: a.ptr, note: a.note, assignedAt: a.assigned_at, releasedAt: a.released_at,
    ipv6: a.ipv6_on ? { prefix: v6Of(pool, a.address)?.prefix ?? null, ptr: a.ipv6_ptr } : null,
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
    db.prepare("UPDATE ip_addresses SET state = 'free', note = NULL, user_id = NULL, vmid = NULL, nic = NULL, mac = NULL, ptr = NULL, ipv6_on = 0, ipv6_ptr = NULL WHERE id = ?").run(id);
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
  const v6 = v6Of(p, a.address);
  return {
    id: a.id, address: a.address, prefix: net.bits, netmask: toIp((~0 << (32 - net.bits)) >>> 0), gateway: p.gateway,
    dns: p.dns ? p.dns.split(',') : [], nic: a.nic, mac: a.mac, ptr: a.ptr, apply: a.apply, monthly: p.price_monthly, pool: p.name,
    ipv6: v6 ? { available: true, on: !!a.ipv6_on, prefix: v6.prefix, address: v6.address, bits: 64, gateway: v6.gateway, ptr: a.ipv6_ptr ?? null, monthly: p.ipv6_price_monthly } : { available: false, on: false },
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
    canAssign: free > 0 && addresses.length < s.maxPerServer, type: guest.type, reverseDns: true, ipv6Enabled: !!s.ipv6Enabled,
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
          db.prepare("UPDATE ip_addresses SET state = 'assigned', user_id = ?, vmid = ?, nic = ?, mac = NULL, ptr = NULL, ipv6_on = 0, ipv6_ptr = NULL, note = NULL, assigned_at = datetime('now'), released_at = NULL WHERE id = ?")
            .run(req.account.id, vmid, `net${n}`, a.id);
          claimed = { ...a, pool: p };
          break;
        }
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    if (!claimed) throw fail(409, 'No public address is free in this server\'s datacenter. Please contact support.');

    const apply = await configureNic(path, guest.type, cfg, n, claimed.address, claimed.pool, null, null);
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
async function configureNic(path, type, cfg, n, address, pool, mac, v6) {
  const bits = parseCidr(pool.cidr).bits;
  const tag = pool.vlan ? `,tag=${pool.vlan}` : '';
  const six = v6 ? `,ip6=${v6.address}/${v6.bits},gw6=${v6.gateway}` : '';
  let how;
  if (type === 'lxc') {
    await pve.put(`${path}/config`, { [`net${n}`]: `name=eth${n},bridge=${pool.bridge}${tag},firewall=1,ip=${address}/${bits},gw=${pool.gateway}${six}${mac ? `,hwaddr=${mac}` : ''}` });
    how = 'live';
  } else {
    const model = /^([a-z0-9]+)(=|,|$)/i.exec(cfg.net0 ?? '')?.[1] ?? 'virtio';
    const params = { [`net${n}`]: `${model}${mac ? `=${mac}` : ''},bridge=${pool.bridge}${tag},firewall=1` };
    if (hasCloudInit(cfg)) {
      // The public NIC carries the default route (a static route wins over the DHCP one on
      // net0), so answers leave from the public address; the private network stays
      // reachable through its own subnet route.
      params[`ipconfig${n}`] = `ip=${address}/${bits},gw=${pool.gateway}${six}`;
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
  if (v6) await pve.post(`${path}/firewall/ipset/${set}`, { cidr: v6.prefix }).catch(() => {});
  return { mac: got, how };
}

export async function releaseIp(req, id) {
  const a = db.prepare("SELECT a.*, p.reverse_zone, p.cidr, p.ipv6_cidr, p.ipv6_gateway, p.ipv6_reverse_zone FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.id = ? AND a.user_id = ? AND a.state = 'assigned'").get(id, req.account.id);
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
    if (a.ipv6_ptr) await pushPtr6(a, null).catch(() => {});
    db.prepare("UPDATE ip_addresses SET state = 'cooldown', user_id = NULL, vmid = NULL, nic = NULL, mac = NULL, ptr = NULL, ipv6_on = 0, ipv6_ptr = NULL, apply = NULL, released_at = ? WHERE id = ?")
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

/** ip6.arpa name of an IPv6 address: its 32 nibbles reversed. */
const ptrName6 = (text) => `${parse6(text).toString(16).padStart(32, '0').split('').reverse().join('.')}.ip6.arpa.`;

/** PTR of the server address (<prefix>::1) of an address row joined with its pool. */
async function pushPtr6(row, hostname) {
  const v6 = v6Of(row, row.address);
  if (!v6) return false;
  const s = stored();
  const key = reveal(s.powerdns.apiKey);
  const zone = row.ipv6_reverse_zone;
  if (!s.powerdns.url || !key || !zone) return false;
  const name = ptrName6(v6.address);
  const rrset = hostname
    ? { name, type: 'PTR', ttl: 3600, changetype: 'REPLACE', records: [{ content: hostname.replace(/\.?$/, '.'), disabled: false }] }
    : { name, type: 'PTR', changetype: 'DELETE' };
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

const rowSql = "SELECT a.*, p.reverse_zone, p.cidr, p.gateway, p.bridge, p.vlan, p.dns, p.ipv6_cidr, p.ipv6_gateway, p.ipv6_reverse_zone, p.ipv6_price_monthly FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.id = ? AND a.user_id = ? AND a.state = 'assigned'";

export async function setPtr(req, id, hostname, family = 4) {
  const a = db.prepare(rowSql).get(id, req.account.id);
  if (!a) throw fail(404, 'Address not found');
  const h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (h && !HOST.test(h)) throw fail(400, 'Reverse DNS: a full host name like mail.example.com');
  if (Number(family) === 6) {
    if (!a.ipv6_on) throw fail(409, 'Switch IPv6 on for this address first');
    const pushed6 = await pushPtr6(a, h || null);
    db.prepare('UPDATE ip_addresses SET ipv6_ptr = ? WHERE id = ?').run(h || null, a.id);
    audit(req, a.vmid, 'ip_ptr_set', { address: v6Of(a, a.address).address, ptr: h || null, dns: pushed6 });
    return { id: a.id, ptr: h || null, published: pushed6, family: 6 };
  }
  const pushed = await pushPtr(a.address, a.reverse_zone, h || null);
  db.prepare('UPDATE ip_addresses SET ptr = ? WHERE id = ?').run(h || null, a.id);
  audit(req, a.vmid, 'ip_ptr_set', { address: a.address, ptr: h || null, dns: pushed });
  return { id: a.id, ptr: h || null, published: pushed };
}

// ---- IPv6 on/off per address ---------------------------------------------------------------------

/**
 * Switches the /64 of an assigned address on or off. Switching on needs IPv6 enabled in
 * the settings and a prefix on the pool; switching off always works (also after the
 * administrator disabled IPv6). Active like the IPv4 address: after a restart from the
 * panel (cloud-init), at once (container) or once set up inside (other VMs).
 */
export async function setIpv6(req, id, on) {
  const s = stored();
  const a = db.prepare(rowSql).get(id, req.account.id);
  if (!a) throw fail(404, 'Address not found');
  const v6 = v6Of(a, a.address);
  if (on && !s.ipv6Enabled) throw fail(404, 'IPv6 is not available');
  if (on && !v6) throw fail(409, 'This address\'s pool has no IPv6 prefix');
  if (!!a.ipv6_on === !!on) return { id: a.id, ipv6: on, apply: a.apply };
  if (busy.has(a.vmid)) throw fail(409, 'Another address change on this server is still running');
  busy.add(a.vmid);
  try {
    const { row, guest, path } = await guestOf(req.account, a.vmid);
    if (row.state !== 'ready') throw fail(409, 'Wait until the current operation on this server has finished');
    if (on && row.expired_at) throw fail(403, 'This server has expired. Renew it first.');
    const cfg = await pve.get(`${path}/config`);
    if (cfg[a.nic] === undefined) throw fail(409, `The network card ${a.nic} of this address is missing on the server; contact support`);
    let apply;
    try {
      apply = await configureNic(path, guest.type, cfg, Number(a.nic.slice(3)), a.address, { ...a, id: a.pool_id }, a.mac, on ? v6 : null);
    } catch (err) {
      if (!err.statusCode) throw fail(502, `Proxmox could not change the address: ${err.message}`);
      throw err;
    }
    if (!on && a.ipv6_ptr) await pushPtr6(a, null).catch(() => {});
    db.prepare(`UPDATE ip_addresses SET ipv6_on = ?, apply = ?${on ? '' : ', ipv6_ptr = NULL'} WHERE id = ?`).run(on ? 1 : 0, apply.how, a.id);
    audit(req, a.vmid, on ? 'ipv6_on' : 'ipv6_off', { address: a.address, prefix: v6?.prefix ?? null, apply: apply.how });
    return { id: a.id, ipv6: !!on, prefix: v6?.prefix ?? null, address: v6?.address ?? null, apply: apply.how };
  } finally {
    busy.delete(a.vmid);
  }
}

// ---- Lifecycle hooks -------------------------------------------------------------------------------

/** After a reinstall (the VM is recreated): put the server's public addresses back. */
export async function applyRecordedIps(path, vmid, { onlyMissing = false } = {}) {
  const rows = db.prepare("SELECT a.*, p.* , a.id AS aid FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.vmid = ? AND a.state = 'assigned'").all(vmid);
  if (!rows.length) return;
  const type = /\/lxc\//.test(path) ? 'lxc' : 'qemu';
  for (const r of rows) {
    const cfg = await pve.get(`${path}/config`);
    const v6 = r.ipv6_on ? v6Of(r, r.address) : null;
    const n = Number(r.nic.slice(3));
    // after a rollback: only what the snapshot lacked (the card, or its IPv6 state)
    const carried = type === 'lxc' ? cfg[r.nic] : (cfg[`ipconfig${n}`] ?? (Object.values(cfg).some((v) => typeof v === 'string' && /cloudinit/.test(v)) ? '' : null));
    const v6Matches = carried === null || /(^|,)ip6=/.test(carried ?? '') === !!v6;
    if (onlyMissing && cfg[r.nic] !== undefined && v6Matches) continue;
    const apply = await configureNic(path, type, cfg, n, r.address, { ...r, id: r.pool_id }, r.mac, v6);
    db.prepare('UPDATE ip_addresses SET mac = ?, apply = ? WHERE id = ?').run(apply.mac, apply.how === 'restart' ? 'live' : apply.how, r.aid);
  }
}

/** A server destroyed by the panel: its addresses cool down. */
export function releaseIpsOfDeletedServer(vmid) {
  // remove reverse DNS in the background (best effort): the next holder starts clean
  for (const r of db.prepare("SELECT a.*, p.reverse_zone, p.cidr, p.ipv6_cidr, p.ipv6_gateway, p.ipv6_reverse_zone FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.vmid = ? AND a.state = 'assigned' AND (a.ptr IS NOT NULL OR a.ipv6_ptr IS NOT NULL)").all(vmid)) {
    if (r.ptr) pushPtr(r.address, r.reverse_zone, null).catch(() => {});
    if (r.ipv6_ptr) pushPtr6(r, null).catch(() => {});
  }
  db.prepare("UPDATE ip_addresses SET state = 'cooldown', user_id = NULL, vmid = NULL, nic = NULL, mac = NULL, ptr = NULL, ipv6_on = 0, ipv6_ptr = NULL, apply = NULL, released_at = ? WHERE vmid = ? AND state = 'assigned'")
    .run(new Date().toISOString(), vmid);
}

/** Billing: public addresses of a server (IPv4, and IPv6 /64s switched on) and their monthly price. */
export function ipsOfServer(vmid) {
  const rows = db.prepare("SELECT a.address, a.ipv6_on, p.cidr, p.ipv6_cidr, p.price_monthly, p.ipv6_price_monthly FROM ip_addresses a JOIN ip_pools p ON p.id = a.pool_id WHERE a.vmid = ? AND a.state = 'assigned' ORDER BY a.id").all(vmid);
  return rows.flatMap((r) => [
    { address: r.address, monthly: r.price_monthly, family: 4 },
    ...(r.ipv6_on && r.ipv6_cidr ? [{ address: v6Of(r, r.address).prefix, monthly: r.ipv6_price_monthly, family: 6 }] : []),
  ]);
}

/** Resource pools: assigned public addresses of these customers. */
export function publicIpsOfUsers(ids) {
  if (!ids.length) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM ip_addresses WHERE state = 'assigned' AND user_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
}
