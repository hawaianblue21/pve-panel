// Admin: backups on Proxmox Backup Server: settings, backup servers (owners),
// policies and which plan uses which.
import {
  backupOverview, saveBackupSettings, testPbs, addPbs, updatePbs, removePbs, exportKey,
  createPolicy, updatePolicy, deletePolicy, setPlanPolicy,
} from '../backups.js';
import { audit } from '../db.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const conn = {
  name: { type: 'string', maxLength: 31 }, url: { type: 'string', maxLength: 300 }, tokenId: { type: 'string', maxLength: 200 },
  tokenSecret: { type: 'string', maxLength: 300 }, fingerprint: { type: ['string', 'null'], maxLength: 120 },
  datastore: { type: 'string', maxLength: 32 }, clusters: { type: 'array', maxItems: 50, items: { type: 'integer', minimum: 0 } },
};
const policy = {
  name: { type: 'string', maxLength: 60 }, frequency: { type: 'string', enum: ['daily', 'weekly'] }, weekday: { type: ['integer', 'null'] },
  keepDaily: { type: 'integer' }, keepWeekly: { type: 'integer' }, keepMonthly: { type: 'integer' }, addonPrice: { type: ['integer', 'null'] },
};

export default async function adminBackupRoutes(app) {
  app.get('/api/admin/backups', async () => backupOverview());

  app.put('/api/admin/backups/settings', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          enabled: { type: 'boolean' }, encrypt: { type: 'boolean' }, windowStart: { type: 'integer' }, windowEnd: { type: 'integer' },
          parallelPerNode: { type: 'integer' }, bwlimitMBs: { type: 'integer' }, manualPerDay: { type: 'integer' },
          keepAfterDeleteDays: { type: 'integer' }, defaultPolicyId: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req) => {
    const s = saveBackupSettings(req.body);
    audit(req, null, 'admin_backup_settings', req.body);
    return s;
  });

  // backup servers: owners only (like Proxmox clusters)
  app.post('/api/admin/backups/servers/test', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, properties: { ...conn, id: { type: 'integer' } } } },
  }, async (req) => testPbs(req.body, { existingId: req.body.id ?? null }));
  app.post('/api/admin/backups/servers', {
    schema: { body: { type: 'object', required: ['name', 'url', 'tokenId', 'tokenSecret', 'datastore'], additionalProperties: false, properties: conn } },
  }, async (req, reply) => reply.code(201).send(await addPbs(req, req.body)));
  app.put('/api/admin/backups/servers/:id', {
    schema: { params: id, body: { type: 'object', additionalProperties: false, properties: { clusters: conn.clusters, enabled: { type: 'boolean' }, tokenSecret: conn.tokenSecret } } },
  }, async (req) => updatePbs(req, req.params.id, req.body));
  app.delete('/api/admin/backups/servers/:id', { schema: { params: id } }, async (req) => removePbs(req, req.params.id));

  // a customer's encryption key, to keep somewhere safe (owners)
  app.get('/api/admin/backups/keys/:userId', {
    schema: { params: { type: 'object', required: ['userId'], properties: { userId: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => { reply.header('Cache-Control', 'no-store'); return exportKey(req, req.params.userId); });

  app.post('/api/admin/backups/policies', {
    schema: { body: { type: 'object', required: ['name', 'frequency'], additionalProperties: false, properties: policy } },
  }, async (req, reply) => reply.code(201).send(createPolicy(req, req.body)));
  app.put('/api/admin/backups/policies/:id', {
    schema: { params: id, body: { type: 'object', additionalProperties: false, properties: policy } },
  }, async (req) => updatePolicy(req, req.params.id, req.body));
  app.delete('/api/admin/backups/policies/:id', { schema: { params: id } }, async (req) => deletePolicy(req, req.params.id));

  app.put('/api/admin/backups/plans/:id', {
    schema: { params: id, body: { type: 'object', required: ['policyId'], additionalProperties: false, properties: { policyId: { type: ['integer', 'null'] } } } },
  }, async (req) => setPlanPolicy(req, req.params.id, req.body.policyId));
}
