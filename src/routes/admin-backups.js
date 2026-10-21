// Admin: backups on Proxmox Backup Server: settings, backup servers (owners),
// policies and which plan uses which; runs, coverage, manual backups and per-server
// overrides (backupjobs.js).
import {
  backupOverview, saveBackupSettings, testPbs, addPbs, updatePbs, removePbs, exportKey,
  createPolicy, updatePolicy, deletePolicy, setPlanPolicy,
} from '../backups.js';
import { listRuns, coverage, backupNow, setServerBackup } from '../backupjobs.js';
import { listRestores } from '../restore.js';
import { audit, db } from '../db.js';

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
  app.get('/api/admin/backups', async () => ({ ...(await backupOverview()), coverage: coverage(), runs: listRuns({ limit: 50 }), restores: listRestores(50) }));

  const vmid = { type: 'object', required: ['vmid'], properties: { vmid: { type: 'integer', minimum: 1 } } };
  app.get('/api/admin/backups/runs', {
    schema: { querystring: { type: 'object', properties: { state: { type: 'string', enum: ['running', 'ok', 'failed'] }, vmid: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } } } },
  }, async (req) => ({ runs: listRuns(req.query) }));
  app.post('/api/admin/backups/run/:vmid', {
    config: { rateLimit: { max: 60, timeWindow: '10 minutes' } }, schema: { params: vmid },
  }, async (req, reply) => {
    const row = db.prepare('SELECT * FROM vms WHERE vmid = ?').get(req.params.vmid);
    if (!row) return reply.code(404).send({ error: 'Server not found' });
    return reply.code(202).send(await backupNow(req, row));
  });
  app.put('/api/admin/backups/vms/:vmid', {
    schema: { params: vmid, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { policyId: { type: ['integer', 'null'] }, excluded: { type: 'boolean' } } } },
  }, async (req) => setServerBackup(req, req.params.vmid, req.body));

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
