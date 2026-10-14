// API tokens: customer scopes, blocked routes, admin RBAC and read-only tokens,
// revocation, expiry, account changes, and the activity log naming the token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack } from '../support/stack.mjs';

let stack;
let admin;
let rina;
const tok = {};
const call = async (base, method, p, token, body) => {
  const r = await fetch(`${base}${p}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
};
const C = (method, p, token, body) => call(stack.customerUrl, method, p, token, body);
const A = (method, p, token, body) => call(stack.adminUrl, method, p, token, body);

before(async () => {
  stack = await startStack();
  admin = await stack.adminSession();
  rina = await stack.customerWith('rina@example.com', { limits: {} });
  await admin.put('/api/admin/vms/101', { userId: rina.userId, label: 'web-prod' });
});
after(async () => { await stack?.stop(); });

test('a customer creates a token; the secret is shown once', async () => {
  assert.equal((await rina.post('/api/tokens', { name: 'x', scopes: ['root'] })).status, 400);
  assert.equal((await rina.post('/api/tokens', { name: 'x', days: 2 })).status, 400);
  const r = await rina.post('/api/tokens', { name: 'deploy script', scopes: ['power'], days: 30 });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.token, /^pvc_\d+_[A-Za-z0-9_-]{43}$/);
  tok.power = r.json.token;
  tok.powerId = r.json.id;
  const list = (await rina.get('/api/tokens')).json;
  assert.deepEqual(list.tokens.map((t) => [t.name, t.scopes]), [['deploy script', ['power']]]);
  assert.equal(JSON.stringify(list).includes(tok.power.split('_')[2]), false, 'the secret is not listed');
});

test('a token reads everything it may and changes only in its scopes', async () => {
  const vms = await C('GET', '/api/vms', tok.power);
  assert.equal(vms.status, 200, vms.text);
  assert.deepEqual(vms.json.map((v) => v.vmid), [101]);
  assert.equal((await C('GET', '/api/account', tok.power)).status, 200);
  const start = await C('POST', '/api/vms/101/power/start', tok.power);
  assert.ok([200, 202].includes(start.status), start.text);
  const vol = await C('POST', '/api/volumes', tok.power, { label: 'x', tier: 'standard', sizeGb: 1, vmid: 101 });
  assert.equal(vol.status, 403);
  assert.match(vol.json.error, /no "storage" permission/);
  const tick = await C('POST', '/api/support/tickets', tok.power, { subject: 'x', body: 'y' });
  assert.equal(tick.status, 403);
});

test('sign-in, account security, the console and tokens are never reachable with a token', async () => {
  for (const [m, p, b] of [
    ['GET', '/api/account/2fa'], ['POST', '/api/account/2fa/setup'], ['GET', '/api/account/passkeys'], ['GET', '/api/auth/me'],
    ['POST', '/api/tokens', { name: 'more' }], ['GET', '/api/tokens'], ['POST', '/api/vms/101/console'], ['POST', '/api/storage/keys'],
    ['GET', '/api/assistant'],
  ]) {
    const r = await C(m, p, tok.power, b);
    assert.equal(r.status, 403, `${m} ${p}: ${r.status}`);
  }
});

test('bad, foreign, revoked and expired tokens are refused; the log names the token', async () => {
  assert.equal((await C('GET', '/api/vms', 'pvc_1_notavalidsecret')).status, 401);
  assert.equal((await C('GET', '/api/vms', `${tok.power.slice(0, -1)}${tok.power.endsWith('A') ? 'B' : 'A'}`)).status, 401, 'one character changed');
  const pa = (await admin.post('/api/admin/tokens', { name: 'monitoring', readOnly: true })).json;
  tok.adminRead = pa.token;
  const wrong = await C('GET', '/api/vms', pa.token);
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /admin token/);
  assert.equal((await A('GET', '/api/admin/vms', tok.power)).status, 401, 'a customer token on the admin portal');

  const ev = (await admin.get('/api/admin/activity?q=power_start')).json.events[0];
  assert.match(ev.detail, /"apiToken":"deploy script"/);

  const t7 = (await rina.post('/api/tokens', { name: 'short', days: 7 })).json;
  const db = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), t7.id);
  db.close();
  const exp = await C('GET', '/api/vms', t7.token);
  assert.equal(exp.status, 401);
  assert.match(exp.json.error, /expired/);

  assert.equal((await rina.del(`/api/tokens/${tok.powerId}`)).status, 200);
  const rev = await C('GET', '/api/vms', tok.power);
  assert.equal(rev.status, 401);
  assert.match(rev.json.error, /revoked/);
  assert.equal((await rina.get('/api/tokens')).json.tokens.some((t) => t.id === tok.powerId), false);
});

test('admin tokens: the role decides, read-only stays read-only, no tokens or roles', async () => {
  assert.equal((await A('GET', '/api/admin/vms', tok.adminRead)).status, 200);
  const put = await A('PUT', '/api/admin/vms/101', tok.adminRead, { userId: rina.userId, label: 'renamed' });
  assert.equal(put.status, 403);
  assert.match(put.json.error, /read-only/);
  const full = (await admin.post('/api/admin/tokens', { name: 'automation' })).json.token;
  assert.equal((await A('PUT', '/api/admin/vms/101', full, { userId: rina.userId, label: 'web-prod-2' })).status, 200);
  for (const [m, p] of [['GET', '/api/admin/tokens'], ['POST', '/api/admin/tokens'], ['GET', '/api/admin/rbac'], ['GET', '/api/auth/me']]) {
    assert.equal((await A(m, p, full, m === 'POST' ? { name: 'x' } : undefined)).status, 403, `${m} ${p}`);
  }

  // a support (read-only) administrator's token can't change anything either
  const u = await admin.post('/api/admin/users', { email: 'helpdesk@example.com', password: 'helpdesk-password-1', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((r) => r.key === 'support').id;
  await admin.put(`/api/admin/rbac/admins/${u.json.id}`, { roleId: role });
  const h = stack.admin();
  await h.post('/api/auth/login', { email: 'helpdesk@example.com', password: 'helpdesk-password-1' });
  const ht = (await h.post('/api/admin/tokens', { name: 'reports' })).json.token;
  assert.equal((await A('GET', '/api/admin/users', ht)).status, 200);
  assert.equal((await A('POST', '/api/admin/users', ht, { email: 'x@example.com', password: 'x-password-12345' })).status, 403);

  // the owner sees and revokes every admin token; losing admin rights stops a token
  const all = (await admin.get('/api/admin/tokens/all')).json.tokens;
  assert.deepEqual(all.map((t) => t.email).sort(), ['admin@example.com', 'admin@example.com', 'helpdesk@example.com']);
  await admin.patch(`/api/admin/users/${u.json.id}`, { isAdmin: false });
  assert.equal((await A('GET', '/api/admin/users', ht)).status, 401);
  const mine = all.find((t) => t.name === 'automation');
  assert.equal((await admin.del(`/api/admin/tokens/all/${mine.id}`)).status, 200);
  assert.equal((await A('GET', '/api/admin/vms', full)).status, 401);
});
