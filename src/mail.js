// Email (SMTP), configured in the admin interface and stored in the database.
// The SMTP password is encrypted at rest and never sent back to the browser.

import nodemailer from 'nodemailer';
import { db } from './db.js';
import { config } from './config.js';
import { seal, open } from './secrets.js';
import { schemeColors } from './appearance.js';
import { brandName } from './branding.js';

const KEY = 'email';
const PURPOSE = 'smtp-password';

const read = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : null;
};

/** Settings as shown in the admin interface (no password). */
export function emailSettings() {
  const s = read();
  return {
    configured: !!(s?.host && s?.fromAddress && s?.panelUrl),
    host: s?.host ?? '',
    port: s?.port ?? 587,
    security: s?.security ?? 'starttls',      // tls | starttls | none
    username: s?.username ?? '',
    hasPassword: !!s?.password,
    fromName: s?.fromName ?? brandName(),
    fromAddress: s?.fromAddress ?? '',
    panelUrl: s?.panelUrl ?? config.oidc.publicUrl.customer ?? '',
    updatedAt: db.prepare('SELECT updated_at FROM settings WHERE key = ?').get(KEY)?.updated_at ?? null,
  };
}

export const emailConfigured = () => emailSettings().configured;

/**
 * Saves settings. `password`: undefined = keep the stored one, '' = remove it,
 * anything else = store (encrypted).
 */
export function saveEmailSettings(input) {
  const current = read() ?? {};
  const next = {
    host: input.host.trim(),
    port: input.port,
    security: input.security,
    username: (input.username ?? '').trim(),
    fromName: (input.fromName ?? '').trim(),
    fromAddress: input.fromAddress.trim(),
    panelUrl: input.panelUrl.trim().replace(/\/+$/, ''),
    password: input.password === undefined ? current.password
      : input.password === '' ? null
      : seal(PURPOSE, input.password),
  };
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(KEY, JSON.stringify(next));
  transport = null; // rebuilt with the new settings
}

export function deleteEmailSettings() {
  db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
  transport = null;
}

let transport = null;
function getTransport() {
  if (transport) return transport;
  const s = read();
  if (!s?.host) throw Object.assign(new Error('Email is not configured'), { statusCode: 409, expose: true });
  let pass;
  if (s.password) {
    try { pass = open(PURPOSE, s.password); } catch {
      throw Object.assign(new Error('The stored SMTP password can no longer be read (JWT_SECRET changed?). Enter it again.'),
        { statusCode: 409, expose: true });
    }
  }
  transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',             // TLS from the first byte (usually 465)
    requireTLS: s.security === 'starttls',    // refuse to continue without STARTTLS (usually 587)
    ignoreTLS: s.security === 'none',
    auth: s.username ? { user: s.username, pass } : undefined,
    tls: { minVersion: 'TLSv1.2' },           // certificates are always verified
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transport;
}

function sender() {
  const s = read();
  const name = (s.fromName || brandName()).replace(/["\r\n]/g, '');
  return `"${name}" <${s.fromAddress}>`;
}

/** Sends a message; throws with a readable reason when the server refuses. */
export async function sendMail({ to, subject, text, html }) {
  try {
    const info = await getTransport().sendMail({ from: sender(), to, subject, text, html });
    return { messageId: info.messageId };
  } catch (err) {
    if (err.expose) throw err;
    const reason = err.response || err.message || String(err);
    throw Object.assign(new Error(`Sending the email failed: ${reason}`), { statusCode: 502, expose: true });
  }
}

// ---- Messages -----------------------------------------------------------------------

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, paragraphs, button, footer }) {
  const brand = esc(brandName());
  const { accent, side } = schemeColors(); // the panel's color scheme
  return `<!doctype html><html><body style="margin:0;background:#eef2f6;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#172230">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #d9e0e8">
<tr><td style="background:${side};color:#ffffff;padding:18px 28px;border-radius:14px 14px 0 0;font-size:17px;font-weight:700">${brand}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:22px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${p}</p>`).join('\n')}
${button ? `<p style="margin:22px 0"><a href="${esc(button.href)}" style="background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>
<p style="margin:0 0 14px;font-size:13px;color:#5a6878">If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all">${esc(button.href)}</span></p>` : ''}
${footer ? `<p style="margin:22px 0 0;font-size:13px;color:#5a6878">${footer}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
}

/**
 * The invitation: panel address, sign-in email, and either the one-time link to
 * set a password or, with single sign-on only, how to sign in.
 */
export function invitationMessage({ email, link, expiresHours, requireTotp, sso, passwordLogin, isAdmin }) {
  const s = emailSettings();
  const brand = brandName();
  const panel = s.panelUrl;
  const steps = [];
  const text = [];

  const intro = `You now have access to ${brand}${isAdmin ? ' as an administrator' : ''}, where you can manage your servers.`;
  text.push('Hello,', '', intro, '', `Panel: ${panel}`, `Your sign-in email: ${email}`, '');
  steps.push(esc(intro));
  steps.push(`<strong>Panel:</strong> <a href="${esc(panel)}">${esc(panel)}</a><br><strong>Your sign-in email:</strong> ${esc(email)}`);

  if (passwordLogin && link) {
    const days = Math.round(expiresHours / 24);
    const line = `To get started, set your password with this personal link. It works once and expires in ${days} day${days === 1 ? '' : 's'}.`;
    text.push(line, link, '');
    steps.push(esc(line));
  }
  if (sso) {
    const line = passwordLogin
      ? `You can also sign in with "${sso}".`
      : `Sign in with "${sso}" on the panel, using your usual company account.`;
    text.push(line, '');
    steps.push(esc(line));
  }
  if (requireTotp) {
    const line = 'At your first sign-in you set up two-factor authentication: have an authenticator app (for example Google or Microsoft Authenticator) ready on your phone.';
    text.push(line, '');
    steps.push(esc(line));
  }
  const footer = "If you didn't expect this email, you can ignore it; nothing happens without the link.";
  text.push(footer);

  return {
    subject: `Your access to ${brand}`,
    text: text.join('\n'),
    html: layout({
      title: `Welcome to ${brand}`,
      paragraphs: steps,
      button: passwordLogin && link ? { href: link, label: 'Set your password' } : { href: panel, label: `Open ${brand}` },
      footer: esc(footer),
    }),
  };
}

export function testMessage(to) {
  const brand = brandName();
  const line = `This is a test from ${brand}. Email sending works.`;
  return {
    subject: `${brand}: test email`,
    text: `${line}\n\nSent to ${to}.`,
    html: layout({ title: 'Email works', paragraphs: [esc(line)] }),
  };
}

// ---- Expiry -----------------------------------------------------------------------------

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const serverName = (s) => s.label || s.name || `server ${s.vmid}`;

function expiryMail(title, lines, { button = true, footer } = {}) {
  const panel = emailSettings().panelUrl;
  return {
    subject: title,
    text: [...lines, '', `Panel: ${panel}`, ...(footer ? ['', footer] : [])].join('\n'),
    html: layout({
      title,
      paragraphs: lines.map(esc),
      button: button && panel ? { href: panel, label: `Open ${brandName()}` } : null,
      footer: footer ? esc(footer) : null,
    }),
  };
}

/** Reminder before expiry. */
export function expiryReminderMessage(server, { expiresAt, graceDays, canExtend }) {
  const days = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000));
  return expiryMail(`Your server ${serverName(server)} expires in ${days} day${days === 1 ? '' : 's'}`, [
    `Your server “${serverName(server)}” expires on ${fmtDate(expiresAt)}.`,
    `It will then be stopped. ${graceDays > 0 ? `After another ${graceDays} days it will be deleted with all its data, unless it is extended.` : 'It will then be deleted with all its data.'}`,
    canExtend ? 'You can extend it once yourself on the server page in the panel.' : 'If you still need it, please contact your provider to extend it.',
  ]);
}

/** The server expired and was stopped. */
export function expiredMessage(server, { deleteAt, willDelete, canExtend }) {
  return expiryMail(`Your server ${serverName(server)} has expired`, [
    `Your server “${serverName(server)}” has expired and was stopped. Its data is still there.`,
    willDelete
      ? `It will be deleted with all its data on ${fmtDate(deleteAt)}, unless it is extended before then.`
      : 'Your provider will decide what happens with it.',
    canExtend ? 'You can extend it once yourself on the server page in the panel.' : 'If you still need it, please contact your provider.',
  ]);
}

/** Last warning before deletion. */
export function finalWarningMessage(server, { deleteAt, canExtend }) {
  return expiryMail(`Last notice: ${serverName(server)} will be deleted tomorrow`, [
    `Your expired server “${serverName(server)}” will be deleted with all its data on ${fmtDate(deleteAt)}.`,
    'Deleted servers cannot be restored.',
    canExtend ? 'You can still extend it once yourself on the server page.' : 'If you still need it, contact your provider today.',
  ]);
}

/** The server was deleted after the grace period. */
export function expiryDeletedMessage(server) {
  return expiryMail(`Your server ${serverName(server)} was deleted`, [
    `Your server “${serverName(server)}” expired and has now been deleted after the grace period.`,
  ], { button: false });
}

/** Daily summary for administrators. */
export function expirySummaryMessage(summary) {
  const line = (title, list) => (list.length ? [`${title}:`, ...list.map((x) => `• ${x}`), ''] : []);
  const lines = [
    ...line('Stopped (expired)', summary.stopped),
    ...line('Deleted', summary.deleted),
    ...line('Expired servers you assigned (not deleted automatically, your decision)', summary.awaitingAdmin),
    ...line('Deletion paused (setting)', summary.paused),
    ...line('Not deleted: the customer could not be warned (email not configured)', summary.blocked),
    ...line('Expiring in the next 7 days', summary.upcoming),
  ];
  const text = lines.join('\n').trim();
  return {
    subject: `${brandName()}: server expiry summary`,
    text: `${text}\n\nManage expiry in the admin interface (Servers and Customers).`,
    html: layout({
      title: 'Server expiry summary',
      paragraphs: lines.filter(Boolean).map((l) => (l.endsWith(':') ? `<strong>${esc(l)}</strong>` : esc(l))),
      footer: 'Manage expiry in the admin interface (Servers and Customers).',
    }),
  };
}

// ---- Support tickets ----------------------------------------------------------------------

/** A support agent answered a customer's ticket. */
export function ticketReplyMessage(ticket, body) {
  const panel = emailSettings().panelUrl;
  const link = panel ? `${panel.replace(/\/+$/, '')}/#support/${ticket.number}` : '';
  const title = `New reply to your ticket #${ticket.number}: ${ticket.subject}`;
  const lines = [`Support answered your ticket “${ticket.subject}”:`, body.length > 4000 ? `${body.slice(0, 4000)}…` : body];
  return {
    subject: title,
    text: [...lines, '', link ? `Reply in the panel: ${link}` : ''].join('\n'),
    html: layout({
      title,
      paragraphs: lines.map((l, i) => (i === 1 ? `<span style="white-space:pre-wrap">${esc(l)}</span>` : esc(l))),
      button: link ? { href: link, label: 'Open the ticket' } : null,
      footer: 'Reply in the panel, so your answer reaches the right person.',
    }),
  };
}

// ---- Billing --------------------------------------------------------------------------------------

const rupiah = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;

/** Receipt after an invoice was paid. */
export function paymentReceiptMessage(inv, expiresAt) {
  const panel = emailSettings().panelUrl;
  const link = panel ? `${panel.replace(/\/+$/, '')}/#billing/${inv.number}` : '';
  const title = `Payment received: ${inv.number}`;
  const lines = [
    `Thank you. We received ${rupiah(inv.total)} for invoice ${inv.number}${inv.paidVia ? ` (${inv.paidVia})` : ''}.`,
    ...inv.lines.map((l) => `${l.description}: ${rupiah(l.amount)}`),
    inv.tax ? `${inv.taxName} ${inv.taxRate}%: ${rupiah(inv.tax)}` : null,
    expiresAt ? `Your server now runs until ${fmtDate(expiresAt)}.` : null,
    inv.purpose === 'topup' ? 'The amount was added to your wallet.' : null,
  ].filter(Boolean);
  return {
    subject: title,
    text: [...lines, '', link ? `Invoice: ${link}` : ''].join('\n'),
    html: layout({ title, paragraphs: lines.map(esc), button: link ? { href: link, label: 'View the invoice' } : null }),
  };
}

/** Auto-renew could not pay from the wallet. */
export function autoRenewFailedMessage(inv, balance) {
  const panel = emailSettings().panelUrl;
  const link = panel ? `${panel.replace(/\/+$/, '')}/#billing/${inv.number}` : '';
  const title = `Please renew: not enough balance for ${inv.number}`;
  const lines = [
    `Your server is set to renew automatically, but the wallet has ${rupiah(balance)} and the renewal costs ${rupiah(inv.total)}.`,
    'Pay the invoice or top up the wallet before the end date, so the server keeps running.',
  ];
  return {
    subject: title,
    text: [...lines, '', link ? `Pay: ${link}` : ''].join('\n'),
    html: layout({ title, paragraphs: lines.map(esc), button: link ? { href: link, label: 'Pay now' } : null }),
  };
}

/** A provider rollout is installing updates on the customer's server. */
export function rolloutNoticeMessage(server, { scope, snapshot, autoRestart }) {
  const panel = emailSettings().panelUrl;
  const link = panel ? `${panel.replace(/\/+$/, '')}/#${server.vmid}` : '';
  const title = `Updates are being installed on ${server.name}`;
  const lines = [
    `Your provider is installing ${scope === 'all' ? 'all available' : 'security'} updates on ${server.name} (${server.vmid}).`,
    snapshot ? 'A snapshot was taken first, so the server can be rolled back if something goes wrong.' : 'No snapshot was taken.',
    autoRestart ? 'The server restarts by itself if an update needs it.' : 'If an update needs a restart, the server page will tell you.',
    'You can follow the progress on the server page (Updates tab).',
  ];
  return {
    subject: title,
    text: [...lines, '', link ? `Server: ${link}` : ''].join('\n'),
    html: layout({ title, paragraphs: lines.map(esc), button: link ? { href: link, label: 'Open the server' } : null }),
  };
}
