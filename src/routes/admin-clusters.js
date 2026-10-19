// Admin: Proxmox clusters besides the main one (owners add, change and remove them).
import { listClusters, testCluster, addCluster, updateCluster, removeCluster } from '../clusters.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const conn = {
  url: { type: 'string', maxLength: 300 }, tokenId: { type: 'string', maxLength: 200 }, tokenSecret: { type: 'string', maxLength: 300 },
  verifyTls: { type: 'boolean' }, fingerprint: { type: ['string', 'null'], maxLength: 120 },
};

export default async function adminClusterRoutes(app) {
  app.get('/api/admin/clusters', async () => listClusters());
  app.post('/api/admin/clusters/test', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, properties: { ...conn, id: { type: 'integer' } } } },
  }, async (req) => testCluster(req.body, { existingId: req.body.id ?? null }));
  app.post('/api/admin/clusters', {
    schema: { body: { type: 'object', required: ['key', 'name', 'url', 'tokenId', 'tokenSecret'], additionalProperties: false,
      properties: { key: { type: 'string', maxLength: 31 }, name: { type: 'string', maxLength: 60 }, ...conn } } },
  }, async (req, reply) => reply.code(201).send(await addCluster(req, req.body)));
  app.put('/api/admin/clusters/:id', {
    schema: { params: id, body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 60 }, enabled: { type: 'boolean' }, ...conn } } },
  }, async (req) => updateCluster(req, req.params.id, req.body));
  app.delete('/api/admin/clusters/:id', { schema: { params: id } }, async (req) => removeCluster(req, req.params.id));
}
