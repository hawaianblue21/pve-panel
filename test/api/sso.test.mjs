// Single sign-on with Google, Microsoft and GitHub, against simulated providers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, Session } from '../support/stack.mjs';
import { startMockIdp } from '../support/mock-idp.mjs';

let stack;
let idp;
let admin;

/** Runs the browser part: panel start → provider → panel callback. Returns where the panel sends the browser. */
async function ssoSignIn(session, provider, { link = false } = {}) {
  const start = await session.get(`/api/auth/sso/${provider}/start${link ? '?link=1' : ''}`);
  if (start.status !== 302) return { status: start.status, target: /url=([^"]+)"/.exec(start.text)?.[1] ?? null };
  const toIdp = start.headers.get('location');
  const back = await fetch(toIdp, { redirect: 'manual' });
  assert.equal(back.status, 302, 'the provider sends the browser back');
  const cb = new URL(back.headers.get('location'));
  const done = await session.get(cb.pathname + cb.search);
  return { status: done.status, target: /url=([^"]+)"/.exec(done.text)?.[1] ?? null, authorize: new URL(toIdp) };
}

const setUp = (provider, body) => admin.put(`/api/admin/settings/sso/${provider}`, body);

before(async () => {
  idp = await startMockIdp();
  stack = await startStack({
    env: {
      PANEL_PUBLIC_URL: '{CUSTOMER_URL}', ADMIN_PUBLIC_URL: '{ADMIN_URL}',
      SSO_TEST_ENDPOINTS: JSON.stringify(idp.endpoints),
    },
  });
  admin = await stack.adminSession();
});
after(async () => { await stack?.stop(); await idp?.close(); });

test('the owner sets providers up; the secret is sealed and never shown', async () => {
  const off = (await admin.get('/api/admin/settings/sso')).json;
  assert.deepEqual(off.providers.map((p) => p.id), ['google', 'microsoft', 'github']);
  assert.equal(off.providers[0].redirectUris.customer, `${stack.customerUrl}/api/auth/sso/google/callback`);

  const early = await setUp('google', { enabled: true, clientId: idp.clientId });
  assert.equal(early.status, 400, 'no secret yet');
  assert.match(early.json.error, /client ID and secret/);
  assert.equal((await setUp('microsoft', { tenant: 'not a tenant!' })).status, 400);
  assert.equal((await setUp('google', { allowedDomains: ['not-a-domain'] })).status, 400);

  for (const p of ['google', 'microsoft', 'github']) {
    const r = await setUp(p, { enabled: true, clientId: idp.clientId, clientSecret: idp.clientSecret, portals: ['customer'], allowSignup: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.hasSecret, true);
    assert.equal(JSON.stringify(r.json).includes(idp.clientSecret), false);
  }
  const db = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'sso_providers'").get().value;
    assert.equal(raw.includes(idp.clientSecret), false, 'secret sealed at rest');
  } finally { db.close(); }

  const opts = (await stack.customer().get('/api/auth/options')).json;
  assert.deepEqual(opts.providers.map((p) => p.id), ['google', 'microsoft', 'github']);
  const adminOpts = (await stack.admin().get('/api/auth/options')).json;
  assert.deepEqual(adminOpts.providers, [], 'not shown on the admin portal unless chosen');
});

test('Google: PKCE, state and nonce are sent; a verified new user can sign up', async () => {
  idp.signInAs('google', { sub: 'g-100', email: 'Nadia@Example.org', email_verified: true, name: 'Nadia' });
  const s = stack.customer();
  const r = await ssoSignIn(s, 'google');
  assert.equal(r.target, '/');
  assert.equal(r.authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(r.authorize.searchParams.get('nonce'));
  assert.ok(r.authorize.searchParams.get('state'));
  const me = await s.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'nadia@example.org');
  const ids = (await s.get('/api/account/identities')).json;
  assert.deepEqual(ids.linked.map((l) => l.provider), ['google']);
  assert.deepEqual(ids.available.map((p) => p.id), ['microsoft', 'github']);

  // the only way in: can't be unlinked
  const un = await s.del('/api/account/identities/google');
  assert.equal(un.status, 409);
  assert.match(un.json.error, /only way you can sign in/);
});

test('an existing account is not taken over by a matching email', async () => {
  await stack.customerWith('lena@example.com');
  idp.signInAs('google', { sub: 'g-evil', email: 'lena@example.com', email_verified: true });
  const r = await ssoSignIn(stack.customer(), 'google');
  assert.equal(r.target, '/?sso_error=link_required');
});

test('unverified emails, other domains and switched-off sign-up are refused', async () => {
  idp.signInAs('google', { sub: 'g-200', email: 'x@example.org', email_verified: false });
  assert.equal((await ssoSignIn(stack.customer(), 'google')).target, '/?sso_error=email_unverified');

  // Microsoft (any organisation): its email claim is not trusted without xms_edov
  idp.signInAs('microsoft', { sub: 'm-1', email: 'omar@contoso.example' });
  assert.equal((await ssoSignIn(stack.customer(), 'microsoft')).target, '/?sso_error=email_unverified');
  idp.signInAs('microsoft', { sub: 'm-2', email: 'olga@contoso.example', xms_edov: true, amr: ['pwd', 'mfa'] });
  assert.equal((await ssoSignIn(stack.customer(), 'microsoft')).target, '/');

  await setUp('google', { allowedDomains: ['example.net'] });
  idp.signInAs('google', { sub: 'g-300', email: 'y@example.org', email_verified: true });
  assert.equal((await ssoSignIn(stack.customer(), 'google')).target, '/?sso_error=domain');
  await setUp('google', { allowedDomains: [], allowSignup: false });
  assert.equal((await ssoSignIn(stack.customer(), 'google')).target, '/?sso_error=not_found');
  await setUp('google', { allowSignup: true });

  idp.signInAs('google', null);
  assert.equal((await ssoSignIn(stack.customer(), 'google')).target, '/?sso_error=denied');
});

test('GitHub: link while signed in, then sign in with it', async () => {
  const lena = stack.customer();
  assert.equal((await lena.post('/api/auth/login', { email: 'lena@example.com', password: 'another-long-password' })).status, 200);
  idp.signInAs('github', { id: 4242, login: 'lena-dev', emails: [{ email: 'lena@users.noreply.example', primary: true, verified: true }] });
  const linked = await ssoSignIn(lena, 'github', { link: true });
  assert.equal(linked.target, '/?sso_linked=github#account');
  assert.equal(linked.authorize.searchParams.get('scope'), 'read:user user:email');

  const fresh = stack.customer();
  assert.equal((await ssoSignIn(fresh, 'github')).target, '/');
  assert.equal((await fresh.get('/api/auth/me')).json.email, 'lena@example.com');

  // the same GitHub account can't be linked to someone else
  const nadia = stack.customer();
  idp.signInAs('google', { sub: 'g-100', email: 'nadia@example.org', email_verified: true });
  await ssoSignIn(nadia, 'google');
  const taken = await ssoSignIn(nadia, 'github', { link: true });
  assert.equal(taken.target, '/?sso_error=linked_elsewhere#account');

  // linking needs a signed-in session
  assert.equal((await ssoSignIn(stack.customer(), 'github', { link: true })).target, '/?sso_error=reauth#account');

  // password user: unlinking is fine
  assert.equal((await lena.del('/api/account/identities/github')).status, 204);
  const after = stack.customer();
  await ssoSignIn(after, 'github');   // sign-up is on: a new account, never Lena's
  assert.notEqual((await after.get('/api/auth/me')).json?.email, 'lena@example.com');
});

test('administrators: only with a linked identity, on the admin portal when chosen', async () => {
  await setUp('github', { portals: ['customer', 'admin'] });
  const opts = (await stack.admin().get('/api/auth/options')).json;
  assert.deepEqual(opts.providers.map((p) => p.id), ['github']);
  idp.signInAs('github', { id: 7, login: 'boss', emails: [{ email: 'admin@example.com', primary: true, verified: true }] });
  assert.equal((await ssoSignIn(stack.admin(), 'github')).target, '/?sso_error=link_required');
  const a = await stack.adminSession();
  assert.equal((await ssoSignIn(a, 'github', { link: true })).target, '/?sso_linked=github#account');
  const b = stack.admin();
  assert.equal((await ssoSignIn(b, 'github')).target, '/');
  assert.equal((await b.get('/api/admin/me')).status, 200);
  // a customer's GitHub never opens the admin portal
  idp.signInAs('github', { id: 9, login: 'cust', emails: [{ email: 'cust9@example.org', primary: true, verified: true }] });
  assert.equal((await ssoSignIn(stack.admin(), 'github')).target, '/?sso_error=not_found');
});

test('the activity log records sign-ups, links and refusals; admin unlink removes all', async () => {
  const log = (await admin.get('/api/admin/audit?limit=300')).json.map((e) => e.action);
  for (const a of ['sso_account_created', 'sso_identity_linked', 'sso_identity_unlinked', 'sso_login_failed', 'admin_sso_provider']) {
    assert.ok(log.includes(a), a);
  }
  const users = (await admin.get('/api/admin/users')).json;
  const nadia = users.find((u) => u.email === 'nadia@example.org');
  assert.equal(!!nadia.ssoLinked, true);
  assert.equal(nadia.ssoProviders, 'google');
  assert.equal((await admin.patch(`/api/admin/users/${nadia.id}`, { unlinkSso: true })).status, 200);
  assert.equal(!!(await admin.get('/api/admin/users')).json.find((u) => u.id === nadia.id).ssoLinked, false);
});
