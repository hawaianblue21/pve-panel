// Several Proxmox clusters: connecting one (test, conflicts, TLS settings), guests
// from both, power actions and new servers routed to the right cluster, VMIDs
// unique across clusters, placement per image, networks per cluster, an
// unreachable cluster, disable and remove.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';
import { startMockPve } from '../support/mock-pve.mjs';

let stack;
let second;
let clash;
let admin;
let rina;
let clusterId;
let remoteVmid;            // a server rina created on the second cluster
const conn = () => ({ url: second.url, tokenId: 'panel@pve!panel', tokenSecret: 'x', verifyTls: true });

before(async () => {
  second = await startMockPve({ second: true });
  clash = await startMockPve();              // same node names as the main cluster
  stack = await startStack();
  admin = await stack.adminSession();
  await stack.offerTemplates();
  rina = await stack.customerWith('rina@example.com', { limits: {} });
});
after(async () => { await stack?.stop(); await second?.close(); await clash?.close(); });

test('testing a connection: version, nodes, conflicts; a wrong secret or repeated node names fail', async () => {
  const t = (await admin.post('/api/admin/clusters/test', conn())).json;
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.version, '9.0.10');
  assert.deepEqual(t.nodes.map((n) => n.node), ['pve3']);
  assert.deepEqual(t.vmidConflicts.map((x) => x.vmid), [102]);
  assert.equal(t.templates, 1);
  const bad = (await admin.post('/api/admin/clusters/test', { ...conn(), tokenSecret: 'wrong' })).json;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /refused/);
  const twin = (await admin.post('/api/admin/clusters/test', { ...conn(), url: clash.url })).json;
  assert.equal(twin.ok, false);
  assert.match(twin.error, /unique across clusters: pve1/);
  assert.equal((await admin.post('/api/admin/clusters', { key: 'twin', name: 'Twin', ...conn(), url: clash.url })).status, 409);
});

test('connect a cluster: its guests appear, a VMID used twice is left out and reported', async () => {
  assert.equal((await admin.post('/api/admin/clusters', { key: 'main', name: 'X', ...conn() })).status, 400);
  const r = await admin.post('/api/admin/clusters', { key: 'dc3', name: 'Jakarta DC3', ...conn() });
  assert.equal(r.status, 201, r.text);
  clusterId = r.json.id;
  const c = (await admin.get('/api/admin/clusters')).json;
  assert.deepEqual(c.clusters.map((x) => [x.key, x.reachable, x.nodes.join(',')]), [['main', true, 'pve1,pve2'], ['dc3', true, 'pve3']]);
  assert.deepEqual(c.collisions.map((x) => [x.vmid, x.clusterName]), [[102, 'Jakarta DC3']]);
  const all = (await admin.get('/api/admin/vms')).json;
  assert.ok(all.some((v) => v.vmid === 201), 'guest of the new cluster');
  assert.equal(all.find((v) => v.vmid === 102).name, 'other-customer', 'the main cluster keeps 102');
  const h = (await admin.get('/api/admin/hosts')).json;
  assert.equal(h.nodes.find((n) => n.node === 'pve3').clusterName, 'Jakarta DC3');
  assert.equal(JSON.stringify(c).includes('"x"'), false, 'the token secret is never shown');
});

test('power actions go to the cluster that has the server', async () => {
  await admin.put('/api/admin/vms/201', { userId: rina.userId, label: 'remote-web' });
  const r = await rina.post('/api/vms/201/power/start');
  assert.ok([200, 202].includes(r.status), r.text);
  await waitFor(() => (second.vms.get(201).status === 'running' ? true : null), { what: 'started on the second cluster' });
  assert.equal(stack.mock.vms.has(201), false);
});

test('new servers: cloned in the image\'s cluster, VMIDs unique across clusters, network on each cluster', async () => {
  await admin.put('/api/admin/templates/9200', { label: 'Debian 12 (DC3)' });
  const mk = (templateId, extra = {}) => rina.post('/api/vms', { hostname: `s${templateId}`, templateId, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123', ...extra });
  const a = await mk(9000);
  assert.equal(a.status, 202, a.text);
  await stack.serverSettled(rina, a.json.vmid);
  assert.ok(stack.mock.vms.has(a.json.vmid));
  const b = await mk(9200);
  assert.equal(b.status, 202, b.text);
  assert.equal((await stack.serverSettled(rina, b.json.vmid)).state, 'ready');
  assert.ok(second.vms.has(b.json.vmid), 'cloned on the second cluster');
  remoteVmid = b.json.vmid;
  assert.equal(second.vms.get(b.json.vmid).node, 'pve3');
  assert.ok(!stack.mock.vms.has(b.json.vmid) && b.json.vmid !== a.json.vmid, 'free in both clusters');
  assert.ok(stack.mock.sdn.vnets.some((v) => v.vnet === 'cu0001'));
  assert.ok(second.sdn.vnets.some((v) => v.vnet === 'cu0001'), 'the same customer network on the second cluster');
  assert.match(second.vms.get(b.json.vmid).cfg.net0, /bridge=cu0001/);

  // a datacenter spanning both clusters: each image only on its own cluster's nodes
  const dc = (await admin.post('/api/admin/datacenters', { key: 'jkt', name: 'Jakarta', nodes: ['pve3'] })).json;
  const wrong = await mk(9000, { datacenterId: dc.id });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /Debian 12 is not available in Jakarta/);
});

test('an unreachable cluster: alert and last known nodes; disable and remove rules', async () => {
  const port = Number(new URL(second.url).port);
  await second.close();
  const h = (await admin.get('/api/admin/hosts')).json;
  assert.deepEqual(h.clusters.map((c) => [c.name, c.reachable]), [['Main', true], ['Jakarta DC3', false]]);
  const p3 = h.nodes.find((n) => n.node === 'pve3');
  assert.equal(p3.online, false);
  assert.equal(p3.clusterName, 'Jakarta DC3');
  const d = (await admin.get('/api/admin/dashboard')).json;
  assert.ok(d.alerts.some((x) => x.title === 'Cluster Jakarta DC3 unreachable'));
  assert.ok((await admin.get('/api/admin/vms')).json.some((v) => v.vmid === 101), 'the main cluster still works');

  second = await startMockPve({ second: true, port });
  assert.equal((await admin.del(`/api/admin/clusters/${clusterId}`)).status, 409, 'panel servers run there');
  assert.equal((await admin.put(`/api/admin/clusters/${clusterId}`, { enabled: false })).json.enabled, false);
  assert.equal((await admin.get('/api/admin/vms')).json.find((v) => v.vmid === 201).status, 'missing', 'disabled: not reachable from the panel');
  // its servers are not dropped from the panel while the cluster is out of sight
  const del = await rina.del(`/api/vms/${remoteVmid}`);
  assert.equal(del.status, 409, del.text);
  assert.match(del.json.error, /clusters is unreachable or disabled/);
  assert.ok((await rina.get('/api/vms')).json.some((v) => v.vmid === remoteVmid), 'still listed for the customer');
  const ops = await admin.get('/api/admin/activity?q=cluster');
  assert.ok(ops.json.events.some((e) => e.action === 'admin_cluster_added'));
});
