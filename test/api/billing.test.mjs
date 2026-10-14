// Billing: prices, invoices with tax, wallet, renewals, Xendit, Midtrans, bank
// transfer and auto-renew, against simulated gateways.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';
import { startMockGateways } from '../support/mock-gateways.mjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

let stack;
let gw;
let admin;
let rina;
const DAY = 86_400_000;
const hook = (gateway, { headers, body }) => fetch(`${stack.customerUrl}/api/billing/webhooks/${gateway}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const expiryOf = async (s, vmid) => (await s.get(`/api/vms/${vmid}`)).json.expiry;
const orderOf = (number) => [...gw.orders.keys()].filter((k) => k.startsWith(number)).at(-1);

before(async () => {
  gw = await startMockGateways();
  stack = await startStack({ env: { PANEL_PUBLIC_URL: '{CUSTOMER_URL}', BILLING_TEST_ENDPOINTS: JSON.stringify(gw.endpoints) }, mail: true });
  admin = await stack.adminSession();
  await admin.put('/api/admin/settings/email', {
    host: '127.0.0.1', port: stack.smtp.port, security: 'none', username: 'panel', password: 'mail-secret',
    fromName: 'Panel', fromAddress: 'panel@example.com', panelUrl: stack.customerUrl,
  });
  rina = await stack.customerWith('rina@example.com');
  await admin.put('/api/admin/vms/101', { userId: rina.userId, label: 'web-prod' });   // 2 vCPU, 4 GB, 20 GB in the mock
  await admin.put('/api/admin/vms/101/expiry', { expiresAt: new Date(Date.now() + 20 * DAY).toISOString() });
});
after(async () => { await stack?.stop(); await gw?.close(); });

test('the owner sets billing up; gateway secrets are sealed and checked', async () => {
  assert.equal((await rina.get('/api/billing')).json.enabled, false);
  assert.equal((await admin.put('/api/admin/settings/billing', { xendit: { enabled: true } })).status, 400, 'no keys');
  assert.equal((await admin.put('/api/admin/settings/billing', { bank: { enabled: true } })).status, 400, 'no instructions');
  const r = await admin.put('/api/admin/settings/billing', {
    enabled: true, taxName: 'PPN', taxRate: 11, company: { name: 'Acme Cloud', address: 'Jakarta', taxId: '01.234.567.8-901.000' },
    rates: { vcpu: 50_000, ramGb: 25_000, diskGb: 1_500, minimum: 50_000 },
    bank: { enabled: true, instructions: 'BCA 123-456-7890 a.n. Acme Cloud' },
    xendit: { enabled: true, secretKey: gw.xenditKey, callbackToken: gw.xenditToken },
    midtrans: { enabled: true, serverKey: gw.midtransKey, sandbox: true },
  });
  assert.equal(r.status, 200, r.text);
  const txt = JSON.stringify(r.json);
  for (const secret of [gw.xenditKey, gw.xenditToken, gw.midtransKey]) assert.equal(txt.includes(secret), false);
  assert.equal(r.json.xendit.webhookUrl, `${stack.customerUrl}/api/billing/webhooks/xendit`);
  const log = (await admin.get('/api/admin/activity?q=admin_billing_settings')).json.events[0];
  assert.equal(log.detail.includes(gw.xenditKey), false, 'secrets are not written to the activity log');
});

test('prices come from the server size; a renewal invoice has the discount and PPN', async () => {
  const o = (await rina.get('/api/billing')).json;
  assert.deepEqual(o.methods, ['wallet', 'xendit', 'midtrans', 'bank']);
  assert.equal(o.servers[0].monthly, 230_000);           // 2×50k + 4×25k + 20×1.5k
  const inv = await rina.post('/api/billing/renewals', { vmid: 101, months: 3 });
  assert.equal(inv.status, 201, inv.text);
  assert.match(inv.json.number, /^INV-\d{6}-0001$/);
  assert.deepEqual(inv.json.lines.map((l) => l.amount), [690_000, -34_500]);
  assert.equal(inv.json.subtotal, 655_500);
  assert.equal(inv.json.tax, 72_105);
  assert.equal(inv.json.total, 727_605);
  assert.equal(inv.json.seller.taxId, '01.234.567.8-901.000');
  const again = await rina.post('/api/billing/renewals', { vmid: 101, months: 3 });
  assert.equal(again.json.number, inv.json.number, 'one open renewal per server');
  assert.equal((await rina.post('/api/billing/invoices/' + inv.json.number + '/pay', { method: 'wallet' })).status, 409, 'wallet is empty');
});

test('Xendit: top-up through the payment page; the webhook is checked and confirmed with the API', async () => {
  assert.equal((await rina.post('/api/billing/topups', { amount: 1000 })).status, 400, 'below the minimum');
  const t = (await rina.post('/api/billing/topups', { amount: 1_000_000 })).json;
  assert.equal(t.tax, 0, 'top-ups are not taxed');
  const p = await rina.post(`/api/billing/invoices/${t.number}/pay`, { method: 'xendit' });
  assert.match(p.json.redirectUrl, /\/checkout\/inv_\d+$/);
  const order = orderOf(t.number);
  const created = gw.calls.find((c) => c.path === '/xendit/v2/invoices' && c.body.external_id === order).body;
  assert.equal(created.amount, 1_000_000);
  assert.equal(created.success_redirect_url, `${stack.customerUrl}/#billing/${t.number}`);

  assert.equal((await hook('xendit', gw.xenditCallback(order, 'wrong-token'))).status, 401);
  // a correct token but not paid at Xendit: nothing happens
  assert.deepEqual(await (await hook('xendit', gw.xenditCallback(order))).json(), { status: 'pending' });
  assert.equal((await rina.get('/api/billing')).json.balance, 0);

  gw.pay(order);
  assert.equal((await hook('xendit', gw.xenditCallback(order))).status, 200);
  assert.equal((await hook('xendit', gw.xenditCallback(order))).status, 200, 'repeated notification');
  const o = (await rina.get('/api/billing')).json;
  assert.equal(o.balance, 1_000_000, 'credited once');
  assert.equal(o.invoices.find((i) => i.number === t.number).status, 'paid');
  const mail = await waitFor(() => stack.smtp.messages.find((m) => m.subject === `Payment received: ${t.number}`), { what: 'receipt' });
  assert.match(mail.text, /added to your wallet/);
});

test('wallet pays the renewal: the end date moves 90 days and the balance goes down', async () => {
  const before = Date.parse((await expiryOf(rina, 101)).expiresAt);
  const inv = (await rina.get('/api/billing')).json.invoices.find((i) => i.purpose === 'renewal' && i.status === 'unpaid');
  const r = await rina.post(`/api/billing/invoices/${inv.number}/pay`, { method: 'wallet' });
  assert.equal(r.json.paid, true);
  const after = Date.parse((await expiryOf(rina, 101)).expiresAt);
  assert.equal(Math.round((after - before) / DAY), 90);
  assert.equal((await rina.get('/api/billing')).json.balance, 1_000_000 - 727_605);
  assert.equal((await rina.post(`/api/billing/invoices/${inv.number}/pay`, { method: 'wallet' })).status, 409, 'already paid');
});

test('Midtrans: signature checked, amount checked, paid once', async () => {
  const inv = (await rina.post('/api/billing/renewals', { vmid: 101, months: 1 })).json;
  assert.equal(inv.total, 255_300);
  const p = await rina.post(`/api/billing/invoices/${inv.number}/pay`, { method: 'midtrans' });
  assert.match(p.json.redirectUrl, /midtrans\.example/);
  const order = orderOf(inv.number);
  const before = Date.parse((await expiryOf(rina, 101)).expiresAt);

  assert.equal((await hook('midtrans', gw.midtransNotification(order, { key: 'not-the-key' }))).status, 401);
  // paid too little at the gateway
  gw.pay(order, { amount: 1000 });
  assert.deepEqual(await (await hook('midtrans', gw.midtransNotification(order))).json(), { status: 'amount mismatch' });
  assert.equal((await rina.get(`/api/billing/invoices/${inv.number}`)).json.status, 'unpaid');

  gw.pay(order);
  assert.deepEqual(await (await hook('midtrans', gw.midtransNotification(order))).json(), { status: 'paid' });
  await hook('midtrans', gw.midtransNotification(order));
  const after = Date.parse((await expiryOf(rina, 101)).expiresAt);
  assert.equal(Math.round((after - before) / DAY), 30, 'extended once');
  const i = (await admin.get(`/api/admin/billing/invoices/${inv.number}`)).json;
  assert.equal(i.paidVia, 'midtrans');
  assert.equal(i.payments.length, 1);
  assert.match(i.payments[0].reference, /qris/);
});

test('paid twice through two gateways: the second payment becomes wallet balance', async () => {
  const inv = (await rina.post('/api/billing/renewals', { vmid: 101, months: 1 })).json;
  await rina.post(`/api/billing/invoices/${inv.number}/pay`, { method: 'xendit' });
  const xo = orderOf(inv.number);
  await rina.post(`/api/billing/invoices/${inv.number}/pay`, { method: 'midtrans' });
  const mo = orderOf(inv.number);
  assert.notEqual(xo, mo);
  const balance = (await rina.get('/api/billing')).json.balance;
  gw.pay(xo); gw.pay(mo);
  await hook('xendit', gw.xenditCallback(xo));
  await hook('midtrans', gw.midtransNotification(mo));
  await hook('midtrans', gw.midtransNotification(mo));
  assert.equal((await rina.get('/api/billing')).json.balance, balance + inv.total, 'the extra money is not lost, and only once');
});

test('bank transfer: the customer reports it, an administrator confirms; an expired server runs again', async () => {
  // a date in the past can't be set through the API; write it like the expiry tests do
  const dbh = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  dbh.prepare('UPDATE vms SET expires_at = ? WHERE vmid = 101').run(new Date(Date.now() - DAY).toISOString());
  dbh.close();
  const run = (await admin.post('/api/admin/expiry/run')).json;
  assert.equal((await expiryOf(rina, 101)).expired, true, JSON.stringify(run));
  const inv = (await rina.post('/api/billing/renewals', { vmid: 101, months: 1 })).json;
  const b = (await rina.post(`/api/billing/invoices/${inv.number}/pay`, { method: 'bank', reference: 'BCA 14/10 09:12' })).json;
  assert.match(b.bank.instructions, /BCA 123-456-7890/);
  assert.equal(b.reported, true);
  const listed = (await admin.get('/api/admin/billing?status=reported')).json.invoices;
  assert.deepEqual(listed.map((i) => i.number), [inv.number]);
  assert.equal(listed[0].customerRef, 'BCA 14/10 09:12');
  assert.equal((await admin.post(`/api/admin/billing/invoices/${inv.number}/mark-paid`, { reference: 'x' })).status, 400);
  const paid = await admin.post(`/api/admin/billing/invoices/${inv.number}/mark-paid`, { reference: 'BCA mutasi 14/10' });
  assert.equal(paid.json.status, 'paid');
  const e = await expiryOf(rina, 101);
  assert.equal(e.expired, false, 'running again');
  assert.ok(Date.parse(e.expiresAt) > Date.now() + 29 * DAY);
});

test('auto-renew pays from the wallet before the end date, or emails when the balance is short', async () => {
  assert.equal((await rina.put('/api/billing/servers/101/auto-renew', { enabled: true })).json.autoRenew, true);
  await admin.put('/api/admin/vms/101/expiry', { expiresAt: new Date(Date.now() + 2 * DAY).toISOString() });
  const balance = (await rina.get('/api/billing')).json.balance;
  const r1 = (await admin.post('/api/admin/billing/auto-renew/run')).json;
  assert.equal(r1.renewed, 1);
  assert.equal((await rina.get('/api/billing')).json.balance, balance - 255_300);
  assert.ok(Date.parse((await expiryOf(rina, 101)).expiresAt) > Date.now() + 31 * DAY);

  // not enough left: one email, an open invoice
  const { userId } = rina;
  await admin.post(`/api/admin/billing/wallets/${userId}`, { amount: -(balance - 255_300), reason: 'Test: empty the wallet' });
  await admin.put('/api/admin/vms/101/expiry', { expiresAt: new Date(Date.now() + DAY).toISOString() });
  const r2 = (await admin.post('/api/admin/billing/auto-renew/run')).json;
  assert.equal(r2.short, 1);
  await admin.post('/api/admin/billing/auto-renew/run');
  await waitFor(() => stack.smtp.messages.some((m) => /not enough balance/.test(m.subject)), { what: 'short-balance email' });
  assert.equal(stack.smtp.messages.filter((m) => /not enough balance/.test(m.subject)).length, 1, 'only once');
});

test('admin: fixed price, cancel, wallet adjustments with a reason; finance role; privacy', async () => {
  assert.equal((await admin.put('/api/admin/billing/servers/101/price', { priceMonthly: 99_000 })).status, 200);
  assert.equal((await rina.get('/api/billing')).json.servers[0].monthly, 99_000);
  const inv = (await rina.post('/api/billing/renewals', { vmid: 101, months: 12 })).json;
  assert.equal(inv.subtotal, 99_000 * 12 - Math.round(99_000 * 12 * 0.15));
  assert.equal((await admin.post(`/api/admin/billing/invoices/${inv.number}/void`, { reason: '' })).status, 400);
  assert.equal((await admin.post(`/api/admin/billing/invoices/${inv.number}/void`, { reason: 'Customer asked' })).json.status, 'void');
  assert.equal((await rina.post(`/api/billing/invoices/${inv.number}/pay`, { method: 'wallet' })).status, 409);
  assert.equal((await admin.post(`/api/admin/billing/wallets/${rina.userId}`, { amount: -99_000_000, reason: 'too much' })).status, 409);

  const bob = await stack.customerWith('bob@example.com');
  assert.equal((await bob.get(`/api/billing/invoices/${inv.number}`)).status, 404);
  assert.equal((await bob.post('/api/billing/renewals', { vmid: 101, months: 1 })).status, 404);

  const f = await admin.post('/api/admin/users', { email: 'finance@example.com', password: 'finance-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((r) => r.key === 'finance').id;
  await admin.put(`/api/admin/rbac/admins/${f.json.id}`, { roleId: role });
  const fin = stack.admin();
  await fin.post('/api/auth/login', { email: 'finance@example.com', password: 'finance-password-1' });
  assert.equal((await fin.get('/api/admin/billing')).status, 200);
  assert.equal((await fin.post(`/api/admin/billing/wallets/${rina.userId}`, { amount: 10_000, reason: 'Goodwill credit' })).status, 200);
  assert.equal((await fin.put('/api/admin/settings/billing', { taxRate: 0 })).status, 403, 'settings are for owners');
  const k = (await admin.get('/api/admin/billing')).json.kpis;
  assert.ok(k.revenueMonth > 0 && k.taxMonth > 0);
});
