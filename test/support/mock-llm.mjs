// Simulated language model for tests, speaking both the Claude Messages API
// (POST /v1/messages) and the OpenAI-compatible Chat Completions API
// (POST /v1/chat/completions). It picks a tool from keywords in the question,
// then answers with what the tool returned. Every request is recorded.
import http from 'node:http';

export async function startMockLlm({ apiKey = 'test-key' } = {}) {
  const requests = [];
  let down = false;
  let n = 0;

  // neutral view of the conversation, whichever API was used
  function lastTurn(body, api) {
    const msgs = body.messages;
    const last = msgs[msgs.length - 1];
    if (api === 'anthropic') {
      if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') return { toolResults: last.content.map((b) => String(b.content)) };
      return { question: typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? '').join(' ') };
    }
    if (last.role === 'tool') {
      const results = [];
      for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'tool'; i -= 1) results.unshift(String(msgs[i].content));
      return { toolResults: results };
    }
    return { question: String(last.content) };
  }
  const firstQuestion = (body) => {
    const users = body.messages.filter((m) => m.role === 'user' && (typeof m.content === 'string'));
    return String(users[users.length - 1]?.content ?? '');
  };

  function decide(body, api) {
    const turn = lastTurn(body, api);
    const q = firstQuestion(body).toLowerCase();
    if (turn.toolResults) {
      if (/loop forever/.test(q) && body.tools?.length) return { tool: ['search_help_center', { query: 'loop' }] };
      return { text: `Here is what I found: ${turn.toolResults.join(' | ').slice(0, 600)}` };
    }
    if (!body.tools?.length) return { text: 'Hello from the model.' };
    if (/loop forever/.test(q)) return { tool: ['search_help_center', { query: 'loop' }] };
    if (/person|human|hacked/.test(q)) {
      return { tool: ['propose_ticket', { subject: 'Server may be hacked', summary: 'Customer sees unknown processes on server 101.', category: 'security', priority: 'urgent', vmid: 101 }] };
    }
    const vm = /server (\d+)/.exec(q);
    if (vm) return { tool: ['get_server', { vmid: Number(vm[1]) }] };
    if (/my servers/.test(q)) return { tool: ['list_my_servers', {}] };
    if (/tickets/.test(q)) return { tool: ['list_my_tickets', {}] };
    return { tool: ['search_help_center', { query: q.replace(/[?!.]/g, '') }] };
  }

  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const api = req.url.endsWith('/v1/messages') ? 'anthropic' : req.url.endsWith('/chat/completions') ? 'openai' : null;
      requests.push({ api, url: req.url, headers: req.headers, body });
      const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (down) return send(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
      if (!api) return send(404, { error: 'not found' });
      if (api === 'anthropic' && (req.headers['x-api-key'] !== apiKey || req.headers['anthropic-version'] !== '2023-06-01')) {
        return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      if (api === 'openai' && req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: { message: 'Incorrect API key' } });
      const d = decide(body, api);
      n += 1;
      const id = `call_${n}`;
      if (api === 'anthropic') {
        return send(200, {
          id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model,
          content: d.tool ? [{ type: 'tool_use', id, name: d.tool[0], input: d.tool[1] }] : [{ type: 'text', text: d.text }],
          stop_reason: d.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 120, output_tokens: 30 },
        });
      }
      return send(200, {
        id: `chatcmpl_${n}`, object: 'chat.completion', model: body.model,
        choices: [{ index: 0, finish_reason: d.tool ? 'tool_calls' : 'stop', message: d.tool
          ? { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: d.tool[0], arguments: JSON.stringify(d.tool[1]) } }] }
          : { role: 'assistant', content: d.text } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url, apiKey, requests,
    setDown(v) { down = v; },
    close: () => new Promise((r) => srv.close(r)),
  };
}
