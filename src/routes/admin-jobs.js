// Admin: background jobs, the update fleet and update rollouts.
import { jobs, fleet, listRollouts, getRollout, createRollout, controlRollout, retryJob, startChecks } from '../rollouts.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export default async function adminJobRoutes(app) {
  app.get('/api/admin/jobs', {
    schema: { querystring: { type: 'object', properties: { filter: { type: 'string', enum: ['all', 'running', 'failed', 'done'] } } } },
  }, async (req) => jobs({ filter: req.query.filter ?? 'all' }));

  // the permission depends on the job (servers.delete, updates.write, servers.manage): checked inside
  app.post('/api/admin/jobs/retry', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^(vm|run|log)-\\d{1,12}$' } } } },
  }, async (req) => retryJob(req, req.body.id));

  app.get('/api/admin/updates/fleet', async () => fleet());
  app.post('/api/admin/updates/check', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', required: ['vmids'], additionalProperties: false, properties: { vmids: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'integer', minimum: 1 } } } } },
  }, async (req, reply) => reply.code(202).send(startChecks(req, req.body.vmids)));
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
          window: {
            type: ['object', 'null'], additionalProperties: false, required: ['days', 'start', 'end'],
            properties: { days: { type: 'array', maxItems: 7, items: { type: 'integer' } }, start: { type: 'integer' }, end: { type: 'integer' } },
          },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(createRollout(req, req.body)));
  app.post('/api/admin/updates/rollouts/:id/:action', {
    schema: { params: { type: 'object', required: ['id', 'action'], properties: { id: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['pause', 'resume', 'cancel'] } } } },
  }, async (req) => controlRollout(req, req.params.id, req.params.action));
}
