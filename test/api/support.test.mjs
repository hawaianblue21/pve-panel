// Support tickets, the knowledge base and the optional Zammad sync.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor, ADMIN } from '../support/stack.mjs';
import { startMockZammad } from '../support/mock-zammad.mjs';

let stack;
let admin;
let rina;
let zammad;

before(async () => {
  zammad = await startMockZammad();
  stack = await startStack({ env: { PANEL_PUBLIC_URL: '{CUSTOMER_URL}' }, mail: true });
  admin = await stack.adminSession();
  rina = await stack.customerWith('rina@example.com');
  await admin.put('/api/admin/vms/101', { userId: rina.userId, label: 'web-prod' });
  await admin.put('/api/admin/settings/email', {
    host: '127.0.0.1', port: stack.smtp.port, security: 'none', username: 'panel', password: 'mail-secret',
    fromName: 'Panel', fromAddress: 'panel@example.com', panelUrl: stack.customerUrl,
  });
});
after(async () => { await stack?.stop(); await zammad?.close(); });

let first;   // ticket number

test('a customer opens a ticket about one of her servers; it is routed by category', async () => {
  const bad = await rina.post('/api/support/tickets', { subject: 'Hi', body: 'short' });
  assert.equal(bad.status, 400);
  const other = await rina.post('/api/support/tickets', { subject: 'Not my server', body: 'This is about server 102.', vmid: 102 });
  assert.equal(other.status, 404, 'only own servers');

  const r = await rina.post('/api/support/tickets', {
    subject: 'Website down after reboot', body: 'web-prod is not reachable since I restarted it this morning.',
    category: 'network', priority: 'high', vmid: 101,
  });
  assert.equal(r.status, 201, r.text);
  first = r.json.number;
  assert.ok(first > 1000);
  assert.equal(r.json.status, 'open');
  assert.equal(r.json.messages.length, 1);
  assert.equal(r.json.messages[0].name, 'You');

  const list = (await rina.get('/api/support/tickets')).json;
  assert.deepEqual(list.tickets.map((t) => t.number), [first]);

  const desk = (await admin.get('/api/admin/support/tickets?status=active')).json;
  const t = desk.tickets.find((x) => x.number === first);
  assert.equal(t.queue, 'L2', 'network → L2');
  assert.equal(t.email, 'rina@example.com');
  assert.equal(t.context.vmid, 101);
  assert.equal(t.context.name, 'web-prod');
  assert.equal(desk.counts.open, 1);

  const sec = await rina.post('/api/support/tickets', { subject: 'Strange logins', body: 'I see sign-ins I did not make.', category: 'security' });
  assert.equal((await admin.get(`/api/admin/support/tickets/${sec.json.number}`)).json.queue, 'L3');
});

test('other customers never see a ticket', async () => {
  const bob = await stack.customerWith('bob@example.com');
  assert.equal((await bob.get(`/api/support/tickets/${first}`)).status, 404);
  assert.equal((await bob.post(`/api/support/tickets/${first}/messages`, { body: 'hello' })).status, 404);
  assert.deepEqual((await bob.get('/api/support/tickets')).json.tickets, []);
  assert.equal((await stack.customer().get('/api/support/tickets')).status, 401);
});

test('agents answer and write internal notes; the customer gets the answer by email, never the note', async () => {
  const note = await admin.post(`/api/admin/support/tickets/${first}/messages`, { body: 'Checked: firewall rule missing after reboot.', internal: true });
  assert.equal(note.status, 200, note.text);
  assert.equal(note.json.status, 'open', 'a note does not change the status');
  const reply = await admin.post(`/api/admin/support/tickets/${first}/messages`, { body: 'Please run `sudo netplan apply` and try again.' });
  assert.equal(reply.json.status, 'waiting');
  assert.equal(reply.json.assigneeId, 1, 'whoever answers first takes it');

  const seen = (await rina.get(`/api/support/tickets/${first}`)).json;
  assert.equal(seen.status, 'waiting');
  assert.deepEqual(seen.messages.map((m) => m.author), ['customer', 'agent']);
  assert.equal(seen.messages[1].name, 'Support');
  assert.ok(!JSON.stringify(seen).includes('firewall rule missing'), 'internal note hidden');
  assert.ok(!JSON.stringify(seen).includes(ADMIN.email), 'agent email hidden');
  assert.equal((await rina.get('/api/support/tickets')).json.waiting, 1);

  const mail = await waitFor(() => stack.smtp.messages.find((m) => m.to === 'rina@example.com' && /New reply/.test(m.subject)), { what: 'reply email' });
  assert.match(mail.text, /netplan apply/);
  assert.match(mail.text, new RegExp(`#support/${first}`));
  assert.ok(!stack.smtp.messages.some((m) => /firewall rule missing/.test(m.text ?? '')));

  // the customer answers: support's turn again; then closes it
  assert.equal((await rina.post(`/api/support/tickets/${first}/messages`, { body: 'That worked, thanks!' })).json.status, 'open');
  assert.equal((await rina.post(`/api/support/tickets/${first}/close`)).json.status, 'closed');
  assert.equal((await rina.post(`/api/support/tickets/${first}/messages`, { body: 'one more' })).status, 409);
});

test('agents set status, priority, queue and assignee', async () => {
  const r = await admin.patch(`/api/admin/support/tickets/${first}`, { status: 'resolved', queue: 'L1', priority: 'normal' });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'resolved');
  assert.equal((await admin.patch(`/api/admin/support/tickets/${first}`, { assigneeId: rina.userId })).status, 400, 'only administrators');
  const ctx = (await admin.get(`/api/admin/support/tickets/${first}`)).json;
  assert.ok(ctx.customer.servers.some((s) => s.vmid === 101));
  assert.ok(ctx.customer.activity.some((a) => a.action === 'ticket_created'));
  assert.equal(ctx.messages.find((m) => m.internal).body, 'Checked: firewall rule missing after reboot.');
});

test('knowledge base: drafts are hidden, published articles are found, visibility is respected', async () => {
  const draft = (await admin.post(`/api/admin/support/tickets/${first}/kb-draft`)).json;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.sourceTicket, first);
  assert.match(draft.body, /## Solution[\s\S]*netplan apply/);
  assert.equal((await rina.get(`/api/kb/${draft.slug}`)).status, 404, 'drafts are not shown');

  const pub = await admin.put(`/api/admin/kb/${draft.id}`, { title: 'Server unreachable after a reboot', status: 'published', category: 'Network' });
  assert.equal(pub.json.status, 'published');
  await admin.post('/api/admin/kb', { title: 'How to reset two-factor authentication', body: 'Ask support with your recovery code.', status: 'published', visibility: 'public', category: 'Account' });
  await admin.post('/api/admin/kb', { title: 'Escalation playbook for compromised servers', body: 'Suspend, snapshot, call the customer.', status: 'published', visibility: 'internal', category: 'Security' });

  const found = (await rina.get('/api/kb?q=server%20reboot&log=1')).json.results;
  assert.equal(found[0].slug, pub.json.slug);
  assert.ok(!(await rina.get('/api/kb?q=escalation%20playbook')).json.results.length, 'internal: agents only');
  const agents = (await admin.get('/api/admin/kb-search?q=escalation%20playbook')).json.results;
  assert.equal(agents.length, 1);

  // signed out: public articles only
  const anon = stack.customer();
  assert.equal((await anon.get(`/api/kb/${pub.json.slug}`)).status, 404);
  const pubList = (await anon.get('/api/kb')).json.categories.flatMap((c) => c.articles.map((a) => a.title));
  assert.deepEqual(pubList, ['How to reset two-factor authentication']);

  // reading and voting
  const art = (await rina.get(`/api/kb/${pub.json.slug}`)).json;
  assert.match(art.body, /netplan/);
  assert.equal((await rina.post(`/api/kb/${pub.json.slug}/feedback`, { helpful: true })).status, 200);
  const stats = (await admin.get('/api/admin/kb')).json;
  const row = stats.articles.find((a) => a.id === pub.json.id);
  assert.equal(row.views, 1);
  assert.equal(row.helpful, 1);
  assert.equal(stats.stats.published, 3);

  // searches without a result become the list of missing articles
  await rina.get('/api/kb?q=install%20own%20iso&log=1');
  await rina.get('/api/kb?q=Install%20own%20ISO&log=1');
  const gaps = (await admin.get('/api/admin/kb')).json.gaps;
  assert.deepEqual(gaps[0], { ...gaps[0], query: 'install own iso', count: 2 });
  assert.ok(!gaps.some((g) => g.query === 'server reboot'), 'searches with results are not gaps');

  // the ticket suggests the article to agents
  const t = (await rina.post('/api/support/tickets', { subject: 'Server not reachable after reboot', body: 'Same problem as last week.' })).json;
  const ctx = (await admin.get(`/api/admin/support/tickets/${t.number}`)).json;
  assert.equal(ctx.suggestions[0].slug, pub.json.slug);
});

test('permissions: read-only support sees tickets, agents answer and write articles, neither changes settings', async () => {
  const a = await admin.post('/api/admin/users', { email: 'agent@example.com', password: 'agent-password-123', isAdmin: true });
  const rbac = (await admin.get('/api/admin/rbac')).json;
  const role = (key) => rbac.roles.find((r) => r.key === key).id;
  await admin.put(`/api/admin/rbac/admins/${a.json.id}`, { roleId: role('agent') });
  const agent = stack.admin();
  assert.equal((await agent.post('/api/auth/login', { email: 'agent@example.com', password: 'agent-password-123' })).status, 200);
  const t = (await agent.get('/api/admin/support/tickets')).json.tickets[0];
  assert.equal((await agent.post(`/api/admin/support/tickets/${t.number}/messages`, { body: 'On it.' })).status, 200);
  assert.equal((await agent.post('/api/admin/kb', { title: 'Agent article' })).status, 201);
  assert.equal((await agent.put('/api/admin/settings/zammad', { enabled: false })).status, 403);
  assert.equal((await agent.post('/api/admin/users', { email: 'z@example.com', password: 'abcdefghijklm' })).status, 403);

  await admin.put(`/api/admin/rbac/admins/${a.json.id}`, { roleId: role('support') });
  const ro = stack.admin();
  await ro.post('/api/auth/login', { email: 'agent@example.com', password: 'agent-password-123' });
  assert.equal((await ro.get('/api/admin/support/tickets')).status, 200);
  assert.equal((await ro.post(`/api/admin/support/tickets/${t.number}/messages`, { body: 'x' })).status, 403);
  assert.equal((await ro.post('/api/admin/kb', { title: 'nope nope' })).status, 403);
});

test('Zammad: tickets and messages go to Zammad; agent replies come back through the signed webhook', async () => {
  assert.equal((await admin.put('/api/admin/settings/zammad', { enabled: true })).status, 400, 'needs address and token');
  const saved = (await admin.put('/api/admin/settings/zammad', {
    url: zammad.url, token: zammad.token, groups: { L1: 'Users', L2: 'L2 Network', L3: 'L3 Security' }, enabled: true,
  })).json;
  assert.equal(saved.hasToken, true);
  assert.equal(JSON.stringify(saved).includes(zammad.token), false);
  assert.equal(saved.webhookUrl, `${stack.customerUrl}/api/support/zammad/webhook`);
  const test1 = (await admin.post('/api/admin/settings/zammad/test')).json;
  assert.equal(test1.user, 'panel-bot@example.com');
  assert.deepEqual(test1.missing, []);

  const t = (await rina.post('/api/support/tickets', { subject: 'Disk almost full', body: 'My server says the disk is 95% full.', category: 'storage', vmid: 101 })).json;
  const z = await waitFor(() => [...zammad.state.tickets.values()].find((x) => x.title === `[#${t.number}] Disk almost full`), { what: 'ticket in Zammad' });
  assert.equal(z.group, 'L2 Network');
  assert.equal(z.customer, 'guess:rina@example.com');
  assert.match(zammad.state.articles.find((a) => a.ticket_id === z.id).body, /VMID 101/);

  await rina.post(`/api/support/tickets/${t.number}/messages`, { body: 'It is /var/log.' });
  const art = await waitFor(() => zammad.state.articles.find((a) => a.body === 'It is /var/log.'), { what: 'customer message in Zammad' });
  assert.equal(art.sender, 'Customer');
  assert.equal(art.onBehalfOf, 'rina@example.com');

  // an agent answers in Zammad → webhook
  const secret = saved.webhookSecret;
  const payload = {
    ticket: { id: z.id, state: 'open' },
    article: { id: 9001, sender: 'Agent', internal: false, body: '<p>Rotate the logs: <br>sudo journalctl --vacuum-size=200M</p>', created_by: { firstname: 'Sari', lastname: 'Agent' } },
  };
  const { raw, signature } = zammad.signedWebhook(secret, payload);
  const hook = (sig, body = raw) => fetch(`${stack.customerUrl}/api/support/zammad/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature': sig }, body });
  assert.equal((await hook('sha1=0000')).status, 401, 'bad signature');
  assert.equal((await hook(signature, raw.replace('Rotate', 'Delete'))).status, 401, 'changed body');
  const ok = await hook(signature);
  assert.equal(ok.status, 200);
  assert.equal((await hook(signature)).status, 200, 'the same article twice is stored once');

  const seen = (await rina.get(`/api/support/tickets/${t.number}`)).json;
  const fromZammad = seen.messages.filter((m) => m.author === 'agent');
  assert.equal(fromZammad.length, 1);
  assert.equal(fromZammad[0].name, 'Sari Agent');
  assert.equal(fromZammad[0].body, 'Rotate the logs: \nsudo journalctl --vacuum-size=200M');
  assert.equal(seen.status, 'waiting');

  // closed in Zammad → closed in the panel
  const closed = zammad.signedWebhook(secret, { ticket: { id: z.id, state: { name: 'closed' } } });
  await hook(closed.signature, closed.raw).then((r) => r.status);
  assert.equal((await rina.get(`/api/support/tickets/${t.number}`)).json.status, 'closed');
});

test('Zammad unreachable: tickets still work, the error is shown, and a retry sends them later', async () => {
  zammad.state.down = true;
  const t = (await rina.post('/api/support/tickets', { subject: 'Backup question', body: 'How often are snapshots kept?' })).json;
  const err = await waitFor(async () => (await admin.get(`/api/admin/support/tickets/${t.number}`)).json.zammadError, { what: 'sync error' });
  assert.match(err, /503/);
  assert.equal((await admin.get('/api/admin/settings/zammad')).json.pending.tickets, 1);
  zammad.state.down = false;
  const r = (await admin.post('/api/admin/settings/zammad/retry')).json;
  assert.equal(r.tickets, 1);
  const after = (await admin.get(`/api/admin/support/tickets/${t.number}`)).json;
  assert.equal(after.zammadError, null);
  assert.ok(after.zammad.id);
});
