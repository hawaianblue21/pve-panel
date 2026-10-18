// Admin: background jobs, the update fleet and update rollouts.
import { jobs, fleet, listRollouts, getRollout, createRollout, controlRollout } from '../rollouts.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export default async function adminJobRoutes(app) {
  app.get('/api/admin/jobs', {
    schema: { querystring: { type: 'object', properties: { filter: { type: 'string', enum: ['all', 'running', 'failed', 'done'] } } } },
  }, async (req) => jobs({ filter: req.query.filter ?? 'all' }));

  app.get('/api/admin/updates/fleet', async () => fleet());
  app.get('/api/admin/updates/rollouts', async () => ({ rollouts: listRollouts() }));
  app.get('/api/admin/updates/rollouts/:id', { schema: { params: id } }, async (req) => getRollout(req.params.id));
  app.post('/api/admin/updates/rollouts', {
    schema: {
      body: {
        type: 'object', required: ['name', 'vmids'], additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 80 }, vmids: { type: 'array', maxItems: 1000, items: { type: 'integer', minimum: 1 } },
          rings: { type: 'array', maxItems: 5, items: { type: 'integer' } }, scope: { type: 'string', enum: ['security', 'all'] },
          snapshot: { type: 'boolean' }, autoRestart: { type: 'boolean' }, maxFailPct: { type: 'integer' },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(createRollout(req, req.body)));
  app.post('/api/admin/updates/rollouts/:id/:action', {
    schema: { params: { type: 'object', required: ['id', 'action'], properties: { id: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['pause', 'resume', 'cancel'] } } } },
  }, async (req) => controlRollout(req, req.params.id, req.params.action));
}
