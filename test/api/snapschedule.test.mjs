// Automatic snapshots: schedule rules, runs with retention (only automatic ones are
// pruned), the plan's limit, and the sync after a rollback (volumes and public IPs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let rina;
let vm;
const snaps = () => (stack.mock.vms.get(vm).snaps ?? []).map((s) => s.name);
const autos = () => snaps().filter((n) => /^auto_\d{14}$/.test(n));
const cfg = () => stack.mock.vms.get(vm).cfg;
const schedule = async () => (await rina.get(`/api/vms/${vm}/snapshot-schedule`)).json.schedule;
/** makes the schedule due now and waits for the run to be recorded */
async function runNow() {
  const before = (await schedule()).lastRunAt;
  const db = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  db.prepare('UPDATE snapshot_schedules SET next_run_at = ? WHERE vmid = ?').run(new Date(Date.now() - 1000).toISOString(), vm);
  db.close();
  return waitFor(async () => { const s = await schedule(); return s.lastRunAt && s.lastRunAt !== before ? s : null; }, { timeout: 30_000, interval: 300, what: 'automatic snapshot run' });
}
async function snapshot(name) {
  const r = await rina.post(`/api/vms/${vm}/snapshots`, { name });
  assert.ok([200, 202].includes(r.status), r.text);
  await waitFor(() => (snaps().includes(name) ? true : null), { what: `snapshot ${name}` });
}
async function rollback(name) {
  const r = await rina.post(`/api/vms/${vm}/snapshots/${name}/rollback`);
  assert.ok([200, 202].includes(r.status), r.text);
}

before(async () => {
  stack = await startStack({ env: { SNAPSHOT_SCHEDULE_SECONDS: '2', MAX_SNAPSHOTS: '3', PANEL_TIMEZONE: 'Asia/Jakarta' } });
  admin = await stack.adminSession();
  await stack.offerTemplates();
  rina = await stack.customerWith('rina@example.com', { limits: {} });
  const r = await rina.post('/api/vms', { hostname: 'db-01', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123' });
  vm = r.json.vmid;
  assert.equal((await stack.serverSettled(rina, vm)).state, 'ready');
});
after(async () => { await stack?.stop(); });

test('schedule rules; the next run is at the chosen hour in the panel time zone', async () => {
  assert.equal((await rina.put(`/api/vms/${vm}/snapshot-schedule`, { frequency: 'daily', hour: 2, keep: 4 })).status, 400, 'more than the plan allows');
  assert.equal((await rina.put(`/api/vms/${vm}/snapshot-schedule`, { frequency: 'weekly', hour: 2, keep: 2 })).status, 400, 'weekly needs a day');
  const r = await rina.put(`/api/vms/${vm}/snapshot-schedule`, { frequency: 'weekly', weekday: 1, hour: 2, keep: 2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.timeZone, 'Asia/Jakarta');
  const next = new Date(r.json.schedule.nextRunAt);
  const local = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', hourCycle: 'h23', hour: '2-digit', weekday: 'short' }).formatToParts(next);
  assert.equal(local.find((p) => p.type === 'hour').value, '02');
  assert.equal(local.find((p) => p.type === 'weekday').value, 'Mon');
  assert.ok(next > new Date() && next - new Date() <= 7 * 86_400_000 + 3_600_000);
  const bob = await stack.customerWith('bob@example.com', { limits: {} });
  assert.equal((await bob.put(`/api/vms/${vm}/snapshot-schedule`, { frequency: 'off' })).status, 404);
});

test('runs keep the last N automatic snapshots and never touch the customer\'s own', { timeout: 90_000 }, async () => {
  await snapshot('mine');
  for (let i = 0; i < 3; i += 1) {
    const s = await runNow();
    assert.equal(s.lastStatus, 'ok', s.lastError);
    await new Promise((r) => setTimeout(r, 1100));        // a new second for the next name
  }
  assert.equal(autos().length, 2, 'keep 2');
  assert.ok(snaps().includes('mine'));
  const list = (await rina.get(`/api/vms/${vm}/snapshots`)).json;
  assert.equal(list.filter((x) => x.auto).length, 2);
  assert.equal(list.find((x) => x.name === 'mine').auto, false);
  const jobs = (await admin.get('/api/admin/jobs')).json.jobs;
  assert.ok(jobs.some((j) => j.action === 'Automatic snapshot' && j.state === 'done'));
});

test('when the customer\'s own snapshots use every slot, the run is skipped with the reason', async () => {
  for (const n of autos()) {
    await rina.del(`/api/vms/${vm}/snapshots/${n}`);
  }
  await waitFor(() => (autos().length === 0 ? true : null), { what: 'autos deleted' });
  await snapshot('mine2');
  await snapshot('mine3');
  const s = await runNow();
  assert.equal(s.lastStatus, 'failed');
  assert.match(s.lastError, /All 3 snapshot slots are used by your own snapshots/);
  assert.deepEqual(snaps().sort(), ['mine', 'mine2', 'mine3']);
  // the failure is a job an administrator can retry; while the slots are full it fails again
  const job = () => admin.get('/api/admin/jobs?filter=failed').then((r) => r.json.jobs.find((j) => j.action === 'Automatic snapshot'));
  const failed = await job();
  assert.equal(failed.retry, 'snapshot');
  const again = await admin.post('/api/admin/jobs/retry', { id: failed.id });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /failed again: All 3 snapshot slots/);
  await rina.del(`/api/vms/${vm}/snapshots/mine3`);
  await waitFor(() => (snaps().length === 2 ? true : null), { what: 'one slot free' });
  const ok = await admin.post('/api/admin/jobs/retry', { id: (await job()).id });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(autos().length, 1);
  assert.equal((await schedule()).lastStatus, 'ok');
  assert.equal((await job())?.retry, undefined, 'no longer offered: the latest run worked');
  for (const n of ['mine2', ...autos()]) await rina.del(`/api/vms/${vm}/snapshots/${n}`);
  await waitFor(() => (snaps().length === 1 ? true : null), { what: 'own snapshots deleted' });
  await rina.put(`/api/vms/${vm}/snapshot-schedule`, { frequency: 'off' });
  assert.equal(await schedule(), null);
});

test('after a rollback, volumes and public addresses match the restored configuration', { timeout: 90_000 }, async () => {
  await admin.put('/api/admin/settings/volumes', { enabled: true, tiers: [{ id: 'std', name: 'Standard', pricePerGb: 0 }] });
  await admin.post('/api/admin/ipam/pools', { name: 'P', cidr: '203.0.113.0/29', gateway: '203.0.113.1', bridge: 'vmbr1' });
  await admin.put('/api/admin/settings/ipam', { enabled: true, cooldownHours: 0 });

  await snapshot('base');                                          // no volume, no public IP
  const v = (await rina.post('/api/volumes', { label: 'data', tier: 'std', sizeGb: 5, vmid: vm })).json;
  const ip = (await rina.post(`/api/vms/${vm}/ips`)).json;
  assert.ok(cfg().scsi1 && cfg().net1);
  await rollback('base');
  await waitFor(async () => {
    const vol = (await rina.get('/api/volumes')).json.volumes.find((x) => x.id === v.id);
    return vol && !vol.attached && cfg().net1 ? true : null;
  }, { timeout: 20_000, what: 'sync after rollback' });
  const owned = [...stack.mock.vms.get(vm).owned.keys()];
  assert.ok(Object.entries(cfg()).some(([k, val]) => /^unused\d+$/.test(k) && owned.includes(val)), 'the volume is kept as unused');
  assert.match(cfg().net1, new RegExp(`=${ip.mac},bridge=vmbr1`), 'the public card is back with its MAC');

  // an address released after a snapshot doesn't come back with a rollback
  await snapshot('withip');
  assert.equal((await rina.del(`/api/ips/${ip.id}`)).status, 200);
  assert.equal(cfg().net1, undefined);
  await rollback('withip');
  await waitFor(() => (stack.mock.vms.get(vm).snaps && cfg().net1 === undefined && stack.mock.vms.get(vm).cfg.ipconfig1 === undefined ? true : null), { timeout: 20_000, what: 'stale card removed' });
  assert.equal(cfg().net1, undefined);
});
