// Chat with a language model, with tools, over one of two APIs:
//   anthropic  Claude Messages API (POST {base}/v1/messages, x-api-key, anthropic-version)
//   openai     any OpenAI-compatible Chat Completions API (POST {base}/chat/completions),
//              e.g. OpenAI, or a local model through vLLM, Ollama or LM Studio
//
// Messages use one neutral shape, converted here:
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, input }] }
//   { role: 'tool', toolCallId, name, content }
// Returns { text, toolCalls, usage: { input, output }, stop }.

export const ANTHROPIC_VERSION = '2023-06-01';

export class ProviderError extends Error {
  constructor(message, status = 502) { super(message); this.statusCode = status; this.expose = true; }
}

async function post(url, headers, body, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`The AI provider can't be reached (${err.cause?.code ?? err.name})`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.error ?? text.slice(0, 200);
    throw new ProviderError(`The AI provider answered ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status === 429 ? 503 : 502);
  }
  return data;
}

// ---- Claude (Anthropic Messages API) --------------------------------------------------------

function toAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      // results of one turn go together in one user message
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

async function anthropic({ baseUrl, apiKey, model, system, messages, tools, maxTokens, timeoutMs }) {
  const data = await post(`${(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
    'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION,
  }, {
    model, max_tokens: maxTokens, system, messages: toAnthropic(messages),
    ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), tool_choice: { type: 'auto' } } : {}),
  }, timeoutMs);
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
    usage: { input: data?.usage?.input_tokens ?? 0, output: data?.usage?.output_tokens ?? 0 },
    stop: data?.stop_reason ?? null,
  };
}

// ---- OpenAI-compatible Chat Completions ---------------------------------------------------------

function toOpenAi(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant', content: m.content || null,
        ...(m.toolCalls?.length ? {
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })),
        } : {}),
      });
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

async function openai({ baseUrl, apiKey, model, system, messages, tools, maxTokens, timeoutMs }) {
  if (!baseUrl) throw new ProviderError('Set the address of the OpenAI-compatible API (e.g. https://api.openai.com/v1)', 400);
  const data = await post(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, {
    model, max_tokens: maxTokens, messages: toOpenAi(system, messages),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' } : {}),
  }, timeoutMs);
  const msg = data?.choices?.[0]?.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((c) => {
    let input = {};
    try { input = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function?.arguments ?? {}); } catch { input = {}; }
    return { id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.function?.name, input };
  });
  return {
    text: String(msg.content ?? '').trim(), toolCalls,
    usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 },
    stop: data?.choices?.[0]?.finish_reason ?? null,
  };
}

export function chat(opts) {
  const o = { maxTokens: 1024, timeoutMs: 60_000, tools: [], ...opts };
  return o.provider === 'openai' ? openai(o) : anthropic(o);
}
