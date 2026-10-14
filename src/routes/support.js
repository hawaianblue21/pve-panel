// Customer portal: support tickets and the help center (knowledge base).
// The help center also works before sign-in, with the public articles only.

import { db } from '../db.js';
import * as support from '../support.js';
import * as kb from '../kb.js';
import { zammadWebhook } from '../zammad.js';

const NUMBER = { type: 'object', required: ['number'], properties: { number: { type: 'integer', minimum: 1 } } };

export default async function supportRoutes(app) {
  // Keep the raw JSON for the Zammad webhook signature (this plugin's routes only)
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, body ? JSON.parse(body) : {}); } catch (err) { err.statusCode = 400; done(err); }
  });

  /** Signed-in customer, or null (help center pages work without). */
  async function viewer(req) {
    try {
      await req.jwtVerify();
      if (req.user.scope !== 'customer') return null;
      const u = db.prepare('SELECT id, deleting FROM users WHERE id = ?').get(req.user.sub);
      return u && !u.deleting ? u : null;
    } catch { return null; }
  }
  const scopeOf = async (req) => ((await viewer(req)) ? 'customers' : 'public');

  // ---- Help center ----------------------------------------------------------------
  app.get('/api/kb', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 }, log: { type: 'string', enum: ['0', '1'] } } } },
  }, async (req) => {
    const scope = await scopeOf(req);
    if (req.query.q) return { results: kb.search(req.query.q, { scope, log: req.query.log === '1' }) };
    return { categories: kb.overview(scope) };
  });

  app.get('/api/kb/:slug', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => kb.read(req.params.slug, await scopeOf(req)));

  app.post('/api/kb/:slug/feedback', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['helpful'], additionalProperties: false, properties: { helpful: { type: 'boolean' } } } },
  }, async (req) => {
    kb.feedback(req.params.slug, req.body.helpful, await scopeOf(req));
    return { ok: true };
  });

  // ---- Tickets ----------------------------------------------------------------------
  const auth = { preHandler: app.authenticate };

  app.get('/api/support/tickets', auth, async (req) => ({
    tickets: support.listForCustomer(req.account.id),
    waiting: support.waitingCount(req.account.id),
  }));

  app.post('/api/support/tickets', {
    ...auth,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object', required: ['subject', 'body'], additionalProperties: false,
        properties: {
          subject: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 12_000 },
          category: { type: 'string', enum: support.CATEGORIES }, priority: { type: 'string', enum: support.PRIORITIES },
          vmid: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(await support.createTicket(req, req.body)));

  app.get('/api/support/tickets/:number', { ...auth, schema: { params: NUMBER } },
    async (req) => support.getForCustomer(req.account.id, req.params.number));

  app.post('/api/support/tickets/:number/messages', {
    ...auth,
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    schema: { params: NUMBER, body: { type: 'object', required: ['body'], additionalProperties: false, properties: { body: { type: 'string', maxLength: 12_000 } } } },
  }, async (req) => support.customerReply(req, req.params.number, req.body.body));

  app.post('/api/support/tickets/:number/close', { ...auth, schema: { params: NUMBER } },
    async (req) => support.customerClose(req, req.params.number));

  // ---- Zammad → panel (optional sync; checked by its HMAC signature) ---------------------
  app.post('/api/support/zammad/webhook', {
    bodyLimit: 1024 * 1024,
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, zammadWebhook);
}
