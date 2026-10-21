// Server expiry: rules, reminders, stop, self-extension, grace period, deletion,
// and the safety rules (assigned servers, pause, no deletion without warning).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, waitFor } from '../support/stack.mjs';

const DAY = 86_400_000;
let stack;
let admin;
let trial;      // customer with an expiry rule
let a;          // trial's first server (full lifecycle)
let b;          // trial's second server (pause test)
let dbh;
const iso = (ms) => new Date(ms).toISOString();
const setVm = (vmid, fields) => {
  const keys = Object.keys(fields);
  dbh.prepare(`UPDATE vms SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE vmid = ?`).run(...keys.map((k) => fields[k]), vmid);
};
const vmRow = (vmid) => dbh.prepare('SELECT * FROM vms WHERE vmid = ?').get(vmid);
const run = async () => (await admin.post('/api/admin/expiry/run')).json;
const mailsTo = (to, re) => stack.smtp.messages.filter((m) => m.to === to && (!re || re.test(m.subject)));
const create = async (s, hostname) => {
  const r = await s.post('/api/vms', { hostname, templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'u', password: 'supersecret-123' });
  assert.equal(r.status, 202, r.text);
  assert.equal((await stack.serverSettled(s, r.json.vmid)).state, 'ready');
  return r.json.vmid;
};

before(async () => {
  stack = await startStack({ mail: true, env: { EXPIRY_CHECK_SECONDS: '0' } }); // tests trigger checks themselves
  dbh = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  admin = await stack.adminSession();
  await admin.put('/api/admin/settings/email', {
    host: '127.0.0.1', port: stack.smtp.port, security: 'none', username: 'panel', password: 'mail-secret',
    fromName: 'PVE Panel', fromAddress: 'panel@example.com', panelUrl: stack.customerUrl,
  });
  await stack.offerTemplates();
  trial = await stack.customerWith('trial@example.com', { limits: {} });
  const r = await admin.patch(`/api/admin/users/${trial.userId}`, { expiryMode: 'after_creation', expiryDays: 14, expirySelfExtend: true });
  assert.equal(r.status, 200, r.text);
});
after(async () => { dbh?.close(); await stack?.stop(); });

test('new servers of a customer with a rule get an expiry date; others none', async () => {
  a = await create(trial, 'trial-a');
  const exp = (await trial.get(`/api/vms/${a}`)).json.expiry;
  assert.ok(Math.abs(Date.parse(exp.expiresAt) - (Date.now() + 14 * DAY)) < 60_000, 'about 14 days from now');
  assert.equal(exp.expired, false);
  assert.equal(exp.canExtend, true);

  const normal = await stack.customerWith('normal@example.com', { limits: {} });
  const n = await create(normal, 'normal-1');
  assert.equal((await normal.get(`/api/vms/${n}`)).json.expiry, null);
});

test('reminder once, at the right time; none if the date was set too late for it', async () => {
  setVm(a, { expires_at: iso(Date.now() + 6 * DAY), expiry_set_at: iso(Date.now() - 8 * DAY) });
  await run();
  await waitFor(() => mailsTo('trial@example.com', /expires in 6 days/).length === 1, { what: '7-day reminder' });
  await run();
  assert.equal(mailsTo('trial@example.com', /expires in/).length, 1, 'no duplicate');

  // a server that only lives 3 days gets no "7 days" reminder
  setVm(a, { expires_at: iso(Date.now() + 3 * DAY), expiry_set_at: iso(Date.now()), expiry_notified: null });
  const before = mailsTo('trial@example.com', /expires in/).length;
  await run();
  assert.equal(mailsTo('trial@example.com', /expires in/).length, before);
});

test('at expiry: stopped, the customer is told and cannot start it', async () => {
  await trial.post(`/api/vms/${a}/power/start`);
  await waitFor(() => stack.mock.vms.get(a).status === 'running', { what: 'running' });
  setVm(a, { expires_at: iso(Date.now() - 60_000) });
  const r = await run();
  assert.ok(r.stopped.some((x) => x.includes(String(a))), JSON.stringify(r));
  assert.equal(stack.mock.vms.get(a).status, 'stopped');
  await waitFor(() => mailsTo('trial@example.com', /has expired/).length === 1, { what: 'expired mail' });
  assert.match(mailsTo('trial@example.com', /has expired/)[0].text, /will be deleted/);

  const detail = (await trial.get(`/api/vms/${a}`)).json;
  assert.equal(detail.expiry.expired, true);
  assert.ok(detail.expiry.deleteAt, 'deletion date shown');
  assert.equal((await trial.post(`/api/vms/${a}/power/start`)).status, 403);
  assert.equal((await trial.post(`/api/vms/${a}/resize`, { cores: 2 })).status, 403);
});

test('the customer can extend once, which makes the server usable again', async () => {
  const r = await trial.post(`/api/vms/${a}/extend`);
  assert.equal(r.status, 200, r.text);
  assert.ok(Date.parse(r.json.expiresAt) > Date.now() + 13 * DAY);
  assert.equal((await trial.get(`/api/vms/${a}`)).json.expiry.expired, false);
  assert.equal((await trial.post(`/api/vms/${a}/power/start`)).status, 200);
  assert.equal((await trial.post(`/api/vms/${a}/extend`)).status, 403, 'only once');
});

test('after the grace period a customer-created server is deleted, with a final email', async () => {
  setVm(a, { expires_at: iso(Date.now() - 60_000) });
  await run();                                                   // expired again
  assert.ok(vmRow(a).expired_at);
  setVm(a, { expired_at: iso(Date.now() - 13.5 * DAY) });        // last day of grace
  await run();
  await waitFor(() => mailsTo('trial@example.com', /Last notice/).length === 1, { what: 'final warning' });
  setVm(a, { expired_at: iso(Date.now() - 15 * DAY) });
  const r = await run();
  assert.ok(r.deleted.some((x) => x.includes(String(a))), JSON.stringify(r));
  assert.equal(stack.mock.vms.has(a), false, 'destroyed in Proxmox');
  assert.equal(vmRow(a), undefined);
  await waitFor(() => mailsTo('trial@example.com', /was deleted/).length === 1, { what: 'deleted mail' });
});

test('servers you assigned are stopped at expiry but never deleted automatically', async () => {
  await admin.put('/api/admin/vms/101', { userId: trial.userId });
  const r = await admin.put('/api/admin/vms/101/expiry', { expiresAt: iso(Date.now() + DAY) });
  assert.equal(r.status, 200, r.text);
  setVm(101, { expires_at: iso(Date.now() - 60_000) });
  await run();
  setVm(101, { expired_at: iso(Date.now() - 100 * DAY) });
  const s = await run();
  assert.ok(s.awaitingAdmin.some((x) => x.includes('101')));
  assert.equal(stack.mock.vms.has(101), true);
  // admin removes the expiry: back to normal
  await admin.put('/api/admin/vms/101/expiry', { expiresAt: null });
  assert.equal(vmRow(101).expires_at, null);
  assert.equal(vmRow(101).expired_at, null);
});

test('"pause deletions" only stops; dates in the past are refused', async () => {
  b = await create(trial, 'trial-b');
  await admin.put('/api/admin/settings/expiry', { pauseDeletions: true });
  setVm(b, { expires_at: iso(Date.now() - 60_000) });
  await run();
  setVm(b, { expired_at: iso(Date.now() - 30 * DAY) });
  const s = await run();
  assert.ok(s.paused.some((x) => x.includes(String(b))));
  assert.equal(stack.mock.vms.has(b), true);
  assert.equal((await admin.put(`/api/admin/vms/${b}/expiry`, { expiresAt: iso(Date.now() - DAY) })).status, 400);
  await admin.put('/api/admin/settings/expiry', { pauseDeletions: false });
});

test('nothing is deleted when the customer could not be warned (no email)', async () => {
  await admin.del('/api/admin/settings/email');
  setVm(b, { expires_at: iso(Date.now() + DAY), expired_at: null, expiry_notified: null });
  setVm(b, { expires_at: iso(Date.now() - 60_000) });
  await run();                                                   // expired, but no email possible
  setVm(b, { expired_at: iso(Date.now() - 30 * DAY) });
  const s = await run();
  assert.ok(s.blocked.some((x) => x.includes(String(b))), JSON.stringify(s));
  assert.equal(stack.mock.vms.has(b), true);
});

test('the lifecycle queue shows each server\'s stage and next step', async () => {
  const q = async () => (await admin.get('/api/admin/expiry/queue')).json;
  let r = await q();
  const held = r.items.find((i) => i.vmid === b);
  assert.equal(held.stage, 'due');
  assert.match(held.next, /not warned by email/);
  assert.equal(held.source, 'Created by customer');
  assert.equal(r.counts.due, 1);

  await admin.put('/api/admin/settings/expiry', { pauseDeletions: true });
  assert.match((await q()).items.find((i) => i.vmid === b).next, /deletions are paused/);
  await admin.put('/api/admin/settings/expiry', { pauseDeletions: false });

  await admin.put('/api/admin/vms/101/expiry', { expiresAt: iso(Date.now() + 3 * DAY) });
  r = await q();
  const soon = r.items.find((i) => i.vmid === 101);
  assert.deepEqual([soon.stage, soon.source, soon.manual], ['soon', 'Assigned by administrator', true]);
  assert.equal(soon.next, 'Reminder 1 day before', 'the 7-day reminder lies before the date was set');
  assert.equal(r.counts.soon, 1);

  setVm(101, { expired_at: iso(Date.now() - DAY) });
  assert.equal((await q()).items.find((i) => i.vmid === 101).stage, 'stopped');
  await admin.put('/api/admin/vms/101/expiry', { expiresAt: null });
  assert.equal((await q()).items.some((i) => i.vmid === 101), false);

  const u = await admin.post('/api/admin/users', { email: 'ro2@example.com', password: 'readonly-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((x) => x.key === 'support').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  const ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'ro2@example.com', password: 'readonly-password-1' });
  assert.equal((await ro.get('/api/admin/expiry/queue')).status, 200, 'read-only admins see the queue');
  assert.equal((await ro.put('/api/admin/vms/101/expiry', { extendDays: 7 })).status, 403);
});

test('a fixed end date applies to all servers of the customer, also assigned ones', async () => {
  const date = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
  const r = await admin.patch(`/api/admin/users/${trial.userId}`, { expiryMode: 'fixed_date', expiryDate: date });
  assert.equal(r.status, 200, r.text);
  await admin.put('/api/admin/vms/102', { userId: trial.userId });
  const servers = (await admin.get('/api/admin/vms')).json.filter((v) => v.userId === trial.userId);
  for (const v of servers) {
    if (v.expiryManual) continue;
    assert.equal(v.expiry.expiresAt.slice(0, 10), new Date(`${date}T23:59:59`).toISOString().slice(0, 10), `server ${v.vmid}`);
  }
  // removing the rule removes rule-based dates
  await admin.patch(`/api/admin/users/${trial.userId}`, { expiryMode: null });
  assert.equal(vmRow(102).expires_at, null);
});
