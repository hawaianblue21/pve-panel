// RBAC, datacenters, resource allocation pools, GPUs and object storage (SeaweedFS).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';
import { startMockSeaweed, ADMIN_AK, ADMIN_SK } from '../support/mock-seaweedfs.mjs';

let stack;
let admin;
let seaweed;

before(async () => {
  stack = await startStack();
  seaweed = await startMockSeaweed();
  admin = await stack.adminSession();
  await stack.offerTemplates();
});
after(async () => { await stack?.stop(); await seaweed?.close(); });

async function adminAs(email, role) {
  const password = 'admin-role-password-1';
  const r = await admin.post('/api/admin/users', { email, password, isAdmin: true, ...(role ? { adminRole: role } : {}) });
  assert.equal(r.status, 201, r.text);
  const s = stack.admin();
  const l = await s.post('/api/auth/login', { email, password });
  assert.equal(l.status, 200, l.text);
  s.userId = r.json.id;
  return s;
}

const createBody = (extra = {}) => ({
  hostname: 'app', templateId: 9000, cores: 2, memoryMb: 2048, diskGb: 10, username: 'u', password: 'supersecret-123', ...extra,
});

// ---- RBAC -------------------------------------------------------------------------

test('RBAC: the first administrator is an owner with every permission', async () => {
  const me = (await admin.get('/api/admin/me')).json;
  assert.equal(me.role.key, 'owner');
  assert.ok(me.permissions.includes('rbac.write'));
  assert.ok(me.permissions.includes('gpu.write'));
});

test('RBAC: support is read-only, operator is the default for new administrators', async () => {
  const support = await adminAs('support@example.com', 'support');
  assert.equal((await support.get('/api/admin/users')).status, 200);
  assert.equal((await support.get('/api/admin/pools')).status, 200);
  assert.equal((await support.post('/api/admin/users', { email: 'x@example.com', password: 'abcdefghijkl' })).status, 403);
  assert.equal((await support.post('/api/admin/pools', { name: 'nope' })).status, 403);
  assert.equal((await support.get('/api/admin/rbac')).status, 403, 'roles are for owners');
  assert.equal((await support.post('/api/admin/vms/101/power/start')).status, 403);

  const operator = await adminAs('operator@example.com');
  assert.equal((await operator.get('/api/admin/me')).json.role.key, 'operator');
  assert.equal((await operator.get('/api/admin/gpu')).status, 200, 'reads are allowed');
  assert.equal((await operator.post('/api/admin/gpu/profiles', { key: 'x', name: 'x', mode: 'passthrough', mapping: 'rtx4090' })).status, 403);
  // An operator can't make administrators or change one
  assert.equal((await operator.post('/api/admin/users', { email: 'y@example.com', password: 'abcdefghijkl', isAdmin: true })).status, 403);
  assert.equal((await operator.patch(`/api/admin/users/${support.userId}`, { password: 'a-new-password-123' })).status, 403);
  // OS templates and panel settings: owners only
  assert.equal((await operator.get('/api/admin/templates')).status, 200);
  assert.equal((await operator.put('/api/admin/templates/9000', { label: 'Debian' })).status, 403);
  assert.equal((await operator.get('/api/admin/settings/sso')).status, 200);
  assert.equal((await operator.put('/api/admin/settings/sso/google', { enabled: false })).status, 403);
  assert.equal((await operator.put('/api/admin/settings/appearance', { scheme: 'forest' })).status, 403);
});

test('RBAC: custom roles, assignment, and the last owner is protected', async () => {
  const rbac = (await admin.get('/api/admin/rbac')).json;
  assert.ok(rbac.permissions.length >= 15);
  const owner = rbac.admins.find((a) => a.email === 'admin@example.com');
  const supportRole = rbac.roles.find((r) => r.key === 'support');
  assert.equal((await admin.put(`/api/admin/rbac/admins/${owner.id}`, { roleId: supportRole.id })).status, 409, 'last owner');

  const bad = await admin.post('/api/admin/rbac/roles', { key: 'gpu-desk', name: 'GPU desk', permissions: ['gpu.read', 'nope'] });
  assert.equal(bad.status, 400);
  const role = (await admin.post('/api/admin/rbac/roles', { key: 'gpu-desk', name: 'GPU desk', permissions: ['gpu.read', 'gpu.write'] })).json;
  const desk = await adminAs('desk@example.com', 'gpu-desk');
  assert.equal((await desk.get('/api/admin/gpu')).status, 200);
  assert.equal((await desk.get('/api/admin/users')).status, 403);
  assert.equal((await admin.del(`/api/admin/rbac/roles/${role.id}`)).status, 409, 'role in use');
  const builtin = rbac.roles.find((r) => r.key === 'operator');
  assert.equal((await admin.put(`/api/admin/rbac/roles/${builtin.id}`, { permissions: ['rbac.write'] })).status, 409, 'built-ins are fixed');
});

// ---- Datacenters & pools ----------------------------------------------------------------

let dc1;
let dc2;
let pool;
let alice;
let bob;

test('datacenters: a node belongs to one datacenter only', async () => {
  dc1 = (await admin.post('/api/admin/datacenters', { key: 'jkt-dc1', name: 'Jakarta DC1', location: 'Jakarta', nodes: ['pve1'] })).json;
  dc2 = (await admin.post('/api/admin/datacenters', { key: 'jkt-dc2', name: 'Jakarta DC2', nodes: ['pve2'], storage: 'local-lvm' })).json;
  assert.equal(dc2.storage, 'local-lvm');
  const clash = await admin.post('/api/admin/datacenters', { key: 'other', name: 'Other', nodes: ['pve1'] });
  assert.equal(clash.status, 409);
});

test('pools: members share the caps, and only the pool\'s datacenters are offered', async () => {
  pool = (await admin.post('/api/admin/pools', {
    name: 'Arunika', maxCores: 3, maxMemoryMb: 8192, maxDiskGb: 100, maxPublicIps: 4, maxGpus: 0, datacenters: [dc2.id],
  })).json;
  alice = await stack.customerWith('alice@arunika.id', { limits: {} });
  bob = await stack.customerWith('bob@arunika.id', { limits: {} });
  for (const c of [alice, bob]) assert.equal((await admin.put(`/api/admin/pools/${pool.id}/members/${c.userId}`)).status, 200);

  const account = (await alice.get('/api/account')).json;
  assert.deepEqual(account.datacenters.map((d) => d.name), ['Jakarta DC2']);

  assert.equal((await alice.post('/api/vms', createBody({ datacenterId: dc1.id }))).status, 403, 'not the pool\'s datacenter');
  const r = await alice.post('/api/vms', createBody());
  assert.equal(r.status, 202, r.text);
  const clone = stack.mock.clones.at(-1);
  assert.equal(clone.target, 'pve2', 'cloned onto the datacenter\'s node');
  assert.equal(clone.storage, 'local-lvm', 'with the datacenter\'s storage');
  assert.equal((await stack.serverSettled(alice, r.json.vmid)).state, 'ready');

  // Bob has room in his own limits, but the pool has 1 vCPU left
  const over = await bob.post('/api/vms', createBody({ hostname: 'bob' }));
  assert.equal(over.status, 409);
  assert.match(over.json.error, /resource pool "Arunika".*1 vCPU left/);

  const listed = (await admin.get('/api/admin/pools')).json.find((p) => p.id === pool.id);
  assert.equal(listed.usage.cores, 2);
  assert.equal(listed.usage.members, 2);
  assert.equal((await admin.del(`/api/admin/pools/${pool.id}`)).status, 409, 'pool with members');
});

// ---- GPUs ---------------------------------------------------------------------------------

let rtx;
let vgpu;

test('GPU: inventory from Proxmox resource mappings, profiles validated against them', async () => {
  const inv = (await admin.get('/api/admin/gpu')).json;
  assert.deepEqual(inv.mappings.map((m) => m.id), ['rtx4090', 'a16']);
  assert.equal(inv.devices.pve1.length, 3, 'display controllers only');

  assert.equal((await admin.post('/api/admin/gpu/profiles', { key: 'x', name: 'x', mode: 'passthrough', mapping: 'missing' })).status, 400);
  const notMdev = await admin.post('/api/admin/gpu/profiles', { key: 'x', name: 'x', mode: 'mdev', mapping: 'rtx4090', mdevType: 'nvidia-660' });
  assert.equal(notMdev.status, 400);
  assert.match(notMdev.json.error, /Mediated Devices/);

  rtx = (await admin.post('/api/admin/gpu/profiles', { key: 'rtx4090', name: 'RTX 4090 (24 GB)', mode: 'passthrough', mapping: 'rtx4090', vramGb: 24 })).json;
  vgpu = (await admin.post('/api/admin/gpu/profiles', { key: 'a16-4q', name: 'A16 vGPU 4 GB', mode: 'mdev', mapping: 'a16', mdevType: 'nvidia-660', vramGb: 4 })).json;
  const again = (await admin.get('/api/admin/gpu')).json;
  assert.deepEqual(again.profiles.find((p) => p.key === 'rtx4090').capacity, { total: 2, used: 0, free: 2, problem: null });
  assert.equal(again.profiles.find((p) => p.key === 'a16-4q').capacity.free, 4);
});

test('GPU: attach to a stopped server only, detach again', async () => {
  const carol = await stack.customerWith('carol@example.com');
  await admin.put('/api/admin/vms/101', { userId: carol.userId });
  await admin.put('/api/admin/vms/102', { userId: carol.userId });
  assert.equal((await admin.post('/api/admin/vms/102/gpu', { profileId: rtx.id })).status, 409, 'running');
  const r = await admin.post('/api/admin/vms/101/gpu', { profileId: rtx.id });
  assert.equal(r.status, 201, r.text);
  assert.equal(stack.mock.vms.get(101).cfg.hostpci0, 'mapping=rtx4090');
  assert.deepEqual((await carol.get('/api/vms/101')).json.gpus.map((g) => g.name), ['RTX 4090 (24 GB)']);
  assert.equal((await admin.del(`/api/admin/gpu/profiles/${rtx.id}`)).status, 409, 'profile in use');
  assert.equal((await admin.del('/api/admin/vms/101/gpu/0')).status, 204);
  assert.equal(stack.mock.vms.get(101).cfg.hostpci0, undefined);
});

test('GPU: customers get GPUs through their pool, counted against it', async () => {
  // No GPU in the pool yet
  assert.equal((await alice.post('/api/vms', createBody({ hostname: 'gpu1', cores: 1, gpuProfileId: vgpu.id }))).status, 403);
  await admin.put(`/api/admin/pools/${pool.id}`, { maxCores: 10, maxGpus: 1, gpuProfiles: [vgpu.id] });
  assert.deepEqual((await alice.get('/api/account')).json.gpuProfiles.map((g) => g.name), ['A16 vGPU 4 GB']);

  const r = await alice.post('/api/vms', createBody({ hostname: 'gpu1', cores: 1, gpuProfileId: vgpu.id }));
  assert.equal(r.status, 202, r.text);
  assert.equal((await stack.serverSettled(alice, r.json.vmid)).state, 'ready');
  assert.equal(stack.mock.vms.get(r.json.vmid).cfg.hostpci0, 'mapping=a16,mdev=nvidia-660');

  const second = await bob.post('/api/vms', createBody({ hostname: 'gpu2', cores: 1, gpuProfileId: vgpu.id }));
  assert.equal(second.status, 409);
  assert.match(second.json.error, /0 GPU\(s\) left/);
});

// ---- Object storage ------------------------------------------------------------------------

test('S3: settings keep the secret key out of answers; the connection is tested with SigV4', async () => {
  const wrong = await admin.put('/api/admin/storage/s3', { enabled: true, endpoint: seaweed.url, accessKey: ADMIN_AK, secretKey: 'wrong' });
  assert.equal(wrong.status, 200);
  const fail = await admin.post('/api/admin/storage/s3/test');
  assert.equal(fail.status, 502);
  assert.match(fail.json.error, /SignatureDoesNotMatch/);

  const saved = (await admin.put('/api/admin/storage/s3', {
    enabled: true, endpoint: seaweed.url, publicEndpoint: 'https://s3.example.com', accessKey: ADMIN_AK, secretKey: ADMIN_SK,
  })).json;
  assert.equal(saved.hasSecretKey, true);
  assert.equal(JSON.stringify(saved).includes(ADMIN_SK), false);
  const ok = await admin.post('/api/admin/storage/s3/test');
  assert.equal(ok.status, 200, ok.text);
});

test('S3: buckets and keys per customer, scoped by policy and capped by the pool', async () => {
  assert.equal((await alice.get('/api/storage')).json.enabled, false, 'pool has no object storage yet');
  await admin.put(`/api/admin/pools/${pool.id}`, { maxS3Buckets: 2, maxS3Gb: 100 });
  const info = (await alice.get('/api/storage')).json;
  assert.equal(info.enabled, true);
  assert.equal(info.endpoint, 'https://s3.example.com');

  assert.equal((await alice.post('/api/storage/buckets', { name: 'data' })).status, 400, 'capped pool: quota needed');
  const b = await alice.post('/api/storage/buckets', { name: 'data', quotaGb: 50 });
  assert.equal(b.status, 201, b.text);
  const name = `pp${alice.userId}-data`;
  assert.equal(b.json.name, name);
  assert.ok(seaweed.buckets.has(name));
  const iamUser = seaweed.users.get(`ppu${alice.userId}`);
  assert.deepEqual(iamUser.policies.get('panel-buckets').Statement[0].Resource, [`arn:aws:s3:::${name}`, `arn:aws:s3:::${name}/*`]);

  const k1 = (await alice.post('/api/storage/keys')).json;
  assert.ok(k1.secretAccessKey && iamUser.keys.get(k1.accessKeyId) === k1.secretAccessKey);
  const k2 = (await alice.post('/api/storage/keys')).json;
  assert.equal(iamUser.keys.has(k1.accessKeyId), false, 'the old key stops working');
  const shown = (await alice.get('/api/storage')).json;
  assert.equal(shown.accessKeyId, k2.accessKeyId);
  assert.equal(JSON.stringify(shown).includes(k2.secretAccessKey), false, 'secret shown once only');

  assert.match((await bob.post('/api/storage/buckets', { name: 'logs', quotaGb: 60 })).json.error, /50 GB object storage left/);
  assert.equal((await bob.post('/api/storage/buckets', { name: 'logs', quotaGb: 40 })).status, 201);
  assert.match((await bob.post('/api/storage/buckets', { name: 'more', quotaGb: 5 })).json.error, /0 bucket\(s\) left/);
  assert.equal((await bob.del(`/api/storage/buckets/${name}`)).status, 404, 'not Bob\'s bucket');

  seaweed.putObject(name, 'report.pdf', 2048);
  const listed = (await alice.get('/api/storage')).json.buckets[0];
  assert.deepEqual(listed.usage, { bytes: 2048, objects: 1, truncated: false });
  assert.equal((await alice.del(`/api/storage/buckets/${name}`)).status, 409, 'not empty');

  const carol = await stack.customerWith('nopool@example.com');
  assert.equal((await carol.get('/api/storage')).json.enabled, false);
  assert.equal((await carol.post('/api/storage/keys')).status, 403);
});

test('S3: read-only buckets allow the customer\'s key only reading and listing', async () => {
  const logs = `pp${bob.userId}-logs`;
  const policy = () => seaweed.users.get(`ppu${bob.userId}`).policies.get('panel-buckets');
  assert.deepEqual(policy().Statement.map((x) => x.Action), [['s3:*']]);
  assert.equal((await alice.patch(`/api/storage/buckets/${logs}`, { readOnly: true })).status, 404, 'not Alice\'s bucket');
  const r = await bob.patch(`/api/storage/buckets/${logs}`, { readOnly: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { name: logs, readOnly: true });
  assert.deepEqual(policy().Statement, [{
    Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectTagging', 's3:ListBucket', 's3:ListBucketVersions', 's3:GetBucketLocation'],
    Resource: [`arn:aws:s3:::${logs}`, `arn:aws:s3:::${logs}/*`],
  }]);
  assert.equal((await bob.get('/api/storage')).json.buckets[0].readOnly, true);
  const listed = (await admin.get('/api/admin/storage/s3/buckets')).json.buckets.find((x) => x.name === logs);
  assert.equal(listed.readOnly, true);
  assert.equal((await admin.patch(`/api/admin/storage/s3/buckets/${logs}`, { readOnly: false })).status, 200);
  assert.deepEqual(policy().Statement.map((x) => x.Action), [['s3:*']]);
});

test('S3: deleting a customer removes their IAM identity but keeps their buckets', async () => {
  assert.equal((await admin.del(`/api/admin/users/${alice.userId}`)).status, 202);
  await waitFor(async () => !(await admin.get('/api/admin/users')).json.some((u) => u.id === alice.userId),
    { timeout: 60_000, what: 'customer deleted' });
  assert.equal(seaweed.users.has(`ppu${alice.userId}`), false);
  const { buckets } = (await admin.get('/api/admin/storage/s3/buckets')).json;
  const orphan = buckets.find((x) => x.name === `pp${alice.userId}-data`);
  assert.equal(orphan.owner, null);
  assert.equal(orphan.usage.objects, 1, 'data kept');
});
