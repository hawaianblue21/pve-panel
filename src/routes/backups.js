// Customer: backups of a server (restore points, a backup of their own, protect, the
// add-on policy, browse and download files, restore as a new server or in place).
import { Readable } from 'node:stream';
import { db } from '../db.js';
import {
  customerBackups, customerBackupNow, setProtected, setAddon, listFiles, downloadFile, restoreInPlace, restoreAsNew,
} from '../restore.js';

const owned = db.prepare('SELECT * FROM vms WHERE vmid = ? AND user_id = ?');
const params = {
  type: 'object', required: ['vmid'],
  properties: { vmid: { type: 'integer', minimum: 100 }, id: { type: 'string', pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ$' } },
};

/** The customer's server, ready (unknown and not-owned are both 404). */
function serverOf(req) {
  const row = owned.get(req.params.vmid, req.account.id);
  if (!row) throw Object.assign(new Error('Server not found'), { statusCode: 404 });
  if (row.state !== 'ready') throw Object.assign(new Error(row.state === 'restoring' ? 'This server is being restored from a backup' : 'This server is busy'), { statusCode: 409 });
  return row;
}

export default async function backupRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/vms/:vmid/backups', { schema: { params } }, async (req) => customerBackups(serverOf(req)));

  app.post('/api/vms/:vmid/backups', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } }, schema: { params },
  }, async (req, reply) => reply.code(202).send(await customerBackupNow(req, serverOf(req))));

  app.put('/api/vms/:vmid/backups/addon', {
    schema: { params, body: { type: 'object', required: ['policyId'], additionalProperties: false, properties: { policyId: { type: ['integer', 'null'] } } } },
  }, async (req) => setAddon(req, serverOf(req), req.body.policyId));

  app.put('/api/vms/:vmid/backups/:id', {
    schema: { params, body: { type: 'object', required: ['protected'], additionalProperties: false, properties: { protected: { type: 'boolean' } } } },
  }, async (req) => setProtected(req, serverOf(req), req.params.id, req.body.protected));

  app.get('/api/vms/:vmid/backups/:id/files', {
    config: { rateLimit: { max: 120, timeWindow: '10 minutes' } },
    schema: { params, querystring: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 } } } },
  }, async (req) => listFiles(serverOf(req), req.params.id, req.query.path ?? '/'));

  app.get('/api/vms/:vmid/backups/:id/download', {
    config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
    schema: { params, querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', maxLength: 1024 }, folder: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const { res, name } = await downloadFile(req, serverOf(req), req.params.id, req.query.path, { folder: !!req.query.folder });
    reply.header('Content-Type', req.query.folder ? 'application/zip' : 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(Readable.fromWeb(res.body));
  });

  app.post('/api/vms/:vmid/backups/:id/restore', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      params,
      body: {
        type: 'object', required: ['mode'], additionalProperties: false,
        properties: { mode: { type: 'string', enum: ['replace', 'new'] }, backupFirst: { type: 'boolean' }, hostname: { type: 'string', maxLength: 63 } },
      },
    },
  }, async (req, reply) => {
    const row = serverOf(req);
    if (req.body.mode === 'replace') return reply.code(202).send(await restoreInPlace(req, row, req.params.id, { backupFirst: !!req.body.backupFirst }));
    return reply.code(202).send(await restoreAsNew(req, row, req.params.id, { hostname: req.body.hostname }));
  });
}
