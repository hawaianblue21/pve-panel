// Fleet updates: the fleet view, rollouts in rings with a failure limit (pause,
// resume, cancel), skipped servers, customer emails, maintenance windows, pending
// update counts (Check now), the job list and retrying failed jobs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let rina;
let ro;                    // a read-only administrator
const ids = [];
const rollout = async (id) => (await admin.get(`/api/admin/updates/rollouts/${id}`)).json;

before(async () => {
  stack = await startStack({ mail: true, env: { WINUPDATE_POLL_SECONDS: '5', ROLLOUT_INTERVAL_SECONDS: '2' } });
  await stack.offerTemplates();
  admin = await stack.adminSession();
  await admin.put('/api/admin/settings/email', {
    host: '127.0.0.1', port: stack.smtp.port, security: 'none', username: 'panel', password: 'mail-secret',
    fromName: 'Panel', fromAddress: 'panel@example.com', panelUrl: stack.customerUrl,
  });
  rina = await stack.customerWith('rina@example.com', { limits: {} });
  for (const name of ['app-01', 'app-02', 'app-03']) {
    const r = await rina.post('/api/vms', { hostname: name, templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123' });
    assert.equal(r.status, 202, r.text);
    ids.push(r.json.vmid);
    assert.equal((await stack.serverSettled(rina, r.json.vmid, 60_000)).state, 'ready');
  }
  ids.sort((a, b) => a - b);
  for (const v of ids) await stack.agentReady(v);
});
after(async () => { await stack?.stop(); });

test('fleet: every server with its OS and last run', async () => {
  const f = (await admin.get('/api/admin/updates/fleet')).json;
  assert.deepEqual(f.servers.map((s) => [s.vmid, s.os, s.flag]), ids.map((v) => [v, 'linux', 'never']));
  assert.equal(f.kpis.patchable, 3);
  assert.equal(f.kpis.never, 3);
});

test('rollout rules are checked', async () => {
  const bad = (b) => admin.post('/api/admin/updates/rollouts', { name: 'x', vmids: ids, ...b });
  assert.equal((await bad({ rings: [50, 40] })).status, 400, 'rings must add up to 100');
  assert.equal((await bad({ vmids: [999] })).status, 400, 'unknown server');
  assert.equal((await bad({ maxFailPct: 80 })).status, 400);
  // a read-only administrator can't start one
  const u = await admin.post('/api/admin/users', { email: 'ro@example.com', password: 'readonly-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((r) => r.key === 'support').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'ro@example.com', password: 'readonly-password-1' });
  assert.equal((await ro.post('/api/admin/updates/rollouts', { name: 'x', vmids: ids })).status, 403);
  assert.equal((await ro.get('/api/admin/updates/fleet')).status, 200);
});

test('rings: a failing first ring pauses the rollout; resume continues; stopped servers are skipped', { timeout: 120_000 }, async () => {
  await stack.mock.control(`/__lu/${ids[0]}/error`);            // ring 1 fails
  await rina.post(`/api/vms/${ids[2]}/power/stop`);              // ring 2: one server is off
  await waitFor(async () => ((await rina.get(`/api/vms/${ids[2]}`)).json.status === 'stopped' ? true : null), { what: 'stopped' });

  const r = await admin.post('/api/admin/updates/rollouts', { name: 'October security', vmids: ids, rings: [30, 70], scope: 'security', snapshot: false, maxFailPct: 2 });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.rings.map((x) => [x.ring, x.total]), [[1, 1], [2, 2]]);
  assert.equal((await admin.post('/api/admin/updates/rollouts', { name: 'again', vmids: ids })).status, 409, 'one at a time');

  const paused = await waitFor(async () => { const x = await rollout(r.json.id); return x.state === 'paused' ? x : null; }, { timeout: 60_000, interval: 500, what: 'pause' });
  assert.match(paused.reason, /1 of 1 updated servers failed \(more than 2 %\)/);
  assert.equal(paused.items.find((i) => i.vmid === ids[0]).state, 'failed');
  assert.match(paused.items.find((i) => i.vmid === ids[0]).note, /apt-get update failed/);
  assert.ok(paused.items.filter((i) => i.ring === 2).every((i) => i.state === 'pending'), 'ring 2 waits');

  assert.equal((await admin.post(`/api/admin/updates/rollouts/${r.json.id}/resume`)).json.state, 'running');
  const done = await waitFor(async () => { const x = await rollout(r.json.id); return x.state === 'done' ? x : null; }, { timeout: 90_000, interval: 500, what: 'rollout done' });
  const st = Object.fromEntries(done.items.map((i) => [i.vmid, i.state]));
  assert.deepEqual([st[ids[0]], st[ids[1]], st[ids[2]]], ['failed', 'done', 'skipped']);
  assert.match(done.items.find((i) => i.vmid === ids[2]).note, /Start the server first/);

  const notices = stack.smtp.messages.filter((m) => /^Updates are being installed on/.test(m.subject));
  assert.equal(notices.length, 2, 'customers of started runs are told');
  const f = (await admin.get('/api/admin/updates/fleet')).json;
  assert.deepEqual(f.servers.map((s) => s.flag), ['failed', 'ok', 'never']);
});

test('jobs: update runs and finished server work; cancel stops pending servers', async () => {
  const j = (await admin.get('/api/admin/jobs')).json;
  assert.ok(j.jobs.some((x) => x.kind === 'updates' && x.state === 'failed' && x.vmid === ids[0]));
  assert.ok(j.jobs.some((x) => x.kind === 'updates' && x.state === 'done' && x.vmid === ids[1]));
  assert.equal(j.jobs.filter((x) => x.action === 'Create server' && x.state === 'done').length, 3);
  assert.deepEqual((await admin.get('/api/admin/jobs?filter=failed')).json.jobs.map((x) => x.state).filter((s) => s !== 'failed'), []);

  const r = (await admin.post('/api/admin/updates/rollouts', { name: 'later', vmids: [ids[2]], rings: [100] })).json;
  const c = await admin.post(`/api/admin/updates/rollouts/${r.id}/cancel`);
  assert.equal(c.json.state, 'cancelled');
  assert.equal((await admin.post(`/api/admin/updates/rollouts/${r.id}/resume`)).status, 409);
  assert.equal((await admin.get('/api/admin/updates/rollouts')).json.rollouts.length, 2);
});

test('maintenance window: outside it nothing starts and the rollout says why', async () => {
  const bad = (window) => admin.post('/api/admin/updates/rollouts', { name: 'w', vmids: [ids[1]], rings: [100], window });
  assert.equal((await bad({ days: [], start: 1, end: 5 })).status, 400);
  assert.equal((await bad({ days: [1], start: 3, end: 3 })).status, 400);
  assert.equal((await bad({ days: [7], start: 1, end: 5 })).status, 400);
  // a two-hour window starting in two hours (UTC, the panel's time zone here): never now
  const h = (new Date().getUTCHours() + 2) % 24;
  const r = await admin.post('/api/admin/updates/rollouts', { name: 'Night window', vmids: [ids[1]], rings: [100], window: { days: [0, 1, 2, 3, 4, 5, 6], start: h, end: (h + 2) % 24 } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.window.days.length, r.json.window.start], [7, h]);
  assert.match(r.json.window.text, /^every day \d\d:00–\d\d:00( \(next day\))? UTC$/);
  const waiting = await waitFor(async () => { const x = await rollout(r.json.id); return x.reason ? x : null; }, { timeout: 15_000, what: 'waiting note' });
  assert.match(waiting.reason, /^Waiting for the maintenance window \(every day/);
  assert.equal(waiting.state, 'running');
  assert.equal(waiting.items[0].state, 'pending', 'nothing started');
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal((await rollout(r.json.id)).items[0].state, 'pending');
  assert.equal((await admin.post(`/api/admin/updates/rollouts/${r.json.id}/cancel`)).json.state, 'cancelled');
});

test('check now: pending updates counted inside running servers, without installing', async () => {
  assert.equal((await ro.post('/api/admin/updates/check', { vmids: ids })).status, 403, 'needs updates.write');
  const r = await admin.post('/api/admin/updates/check', { vmids: [...ids, 99999] });
  assert.equal(r.status, 202, r.text);
  assert.deepEqual(r.json, { queued: 3, skipped: 1 });
  const fleet = await waitFor(async () => {
    const f = (await admin.get('/api/admin/updates/fleet')).json;
    return f.servers.every((s) => s.check && s.check.state !== 'checking') ? f : null;
  }, { timeout: 30_000, what: 'checks finished' });
  const c = Object.fromEntries(fleet.servers.map((s) => [s.vmid, s.check]));
  assert.deepEqual([c[ids[0]].state, c[ids[0]].pending, c[ids[0]].security, c[ids[0]].rebootRequired], ['done', 7, 2, false]);
  assert.equal(c[ids[1]].state, 'done');
  assert.deepEqual([c[ids[2]].state, c[ids[2]].error], ['failed', 'The server is not running'], 'the stopped server');
});

test('retry: the latest failed update run starts again; a failed creation can\'t be retried; a failed deletion can', { timeout: 90_000 }, async () => {
  await stack.mock.control(`/__lu/${ids[0]}/normal`);
  const failedRun = (await admin.get('/api/admin/jobs?filter=failed')).json.jobs.find((j) => j.kind === 'updates' && j.vmid === ids[0]);
  assert.equal(failedRun.retry, 'updates');
  assert.equal((await ro.post('/api/admin/jobs/retry', { id: failedRun.id })).status, 403, 'needs updates.write');
  assert.equal((await admin.post('/api/admin/jobs/retry', { id: 'run-999999' })).status, 404);
  const r = await admin.post('/api/admin/jobs/retry', { id: failedRun.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.retried, true);
  await waitFor(async () => ((await admin.get('/api/admin/updates/fleet')).json.servers.find((s) => s.vmid === ids[0]).flag === 'ok' ? true : null), { timeout: 60_000, interval: 500, what: 'retried run done' });
  assert.equal((await admin.get('/api/admin/jobs?filter=failed')).json.jobs.some((j) => j.kind === 'updates' && j.vmid === ids[0] && j.retry), false, 'older failure not offered');

  const db = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  db.prepare("UPDATE vms SET state = 'failed', error = 'Setting up failed: the clone timed out' WHERE vmid = ?").run(ids[2]);
  let job = (await admin.get('/api/admin/jobs?filter=failed')).json.jobs.find((j) => j.id === `vm-${ids[2]}`);
  assert.equal(job.retry, null);
  assert.match(job.retryNote, /customer reinstalls or deletes/);
  const no = await admin.post('/api/admin/jobs/retry', { id: job.id });
  assert.equal(no.status, 409);
  assert.match(no.json.error, /customer's sign-in details/);

  db.prepare("UPDATE vms SET state = 'failed', error = 'Deleting failed: storage timeout' WHERE vmid = ?").run(ids[2]);
  db.close();
  job = (await admin.get('/api/admin/jobs?filter=failed')).json.jobs.find((j) => j.id === `vm-${ids[2]}`);
  assert.equal(job.retry, 'delete');
  const del = await admin.post('/api/admin/jobs/retry', { id: job.id });
  assert.equal(del.status, 200, del.text);
  await waitFor(async () => ((await rina.get(`/api/vms/${ids[2]}`)).status === 404 ? true : null), { timeout: 30_000, what: 'deleted' });
});
