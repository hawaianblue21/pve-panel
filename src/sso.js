// Single sign-on with public providers: Google, Microsoft (Entra ID / Microsoft 365)
// and GitHub. The panel owner sets them up in Settings → Single sign-on (client
// ID and secret; the secret is sealed at rest). The generic OIDC provider from the
// environment (oidc.js, OIDC_*) works as before, next to these.
//
// Flow (same rules as oidc.js): Authorization Code with PKCE (S256) and state;
// Google and Microsoft are OpenID Connect (ID token validated by openid-client,
// with nonce); GitHub is plain OAuth 2.0: the user and the verified primary
// email come from its API.
//
// Accounts:
//   - an identity (provider + issuer + subject) is linked to one panel account
//     and found by that from then on, even when the email changes;
//   - an existing account is NEVER linked just because the email matches: the
//     customer signs in as usual and links the provider under Account (a recent
//     sign-in is required). Otherwise anyone who controls a provider account
//     showing that email could take the panel account over;
//   - new customer accounts are created only when the owner allows sign-up for
//     that provider, and only with an email the provider has verified.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as client from 'openid-client';
import { db } from './db.js';
import { config } from './config.js';
import { seal, open } from './secrets.js';
import { SsoError, idpUsedMfa } from './oidc.js';

const KEY = 'sso_providers';
const PURPOSE = 'sso-client-secret';
const MS_SHARED_TENANTS = ['common', 'organizations', 'consumers'];

export const PROVIDERS = {
  google: {
    name: 'Google', kind: 'oidc', scopes: 'openid email profile',
    issuer: () => 'https://accounts.google.com',
    hint: 'Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application)',
  },
  microsoft: {
    name: 'Microsoft', kind: 'oidc', scopes: 'openid email profile',
    issuer: (s) => `https://login.microsoftonline.com/${s.tenant || 'organizations'}/v2.0`,
    hint: 'Microsoft Entra admin center → App registrations → New registration (Web platform)',
  },
  github: {
    name: 'GitHub', kind: 'github', scopes: 'read:user user:email',
    hint: 'GitHub → Settings → Developer settings → OAuth Apps → New OAuth App',
  },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

// For tests only: point providers at a local mock ({"google":"http://127.0.0.1:…/google", …}).
let testEndpoints = {};
try { testEndpoints = JSON.parse(process.env.SSO_TEST_ENDPOINTS || '{}'); } catch { testEndpoints = {}; }

// ---- Settings ------------------------------------------------------------------------

const DEFAULTS = { enabled: false, clientId: '', secret: null, portals: ['customer'], allowSignup: false, allowedDomains: [], tenant: 'organizations' };

function stored() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : {};
}

function settingsOf(id) {
  return { ...DEFAULTS, ...(stored()[id] ?? {}) };
}

function secretOf(s) {
  if (!s.secret) return '';
  try { return open(PURPOSE, s.secret); } catch { return ''; } // panel secret changed: set it again
}

export const redirectUri = (id, scope) => `${config.oidc.publicUrl[scope]}/api/auth/sso/${id}/callback`;

/** Usable for this portal: switched on, complete, and the portal has a public address. */
function usable(id, s, scope) {
  return !!(s.enabled && s.clientId && secretOf(s) && s.portals.includes(scope) && config.oidc.publicUrl[scope]);
}

/** Buttons for the sign-in page of a portal. */
export function providersFor(scope) {
  return PROVIDER_IDS.filter((id) => usable(id, settingsOf(id), scope)).map((id) => ({
    id, name: PROVIDERS[id].name, startUrl: `${config.oidc.publicUrl[scope]}/api/auth/sso/${id}/start`,
  }));
}

/** For the Settings page (never the secret itself). */
export function publicSettings() {
  return {
    publicUrls: { customer: config.oidc.publicUrl.customer || null, admin: config.oidc.publicUrl.admin || null },
    providers: PROVIDER_IDS.map((id) => {
      const s = settingsOf(id);
      return {
        id, name: PROVIDERS[id].name, hint: PROVIDERS[id].hint,
        enabled: !!s.enabled, clientId: s.clientId, hasSecret: !!secretOf(s), portals: s.portals,
        allowSignup: !!s.allowSignup, allowedDomains: s.allowedDomains,
        ...(id === 'microsoft' ? { tenant: s.tenant } : {}),
        redirectUris: Object.fromEntries(['customer', 'admin']
          .filter((p) => config.oidc.publicUrl[p]).map((p) => [p, redirectUri(id, p)])),
        linkedAccounts: db.prepare('SELECT COUNT(*) AS n FROM user_identities WHERE provider = ?').get(id).n,
      };
    }),
  };
}

export function saveProvider(id, input) {
  if (!PROVIDERS[id]) throw Object.assign(new Error('Unknown provider'), { statusCode: 404, expose: true });
  const all = stored();
  const next = { ...DEFAULTS, ...(all[id] ?? {}) };
  if (typeof input.clientId === 'string') next.clientId = input.clientId.trim();
  if (typeof input.clientSecret === 'string' && input.clientSecret) next.secret = seal(PURPOSE, input.clientSecret.trim());
  if (Array.isArray(input.portals)) next.portals = [...new Set(input.portals.filter((p) => ['customer', 'admin'].includes(p)))];
  if (typeof input.allowSignup === 'boolean') next.allowSignup = input.allowSignup;
  if (Array.isArray(input.allowedDomains)) {
    next.allowedDomains = [...new Set(input.allowedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
    const bad = next.allowedDomains.find((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
    if (bad) throw Object.assign(new Error(`"${bad}" is not a domain like example.com`), { statusCode: 400, expose: true });
  }
  if (id === 'microsoft' && typeof input.tenant === 'string') {
    const t = input.tenant.trim() || 'organizations';
    if (!MS_SHARED_TENANTS.includes(t) && !/^[0-9a-f-]{36}$/i.test(t) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) {
      throw Object.assign(new Error('Tenant: organizations, common, consumers, a tenant ID or a domain'), { statusCode: 400, expose: true });
    }
    next.tenant = t;
  }
  if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
  if (next.enabled && (!next.clientId || !secretOf(next))) {
    throw Object.assign(new Error('Enter the client ID and secret before switching it on'), { statusCode: 400, expose: true });
  }
  all[id] = next;
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(KEY, JSON.stringify(all));
  discovery.delete(id);
  return publicSettings().providers.find((p) => p.id === id);
}

// ---- OpenID Connect providers (Google, Microsoft) ----------------------------------

const discovery = new Map(); // id → Promise<Configuration>

function oidcConfig(id, s) {
  if (!discovery.has(id)) {
    const test = testEndpoints[id];
    const issuer = new URL(test || PROVIDERS[id].issuer(s));
    const p = client.discovery(
      issuer, s.clientId, { [client.clockTolerance]: 30 }, client.ClientSecretPost(secretOf(s)),
      test && issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined,
    ).catch((err) => { discovery.delete(id); throw err; });
    discovery.set(id, p);
  }
  return discovery.get(id);
}

// ---- Start ---------------------------------------------------------------------------

/** URL to send the browser to, and the transaction to keep (signed) until the callback. */
export async function startLogin(id, scope) {
  const p = PROVIDERS[id];
  const s = settingsOf(id);
  if (!p || !usable(id, s, scope)) throw new SsoError('unavailable', `${id} is not set up for the ${scope} portal`);
  const tx = { provider: id, verifier: client.randomPKCECodeVerifier(), state: client.randomState(), nonce: client.randomNonce() };
  const challenge = await client.calculatePKCECodeChallenge(tx.verifier);
  if (p.kind === 'github') {
    const base = testEndpoints.github || 'https://github.com';
    const url = new URL(`${base}/login/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: s.clientId, redirect_uri: redirectUri(id, scope), scope: p.scopes, state: tx.state,
      code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false',
    }).toString();
    return { url: url.href, tx };
  }
  const cfg = await oidcConfig(id, s);
  const params = {
    redirect_uri: redirectUri(id, scope), scope: p.scopes, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: tx.state, nonce: tx.nonce,
  };
  if (id === 'google') params.prompt = 'select_account';
  if (id === 'microsoft') params.prompt = 'select_account';
  return { url: client.buildAuthorizationUrl(cfg, params).href, tx };
}

// ---- Callback ------------------------------------------------------------------------

/**
 * Exchanges the code and returns the identity:
 * { provider, issuer, subject, email, emailVerified, name, mfa }
 */
export async function finishLogin(id, scope, query, tx) {
  const s = settingsOf(id);
  if (!PROVIDERS[id] || tx.provider !== id) throw new SsoError('failed', 'Provider does not match the sign-in that was started');
  if (!usable(id, s, scope)) throw new SsoError('unavailable', `${id} is no longer set up for the ${scope} portal`);
  if (PROVIDERS[id].kind === 'github') return githubIdentity(s, scope, query, tx);

  const cfg = await oidcConfig(id, s);
  const current = new URL(redirectUri(id, scope));
  current.search = new URLSearchParams(query).toString();
  const tokens = await client.authorizationCodeGrant(cfg, current, {
    pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, idTokenExpected: true,
  });
  const c = { ...tokens.claims() };
  if (!c.sub) throw new SsoError('failed', 'No ID token subject');
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : null;
  let emailVerified = false;
  if (id === 'google') emailVerified = c.email_verified === true;
  if (id === 'microsoft') {
    // Entra's email claim is not verified by default. Trust it only when Entra
    // says the domain owner verified it (optional claim xms_edov), or when the
    // panel is bound to one organisation (its own tenant controls the addresses).
    emailVerified = c.xms_edov === true || c.xms_edov === 1 || c.xms_edov === '1'
      || !MS_SHARED_TENANTS.includes(s.tenant || 'organizations');
  }
  return { provider: id, issuer: c.iss, subject: String(c.sub), email, emailVerified, name: c.name ?? null, mfa: idpUsedMfa(c) };
}

async function githubIdentity(s, scope, query, tx) {
  if (!query.state || query.state !== tx.state) throw new SsoError('failed', 'state does not match');
  if (!query.code) throw new SsoError('failed', 'no authorization code');
  const base = testEndpoints.github || 'https://github.com';
  const apiBase = testEndpoints.github ? `${testEndpoints.github}/api` : 'https://api.github.com';
  const call = async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new SsoError('failed', `GitHub ${new URL(url).pathname}: HTTP ${res.status} ${body?.message ?? ''}`);
    return body;
  };
  const tok = await call(`${base}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: s.clientId, client_secret: secretOf(s), code: String(query.code),
      redirect_uri: redirectUri('github', scope), code_verifier: tx.verifier,
    }),
  });
  if (!tok?.access_token) throw new SsoError('failed', `GitHub token: ${tok?.error_description || tok?.error || 'no access token'}`);
  const headers = {
    Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json',
    'User-Agent': 'pve-panel', 'X-GitHub-Api-Version': '2022-11-28',
  };
  const user = await call(`${apiBase}/user`, { headers });
  if (!user?.id) throw new SsoError('failed', 'GitHub returned no user id');
  const emails = await call(`${apiBase}/user/emails`, { headers }).catch(() => []);
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : null;
  return {
    provider: 'github', issuer: 'https://github.com', subject: String(user.id),
    email: primary?.email?.toLowerCase() ?? null, emailVerified: !!primary, name: user.name || user.login || null, mfa: false,
  };
}

// ---- Accounts ------------------------------------------------------------------------

const byIdentity = db.prepare(`SELECT u.* FROM user_identities i JOIN users u ON u.id = i.user_id
  WHERE i.provider = ? AND i.issuer = ? AND i.subject = ?`);

/**
 * Finds (or, when allowed, creates) the panel account for an identity.
 * linkUserId: the signed-in user who asked to link this provider.
 */
export function resolveAccount(identity, { scope, adminOnly, linkUserId = null }) {
  const s = settingsOf(identity.provider);
  let user = byIdentity.get(identity.provider, identity.issuer, identity.subject);

  if (linkUserId) {
    if (user && user.id !== linkUserId) throw new SsoError('linked_elsewhere');
    if (!user) {
      const other = db.prepare('SELECT 1 FROM user_identities WHERE user_id = ? AND provider = ?').get(linkUserId, identity.provider);
      if (other) throw new SsoError('provider_linked');
      addIdentity(linkUserId, identity);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(linkUserId);
      return { user, linked: true, created: false };
    }
    return { user, linked: false, created: false };
  }

  if (user) {
    db.prepare("UPDATE user_identities SET last_used_at = datetime('now'), email = ? WHERE provider = ? AND issuer = ? AND subject = ?")
      .run(identity.email, identity.provider, identity.issuer, identity.subject);
  } else {
    if (!identity.email) throw new SsoError('no_email');
    if (!identity.emailVerified) throw new SsoError('email_unverified');
    const domain = identity.email.split('@')[1] ?? '';
    if (s.allowedDomains.length && !s.allowedDomains.includes(domain)) throw new SsoError('domain');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(identity.email)) throw new SsoError('link_required');
    if (adminOnly || scope !== 'customer' || !s.allowSignup) throw new SsoError('not_found');
    // No usable password: this account signs in through the provider (or a passkey).
    const unusable = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    const id = Number(db.prepare('INSERT INTO users (email, password_hash, password_set, is_admin) VALUES (?, ?, 0, 0)')
      .run(identity.email, unusable).lastInsertRowid);
    addIdentity(id, identity);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(id), linked: true, created: true };
  }
  if (user.deleting) throw new SsoError('not_found');
  if (adminOnly && !user.is_admin) throw new SsoError('not_admin');
  return { user, linked: false, created: false };
}

function addIdentity(userId, identity) {
  db.prepare(`INSERT INTO user_identities (user_id, provider, issuer, subject, email, name, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(userId, identity.provider, identity.issuer, identity.subject, identity.email, identity.name);
}

/** Linked providers of an account, and the ones it could link on this portal. */
export function identitiesOf(userId, scope) {
  const linked = db.prepare('SELECT provider, email, name, created_at AS linkedAt, last_used_at AS lastUsedAt FROM user_identities WHERE user_id = ? ORDER BY provider')
    .all(userId);
  const have = new Set(linked.map((l) => l.provider));
  return {
    linked: linked.map((l) => ({ ...l, name: PROVIDERS[l.provider]?.name ?? l.provider, account: l.name })),
    available: providersFor(scope).filter((p) => !have.has(p.id)),
  };
}

/**
 * Removes a link, unless it is the last way left to sign in (no password that
 * can be used here, no passkey, no other linked provider).
 */
export function unlink(userId, provider, scope) {
  const row = db.prepare('SELECT 1 FROM user_identities WHERE user_id = ? AND provider = ?').get(userId, provider);
  if (!row) throw Object.assign(new Error('That provider is not linked to your account'), { statusCode: 404, expose: true });
  const u = db.prepare('SELECT password_set, oidc_subject FROM users WHERE id = ?').get(userId);
  const others = db.prepare('SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ? AND provider <> ?').get(userId, provider).n;
  const keys = db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
  const password = config.auth.password[scope] && u.password_set !== 0;
  const genericSso = u.oidc_subject && config.oidc.enabled && config.oidc.portals.includes(scope);
  if (!others && !keys && !password && !genericSso) {
    throw Object.assign(new Error('This is the only way you can sign in. Add a passkey or link another provider first.'), { statusCode: 409, expose: true });
  }
  db.prepare('DELETE FROM user_identities WHERE user_id = ? AND provider = ?').run(userId, provider);
}
