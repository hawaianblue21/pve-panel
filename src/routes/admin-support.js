// Admin portal: ticket desk, knowledge-base editor and the Zammad settings.
// Registered inside adminRoutes, so the admin sign-in and RBAC checks apply.

import { audit } from '../db.js';
import { config } from '../config.js';
import * as support from '../support.js';
import * as kb from '../kb.js';
import { zammadSettings, saveZammad, testZammad, retryPending } from '../zammad.js';
import * as ai from '../ai.js';

const NUMBER = { type: 'object', required: ['number'], properties: { number: { type: 'integer', minimum: 1 } } };
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const ARTICLE = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 200 }, category: { type: 'string', maxLength: 60 }, body: { type: 'string', maxLength: 100_000 },
    visibility: { type: 'string', enum: kb.VISIBILITY }, status: { type: 'string', enum: ['draft', 'published'] },
  },
};

export default async function adminSupportRoutes(app) {
  // ---- Tickets ---------------------------------------------------------------------
  app.get('/api/admin/support/tickets', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['active', ...support.STATUSES] }, queue: { type: 'string', enum: support.QUEUES },
          q: { type: 'string', maxLength: 100 }, mine: { type: 'string', enum: ['1'] },
        },
      },
    },
  }, async (req) => support.adminList({ ...req.query, mine: req.query.mine ? req.account.id : null }));

  app.get('/api/admin/support/tickets/:number', { schema: { params: NUMBER } }, async (req) => support.adminGet(req.params.number));

  app.post('/api/admin/support/tickets/:number/messages', {
    schema: {
      params: NUMBER,
      body: {
        type: 'object', required: ['body'], additionalProperties: false,
        properties: { body: { type: 'string', maxLength: 20_000 }, internal: { type: 'boolean' }, status: { type: 'string', enum: support.STATUSES } },
      },
    },
  }, async (req) => support.agentReply(req, req.params.number, req.body));

  app.patch('/api/admin/support/tickets/:number', {
    schema: {
      params: NUMBER,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          status: { type: 'string', enum: support.STATUSES }, priority: { type: 'string', enum: support.PRIORITIES },
          queue: { type: 'string', enum: support.QUEUES }, assigneeId: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  }, async (req) => support.updateTicket(req, req.params.number, req.body));

  app.post('/api/admin/support/tickets/:number/kb-draft', { schema: { params: NUMBER } },
    async (req, reply) => reply.code(201).send(support.draftFromTicket(req, req.params.number)));

  // ---- Knowledge base ----------------------------------------------------------------
  app.get('/api/admin/kb', async () => ({ articles: kb.listAll(), stats: kb.stats(), gaps: kb.gaps() }));
  app.get('/api/admin/kb/:id', { schema: { params: ID } }, async (req) => kb.getById(req.params.id));
  app.get('/api/admin/kb-search', {
    schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 200 } } } },
  }, async (req) => ({ results: kb.search(req.query.q, { scope: 'agents' }) }));

  app.post('/api/admin/kb', { schema: { body: { ...ARTICLE, required: ['title'] } } }, async (req, reply) => {
    const a = kb.create(req.body, req.account.id);
    audit(req, null, 'admin_kb_create', { id: a.id, title: a.title, status: a.status });
    return reply.code(201).send(a);
  });
  app.put('/api/admin/kb/:id', { schema: { params: ID, body: ARTICLE } }, async (req) => {
    const a = kb.update(req.params.id, req.body, req.account.id);
    audit(req, null, 'admin_kb_update', { id: a.id, title: a.title, status: a.status, visibility: a.visibility });
    return a;
  });
  app.delete('/api/admin/kb/:id', { schema: { params: ID } }, async (req, reply) => {
    kb.remove(req.params.id);
    audit(req, null, 'admin_kb_delete', { id: req.params.id });
    return reply.code(204).send();
  });

  // ---- AI assistant -------------------------------------------------------------------
  app.get('/api/admin/ai', async () => ({ settings: ai.aiSettings(), ...ai.adminOverview() }));
  app.get('/api/admin/ai/conversations/:id', { schema: { params: ID } }, async (req) => ai.adminConversation(req.params.id));
  app.get('/api/admin/settings/ai', async () => ai.aiSettings());
  app.put('/api/admin/settings/ai', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          enabled: { type: 'boolean' }, provider: { type: 'string', enum: ['anthropic', 'openai'] },
          baseUrl: { type: 'string', maxLength: 300 }, model: { type: 'string', maxLength: 100 }, apiKey: { type: 'string', maxLength: 500 },
          dailyLimit: { type: 'integer' }, maxTokens: { type: 'integer' }, instructions: { type: 'string', maxLength: 4000 }, handover: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const saved = ai.saveAiSettings(req.body);
    const { apiKey, ...rest } = req.body;
    audit(req, null, 'admin_ai_settings', { ...rest, keyChanged: apiKey !== undefined });
    return saved;
  });
  app.post('/api/admin/settings/ai/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => ai.testAssistant());

  // ---- Zammad (optional) ---------------------------------------------------------------
  app.get('/api/admin/settings/zammad', async () => zammadSettings(config.oidc.publicUrl.customer || null));
  app.put('/api/admin/settings/zammad', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          enabled: { type: 'boolean' }, url: { type: 'string', maxLength: 300 }, token: { type: 'string', maxLength: 300 },
          groups: { type: 'object', additionalProperties: false, properties: { L1: { type: 'string' }, L2: { type: 'string' }, L3: { type: 'string' } } },
          newSecret: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    saveZammad(req.body);
    const { token, ...rest } = req.body;
    audit(req, null, 'admin_zammad_settings', { ...rest, tokenChanged: !!token });
    return zammadSettings(config.oidc.publicUrl.customer || null);
  });
  app.post('/api/admin/settings/zammad/test', async () => testZammad());
  app.post('/api/admin/settings/zammad/retry', async () => retryPending());
}
