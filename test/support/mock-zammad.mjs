// Simulated Zammad REST API (the parts the panel uses), for tests.
// Records every call; `down` makes every call fail with 503.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startMockZammad({ token = 'zammad-token' } = {}) {
  const state = { tickets: new Map(), articles: [], calls: [], down: false, nextTicket: 50, nextArticle: 500 };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = (req) => new Promise((r) => { let x = ''; req.on('data', (c) => { x += c; }); req.on('end', () => r(x ? JSON.parse(x) : null)); });

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = await read(req);
    state.calls.push({ method: req.method, path: u.pathname, body, onBehalfOf: req.headers['x-on-behalf-of'] ?? null });
    if (state.down) return json(res, 503, { error: 'maintenance' });
    if (req.headers.authorization !== `Token token=${token}`) return json(res, 401, { error: 'authentication failed' });
    if (u.pathname === '/api/v1/users/me') return json(res, 200, { id: 3, email: 'panel-bot@example.com' });
    if (u.pathname === '/api/v1/groups') return json(res, 200, [{ id: 1, name: 'Users' }, { id: 2, name: 'L2 Network' }, { id: 3, name: 'L3 Security' }]);
    if (req.method === 'POST' && u.pathname === '/api/v1/tickets') {
      const id = state.nextTicket++;
      const t = { id, number: String(90000 + id), title: body.title, group: body.group, customer: body.customer_id, priority: body.priority, state: 'new' };
      state.tickets.set(id, t);
      state.articles.push({ id: state.nextArticle++, ticket_id: id, ...body.article });
      return json(res, 201, t);
    }
    let m = /^\/api\/v1\/ticket_articles\/by_ticket\/(\d+)$/.exec(u.pathname);
    if (m) return json(res, 200, state.articles.filter((a) => a.ticket_id === Number(m[1])));
    if (req.method === 'POST' && u.pathname === '/api/v1/ticket_articles') {
      if (!state.tickets.has(body.ticket_id)) return json(res, 404, { error: 'no ticket' });
      const a = { id: state.nextArticle++, ...body, onBehalfOf: req.headers['x-on-behalf-of'] ?? null };
      state.articles.push(a);
      return json(res, 201, a);
    }
    m = /^\/api\/v1\/tickets\/(\d+)$/.exec(u.pathname);
    if (req.method === 'PUT' && m) {
      const t = state.tickets.get(Number(m[1]));
      if (!t) return json(res, 404, { error: 'no ticket' });
      Object.assign(t, body);
      return json(res, 200, t);
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url, token, state,
    /** What Zammad would POST to the panel's webhook, signed like Zammad does. */
    signedWebhook(secret, payload) {
      const raw = JSON.stringify(payload);
      return { raw, signature: `sha1=${crypto.createHmac('sha1', secret).update(raw).digest('hex')}` };
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}
