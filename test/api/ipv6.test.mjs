// IPv6 (optional): a pool's IPv6 prefix, one /64 per IPv4 address, the global switch,
// per-address on/off with cloud-init, IP filter, reverse DNS (ip6.arpa), billing,
// reinstall and release.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let rina;
let app01;
let poolId;
let pdns;
let ip;
const pdnsCalls = [];
const DAY = 86_400_000;
const AUTH = { authorization: 'PVEAPIToken=panel@pve!panel=x' };
const pveGet = async (p) => (await (await fetch(`${stack.mock.url}/api2/json${p}`, { headers: AUTH })).json()).data;
const cfgOf = (vmid) => pveGet(`/nodes/pve1/qemu/${vmid}/config`);
const ipset = (vmid, n) => pveGet(`/nodes/pve1/qemu/${vmid}/firewall/ipset/ipfilter-net${n}`);
const mine = async () => (await rina.get(`/api/vms/${app01}/ips`)).json;

before(async () => {
  pdns = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { pdnsCalls.push({ url: req.url, body: raw ? JSON.parse(raw) : null }); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => pdns.listen(0, '127.0.0.1', r));
  stack = await startStack();
  admin = await stack.adminSession();
  await stack.offerTemplates();
  rina = await stack.customerWith('rina6@example.com', { limits: {} });
  const r = await rina.post('/api/vms', { hostname: 'app-01', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123' });
  assert.equal(r.status, 202, r.text);
  app01 = r.json.vmid;
  assert.equal((await stack.serverSettled(rina, app01)).state, 'ready');
  await admin.put('/api/admin/settings/ipam', { enabled: true, powerdns: { url: `http://127.0.0.1:${pdns.address().port}`, apiKey: 'k' } });
});
after(async () => { await stack?.stop(); await new Promise((r) => pdns?.close(r)); });

test('pool IPv6 prefix: size, network address, gateway, reverse zone and overlaps are checked', async () => {
  const base = { name: 'V6 A', cidr: '198.51.100.0/29', gateway: '198.51.100.1', bridge: 'vmbr1' };
  const bad = async (v6, re) => {
    const r = await admin.post('/api/admin/ipam/pools', { ...base, ...v6 });
    assert.equal(r.status, 400, JSON.stringify(v6));
    if (re) assert.match(r.json.error, re);
  };
  await bad({ ipv6Cidr: '2001:db8:100::/62', ipv6Gateway: 'fe80::1' }, /\/61 or larger/);
  await bad({ ipv6Cidr: '2001:db8:100::1/56', ipv6Gateway: 'fe80::1' }, /not the network address/);
  await bad({ ipv6Cidr: '2001:db8:100::/56', ipv6Gateway: '2001:db8:100:5::1' }, /first \/64/);
  await bad({ ipv6Cidr: '2001:db8:100::/56', ipv6Gateway: 'nope' });
  await bad({ ipv6Cidr: '2001:db8:::/56', ipv6Gateway: 'fe80::1' });
  await bad({ ipv6Cidr: '2001:db8:100::/56', ipv6Gateway: 'fe80::1', ipv6ReverseZone: 'example.com' });
  await bad({ ipv6Cidr: '2001:db8:100::/56', ipv6Gateway: 'fe80::1', ipv6ReverseZone: '0.0.2.0.8.b.d.0.1.0.0.2.ip6.arpa' }, /must cover/);
  const r = await admin.post('/api/admin/ipam/pools', {
    ...base, ipv6Cidr: '2001:0db8:0100:0000::/56', ipv6Gateway: 'FE80::1', ipv6ReverseZone: '0.0.1.0.8.b.d.0.1.0.0.2.ip6.arpa', ipv6PriceMonthly: 10_000, priceMonthly: 40_000,
  });
  assert.equal(r.status, 201, r.text);
  poolId = r.json.id;
  assert.deepEqual(r.json.ipv6, { cidr: '2001:db8:100::/56', gateway: 'fe80::1', reverseZone: '0.0.1.0.8.b.d.0.1.0.0.2.ip6.arpa.', priceMonthly: 10_000 });
  const o = await admin.post('/api/admin/ipam/pools', { name: 'V6 B', cidr: '198.51.100.8/29', gateway: '198.51.100.9', bridge: 'vmbr1', ipv6Cidr: '2001:db8:100:80::/57', ipv6Gateway: 'fe80::1' });
  assert.equal(o.status, 409);
  assert.match(o.json.error, /IPv6 prefix overlaps/);
});

test('off by default: the /64 is shown as available but can\'t be switched on', async () => {
  const a = await rina.post(`/api/vms/${app01}/ips`);
  assert.equal(a.status, 201, a.text);
  ip = a.json;
  assert.equal(ip.address, '198.51.100.2');
  assert.deepEqual(ip.ipv6, { available: true, on: false, prefix: '2001:db8:100:2::/64', address: '2001:db8:100:2::1', bits: 64, gateway: 'fe80::1', ptr: null, monthly: 10_000 });
  assert.equal((await mine()).ipv6Enabled, false);
  assert.equal((await rina.put(`/api/ips/${ip.id}/ipv6`, { enabled: true })).status, 404);
  assert.equal((await rina.put(`/api/ips/${ip.id}/ptr`, { hostname: 'v6.example.com', family: 6 })).status, 409, 'no PTR while IPv6 is off');
});

test('switched on: cloud-init ip6/gw6 on the same card, the /64 in the IP filter', async () => {
  assert.equal((await admin.put('/api/admin/settings/ipam', { ipv6Enabled: true })).json.ipv6Enabled, true);
  assert.equal((await mine()).ipv6Enabled, true);
  const r = await rina.put(`/api/ips/${ip.id}/ipv6`, { enabled: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.ipv6, r.json.prefix, r.json.address, r.json.apply], [true, '2001:db8:100:2::/64', '2001:db8:100:2::1', 'restart']);
  const cfg = await cfgOf(app01);
  assert.equal(cfg.ipconfig1, 'ip=198.51.100.2/29,gw=198.51.100.1,ip6=2001:db8:100:2::1/64,gw6=fe80::1');
  assert.equal(cfg.net1, `virtio=${ip.mac},bridge=vmbr1,firewall=1`, 'same card, same MAC');
  assert.deepEqual(await ipset(app01, 1), [{ cidr: '198.51.100.2/32' }, { cidr: '2001:db8:100:2::/64' }]);
  const a = (await mine()).addresses[0];
  assert.equal(a.ipv6.on, true);
  const row = (await (await admin.get(`/api/admin/ipam/pools/${poolId}/addresses?state=assigned`)).json)[0];
  assert.deepEqual(row.ipv6, { prefix: '2001:db8:100:2::/64', ptr: null });
  assert.equal((await (await admin.get('/api/admin/ipam')).json).pools.find((p) => p.id === poolId).ipv6On, 1);
});

test('reverse DNS for the IPv6 address goes to its ip6.arpa zone', async () => {
  const r = await rina.put(`/api/ips/${ip.id}/ptr`, { hostname: 'v6.example.com', family: 6 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.published, true);
  const call = pdnsCalls.at(-1);
  assert.equal(call.url, '/api/v1/servers/localhost/zones/0.0.1.0.8.b.d.0.1.0.0.2.ip6.arpa.');
  assert.equal(call.body.rrsets[0].name, '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.1.0.8.b.d.0.1.0.0.2.ip6.arpa.');
  assert.equal(call.body.rrsets[0].records[0].content, 'v6.example.com.');
  assert.equal((await mine()).addresses[0].ipv6.ptr, 'v6.example.com');
});

test('the prefix of a pool in use is locked; price and zone can change', async () => {
  const lock = await admin.put(`/api/admin/ipam/pools/${poolId}`, { ipv6Cidr: '2001:db8:200::/56' });
  assert.equal(lock.status, 409);
  assert.match(lock.json.error, /1 server uses IPv6/);
  assert.equal((await admin.put(`/api/admin/ipam/pools/${poolId}`, { ipv6Cidr: '' })).status, 409, 'can\'t be removed either');
  assert.equal((await admin.put(`/api/admin/ipam/pools/${poolId}`, { ipv6PriceMonthly: 12_000 })).json.ipv6.priceMonthly, 12_000);
});

test('the /64 is billed with the server, as its own line', async () => {
  await admin.put('/api/admin/settings/billing', { enabled: true, taxRate: 11, bank: { enabled: true, instructions: 'Bank transfer' } });
  await admin.put(`/api/admin/vms/${app01}/expiry`, { expiresAt: new Date(Date.now() + 10 * DAY).toISOString() });
  const inv = await rina.post('/api/billing/renewals', { vmid: app01, months: 1 });
  assert.equal(inv.status, 201, inv.text);
  const lines = inv.json.lines.map((l) => [l.description, l.amount]).slice(1);
  assert.deepEqual(lines, [['Public IPv4: 198.51.100.2 · 1 month', 40_000], ['IPv6: 2001:db8:100:2::/64 · 1 month', 12_000]]);
});

test('a reinstall keeps IPv6 on the card', async () => {
  await rina.post(`/api/vms/${app01}/power/stop`);
  await waitFor(async () => ((await rina.get(`/api/vms/${app01}`)).json.status === 'stopped' ? true : null), { what: 'stopped' });
  const r = await rina.post(`/api/vms/${app01}/reinstall`, { templateId: 9000, username: 'ops', password: 'a-long-password-1' });
  assert.equal(r.status, 202, r.text);
  await waitFor(async () => ((await rina.get(`/api/vms/${app01}`)).json.state === 'ready' ? true : null), { what: 'reinstalled', timeout: 60_000 });
  const cfg = await cfgOf(app01);
  assert.equal(cfg.ipconfig1, 'ip=198.51.100.2/29,gw=198.51.100.1,ip6=2001:db8:100:2::1/64,gw6=fe80::1');
  assert.deepEqual(await ipset(app01, 1), [{ cidr: '198.51.100.2/32' }, { cidr: '2001:db8:100:2::/64' }]);
});

test('switched off globally: nobody can switch it on, the owner can still switch it off', async () => {
  await admin.put('/api/admin/settings/ipam', { ipv6Enabled: false });
  const st = await mine();
  assert.equal(st.ipv6Enabled, false);
  assert.equal(st.addresses[0].ipv6.on, true, 'kept');
  pdnsCalls.length = 0;
  const off = await rina.put(`/api/ips/${ip.id}/ipv6`, { enabled: false });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.ipv6, false);
  const cfg = await cfgOf(app01);
  assert.equal(cfg.ipconfig1, 'ip=198.51.100.2/29,gw=198.51.100.1');
  assert.deepEqual(await ipset(app01, 1), [{ cidr: '198.51.100.2/32' }]);
  assert.equal(pdnsCalls[0]?.body.rrsets[0].changetype, 'DELETE', 'its PTR is removed');
  assert.equal((await rina.put(`/api/ips/${ip.id}/ipv6`, { enabled: true })).status, 404);
  const wrongZone = await admin.put(`/api/admin/ipam/pools/${poolId}`, { ipv6Cidr: '2001:db8:200::/56' });
  assert.equal(wrongZone.status, 400, 'the old reverse zone doesn\'t cover the new prefix');
  assert.match(wrongZone.json.error, /0\.0\.2\.0\.8\.b\.d\.0\.1\.0\.0\.2\.ip6\.arpa/);
  assert.equal((await admin.put(`/api/admin/ipam/pools/${poolId}`, { ipv6Cidr: '2001:db8:200::/56', ipv6ReverseZone: '' })).status, 200, 'unlocked again');
});

test('a rollback to a snapshot without IPv6 puts the switched-on /64 back', { timeout: 60_000 }, async () => {
  const snap = await rina.post(`/api/vms/${app01}/snapshots`, { name: 'nov6' });
  assert.equal(snap.status < 300, true, snap.text);
  await waitFor(async () => ((await rina.get(`/api/vms/${app01}/snapshots`)).json.some((x) => x.name === 'nov6') ? true : null), { what: 'snapshot' });
  await admin.put('/api/admin/settings/ipam', { ipv6Enabled: true });
  assert.equal((await rina.put(`/api/ips/${ip.id}/ipv6`, { enabled: true })).status, 200);
  assert.match((await cfgOf(app01)).ipconfig1, /ip6=/);
  assert.equal((await rina.post(`/api/vms/${app01}/snapshots/nov6/rollback`)).status < 300, true);
  await waitFor(async () => (/ip6=2001:db8:200:2::1\/64/.test((await cfgOf(app01)).ipconfig1 ?? '') ? true : null), { what: 'IPv6 back after rollback', timeout: 20_000 });
  assert.deepEqual(await ipset(app01, 1), [{ cidr: '198.51.100.2/32' }, { cidr: '2001:db8:200:2::/64' }]);
});

test('release clears IPv6; the address comes back without it', async () => {
  assert.equal((await mine()).addresses[0].ipv6.prefix, '2001:db8:200:2::/64');
  assert.equal((await rina.del(`/api/ips/${ip.id}`)).status, 200);
  const row = (await (await admin.get(`/api/admin/ipam/pools/${poolId}/addresses?state=cooldown`)).json)[0];
  assert.equal(row.ipv6, null);
  await admin.put(`/api/admin/ipam/addresses/${row.id}`, { state: 'free' });
  const bob = await stack.customerWith('bob6@example.com', { limits: {} });
  assert.equal((await bob.put(`/api/ips/${ip.id}/ipv6`, { enabled: true })).status, 404, 'not someone else\'s address');
});
