// Admin: importing OS images as Proxmox templates (owners, or a role with templates.write).
import {
  importOptions, startImport, retryImport, removeImport, listImports, startInstallVm, finishInstall, cancelInstall,
} from '../imports.js';
import { createUpload, uploadStatus, appendChunk, removeUpload } from '../uploads.js';
import { audit } from '../db.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const name = { type: 'string', maxLength: 63 };

export default async function adminImportRoutes(app) {
  app.get('/api/admin/templates/imports', async () => ({ imports: listImports() }));
  app.get('/api/admin/templates/import-options', async () => importOptions());

  app.post('/api/admin/templates/imports', {
    config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object', required: ['name', 'format', 'targets'], additionalProperties: false,
        properties: {
          name, label: { type: 'string', maxLength: 80 }, format: { type: 'string', enum: ['qcow2', 'ova', 'iso', 'vmdk'] }, uploadId: { type: 'string', maxLength: 40 }, diskGb: { type: 'integer' }, virtio: { type: 'boolean' },
          url: { type: 'string', maxLength: 2000 }, checksum: { type: ['string', 'null'], maxLength: 64 },
          setup: { type: 'string', enum: ['cloudinit', 'windows'] }, cloudinit: { type: 'boolean' }, testBoot: { type: 'boolean' },
          cores: { type: 'integer' }, memoryMb: { type: 'integer' }, bridge: { type: 'string', maxLength: 15 },
          targets: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object', required: ['node', 'storage', 'importStorage'], additionalProperties: false,
              properties: { clusterId: { type: 'integer', minimum: 0 }, node: name, storage: name, importStorage: name },
            },
          },
        },
      },
    },
  }, async (req, reply) => reply.code(202).send(startImport(req, req.body)));

  // disk images uploaded from the browser, in chunks (resumable)
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
  const upId = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{24}$' } } };
  app.post('/api/admin/templates/uploads', {
    schema: { body: { type: 'object', required: ['filename', 'size'], additionalProperties: false, properties: { filename: { type: 'string', maxLength: 200 }, size: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => reply.code(201).send(await createUpload(req, req.body)));
  app.get('/api/admin/templates/uploads/:id', { schema: { params: upId } }, async (req) => uploadStatus(req.params.id));
  app.put('/api/admin/templates/uploads/:id', {
    schema: { params: upId, querystring: { type: 'object', required: ['offset'], properties: { offset: { type: 'integer', minimum: 0 } } } },
  }, async (req, reply) => {
    if (!req.headers['content-type']?.startsWith('application/octet-stream')) return reply.code(415).send({ error: 'Send the chunk as application/octet-stream' });
    try {
      return await appendChunk(req.params.id, req.query.offset, req.body);
    } catch (err) {
      if (err.received !== undefined) return reply.code(409).send({ error: err.message, received: err.received });
      throw err;
    }
  });
  app.delete('/api/admin/templates/uploads/:id', { schema: { params: upId } }, async (req) => {
    uploadStatus(req.params.id);
    await removeUpload(req.params.id);
    audit(req, null, 'admin_template_upload_removed', { id: req.params.id });
    return { removed: true };
  });

  app.post('/api/admin/templates/imports/:id/retry', { schema: { params: id } }, async (req, reply) => reply.code(202).send(retryImport(req, req.params.id)));
  // ISO installs: start the VM, the installation is done, or give up
  app.post('/api/admin/templates/imports/:id/start', { schema: { params: id } }, async (req) => startInstallVm(req, req.params.id));
  app.post('/api/admin/templates/imports/:id/installed', { schema: { params: id } }, async (req, reply) => reply.code(202).send(await finishInstall(req, req.params.id)));
  app.post('/api/admin/templates/imports/:id/cancel', { schema: { params: id } }, async (req) => cancelInstall(req, req.params.id));
  app.delete('/api/admin/templates/imports/:id', { schema: { params: id } }, async (req) => removeImport(req, req.params.id));
}
