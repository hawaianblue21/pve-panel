// Backups, stage 3 (customers): restore points, a backup of their own (limit per day),
// protecting backups, the add-on policy on the renewal, browsing and downloading files,
// restoring in place (with a backup first) and as a new server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';
import { startMockPbs, PBS_TOKEN, PBS_SECRET } from '../support/mock-pbs.mjs';

let stack;
let admin;
let pbs;
let mila;
let other;
let daily;
let long;
const VM = 101;
const DAY = 86_400_000;
const view = async () => (await mila.get(`/api/vms/${VM}/backups`)).json;
const settled = () => waitFor(async () => { const v = await view(); return v.enabled && !v.running ? v : null; }, { what: 'the backup to finish' });
const adminBackup = async () => { assert.equal((await admin.post(`/api/admin/backups/run/${VM}`)).status, 202); return settled(); };
const stateOf = async (vmid) => (await mila.get('/api/vms')).json.find((v) => v.vmid === vmid)?.state;

before(async () => {
  pbs = await startMockPbs();
  stack = await startStack({ env: { BACKUP_TICK_SECONDS: '1' } });
  admin = await stack.adminSession();
  mila = await stack.customerWith('mila@example.com', { limits: {} });
  other = await stack.customerWith('olaf@example.com');
  await admin.put(`/api/admin/vms/${VM}`, { userId: mila.userId, label: 'web-prod' });
  await admin.put(`/api/admin/vms/${VM}/expiry`, { expiresAt: new Date(Date.now() + 20 * DAY).toISOString() });
  assert.equal((await admin.post('/api/admin/backups/servers', { name: 'pbs-jkt', url: pbs.url, tokenId: PBS_TOKEN, tokenSecret: PBS_SECRET, datastore: 'ds-customer' })).status, 201);
  daily = (await admin.post('/api/admin/backups/policies', { name: 'Daily 7', frequency: 'daily', keepDaily: 7 })).json.id;
  long = (await admin.post('/api/admin/backups/policies', { name: 'Long', frequency: 'daily', keepDaily: 14, keepWeekly: 8, addonPrice: 25_000 })).json.id;
});
after(async () => { await stack?.stop(); await pbs?.close(); });

test('customers see backups once they are switched on; only their own servers', async () => {
  assert.deepEqual(await view(), { enabled: false });
  const h = new Date().getUTCHours();
  const s = await admin.put('/api/admin/backups/settings', { enabled: true, defaultPolicyId: daily, manualPerDay: 1, windowStart: (h + 3) % 24, windowEnd: (h + 5) % 24 });
  assert.equal(s.status, 200, s.text);
  const v = await view();
  assert.equal(v.policy.name, 'Daily 7');
  assert.deepEqual(v.addons.map((x) => x.name), ['Long']);
  assert.equal(v.manual.left, 1);
  assert.deepEqual(v.points, []);
  assert.equal((await other.get(`/api/vms/${VM}/backups`)).status, 404);
  assert.equal((await other.post(`/api/vms/${VM}/backups`)).status, 404);
});

test('a backup of their own: one at a time, limited per day', async () => {
  const r = await mila.post(`/api/vms/${VM}/backups`);
  assert.equal(r.status, 202, r.text);
  assert.equal((await mila.post(`/api/vms/${VM}/backups`)).status, 409, 'already running');
  const v = await settled();
  assert.equal(v.points.length, 1);
  assert.equal(v.points[0].verified, true);
  assert.equal(v.manual.left, 0);
  const again = await mila.post(`/api/vms/${VM}/backups`);
  assert.equal(again.status, 429);
  assert.match(again.json.error, /Up to 1 backups/);
});

test('protected backups survive pruning; at most three per server', async () => {
  for (let i = 0; i < 3; i += 1) {
    const v = await view();
    const id = v.points[0].id;
    assert.equal((await mila.put(`/api/vms/${VM}/backups/${id}`, { protected: true })).status, 200);
    await adminBackup();                                  // keep-daily=7: one a day, protected ones stay
  }
  const v = await view();
  assert.equal(v.points.filter((p) => p.protected).length, 3);
  assert.equal(v.points.length, 4);
  const r = await mila.put(`/api/vms/${VM}/backups/${v.points[0].id}`, { protected: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Up to 3 protected/);
  assert.equal((await mila.put(`/api/vms/${VM}/backups/2001-01-01T00:00:00Z`, { protected: true })).status, 404);
  assert.equal((await mila.put(`/api/vms/${VM}/backups/nope`, { protected: true })).status, 400);
});

test('the add-on policy is billed with the renewal; a policy set by support is not theirs to change', async () => {
  const b = await admin.put('/api/admin/settings/billing', {
    enabled: true, taxName: 'PPN', taxRate: 0, rates: { vcpu: 50_000, ramGb: 25_000, diskGb: 1_500, minimum: 50_000 },
    bank: { enabled: true, instructions: 'Bank transfer to Example Bank 000-000' },
  });
  assert.equal(b.status, 200, b.text);
  assert.equal((await mila.put(`/api/vms/${VM}/backups/addon`, { policyId: daily })).status, 400, 'not sold as an add-on');
  assert.equal((await mila.put(`/api/vms/${VM}/backups/addon`, { policyId: long })).status, 200);
  assert.equal((await view()).addon.name, 'Long');
  const inv = await mila.post('/api/billing/renewals', { vmid: VM, months: 1 });
  assert.equal(inv.status, 201, inv.text);
  const line = inv.json.lines.find((l) => /Backup add-on: Long/.test(l.description));
  assert.equal(line?.amount, 25_000);
  assert.equal((await mila.put(`/api/vms/${VM}/backups/addon`, { policyId: null })).status, 200);

  await admin.put(`/api/admin/backups/vms/${VM}`, { policyId: daily });
  const r = await mila.put(`/api/vms/${VM}/backups/addon`, { policyId: long });
  assert.equal(r.status, 409);
  assert.equal((await view()).setBySupport, true);
  await admin.put(`/api/admin/backups/vms/${VM}`, { policyId: null });
});

test('browse a backup and download a file; paths are checked', async () => {
  const id = (await view()).points[0].id;
  const root = await mila.get(`/api/vms/${VM}/backups/${id}/files`);
  assert.equal(root.status, 200, root.text);
  assert.deepEqual(root.json.entries.map((e) => `${e.type}:${e.name}`), ['folder:etc', 'folder:var']);
  const html = (await mila.get(`/api/vms/${VM}/backups/${id}/files?path=${encodeURIComponent('/var/www/html')}`)).json;
  assert.deepEqual(html.entries.map((e) => e.path), ['/var/www/html/index.php', '/var/www/html/wp-config.php']);
  assert.equal((await mila.get(`/api/vms/${VM}/backups/${id}/files?path=${encodeURIComponent('/etc/../..')}`)).status, 400);

  const dl = await mila.get(`/api/vms/${VM}/backups/${id}/download?path=${encodeURIComponent('/etc/hostname')}`);
  assert.equal(dl.status, 200, dl.text);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="hostname"/);
  const d = dl.text;
  assert.match(d, /content of hostname from pbs1-c\d+:backup\/vm\/101\//);
  assert.equal((await other.get(`/api/vms/${VM}/backups/${id}/download?path=%2Fetc%2Fhostname`)).status, 404);
  const hist = (await admin.get('/api/admin/backups')).json.restores;
  assert.equal(hist[0].mode, 'files');
  assert.equal(hist[0].path, '/etc/hostname');
});

test('restore in place: the server must be shut down; a backup is made first', async () => {
  const points = (await view()).points;
  const target = points[points.length - 1];
  stack.mock.vms.get(VM).status = 'running';
  const busy = await mila.post(`/api/vms/${VM}/backups/${target.id}/restore`, { mode: 'replace' });
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /Shut down/);
  stack.mock.vms.get(VM).status = 'stopped';

  const runsBefore = (await admin.get(`/api/admin/backups/runs?vmid=${VM}`)).json.runs.length;
  const r = await mila.post(`/api/vms/${VM}/backups/${target.id}/restore`, { mode: 'replace', backupFirst: true });
  assert.equal(r.status, 202, r.text);
  assert.equal(await stateOf(VM), 'restoring');
  assert.equal((await mila.get(`/api/vms/${VM}/backups`)).status, 409, 'busy while restoring');
  await waitFor(async () => ((await stateOf(VM)) === 'ready' ? true : null), { timeout: 30_000, what: 'the restore' });
  assert.equal(stack.mock.vms.get(VM).restoredFrom, target.volid);
  const runs = (await admin.get(`/api/admin/backups/runs?vmid=${VM}`)).json.runs;
  assert.equal(runs.length, runsBefore + 1, 'a backup first');
  assert.equal(runs[0].state, 'ok');
  const hist = (await admin.get('/api/admin/backups')).json.restores[0];
  assert.equal(hist.mode, 'replace');
  assert.equal(hist.state, 'ok');
});

test('restore as a new server: limits, only the system disk, no public addresses or GPUs', async () => {
  const point = (await view()).points[0];
  const bk = stack.mock.backups.get(point.volid);
  Object.assign(bk.cfg, {
    net1: 'virtio=AA:BB:CC:DD:EE:01,bridge=vmbr1', ipconfig1: 'ip=203.0.113.9/24', hostpci0: '0000:41:00.0,mdev=nvidia-660',
    scsi1: 'VMStorage:vm-101-disk-11,size=50G',
  });
  assert.equal((await mila.post(`/api/vms/${VM}/backups/${point.id}/restore`, { mode: 'new', hostname: 'Bad Name' })).status, 400);
  const u = { id: mila.userId };
  await admin.patch(`/api/admin/users/${u.id}`, { maxServers: 1 });
  const over = await mila.post(`/api/vms/${VM}/backups/${point.id}/restore`, { mode: 'new', hostname: 'web-copy' });
  assert.equal(over.status, 409);
  assert.match(over.json.error, /exceeds your plan: servers/);
  await admin.patch(`/api/admin/users/${u.id}`, { maxServers: 5 });

  const r = await mila.post(`/api/vms/${VM}/backups/${point.id}/restore`, { mode: 'new', hostname: 'web-copy' });
  assert.equal(r.status, 202, r.text);
  const vmid = r.json.vmid;
  assert.notEqual(vmid, VM);
  await waitFor(async () => ((await stateOf(vmid)) === 'ready' ? true : null), { timeout: 30_000, what: 'the new server' });
  const cfg = stack.mock.vms.get(vmid).cfg;
  assert.equal(cfg.name, 'web-copy');
  for (const k of ['net1', 'ipconfig1', 'hostpci0', 'scsi1']) assert.equal(cfg[k], undefined, `${k} removed`);
  assert.equal(Object.keys(cfg).some((k) => /^unused\d+$/.test(k)), false, 'the extra disk is destroyed');
  assert.ok(cfg.scsi0, 'the system disk stays');
  const hist = (await admin.get('/api/admin/backups')).json.restores[0];
  assert.equal(hist.mode, 'new');
  assert.equal(hist.targetVmid, vmid);
  assert.equal(hist.state, 'ok');
});
