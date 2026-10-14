// Knowledge base: articles in Markdown, written by administrators, read by
// customers in the help center and by agents next to a ticket.
//
// Visibility: public (also before sign-in), customers (signed in) or internal
// (agents only). Only published articles are shown outside the editor.
// Searches are logged with their number of results; searches without a result
// are the list of articles still missing.

import { db } from './db.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
export const VISIBILITY = ['public', 'customers', 'internal'];

const slugify = (title) => title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'article';

function uniqueSlug(title, exceptId = null) {
  const base = slugify(title);
  for (let n = 1; ; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const row = db.prepare('SELECT id FROM kb_articles WHERE slug = ?').get(slug);
    if (!row || row.id === exceptId) return slug;
  }
}

const pub = (a, { full = false, admin = false } = {}) => a && ({
  id: a.id, slug: a.slug, title: a.title, category: a.category,
  ...(full ? { body: a.body } : { excerpt: excerpt(a.body) }),
  updatedAt: a.updated_at,
  ...(admin ? {
    visibility: a.visibility, status: a.status, sourceTicket: a.source_ticket, createdAt: a.created_at,
    publishedAt: a.published_at, views: a.views, helpful: a.helpful, notHelpful: a.not_helpful,
  } : {}),
});

/** First words of an article without Markdown marks. */
function excerpt(body) {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`[\]()-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

// ---- Search ----------------------------------------------------------------------------

const words = (q) => [...new Set(String(q ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, 12);

/**
 * Ranks published articles the reader may see: title words count most, then
 * the category, then the text. scope: 'public' | 'customers' | 'agents'.
 */
export function search(q, { scope = 'customers', limit = 10, log = false } = {}) {
  const terms = words(q);
  const allowed = scope === 'agents' ? VISIBILITY : scope === 'customers' ? ['public', 'customers'] : ['public'];
  const rows = db.prepare(`SELECT * FROM kb_articles WHERE status = 'published' AND visibility IN (${allowed.map(() => '?').join(',')})`).all(...allowed);
  const scored = terms.length ? rows.map((a) => {
    const title = a.title.toLowerCase();
    const body = a.body.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const inTitle = title.includes(t);
      const inBody = body.split(t).length - 1;
      if (inTitle || inBody || a.category.toLowerCase().includes(t)) matched += 1;
      score += (inTitle ? 6 : 0) + (a.category.toLowerCase().includes(t) ? 2 : 0) + Math.min(inBody, 5);
    }
    // most of the words should be there
    return { a, score: matched >= Math.ceil(terms.length / 2) ? score + a.helpful * 0.1 : 0 };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score) : rows.map((a) => ({ a, score: 0 }));
  const results = scored.slice(0, limit).map(({ a }) => pub(a));
  if (log && terms.length) {
    db.prepare('INSERT INTO kb_searches (query, results, signed_in) VALUES (?, ?, ?)')
      .run(String(q).trim().slice(0, 200), scored.length, scope === 'public' ? 0 : 1);
  }
  return results;
}

/** Categories with their published articles (help center start page). */
export function overview(scope = 'customers') {
  const allowed = scope === 'customers' ? ['public', 'customers'] : ['public'];
  const rows = db.prepare(`SELECT * FROM kb_articles WHERE status = 'published' AND visibility IN (${allowed.map(() => '?').join(',')})
    ORDER BY category, helpful DESC, title`).all(...allowed);
  const cats = new Map();
  for (const a of rows) {
    if (!cats.has(a.category)) cats.set(a.category, []);
    cats.get(a.category).push(pub(a));
  }
  return [...cats].map(([name, articles]) => ({ name, articles }));
}

function visible(slug, scope) {
  const a = db.prepare("SELECT * FROM kb_articles WHERE slug = ? AND status = 'published'").get(String(slug));
  const ok = a && (a.visibility === 'public' || (a.visibility === 'customers' && scope !== 'public') || scope === 'agents');
  if (!ok) throw fail(404, 'Article not found');
  return a;
}

/** One article for a reader; counts the view. */
export function read(slug, scope = 'customers') {
  const a = visible(slug, scope);
  db.prepare('UPDATE kb_articles SET views = views + 1 WHERE id = ?').run(a.id);
  return pub(a, { full: true });
}

export function feedback(slug, helpful, scope = 'customers') {
  const a = visible(slug, scope);
  db.prepare(`UPDATE kb_articles SET ${helpful ? 'helpful = helpful + 1' : 'not_helpful = not_helpful + 1'} WHERE id = ?`).run(a.id);
}

// ---- Editor (administrators) ------------------------------------------------------------

export function listAll() {
  return db.prepare('SELECT * FROM kb_articles ORDER BY status, updated_at DESC').all().map((a) => pub(a, { admin: true }));
}

export function getById(id) {
  const a = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(id);
  if (!a) throw fail(404, 'Article not found');
  return pub(a, { full: true, admin: true });
}

function validate(input, partial) {
  const out = {};
  if (input.title !== undefined || !partial) {
    const t = String(input.title ?? '').trim();
    if (t.length < 3 || t.length > 150) throw fail(400, 'Title: 3 to 150 characters');
    out.title = t;
  }
  if (input.category !== undefined) {
    const c = String(input.category).trim();
    if (!c || c.length > 40) throw fail(400, 'Category: 1 to 40 characters');
    out.category = c;
  }
  if (input.body !== undefined) {
    if (String(input.body).length > 100_000) throw fail(400, 'The article is too long');
    out.body = String(input.body);
  }
  if (input.visibility !== undefined) {
    if (!VISIBILITY.includes(input.visibility)) throw fail(400, 'Visibility: public, customers or internal');
    out.visibility = input.visibility;
  }
  if (input.status !== undefined) {
    if (!['draft', 'published'].includes(input.status)) throw fail(400, 'Status: draft or published');
    out.status = input.status;
  }
  return out;
}

export function create(input, userId) {
  const v = validate(input, false);
  const id = Number(db.prepare(`INSERT INTO kb_articles (slug, title, category, body, visibility, status, source_ticket, created_by, updated_by, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    uniqueSlug(v.title), v.title, v.category ?? 'General', v.body ?? '', v.visibility ?? 'customers', v.status ?? 'draft',
    input.sourceTicket ?? null, userId, userId, v.status === 'published' ? new Date().toISOString() : null,
  ).lastInsertRowid);
  return getById(id);
}

export function update(id, input, userId) {
  const cur = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(id);
  if (!cur) throw fail(404, 'Article not found');
  const v = validate(input, true);
  const next = { ...cur, ...v };
  const slug = v.title && v.title !== cur.title && cur.status === 'draft' ? uniqueSlug(v.title, id) : cur.slug; // published links stay
  const publishedAt = next.status === 'published' && !cur.published_at ? new Date().toISOString() : cur.published_at;
  db.prepare(`UPDATE kb_articles SET slug = ?, title = ?, category = ?, body = ?, visibility = ?, status = ?, updated_by = ?,
    updated_at = datetime('now'), published_at = ? WHERE id = ?`)
    .run(slug, next.title, next.category, next.body, next.visibility, next.status, userId, publishedAt, id);
  return getById(id);
}

export function remove(id) {
  if (!db.prepare('DELETE FROM kb_articles WHERE id = ?').run(id).changes) throw fail(404, 'Article not found');
}

/** Searches of the last 30 days that found nothing, most frequent first. */
export function gaps(days = 30) {
  return db.prepare(`SELECT lower(trim(query)) AS query, COUNT(*) AS count, MAX(created_at) AS lastAt
    FROM kb_searches WHERE results = 0 AND created_at >= datetime('now', ?)
    GROUP BY lower(trim(query)) ORDER BY count DESC, lastAt DESC LIMIT 50`).all(`-${Number(days)} days`);
}

export function stats() {
  const r = db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'published') AS published, SUM(status = 'draft') AS drafts,
    SUM(views) AS views, SUM(helpful) AS helpful, SUM(not_helpful) AS notHelpful FROM kb_articles`).get();
  return { total: r.total, published: r.published ?? 0, drafts: r.drafts ?? 0, views: r.views ?? 0, helpful: r.helpful ?? 0, notHelpful: r.notHelpful ?? 0 };
}
