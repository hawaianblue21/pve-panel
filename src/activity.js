// The activity log for administrators: who did what, filtered by actor
// (customer, administrator, the panel itself), kind of action, customer,
// server or free text, newest first, in pages.

import { db } from './db.js';

// Kind of action, from its name (first match wins)
const CATEGORIES = [
  ['security', /login|twofa|passkey|sso|password|role|invite|rbac|console/],
  ['delete', /delete|deleted|removed|remove|unassign|withdraw|unlink|destroy|disconnect/],
  ['create', /create|started|_add|added|offer|connected|connect_started|assign|import|enrol/],
  ['power', /power|reboot|shutdown|suspend|_start$|_stop$|expired/],
];
export const CATEGORY_KEYS = ['create', 'change', 'delete', 'power', 'security'];
export const ACTOR_KEYS = ['customer', 'admin', 'system', 'anonymous'];

export const categoryOf = (action) => CATEGORIES.find(([, re]) => re.test(action))?.[0] ?? 'change';

/** customer | admin | system (scheduler, update tracker, …) | anonymous (failed sign-in of an unknown address) */
export function actorOf(row) {
  const ip = row.ip ?? '';
  if (ip && !/^[0-9a-f.:]+$/i.test(ip)) return 'system';
  if (row.action.startsWith('admin_') || row.isAdmin) return 'admin';
  if (row.userId == null) return 'anonymous';
  return 'customer';
}

const BATCH = 500;
const MAX_SCAN = 20_000;

export function activity({ actor = null, category = null, userId = null, vmid = null, q = '', before = null, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (userId) { where.push('a.user_id = ?'); args.push(userId); }
  if (vmid) { where.push('a.vmid = ?'); args.push(vmid); }
  const text = String(q ?? '').trim().slice(0, 100);
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(u.email LIKE ? ESCAPE '\\' OR a.action LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\' OR a.ip LIKE ? ESCAPE '\\' OR CAST(a.vmid AS TEXT) = ?)");
    args.push(like, like, like, like, text);
  }
  const page = db.prepare(`
    SELECT a.id, a.vmid, a.action, a.detail, a.ip, a.created_at AS createdAt, a.user_id AS userId,
           u.email, u.is_admin AS isAdmin
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.id < ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
    ORDER BY a.id DESC LIMIT ${BATCH}`);

  const events = [];
  let cursor = before ?? Number.MAX_SAFE_INTEGER;
  let scanned = 0;
  let exhausted = false;
  while (events.length < limit && scanned < MAX_SCAN) {
    const rows = page.all(cursor, ...args);
    if (!rows.length) { exhausted = true; break; }
    for (const r of rows) {
      cursor = r.id;
      const e = { ...r, isAdmin: !!r.isAdmin, actor: actorOf(r), category: categoryOf(r.action) };
      if ((actor && e.actor !== actor) || (category && e.category !== category)) continue;
      events.push(e);
      if (events.length >= limit) break;
    }
    scanned += rows.length;
    if (rows.length < BATCH && events.length < limit) { exhausted = true; break; }
  }
  return { events, nextBefore: exhausted && events.length < limit ? null : cursor };
}
