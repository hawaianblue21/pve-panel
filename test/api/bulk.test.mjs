// Servers tab: bulk actions (power, assign, unassign) and the richer server list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let lena;
const vms = async () => (await admin.get('/api/admin/vms')).json;
const guest = (vmid) => stack.mock.vms.get(vmid);

before(async () => {
  stack = await startStack();
  admin = await stack.adminSession();
  lena = await stack.customerWith('lena@example.com', { limits: {} });
});
after(async () => { await stack?.stop(); });

test('the list carries cluster and size for grouping', async () => {
  const v = (await vms()).find((x) => x.vmid === 101);
  assert.deepEqual([v.cluster, v.cores, v.memoryMb, v.diskGb], ['Main', 2, 4096, 20]);
});

test('bulk assign adopts several guests at once; templates and the VPN gateway are refused', async () => {
  assert.equal((await admin.post('/api/admin/vms/bulk', { action: 'assign', vmids: [101] })).status, 400, 'customer needed');
  const r = await admin.post('/api/admin/vms/bulk', { action: 'assign', vmids: [101, 102, 150, 9000, 4242], userId: lena.userId });
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.results.map((x) => [x.vmid, x]));
  assert.equal(by[101].ok, true);
  assert.equal(by[102].ok, true);
  assert.match(by[150].error, /protected/);
  assert.equal(by[9000].ok, false, 'templates are no servers');
  assert.equal(by[4242].ok, false);
  assert.equal(r.json.done, 2);
  const list = await vms();
  assert.deepEqual(list.filter((x) => x.userId === lena.userId).map((x) => x.vmid), [101, 102]);
  assert.deepEqual((await lena.get('/api/vms')).json.map((x) => x.vmid).sort(), [101, 102]);
  const again = await admin.post('/api/admin/vms/bulk', { action: 'assign', vmids: [101], userId: lena.userId });
  assert.equal(again.json.results[0].skipped, 'already assigned');
});

test('bulk power: running servers are shut down, stopped ones skipped; read-only admins are refused', async () => {
  assert.equal(guest(102).status, 'running');
  const r = await admin.post('/api/admin/vms/bulk', { action: 'shutdown', vmids: [101, 102] });
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.results.map((x) => [x.vmid, x]));
  assert.equal(by[101].skipped, 'not running');
  assert.equal(by[102].ok, true);
  await waitFor(() => (guest(102).status === 'stopped' ? true : null), { what: '102 stopped' });
  const start = await admin.post('/api/admin/vms/bulk', { action: 'start', vmids: [101, 102] });
  assert.equal(start.json.done, 2);
  await waitFor(() => (guest(101).status === 'running' && guest(102).status === 'running' ? true : null), { what: 'both running' });

  const u = await admin.post('/api/admin/users', { email: 'ro@example.com', password: 'readonly-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((x) => x.key === 'support').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  const ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'ro@example.com', password: 'readonly-password-1' });
  assert.equal((await ro.post('/api/admin/vms/bulk', { action: 'stop', vmids: [101] })).status, 403);
});

test('bulk unassign: the servers keep running, the customer no longer sees them', async () => {
  const r = await admin.post('/api/admin/vms/bulk', { action: 'unassign', vmids: [102, 9000] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.results.find((x) => x.vmid === 9000).skipped, 'not assigned');
  assert.deepEqual((await lena.get('/api/vms')).json.map((x) => x.vmid), [101]);
  assert.equal(guest(102).status, 'running');
});
