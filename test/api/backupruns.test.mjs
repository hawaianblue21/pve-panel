// Backups, stage 2: the scheduler inside the window, vzdump to the customer's storage
// with the policy's retention, one run per window, a retry after a failure, manual
// backups and retries from Jobs, coverage, per-server overrides and the clean-up of
// backups whose server is gone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, waitFor, sleep } from '../support/stack.mjs';
import { startMockPbs, PBS_TOKEN, PBS_SECRET } from '../support/mock-pbs.mjs';

let stack;
let admin;
let pbs;
let mila;
let policyId;
const VM = 101;
const sql = (q, ...args) => { const db = new DatabaseSync(path.join(stack.dir, 'panel.db')); try { return db.prepare(q).all(...args); } finally { db.close(); } };
const runs = async (q = '') => (await admin.get(`/api/admin/backups/runs?vmid=${VM}${q}`)).json.runs;
const failNext = (n) => fetch(`${stack.mock.url}/api2/json/__vzdumpfail/${VM}/${n}`, { headers: { authorization: 'PVEAPIToken=panel@pve!panel=x' } });
const backupsOf = (vmid) => [...stack.mock.backups.values()].filter((b) => b.vmid === vmid);

before(async () => {
  pbs = await startMockPbs();
  stack = await startStack({ env: { BACKUP_TICK_SECONDS: '1', BACKUP_RETRY_DELAY_SECONDS: '0', BACKUP_PURGE_SECONDS: '1' } });
  admin = await stack.adminSession();
  mila = await stack.customerWith('mila@example.com');
  assert.equal((await admin.post('/api/admin/vms/bulk', { action: 'assign', vmids: [VM], userId: mila.userId })).status, 200);
  const s = await admin.post('/api/admin/backups/servers', { name: 'pbs-jkt', url: pbs.url, tokenId: PBS_TOKEN, tokenSecret: PBS_SECRET, datastore: 'ds-customer' });
  assert.equal(s.status, 201, s.text);
  policyId = (await admin.post('/api/admin/backups/policies', { name: 'Daily 2', frequency: 'daily', keepDaily: 2 })).json.id;
});
after(async () => { await stack?.stop(); await pbs?.close(); });

test('nothing runs while backups are off or outside the window', async () => {
  const h = new Date().getUTCHours();
  await admin.put('/api/admin/backups/settings', { enabled: true, defaultPolicyId: policyId, windowStart: (h + 2) % 24, windowEnd: (h + 4) % 24 });
  await sleep(2500);
  assert.equal((await runs()).length, 0);
  assert.equal(stack.mock.vzdumps.length, 0);
});

test('inside the window: one scheduled backup to the customer\'s encrypted storage, pruned by the policy', async () => {
  const h = new Date().getUTCHours();
  const s = await admin.put('/api/admin/backups/settings', { windowStart: h, windowEnd: (h + 2) % 24, bwlimitMBs: 50 });
  assert.equal(s.status, 200, s.text);
  const ok = await waitFor(async () => (await runs()).find((r) => r.state === 'ok'), { what: 'the scheduled backup' });
  assert.equal(ok.kind, 'scheduled');
  assert.match(ok.volid, new RegExp(`^pbs1-c${mila.userId}:backup/vm/${VM}/`));
  assert.ok(ok.size > 0);
  const call = stack.mock.vzdumps[0];
  assert.equal(call.storage, `pbs1-c${mila.userId}`);
  assert.equal(call['prune-backups'], 'keep-daily=2');
  assert.equal(Number(call.bwlimit), 50 * 1024);
  assert.equal(call.mode, 'snapshot');
  const st = stack.mock.storages.get(`pbs1-c${mila.userId}`);
  assert.equal(st.namespace, `panel/c${mila.userId}`);
  assert.equal(st.encrypted, true);
  assert.ok(pbs.namespaces.has(`ds-customer:panel/c${mila.userId}`));

  await sleep(2500);
  assert.equal((await runs()).length, 1, 'once per window');
  const o = (await admin.get('/api/admin/backups')).json;
  assert.equal(o.keys, 1, 'the generated key is kept');
  assert.equal(o.coverage.servers.find((x) => x.vmid === VM).status, 'protected');
  assert.equal(o.coverage.last24h.ok, 1);
});

test('a failed scheduled backup is tried once more in the same window, then reported', async () => {
  sql("UPDATE backup_runs SET window_key = '2000-01-01'");          // as if the last one was yesterday
  await failNext(5);
  await waitFor(async () => ((await runs('&state=failed')).length >= 2 ? true : null), { what: 'two failed attempts' });
  await sleep(2500);
  assert.equal((await runs('&state=failed')).length, 2, 'one retry, no more');
  const o = (await admin.get('/api/admin/backups')).json;
  const c = o.coverage.servers.find((x) => x.vmid === VM);
  assert.equal(c.status, 'failing');
  assert.match(c.lastError, /job errors/);

  // Jobs: the latest failed run can be retried
  await failNext(0);
  const job = (await admin.get('/api/admin/jobs?filter=failed')).json.jobs.find((j) => j.kind === 'backup' && j.retry === 'backup');
  assert.ok(job, 'listed in Jobs with a retry');
  const r = await admin.post('/api/admin/jobs/retry', { id: job.id });
  assert.equal(r.status, 200, r.text);
  await waitFor(async () => ((await runs())[0].state === 'ok' ? true : null), { what: 'the retried backup' });
});

test('manual backups by administrators; one at a time; read-only roles can only look', async () => {
  const r = await admin.post(`/api/admin/backups/run/${VM}`);
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.kind, 'manual');
  assert.equal((await admin.post(`/api/admin/backups/run/${VM}`)).status, 409, 'already running');
  await waitFor(async () => ((await runs())[0].state === 'ok' ? true : null), { what: 'the manual backup' });

  const u = await admin.post('/api/admin/users', { email: 'look@example.com', password: 'readonly-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((x) => x.key === 'support').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  const ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'look@example.com', password: 'readonly-password-1' });
  assert.equal((await ro.get('/api/admin/backups/runs')).status, 200);
  assert.equal((await ro.post(`/api/admin/backups/run/${VM}`)).status, 403);
  assert.equal((await ro.put(`/api/admin/backups/vms/${VM}`, { excluded: true })).status, 403);
});

test('a server can get its own policy or be excluded', async () => {
  const other = (await admin.post('/api/admin/backups/policies', { name: 'Weekly', frequency: 'weekly', weekday: 0, keepWeekly: 4 })).json.id;
  const r = await admin.put(`/api/admin/backups/vms/${VM}`, { policyId: other });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.policy, 'Weekly');
  assert.equal((await admin.put(`/api/admin/backups/vms/${VM}`, { policyId: 999 })).status, 400);
  const x = await admin.put(`/api/admin/backups/vms/${VM}`, { policyId: null, excluded: true });
  assert.equal(x.json.status, 'excluded');
  sql("UPDATE backup_runs SET window_key = '2000-01-01'");
  const before = (await runs()).length;
  await sleep(2500);
  assert.equal((await runs()).length, before, 'excluded servers are not backed up');
  await admin.put(`/api/admin/backups/vms/${VM}`, { excluded: false });
});

test('backups of a server that is no longer the customer\'s are removed after the grace period', async () => {
  await waitFor(async () => ((await runs())[0].state === 'ok' ? true : null), { what: 'runs to settle' });
  assert.ok(backupsOf(VM).length >= 1);
  backupsOf(VM)[0].protected = true;                                  // protected ones go too
  await admin.put('/api/admin/backups/settings', { keepAfterDeleteDays: 30 });
  assert.equal((await admin.del(`/api/admin/vms/${VM}`)).status, 204);
  const o = await waitFor(async () => (await admin.get('/api/admin/backups')).json.coverage.orphans.find((x) => x.vmid === VM), { what: 'the orphan to be listed' });
  assert.equal(o.email, 'mila@example.com');
  await sleep(1500);
  assert.ok(backupsOf(VM).length >= 1, 'kept during the grace period');

  sql('UPDATE backup_orphans SET first_seen = ?', new Date(Date.now() - 31 * 86_400_000).toISOString());
  await waitFor(() => (backupsOf(VM).length === 0 ? true : null), { what: 'the backups to be removed' });
  await waitFor(async () => ((await admin.get('/api/admin/backups')).json.coverage.orphans.length === 0 ? true : null), { what: 'the orphan list to clear' });
  const log = sql("SELECT detail FROM audit_log WHERE action = 'backup_purged'");
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0].detail).afterDays, 30);
});
