// Dunning: renewal invoices issued before the end date, reminders by email, the wallet
// charged on the due date, a few days' hold before the server stops, pausing, "don't
// renew", and refunds (wallet or recorded outside the panel).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
let rina;
const VM = 101;
const DAY = 86_400_000;
const PRICE = 255_300;                                   // 2 vCPU, 4 GB, 20 GB + PPN 11 %
const sql = (q, ...a) => { const d = new DatabaseSync(path.join(stack.dir, 'panel.db')); try { return d.prepare(q).run(...a); } finally { d.close(); } };
const iso = (ms) => new Date(ms).toISOString();
const run = async () => (await admin.post('/api/admin/billing/dunning/run')).json;
const lifecycle = async () => (await admin.post('/api/admin/expiry/run')).json;
const expiry = async () => (await rina.get(`/api/vms/${VM}`)).json.expiry;
const mails = (re) => stack.smtp.messages.filter((m) => re.test(m.subject));
const openInvoice = async () => (await admin.get(`/api/admin/billing?status=unpaid&q=${VM}`)).json.invoices.find((i) => i.purpose === 'renewal');
/** Moves the server's end date and its open renewal's due date to `at`. */
const moveTo = (at) => { sql('UPDATE vms SET expires_at = ? WHERE vmid = ?', iso(at), VM); sql("UPDATE invoices SET due_at = ? WHERE vmid = ? AND status = 'unpaid'", iso(at), VM); };

before(async () => {
  stack = await startStack({ env: { EXPIRY_CHECK_SECONDS: '0' }, mail: true });
  admin = await stack.adminSession();
  await admin.put('/api/admin/settings/email', {
    host: '127.0.0.1', port: stack.smtp.port, security: 'none', username: 'panel', password: 'mail-secret',
    fromName: 'Panel', fromAddress: 'panel@example.com', panelUrl: stack.customerUrl,
  });
  rina = await stack.customerWith('rina@example.com');
  await admin.put(`/api/admin/vms/${VM}`, { userId: rina.userId, label: 'web-prod' });
  const b = await admin.put('/api/admin/settings/billing', {
    enabled: true, taxName: 'PPN', taxRate: 11, rates: { vcpu: 50_000, ramGb: 25_000, diskGb: 1_500, minimum: 50_000 },
    bank: { enabled: true, instructions: 'Bank transfer to Example Bank 000-000' },
  });
  assert.equal(b.status, 200, b.text);
});
after(async () => { await stack?.stop(); });

test('settings: reminders not before the invoice, a hold of at most 14 days', async () => {
  const s = (await admin.get('/api/admin/settings/billing')).json.dunning;
  assert.deepEqual(s, { enabled: true, issueDaysBefore: 7, reminderDays: [7, 1], autoCharge: true, suspendAfterDays: 3 });
  assert.equal((await admin.put('/api/admin/settings/billing', { dunning: { reminderDays: [10] } })).status, 400);
  assert.equal((await admin.put('/api/admin/settings/billing', { dunning: { suspendAfterDays: 15 } })).status, 400);
});

test('within 7 days of the end date: a renewal invoice due on it, with the first reminder, once', async () => {
  await admin.put(`/api/admin/vms/${VM}/expiry`, { expiresAt: iso(Date.now() + 20 * DAY) });
  assert.equal((await run()).issued, 0, 'too early');
  const end = Date.now() + 5 * DAY;
  await admin.put(`/api/admin/vms/${VM}/expiry`, { expiresAt: iso(end) });
  const r = await run();
  assert.equal(r.issued, 1);
  assert.equal(r.reminded, 1);
  const inv = await openInvoice();
  assert.equal(inv.total, PRICE);
  assert.equal(Date.parse(inv.dueAt), Date.parse((await expiry()).expiresAt), 'due on the end date');
  assert.equal(inv.auto, true);
  await waitFor(() => (mails(new RegExp(`Invoice ${inv.number} for web-prod`)).length ? true : null), { what: 'the invoice email' });
  const again = await run();
  assert.equal(again.issued + again.reminded, 0, 'nothing twice');
  const e = await expiry();
  assert.equal(e.invoice.number, inv.number);
  assert.equal(e.invoice.overdue, false);
  // the lifecycle doesn't send its own reminder for it
  await lifecycle();
  assert.equal(mails(/expires in/).length, 0);
  const q = (await admin.get('/api/admin/expiry/queue')).json.items.find((x) => x.vmid === VM);
  assert.match(q.next, new RegExp(`Invoice ${inv.number} open`));
});

test('the day before: the last reminder; on the due date with a short wallet: overdue, kept running 3 days', async () => {
  const inv = await openInvoice();
  moveTo(Date.now() + 12 * 3600_000);
  assert.equal((await run()).reminded, 1);
  await waitFor(() => (mails(/Last reminder/).length ? true : null), { what: 'the last reminder' });

  moveTo(Date.now() - 3600_000);
  const r = await run();
  assert.equal(r.overdue, 1);
  assert.equal(r.charged, 0);
  await waitFor(() => (mails(new RegExp(`Overdue: ${inv.number}`)).length ? true : null), { what: 'the overdue email' });
  await lifecycle();
  let e = await expiry();
  assert.equal(e.expired, false, 'still running in the 3 days');
  assert.equal(e.invoice.overdue, true);
  assert.ok(Math.abs(Date.parse(e.invoice.stopAt) - (Date.now() + 3 * DAY - 3600_000)) < 60_000);
  assert.equal((await admin.get('/api/admin/billing')).json.dunning.stages.overdue.count, 1);

  moveTo(Date.now() - 4 * DAY);
  await lifecycle();
  e = await expiry();
  assert.equal(e.expired, true, 'stopped after the hold');
  assert.equal((await admin.get('/api/admin/billing')).json.dunning.stages.suspended.count, 1);
  const tl = (await admin.get(`/api/admin/billing/invoices/${inv.number}`)).json.dunning.events.map((x) => x.k);
  assert.deepEqual(tl, ['issued', 'r7', 'r1', 'due']);
});

test('on the due date with enough balance: paid from the wallet; the new period follows the old end date', async () => {
  const old = await openInvoice();
  await admin.post(`/api/admin/billing/invoices/${old.number}/void`, { reason: 'test reset' });
  const end = Date.now() + 5 * DAY;
  await admin.put(`/api/admin/vms/${VM}/expiry`, { expiresAt: iso(end) });
  await admin.post(`/api/admin/billing/wallets/${rina.userId}`, { amount: 1_000_000, reason: 'Credit' });
  assert.equal((await run()).issued, 1);
  const inv = await openInvoice();
  const due = Date.now() - 3600_000;
  moveTo(due);
  const r = await run();
  assert.equal(r.charged, 1);
  assert.equal((await rina.get(`/api/billing/invoices/${inv.number}`)).json.status, 'paid');
  assert.equal((await rina.get('/api/billing')).json.balance, 1_000_000 - PRICE);
  const e = await expiry();
  assert.ok(Math.abs(Date.parse(e.expiresAt) - (due + 30 * DAY)) < 60_000, 'from the old end date, not from now');
  assert.equal(e.invoice, null);
});

test('an administrator pauses dunning (not stopped, no emails) and sends a reminder by hand', async () => {
  await admin.put(`/api/admin/vms/${VM}/expiry`, { expiresAt: iso(Date.now() + 5 * DAY) });
  await admin.post(`/api/admin/billing/wallets/${rina.userId}`, { amount: -(1_000_000 - PRICE), reason: 'Back to zero' });
  await run();
  const inv = await openInvoice();
  assert.equal((await admin.post(`/api/admin/billing/invoices/${inv.number}/dunning`, { paused: true })).json.paused, true);
  moveTo(Date.now() - 5 * DAY);
  const before = mails(/Overdue/).length;
  assert.equal((await run()).overdue, 0, 'paused: no overdue step');
  await lifecycle();
  assert.equal((await expiry()).expired, false, 'paused: not stopped');
  assert.equal((await admin.get('/api/admin/billing')).json.dunning.stages.paused.count, 1);

  const m = await admin.post(`/api/admin/billing/invoices/${inv.number}/reminder`);
  assert.equal(m.status, 200, m.text);
  await waitFor(() => (mails(/Overdue/).length > before ? true : null), { what: 'the manual reminder' });

  await admin.post(`/api/admin/billing/invoices/${inv.number}/dunning`, { paused: false });
  await lifecycle();
  assert.equal((await expiry()).expired, true, 'resumed: stopped (the hold is over)');
  const ev = (await admin.get(`/api/admin/billing/invoices/${inv.number}`)).json.dunning.events.map((x) => x.k);
  assert.ok(['paused', 'manual', 'resumed'].every((k) => ev.includes(k)));
});

test('"don\'t renew": the open renewal is cancelled, no new one is issued; auto-renew undoes it', async () => {
  await admin.put(`/api/admin/vms/${VM}/expiry`, { expiresAt: iso(Date.now() + 5 * DAY) });
  const inv = await openInvoice();
  const r = await rina.put(`/api/billing/servers/${VM}/renew`, { cancelled: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.voided, 1);
  assert.equal((await rina.get(`/api/billing/invoices/${inv.number}`)).json.status, 'void');
  assert.equal((await run()).issued, 0);
  assert.equal((await rina.get('/api/billing')).json.servers.find((s) => s.vmid === VM).renewCancelled, true);
  assert.equal((await expiry()).renewCancelled, true);
  await rina.put(`/api/billing/servers/${VM}/auto-renew`, { enabled: true });
  assert.equal((await expiry()).renewCancelled, false);
  await rina.put(`/api/billing/servers/${VM}/auto-renew`, { enabled: false });
});

test('refunds: to the wallet, or recorded with the reference of a refund made outside the panel', async () => {
  const paid = (await admin.get('/api/admin/billing?status=paid')).json.invoices.find((i) => i.purpose === 'renewal');
  assert.ok(paid);
  assert.equal((await admin.post(`/api/admin/billing/invoices/${paid.number}/refund`, { via: 'wallet', reason: 'x' })).status, 400, 'reason needed');
  const before = (await rina.get('/api/billing')).json.balance;
  const r = await admin.post(`/api/admin/billing/invoices/${paid.number}/refund`, { via: 'wallet', reason: 'Service outage' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'refunded');
  assert.equal(r.json.refundVia, 'wallet');
  assert.equal((await rina.get('/api/billing')).json.balance, before + paid.total);
  assert.equal((await admin.post(`/api/admin/billing/invoices/${paid.number}/refund`, { via: 'wallet', reason: 'again' })).status, 409);

  // a top-up paid at a gateway: refunded there, recorded here
  const t = (await rina.post('/api/billing/topups', { amount: 100_000 })).json;
  await admin.post(`/api/admin/billing/invoices/${t.number}/mark-paid`, { reference: 'BCA 21/10' });
  assert.equal((await admin.post(`/api/admin/billing/invoices/${t.number}/refund`, { via: 'wallet', reason: 'Paid twice' })).status, 400);
  assert.equal((await admin.post(`/api/admin/billing/invoices/${t.number}/refund`, { via: 'external', reason: 'Paid twice' })).status, 400, 'reference needed');
  const x = await admin.post(`/api/admin/billing/invoices/${t.number}/refund`, { via: 'external', reference: 'XND-RF-1234', reason: 'Paid twice' });
  assert.equal(x.json.status, 'refunded');
  assert.equal(x.json.refundRef, 'XND-RF-1234');
});
