import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { db, audit } from './db.js';
import * as totp from './totp.js';
import * as oidc from './oidc.js';
import * as sso from './sso.js';
import { userAppearance, setUserAppearance, MODES } from './appearance.js';
import { checkInvitation, acceptInvitation } from './invite.js';
import * as passkeys from './passkeys.js';
import { checkToken } from './tokens.js';

const SESSION_HOURS = 8;
// Adding a way to sign in (passkey, linked provider) needs a sign-in this recent.
const RECENT_SIGN_IN_S = 15 * 60;
// Compared against when the email is unknown, so response time
// doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare(`
  SELECT id, email, is_admin, admin_role_id, resource_pool_id,
         can_create, max_servers, max_cores, max_memory_mb, max_disk_gb, deleting
  FROM users WHERE id = ?
`);

/**
 * Registered once per server with its own scope:
 *   customer: cookie "panel_session",       any user may sign in
 *   admin:    cookie "panel_admin_session", administrators only
 * Browsers send cookies to every port of a host, so each scope uses its own
 * cookie name, its own signing key and a scope claim that is checked on
 * every request. A customer session is useless on the admin port.
 */
async function authPlugin(app, { scope }) {
  const adminOnly = scope === 'admin';
  const cookieName = adminOnly ? 'panel_admin_session' : 'panel_session';

  await app.register(jwt, {
    secret: adminOnly ? `${config.jwtSecret}:admin` : config.jwtSecret,
    cookie: { cookieName, signed: false },
    sign: { expiresIn: `${SESSION_HOURS}h` },
  });

  app.decorateRequest('account', null);
  app.decorateRequest('apiToken', null);

  app.decorate('authenticate', async (req, reply) => {
    // API token (scripts, integrations): checked instead of the session cookie
    if (/^Bearer\s+pv[ca]_/.test(req.headers.authorization ?? '')) {
      const r = checkToken(req, scope);
      if (r.status) return reply.code(r.status).send({ error: r.message });
      const owner = findById.get(r.token.user_id);
      if (!owner || owner.deleting || (adminOnly && !owner.is_admin)) return reply.code(401).send({ error: 'Invalid API token' });
      req.account = owner;
      req.apiToken = { id: r.token.id, name: r.token.name };
      return;
    }
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Sign in to continue' });
    }
    if (req.user.scope !== scope) return reply.code(401).send({ error: 'Sign in to continue' });
    // Re-check the database so deleted users and revoked admins lose access immediately.
    const account = findById.get(req.user.sub);
    if (!account || account.deleting || (adminOnly && !account.is_admin)) {
      return reply.code(401).send({ error: 'Sign in to continue' });
    }
    req.account = account;
  });

  app.decorate('requireAdmin', app.authenticate);

  const cookieOpts = (maxAge) => ({
    path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', maxAge,
  });
  const pendingCookie = `${cookieName}_2fa`;
  const me = (u) => ({ id: u.id, email: u.email, isAdmin: !!u.is_admin });

  async function startSession(req, reply, user, how) {
    const token = await reply.jwtSign({ sub: user.id, scope });
    req.account = user;
    audit(req, null, adminOnly ? 'admin_login' : 'login', how === 'passkey' ? { passkey: true } : how ? { twoFactor: how } : null);
    return reply
      .clearCookie(pendingCookie, { path: '/' })
      .setCookie(cookieName, token, cookieOpts(SESSION_HOURS * 3600))
      .send(me(user));
  }

  /** Password was right; the second step is pending for 5 minutes. */
  function pending(reply, user, stage) {
    const token = app.jwt.sign({ sub: user.id, scope: `${scope}:2fa`, stage }, { expiresIn: '5m' });
    return reply.setCookie(pendingCookie, token, cookieOpts(300)).send({ twoFactor: stage });
  }

  function pendingUser(req, stage) {
    try {
      const claim = app.jwt.verify(req.cookies[pendingCookie] ?? '');
      if (claim.scope !== `${scope}:2fa` || claim.stage !== stage) return null;
      const user = findByEmail.get(db.prepare('SELECT email FROM users WHERE id = ?').get(claim.sub)?.email ?? '');
      if (!user || user.deleting || (adminOnly && !user.is_admin)) return null;
      return user;
    } catch {
      return null;
    }
  }
  const expired = (reply) => reply.code(401).send({ error: 'The sign-in took too long. Please start again.', restart: true });

  app.post('/api/auth/login', {
    // per IP; LOGIN_RATE_LIMIT raises it (e.g. many staff behind one NAT address, or tests)
    config: { rateLimit: { max: Math.max(1, Number(process.env.LOGIN_RATE_LIMIT) || 10), timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', maxLength: 254 },
          password: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    if (!config.auth.password[scope]) {
      return reply.code(403).send({ error: 'Signing in with a password is turned off. Use single sign-on.' });
    }
    const { email, password } = req.body;
    const user = findByEmail.get(email.trim());
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

    // Non-admins get the same answer as a wrong password on the admin port.
    if (!user || !ok || user.deleting || (adminOnly && !user.is_admin)) {
      audit(req, null, adminOnly ? 'admin_login_failed' : 'login_failed', { email });
      return reply.code(401).send({ error: 'Email or password is incorrect' });
    }
    if (user.totp_enabled) return pending(reply, user, 'verify');
    if (user.totp_required) return pending(reply, user, 'setup');
    return startSession(req, reply, user, null);
  });

  // Second step: authenticator code or recovery code
  app.post('/api/auth/2fa/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } } },
  }, async (req, reply) => {
    const user = pendingUser(req, 'verify');
    if (!user) return expired(reply);
    const how = totp.verify(user.id, req.body.code);
    if (!how) {
      audit({ account: user, ip: req.ip }, null, adminOnly ? 'admin_login_failed' : 'login_failed', { email: user.email, twoFactor: true });
      return reply.code(401).send({ error: 'That code is not correct. Check the time on your phone and try the newest code.' });
    }
    return startSession(req, reply, user, how);
  });

  // Required 2FA not set up yet: enrol before the first session
  app.post('/api/auth/2fa/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = pendingUser(req, 'setup');
    if (!user) return expired(reply);
    return totp.beginSetup(user.id);
  });

  app.post('/api/auth/2fa/activate', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const user = pendingUser(req, 'setup');
    if (!user) return expired(reply);
    const codes = totp.activate(user.id, String(req.body.code).replace(/\s/g, ''));
    if (!codes) return reply.code(400).send({ error: 'That code is not correct. Enter the 6-digit code your app shows now.' });
    audit({ account: user, ip: req.ip }, null, 'twofa_enabled');
    const token = await reply.jwtSign({ sub: user.id, scope });
    req.account = user;
    audit(req, null, adminOnly ? 'admin_login' : 'login', { twoFactor: 'setup' });
    return reply
      .clearCookie(pendingCookie, { path: '/' })
      .setCookie(cookieName, token, cookieOpts(SESSION_HOURS * 3600))
      .send({ ...me(user), recoveryCodes: codes });
  });

  // ---- Invitations: set your own password (customer portal) -------------------
  if (!adminOnly) {
    const tokenBody = { type: 'string', minLength: 40, maxLength: 60, pattern: '^[A-Za-z0-9_-]+$' };
    app.post('/api/invite/check', {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: { type: 'object', required: ['token'], properties: { token: tokenBody } } },
    }, async (req) => checkInvitation(req.body.token));

    app.post('/api/invite/accept', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: { token: tokenBody, password: { type: 'string', minLength: 12, maxLength: 200 } },
        },
      },
    }, async (req) => acceptInvitation(req, req.body.token, req.body.password));
  }

  // ---- Sign-in options + OIDC ---------------------------------------------------
  const ssoHere = oidc.oidcEnabledFor(scope);

  app.get('/api/auth/options', async (req) => ({
    password: config.auth.password[scope],
    passkeys: passkeys.relyingParty(scope, req).usable,
    oidc: ssoHere
      ? { enabled: true, label: config.oidc.label, startUrl: `${config.oidc.publicUrl[scope]}/api/auth/oidc/start` }
      : { enabled: false },
    providers: sso.providersFor(scope),   // Google, Microsoft, GitHub (Settings → Single sign-on)
  }));

  // Which second step is waiting (after single sign-on redirected back)
  app.get('/api/auth/2fa/pending', async (req, reply) => {
    for (const stage of ['verify', 'setup']) {
      const user = pendingUser(req, stage);
      if (user) return { stage, email: user.email };
    }
    return expired(reply);
  });

  if (ssoHere) {
    const txCookie = `${cookieName}_oidc`;
    // Lax, not Strict: the provider sends the browser back cross-site, and the
    // transaction cookie must come along. It lives 10 minutes and is used once.
    const txOpts = {
      path: '/api/auth/oidc', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: 600,
    };

    // Continue on our own site with a same-site navigation, so the Strict
    // session cookie is sent (it isn't on a redirect chain started elsewhere).
    const continueTo = (reply, target) => reply
      .header('Cache-Control', 'no-store')
      .type('text/html')
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${target}"><title>Signing in…</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px">Signing in… <a href="${target}">Continue</a></body></html>`);

    const fail = (req, reply, code, detail) => {
      req.log.warn({ code, detail }, 'single sign-on failed');
      audit(req, null, adminOnly ? 'admin_sso_login_failed' : 'sso_login_failed', { reason: code, detail: String(detail ?? '').slice(0, 300) });
      return continueTo(reply.clearCookie(txCookie, { path: txOpts.path }), `/?sso_error=${encodeURIComponent(code)}`);
    };

    const publicOrigin = new URL(config.oidc.publicUrl[scope]).origin;

    app.get('/api/auth/oidc/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      // The sign-in cookie must be set on the same address the provider sends
      // the browser back to. If the panel was opened under another address
      // (IP instead of name, other port, tunnel), start again on the right one.
      const here = `${req.protocol}://${req.host}`;
      if (here.toLowerCase() !== publicOrigin.toLowerCase()) {
        req.log.info({ here, publicOrigin }, 'single sign-on started on another address; moving to the configured one');
        return reply.redirect(`${publicOrigin}/api/auth/oidc/start`);
      }
      try {
        const { url, tx } = await oidc.startLogin(scope);
        const token = app.jwt.sign({ scope: `${scope}:oidc`, ...tx }, { expiresIn: '10m' });
        return reply.header('Cache-Control', 'no-store').setCookie(txCookie, token, txOpts).redirect(url);
      } catch (err) {
        return fail(req, reply, 'unavailable', err.message);
      }
    });

    app.get('/api/auth/oidc/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      let tx;
      const raw = req.cookies[txCookie];
      try {
        tx = app.jwt.verify(raw ?? '');
        if (tx.scope !== `${scope}:oidc`) throw new Error('wrong scope');
      } catch (err) {
        // Say precisely why, for the activity log and the panel log.
        const why = !raw
          ? `the browser brought no sign-in cookie to ${req.protocol}://${req.host}. Usual causes: the sign-in `
            + 'was started under another address than the configured public URL, the browser blocks cookies, '
            + `or COOKIE_SECURE=true on a plain-http address other than localhost`
          : /expired/i.test(err.message) ? 'the sign-in took longer than 10 minutes'
          : `the sign-in cookie was not valid (${err.message})`;
        return fail(req, reply, 'expired', why);
      }
      reply.clearCookie(txCookie, { path: txOpts.path });

      if (req.query.error) {
        return fail(req, reply, req.query.error === 'access_denied' ? 'denied' : 'failed',
          `${req.query.error}: ${req.query.error_description ?? ''}`);
      }

      let claims;
      try {
        claims = await oidc.finishLogin(scope, req.query, tx);
      } catch (err) {
        return fail(req, reply, 'failed', err.message);
      }

      let result;
      try {
        result = oidc.resolveAccount(claims, { adminOnly });
      } catch (err) {
        return fail(req, reply, err.code ?? 'failed', `${err.message} (sub ${claims.sub}, email ${claims.email ?? '-'})`);
      }
      const { user, linked, created } = result;
      const actor = { account: user, ip: req.ip };
      if (created) audit(actor, null, 'sso_account_created', { email: user.email, issuer: claims.iss });
      if (linked) audit(actor, null, 'sso_account_linked', { email: user.email, issuer: claims.iss });

      // The panel's own 2FA still applies, unless the provider confirmed MFA.
      const idpMfa = config.oidc.trustIdpMfa && oidc.idpUsedMfa(claims);
      if (!idpMfa && (user.totp_enabled || user.totp_required)) {
        const stage = user.totp_enabled ? 'verify' : 'setup';
        const token = app.jwt.sign({ sub: user.id, scope: `${scope}:2fa`, stage }, { expiresIn: '5m' });
        reply.setCookie(pendingCookie, token, cookieOpts(300));
        return continueTo(reply, '/?sso=2fa');
      }

      const session = await reply.jwtSign({ sub: user.id, scope });
      req.account = user;
      audit(req, null, adminOnly ? 'admin_login' : 'login', { sso: true, idpMfa: oidc.idpUsedMfa(claims) });
      reply.clearCookie(pendingCookie, { path: '/' }).setCookie(cookieName, session, cookieOpts(SESSION_HOURS * 3600));
      return continueTo(reply, '/');
    });
  }

  // ---- Single sign-on with Google, Microsoft, GitHub (sso.js) -----------------------
  // Routes exist when the portal has a public address (needed for the callback URL);
  // whether a provider is switched on is checked on every request (Settings).
  if (config.oidc.publicUrl[scope]) {
    const txCookie = `${cookieName}_sso`;
    const txPath = '/api/auth/sso';
    const txOpts = { path: txPath, httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: 600 };
    const publicOrigin = new URL(config.oidc.publicUrl[scope]).origin;
    const known = (id) => sso.PROVIDER_IDS.includes(id);

    const continueTo = (reply, target) => reply
      .header('Cache-Control', 'no-store')
      .type('text/html')
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${target}"><title>Signing in…</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px">Signing in… <a href="${target}">Continue</a></body></html>`);

    const fail = (req, reply, provider, code, detail, linking = false) => {
      req.log.warn({ provider, code, detail }, 'single sign-on failed');
      audit(req, null, adminOnly ? 'admin_sso_login_failed' : 'sso_login_failed',
        { provider, reason: code, detail: String(detail ?? '').slice(0, 300) });
      const target = linking ? `/?sso_error=${encodeURIComponent(code)}#account` : `/?sso_error=${encodeURIComponent(code)}`;
      return continueTo(reply.clearCookie(txCookie, { path: txPath }), target);
    };

    app.get('/api/auth/sso/:provider/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const id = req.params.provider;
      if (!known(id)) return reply.code(404).send({ error: 'Unknown sign-in provider' });
      const here = `${req.protocol}://${req.host}`;
      const linking = req.query.link === '1';
      if (here.toLowerCase() !== publicOrigin.toLowerCase()) {
        return reply.redirect(`${publicOrigin}/api/auth/sso/${id}/start${linking ? '?link=1' : ''}`);
      }
      // Linking needs the signed-in user (same-site click, so the session cookie
      // is here) and a recent sign-in, so a stolen session can't add a way in.
      let link = null;
      if (linking) {
        let claim = null;
        try { claim = app.jwt.verify(req.cookies[cookieName] ?? ''); } catch { /* not signed in */ }
        if (!claim || claim.scope !== scope) return fail(req, reply, id, 'reauth', 'not signed in', true);
        if (!claim.iat || Date.now() / 1000 - claim.iat > RECENT_SIGN_IN_S) return fail(req, reply, id, 'reauth', 'sign-in too old', true);
        link = claim.sub;
      }
      try {
        const { url, tx } = await sso.startLogin(id, scope);
        const token = app.jwt.sign({ scope: `${scope}:sso`, ...tx, link }, { expiresIn: '10m' });
        return reply.header('Cache-Control', 'no-store').setCookie(txCookie, token, txOpts).redirect(url);
      } catch (err) {
        return fail(req, reply, id, 'unavailable', err.message, linking);
      }
    });

    app.get('/api/auth/sso/:provider/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const id = req.params.provider;
      if (!known(id)) return reply.code(404).send({ error: 'Unknown sign-in provider' });
      let tx;
      try {
        tx = app.jwt.verify(req.cookies[txCookie] ?? '');
        if (tx.scope !== `${scope}:sso` || tx.provider !== id) throw new Error('wrong sign-in transaction');
      } catch (err) {
        return fail(req, reply, id, 'expired', req.cookies[txCookie] ? err.message : 'the browser brought no sign-in cookie');
      }
      reply.clearCookie(txCookie, { path: txPath });
      const linking = !!tx.link;
      if (req.query.error) {
        return fail(req, reply, id, req.query.error === 'access_denied' ? 'denied' : 'failed',
          `${req.query.error}: ${req.query.error_description ?? ''}`, linking);
      }
      let identity;
      try {
        identity = await sso.finishLogin(id, scope, req.query, tx);
      } catch (err) {
        return fail(req, reply, id, err.code ?? 'failed', err.message, linking);
      }
      let result;
      try {
        result = sso.resolveAccount(identity, { scope, adminOnly, linkUserId: tx.link ?? null });
      } catch (err) {
        return fail(req, reply, id, err.code ?? 'failed', `${err.message} (subject ${identity.subject}, email ${identity.email ?? '-'})`, linking);
      }
      const { user, linked, created } = result;
      const actor = { account: user, ip: req.ip };
      if (created) audit(actor, null, 'sso_account_created', { provider: id, email: user.email });
      if (linked) audit(actor, null, 'sso_identity_linked', { provider: id, email: identity.email });
      if (linking) return continueTo(reply, `/?sso_linked=${encodeURIComponent(id)}#account`);

      // The panel's own 2FA still applies, unless the provider confirmed MFA.
      const idpMfa = config.oidc.trustIdpMfa && identity.mfa;
      if (!idpMfa && (user.totp_enabled || user.totp_required)) {
        const stage = user.totp_enabled ? 'verify' : 'setup';
        const token = app.jwt.sign({ sub: user.id, scope: `${scope}:2fa`, stage }, { expiresIn: '5m' });
        reply.setCookie(pendingCookie, token, cookieOpts(300));
        return continueTo(reply, '/?sso=2fa');
      }
      const session = await reply.jwtSign({ sub: user.id, scope });
      req.account = user;
      audit(req, null, adminOnly ? 'admin_login' : 'login', { sso: id, idpMfa: identity.mfa });
      reply.clearCookie(pendingCookie, { path: '/' }).setCookie(cookieName, session, cookieOpts(SESSION_HOURS * 3600));
      return continueTo(reply, '/');
    });
  }

  // Personal color scheme and light/dark mode
  app.get('/api/account/appearance', { preHandler: app.authenticate }, async (req) => userAppearance(req.account.id));
  app.put('/api/account/appearance', {
    preHandler: app.authenticate,
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { scheme: { type: ['string', 'null'], maxLength: 30 }, mode: { type: 'string', enum: MODES } },
      },
    },
  }, async (req) => setUserAppearance(req.account.id, req.body));

  app.get('/api/account/identities', { preHandler: app.authenticate }, async (req) => ({
    ...sso.identitiesOf(req.account.id, scope),
    recent: !!(req.user.iat && Date.now() / 1000 - req.user.iat < RECENT_SIGN_IN_S),
  }));

  app.delete('/api/account/identities/:provider', { preHandler: app.authenticate }, async (req, reply) => {
    sso.unlink(req.account.id, req.params.provider, scope);
    audit(req, null, 'sso_identity_unlinked', { provider: req.params.provider });
    return reply.code(204).send();
  });

  // ---- Passkeys: sign-in ----------------------------------------------------------
  const keyBody = { type: 'string', minLength: 20, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };

  app.post('/api/auth/passkey/options', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => passkeys.authenticationOptions(scope, req));

  // Signature-based, so nothing to guess: a looser limit than for passwords.
  app.post('/api/auth/passkey/verify', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['key', 'response'], properties: { key: keyBody, response: { type: 'object' } } } },
  }, async (req, reply) => {
    let user;
    try {
      user = await passkeys.finishAuthentication(req.body.key, req.body.response);
    } catch (err) {
      audit(req, null, adminOnly ? 'admin_login_failed' : 'login_failed', { passkey: true, reason: err.message });
      throw err;
    }
    if (adminOnly && !user.is_admin) {
      audit({ account: user, ip: req.ip }, null, 'admin_login_failed', { passkey: true, reason: 'not an administrator' });
      return reply.code(401).send({ error: 'This passkey was not accepted. Use a passkey registered for this panel.' });
    }
    // Passkeys always require biometrics or a PIN on the device: that's two factors,
    // so the TOTP step (and a "2FA required" setting) is satisfied.
    return startSession(req, reply, user, 'passkey');
  });

  // ---- Own account: passkeys -----------------------------------------------------------
  // Adding a passkey needs a recent sign-in (or the password), so a stolen session
  // can't quietly register the attacker's passkey.

  app.get('/api/account/passkeys', { preHandler: app.authenticate }, async (req) => ({
    available: passkeys.relyingParty(scope, req).usable,
    passkeys: passkeys.listPasskeys(req.account.id),
  }));

  app.post('/api/account/passkeys/options', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', properties: { password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const recent = req.user.iat && Date.now() / 1000 - req.user.iat < RECENT_SIGN_IN_S;
    if (!recent) {
      const ok = req.body?.password
        && await bcrypt.compare(req.body.password, db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.account.id).password_hash);
      if (!ok) {
        return reply.code(403).send({
          error: req.body?.password ? 'The password is not correct' : 'Confirm with your password to add a passkey',
          needPassword: true,
        });
      }
    }
    return passkeys.registrationOptions(scope, req, req.account);
  });

  app.post('/api/account/passkeys', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['key', 'response'],
        properties: { key: keyBody, response: { type: 'object' }, name: { type: 'string', maxLength: 60 } },
      },
    },
  }, async (req, reply) => {
    const added = await passkeys.finishRegistration(req.account, req.body.key, req.body.response, req.body.name);
    audit(req, null, 'passkey_added', { name: added.name, synced: added.synced });
    return reply.code(201).send(added);
  });

  app.patch('/api/account/passkeys/:id', {
    preHandler: app.authenticate,
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 60 } } } },
  }, async (req) => {
    passkeys.renamePasskey(req.account.id, req.params.id, req.body.name);
    return { ok: true };
  });

  app.delete('/api/account/passkeys/:id', { preHandler: app.authenticate }, async (req, reply) => {
    passkeys.deletePasskey(req.account.id, req.params.id);
    audit(req, null, 'passkey_removed');
    return reply.code(204).send();
  });

  // ---- Own account: manage 2FA ------------------------------------------------
  app.get('/api/account/2fa', { preHandler: app.authenticate }, async (req) => totp.twoFactorState(req.account.id));

  app.post('/api/account/2fa/setup', { preHandler: app.authenticate }, async (req, reply) => {
    if (totp.twoFactorState(req.account.id).enabled) return reply.code(409).send({ error: 'Two-factor authentication is already on' });
    return totp.beginSetup(req.account.id);
  });

  app.post('/api/account/2fa/activate', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const codes = totp.activate(req.account.id, String(req.body.code).replace(/\s/g, ''));
    if (!codes) return reply.code(400).send({ error: 'That code is not correct. Enter the 6-digit code your app shows now.' });
    audit(req, null, 'twofa_enabled');
    return { recoveryCodes: codes };
  });

  const codeBody = { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } } };

  app.post('/api/account/2fa/disable', {
    preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: codeBody,
  }, async (req, reply) => {
    const state = totp.twoFactorState(req.account.id);
    if (state.required) return reply.code(403).send({ error: 'Your provider requires two-factor authentication for your account' });
    if (!totp.verify(req.account.id, req.body.code)) return reply.code(400).send({ error: 'That code is not correct' });
    totp.reset(req.account.id);
    audit(req, null, 'twofa_disabled');
    return { enabled: false };
  });

  app.post('/api/account/2fa/recovery-codes', {
    preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: codeBody,
  }, async (req, reply) => {
    if (!totp.verify(req.account.id, req.body.code)) return reply.code(400).send({ error: 'That code is not correct' });
    audit(req, null, 'twofa_recovery_codes');
    return { recoveryCodes: totp.newRecoveryCodesFor(req.account.id) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    return reply.clearCookie(cookieName, { path: '/' }).clearCookie(pendingCookie, { path: '/' }).code(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => ({
    id: req.account.id,
    email: req.account.email,
    isAdmin: !!req.account.is_admin,
  }));
}

export default fp(authPlugin);
