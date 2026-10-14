// Customer block storage: volumes to create, attach, detach, move, enlarge and delete.
import {
  customerVolumes, createVolume, attachVolume, detachVolume, resizeVolume, renameVolume, deleteVolume,
} from '../volumes.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const limited = { rateLimit: { max: 30, timeWindow: '10 minutes' } };

export default async function volumeRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/volumes', async (req) => customerVolumes(req.account));

  app.post('/api/volumes', {
    config: limited,
    schema: {
      body: {
        type: 'object', required: ['label', 'tier', 'sizeGb', 'vmid'], additionalProperties: false,
        properties: {
          label: { type: 'string', maxLength: 40 }, tier: { type: 'string', maxLength: 20 },
          sizeGb: { type: 'integer', minimum: 1 }, vmid: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(await createVolume(req, req.body)));

  app.post('/api/volumes/:id/attach', {
    config: limited,
    schema: { params: id, body: { type: 'object', required: ['vmid'], additionalProperties: false, properties: { vmid: { type: 'integer', minimum: 1 } } } },
  }, async (req) => attachVolume(req, req.params.id, req.body.vmid));

  app.post('/api/volumes/:id/detach', { config: limited, schema: { params: id } }, async (req) => detachVolume(req, req.params.id));

  app.post('/api/volumes/:id/resize', {
    config: limited,
    schema: { params: id, body: { type: 'object', required: ['sizeGb'], additionalProperties: false, properties: { sizeGb: { type: 'integer', minimum: 1 } } } },
  }, async (req) => resizeVolume(req, req.params.id, req.body.sizeGb));

  app.patch('/api/volumes/:id', {
    schema: { params: id, body: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { type: 'string', maxLength: 40 } } } },
  }, async (req) => renameVolume(req, req.params.id, req.body.label));

  app.delete('/api/volumes/:id', { config: limited, schema: { params: id } }, async (req) => deleteVolume(req, req.params.id));
}
