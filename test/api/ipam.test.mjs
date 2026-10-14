// Public IPv4: pools, assignment (cloud-init and manual), anti-spoofing IP filter,
// limits, reverse DNS via PowerDNS, release and cool-down, reinstall, billing,
// server deletion and unassignment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let rina;
let app01;                // created by rina (cloud-init image)
let poolId;
let pdns;
const pdnsCalls = [];
const ips = {};
const DAY = 86_400_000;
const AUTH = { authorization: 'PVEAPIToken=panel@pve!panel=x' };
const pveGet = async (p) => (await (await fetch(`${stack.mock.url}/api2/json${p}`, { headers: AUTH })).json()).data;
const cfgOf = (vmid) => pveGet(`/nodes/pve1/qemu/${vmid}/config`);
const ipset = (vmid, n) => pveGet(`/nodes/pve1/qemu/${vmid}/firewall/ipset/ipfilter-net${n}`);
const addresses = async (q = '') => (await admin.get(`/api/admin/ipam/pools/${poolId}/addresses${q}`)).json;
const stop = async (s, vmid) => {
  await s.post(`/api/vms/${vmid}/power/stop`);
  await waitFor(async () => ((await s.get(`/api/vms/${vmid}`)).json.status === 'stopped' ? true : null), { what: `server ${vmid} stopped` });
};

before(async () => {
  pdns = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      pdnsCalls.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body: raw ? JSON.parse(raw) : null });
      res.writeHead(req.headers['x-api-key'] === 'pdns-key' ? 204 : 401); res.end();
    });
  });
  await new Promise((r) => pdns.listen(0, '127.0.0.1', r));
  stack = await startStack();
  admin = await stack.adminSession();
  await stack.offerTemplates();
  rina = await stack.customerWith('rina@example.com', { limits: {} });
  await admin.put('/api/admin/vms/101', { userId: rina.userId, label: 'web-prod' });       // no cloud-init
  const r = await rina.post('/api/vms', { hostname: 'app-01', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123' });
  assert.equal(r.status, 202, r.text);
  app01 = r.json.vmid;
  assert.equal((await stack.serverSettled(rina, app01)).state, 'ready');
});
after(async () => { await stack?.stop(); await new Promise((r) => pdns?.close(r)); });

test('pools: subnet, gateway, bridge and VLAN are checked; addresses are created', async () => {
  const bad = (body) => admin.post('/api/admin/ipam/pools', { name: 'x', cidr: '203.0.113.0/29', gateway: '203.0.113.1', bridge: 'vmbr1', ...body });
  assert.equal((await bad({ cidr: '203.0.113.0/21' })).status, 400, 'too big');
  assert.equal((await bad({ cidr: '203.0.113.5/29' })).status, 400, 'not the network address');
  assert.equal((await bad({ gateway: '198.51.100.1' })).status, 400, 'gateway outside');
  assert.equal((await bad({ bridge: 'vmbr1; rm' })).status, 400);
  assert.equal((await bad({ vlan: 5000 })).status, 400);
  assert.equal((await bad({ reverseZone: 'example.com' })).status, 400);
  const r = await admin.post('/api/admin/ipam/pools', {
    name: 'Public A', cidr: '203.0.113.0/29', gateway: '203.0.113.1', bridge: 'vmbr1', vlan: 40, dns: ['1.1.1.1'],
    priceMonthly: 50_000, reverseZone: '113.0.203.in-addr.arpa',
  });
  assert.equal(r.status, 201, r.text);
  poolId = r.json.id;
  assert.deepEqual([r.json.total, r.json.free, r.json.reserved], [6, 5, 1]);
  assert.equal((await admin.post('/api/admin/ipam/pools', { name: 'y', cidr: '203.0.113.4/30', gateway: '203.0.113.5', bridge: 'vmbr1' })).status, 409, 'overlap');
  const list = await addresses();
  assert.deepEqual(list.map((a) => a.address), ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4', '203.0.113.5', '203.0.113.6']);
  assert.equal(list[0].state, 'reserved');
  assert.equal((await admin.put(`/api/admin/ipam/addresses/${list[0].id}`, { state: 'free' })).status, 409, 'the gateway stays reserved');
});

test('off until switched on; settings keep the PowerDNS key secret', async () => {
  assert.deepEqual((await rina.get(`/api/vms/${app01}/ips`)).json, { enabled: false });
  assert.equal((await rina.post(`/api/vms/${app01}/ips`)).status, 404);
  const s = await admin.put('/api/admin/settings/ipam', {
    enabled: true, maxPerServer: 2, cooldownHours: 24, powerdns: { url: `http://127.0.0.1:${pdns.address().port}`, apiKey: 'pdns-key' },
  });
  assert.equal(s.status, 200, s.text);
  assert.equal(JSON.stringify(s.json).includes('pdns-key'), false);
  assert.equal(s.json.powerdns.hasApiKey, true);
});

test('assign with cloud-init: a NIC on the pool bridge, ipconfig with the gateway, IP filter', async () => {
  const st = (await rina.get(`/api/vms/${app01}/ips`)).json;
  assert.equal(st.canAssign, true);
  assert.equal(st.priceMonthly, 50_000);
  const r = await rina.post(`/api/vms/${app01}/ips`);
  assert.equal(r.status, 201, r.text);
  ips.a = r.json;
  assert.deepEqual([r.json.address, r.json.prefix, r.json.netmask, r.json.gateway, r.json.apply, r.json.nic],
    ['203.0.113.2', 29, '255.255.255.248', '203.0.113.1', 'restart', 'net1']);
  const cfg = await cfgOf(app01);
  assert.match(cfg.net1, /^virtio=[0-9A-F:]{17},bridge=vmbr1,tag=40,firewall=1$/);
  assert.equal(cfg.ipconfig1, 'ip=203.0.113.2/29,gw=203.0.113.1');
  assert.equal(cfg.nameserver, '1.1.1.1');
  assert.equal(r.json.mac, /=([0-9A-F:]{17})/.exec(cfg.net1)[1]);
  assert.deepEqual(await ipset(app01, 1), [{ cidr: '203.0.113.2/32' }]);
});

test('without cloud-init the customer sets the address by hand; limits per server and per pool', async () => {
  const r = await rina.post('/api/vms/101/ips');
  assert.equal(r.status, 201, r.text);
  ips.b = r.json;
  assert.equal(r.json.apply, 'manual');
  const cfg = await cfgOf(101);
  assert.match(cfg.net1, /bridge=vmbr1,tag=40/);
  assert.equal(cfg.ipconfig1, undefined);

  ips.c = (await rina.post(`/api/vms/${app01}/ips`)).json;
  assert.equal(ips.c.nic, 'net2');
  const third = await rina.post(`/api/vms/${app01}/ips`);
  assert.equal(third.status, 409);
  assert.match(third.json.error, /at most 2 public addresses/);

  const pool = (await admin.post('/api/admin/pools', { name: 'Rina', maxPublicIps: 3 })).json;
  await admin.put(`/api/admin/pools/${pool.id}/members/${rina.userId}`);
  const over = await rina.post('/api/vms/101/ips');
  assert.equal(over.status, 409);
  assert.match(over.json.error, /resource pool "Rina": 0 public IPv4/);
  await admin.put(`/api/admin/pools/${pool.id}`, { maxPublicIps: null });
});

test('reverse DNS goes to PowerDNS', async () => {
  assert.equal((await rina.put(`/api/ips/${ips.a.id}/ptr`, { hostname: 'not a host' })).status, 400);
  const r = await rina.put(`/api/ips/${ips.a.id}/ptr`, { hostname: 'web.example.com' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.published, true);
  const call = pdnsCalls.at(-1);
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url, '/api/v1/servers/localhost/zones/113.0.203.in-addr.arpa.');
  assert.equal(call.key, 'pdns-key');
  assert.deepEqual(call.body.rrsets[0], { name: '2.113.0.203.in-addr.arpa.', type: 'PTR', ttl: 3600, changetype: 'REPLACE', records: [{ content: 'web.example.com.', disabled: false }] });
});

test('release: NIC, ipconfig and IP filter go; the address cools down before reuse', async () => {
  assert.equal((await rina.del(`/api/ips/${ips.c.id}`)).status, 200);
  const cfg = await cfgOf(app01);
  assert.equal(cfg.net2, undefined);
  assert.equal(cfg.ipconfig2, undefined);
  assert.equal((await pveGet(`/nodes/pve1/qemu/${app01}/firewall/ipset`)).some((x) => x.name === 'ipfilter-net2'), false);
  assert.equal((await addresses('?state=cooldown'))[0].address, ips.c.address);
  const next = await rina.post(`/api/vms/${app01}/ips`);
  assert.notEqual(next.json.address, ips.c.address, 'not handed out again during the cool-down');
  ips.c = next.json;
  const cooling = (await addresses('?state=cooldown'))[0];
  assert.equal((await admin.put(`/api/admin/ipam/addresses/${cooling.id}`, { state: 'free' })).json.state, 'free');
});

test('reinstall puts the addresses back with the same MAC', async () => {
  await stop(rina, app01);
  const r = await rina.post(`/api/vms/${app01}/reinstall`, { templateId: 9000, username: 'ops', password: 'a-long-password-1' });
  assert.equal(r.status, 202, r.text);
  await waitFor(async () => ((await rina.get(`/api/vms/${app01}`)).json.state === 'ready' ? true : null), { what: 'reinstalled', timeout: 60_000 });
  const cfg = await cfgOf(app01);
  assert.equal(cfg.net1, `virtio=${ips.a.mac},bridge=vmbr1,tag=40,firewall=1`);
  assert.equal(cfg.ipconfig1, 'ip=203.0.113.2/29,gw=203.0.113.1');
  assert.deepEqual(await ipset(app01, 1), [{ cidr: '203.0.113.2/32' }]);
});

test('public addresses are billed with their server', async () => {
  await admin.put('/api/admin/settings/billing', { enabled: true, taxRate: 11, bank: { enabled: true, instructions: 'BCA 123' } });
  await admin.put('/api/admin/vms/101/expiry', { expiresAt: new Date(Date.now() + 10 * DAY).toISOString() });
  const inv = (await rina.post('/api/billing/renewals', { vmid: 101, months: 1 })).json;
  assert.deepEqual(inv.lines.map((l) => [l.description, l.amount]).slice(1), [[`Public IPv4: ${ips.b.address} · 1 month`, 50_000]]);
});

test('privacy; deleting a server releases its addresses; unassigning holds them', async () => {
  const bob = await stack.customerWith('bob@example.com', { limits: {} });
  assert.equal((await bob.get(`/api/vms/${app01}/ips`)).status, 404);
  assert.equal((await bob.del(`/api/ips/${ips.a.id}`)).status, 404);
  assert.equal((await bob.put(`/api/ips/${ips.a.id}/ptr`, { hostname: 'evil.example.com' })).status, 404);

  await stop(rina, app01).catch(() => {});
  pdnsCalls.length = 0;
  assert.equal((await rina.del(`/api/vms/${app01}`)).status, 202);
  await waitFor(async () => ((await addresses('?state=assigned')).some((a) => a.vmid === app01) ? null : true), { what: 'released' });
  const a = (await addresses()).find((x) => x.address === '203.0.113.2');
  assert.equal(a.state, 'cooldown');
  await waitFor(() => (pdnsCalls.some((c) => c.body?.rrsets?.[0]?.changetype === 'DELETE') ? true : null), { what: 'PTR removed' });

  assert.equal((await admin.del('/api/admin/vms/101')).status < 300, true);
  const held = (await addresses('?state=held'))[0];
  assert.equal(held.address, ips.b.address);
  assert.match(held.note, /left the panel/);
  assert.equal((await admin.del(`/api/admin/ipam/pools/${poolId}`)).status, 409, 'a held address keeps the pool');
  assert.equal((await admin.put(`/api/admin/ipam/addresses/${held.id}`, { state: 'free' })).json.state, 'free');
});
