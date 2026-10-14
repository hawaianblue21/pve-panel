// Customer portal: the AI assistant.
import * as ai from '../ai.js';

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const ASK = {
  type: 'object', required: ['message'], additionalProperties: false,
  properties: { message: { type: 'string', maxLength: 4000 } },
};

// Per signed-in session, not per IP address (many customers can share one address)
const perSession = (max) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (req) => req.cookies?.panel_session ?? req.ip } });

export default async function assistantRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/assistant', async (req) => ai.status(req.account.id));
  app.get('/api/assistant/conversations', async (req) => ai.listConversations(req.account.id));

  // new conversation with its first question
  app.post('/api/assistant/conversations', {
    config: perSession(20),
    schema: { body: ASK },
  }, async (req, reply) => reply.code(201).send(await ai.ask(req, { message: req.body.message })));

  app.get('/api/assistant/conversations/:id', { schema: { params: ID } }, async (req) => ai.getConversation(req.account.id, req.params.id));

  app.post('/api/assistant/conversations/:id/messages', {
    config: perSession(20),
    schema: { params: ID, body: ASK },
  }, async (req) => ai.ask(req, { conversationId: req.params.id, message: req.body.message }));

  app.delete('/api/assistant/conversations/:id', { schema: { params: ID } }, async (req, reply) => {
    ai.deleteConversation(req.account.id, req.params.id);
    return reply.code(204).send();
  });

  app.post('/api/assistant/messages/:id/rating', {
    schema: { params: ID, body: { type: 'object', required: ['helpful'], additionalProperties: false, properties: { helpful: { type: 'boolean' } } } },
  }, async (req) => { ai.rate(req.account.id, req.params.id, req.body.helpful); return { ok: true }; });

  app.post('/api/assistant/conversations/:id/handover', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    schema: { params: ID, body: { type: 'object', required: ['messageId'], additionalProperties: false, properties: { messageId: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => reply.code(201).send(await ai.handoverToTicket(req, req.params.id, req.body.messageId)));
}
