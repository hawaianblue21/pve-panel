// Plans: sizes with a monthly price. Without billing they are size presets; with
// billing the first period is paid from the wallet before the server is set up,
// refunded if setup fails, and a server moves up to a larger plan for the difference.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let dina;
const DAY = 86_400_000;
const plans = {};
let n = 0;
const create = (s, body) => s.post('/api/vms', {
  hostname: `plan-${++n}`, templateId: 9000, username: 'dina', password: 'supersecret-123', ...body,
});
const created = async (s, body) => {
  const r = await create(s, body);
  assert.equal(r.status, 202, r.text);
  assert.equal((await stack.serverSettled(s, r.json.vmid)).state, 'ready');
  return r.json.vmid;
};
const balance = async () => (await dina.get('/api/billing')).json.balance;

before(async () => {
  stack = await startStack({ env: { EXPIRY_CHECK_SECONDS: '0' } });
  admin = await stack.adminSession();
  await stack.offerTemplates();
  dina = await stack.customerWith('dina@example.com', { limits: {} });
});
after(async () => { await stack?.stop(); });

test('the owner defines plans; sizes are checked', async () => {
  assert.equal((await admin.post('/api/admin/plans', { name: 'Odd', cores: 1, memoryMb: 1000, diskGb: 20 })).status, 400, 'memory in 256 MB steps');
  assert.equal((await admin.post('/api/admin/plans', { name: 'GPU', cores: 4, memoryMb: 8192, diskGb: 50, gpuProfileId: 999 })).status, 400, 'unknown GPU');
  assert.equal((await admin.put('/api/admin/settings/plans', { requirePlan: true })).status, 400, 'no plan yet');
  for (const [key, p] of Object.entries({
    S: { name: 'Small', cores: 1, memoryMb: 1024, diskGb: 20, priceMonthly: 100_000, sort: 1 },
    M: { name: 'Medium', cores: 2, memoryMb: 2048, diskGb: 40, priceMonthly: 180_000, sort: 2 },
    Free: { name: 'Trial', cores: 1, memoryMb: 1024, diskGb: 10, sort: 0 },
  })) {
    const r = await admin.post('/api/admin/plans', p);
    assert.equal(r.status, 201, r.text);
    plans[key] = r.json;
  }
  const list = (await admin.get('/api/admin/plans')).json.plans;
  assert.deepEqual(list.map((p) => p.name), ['Trial', 'Small', 'Medium']);
});

test('without billing a plan is a size preset; with "plans only" a custom size is refused', async () => {
  const p = (await dina.get('/api/plans')).json;
  assert.equal(p.billing.enabled, false);
  assert.equal(p.plans.every((x) => !x.billed && !x.prices), true);
  const vmid = await created(dina, { planId: plans.M.id, cores: 16, memoryMb: 32768, diskGb: 300 });   // size from the plan
  const v = (await dina.get(`/api/vms/${vmid}`)).json;
  assert.deepEqual([v.cores, v.memoryMb, v.diskGb], [2, 2048, 40]);
  assert.deepEqual(v.plan, { id: plans.M.id, name: 'Medium' });
  assert.equal(v.resizable, false);
  assert.equal((await dina.post(`/api/vms/${vmid}/resize`, { cores: 4 })).status, 409, 'plan servers change plan instead');

  assert.equal((await admin.put('/api/admin/settings/plans', { requirePlan: true })).json.requirePlan, true);
  assert.equal((await create(dina, { cores: 1, memoryMb: 1024, diskGb: 10 })).status, 400);
  await admin.put('/api/admin/settings/plans', { requirePlan: false });
});

test('with billing: the first period is paid from the wallet before the server exists', async () => {
  await admin.put('/api/admin/settings/billing', { enabled: true });
  const p = (await dina.get('/api/plans')).json;
  const small = p.plans.find((x) => x.id === plans.S.id);
  assert.equal(small.billed, true);
  assert.equal(small.prices[1].total, 111_000);
  assert.equal(small.prices[3].total, 316_350);                 // 300.000 − 5% = 285.000 + PPN 31.350
  assert.equal(p.plans.find((x) => x.id === plans.Free.id).billed, false);

  const vmsBefore = (await dina.get('/api/vms')).json.length;
  const poor = await create(dina, { planId: plans.S.id, months: 3 });
  assert.equal(poor.status, 402);
  assert.match(poor.json.error, /Top up/);
  assert.equal((await dina.get('/api/vms')).json.length, vmsBefore, 'nothing created');
  assert.equal((await dina.get('/api/billing')).json.invoices.length, 0, 'no invoice either');

  await admin.post(`/api/admin/billing/wallets/${dina.userId}`, { amount: 1_000_000, reason: 'Test credit' });
  const vmid = await created(dina, { planId: plans.S.id, months: 3 });
  assert.equal(await balance(), 1_000_000 - 316_350);
  const inv = (await dina.get('/api/billing')).json.invoices[0];
  assert.equal(inv.purpose, 'order');
  assert.equal(inv.status, 'paid');
  assert.equal(inv.vmid, vmid);
  assert.match(inv.lines[0].description, /plan Small \(1 vCPU, 1 GB RAM, 20 GB disk\) · 3 months/);
  const e = (await dina.get(`/api/vms/${vmid}`)).json.expiry;
  assert.equal(Math.round((Date.parse(e.expiresAt) - Date.now()) / DAY), 90);

  // renewals use the plan's price
  const r = (await dina.post('/api/billing/renewals', { vmid, months: 1 })).json;
  assert.equal(r.subtotal, 100_000);
  assert.match(r.lines[0].description, /plan Small/);
  plans.vmid = vmid;
});

test('upgrade to a larger plan: the difference for the days left, then the server grows', async () => {
  const vmid = plans.vmid;
  const o = (await dina.get(`/api/vms/${vmid}/plans`)).json;
  assert.equal(o.current.name, 'Small');
  assert.deepEqual(o.options.map((x) => x.name), ['Medium'], 'only larger plans');
  const cost = o.options[0].cost;
  assert.equal(cost.perMonth, 80_000);
  assert.ok(cost.days >= 89 && cost.days <= 90);
  const expected = Math.ceil((80_000 * cost.days) / 30 / 1000) * 1000;
  assert.equal(cost.total, expected + Math.round(expected * 0.11));

  assert.equal((await dina.post(`/api/vms/${vmid}/plan`, { planId: plans.Free.id })).status, 400, 'not smaller');
  const before = await balance();
  const r = await dina.post(`/api/vms/${vmid}/plan`, { planId: plans.M.id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.after, { cores: 2, memoryMb: 2048, diskGb: 40 });
  assert.equal(await balance(), before - cost.total);
  const v = (await dina.get(`/api/vms/${vmid}`)).json;
  assert.equal(v.plan.name, 'Medium');
  assert.equal(v.diskGb, 40);
  const inv = (await dina.get('/api/billing')).json.invoices.find((i) => i.purpose === 'upgrade');
  assert.equal(inv.total, cost.total);
  assert.equal((await dina.get(`/api/vms/${vmid}/plans`)).json.options.length, 0, 'nothing larger left');
  // the open renewal at the old price was cancelled; a new one has the new price
  const open = (await dina.get('/api/billing')).json.invoices.filter((i) => i.purpose === 'renewal' && i.status === 'unpaid');
  assert.equal(open.length, 0);
  assert.equal((await dina.post('/api/billing/renewals', { vmid, months: 1 })).json.subtotal, 180_000);
});

test('setup fails: the order goes back to the wallet', async () => {
  const before = await balance();
  await stack.mock.control('/__failclone/1');
  const r = await create(dina, { planId: plans.S.id, months: 1 });
  assert.equal(r.status, 202, r.text);
  assert.equal((await stack.serverSettled(dina, r.json.vmid)).state, 'failed');
  await waitFor(async () => (await balance()) === before, { what: 'refund' });
  const inv = (await dina.get('/api/billing')).json.invoices.find((i) => i.vmid === r.json.vmid);
  assert.equal(inv.status, 'refunded');
  assert.equal((await dina.post('/api/billing/renewals', { vmid: r.json.vmid, months: 1 })).status, 409);
  const log = (await admin.get(`/api/admin/billing/invoices/${inv.number}`)).json;
  assert.match(log.note, /refunded: the server could not be set up/);
});

test('changing and retiring plans', async () => {
  assert.equal((await admin.put(`/api/admin/plans/${plans.M.id}`, { cores: 4 })).status, 409, 'in use: size is fixed');
  assert.equal((await admin.del(`/api/admin/plans/${plans.M.id}`)).status, 409, 'in use: deactivate instead');
  const p = await admin.put(`/api/admin/plans/${plans.M.id}`, { priceMonthly: 200_000 });
  assert.equal(p.json.priceMonthly, 200_000);
  assert.equal((await dina.post('/api/billing/renewals', { vmid: plans.vmid, months: 1 })).json.subtotal, 200_000, 'new price from the next invoice');

  await admin.put(`/api/admin/plans/${plans.S.id}`, { active: false });
  assert.equal((await dina.get('/api/plans')).json.plans.some((x) => x.id === plans.S.id), false);
  assert.equal((await create(dina, { planId: plans.S.id })).status, 400);

  // finance may change plans, read-only support may not
  const f = await admin.post('/api/admin/users', { email: 'fin@example.com', password: 'finance-password-1', isAdmin: true });
  const roles = (await admin.get('/api/admin/rbac')).json.roles;
  await admin.put(`/api/admin/rbac/admins/${f.json.id}`, { roleId: roles.find((r) => r.key === 'support').id });
  const ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'fin@example.com', password: 'finance-password-1' });
  assert.equal((await ro.get('/api/admin/plans')).status, 200);
  assert.equal((await ro.post('/api/admin/plans', { name: 'X', cores: 1, memoryMb: 1024, diskGb: 10 })).status, 403);
  await admin.put(`/api/admin/rbac/admins/${f.json.id}`, { roleId: roles.find((r) => r.key === 'finance').id });
  assert.equal((await ro.put(`/api/admin/plans/${plans.Free.id}`, { description: 'For trying out' })).status, 200);
});
