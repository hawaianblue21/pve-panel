// Optional two-way sync of support tickets with a Zammad helpdesk.
//
// Panel → Zammad (REST API, agent token):
//   new ticket   POST /api/v1/tickets (customer "guess:<email>", group per queue)
//   new message  POST /api/v1/ticket_articles (customer messages on behalf of the customer)
//   changes      PUT  /api/v1/tickets/:id (state, priority, group)
// Zammad → panel (webhook, signed with HMAC-SHA1 in X-Hub-Signature):
//   articles written in Zammad (agents, or the customer by email/WhatsApp/phone)
//   and state changes come back into the panel ticket.
//
// Tickets keep working without Zammad; anything that couldn't be sent is
// retried every two minutes and shown on the ticket in the admin portal.

import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { seal, open } from './secrets.js';
import { setSync, notifyCustomer } from './support.js';

const KEY = 'zammad';
const PURPOSE = 'zammad-token';
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });

const STATE_TO_ZAMMAD = { open: 'open', waiting: 'open', resolved: 'closed', closed: 'closed' };
const PRIORITY_TO_ZAMMAD = { low: '1 low', normal: '2 normal', high: '3 high', urgent: '3 high' };

// ---- Settings ------------------------------------------------------------------------------

function stored() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : {};
}
function store(v) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(v));
}
const reveal = (sealed) => { try { return sealed ? open(PURPOSE, sealed) : ''; } catch { return ''; } };

function current() {
  const s = stored();
  return {
    enabled: !!s.enabled, url: (s.url ?? '').replace(/\/+$/, ''), token: reveal(s.token), secret: reveal(s.secret),
    groups: { L1: 'Users', L2: 'Users', L3: 'Users', ...(s.groups ?? {}) },
  };
}
export const zammadEnabled = () => { const s = current(); return s.enabled && !!s.url && !!s.token; };

/** For the Settings page: never the token; the webhook secret is shown so it can be pasted into Zammad. */
export function zammadSettings(publicUrl) {
  const s = current();
  const pending = db.prepare(`SELECT
      (SELECT COUNT(*) FROM tickets WHERE zammad_id IS NULL AND zammad_error IS NOT NULL) AS tickets,
      (SELECT COUNT(*) FROM ticket_messages WHERE zammad_pending = 1) AS messages`).get();
  return {
    enabled: s.enabled, url: s.url, hasToken: !!s.token, groups: s.groups,
    webhookUrl: publicUrl ? `${publicUrl}/api/support/zammad/webhook` : null,
    webhookSecret: s.secret || null, pending,
  };
}

export function saveZammad(input) {
  const s = stored();
  const next = { ...s };
  if (typeof input.url === 'string') {
    const url = input.url.trim().replace(/\/+$/, '');
    if (url && !/^https:\/\/[^\s/]+/.test(url) && !(process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d+/.test(url))) {
      throw fail(400, 'Zammad address: https://helpdesk.example.com');
    }
    next.url = url;
  }
  if (typeof input.token === 'string' && input.token) next.token = seal(PURPOSE, input.token.trim());
  if (input.groups && typeof input.groups === 'object') {
    next.groups = {};
    for (const q of ['L1', 'L2', 'L3']) {
      const g = String(input.groups[q] ?? '').trim();
      if (g.length > 100) throw fail(400, 'Group names: up to 100 characters');
      if (g) next.groups[q] = g;
    }
  }
  if (input.newSecret || !next.secret) next.secret = seal(PURPOSE, crypto.randomBytes(24).toString('base64url'));
  if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
  if (next.enabled && (!next.url || !reveal(next.token))) throw fail(400, 'Enter the Zammad address and an API token first');
  store(next);
}

// ---- API ------------------------------------------------------------------------------------

async function call(method, path, body, { onBehalfOf } = {}) {
  const s = current();
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: {
      Authorization: `Token token=${s.token}`, 'Content-Type': 'application/json', Accept: 'application/json',
      ...(onBehalfOf ? { 'X-On-Behalf-Of': onBehalfOf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`Zammad ${method} ${path}: HTTP ${res.status} ${data?.error ?? text.slice(0, 200)}`);
  return data;
}

/** Checks address and token (who am I, and do the groups exist). */
export async function testZammad() {
  if (!current().url || !current().token) throw fail(400, 'Enter the Zammad address and an API token first');
  try {
    const me = await call('GET', '/api/v1/users/me');
    const groups = (await call('GET', '/api/v1/groups').catch(() => [])).map((g) => g.name);
    const missing = Object.values(current().groups).filter((g) => groups.length && !groups.includes(g));
    return { ok: true, user: me?.email || me?.login || null, groups, missing: [...new Set(missing)] };
  } catch (err) {
    throw fail(502, err.message);
  }
}

// ---- Panel → Zammad ----------------------------------------------------------------------------

const ticketRow = (id) => db.prepare('SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(id);
const setError = (id, err) => db.prepare('UPDATE tickets SET zammad_error = ? WHERE id = ?').run(err ? String(err.message ?? err).slice(0, 500) : null, id);

async function pushTicket(id) {
  const t = ticketRow(id);
  if (!t || t.zammad_id) return;
  const first = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id LIMIT 1').get(id);
  const ctx = t.context ? JSON.parse(t.context) : null;
  const note = ctx ? `\n\n— Server: ${ctx.name ?? ''} (VMID ${ctx.vmid}, ${ctx.status ?? 'unknown'}${ctx.node ? `, node ${ctx.node}` : ''})` : '';
  const created = await call('POST', '/api/v1/tickets', {
    title: `[#${t.number}] ${t.subject}`,
    group: current().groups[t.queue],
    customer_id: `guess:${t.email}`,
    priority: PRIORITY_TO_ZAMMAD[t.priority],
    article: {
      subject: t.subject, body: `${first?.body ?? ''}${note}`, type: 'web', internal: false,
      sender: 'Customer', content_type: 'text/plain',
    },
  });
  db.prepare("UPDATE tickets SET zammad_id = ?, zammad_error = NULL, zammad_synced_at = datetime('now') WHERE id = ?").run(created.id, id);
  // remember the first article, so the webhook doesn't bring it back as a new message
  const articles = await call('GET', `/api/v1/ticket_articles/by_ticket/${created.id}`).catch(() => []);
  if (first && articles?.[0]?.id) {
    db.prepare('UPDATE ticket_messages SET zammad_article_id = ?, zammad_pending = 0 WHERE id = ?').run(articles[0].id, first.id);
  }
  db.prepare('UPDATE ticket_messages SET zammad_pending = 0 WHERE ticket_id = ? AND id = ?').run(id, first?.id ?? 0);
  // messages written before the ticket reached Zammad
  for (const m of db.prepare('SELECT id FROM ticket_messages WHERE ticket_id = ? AND zammad_pending = 1 ORDER BY id').all(id)) await pushMessage(m.id);
}

async function pushMessage(messageId) {
  const m = db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(messageId);
  if (!m || m.zammad_article_id) return;
  const t = ticketRow(m.ticket_id);
  if (!t.zammad_id) { await pushTicket(t.id); return; }  // the ticket push sends its pending messages
  const article = await call('POST', '/api/v1/ticket_articles', {
    ticket_id: t.zammad_id, body: m.body, content_type: 'text/plain', type: 'note',
    internal: !!m.internal, sender: m.author === 'customer' ? 'Customer' : 'Agent',
  }, { onBehalfOf: m.author === 'customer' ? t.email : undefined });
  db.prepare('UPDATE ticket_messages SET zammad_article_id = ?, zammad_pending = 0 WHERE id = ?').run(article?.id ?? null, m.id);
  db.prepare("UPDATE tickets SET zammad_error = NULL, zammad_synced_at = datetime('now') WHERE id = ?").run(t.id);
}

async function pushChanges(id) {
  const t = ticketRow(id);
  if (!t?.zammad_id) return;
  await call('PUT', `/api/v1/tickets/${t.zammad_id}`, {
    state: STATE_TO_ZAMMAD[t.status], priority: PRIORITY_TO_ZAMMAD[t.priority], group: current().groups[t.queue],
  });
  db.prepare("UPDATE tickets SET zammad_error = NULL, zammad_synced_at = datetime('now') WHERE id = ?").run(id);
}

// Runs sync steps after the request has been answered, one after the other per
// ticket (so a quick reply can't create the ticket twice); errors are kept on the ticket.
const chains = new Map();
const later = (ticketId, fn) => {
  if (!zammadEnabled()) return;
  const next = (chains.get(ticketId) ?? Promise.resolve())
    .then(fn).catch((err) => setError(ticketId, err))
    .finally(() => { if (chains.get(ticketId) === next) chains.delete(ticketId); });
  chains.set(ticketId, next);
};

/** Waits until the sync steps queued so far have run (tests, shutdown). */
export const syncIdle = () => Promise.all([...chains.values()]);

setSync({
  ticketCreated: (id) => later(id, () => pushTicket(id)),
  messageAdded: (mid) => {
    const m = db.prepare('SELECT ticket_id FROM ticket_messages WHERE id = ?').get(mid);
    if (!m || !zammadEnabled()) return;
    db.prepare('UPDATE ticket_messages SET zammad_pending = 1 WHERE id = ? AND zammad_article_id IS NULL').run(mid);
    later(m.ticket_id, () => pushMessage(mid));
  },
  ticketChanged: (id) => later(id, () => pushChanges(id)),
});

/** Sends what is still missing in Zammad (also from the "Retry" button). */
export async function retryPending() {
  if (!zammadEnabled()) return { tickets: 0, messages: 0 };
  let tickets = 0;
  let messages = 0;
  for (const t of db.prepare('SELECT id FROM tickets WHERE zammad_id IS NULL AND zammad_error IS NOT NULL').all()) {
    try { await pushTicket(t.id); tickets += 1; } catch (err) { setError(t.id, err); }
  }
  for (const m of db.prepare('SELECT id, ticket_id FROM ticket_messages WHERE zammad_pending = 1').all()) {
    try { await pushMessage(m.id); messages += 1; } catch (err) { setError(m.ticket_id, err); }
  }
  return { tickets, messages };
}

export function startZammadRetry(log) {
  setInterval(() => {
    retryPending().then((r) => { if (r.tickets || r.messages) log?.info(`Zammad: sent ${r.tickets} tickets, ${r.messages} messages that were waiting`); })
      .catch(() => {});
  }, 120_000).unref();
}

// ---- Zammad → panel (webhook) ------------------------------------------------------------------

const nameOf = (v) => (typeof v === 'string' ? v : v?.name ?? '');

function stateFromZammad(state, current) {
  const s = nameOf(state).toLowerCase();
  if (s === 'closed' || s === 'merged' || s === 'removed') return current === 'resolved' ? 'resolved' : 'closed';
  if (s.startsWith('pending')) return 'waiting';
  if (s === 'open' || s === 'new') return current === 'waiting' ? 'waiting' : 'open';
  return current;
}

/** Fastify handler: needs the raw body (req.rawBody) for the signature. */
export async function zammadWebhook(req, reply) {
  const s = current();
  if (!s.enabled || !s.secret) return reply.code(404).send({ error: 'Not found' });
  const sig = String(req.headers['x-hub-signature'] ?? '');
  const expected = `sha1=${crypto.createHmac('sha1', s.secret).update(req.rawBody ?? '').digest('hex')}`;
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    audit(req, null, 'zammad_webhook_refused', { reason: sig ? 'bad signature' : 'no signature' });
    return reply.code(401).send({ error: 'Signature does not match' });
  }
  const zt = req.body?.ticket;
  const t = zt?.id ? db.prepare('SELECT * FROM tickets WHERE zammad_id = ?').get(Number(zt.id)) : null;
  if (!t) return reply.code(202).send({ ignored: 'not a panel ticket' });

  const a = req.body.article;
  let added = null;
  if (a?.id && !db.prepare('SELECT 1 FROM ticket_messages WHERE zammad_article_id = ?').get(Number(a.id))) {
    const sender = nameOf(a.sender).toLowerCase();
    const author = sender === 'customer' ? 'customer' : sender === 'system' ? 'system' : 'agent';
    const body = String(a.body ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim().slice(0, 20_000);
    if (body) {
      const by = a.created_by;
      const name = author === 'agent'
        ? (typeof by === 'object' && by ? [by.firstname, by.lastname].filter(Boolean).join(' ') : '') || String(a.from ?? '').replace(/<.*>/, '').trim() || 'Support'
        : null;
      added = Number(db.prepare(`INSERT INTO ticket_messages (ticket_id, author, author_name, body, internal, zammad_article_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(t.id, author, name, body, a.internal ? 1 : 0, Number(a.id)).lastInsertRowid);
    }
  }
  let status = stateFromZammad(zt.state, t.status);
  if (added) {
    const m = db.prepare('SELECT author, internal FROM ticket_messages WHERE id = ?').get(added);
    if (!m.internal && m.author === 'agent' && status === 'open') status = 'waiting';
    if (!m.internal && m.author === 'customer' && status === 'waiting') status = 'open';
  }
  db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now'), zammad_synced_at = datetime('now') WHERE id = ?").run(status, t.id);
  if (added) {
    const m = db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(added);
    audit({ account: { id: t.user_id }, ip: 'zammad' }, t.vmid, 'ticket_message_from_zammad', { number: t.number, author: m.author, internal: !!m.internal });
    if (m.author === 'agent' && !m.internal) notifyCustomer(t, m.body);
  }
  return { ok: true, added: !!added, status };
}
