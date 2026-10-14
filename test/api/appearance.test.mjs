// Color schemes: set by an admin, applied to both portals and to emails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';

let stack;
let admin;
before(async () => {
  stack = await startStack({ mail: true });
  admin = await stack.adminSession();
});
after(async () => { await stack?.stop(); });

test('default is Harbor; five schemes are offered', async () => {
  assert.equal((await stack.customer().get('/api/brand')).json.scheme, 'harbor');
  const r = (await admin.get('/api/admin/settings/appearance')).json;
  assert.deepEqual(r.schemes.map((s) => s.id), ['harbor', 'forest', 'ember', 'orchid', 'graphite']);
});

test('a scheme set by the admin reaches both portals (also before sign-in)', async () => {
  const r = await admin.put('/api/admin/settings/appearance', { scheme: 'forest' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await stack.customer().get('/api/brand')).json.scheme, 'forest');
  assert.equal((await stack.admin().get('/api/brand')).json.scheme, 'forest');
});

test('unknown schemes are refused; customers cannot change it', async () => {
  assert.equal((await admin.put('/api/admin/settings/appearance', { scheme: 'neon' })).status, 400);
  const c = await stack.customerWith('lena@example.com');
  assert.equal((await c.put('/api/admin/settings/appearance', { scheme: 'ember' })).status, 404);
  assert.equal((await stack.customer().get('/api/brand')).json.scheme, 'forest');
});

test('every scheme has CSS for light and dark mode', async () => {
  const css = (await stack.customer().get('/shared/styles.css')).text;
  for (const id of ['forest', 'ember', 'orchid', 'graphite']) {
    // light, dark when the device is dark (unless light was chosen), and dark when chosen
    assert.equal(css.split(`:root[data-scheme="${id}"] {`).length - 1, 1, `${id}: light block`);
    assert.equal(css.split(`:root[data-scheme="${id}"]:not([data-mode="light"]) {`).length - 1, 1, `${id}: device dark block`);
    assert.equal(css.split(`:root[data-scheme="${id}"][data-mode="dark"] {`).length - 1, 1, `${id}: chosen dark block`);
  }
  assert.match(css, /:root\[data-mode="dark"\] \{/, 'default scheme: chosen dark');
});

test('emails use the scheme colors', async () => {
  await admin.put('/api/admin/settings/appearance', { scheme: 'orchid' });
  await admin.put('/api/admin/settings/email', {
    host: '127.0.0.1', port: stack.smtp.port, security: 'none', username: 'panel', password: 'mail-secret',
    fromName: 'PVE Panel', fromAddress: 'panel@example.com', panelUrl: stack.customerUrl,
  });
  await admin.post('/api/admin/users', { email: 'mia@example.com', invite: true });
  const mail = await waitFor(() => stack.smtp.messages.find((m) => m.to === 'mia@example.com'), { what: 'invitation' });
  assert.match(mail.html, /#7339e0/, 'orchid accent on the button');
  assert.match(mail.html, /#221836/, 'orchid header');
});
