// Windows updates through the panel, against a simulated Windows Update.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let lena;
let win;      // vmid of a Windows server
const run = async () => (await lena.get(`/api/vms/${win}/updates`)).json.run;
const finished = (timeout = 60_000) => waitFor(async () => {
  const r = await run();
  return r && ['done', 'failed'].includes(r.state) ? r : null;
}, { timeout, interval: 500, what: 'the update run to finish' });
const scenario = (name) => stack.mock.control(`/__wu/${win}/${name}`);

before(async () => {
  stack = await startStack({ env: { WINUPDATE_POLL_SECONDS: '5' } });
  await stack.offerTemplates();
  lena = await stack.customerWith('lena@example.com', { limits: {} });
  const r = await lena.post('/api/vms', { templateId: 9100, cores: 2, memoryMb: 4096, diskGb: 60, hostname: 'win-office', password: 'Winter-Sun-2026!x' });
  win = r.json.vmid;
  assert.equal((await stack.serverSettled(lena, win, 110_000)).state, 'ready');
  await stack.agentReady(win);
});
after(async () => { await stack?.stop(); });

test('offered for Windows servers', async () => {
  const info = (await lena.get(`/api/vms/${win}/updates`)).json;
  assert.equal(info.available, true);
  assert.equal(info.run, null);
});

test('refused when there is too little disk space or the update service is disabled', async () => {
  await scenario('lowdisk');
  const low = await lena.post(`/api/vms/${win}/updates`, {});
  assert.equal(low.status, 409);
  assert.match(low.json.error, /4\.2 GB free.*at least 10 GB/);
  await scenario('disabled');
  const off = await lena.post(`/api/vms/${win}/updates`, {});
  assert.equal(off.status, 409);
  assert.match(off.json.error, /service is disabled/);
  await scenario('normal');
});

test('installs updates: snapshot first, restart in between, until up to date', { timeout: 90_000 }, async () => {
  const r = await lena.post(`/api/vms/${win}/updates`, { scope: 'security', snapshot: true, autoRestart: true });
  assert.equal(r.status, 202, r.text);
  assert.match(r.json.snapshot, /^before_updates_\d{12}$/);
  const snaps = (await lena.get(`/api/vms/${win}/snapshots`)).json.map((s) => s.name);
  assert.ok(snaps.includes(r.json.snapshot), 'snapshot taken before updating');
  assert.equal(stack.mock.vms.get(win).wuConfig.scope, 'security');

  // while it runs: no second run, no reinstall
  assert.equal((await lena.post(`/api/vms/${win}/updates`, {})).status, 409);
  const re = await lena.post(`/api/vms/${win}/reinstall`, { templateId: 9100, password: 'Winter-Sun-2026!x' });
  assert.equal(re.status, 409);
  assert.match(re.json.error, /updates are being installed/);

  const seen = new Set();
  const done = await waitFor(async () => {
    const x = await run();
    seen.add(x.state);
    return ['done', 'failed'].includes(x.state) ? x : null;
  }, { timeout: 60_000, interval: 250, what: 'updates finished' });
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(done.installed.map((u) => u.kb), ['KB5044284', 'KB5044029', 'KB2267602', 'KB5044099']);
  assert.ok(seen.has('installing'), `progress reported (${[...seen]})`);
  assert.ok(stack.mock.vms.get(win).wuCleaned, 'the scheduled task is removed afterwards');
});

test('"I\'ll restart later": waits for a restart, then continues', { timeout: 90_000 }, async () => {
  const r = await lena.post(`/api/vms/${win}/updates`, { scope: 'all', snapshot: false, autoRestart: false });
  assert.equal(r.status, 202, r.text);
  await waitFor(async () => (await run()).state === 'restart-required', { timeout: 30_000, interval: 300, what: 'restart required' });
  assert.equal(stack.mock.vms.get(win).wuConfig.scope, 'all');
  await lena.post(`/api/vms/${win}/power/reboot`);
  const done = await finished();
  assert.equal(done.state, 'done');
  assert.equal(done.installed.length, 4);
});

test('a failing Windows Update gets a readable message', async () => {
  await scenario('error');
  assert.equal((await lena.post(`/api/vms/${win}/updates`, { snapshot: false })).status, 202);
  const r = await finished();
  assert.equal(r.state, 'failed');
  assert.match(r.error, /can't be reached \(check DNS or proxy settings\)/);
  await scenario('normal');
});

test('the snapshot limit is respected', async () => {
  for (const n of ['a1', 'a2', 'a3']) await lena.post(`/api/vms/${win}/snapshots`, { name: n });
  await waitFor(async () => (await lena.get(`/api/vms/${win}/snapshots`)).json.length >= 3, { what: 'snapshots' });
  const r = await lena.post(`/api/vms/${win}/updates`, { snapshot: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Delete one, or start without a snapshot/);
});

test('runs are tracked even when nobody watches', { timeout: 60_000 }, async () => {
  await scenario('uptodate');
  assert.equal((await lena.post(`/api/vms/${win}/updates`, { snapshot: false })).status, 202);
  const db = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  try {
    const row = await waitFor(() => {
      const x = db.prepare('SELECT state FROM winupdates WHERE vmid = ? ORDER BY id DESC LIMIT 1').get(win);
      return x?.state === 'done' ? x : null;
    }, { timeout: 30_000, interval: 500, what: 'the tracker to record the result' });
    assert.equal(row.state, 'done');
  } finally { db.close(); }
});

test('stopped servers and switched-off updates are refused', async () => {
  const admin = await stack.adminSession();
  await admin.put('/api/admin/vms/101', { userId: lena.userId });   // Linux, stopped
  const info = (await lena.get('/api/vms/101/updates')).json;
  assert.equal(info.os, 'linux');
  const stopped = await lena.post('/api/vms/101/updates', {});
  assert.equal(stopped.status, 409);
  assert.match(stopped.json.error, /Start the server first/);

  // Switching Windows off leaves Linux alone (and the other way round)
  await admin.put('/api/admin/settings/winupdates', { enabled: false });
  assert.equal((await lena.get(`/api/vms/${win}/updates`)).json.available, false);
  assert.equal((await lena.post(`/api/vms/${win}/updates`, {})).status, 403);
  assert.equal((await lena.get('/api/vms/101/updates')).json.available, true);
  await admin.put('/api/admin/settings/winupdates', { enabled: true });
});
