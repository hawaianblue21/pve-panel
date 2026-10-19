// API tokens: scripts and integrations call the panel's API with
//   Authorization: Bearer pvc_<id>_<secret>   (customer portal)
//   Authorization: Bearer pva_<id>_<secret>   (admin portal)
//
// The secret is shown once; only its SHA-256 is stored (the secret has 256 bits,
// so a slow hash adds nothing). A token acts as its account, but:
//   customer  only the routes in CUSTOMER_ROUTES, reading always, changing only in the
//             scopes given to the token (power, servers, storage, network, billing,
//             support). Sign-in, account security, the console, S3 keys, the AI
//             assistant and tokens themselves are never reachable with a token.
//   admin     the account's role decides (RBAC) as usual; a token can be read-only,
//             and never manages tokens, administrators or roles.
// Every request re-checks the account, so deleting a user or taking away
// admin rights stops their tokens at once.

import crypto from 'node:crypto';
import { db, audit } from './db.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
export const CUSTOMER_SCOPES = ['power', 'servers', 'storage', 'network', 'billing', 'support'];
const PREFIX = { customer: 'pvc', admin: 'pva' };
const MAX_TOKENS = 20;

/** Customer routes a token may use: 'read' (always) or the scope a change needs. */
const CUSTOMER_ROUTES = {
  'GET /api/account': 'read',
  'GET /api/vms': 'read', 'GET /api/vms/:vmid': 'read', 'GET /api/vms/:vmid/rrd': 'read', 'GET /api/vms/:vmid/snapshots': 'read',
  'GET /api/vms/:vmid/ips': 'read', 'GET /api/vms/:vmid/plans': 'read', 'GET /api/vms/:vmid/updates': 'read', 'GET /api/vms/:vmid/tailscale': 'read', 'GET /api/vms/:vmid/snapshot-schedule': 'read',
  'GET /api/tasks/:upid': 'read', 'GET /api/templates': 'read', 'GET /api/plans': 'read',
  'GET /api/volumes': 'read', 'GET /api/storage': 'read', 'GET /api/vpn': 'read',
  'GET /api/billing': 'read', 'GET /api/billing/invoices/:number': 'read',
  'GET /api/support/tickets': 'read', 'GET /api/support/tickets/:number': 'read', 'GET /api/kb': 'read', 'GET /api/kb/:slug': 'read',

  'POST /api/vms/:vmid/power/:action': 'power',

  'POST /api/vms': 'servers', 'DELETE /api/vms/:vmid': 'servers', 'POST /api/vms/:vmid/reinstall': 'servers',
  'POST /api/vms/:vmid/resize': 'servers', 'POST /api/vms/:vmid/plan': 'servers', 'POST /api/vms/:vmid/extend': 'servers',
  'POST /api/vms/:vmid/updates': 'servers', 'POST /api/vms/:vmid/snapshots': 'servers', 'DELETE /api/vms/:vmid/snapshots/:name': 'servers',
  'POST /api/vms/:vmid/snapshots/:name/rollback': 'servers', 'PUT /api/vms/:vmid/snapshot-schedule': 'servers', 'POST /api/vms/:vmid/tailscale': 'servers', 'DELETE /api/vms/:vmid/tailscale': 'servers',

  'POST /api/volumes': 'storage', 'PATCH /api/volumes/:id': 'storage', 'DELETE /api/volumes/:id': 'storage',
  'POST /api/volumes/:id/attach': 'storage', 'POST /api/volumes/:id/detach': 'storage', 'POST /api/volumes/:id/resize': 'storage',
  'POST /api/storage/buckets': 'storage', 'PATCH /api/storage/buckets/:name': 'storage', 'DELETE /api/storage/buckets/:name': 'storage',

  'POST /api/vms/:vmid/ips': 'network', 'DELETE /api/ips/:id': 'network', 'PUT /api/ips/:id/ptr': 'network', 'PUT /api/ips/:id/ipv6': 'network',
  'POST /api/vpn/devices': 'network', 'DELETE /api/vpn/devices/:id': 'network',

  'POST /api/billing/renewals': 'billing', 'POST /api/billing/topups': 'billing', 'POST /api/billing/invoices/:number/pay': 'billing',
  'PUT /api/billing/servers/:vmid/auto-renew': 'billing', 'PUT /api/billing/profile': 'billing',

  'POST /api/support/tickets': 'support', 'POST /api/support/tickets/:number/messages': 'support', 'POST /api/support/tickets/:number/close': 'support',
};

/** Admin routes a token never reaches, whatever the role. */
const ADMIN_BLOCKED = [/^\/api\/admin\/tokens/, /^\/api\/admin\/rbac/, /^\/api\/auth\//, /^\/api\/account/];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- Verifying ---------------------------------------------------------------------------------

/**
 * For a request with "Authorization: Bearer pv?_…": the token row, or an error
 * { status, message }. Checks the scope (portal), revocation, expiry and the route.
 */
export function checkToken(req, portal) {
  const m = /^Bearer\s+(pv[ca])_(\d{1,10})_([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
  if (!m) return { status: 401, message: 'Invalid API token' };
  if (m[1] !== PREFIX[portal]) return { status: 401, message: `This is a ${m[1] === 'pva' ? 'admin' : 'customer'} token; use it on the ${m[1] === 'pva' ? 'admin' : 'customer'} portal` };
  const t = db.prepare('SELECT * FROM api_tokens WHERE id = ? AND portal = ?').get(Number(m[2]), portal);
  const given = Buffer.from(sha(m[3]), 'hex');
  const known = Buffer.from(t?.hash ?? '0'.repeat(64), 'hex');
  if (!t || !crypto.timingSafeEqual(given, known)) return { status: 401, message: 'Invalid API token' };
  if (t.revoked_at) return { status: 401, message: 'This API token was revoked' };
  if (t.expires_at && Date.parse(t.expires_at) < Date.now()) return { status: 401, message: 'This API token has expired' };

  const route = `${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions?.url ?? ''}`;
  if (portal === 'customer') {
    const need = CUSTOMER_ROUTES[route];
    if (!need) return { status: 403, message: 'API tokens can\'t be used for this; sign in to the portal instead' };
    const scopes = JSON.parse(t.scopes || '[]');
    if (need !== 'read' && !scopes.includes(need)) return { status: 403, message: `This API token has no "${need}" permission` };
  } else {
    if (ADMIN_BLOCKED.some((re) => re.test(req.routeOptions?.url ?? ''))) return { status: 403, message: 'API tokens can\'t manage tokens, administrators or roles' };
    if (t.read_only && !['GET', 'HEAD'].includes(req.method)) return { status: 403, message: 'This API token is read-only' };
  }
  // last use, at most once a minute per token
  if (!t.last_used_at || Date.now() - Date.parse(t.last_used_at) > 60_000) {
    db.prepare('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(new Date().toISOString(), req.ip, t.id);
  }
  return { token: t };
}

// ---- Managing (signed-in sessions only) --------------------------------------------------------------

const pub = (t) => ({
  id: t.id, name: t.name, prefix: `${PREFIX[t.portal]}_${t.id}_`, scopes: JSON.parse(t.scopes || '[]'), readOnly: !!t.read_only,
  expiresAt: t.expires_at, lastUsedAt: t.last_used_at, lastUsedIp: t.last_used_ip, createdAt: t.created_at,
  expired: !!(t.expires_at && Date.parse(t.expires_at) < Date.now()),
});

export const listTokens = (account, portal) => db.prepare('SELECT * FROM api_tokens WHERE user_id = ? AND portal = ? AND revoked_at IS NULL ORDER BY id DESC').all(account.id, portal).map(pub);

export function createToken(req, portal, { name, scopes = [], readOnly = false, days = 90 }) {
  if (req.apiToken) throw fail(403, 'API tokens can\'t create tokens');
  const n = String(name ?? '').trim();
  if (!n || n.length > 60) throw fail(400, 'Name: up to 60 characters, e.g. "backup script"');
  const count = db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND portal = ? AND revoked_at IS NULL').get(req.account.id, portal).n;
  if (count >= MAX_TOKENS) throw fail(409, `At most ${MAX_TOKENS} tokens; revoke one you no longer use`);
  let list = [];
  if (portal === 'customer') {
    list = [...new Set(scopes)];
    const bad = list.filter((x) => !CUSTOMER_SCOPES.includes(x));
    if (bad.length) throw fail(400, `Unknown permission ${bad.join(', ')}`);
  }
  if (days !== null && ![7, 30, 90, 365].includes(Number(days))) throw fail(400, 'Valid for 7, 30, 90 or 365 days, or without end');
  const expires = days === null ? null : new Date(Date.now() + Number(days) * 86_400_000).toISOString();
  const secret = crypto.randomBytes(32).toString('base64url');
  const id = Number(db.prepare('INSERT INTO api_tokens (user_id, portal, name, hash, scopes, read_only, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.account.id, portal, n, sha(secret), JSON.stringify(list), portal === 'admin' && readOnly ? 1 : 0, expires).lastInsertRowid);
  audit(req, null, 'api_token_created', { id, name: n, portal, scopes: list, readOnly: portal === 'admin' && !!readOnly, expiresAt: expires });
  return { ...pub(db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id)), token: `${PREFIX[portal]}_${id}_${secret}` };
}

export function revokeToken(req, portal, id) {
  if (req.apiToken) throw fail(403, 'API tokens can\'t revoke tokens');
  const t = db.prepare('SELECT * FROM api_tokens WHERE id = ? AND user_id = ? AND portal = ? AND revoked_at IS NULL').get(id, req.account.id, portal);
  if (!t) throw fail(404, 'Token not found');
  db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  audit(req, null, 'api_token_revoked', { id, name: t.name, portal });
  return { revoked: true };
}

/** Owners: every administrator's tokens, and revoking any of them. */
export const allAdminTokens = () => db.prepare(`SELECT t.*, u.email FROM api_tokens t JOIN users u ON u.id = t.user_id
  WHERE t.portal = 'admin' AND t.revoked_at IS NULL ORDER BY u.email, t.id`).all().map((t) => ({ ...pub(t), email: t.email, userId: t.user_id }));

export function revokeAnyAdminToken(req, id) {
  const t = db.prepare("SELECT * FROM api_tokens WHERE id = ? AND portal = 'admin' AND revoked_at IS NULL").get(id);
  if (!t) throw fail(404, 'Token not found');
  db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  audit(req, null, 'api_token_revoked', { id, name: t.name, portal: 'admin', userId: t.user_id, byOwner: true });
  return { revoked: true };
}
