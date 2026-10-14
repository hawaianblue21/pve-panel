// Personal appearance, white-label branding and the filtered activity log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from '../support/stack.mjs';

let stack;
let admin;
let rina;

// 1×1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const svg = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`).toString('base64');

before(async () => {
  stack = await startStack();
  admin = await stack.adminSession();
  rina = await stack.customerWith('rina@example.com');
});
after(async () => { await stack?.stop(); });

test('personal appearance: own scheme and light/dark mode, only for this account', async () => {
  const a = (await rina.get('/api/account/appearance')).json;
  assert.equal(a.allowed, true);
  assert.equal(a.scheme, null);
  assert.equal(a.mode, 'system');
  assert.equal(a.effective, 'harbor');

  const set = await rina.put('/api/account/appearance', { scheme: 'orchid', mode: 'dark' });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.effective, 'orchid');
  assert.equal(set.json.mode, 'dark');
  assert.equal((await rina.put('/api/account/appearance', { scheme: 'neon' })).status, 400);
  assert.equal((await rina.put('/api/account/appearance', { mode: 'sepia' })).status, 400);
  assert.equal((await rina.put('/api/account/appearance', {})).status, 400);

  // the panel's scheme for everyone is unchanged; admins see their own default
  assert.equal((await stack.customer().get('/api/brand')).json.scheme, 'harbor');
  assert.equal((await admin.get('/api/account/appearance')).json.effective, 'harbor');

  // back to the panel default
  const reset = await rina.put('/api/account/appearance', { scheme: null, mode: 'system' });
  assert.equal(reset.json.scheme, null);
  assert.equal(reset.json.effective, 'harbor');
});

test('the owner can turn personal appearance off for everyone', async () => {
  await rina.put('/api/account/appearance', { scheme: 'ember', mode: 'light' });
  const off = await admin.put('/api/admin/settings/appearance', { allowPersonal: false });
  assert.equal(off.json.allowPersonal, false);
  assert.equal(off.json.scheme, 'harbor', 'scheme untouched');
  const a = (await rina.get('/api/account/appearance')).json;
  assert.equal(a.allowed, false);
  assert.equal(a.effective, 'harbor');
  assert.equal(a.mode, 'system');
  assert.equal((await rina.put('/api/account/appearance', { mode: 'dark' })).status, 403);
  await admin.put('/api/admin/settings/appearance', { allowPersonal: true });
  assert.equal((await rina.get('/api/account/appearance')).json.effective, 'ember', 'the choice was kept');
});

test('branding: name and support link reach the sign-in page; bad links are refused', async () => {
  assert.equal((await stack.customer().get('/api/brand')).json.name, 'PVE Panel');
  const r = await admin.put('/api/admin/settings/branding', { name: 'Acme Cloud', supportUrl: 'https://support.example.com' });
  assert.equal(r.status, 200, r.text);
  const b = (await stack.customer().get('/api/brand')).json;
  assert.equal(b.name, 'Acme Cloud');
  assert.equal(b.supportUrl, 'https://support.example.com');
  assert.equal((await stack.admin().get('/api/brand')).json.name, 'Acme Cloud');
  assert.equal((await admin.put('/api/admin/settings/branding', { supportUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings/branding', { name: 'x'.repeat(41) })).status, 400);
  assert.equal((await rina.put('/api/admin/settings/branding', { name: 'x' })).status, 404, 'not on the customer port');
  // empty name: back to PANEL_NAME
  await admin.put('/api/admin/settings/branding', { name: '' });
  assert.equal((await stack.customer().get('/api/brand')).json.name, 'PVE Panel');
  await admin.put('/api/admin/settings/branding', { name: 'Acme Cloud' });
});

test('branding: logo and favicon uploads are checked, served and removable', async () => {
  const png = await admin.put('/api/admin/settings/branding/logo', { type: 'image/png', data: PNG });
  assert.equal(png.status, 200, png.text);
  assert.match(png.json.logo, /^\/branding\/logo\.png\?v=\d+$/);
  const served = await fetch(stack.customerUrl + png.json.logo);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await stack.customer().get('/api/brand')).json.logo, png.json.logo);

  // an SVG replaces the PNG
  const ok = await admin.put('/api/admin/settings/branding/logo', { type: 'image/svg+xml', data: svg('<circle cx="5" cy="5" r="4"/>') });
  assert.match(ok.json.logo, /logo\.svg/);
  assert.equal((await fetch(`${stack.customerUrl}/branding/logo.png`)).status, 404);

  for (const bad of ['<script>alert(1)</script>', '<a href="https://evil.example"><circle r="1"/></a>', '<circle r="1" onload="x()"/>', '<foreignObject></foreignObject>']) {
    const r = await admin.put('/api/admin/settings/branding/logo', { type: 'image/svg+xml', data: svg(bad) });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await admin.put('/api/admin/settings/branding/logo', { type: 'image/png', data: svg('') })).status, 400, 'not a PNG');
  assert.equal((await admin.put('/api/admin/settings/branding/logo', { type: 'image/gif', data: PNG })).status, 400);
  assert.equal((await admin.put('/api/admin/settings/branding/banner', { type: 'image/png', data: PNG })).status, 404);
  const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(140 * 1024)]).toString('base64');
  assert.equal((await admin.put('/api/admin/settings/branding/favicon', { type: 'image/png', data: big })).status, 413);

  assert.equal((await admin.put('/api/admin/settings/branding/favicon', { type: 'image/png', data: PNG })).status, 200);
  assert.ok((await stack.customer().get('/api/brand')).json.favicon);
  const removed = await admin.del('/api/admin/settings/branding/logo');
  assert.equal(removed.json.logo, null);
  assert.equal((await stack.customer().get('/api/brand')).json.logo, null);
  // other files in the folder are never served
  assert.equal((await fetch(`${stack.customerUrl}/branding/panel.db`)).status, 404);
});

test('activity: filter by who (customer, admin, panel) and by kind of action, with paging', async () => {
  await rina.put('/api/account/appearance', { mode: 'dark' });          // not audited, fine
  await stack.customer().post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password-123' });

  const all = (await admin.get('/api/admin/activity?limit=500')).json;
  assert.ok(all.events.length > 5);
  const kinds = new Set(all.events.map((e) => e.actor));
  for (const k of ['customer', 'admin', 'anonymous']) assert.ok(kinds.has(k), `${k} in ${[...kinds]}`);

  const customers = (await admin.get('/api/admin/activity?actor=customer')).json.events;
  assert.ok(customers.length);
  assert.ok(customers.every((e) => e.actor === 'customer'));
  assert.ok(customers.some((e) => e.email === 'rina@example.com' && e.action === 'login'));

  const admins = (await admin.get('/api/admin/activity?actor=admin&category=change')).json.events;
  assert.ok(admins.some((e) => e.action === 'admin_branding'));
  assert.ok(admins.every((e) => e.actor === 'admin' && e.category === 'change'));

  const security = (await admin.get('/api/admin/activity?category=security&q=nobody%40example.com')).json.events;
  assert.equal(security.length, 1);
  assert.equal(security[0].action, 'login_failed');
  assert.equal(security[0].actor, 'anonymous');

  const page1 = (await admin.get('/api/admin/activity?limit=3')).json;
  assert.equal(page1.events.length, 3);
  assert.ok(page1.nextBefore);
  const page2 = (await admin.get(`/api/admin/activity?limit=3&before=${page1.nextBefore}`)).json;
  assert.ok(page2.events.every((e) => e.id < page1.events[2].id));

  assert.equal((await admin.get('/api/admin/activity?actor=robot')).status, 400);
  // search text can't break out of LIKE
  assert.equal((await admin.get('/api/admin/activity?q=%25')).json.events.length, 0);
});
