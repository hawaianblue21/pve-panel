// The AI assistant against a simulated model (Claude and OpenAI-compatible APIs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from '../support/stack.mjs';
import { startMockLlm } from '../support/mock-llm.mjs';

let stack;
let llm;
let admin;
let rina;
let conv;

before(async () => {
  llm = await startMockLlm();
  stack = await startStack();
  admin = await stack.adminSession();
  rina = await stack.customerWith('rina@example.com');
  await admin.put('/api/admin/vms/101', { userId: rina.userId, label: 'web-prod' });
  await admin.post('/api/admin/kb', { title: 'Server unreachable after a reboot', category: 'Network', status: 'published', body: 'Run `sudo netplan apply`.' });
  await admin.post('/api/admin/kb', { title: 'Escalation playbook', category: 'Security', status: 'published', visibility: 'internal', body: 'INTERNAL ONLY steps.' });
});
after(async () => { await stack?.stop(); await llm?.close(); });

test('off until the owner sets it up; the key is sealed and never shown', async () => {
  assert.equal((await rina.get('/api/assistant')).json.enabled, false);
  assert.equal((await rina.post('/api/assistant/conversations', { message: 'hi' })).status, 404);
  assert.equal((await admin.put('/api/admin/settings/ai', { enabled: true })).status, 400, 'no key yet');
  const s = await admin.put('/api/admin/settings/ai', { provider: 'anthropic', baseUrl: llm.url, apiKey: llm.apiKey, model: 'claude-sonnet-5-5', enabled: true, dailyLimit: 12 });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.hasKey, true);
  assert.equal(JSON.stringify(s.json).includes(llm.apiKey), false);
  const t = await admin.post('/api/admin/settings/ai/test');
  assert.equal(t.json.answer, 'Hello from the model.');
  assert.equal((await rina.get('/api/assistant')).json.enabled, true);
});

test('Claude API: searches the help center, answers with the article, and lists it as a source', async () => {
  const r = await rina.post('/api/assistant/conversations', { message: 'Website unreachable after reboot?' });
  assert.equal(r.status, 201, r.text);
  conv = r.json.id;
  const answer = r.json.messages.at(-1);
  assert.equal(answer.role, 'assistant');
  assert.match(answer.content, /Server unreachable after a reboot/);
  assert.deepEqual(answer.sources.map((s) => s.title), ['Server unreachable after a reboot']);
  assert.equal(r.json.messages.length, 2, 'tool rounds are not shown to the customer');

  const req = llm.requests.filter((x) => x.api === 'anthropic').at(-1);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.model, 'claude-sonnet-5-5');
  assert.match(req.body.system, /You can only read/);
  assert.match(req.body.system, /rina@example\.com/);
  assert.ok(req.body.tools.some((t) => t.name === 'propose_ticket' && t.input_schema));
  assert.equal(req.body.messages.at(-1).content[0].type, 'tool_result');
  assert.ok(!JSON.stringify(llm.requests).includes('INTERNAL ONLY'), 'agents-only articles never reach the model');
});

test('tools only see the customer\'s own servers', async () => {
  const own = (await rina.post(`/api/assistant/conversations/${conv}/messages`, { message: 'How is server 101 doing?' })).json;
  assert.match(own.messages.at(-1).content, /"vmid":101/);
  assert.match(own.messages.at(-1).content, /web-prod/);
  const other = (await rina.post(`/api/assistant/conversations/${conv}/messages`, { message: 'And server 102?' })).json;
  assert.match(other.messages.at(-1).content, /not one of the customer's servers/);
  assert.doesNotMatch(other.messages.at(-1).content, /"vmid":102/);
});

test('handover: the assistant proposes, the customer confirms, a ticket with the conversation is created', async () => {
  const r = (await rina.post('/api/assistant/conversations', { message: 'I think my server was hacked, I want a person' })).json;
  const msg = r.messages.at(-1);
  assert.equal(msg.handover.category, 'security');
  assert.equal(msg.handover.vmid, 101);
  assert.equal((await rina.get('/api/support/tickets')).json.tickets.length, 0, 'nothing is created by the model itself');

  const t = await rina.post(`/api/assistant/conversations/${r.id}/handover`, { messageId: msg.id });
  assert.equal(t.status, 201, t.text);
  assert.equal(t.json.subject, 'Server may be hacked');
  assert.match(t.json.messages[0].body, /Conversation with the assistant/);
  assert.match(t.json.messages[0].body, /I think my server was hacked/);
  assert.equal((await admin.get(`/api/admin/support/tickets/${t.json.number}`)).json.queue, 'L3');
  assert.equal((await rina.post(`/api/assistant/conversations/${r.id}/handover`, { messageId: msg.id })).status, 409, 'only once');
  assert.equal((await rina.get(`/api/assistant/conversations/${r.id}`)).json.ticketNumber, t.json.number);
});

test('conversations are private; ratings; deleting', async () => {
  const bob = await stack.customerWith('bob@example.com');
  assert.equal((await bob.get(`/api/assistant/conversations/${conv}`)).status, 404);
  assert.equal((await bob.post(`/api/assistant/conversations/${conv}/messages`, { message: 'x' })).status, 404);
  const msg = (await rina.get(`/api/assistant/conversations/${conv}`)).json.messages.find((m) => m.role === 'assistant');
  assert.equal((await bob.post(`/api/assistant/messages/${msg.id}/rating`, { helpful: false })).status, 404);
  assert.equal((await rina.post(`/api/assistant/messages/${msg.id}/rating`, { helpful: true })).status, 200);
  const list = (await rina.get('/api/assistant/conversations')).json;
  assert.equal(list.length, 2);
  const extra = (await bob.post('/api/assistant/conversations', { message: 'my servers' })).json;
  assert.equal((await bob.del(`/api/assistant/conversations/${extra.id}`)).status, 204);
  assert.equal((await bob.get(`/api/assistant/conversations/${extra.id}`)).status, 404);
});

test('limits: tool rounds are capped, the daily limit holds, long messages are refused', async () => {
  const r = await rina.post('/api/assistant/conversations', { message: 'loop forever please' });
  assert.equal(r.status, 201);
  const reqs = llm.requests.filter((x) => JSON.stringify(x.body.messages).includes('loop forever'));
  assert.ok(reqs.length <= 6, `${reqs.length} model calls`);
  assert.equal(reqs.at(-1).body.tools, undefined, 'last round without tools forces an answer');

  assert.equal((await rina.post('/api/assistant/conversations', { message: 'x'.repeat(2001) })).status, 400);
  let status = 201;
  for (let i = 0; i < 12 && status !== 429; i += 1) status = (await rina.post('/api/assistant/conversations', { message: `my tickets ${i}` })).status;
  assert.equal(status, 429);
  assert.equal((await rina.get('/api/assistant')).json.usedToday, 12);
});

test('provider errors become a friendly message and are logged', async () => {
  const bob = await stack.customerWith('carla@example.com');
  llm.setDown(true);
  const r = await bob.post('/api/assistant/conversations', { message: 'help with backups' });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /not available right now/);
  llm.setDown(false);
  const log = (await admin.get('/api/admin/activity?q=ai_error')).json.events;
  assert.ok(log.length >= 1);
});

test('OpenAI-compatible API (e.g. a local model) works the same way', async () => {
  await admin.put('/api/admin/settings/ai', { provider: 'openai', baseUrl: `${llm.url}/v1`, model: 'llama-3.3-70b' });
  const dana = await stack.customerWith('dana@example.com');
  const r = (await dana.post('/api/assistant/conversations', { message: 'Website unreachable after reboot?' })).json;
  assert.match(r.messages.at(-1).content, /Server unreachable after a reboot/);
  const req = llm.requests.filter((x) => x.api === 'openai').at(-1);
  assert.equal(req.headers.authorization, `Bearer ${llm.apiKey}`);
  assert.equal(req.body.messages[0].role, 'system');
  assert.equal(req.body.messages.at(-1).role, 'tool');
  assert.ok(req.body.tools.every((t) => t.type === 'function'));
});

test('admins review conversations with the tool calls; agents cannot change the settings', async () => {
  const o = (await admin.get('/api/admin/ai')).json;
  assert.ok(o.totals.conversations >= 4);
  assert.ok(o.totals.handovers >= 1);
  assert.equal(o.totals.helpful, 1);
  assert.equal(o.settings.hasKey, true);
  const c = (await admin.get(`/api/admin/ai/conversations/${conv}`)).json;
  assert.ok(c.messages.some((m) => m.role === 'tool' && m.toolName === 'search_help_center'));
  assert.equal(c.email, 'rina@example.com');

  const a = await admin.post('/api/admin/users', { email: 'agent@example.com', password: 'agent-password-123', isAdmin: true });
  const role = (await admin.get('/api/admin/rbac')).json.roles.find((r) => r.key === 'agent').id;
  await admin.put(`/api/admin/rbac/admins/${a.json.id}`, { roleId: role });
  const agent = stack.admin();
  await agent.post('/api/auth/login', { email: 'agent@example.com', password: 'agent-password-123' });
  assert.equal((await agent.get('/api/admin/ai')).status, 200);
  assert.equal((await agent.put('/api/admin/settings/ai', { enabled: false })).status, 403);
});
