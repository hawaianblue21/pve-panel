// Server expiry (opt-in per customer, or per server):
//   reminders (default 7 and 1 days before) → stopped at expiry, customer can't
//   start it → grace period (default 14 days, data kept, one-click extension) →
//   deleted with disks and snapshots, ONLY for servers the customer created.
//
// Safety: servers an admin assigned are only stopped, never deleted
// automatically; nothing is deleted unless the customer was warned by email;
// deletions can be paused globally. Every step is stored per server, so a panel
// restart never repeats or skips one.

import { db, audit } from './db.js';
import { clusterGuests, guestPath, pve, waitTask } from './pve.js';
import { destroyServer } from './cleanup.js';
import { runDunning, holdOf, openRenewal } from './dunning.js';
import {
  emailConfigured, sendMail, expiryReminderMessage, expiredMessage,
  finalWarningMessage, expiryDeletedMessage, expirySummaryMessage,
} from './mail.js';

const DAY = 86_400_000;
const KEY = 'expiry';
export const DEFAULT_SETTINGS = {
  reminderDays: [7, 1],    // days before expiry
  graceDays: 14,           // stopped, data kept, then deleted
  selfExtendDays: 14,      // a customer's one self-service extension
  pauseDeletions: false,   // global brake: only stop, never delete
  adminSummary: true,      // daily email to administrators
};

// ---- Settings --------------------------------------------------------------------------

export function expirySettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  const stored = row ? JSON.parse(row.value) : {};
  const s = { ...DEFAULT_SETTINGS, ...stored };
  delete s.lastSummaryAt;
  return s;
}

function rawSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : {};
}

function storeSettings(values) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(KEY, JSON.stringify(values));
}

export function saveExpirySettings(input) {
  const next = { ...rawSettings() };
  if (Array.isArray(input.reminderDays)) {
    next.reminderDays = [...new Set(input.reminderDays.map(Number).filter((d) => Number.isInteger(d) && d > 0 && d <= 365))]
      .sort((a, b) => b - a);
  }
  for (const k of ['graceDays', 'selfExtendDays']) if (Number.isInteger(input[k])) next[k] = input[k];
  for (const k of ['pauseDeletions', 'adminSummary']) if (typeof input[k] === 'boolean') next[k] = input[k];
  storeSettings(next);
  return expirySettings();
}

// ---- Dates for servers -------------------------------------------------------------------

/** End of a calendar day (server's local time zone). */
const endOfDay = (yyyyMmDd) => new Date(`${yyyyMmDd}T23:59:59`).toISOString();

/** Expiry for a server the customer is creating now, from the customer's rule. */
export function expiryForNewServer(userId, now = new Date()) {
  const u = db.prepare('SELECT expiry_mode, expiry_days, expiry_date FROM users WHERE id = ?').get(userId);
  if (u?.expiry_mode === 'after_creation' && u.expiry_days > 0) return new Date(now.getTime() + u.expiry_days * DAY).toISOString();
  if (u?.expiry_mode === 'fixed_date' && u.expiry_date) return endOfDay(u.expiry_date);
  return null;
}

const resetStages = (vmid, expiresAt, manual) => db.prepare(`
  UPDATE vms SET expires_at = ?, expiry_set_at = ?, expiry_manual = ?, expired_at = NULL, expiry_notified = NULL
  WHERE vmid = ?`).run(expiresAt, expiresAt ? new Date().toISOString() : null, manual ? 1 : 0, vmid);

/**
 * After a customer's rule changed: a fixed date applies to all their servers
 * (except dates set by hand); "no expiry" removes rule-based dates. "N days after
 * creation" only applies to servers created from now on.
 */
export function applyCustomerRule(userId) {
  const u = db.prepare('SELECT expiry_mode, expiry_date FROM users WHERE id = ?').get(userId);
  const rows = db.prepare('SELECT vmid, expires_at FROM vms WHERE user_id = ? AND expiry_manual = 0').all(userId);
  for (const r of rows) {
    if (u?.expiry_mode === 'fixed_date' && u.expiry_date) {
      const at = endOfDay(u.expiry_date);
      if (r.expires_at !== at) resetStages(r.vmid, at, false);
    } else if (!u?.expiry_mode && r.expires_at) {
      resetStages(r.vmid, null, false);
    }
  }
}

/** Set (or remove with null) a server's expiry by hand; an expired server becomes active again. */
export function setServerExpiry(vmid, expiresAt) {
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw Object.assign(new Error('Invalid date'), { statusCode: 400, expose: true });
  resetStages(vmid, expiresAt ? new Date(expiresAt).toISOString() : null, true);
}

/** Extend by days from the current expiry (from now once it was stopped); reactivates an expired server. */
export function extendServer(vmid, days) {
  const row = db.prepare('SELECT expires_at, expiry_manual, expired_at FROM vms WHERE vmid = ?').get(vmid);
  const exp = row?.expires_at ? Date.parse(row.expires_at) : 0;
  // still running past the end date (unpaid, before suspension): the new period follows the old one
  const from = row?.expires_at && !row.expired_at && exp > Date.now() - 14 * DAY ? exp : Math.max(Date.now(), exp);
  const at = new Date(from + days * DAY).toISOString();
  resetStages(vmid, at, true);
  return at;
}

/** What the customer portal and admin list show for a server. */
export function expiryInfo(row, settings = expirySettings()) {
  if (!row.expires_at) return null;
  const expired = !!row.expired_at;
  const deleteAt = expired ? new Date(Date.parse(row.expired_at) + settings.graceDays * DAY).toISOString() : null;
  const user = db.prepare('SELECT expiry_self_extend FROM users WHERE id = ?').get(row.user_id);
  return {
    expiresAt: row.expires_at,
    expired,
    expiredAt: row.expired_at ?? null,
    // only customer-created servers are deleted automatically
    deleteAt: expired && row.created_by_customer ? deleteAt : null,
    canExtend: !!user?.expiry_self_extend && !row.self_extended,
    extendDays: settings.selfExtendDays,
    invoice: openRenewal(row),
    renewCancelled: !!row.renew_cancelled,
  };
}

/**
 * The lifecycle queue (admin): every server with an end date, where it stands and
 * what happens next. stage: later (more than 7 days) | soon (within 7 days) |
 * grace (stopped, will be deleted) | stopped (stopped, assigned by an admin: never
 * deleted, an admin decides) | due (deletion time passed but paused or no warning
 * delivered).
 */
export function expiryQueue({ now = Date.now(), names = new Map() } = {}) {
  const s = expirySettings();
  const rows = db.prepare(`SELECT v.*, u.email FROM vms v JOIN users u ON u.id = v.user_id
    WHERE v.expires_at IS NOT NULL AND u.deleting = 0 ORDER BY v.expires_at`).all();
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const items = rows.map((r) => {
    const exp = Date.parse(r.expires_at);
    const sent = JSON.parse(r.expiry_notified || '[]');
    const warned = sent.includes('expired') || sent.includes('final');
    let stage; let next; let nextAt = null;
    if (!r.expired_at) {
      stage = exp - now <= 7 * DAY ? 'soon' : 'later';
      const reminders = s.reminderDays.filter((d) => !sent.includes(`r${d}`) && exp - d * DAY > now).sort((a, b) => b - a);
      const inv = openRenewal(r);
      if (inv) {
        next = inv.stopAt ? `Invoice ${inv.number} ${inv.overdue ? 'overdue' : 'open'}; stopped if unpaid` : `Invoice ${inv.number} open; dunning paused (not stopped)`;
        nextAt = inv.stopAt;
      } else if (r.renew_cancelled) { next = 'Not renewed (customer); stopped at the end date'; nextAt = r.expires_at; }
      else if (r.auto_renew) { next = 'Auto-renew from the wallet before the end date'; nextAt = r.expires_at; }
      else if (reminders.length) { next = `Reminder ${reminders[0]} day${reminders[0] === 1 ? '' : 's'} before`; nextAt = new Date(exp - reminders[0] * DAY).toISOString(); }
      else { next = 'Stopped at the end date'; nextAt = r.expires_at; }
    } else if (!r.created_by_customer) {
      stage = 'stopped'; next = 'Stopped; never deleted automatically (assigned by an administrator)';
    } else {
      const deleteAt = Date.parse(r.expired_at) + s.graceDays * DAY;
      nextAt = new Date(deleteAt).toISOString();
      if (now < deleteAt) { stage = 'grace'; next = 'Deleted with its disks after the grace period'; }
      else { stage = 'due'; next = s.pauseDeletions ? 'Deletion due, but deletions are paused' : warned ? 'Deleted at the next check' : 'Deletion held: the customer was not warned by email'; }
    }
    return {
      vmid: r.vmid, name: r.label || names.get(r.vmid) || `server ${r.vmid}`, email: r.email, userId: r.user_id,
      source: r.created_by_customer ? 'Created by customer' : 'Assigned by administrator', manual: !!r.expiry_manual,
      expiresAt: r.expires_at, expiredAt: r.expired_at, stage, next, nextAt, autoRenew: !!r.auto_renew,
      sent: sent.map((x) => (x === 'expired' ? 'stopped notice' : x === 'final' ? 'final warning' : `reminder ${x.slice(1)} d`)),
      endDay: day(exp),
    };
  });
  const count = (st) => items.filter((i) => i.stage === st).length;
  return {
    items, settings: s,
    counts: { all: items.length, soon: count('soon'), grace: count('grace'), due: count('due'), stopped: count('stopped'), later: count('later') },
  };
}

/** The customer's one self-service extension. */
export function customerExtend(req, row) {
  const info = expiryInfo(row);
  if (!info) throw Object.assign(new Error('This server does not expire'), { statusCode: 400, expose: true });
  if (!info.canExtend) throw Object.assign(new Error('This server cannot be extended here. Contact your provider.'), { statusCode: 403, expose: true });
  const at = extendServer(row.vmid, info.extendDays);
  db.prepare('UPDATE vms SET self_extended = 1 WHERE vmid = ?').run(row.vmid);
  audit(req, row.vmid, 'server_expiry_extended', { by: 'customer', days: info.extendDays, expiresAt: at });
  return { expiresAt: at };
}

// ---- The lifecycle job -------------------------------------------------------------------

// Runs are queued, never parallel: "Check now" during a scheduled run waits for it.
let queue = Promise.resolve();

async function notify(row, message) {
  if (!emailConfigured()) return false;
  try {
    await sendMail({ to: row.email, ...message });
    return true;
  } catch {
    return false;
  }
}

/**
 * One pass over all servers with an expiry date. Returns what happened (also
 * used for the admin summary and the "Check now" button).
 */
export function runExpiry(options = {}) {
  const run = queue.then(() => runOnce(options));
  queue = run.catch(() => {});
  return run;
}

async function runOnce({ log, now = Date.now() } = {}) {
  // renewal invoices first, so the lifecycle sees what dunning issued, charged or paused
  await runDunning({ log, now }).catch((err) => log?.warn(`Dunning: ${err.message}`));
  const settings = expirySettings();
  const summary = { stopped: [], deleted: [], reminded: [], awaitingAdmin: [], paused: [], blocked: [], upcoming: [], errors: [] };
  try {
    const rows = db.prepare(`
      SELECT v.*, u.email, u.expiry_self_extend FROM vms v JOIN users u ON u.id = v.user_id
      WHERE v.expires_at IS NOT NULL AND v.state = 'ready' AND u.deleting = 0`).all();
    if (!rows.length) return summary;
    const guests = await clusterGuests(true);

    for (const row of rows) {
      const name = `${row.label || guests.get(row.vmid)?.name || `server ${row.vmid}`} (${row.vmid}, ${row.email})`;
      const sent = new Set(JSON.parse(row.expiry_notified || '[]'));
      const save = () => db.prepare('UPDATE vms SET expiry_notified = ? WHERE vmid = ?').run(JSON.stringify([...sent]), row.vmid);
      const actor = { account: { id: row.user_id }, ip: 'expiry' };
      const exp = Date.parse(row.expires_at);
      const info = expiryInfo(row, settings);
      try {
        if (!row.expired_at) {
          // an unpaid renewal being chased (dunning.js) keeps the server running a few days longer
          const hold = holdOf(row);
          if (now >= exp + hold) {
            // Expired: stop it (data stays), customer can no longer start it
            const guest = guests.get(row.vmid);
            if (guest && guest.status !== 'stopped') {
              await waitTask(guest.node, await pve.post(`${guestPath(guest)}/status/stop`));
            }
            db.prepare('UPDATE vms SET expired_at = ? WHERE vmid = ?').run(new Date(now).toISOString(), row.vmid);
            const deleteAt = new Date(now + settings.graceDays * DAY).toISOString();
            if (await notify(row, expiredMessage(row, { deleteAt, willDelete: !!row.created_by_customer, canExtend: info.canExtend }))) sent.add('expired');
            save();
            audit(actor, row.vmid, 'server_expired', { deleteAt: row.created_by_customer ? deleteAt : null });
            summary.stopped.push(name);
            continue;
          }
          // in the hold: nothing more to send (dunning sent the overdue notice)
          if (now >= exp) continue;
          // An open renewal invoice: dunning sends the reminders (with the pay link) instead
          if (hold > 0 || openRenewal(row)) continue;
          // Reminders: thresholds reached now; skip those that were already
          // past when the date was set (e.g. a 3-day server gets no 7-day mail)
          const setAt = Date.parse(row.expiry_set_at || row.expires_at);
          const due = settings.reminderDays.filter((d) => now >= exp - d * DAY && !sent.has(`r${d}`));
          if (due.length) {
            const meaningful = due.filter((d) => exp - setAt > d * DAY);
            due.forEach((d) => sent.add(`r${d}`));
            if (meaningful.length && await notify(row, expiryReminderMessage(row, {
              expiresAt: row.expires_at, graceDays: row.created_by_customer ? settings.graceDays : 0, canExtend: info.canExtend,
            }))) summary.reminded.push(name);
            save();
          }
          if (exp - now <= 7 * DAY) summary.upcoming.push(`${name}: ${new Date(exp).toISOString().slice(0, 10)}`);
          continue;
        }

        // Expired, in the grace period
        if (!row.created_by_customer) { summary.awaitingAdmin.push(name); continue; }
        const deleteAt = Date.parse(row.expired_at) + settings.graceDays * DAY;
        if (settings.graceDays >= 2 && now >= deleteAt - DAY && now < deleteAt && !sent.has('final')) {
          if (await notify(row, finalWarningMessage(row, { deleteAt: new Date(deleteAt).toISOString(), canExtend: info.canExtend }))) {
            sent.add('final');
            save();
          }
        }
        if (now < deleteAt) continue;
        if (settings.pauseDeletions) { summary.paused.push(name); continue; }
        if (!sent.has('expired') && !sent.has('final')) { summary.blocked.push(name); continue; }

        await destroyServer(actor, row.vmid);
        await notify(row, expiryDeletedMessage(row));
        audit(actor, row.vmid, 'server_expired_deleted', { expiredAt: row.expired_at });
        summary.deleted.push(name);
      } catch (err) {
        summary.errors.push(`${name}: ${err.message}`);
        log?.warn(`Expiry: ${name}: ${err.message}`);
      }
    }
    return summary;
  } catch (err) {
    summary.errors.push(err.message);
    return summary;
  }
}

/** Daily summary for administrators (only when there is something to tell). */
async function maybeSummary(summary, log) {
  const s = expirySettings();
  if (!s.adminSummary || !emailConfigured()) return;
  const raw = rawSettings();
  if (raw.lastSummaryAt && Date.now() - Date.parse(raw.lastSummaryAt) < DAY) return;
  const interesting = ['stopped', 'deleted', 'awaitingAdmin', 'paused', 'blocked', 'upcoming'].some((k) => summary[k]?.length);
  if (!interesting) return;
  const admins = db.prepare('SELECT email FROM users WHERE is_admin = 1 AND deleting = 0').all();
  for (const a of admins) await sendMail({ to: a.email, ...expirySummaryMessage(summary) }).catch(() => {});
  storeSettings({ ...raw, lastSummaryAt: new Date().toISOString() });
  log?.info(`Expiry summary sent to ${admins.length} administrator(s)`);
}

/**
 * Runs the job regularly: every EXPIRY_CHECK_SECONDS (default 300). 0 switches
 * automatic runs off; then only "Check now" in the admin interface acts.
 */
export function startExpiryScheduler(log) {
  const seconds = Number(process.env.EXPIRY_CHECK_SECONDS ?? 300);
  if (seconds === 0) {
    log.info('Automatic expiry checks are off (EXPIRY_CHECK_SECONDS=0)');
    return;
  }
  const every = Math.max(5, seconds || 300) * 1000;
  const tick = async () => {
    try {
      const summary = await runExpiry({ log });
      if (summary.stopped.length || summary.deleted.length) {
        log.info(`Expiry: ${summary.stopped.length} stopped, ${summary.deleted.length} deleted`);
      }
      await maybeSummary(summary, log);
    } catch (err) {
      log.warn(`Expiry check failed: ${err.message}`);
    }
  };
  setTimeout(tick, Math.min(every, 20_000)).unref();
  setInterval(tick, every).unref();
}
