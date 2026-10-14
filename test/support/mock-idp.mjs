// Simulated sign-in providers for tests:
//   /google, /microsoft   OpenID Connect (discovery, authorize, token with PKCE,
//                         RS256-signed ID tokens, JWKS)
//   /github               GitHub OAuth app (authorize, access_token with PKCE, /api/user, /api/user/emails)
// The authorize endpoints approve at once and send the browser back with a code
// for the user set with idp.signInAs(provider, user).
import http from 'node:http';
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export async function startMockIdp({ clientId = 'test-client', clientSecret = 'test-secret' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();           // code → { provider, user, nonce, challenge, redirectUri }
  const users = new Map();           // provider → user to sign in as
  const tokens = new Map();          // github access token → user
  const seen = [];                   // authorize requests (for assertions)
  let base = '';

  const sign = (claims) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const body = b64url(JSON.stringify(claims));
    return `${head}.${body}.${b64url(crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey))}`;
  };
  const form = (req) => new Promise((r) => { let x = ''; req.on('data', (c) => { x += c; }); req.on('end', () => r(new URLSearchParams(x))); });
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const pkceOk = (verifier, challenge) => !!verifier && b64url(crypto.createHash('sha256').update(verifier).digest()) === challenge;

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const [, provider, ...rest] = u.pathname.split('/');
    const tail = `/${rest.join('/')}`;
    const issuer = `${base}/${provider}`;

    if (tail === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (tail === '/jwks') return json(res, 200, { keys: [jwk] });
    if (tail === '/authorize' || tail === '/login/oauth/authorize') {
      const q = Object.fromEntries(u.searchParams);
      seen.push({ provider, ...q });
      if (q.client_id !== clientId) return json(res, 400, { error: 'unknown client' });
      const user = users.get(provider);
      const back = new URL(q.redirect_uri);
      if (!user) { back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', q.state); }
      else {
        const code = crypto.randomBytes(12).toString('hex');
        codes.set(code, { provider, user, nonce: q.nonce, challenge: q.code_challenge, redirectUri: q.redirect_uri });
        back.searchParams.set('code', code); back.searchParams.set('state', q.state);
      }
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (req.method === 'POST' && (tail === '/token' || tail === '/login/oauth/access_token')) {
      const f = await form(req);
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent) : null;
      const [id, secret] = basic ?? [f.get('client_id'), f.get('client_secret')];
      if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: 'invalid_client' });
      const c = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (!c || c.provider !== provider || c.redirectUri !== f.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
      if (!pkceOk(f.get('code_verifier'), c.challenge)) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      if (provider === 'github') {
        const t = crypto.randomBytes(12).toString('hex');
        tokens.set(t, c.user);
        return json(res, 200, { access_token: t, token_type: 'bearer', scope: 'read:user,user:email' });
      }
      const now = Math.floor(Date.now() / 1000);
      const { sub, ...claims } = c.user;
      return json(res, 200, {
        access_token: crypto.randomBytes(12).toString('hex'), token_type: 'Bearer', expires_in: 3600,
        id_token: sign({ iss: issuer, aud: clientId, sub, nonce: c.nonce, iat: now, exp: now + 300, ...claims }),
      });
    }
    if (provider === 'github' && tail.startsWith('/api/')) {
      const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!user) return json(res, 401, { message: 'Bad credentials' });
      if (tail === '/api/user') return json(res, 200, { id: user.id, login: user.login, name: user.name ?? null });
      if (tail === '/api/user/emails') return json(res, 200, user.emails ?? []);
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base, clientId, clientSecret, seen,
    endpoints: { google: `${base}/google`, microsoft: `${base}/microsoft`, github: `${base}/github` },
    signInAs(provider, user) { users.set(provider, user); },
    close: () => new Promise((r) => srv.close(r)),
  };
}
