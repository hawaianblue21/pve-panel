// Billing: prepaid renewals for servers, a wallet, invoices with tax (PPN), and
// payment by wallet, bank transfer (confirmed by an administrator), Xendit or
// Midtrans.
//
// The model fits the server lifecycle (expiry.js): a server with an end date is
// renewed by paying for 1, 3, 6 or 12 months (30 days each); paying extends the
// end date and reactivates a stopped server. Auto-renew pays from the wallet a
// few days before the end date. Servers without an end date are not billed.
//
// Plans (plans.js): a server created from a priced plan is paid in advance from
// the wallet for its first period ("order"); a move to a larger plan is charged for
// the rest of the paid period ("upgrade"). If setting up the server fails, the
// order is refunded to the wallet.
//
// Money is whole rupiah (integers). Tax is added on top of the prices.

import { db, audit } from './db.js';
import { config } from './config.js';
import { seal, open } from './secrets.js';
import { volumesOfServer } from './volumes.js';
import { ipsOfServer } from './ipam.js';
import { clusterGuests } from './pve.js';
import { extendServer, setServerExpiry } from './expiry.js';
import { planRow } from './plans.js';
import { emailConfigured, sendMail, paymentReceiptMessage, autoRenewFailedMessage } from './mail.js';
import { xendit, midtrans, GatewayError } from './gateways.js';

const KEY = 'billing';
const PURPOSE = 'billing-gateway';
const DAY = 86_400_000;
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
export const MONTH_OPTIONS = [1, 3, 6, 12];

// ---- Settings ------------------------------------------------------------------------------

const DEFAULTS = {
  enabled: false,
  taxName: 'PPN', taxRate: 11,
  company: { name: '', address: '', taxId: '' },
  invoicePrefix: 'INV', dueDays: 7,
  rates: { vcpu: 50_000, ramGb: 25_000, diskGb: 1_500, minimum: 50_000 },
  discounts: { 3: 5, 6: 10, 12: 15 },
  topupMin: 50_000,
  autoRenewDays: 3,
  bank: { enabled: false, instructions: '' },
  xendit: { enabled: false, secretKey: null, callbackToken: null },
  midtrans: { enabled: false, serverKey: null, sandbox: true },
};

function stored() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  const s = row ? JSON.parse(row.value) : {};
  return {
    ...DEFAULTS, ...s,
    company: { ...DEFAULTS.company, ...(s.company ?? {}) }, rates: { ...DEFAULTS.rates, ...(s.rates ?? {}) },
    discounts: { ...DEFAULTS.discounts, ...(s.discounts ?? {}) }, bank: { ...DEFAULTS.bank, ...(s.bank ?? {}) },
    xendit: { ...DEFAULTS.xendit, ...(s.xendit ?? {}) }, midtrans: { ...DEFAULTS.midtrans, ...(s.midtrans ?? {}) },
  };
}
const reveal = (v) => { try { return v ? open(PURPOSE, v) : ''; } catch { return ''; } };
const xenditOn = (s) => s.xendit.enabled && reveal(s.xendit.secretKey) && reveal(s.xendit.callbackToken);
const midtransOn = (s) => s.midtrans.enabled && reveal(s.midtrans.serverKey);
export const billingEnabled = () => stored().enabled;

/** For the admin portal: no secrets, only whether they are set. */
export function billingSettings() {
  const s = stored();
  const base = config.oidc.publicUrl.customer;
  return {
    ...s,
    xendit: { enabled: s.xendit.enabled, hasSecretKey: !!reveal(s.xendit.secretKey), hasCallbackToken: !!reveal(s.xendit.callbackToken),
      webhookUrl: base ? `${base}/api/billing/webhooks/xendit` : null },
    midtrans: { enabled: s.midtrans.enabled, sandbox: s.midtrans.sandbox, hasServerKey: !!reveal(s.midtrans.serverKey),
      webhookUrl: base ? `${base}/api/billing/webhooks/midtrans` : null },
  };
}

const int = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${what}: a whole number from ${min} to ${max}`);
  return n;
};

export function saveBillingSettings(input) {
  const s = stored();
  if (typeof input.enabled === 'boolean') s.enabled = input.enabled;
  if (typeof input.taxName === 'string') s.taxName = input.taxName.trim().slice(0, 20) || 'Tax';
  if (input.taxRate !== undefined) {
    const r = Number(input.taxRate);
    if (!(r >= 0 && r <= 50)) throw fail(400, 'Tax rate: 0 to 50 %');
    s.taxRate = Math.round(r * 100) / 100;
  }
  if (input.company) {
    for (const k of ['name', 'address', 'taxId']) if (typeof input.company[k] === 'string') s.company[k] = input.company[k].trim().slice(0, k === 'address' ? 300 : 120);
  }
  if (typeof input.invoicePrefix === 'string') {
    if (!/^[A-Z0-9]{1,8}$/.test(input.invoicePrefix)) throw fail(400, 'Invoice prefix: 1 to 8 capital letters or digits');
    s.invoicePrefix = input.invoicePrefix;
  }
  if (input.dueDays !== undefined) s.dueDays = int(input.dueDays, 1, 60, 'Days to pay');
  if (input.rates) for (const k of ['vcpu', 'ramGb', 'diskGb', 'minimum']) if (input.rates[k] !== undefined) s.rates[k] = int(input.rates[k], 0, 100_000_000, `Rate ${k}`);
  if (input.discounts) for (const m of [3, 6, 12]) if (input.discounts[m] !== undefined) s.discounts[m] = int(input.discounts[m], 0, 50, `Discount for ${m} months`);
  if (input.topupMin !== undefined) s.topupMin = int(input.topupMin, 10_000, 100_000_000, 'Smallest top-up');
  if (input.autoRenewDays !== undefined) s.autoRenewDays = int(input.autoRenewDays, 1, 30, 'Auto-renew days before');
  if (input.bank) {
    if (typeof input.bank.enabled === 'boolean') s.bank.enabled = input.bank.enabled;
    if (typeof input.bank.instructions === 'string') s.bank.instructions = input.bank.instructions.slice(0, 2000);
  }
  if (input.xendit) {
    if (typeof input.xendit.secretKey === 'string' && input.xendit.secretKey) s.xendit.secretKey = seal(PURPOSE, input.xendit.secretKey.trim());
    if (typeof input.xendit.callbackToken === 'string' && input.xendit.callbackToken) s.xendit.callbackToken = seal(PURPOSE, input.xendit.callbackToken.trim());
    if (typeof input.xendit.enabled === 'boolean') s.xendit.enabled = input.xendit.enabled;
    if (s.xendit.enabled && !xenditOn(s)) throw fail(400, 'Xendit needs the secret API key and the callback verification token');
  }
  if (input.midtrans) {
    if (typeof input.midtrans.serverKey === 'string' && input.midtrans.serverKey) s.midtrans.serverKey = seal(PURPOSE, input.midtrans.serverKey.trim());
    if (typeof input.midtrans.sandbox === 'boolean') s.midtrans.sandbox = input.midtrans.sandbox;
    if (typeof input.midtrans.enabled === 'boolean') s.midtrans.enabled = input.midtrans.enabled;
    if (s.midtrans.enabled && !midtransOn(s)) throw fail(400, 'Midtrans needs the server key');
  }
  if (s.bank.enabled && !s.bank.instructions.trim()) throw fail(400, 'Bank transfer needs the instructions (bank, account number, name)');
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(s));
  return billingSettings();
}

export function paymentMethods(s = stored()) {
  return [
    'wallet',
    ...(xenditOn(s) ? ['xendit'] : []),
    ...(midtransOn(s) ? ['midtrans'] : []),
    ...(s.bank.enabled ? ['bank'] : []),
  ];
}

// ---- Prices ------------------------------------------------------------------------------------

const roundUp = (n, step = 1000) => Math.ceil(n / step) * step;
const taxOf = (amount, rate) => Math.round((amount * rate) / 100);

/** Monthly price of a server: its fixed price, or the rate card applied to its size. */
export async function priceOf(vmid, s = stored()) {
  const row = db.prepare('SELECT vmid, label, price_monthly, plan_id FROM vms WHERE vmid = ?').get(vmid);
  if (!row) throw fail(404, 'Server not found');
  const plan = row.plan_id ? planRow(row.plan_id) : null;
  let g = null;
  try { g = (await clusterGuests()).get(vmid); } catch { /* Proxmox unreachable */ }
  const cores = g?.maxcpu ?? 0;
  const memoryGb = g?.maxmem ? +(g.maxmem / 2 ** 30).toFixed(1) : 0;
  const diskGb = g?.maxdisk ? Math.round(g.maxdisk / 2 ** 30) : 0;
  const name = row.label || g?.name || `server ${vmid}`;
  if (row.price_monthly != null) return { vmid, name, cores, memoryGb, diskGb, monthly: row.price_monthly, fixed: true, plan: plan?.name ?? null };
  if (plan?.price_monthly != null) {
    return { vmid, name, cores: cores || plan.cores, memoryGb: memoryGb || +(plan.memory_mb / 1024).toFixed(1), diskGb: diskGb || plan.disk_gb,
      monthly: plan.price_monthly, fixed: false, plan: plan.name };
  }
  if (!g) throw fail(503, 'The server size is not known right now (Proxmox unreachable). Try again in a minute.');
  const r = s.rates;
  const monthly = Math.max(r.minimum, roundUp(cores * r.vcpu + memoryGb * r.ramGb + diskGb * r.diskGb));
  return { vmid, name, cores, memoryGb, diskGb, monthly, fixed: false };
}

/** The lines of a renewal: the months, then the discount for a longer period. */
export async function renewalQuote(vmid, months, s = stored()) {
  if (!MONTH_OPTIONS.includes(months)) throw fail(400, `Months: ${MONTH_OPTIONS.join(', ')}`);
  const p = await priceOf(vmid, s);
  const size = [p.plan && `plan ${p.plan}`, p.cores && `${p.cores} vCPU`, p.memoryGb && `${p.memoryGb} GB RAM`, p.diskGb && `${p.diskGb} GB disk`].filter(Boolean).join(', ');
  // block storage volumes the server holds (attached or detached) are renewed with it
  const vols = volumesOfServer(vmid);
  const volMonthly = vols.reduce((a, v) => a + v.monthly, 0);
  const extras = volMonthly > 0 ? [{ description: `Block storage: ${vols.map((v) => `${v.label} ${v.sizeGb} GB ${v.tier}`).join(', ')}`, monthly: volMonthly }] : [];
  // public IPv4 addresses of the server
  const charged = ipsOfServer(vmid).filter((a) => a.monthly > 0);
  for (const [family, label] of [[4, 'Public IPv4'], [6, 'IPv6']]) {
    const ips = charged.filter((a) => a.family === family);
    if (ips.length) extras.push({ description: `${label}: ${ips.map((a) => a.address).join(', ')}`, monthly: ips.reduce((a, x) => a + x.monthly, 0) });
  }
  return { price: { ...p, volumesMonthly: volMonthly }, ...periodLines(`${p.name} (${vmid})${size ? ` · ${size}` : ''}`, p.monthly, months, s, extras) };
}

/** Lines, discount and tax for some months of a monthly price. */
function periodLines(what, monthly, months, s, extras = []) {
  const per = `${months} month${months > 1 ? 's' : ''}`;
  const lines = [{ description: `${what} · ${per}`, quantity: months, unitPrice: monthly, amount: monthly * months },
    ...extras.map((x) => ({ description: `${x.description} · ${per}`, quantity: months, unitPrice: x.monthly, amount: x.monthly * months }))];
  const gross = lines.reduce((a, l) => a + l.amount, 0);
  const pct = Number(s.discounts[months] ?? 0);
  const off = Math.round((gross * pct) / 100);
  if (pct > 0 && off > 0) lines.push({ description: `Discount ${pct}% for ${months} months`, quantity: 1, unitPrice: -off, amount: -off });
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const tax = taxOf(subtotal, s.taxRate);
  return { months, lines, subtotal, taxName: s.taxName, taxRate: s.taxRate, tax, total: subtotal + tax };
}

const planSize = (p) => `${p.cores} vCPU, ${+(p.memory_mb / 1024).toFixed(1)} GB RAM, ${p.disk_gb} GB disk${p.gpu_name ? `, ${p.gpu_name}` : ''}`;

/** Is a new server on this plan paid in advance? (billing on and the plan has a price above 0) */
export function planIsBilled(plan) {
  return stored().enabled && Number(plan?.price_monthly) > 0;
}

/** What a new server on a plan costs for some months (before it exists). */
export function orderQuote(plan, months, s = stored()) {
  if (!MONTH_OPTIONS.includes(months)) throw fail(400, `Months: ${MONTH_OPTIONS.join(', ')}`);
  return periodLines(`New server, plan ${plan.name} (${planSize(plan)})`, plan.price_monthly, months, s);
}

// ---- Invoices ----------------------------------------------------------------------------------

function nextNumber(prefix) {
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  const like = `${prefix}-${ym}-%`;
  const last = db.prepare('SELECT number FROM invoices WHERE number LIKE ? ORDER BY id DESC LIMIT 1').get(like)?.number;
  const seq = last ? Number(last.split('-').pop()) + 1 : 1;
  return `${prefix}-${ym}-${String(seq).padStart(4, '0')}`;
}

function billTo(userId) {
  const u = db.prepare('SELECT email, billing_profile FROM users WHERE id = ?').get(userId);
  const p = u?.billing_profile ? JSON.parse(u.billing_profile) : {};
  return { email: u?.email ?? '', name: p.name ?? '', address: p.address ?? '', taxId: p.taxId ?? '' };
}

function insertInvoice({ userId, purpose, vmid = null, months = null, lines, subtotal, total, tax, s, auto = false, note = null }) {
  const id = Number(db.prepare(`INSERT INTO invoices (number, user_id, purpose, vmid, months, lines, subtotal, tax_name, tax_rate, tax, total, due_at, auto, note, bill_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    nextNumber(s.invoicePrefix), userId, purpose, vmid, months, JSON.stringify(lines), subtotal, s.taxName, s.taxRate, tax, total,
    new Date(Date.now() + s.dueDays * DAY).toISOString(), auto ? 1 : 0, note, JSON.stringify(billTo(userId)),
  ).lastInsertRowid);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
}

function pub(inv, { admin = false } = {}) {
  const s = stored();
  const overdue = inv.status === 'unpaid' && Date.parse(inv.due_at) < Date.now();
  return {
    number: inv.number, purpose: inv.purpose, vmid: inv.vmid, months: inv.months, status: inv.status, overdue,
    lines: JSON.parse(inv.lines), subtotal: inv.subtotal, taxName: inv.tax_name, taxRate: inv.tax_rate, tax: inv.tax, total: inv.total,
    currency: inv.currency, dueAt: inv.due_at, paidAt: inv.paid_at, paidVia: inv.paid_via, createdAt: inv.created_at, auto: !!inv.auto,
    customerRef: inv.customer_ref, billTo: inv.bill_to ? JSON.parse(inv.bill_to) : null,
    seller: { name: s.company.name, address: s.company.address, taxId: s.company.taxId },
    ...(admin ? { userId: inv.user_id, email: inv.email, note: inv.note, fulfilledAt: inv.fulfilled_at,
      payments: db.prepare('SELECT method, reference, amount, created_at AS createdAt FROM payments WHERE invoice_id = ? ORDER BY id').all(inv.id) } : {}),
  };
}

const ownServer = (userId, vmid) => db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?').get(vmid, userId);

export async function createRenewal(req, vmid, months, { auto = false } = {}) {
  const s = stored();
  if (!s.enabled) throw fail(404, 'Billing is not available');
  const userId = req.account.id;
  const vm = ownServer(userId, vmid);
  if (!vm) throw fail(404, 'Server not found');
  if (!vm.expires_at) throw fail(400, 'This server has no end date and is not billed');
  if (vm.state === 'failed') throw fail(409, 'This server could not be set up. Delete it; a paid order was refunded to your wallet.');
  // one open renewal per server: return it instead of a second one
  // (or replace it when the period or the price has changed since)
  const q = await renewalQuote(vmid, months, s);
  const open = db.prepare("SELECT * FROM invoices WHERE user_id = ? AND vmid = ? AND purpose = 'renewal' AND status = 'unpaid'").get(userId, vmid);
  if (open && open.months === months && open.subtotal === q.subtotal && open.tax_rate === q.taxRate) return pub(open);
  if (open) db.prepare("UPDATE invoices SET status = 'void', note = ? WHERE id = ?").run(open.months === months ? 'Replaced: the price changed' : 'Replaced by a renewal for another period', open.id);
  const inv = insertInvoice({ userId, purpose: 'renewal', vmid, months, lines: q.lines, subtotal: q.subtotal, tax: q.tax, total: q.total, s, auto });
  audit(req, vmid, 'invoice_created', { number: inv.number, purpose: 'renewal', months, total: inv.total, auto });
  return pub(inv);
}

export function createTopup(req, amount) {
  const s = stored();
  if (!s.enabled) throw fail(404, 'Billing is not available');
  const a = int(amount, s.topupMin, 100_000_000, `Amount (at least ${s.topupMin.toLocaleString('id-ID')})`);
  // top-ups are not taxed: tax is charged when the balance pays for a service
  const lines = [{ description: 'Wallet top-up', quantity: 1, unitPrice: a, amount: a }];
  const inv = insertInvoice({ userId: req.account.id, purpose: 'topup', lines, subtotal: a, tax: 0, total: a, s: { ...s, taxRate: 0 } });
  audit(req, null, 'invoice_created', { number: inv.number, purpose: 'topup', total: a });
  return pub(inv);
}

export function getInvoice(userId, number) {
  const inv = db.prepare('SELECT * FROM invoices WHERE number = ?').get(String(number));
  if (!inv || (userId !== null && inv.user_id !== userId)) throw fail(404, 'Invoice not found');
  return inv;
}

// ---- Wallet ------------------------------------------------------------------------------------

export const balanceOf = (userId) => db.prepare('SELECT balance_after FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId)?.balance_after ?? 0;

function walletEntry(userId, amount, reason, { invoiceId = null, adminId = null } = {}) {
  const after = balanceOf(userId) + amount;
  if (after < 0) throw fail(409, 'Not enough balance in the wallet');
  db.prepare('INSERT INTO wallet_entries (user_id, amount, balance_after, reason, invoice_id, admin_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, amount, after, reason, invoiceId, adminId);
  return after;
}

export function adjustWallet(req, userId, amount, reason) {
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw fail(404, 'Customer not found');
  const a = int(amount, -100_000_000, 100_000_000, 'Amount');
  if (!a) throw fail(400, 'Amount must not be 0');
  const r = String(reason ?? '').trim();
  if (r.length < 3) throw fail(400, 'Give a reason (shown to the customer)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const after = walletEntry(userId, a, r.slice(0, 200), { adminId: req.account.id });
    db.exec('COMMIT');
    audit(req, null, 'admin_wallet_adjust', { userId, amount: a, reason: r, balance: after });
    return { balance: after };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// ---- Paying ------------------------------------------------------------------------------------

/**
 * Marks an invoice paid exactly once and delivers what was bought: the renewal
 * (end date + 30 days per month, server active again) or the wallet top-up.
 * Returns false when it was already paid.
 */
export function markPaid(invoiceId, { via, reference = null, amount, adminId = null, actor = null }) {
  db.exec('BEGIN IMMEDIATE');
  let inv;
  try {
    inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv || inv.status === 'paid') { db.exec('ROLLBACK'); return false; }
    if (inv.status === 'void' && via !== 'admin') { db.exec('ROLLBACK'); return false; }
    db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now'), paid_via = ? WHERE id = ?").run(via, inv.id);
    db.prepare('INSERT INTO payments (invoice_id, method, reference, amount, admin_id) VALUES (?, ?, ?, ?, ?)').run(inv.id, via, reference, amount ?? inv.total, adminId);
    if (inv.purpose === 'topup') walletEntry(inv.user_id, inv.total, `Top-up ${inv.number}`, { invoiceId: inv.id });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }

  let expiresAt = null;
  if (inv.purpose === 'renewal' && inv.vmid && db.prepare('SELECT 1 FROM vms WHERE vmid = ? AND user_id = ?').get(inv.vmid, inv.user_id)) {
    expiresAt = extendServer(inv.vmid, 30 * inv.months);
  }
  db.prepare("UPDATE invoices SET fulfilled_at = datetime('now') WHERE id = ?").run(inv.id);
  audit(actor ?? { account: { id: inv.user_id }, ip: 'billing' }, inv.vmid, 'invoice_paid',
    { number: inv.number, via, total: inv.total, reference, ...(expiresAt ? { expiresAt } : {}) });
  if (emailConfigured()) {
    const email = db.prepare('SELECT email FROM users WHERE id = ?').get(inv.user_id)?.email;
    if (email) sendMail({ to: email, ...paymentReceiptMessage(pub(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id)), expiresAt) }).catch(() => {});
  }
  return true;
}

/** Customer portal address for the return link: PANEL_PUBLIC_URL, else the address the browser used. */
const panelUrl = (req) => {
  if (config.oidc.publicUrl.customer) return config.oidc.publicUrl.customer.replace(/\/$/, '');
  try { return req?.protocol && req?.host ? new URL(`${req.protocol}://${req.host}`).origin : ''; } catch { return ''; }
};

/** The customer pays: wallet now, a gateway checkout, or bank-transfer instructions. */
export async function pay(req, number, method, { reference = null } = {}) {
  const s = stored();
  const inv = getInvoice(req.account.id, number);
  if (inv.status !== 'unpaid') throw fail(409, inv.status === 'paid' ? 'This invoice is already paid' : 'This invoice was cancelled');
  if (!paymentMethods(s).includes(method)) throw fail(400, 'That payment method is not available');
  if (method === 'wallet' && inv.purpose === 'topup') throw fail(400, 'A top-up can\'t be paid from the wallet');

  if (method === 'wallet') {
    db.exec('BEGIN IMMEDIATE');
    try {
      walletEntry(req.account.id, -inv.total, `Paid ${inv.number}`, { invoiceId: inv.id });
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    if (!markPaid(inv.id, { via: 'wallet', amount: inv.total, actor: req })) {
      // paid another way at the same moment: give the money back
      walletEntry(req.account.id, inv.total, `Refund: ${inv.number} was already paid`, { invoiceId: inv.id });
    }
    return { paid: true, invoice: pub(getInvoice(req.account.id, number)) };
  }
  if (method === 'bank') {
    const ref = String(reference ?? '').trim().slice(0, 120);
    if (ref) {
      db.prepare('UPDATE invoices SET customer_ref = ? WHERE id = ?').run(ref, inv.id);
      audit(req, inv.vmid, 'invoice_transfer_reported', { number: inv.number, reference: ref });
    }
    return { bank: { instructions: s.bank.instructions, reference: inv.number, amount: inv.total }, reported: !!ref };
  }

  // gateway: reuse a recent open checkout for the same invoice and gateway
  const recent = db.prepare(`SELECT * FROM checkouts WHERE invoice_id = ? AND gateway = ? AND status = 'pending'
    AND created_at >= datetime('now', '-23 hours') AND amount = ? ORDER BY id DESC LIMIT 1`).get(inv.id, method, inv.total);
  if (recent?.url) return { redirectUrl: recent.url };
  const attempt = db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE invoice_id = ?').get(inv.id).n + 1;
  const orderId = `${inv.number}-${attempt}`;
  const base = panelUrl(req);
  const back = base ? `${base}/#billing/${inv.number}` : null;
  const lines = JSON.parse(inv.lines);
  let r;
  try {
    if (method === 'xendit') {
      r = await xendit.create({
        secretKey: reveal(s.xendit.secretKey), orderId, amount: inv.total, email: req.account.email,
        description: `${inv.number}: ${lines[0]?.description ?? inv.purpose}`.slice(0, 250), durationSeconds: 24 * 3600,
        successUrl: back, failureUrl: back,
      });
    } else {
      // Midtrans checks that the items add up to the gross amount: one line with the total
      r = await midtrans.create({
        serverKey: reveal(s.midtrans.serverKey), sandbox: s.midtrans.sandbox, orderId, amount: inv.total,
        email: req.account.email, items: [{ id: inv.number, price: inv.total, quantity: 1, name: `Invoice ${inv.number}`.slice(0, 50) }],
        finishUrl: back,
      });
    }
  } catch (err) {
    audit(req, inv.vmid, 'payment_checkout_failed', { number: inv.number, gateway: method, error: String(err.message).slice(0, 300) });
    if (err instanceof GatewayError) throw fail(502, 'The payment page could not be opened. Please try again or choose another method.');
    throw err;
  }
  db.prepare('INSERT INTO checkouts (invoice_id, gateway, order_id, gateway_id, url, amount, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(inv.id, method, orderId, r.gatewayId, r.url, inv.total, r.expiresAt);
  audit(req, inv.vmid, 'payment_checkout', { number: inv.number, gateway: method, orderId });
  return { redirectUrl: r.url };
}

/**
 * A gateway notification. Authenticated first, then the payment is confirmed
 * with the gateway's own API (status and amount) before anything is delivered.
 * Returns { status, body } for the HTTP answer.
 */
export async function webhook(gateway, req) {
  const s = stored();
  const g = gateway === 'xendit' ? xendit : gateway === 'midtrans' ? midtrans : null;
  if (!g) return { status: 404, body: { error: 'Unknown gateway' } };
  const secret = gateway === 'xendit' ? reveal(s.xendit.callbackToken) : reveal(s.midtrans.serverKey);
  const who = g.authenticate(req.headers, req.body, secret);
  if (!who) {
    audit(req, null, 'payment_webhook_refused', { gateway, reason: 'not authenticated' });
    return { status: 401, body: { error: 'Not authenticated' } };
  }
  const co = db.prepare('SELECT * FROM checkouts WHERE order_id = ? AND gateway = ?').get(who.orderId, gateway);
  if (!co) return { status: 200, body: { ignored: 'unknown order' } };   // e.g. a test notification from the dashboard
  let st;
  try {
    st = gateway === 'xendit'
      ? await xendit.status({ secretKey: reveal(s.xendit.secretKey), gatewayId: co.gateway_id ?? who.gatewayId })
      : await midtrans.status({ serverKey: reveal(s.midtrans.serverKey), sandbox: s.midtrans.sandbox, orderId: co.order_id });
  } catch (err) {
    // the gateway retries the notification later
    return { status: 503, body: { error: `Status check failed: ${err.message}` } };
  }
  if (st.orderId && String(st.orderId) !== co.order_id) return { status: 409, body: { error: 'Order does not match' } };
  if (st.failed) {
    db.prepare("UPDATE checkouts SET status = 'failed' WHERE id = ?").run(co.id);
    return { status: 200, body: { status: 'failed' } };
  }
  if (!st.paid) return { status: 200, body: { status: 'pending' } };
  if (st.amount < co.amount) {
    audit({ account: null, ip: gateway }, null, 'payment_amount_mismatch', { orderId: co.order_id, expected: co.amount, paid: st.amount });
    return { status: 200, body: { status: 'amount mismatch' } };
  }
  db.prepare("UPDATE checkouts SET status = 'paid' WHERE id = ?").run(co.id);
  const first = markPaid(co.invoice_id, { via: gateway, reference: `${co.order_id}${st.method ? ` (${st.method})` : ''}`, amount: st.amount });
  // paid twice (two checkouts): keep the money as wallet balance
  if (!first) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(co.invoice_id);
    const dup = db.prepare('SELECT 1 FROM payments WHERE reference LIKE ?').get(`${co.order_id}%`);
    if (inv && !dup) {
      db.prepare('INSERT INTO payments (invoice_id, method, reference, amount) VALUES (?, ?, ?, ?)').run(inv.id, gateway, `${co.order_id} (duplicate, to wallet)`, st.amount);
      walletEntry(inv.user_id, st.amount, `Second payment of ${inv.number}, kept as balance`, { invoiceId: inv.id });
      audit({ account: { id: inv.user_id }, ip: gateway }, inv.vmid, 'payment_duplicate_to_wallet', { number: inv.number, amount: st.amount });
    }
  }
  return { status: 200, body: { status: 'paid' } };
}

// ---- Orders (new servers on a plan) and upgrades ------------------------------------------------

/** Pays an invoice from the wallet right away; the invoice and the debit in one transaction. */
function chargeWallet(req, { purpose, vmid = null, months = null, quote, note }) {
  const s = stored();
  const userId = req.account.id;
  if (balanceOf(userId) < quote.total) {
    throw fail(402, `Your wallet has ${rp(balanceOf(userId))}; this costs ${rp(quote.total)}. Top up your wallet first (Billing).`);
  }
  db.exec('BEGIN IMMEDIATE');
  let inv;
  try {
    inv = insertInvoice({ userId, purpose, vmid, months, lines: quote.lines, subtotal: quote.subtotal, tax: quote.tax, total: quote.total, s, note });
    walletEntry(userId, -inv.total, `Paid ${inv.number}`, { invoiceId: inv.id });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  markPaid(inv.id, { via: 'wallet', amount: inv.total, actor: req });
  audit(req, vmid, 'invoice_created', { number: inv.number, purpose, months, total: inv.total });
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
}
const rp = (n) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;

/** Before cloning a new server on a priced plan: invoice and pay the first period from the wallet. */
export function chargeOrder(req, plan, months) {
  const quote = orderQuote(plan, months);
  return chargeWallet(req, { purpose: 'order', months, quote, note: `plan ${plan.id}` });
}

/** The server exists: link the order to it and set its paid-until date. */
export function completeOrder(invoiceId, vmid, months) {
  db.prepare('UPDATE invoices SET vmid = ? WHERE id = ?').run(vmid, invoiceId);
  const at = new Date(Date.now() + 30 * months * DAY).toISOString();
  setServerExpiry(vmid, at);
  return at;
}

/** Gives a paid invoice back to the wallet (setup failed or an upgrade could not be applied). */
export function refundInvoice(invoiceId, reason, actor = null) {
  db.exec('BEGIN IMMEDIATE');
  let inv;
  try {
    inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv || inv.status !== 'paid') { db.exec('ROLLBACK'); return false; }
    db.prepare("UPDATE invoices SET status = 'refunded', note = trim(coalesce(note, '') || ' · refunded: ' || ?) WHERE id = ?").run(String(reason).slice(0, 200), inv.id);
    walletEntry(inv.user_id, inv.total, `Refund ${inv.number}: ${String(reason).slice(0, 120)}`, { invoiceId: inv.id });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  audit(actor ?? { account: { id: inv.user_id }, ip: 'billing' }, inv.vmid, 'invoice_refunded', { number: inv.number, total: inv.total, reason });
  return true;
}

/** Called when setting up a new server failed: refund its order, if it had one. */
export function refundFailedOrder(vmid) {
  const inv = db.prepare("SELECT id FROM invoices WHERE vmid = ? AND purpose = 'order' AND status = 'paid'").get(vmid);
  if (inv) refundInvoice(inv.id, 'the server could not be set up');
}

/**
 * Moving a server to a larger plan: the difference in monthly price for the days
 * left of the paid period (at least nothing), plus tax.
 */
export function upgradeQuote(vmid, from, to) {
  const s = stored();
  const row = db.prepare('SELECT expires_at FROM vms WHERE vmid = ?').get(vmid);
  const days = row?.expires_at ? Math.max(0, Math.ceil((Date.parse(row.expires_at) - Date.now()) / DAY)) : 0;
  const perMonth = Math.max(0, (to.price_monthly ?? 0) - (from.price_monthly ?? 0));
  const amount = s.enabled ? roundUp((perMonth * days) / 30) : 0;
  const lines = amount ? [{ description: `Upgrade server ${vmid}: plan ${from.name} → ${to.name} (${planSize(to)}), ${days} days left`, quantity: 1, unitPrice: amount, amount }] : [];
  const tax = taxOf(amount, s.taxRate);
  return { days, perMonth, lines, subtotal: amount, taxName: s.taxName, taxRate: s.taxRate, tax, total: amount + tax };
}

/** Unpaid renewals of a server at its old size: cancelled after a plan change (the next one has the new price). */
export function voidOpenRenewals(vmid, reason) {
  return db.prepare("UPDATE invoices SET status = 'void', note = ? WHERE vmid = ? AND purpose = 'renewal' AND status = 'unpaid'").run(reason, vmid).changes;
}

export function chargeUpgrade(req, vmid, from, to) {
  const quote = upgradeQuote(vmid, from, to);
  if (!quote.total) return null;
  return chargeWallet(req, { purpose: 'upgrade', vmid, quote, note: `plan ${from.id} to ${to.id}` });
}

// ---- Auto-renew ----------------------------------------------------------------------------------

/** Servers with auto-renew whose end date is near: renew for one month from the wallet. */
export async function runAutoRenew(log) {
  const s = stored();
  if (!s.enabled) return { renewed: 0, short: 0 };
  const due = db.prepare(`SELECT v.vmid, v.user_id, u.email FROM vms v JOIN users u ON u.id = v.user_id
    WHERE v.auto_renew = 1 AND v.expires_at IS NOT NULL AND v.expires_at <= ? AND u.deleting = 0`)
    .all(new Date(Date.now() + s.autoRenewDays * DAY).toISOString());
  let renewed = 0;
  let short = 0;
  for (const v of due) {
    const actor = { account: { id: v.user_id, email: v.email }, ip: 'billing' };
    try {
      const inv = await createRenewal(actor, v.vmid, 1, { auto: true });
      const row = getInvoice(v.user_id, inv.number);
      if (balanceOf(v.user_id) >= row.total) {
        await pay(actor, inv.number, 'wallet');
        renewed += 1;
      } else {
        short += 1;
        // tell the customer once per invoice
        if (!row.note?.includes('auto-renew notice') && emailConfigured()) {
          sendMail({ to: v.email, ...autoRenewFailedMessage(pub(row), balanceOf(v.user_id)) }).catch(() => {});
          db.prepare("UPDATE invoices SET note = trim(coalesce(note, '') || ' auto-renew notice sent') WHERE id = ?").run(row.id);
        }
      }
    } catch (err) {
      log?.warn(`Auto-renew of ${v.vmid} failed: ${err.message}`);
    }
  }
  if (renewed || short) log?.info(`Auto-renew: ${renewed} renewed from the wallet, ${short} short of balance`);
  return { renewed, short };
}

export function startAutoRenew(log) {
  const every = Math.max(60, Number(process.env.AUTORENEW_INTERVAL_SECONDS || 3600)) * 1000;
  setInterval(() => { runAutoRenew(log).catch(() => {}); }, every).unref();
}

// ---- Views -----------------------------------------------------------------------------------------

export async function customerOverview(userId) {
  const s = stored();
  if (!s.enabled) return { enabled: false };
  const vms = db.prepare('SELECT vmid, label, expires_at, expired_at, auto_renew FROM vms WHERE user_id = ? AND expires_at IS NOT NULL ORDER BY expires_at').all(userId);
  const servers = [];
  for (const v of vms) {
    let monthly = null;
    try { monthly = (await priceOf(v.vmid, s)).monthly + volumesOfServer(v.vmid).reduce((a, x) => a + x.monthly, 0) + ipsOfServer(v.vmid).reduce((a, x) => a + x.monthly, 0); } catch { /* size unknown right now */ }
    servers.push({ vmid: v.vmid, name: v.label || `server ${v.vmid}`, expiresAt: v.expires_at, expired: !!v.expired_at, autoRenew: !!v.auto_renew, monthly });
  }
  const invoices = db.prepare('SELECT * FROM invoices WHERE user_id = ? AND status <> \'void\' ORDER BY id DESC LIMIT 50').all(userId).map((i) => pub(i));
  const wallet = db.prepare('SELECT amount, balance_after AS balance, reason, created_at AS createdAt FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(userId);
  const u = db.prepare('SELECT billing_profile FROM users WHERE id = ?').get(userId);
  return {
    enabled: true, currency: 'IDR', balance: balanceOf(userId), wallet, servers, invoices,
    methods: paymentMethods(s), taxName: s.taxName, taxRate: s.taxRate, topupMin: s.topupMin,
    months: MONTH_OPTIONS.map((m) => ({ months: m, discount: Number(s.discounts[m] ?? 0) })),
    profile: u?.billing_profile ? JSON.parse(u.billing_profile) : { name: '', address: '', taxId: '' },
  };
}

export function invoiceForCustomer(userId, number) {
  const inv = getInvoice(userId, number);
  const s = stored();
  return { ...pub(inv), methods: inv.status === 'unpaid' ? paymentMethods(s).filter((m) => !(m === 'wallet' && inv.purpose === 'topup')) : [],
    balance: balanceOf(userId), bank: s.bank.enabled ? s.bank.instructions : null };
}

export function setAutoRenew(req, vmid, enabled) {
  const vm = ownServer(req.account.id, vmid);
  if (!vm) throw fail(404, 'Server not found');
  if (!vm.expires_at) throw fail(400, 'This server has no end date');
  db.prepare('UPDATE vms SET auto_renew = ? WHERE vmid = ?').run(enabled ? 1 : 0, vmid);
  audit(req, vmid, 'auto_renew_changed', { enabled });
  return { vmid, autoRenew: enabled };
}

export function saveProfile(userId, input) {
  const p = {};
  for (const k of ['name', 'address', 'taxId']) p[k] = String(input[k] ?? '').trim().slice(0, k === 'address' ? 300 : 120);
  db.prepare('UPDATE users SET billing_profile = ? WHERE id = ?').run(JSON.stringify(p), userId);
  return p;
}

export function adminOverview({ status = null, q = '' } = {}) {
  const where = [];
  const args = [];
  if (status === 'overdue') { where.push("i.status = 'unpaid' AND i.due_at < ?"); args.push(new Date().toISOString()); }
  else if (status === 'reported') { where.push("i.status = 'unpaid' AND i.customer_ref IS NOT NULL"); }
  else if (status) { where.push('i.status = ?'); args.push(status); }
  const text = String(q ?? '').trim();
  if (text) {
    where.push("(i.number LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR CAST(i.vmid AS TEXT) = ?)");
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, text);
  }
  const invoices = db.prepare(`SELECT i.*, u.email FROM invoices i JOIN users u ON u.id = i.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.id DESC LIMIT 300`).all(...args).map((i) => pub(i, { admin: true }));
  const month = new Date().toISOString().slice(0, 7);
  const k = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' AND purpose <> 'topup' AND substr(paid_at, 1, 7) = ? THEN total END), 0) AS revenueMonth,
      COALESCE(SUM(CASE WHEN status = 'paid' AND purpose <> 'topup' AND substr(paid_at, 1, 7) = ? THEN tax END), 0) AS taxMonth,
      COALESCE(SUM(CASE WHEN status = 'unpaid' THEN total END), 0) AS unpaid,
      COUNT(CASE WHEN status = 'unpaid' AND due_at < ? THEN 1 END) AS overdue,
      COUNT(CASE WHEN status = 'unpaid' AND customer_ref IS NOT NULL THEN 1 END) AS reported
    FROM invoices`).get(month, month, new Date().toISOString());
  const wallets = db.prepare(`SELECT COALESCE(SUM(balance_after), 0) AS total FROM wallet_entries w
    WHERE id = (SELECT MAX(id) FROM wallet_entries x WHERE x.user_id = w.user_id)`).get().total;
  return { kpis: { ...k, wallets }, invoices, settings: billingSettings() };
}

export function adminInvoice(number) {
  const inv = db.prepare('SELECT i.*, u.email FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.number = ?').get(String(number));
  if (!inv) throw fail(404, 'Invoice not found');
  return { ...pub(inv, { admin: true }), balance: balanceOf(inv.user_id),
    checkouts: db.prepare('SELECT gateway, order_id AS orderId, status, amount, created_at AS createdAt FROM checkouts WHERE invoice_id = ? ORDER BY id').all(inv.id) };
}

export function adminMarkPaid(req, number, { reference, note }) {
  const inv = getInvoice(null, number);
  if (inv.status === 'paid') throw fail(409, 'Already paid');
  const ref = String(reference ?? '').trim();
  if (ref.length < 3) throw fail(400, 'Enter the bank reference or a note of how it was paid');
  if (note) db.prepare('UPDATE invoices SET note = ? WHERE id = ?').run(String(note).slice(0, 500), inv.id);
  markPaid(inv.id, { via: 'bank', reference: ref.slice(0, 120), amount: inv.total, adminId: req.account.id, actor: req });
  return adminInvoice(number);
}

export function adminVoid(req, number, reason) {
  const inv = getInvoice(null, number);
  if (inv.status !== 'unpaid') throw fail(409, 'Only unpaid invoices can be cancelled');
  const r = String(reason ?? '').trim();
  if (r.length < 3) throw fail(400, 'Give a reason');
  db.prepare("UPDATE invoices SET status = 'void', note = ? WHERE id = ?").run(r.slice(0, 500), inv.id);
  audit(req, inv.vmid, 'admin_invoice_void', { number: inv.number, reason: r });
  return adminInvoice(number);
}

export function setServerPrice(req, vmid, priceMonthly) {
  if (!db.prepare('SELECT 1 FROM vms WHERE vmid = ?').get(vmid)) throw fail(404, 'Server not found');
  const p = priceMonthly === null ? null : int(priceMonthly, 0, 1_000_000_000, 'Monthly price');
  db.prepare('UPDATE vms SET price_monthly = ? WHERE vmid = ?').run(p, vmid);
  audit(req, vmid, 'admin_server_price', { priceMonthly: p });
  return { vmid, priceMonthly: p };
}
