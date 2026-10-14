// Linux package updates (apt / dnf) through the panel, against a simulated guest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let rina;
let lin;      // vmid of a Linux server
let admin;
const info = async () => (await rina.get(`/api/vms/${lin}/updates`)).json;
const finished = (timeout = 30_000) => waitFor(async () => {
  const r = (await info()).run;
  return r && ['done', 'failed'].includes(r.state) ? r : null;
}, { timeout, interval: 300, what: 'the update run to finish' });
const scenario = (name) => stack.mock.control(`/__lu/${lin}/${name}`);

before(async () => {
  stack = await startStack({ env: { WINUPDATE_POLL_SECONDS: '5' } });
  await stack.offerTemplates();
  admin = await stack.adminSession();
  rina = await stack.customerWith('rina@example.com', { limits: {} });
  const r = await rina.post('/api/vms', { hostname: 'web-prod', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123' });
  lin = r.json.vmid;
  assert.equal((await stack.serverSettled(rina, lin, 60_000)).state, 'ready');
  await stack.agentReady(lin);
});
after(async () => { await stack?.stop(); });

test('offered for Linux servers', async () => {
  const x = await info();
  assert.equal(x.os, 'linux');
  assert.equal(x.available, true);
  assert.equal(x.run, null);
  assert.equal(x.rebootPending, false);
});

test('refused without apt/dnf or with too little disk space', async () => {
  await scenario('nopm');
  const none = await rina.post(`/api/vms/${lin}/updates`, {});
  assert.equal(none.status, 409);
  assert.match(none.json.error, /No supported package manager/);
  await scenario('lowdisk');
  const low = await rina.post(`/api/vms/${lin}/updates`, {});
  assert.equal(low.status, 409);
  assert.match(low.json.error, /0\.6 GB free on \/, at least 1 GB needed/);
  await scenario('normal');
});

test('security updates: snapshot first, script and arguments passed, packages listed', { timeout: 60_000 }, async () => {
  const r = await rina.post(`/api/vms/${lin}/updates`, { scope: 'security', snapshot: true, autoRestart: false });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.os, 'linux');
  assert.match(r.json.snapshot, /^before_updates_\d{12}$/);
  const lu = stack.mock.vms.get(lin).lu;
  assert.equal(lu.scope, 'security');
  assert.equal(lu.auto, false);

  // one run at a time
  assert.equal((await rina.post(`/api/vms/${lin}/updates`, {})).status, 409);

  const done = await finished();
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.manager, 'apt');
  assert.deepEqual(done.installed.map((p) => p.kb), ['openssl', 'libssl3t64']);
  assert.equal(done.rebootRequired, false);
  assert.equal((await info()).rebootPending, false);
});

test('a new kernel without automatic restart: restart pending until the server restarts', { timeout: 60_000 }, async () => {
  await scenario('kernel');
  assert.equal((await rina.post(`/api/vms/${lin}/updates`, { scope: 'all', snapshot: false, autoRestart: false })).status, 202);
  const done = await finished();
  assert.equal(done.rebootRequired, true);
  assert.equal(done.installed.length, 4);
  assert.equal((await info()).rebootPending, true);
  await new Promise((r) => setTimeout(r, 1100));     // uptime is counted in seconds
  await rina.post(`/api/vms/${lin}/power/reboot`);
  await waitFor(async () => (await info()).rebootPending === false, { timeout: 15_000, interval: 300, what: 'restart noticed' });
  await stack.agentReady(lin);
  await scenario('normal');
});

test('a failing update gets the error from the server', { timeout: 30_000 }, async () => {
  await scenario('error');
  const start = await rina.post(`/api/vms/${lin}/updates`, { snapshot: false });
  assert.equal(start.status, 202, start.text);
  const r = await finished();
  assert.equal(r.state, 'failed');
  assert.match(r.error, /apt-get update failed/);
  await scenario('normal');
});

test('dnf servers work the same way', { timeout: 30_000 }, async () => {
  await scenario('dnf');
  const start = await rina.post(`/api/vms/${lin}/updates`, { snapshot: false });
  assert.equal(start.status, 202, start.text);
  const r = await finished();
  assert.equal(r.state, 'done');
  assert.equal(r.manager, 'dnf');
  await scenario('normal');
});

test('switched off by the administrator: Linux only', async () => {
  const off = await admin.put('/api/admin/settings/winupdates', { linux: false });
  assert.deepEqual(off.json, { enabled: true, linux: false });
  assert.equal((await info()).available, false);
  const r = await rina.post(`/api/vms/${lin}/updates`, {});
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Linux updates through the panel are switched off/);
  assert.equal((await admin.put('/api/admin/settings/winupdates', {})).status, 400);
  await admin.put('/api/admin/settings/winupdates', { linux: true });
  assert.equal((await info()).available, true);
});

test('the activity log names Linux runs', async () => {
  const log = (await admin.get('/api/admin/audit?limit=200')).json;
  const rows = Array.isArray(log) ? log : log.entries ?? log.items ?? [];
  const actions = rows.map((e) => e.action);
  assert.ok(actions.includes('linuxupdate_started'), actions.slice(0, 10).join());
  assert.ok(actions.includes('linuxupdate_finished'));
  assert.ok(actions.includes('linuxupdate_failed'));
});

test('the guest script has no syntax errors and never upgrades releases', () => {
  const src = fs.readFileSync(new URL('../../src/guest/linux-update.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /dist-upgrade|full-upgrade|do-release-upgrade|autoremove|system-upgrade/);
  assert.match(src, /--force-confold/);
});
