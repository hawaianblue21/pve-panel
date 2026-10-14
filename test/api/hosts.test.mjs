// Hosts and the admin dashboard: node load, version and last snapshot, alerts,
// what each role sees, and maintenance mode keeping new servers off a node.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
const AUTH = { authorization: 'PVEAPIToken=panel@pve!panel=x' };
const mock = (p) => fetch(`${stack.mock.url}/api2/json${p}`, { headers: AUTH });
const nodeOfVm = async (vmid) => (await (await mock('/cluster/resources?type=vm')).json()).data.find((g) => g.vmid === vmid)?.node;

before(async () => {
  stack = await startStack();
  admin = await stack.adminSession();
  await stack.offerTemplates();
});
after(async () => { await stack?.stop(); });

test('hosts: load, memory, storage, version, kernel, guests per node', async () => {
  const h = (await admin.get('/api/admin/hosts')).json;
  assert.deepEqual(h.cluster, { name: 'mock-cluster', quorate: true, nodes: 2 });
  assert.deepEqual(h.nodes.map((n) => n.node), ['pve1', 'pve2']);
  const p1 = h.nodes[0];
  assert.equal(p1.online, true);
  assert.equal(p1.pveVersion, '9.0.10');
  assert.equal(p1.kernel, '6.14.8-2-pve');
  assert.match(p1.cpuModel, /EPYC/);
  assert.equal(p1.cores, 64);
  assert.equal(p1.memTotal, 256 * 2 ** 30);
  assert.deepEqual(p1.storage.map((s) => s.storage), ['VMStorage', 'local-lvm']);
  assert.equal(p1.guests, 3, '101, 102 and the VPN gateway (templates not counted)');
  assert.equal(p1.maintenance, false);
});

test('an unreachable node shows its last snapshot and raises an alert', async () => {
  await mock('/__nodestate/pve2/offline');
  const h = (await admin.get('/api/admin/hosts')).json;
  const p2 = h.nodes.find((n) => n.node === 'pve2');
  assert.equal(p2.online, false);
  assert.equal(p2.stale, true);
  assert.equal(p2.memTotal, 256 * 2 ** 30, 'from the last snapshot');
  assert.ok(p2.lastSeen);
  const d = (await admin.get('/api/admin/dashboard')).json;
  assert.ok(d.alerts.some((a) => a.level === 'bad' && a.title === 'pve2 unreachable'));
  assert.deepEqual(d.kpis.nodes, { total: 2, online: 1, maintenance: 0 });
  await mock('/__nodestate/pve2/online');
});

test('dashboard: KPIs and alerts for the owner', async () => {
  const d = (await admin.get('/api/admin/dashboard')).json;
  assert.equal(d.kpis.guests.total, 3);
  assert.equal(d.kpis.guests.running, 2);
  assert.ok(d.alerts.some((a) => a.title === 'pve2 memory at 90%'));
  assert.ok(d.alerts.some((a) => /^Storage VMStorage on pve2 at 91%/.test(a.title)));
  assert.ok('billing' in d.kpis && 'tickets' in d.kpis);
  assert.ok(Array.isArray(d.activity) && d.activity.length > 0);
});

test('each role sees only its part of the dashboard; maintenance needs hosts.write', async () => {
  const role = await admin.post('/api/admin/rbac/roles', { key: 'nodes-only', name: 'Nodes only', permissions: ['servers.read'] });
  assert.equal(role.status, 201, role.text);
  const u = await admin.post('/api/admin/users', { email: 'ops@example.com', password: 'ops-password-123', isAdmin: true });
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role.json.id });
  const ops = stack.admin();
  await ops.post('/api/auth/login', { email: 'ops@example.com', password: 'ops-password-123' });
  const d = (await ops.get('/api/admin/dashboard')).json;
  assert.ok(d.kpis.guests);
  assert.equal(d.kpis.billing, undefined);
  assert.equal(d.kpis.tickets, undefined);
  assert.equal(d.activity, undefined);
  assert.equal((await ops.put('/api/admin/hosts/pve1/maintenance', { maintenance: true })).status, 403);
});

test('maintenance mode: new servers go to another node of the datacenter', async () => {
  const dc = await admin.post('/api/admin/datacenters', { key: 'dc1', name: 'DC 1', nodes: ['pve1', 'pve2'] });
  assert.equal(dc.status, 201, dc.text);
  const rina = await stack.customerWith('rina@example.com', { limits: {} });
  const m = await admin.put('/api/admin/hosts/pve1/maintenance', { maintenance: true, note: 'RAM swap' });
  assert.deepEqual(m.json, { node: 'pve1', maintenance: true, note: 'RAM swap' });
  assert.equal((await admin.get('/api/admin/hosts')).json.nodes[0].note, 'RAM swap');

  const r = await rina.post('/api/vms', { hostname: 'app-01', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123', datacenterId: dc.json.id });
  assert.equal(r.status, 202, r.text);
  await stack.serverSettled(rina, r.json.vmid);
  assert.equal(await nodeOfVm(r.json.vmid), 'pve2', 'not on the node in maintenance');

  await admin.put('/api/admin/hosts/pve2/maintenance', { maintenance: true });
  const none = await rina.post('/api/vms', { hostname: 'app-02', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123', datacenterId: dc.json.id });
  assert.equal(none.status, 409);
  assert.match(none.json.error, /No host in DC 1 takes new servers/);
  await admin.put('/api/admin/hosts/pve1/maintenance', { maintenance: false });
  await admin.put('/api/admin/hosts/pve2/maintenance', { maintenance: false });
  const ev = (await admin.get('/api/admin/activity?q=maintenance')).json.events;
  assert.ok(ev.some((e) => e.action === 'admin_node_maintenance_on'));
});
