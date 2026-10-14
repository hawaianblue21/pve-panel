// Support tickets: customers open them from the panel (optionally about one of
// their servers), agents answer in the admin portal. Everything is stored here;
// with the optional Zammad sync (zammad.js) tickets and replies are mirrored to
// Zammad and agent replies come back through its webhook.
//
// Status: open (support's turn) → waiting (customer's turn, after an agent
// reply) → resolved / closed. A customer reply opens the ticket again.
// Queues: L1 first response, L2 network/compute/storage, L3 security.

import { db, audit } from './db.js';
import { clusterGuests } from './pve.js';
import { emailConfigured, sendMail, ticketReplyMessage } from './mail.js';
import * as kb from './kb.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });

export const CATEGORIES = ['server', 'network', 'storage', 'billing', 'account', 'security', 'other'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const STATUSES = ['open', 'waiting', 'resolved', 'closed'];
export const QUEUES = ['L1', 'L2', 'L3'];
const MAX_OPEN = 20;

/** First queue for a new ticket. */
export const queueFor = (category, priority) => (category === 'security' ? 'L3'
  : ['network', 'storage'].includes(category) || priority === 'urgent' ? 'L2' : 'L1');

// The Zammad sync registers itself here (keeps this module free of it).
let sync = { ticketCreated() {}, messageAdded() {}, ticketChanged() {} };
export function setSync(hooks) { sync = { ...sync, ...hooks }; }

// ---- Reading ------------------------------------------------------------------------------

const byNumber = db.prepare('SELECT * FROM tickets WHERE number = ?');

function pubTicket(t, { admin = false } = {}) {
  return {
    number: t.number, subject: t.subject, category: t.category, priority: t.priority, status: t.status,
    vmid: t.vmid, createdAt: t.created_at, updatedAt: t.updated_at,
    ...(admin ? {
      queue: t.queue, assigneeId: t.assignee_id, userId: t.user_id, email: t.email ?? undefined,
      context: t.context ? JSON.parse(t.context) : null,
      zammad: t.zammad_id ? { id: t.zammad_id, syncedAt: t.zammad_synced_at } : null, zammadError: t.zammad_error,
    } : {}),
  };
}

function messages(ticketId, { internal }) {
  return db.prepare(`SELECT m.id, m.author, m.author_name AS authorName, m.body, m.internal, m.created_at AS createdAt, u.email
    FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = ? ${internal ? '' : 'AND m.internal = 0'} ORDER BY m.id`).all(ticketId)
    .map((m) => ({
      id: m.id, author: m.author, internal: !!m.internal, body: m.body, createdAt: m.createdAt,
      // customers see "Support" or the agent's name from Zammad, never an admin's email
      name: m.author === 'customer' ? 'You' : m.author === 'system' ? 'Panel' : (m.authorName || 'Support'),
      ...(internal ? { email: m.email ?? null, name: m.author === 'customer' ? (m.email ?? 'Customer') : (m.authorName || m.email || 'Support') } : {}),
    }));
}

function own(userId, number) {
  const t = byNumber.get(Number(number));
  if (!t || t.user_id !== userId) throw fail(404, 'Ticket not found');
  return t;
}

export function listForCustomer(userId) {
  return db.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY (status IN (\'resolved\', \'closed\')), updated_at DESC')
    .all(userId).map((t) => pubTicket(t));
}

/** Tickets waiting for the customer (badge in the menu). */
export const waitingCount = (userId) => db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND status = 'waiting'").get(userId).n;

export function getForCustomer(userId, number) {
  const t = own(userId, number);
  return { ...pubTicket(t), messages: messages(t.id, { internal: false }) };
}

// ---- Customers ----------------------------------------------------------------------------

async function snapshot(vmid) {
  const row = db.prepare('SELECT vmid, label, type FROM vms WHERE vmid = ?').get(vmid);
  try {
    const g = (await clusterGuests(true)).get(vmid);
    return { vmid, name: row?.label || g?.name || null, type: row?.type ?? g?.type ?? null, status: g?.status ?? null,
      node: g?.node ?? null, cores: g?.maxcpu ?? null, memoryMb: g?.maxmem ? Math.round(g.maxmem / 2 ** 20) : null };
  } catch {
    return { vmid, name: row?.label ?? null, type: row?.type ?? null, status: 'unknown' };
  }
}

export async function createTicket(req, { subject, body, category = 'other', priority = 'normal', vmid = null }) {
  const userId = req.account.id;
  subject = String(subject ?? '').trim();
  body = String(body ?? '').trim();
  if (subject.length < 4 || subject.length > 120) throw fail(400, 'Subject: 4 to 120 characters');
  if (body.length < 10 || body.length > 10_000) throw fail(400, 'Please describe the problem (10 to 10,000 characters)');
  if (!CATEGORIES.includes(category)) throw fail(400, 'Unknown category');
  if (!PRIORITIES.includes(priority)) throw fail(400, 'Unknown priority');
  if (vmid != null && !db.prepare('SELECT 1 FROM vms WHERE vmid = ? AND user_id = ?').get(vmid, userId)) {
    throw fail(404, 'Server not found');
  }
  const open = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND status IN ('open', 'waiting')").get(userId).n;
  if (open >= MAX_OPEN) throw fail(429, `You have ${open} open tickets. Please wait for answers or close some first.`);

  const context = vmid != null ? await snapshot(vmid) : null;
  const queue = queueFor(category, priority);
  const number = db.prepare('SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM tickets').get().n;
  const id = Number(db.prepare(`INSERT INTO tickets (number, user_id, vmid, subject, category, priority, queue, context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(number, userId, vmid, subject, category, priority, queue, context ? JSON.stringify(context) : null).lastInsertRowid);
  db.prepare("INSERT INTO ticket_messages (ticket_id, author, author_id, body) VALUES (?, 'customer', ?, ?)").run(id, userId, body);
  audit(req, vmid, 'ticket_created', { number, category, priority, queue });
  sync.ticketCreated(id);
  return getForCustomer(userId, number);
}

export function customerReply(req, number, body) {
  const t = own(req.account.id, number);
  body = String(body ?? '').trim();
  if (!body || body.length > 10_000) throw fail(400, 'Write a message (up to 10,000 characters)');
  if (t.status === 'closed') throw fail(409, 'This ticket is closed. Please open a new one.');
  const mid = Number(db.prepare("INSERT INTO ticket_messages (ticket_id, author, author_id, body) VALUES (?, 'customer', ?, ?)")
    .run(t.id, req.account.id, body).lastInsertRowid);
  db.prepare("UPDATE tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(t.id);
  audit(req, t.vmid, 'ticket_replied', { number: t.number });
  sync.messageAdded(mid);
  if (t.status !== 'open') sync.ticketChanged(t.id);
  return getForCustomer(req.account.id, number);
}

export function customerClose(req, number) {
  const t = own(req.account.id, number);
  if (t.status !== 'closed') {
    db.prepare("UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(t.id);
    audit(req, t.vmid, 'ticket_closed', { number: t.number });
    sync.ticketChanged(t.id);
  }
  return getForCustomer(req.account.id, number);
}

// ---- Agents (admin portal) -------------------------------------------------------------------

export function adminList({ status = null, queue = null, q = '', mine = null } = {}) {
  const where = [];
  const args = [];
  if (status === 'active') where.push("t.status IN ('open', 'waiting')");
  else if (status) { where.push('t.status = ?'); args.push(status); }
  if (queue) { where.push('t.queue = ?'); args.push(queue); }
  if (mine) { where.push('t.assignee_id = ?'); args.push(mine); }
  const text = String(q ?? '').trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(t.subject LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR CAST(t.number AS TEXT) = ? OR CAST(t.vmid AS TEXT) = ?)");
    args.push(like, like, text.replace(/^#/, ''), text);
  }
  const rows = db.prepare(`SELECT t.*, u.email,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.internal = 0) AS messageCount
    FROM tickets t JOIN users u ON u.id = t.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
             CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC
    LIMIT 300`).all(...args);
  const counts = db.prepare(`SELECT
      SUM(status = 'open') AS open, SUM(status = 'waiting') AS waiting,
      SUM(status = 'open' AND priority IN ('urgent', 'high')) AS urgent,
      SUM(status IN ('resolved', 'closed') AND updated_at >= datetime('now', '-7 days')) AS solvedWeek
    FROM tickets`).get();
  return {
    tickets: rows.map((t) => ({ ...pubTicket(t, { admin: true }), messageCount: t.messageCount })),
    counts: { open: counts.open ?? 0, waiting: counts.waiting ?? 0, urgent: counts.urgent ?? 0, solvedWeek: counts.solvedWeek ?? 0 },
  };
}

/** A ticket with everything an agent needs next to it. */
export async function adminGet(number) {
  const t = db.prepare('SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.number = ?').get(Number(number));
  if (!t) throw fail(404, 'Ticket not found');
  const servers = db.prepare('SELECT vmid, label, type FROM vms WHERE user_id = ? ORDER BY vmid').all(t.user_id);
  let guests = new Map();
  try { guests = await clusterGuests(); } catch { /* Proxmox unreachable: list without status */ }
  const customer = db.prepare(`SELECT id, email, created_at AS createdAt, totp_enabled AS twoFactor,
      (SELECT COUNT(*) FROM tickets x WHERE x.user_id = users.id) AS tickets FROM users WHERE id = ?`).get(t.user_id);
  const activity = db.prepare(`SELECT action, vmid, created_at AS createdAt, ip FROM audit_log
    WHERE user_id = ? ORDER BY id DESC LIMIT 15`).all(t.user_id);
  return {
    ...pubTicket(t, { admin: true }),
    messages: messages(t.id, { internal: true }),
    customer: {
      ...customer, twoFactor: !!customer.twoFactor,
      servers: servers.map((s) => ({ vmid: s.vmid, name: s.label || guests.get(s.vmid)?.name || `server ${s.vmid}`, type: s.type, status: guests.get(s.vmid)?.status ?? null })),
      activity,
    },
    suggestions: kb.search(t.subject, { scope: 'agents', limit: 4 }),
  };
}

/** An agent answers (or writes an internal note). */
export async function agentReply(req, number, { body, internal = false, status = null }) {
  const t = db.prepare('SELECT * FROM tickets WHERE number = ?').get(Number(number));
  if (!t) throw fail(404, 'Ticket not found');
  body = String(body ?? '').trim();
  if (!body || body.length > 20_000) throw fail(400, 'Write a message (up to 20,000 characters)');
  const mid = Number(db.prepare("INSERT INTO ticket_messages (ticket_id, author, author_id, body, internal) VALUES (?, 'agent', ?, ?, ?)")
    .run(t.id, req.account.id, body, internal ? 1 : 0).lastInsertRowid);
  const next = status ?? (internal ? t.status : 'waiting');
  if (!STATUSES.includes(next)) throw fail(400, 'Unknown status');
  db.prepare("UPDATE tickets SET status = ?, assignee_id = COALESCE(assignee_id, ?), updated_at = datetime('now') WHERE id = ?")
    .run(next, req.account.id, t.id);
  audit(req, t.vmid, internal ? 'admin_ticket_note' : 'admin_ticket_reply', { number: t.number, status: next });
  sync.messageAdded(mid);
  if (next !== t.status) sync.ticketChanged(t.id);
  if (!internal) notifyCustomer(t, body);
  return adminGet(number);
}

/** Emails the customer about a reply (when email is set up). Never blocks the answer. */
export function notifyCustomer(t, body) {
  if (!emailConfigured()) return;
  const email = db.prepare('SELECT email FROM users WHERE id = ?').get(t.user_id)?.email;
  if (!email) return;
  sendMail({ to: email, ...ticketReplyMessage(t, body) }).catch(() => { /* logged by the mailer's caller elsewhere */ });
}

export function updateTicket(req, number, { status, priority, queue, assigneeId }) {
  const t = db.prepare('SELECT * FROM tickets WHERE number = ?').get(Number(number));
  if (!t) throw fail(404, 'Ticket not found');
  const next = {
    status: status ?? t.status, priority: priority ?? t.priority, queue: queue ?? t.queue,
    assignee_id: assigneeId === undefined ? t.assignee_id : assigneeId,
  };
  if (!STATUSES.includes(next.status) || !PRIORITIES.includes(next.priority) || !QUEUES.includes(next.queue)) throw fail(400, 'Unknown value');
  if (next.assignee_id != null && !db.prepare('SELECT 1 FROM users WHERE id = ? AND is_admin = 1').get(next.assignee_id)) {
    throw fail(400, 'Assign to an administrator');
  }
  db.prepare("UPDATE tickets SET status = ?, priority = ?, queue = ?, assignee_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next.status, next.priority, next.queue, next.assignee_id, t.id);
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => t[k] !== v));
  if (Object.keys(changed).length) {
    audit(req, t.vmid, 'admin_ticket_update', { number: t.number, ...changed });
    sync.ticketChanged(t.id);
  }
  return adminGet(number);
}

/** Draft knowledge-base article from a solved ticket: question and the last public answer. */
export function draftFromTicket(req, number) {
  const t = db.prepare('SELECT * FROM tickets WHERE number = ?').get(Number(number));
  if (!t) throw fail(404, 'Ticket not found');
  const msgs = db.prepare('SELECT author, body FROM ticket_messages WHERE ticket_id = ? AND internal = 0 ORDER BY id').all(t.id);
  const question = msgs.find((m) => m.author === 'customer')?.body ?? '';
  const answer = [...msgs].reverse().find((m) => m.author === 'agent')?.body ?? '';
  const body = `## Problem\n\n${question}\n\n## Solution\n\n${answer || '(write the steps here)'}\n`;
  const category = { server: 'Servers', network: 'Network', storage: 'Storage', billing: 'Billing', account: 'Account', security: 'Security' }[t.category] ?? 'General';
  const article = kb.create({ title: t.subject, category, body, visibility: 'customers', status: 'draft', sourceTicket: t.number }, req.account.id);
  audit(req, t.vmid, 'admin_kb_draft_from_ticket', { number: t.number, article: article.id });
  return article;
}
