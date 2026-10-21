// Backups, stage 1: backup servers (test, connect, owners only), datastore figures,
// policies, plans, settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from '../support/stack.mjs';
import { startMockPbs, PBS_TOKEN, PBS_SECRET } from '../support/mock-pbs.mjs';

let stack;
let admin;
let pbs;
let operator;
const conn = () => ({ url: pbs.url, tokenId: PBS_TOKEN, tokenSecret: PBS_SECRET });

before(async () => {
  pbs = await startMockPbs();
  stack = await startStack();
  admin = await stack.adminSession();
  const u = await admin.post('/api/admin/users', { email: 'ops@example.com', password: 'operator-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((r) => r.key === 'operator').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  operator = stack.admin();
  await operator.post('/api/auth/login', { email: 'ops@example.com', password: 'operator-password-1' });
});
after(async () => { await stack?.stop(); await pbs?.close(); });

test('backups can\'t be switched on without a backup server', async () => {
  const r = await admin.put('/api/admin/backups/settings', { enabled: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Connect a Proxmox Backup Server first/);
});

test('connection test: a wrong secret is reported; the right one lists the datastores', async () => {
  const bad = await admin.post('/api/admin/backups/servers/test', { ...conn(), tokenSecret: 'nope' });
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /token was refused/);
  const ok = await admin.post('/api/admin/backups/servers/test', conn());
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  assert.equal(ok.json.version, '4.0.14');
  assert.deepEqual(ok.json.datastores.map((d) => d.name), ['ds-customer', 'ds-archive']);
});

test('only owners connect a backup server; name, datastore and clusters are checked', async () => {
  assert.equal((await operator.post('/api/admin/backups/servers', { name: 'pbs-jkt', ...conn(), datastore: 'ds-customer' })).status, 403);
  assert.equal((await admin.post('/api/admin/backups/servers', { name: 'PBS JKT', ...conn(), datastore: 'ds-customer' })).status, 400);
  assert.equal((await admin.post('/api/admin/backups/servers', { name: 'pbs-jkt', ...conn(), datastore: 'nope' })).status, 409);
  assert.equal((await admin.post('/api/admin/backups/servers', { name: 'pbs-jkt', ...conn(), datastore: 'ds-customer', clusters: [7] })).status, 400);
  const r = await admin.post('/api/admin/backups/servers', { name: 'pbs-jkt', ...conn(), datastore: 'ds-customer', clusters: [0] });
  assert.equal(r.status, 201, r.text);
  assert.equal(JSON.stringify(r.json).includes(PBS_SECRET), false, 'the secret never comes back');
  assert.equal((await admin.post('/api/admin/backups/servers', { name: 'pbs-jkt', ...conn(), datastore: 'ds-customer' })).status, 409, 'unique name');
});

test('overview: datastore figures from the backup server', async () => {
  const o = (await operator.get('/api/admin/backups')).json;
  const s = o.servers[0];
  assert.equal(s.status.reachable, true);
  assert.equal(s.status.dedup, 3.4);
  assert.equal(s.status.lastVerify.ok, true);
  assert.ok(s.status.used > 0 && s.status.total > s.status.used);
  assert.deepEqual(s.clusters, [0]);
});

test('policies: rules, plans and the default; operators manage them', async () => {
  const bad = (b) => operator.post('/api/admin/backups/policies', { name: 'x', frequency: 'daily', keepDaily: 7, ...b });
  assert.equal((await bad({ keepDaily: 0 })).status, 400, 'keeps nothing');
  assert.equal((await bad({ frequency: 'weekly' })).status, 400, 'weekly needs a day');
  assert.equal((await bad({ frequency: 'weekly', weekday: 0 })).status, 400, 'weekly keeps no daily');
  const daily = await operator.post('/api/admin/backups/policies', { name: 'Daily 7', frequency: 'daily', keepDaily: 7 });
  assert.equal(daily.status, 201, daily.text);
  const long = await operator.post('/api/admin/backups/policies', { name: 'Long', frequency: 'daily', keepDaily: 14, keepWeekly: 8, addonPrice: 25_000 });
  assert.equal(long.json.addonPrice, 25_000);
  assert.equal((await operator.post('/api/admin/backups/policies', { name: 'Daily 7', frequency: 'daily', keepDaily: 3 })).status, 409);

  const plan = (await admin.post('/api/admin/plans', { name: 'Business', cores: 2, memoryMb: 4096, diskGb: 40, priceMonthly: 200_000 })).json;
  assert.equal((await operator.put(`/api/admin/backups/plans/${plan.id}`, { policyId: daily.json.id })).status, 200);
  assert.equal((await operator.put(`/api/admin/backups/plans/${plan.id}`, { policyId: 999 })).status, 400);
  const o = (await admin.get('/api/admin/backups')).json;
  assert.deepEqual(o.policies.find((p) => p.name === 'Daily 7').plans.map((p) => p.name), ['Business']);
  assert.equal(o.plans.find((p) => p.id === plan.id).policyId, daily.json.id);
  assert.equal((await operator.del(`/api/admin/backups/policies/${daily.json.id}`)).status, 409, 'used by a plan');

  const s = await operator.put('/api/admin/backups/settings', { enabled: true, defaultPolicyId: long.json.id, windowStart: 1, windowEnd: 5 });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.enabled, true);
  assert.equal((await operator.put('/api/admin/backups/settings', { windowStart: 3, windowEnd: 3 })).status, 400);
  assert.equal((await operator.del(`/api/admin/backups/policies/${long.json.id}`)).status, 409, 'the default');
});

test('read-only administrators see backups but change nothing; servers can be disabled and removed', async () => {
  const u = await admin.post('/api/admin/users', { email: 'ro@example.com', password: 'readonly-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((r) => r.key === 'support').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  const ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'ro@example.com', password: 'readonly-password-1' });
  assert.equal((await ro.get('/api/admin/backups')).status, 200);
  assert.equal((await ro.put('/api/admin/backups/settings', { manualPerDay: 5 })).status, 403);

  const id = (await admin.get('/api/admin/backups')).json.servers[0].id;
  assert.equal((await admin.put(`/api/admin/backups/servers/${id}`, { enabled: false })).json.enabled, false);
  assert.equal((await admin.del(`/api/admin/backups/servers/${id}`)).json.removed, true);
  assert.equal((await admin.get('/api/admin/backups')).json.servers.length, 0);
});
