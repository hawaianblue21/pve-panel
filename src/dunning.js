// Dunning: getting renewals paid before servers stop.
//
//   Issue      a renewal invoice for one month, issueDaysBefore (default 7) days before a billed
//              server's end date; due on the end date. Not for servers the customer chose not to
//              renew, nor for free servers.
//   Remind     by email on reminderDays before the due date (default 7 and 1), with a pay link.
//   Due date   paid from the wallet when the balance covers it (autoCharge); otherwise one
//              overdue email with the date the server will stop.
//   Suspend    the server keeps running suspendAfterDays (default 3) after the due date, then the
//              server lifecycle (expiry.js) stops it; grace period and deletion follow as before.
//   Pause      an administrator can pause an invoice's dunning: no emails, no charge, no stop.
//
// The step state lives on the invoice (invoices.dunning: { events: [{ k, at }], paused }), so a
// restart never repeats or skips a step. runDunning() is called by the expiry job before it acts.

import { db, audit } from './db.js';
import {
  billingStored, renewalQuote, createRenewal, getInvoice, balanceOf, pay, pub as pubInvoice,
} from './billing.js';
import { emailConfigured, sendMail, invoiceDueMessage, invoiceOverdueMessage } from './mail.js';

const DAY = 86_400_000;
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
const iso = (ms) => new Date(ms).toISOString();

const stateOf = (inv) => {
  const st = inv.dunning ? JSON.parse(inv.dunning) : {};
  return { events: st.events ?? [], paused: !!st.paused, pausedBy: st.pausedBy ?? null, pausedAt: st.pausedAt ?? null };
};
const saveState = (id, st) => db.prepare('UPDATE invoices SET dunning = ? WHERE id = ?').run(JSON.stringify(st), id);
const sent = (st, k) => st.events.some((e) => e.k === k);
const serverName = (row) => row.label || `server ${row.vmid}`;

async function mail(to, message) {
  if (!emailConfigured() || !to) return false;
  try { await sendMail({ to, ...message }); return true; } catch { return false; }
}

/** One pass: issue, remind, charge or warn. Returns counts. */
export async function runDunning({ log, now = Date.now() } = {}) {
  const s = billingStored();
  const d = s.dunning;
  const out = { issued: 0, reminded: 0, charged: 0, overdue: 0 };
  if (!s.enabled || !d.enabled) return out;

  // 1. issue renewal invoices before the end date
  const servers = db.prepare(`SELECT v.*, u.email FROM vms v JOIN users u ON u.id = v.user_id
    WHERE v.expires_at IS NOT NULL AND v.expires_at <= ? AND v.expired_at IS NULL AND v.renew_cancelled = 0
      AND v.state = 'ready' AND u.deleting = 0`).all(iso(now + d.issueDaysBefore * DAY));
  for (const row of servers) {
    if (db.prepare("SELECT 1 FROM invoices WHERE vmid = ? AND user_id = ? AND purpose = 'renewal' AND status = 'unpaid'").get(row.vmid, row.user_id)) continue;
    try {
      const q = await renewalQuote(row.vmid, 1, s);
      if (!(q.total > 0)) continue;                       // free server: nothing to collect
      const actor = { account: { id: row.user_id, email: row.email }, ip: 'billing' };
      const inv = await createRenewal(actor, row.vmid, 1, { auto: true });
      const r = getInvoice(row.user_id, inv.number);
      saveState(r.id, { events: [{ k: 'issued', at: iso(now) }], paused: false });
      out.issued += 1;
    } catch (err) {
      log?.warn(`Dunning: invoice for ${row.vmid} not issued: ${err.message}`);
    }
  }

  // 2. unpaid renewals: remind before the due date, charge or warn on it
  const open = db.prepare(`SELECT i.*, u.email, v.label, v.expired_at, v.vmid AS server FROM invoices i
    JOIN users u ON u.id = i.user_id JOIN vms v ON v.vmid = i.vmid AND v.user_id = i.user_id
    WHERE i.purpose = 'renewal' AND i.status = 'unpaid' AND v.renew_cancelled = 0 AND u.deleting = 0`).all();
  for (const inv of open) {
    const st = stateOf(inv);
    if (st.paused) continue;
    const due = Date.parse(inv.due_at);
    const p = pubInvoice(inv);
    try {
      if (now < due) {
        const reached = d.reminderDays.filter((r) => now >= due - r * DAY && !sent(st, `r${r}`));
        if (!reached.length) continue;
        const days = Math.max(1, Math.ceil((due - now) / DAY));
        const ok = await mail(inv.email, invoiceDueMessage(p, { server: serverName(inv), days, balance: balanceOf(inv.user_id), autoCharge: d.autoCharge }));
        for (const r of reached) st.events.push({ k: `r${r}`, at: iso(now), email: ok });
        saveState(inv.id, st);
        out.reminded += 1;
        continue;
      }
      if (sent(st, 'due')) continue;
      if (d.autoCharge && balanceOf(inv.user_id) >= inv.total) {
        await pay({ account: { id: inv.user_id, email: inv.email }, ip: 'billing' }, inv.number, 'wallet');
        st.events.push({ k: 'due', at: iso(now), charged: true });
        saveState(inv.id, st);
        out.charged += 1;
        continue;
      }
      const stopAt = iso(due + d.suspendAfterDays * DAY);
      const ok = await mail(inv.email, invoiceOverdueMessage(p, { server: serverName(inv), stopAt }));
      st.events.push({ k: 'due', at: iso(now), charged: false, email: ok, stopAt });
      saveState(inv.id, st);
      audit({ account: { id: inv.user_id }, ip: 'billing' }, inv.vmid, 'invoice_overdue', { number: inv.number, total: inv.total, stopAt });
      out.overdue += 1;
    } catch (err) {
      log?.warn(`Dunning: ${inv.number}: ${err.message}`);
    }
  }
  if (out.issued || out.reminded || out.charged || out.overdue) log?.info(`Dunning: ${JSON.stringify(out)}`);
  return out;
}

// ---- Administrators -------------------------------------------------------------------------------

const renewalOf = (number) => {
  const inv = getInvoice(null, number);
  if (inv.purpose !== 'renewal' || inv.status !== 'unpaid') throw fail(409, 'Dunning applies to unpaid renewal invoices');
  return inv;
};

/** Pause (no emails, no wallet charge, the server is not stopped for it) or resume. */
export function setPaused(req, number, paused) {
  const inv = renewalOf(number);
  const st = stateOf(inv);
  st.paused = !!paused;
  st.pausedBy = paused ? req.account?.email ?? null : null;
  st.pausedAt = paused ? iso(Date.now()) : null;
  st.events.push({ k: paused ? 'paused' : 'resumed', at: iso(Date.now()), by: req.account?.email ?? null });
  saveState(inv.id, st);
  audit(req, inv.vmid, paused ? 'admin_dunning_paused' : 'admin_dunning_resumed', { number: inv.number });
  return { number: inv.number, paused: st.paused };
}

/** A reminder now, whatever the schedule. */
export async function sendReminder(req, number) {
  const inv = renewalOf(number);
  const row = db.prepare('SELECT u.email, v.label, v.vmid FROM invoices i JOIN users u ON u.id = i.user_id LEFT JOIN vms v ON v.vmid = i.vmid WHERE i.id = ?').get(inv.id);
  if (!emailConfigured()) throw fail(409, 'Email is not set up (Settings → Email)');
  const s = billingStored();
  const p = pubInvoice(inv);
  const due = Date.parse(inv.due_at);
  const ok = await mail(row.email, Date.now() < due
    ? invoiceDueMessage(p, { server: serverName(row), days: Math.max(1, Math.ceil((due - Date.now()) / DAY)), balance: balanceOf(inv.user_id), autoCharge: s.dunning.autoCharge })
    : invoiceOverdueMessage(p, { server: serverName(row), stopAt: iso(due + s.dunning.suspendAfterDays * DAY) }));
  if (!ok) throw fail(502, 'The email could not be sent');
  const st = stateOf(inv);
  st.events.push({ k: 'manual', at: iso(Date.now()), by: req.account?.email ?? null, email: true });
  saveState(inv.id, st);
  audit(req, inv.vmid, 'admin_dunning_reminder', { number: inv.number, to: row.email });
  return { sent: true };
}

/** Where unpaid renewals stand, for the Billing tab. */
export function dunningOverview(now = Date.now()) {
  const s = billingStored();
  const rows = db.prepare(`SELECT i.id, i.number, i.total, i.due_at, i.dunning, v.expired_at FROM invoices i
    JOIN vms v ON v.vmid = i.vmid AND v.user_id = i.user_id
    WHERE i.purpose = 'renewal' AND i.status = 'unpaid' AND v.renew_cancelled = 0`).all();
  const stages = { invoiced: [], final: [], overdue: [], suspended: [], paused: [] };
  for (const r of rows) {
    const st = stateOf(r);
    const due = Date.parse(r.due_at);
    const k = st.paused ? 'paused' : r.expired_at ? 'suspended' : now >= due ? 'overdue' : now >= due - DAY ? 'final' : 'invoiced';
    stages[k].push(r);
  }
  const sum = (list) => list.reduce((a, r) => a + r.total, 0);
  return {
    settings: s.dunning,
    stages: Object.fromEntries(Object.entries(stages).map(([k, list]) => [k, { count: list.length, total: sum(list) }])),
    upcoming: db.prepare(`SELECT COUNT(*) AS n FROM vms WHERE expires_at IS NOT NULL AND expired_at IS NULL AND renew_cancelled = 0
      AND expires_at <= ? AND expires_at > ?`).get(iso(now + s.dunning.issueDaysBefore * DAY), iso(now)).n,
    cancelled: db.prepare('SELECT COUNT(*) AS n FROM vms WHERE renew_cancelled = 1 AND expires_at IS NOT NULL').get().n,
  };
}

/** Customer: don't renew this server (it ends on its end date), or renew it again. */
export function setRenewCancelled(req, vmid, cancelled) {
  const vm = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?').get(vmid, req.account.id);
  if (!vm) throw fail(404, 'Server not found');
  if (!vm.expires_at) throw fail(400, 'This server has no end date');
  db.prepare('UPDATE vms SET renew_cancelled = ?, auto_renew = CASE WHEN ? THEN 0 ELSE auto_renew END WHERE vmid = ?').run(cancelled ? 1 : 0, cancelled ? 1 : 0, vmid);
  let voided = 0;
  if (cancelled) {
    voided = db.prepare("UPDATE invoices SET status = 'void', note = 'Not renewed (the customer let the server end)' WHERE vmid = ? AND user_id = ? AND purpose = 'renewal' AND status = 'unpaid'")
      .run(vmid, req.account.id).changes;
  }
  audit(req, vmid, cancelled ? 'renewal_cancelled' : 'renewal_resumed', { voided });
  return { vmid, renewCancelled: !!cancelled, voided };
}

/** For the server lifecycle: how long to keep a server running past its end date while dunning chases its invoice. */
export function holdOf(row) {
  const s = billingStored();
  if (!s.enabled || !s.dunning.enabled || row.renew_cancelled) return 0;
  const inv = db.prepare("SELECT dunning FROM invoices WHERE vmid = ? AND user_id = ? AND purpose = 'renewal' AND status = 'unpaid' ORDER BY id DESC LIMIT 1").get(row.vmid, row.user_id);
  if (!inv) return 0;
  return stateOf(inv).paused ? Infinity : s.dunning.suspendAfterDays * DAY;
}

/** The open renewal of a server (customer banner), or null. */
export function openRenewal(row) {
  const s = billingStored();
  if (!s.enabled) return null;
  const inv = db.prepare("SELECT * FROM invoices WHERE vmid = ? AND user_id = ? AND purpose = 'renewal' AND status = 'unpaid' ORDER BY id DESC LIMIT 1").get(row.vmid, row.user_id);
  if (!inv) return null;
  const due = Date.parse(inv.due_at);
  return {
    number: inv.number, total: inv.total, dueAt: inv.due_at, overdue: Date.now() >= due,
    stopAt: s.dunning.enabled && !stateOf(inv).paused ? iso(Math.max(due, Date.parse(row.expires_at ?? inv.due_at)) + s.dunning.suspendAfterDays * DAY) : null,
  };
}
