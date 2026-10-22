// Admin: importing OS images as Proxmox templates (owners, or a role with templates.write).
import {
  importOptions, startImport, retryImport, removeImport, listImports, startInstallVm, finishInstall, cancelInstall,
} from '../imports.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const name = { type: 'string', maxLength: 63 };

export default async function adminImportRoutes(app) {
  app.get('/api/admin/templates/imports', async () => ({ imports: listImports() }));
  app.get('/api/admin/templates/import-options', async () => importOptions());

  app.post('/api/admin/templates/imports', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object', required: ['name', 'format', 'url', 'targets'], additionalProperties: false,
        properties: {
          name, label: { type: 'string', maxLength: 80 }, format: { type: 'string', enum: ['qcow2', 'ova', 'iso'] }, diskGb: { type: 'integer' }, virtio: { type: 'boolean' },
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

  app.post('/api/admin/templates/imports/:id/retry', { schema: { params: id } }, async (req, reply) => reply.code(202).send(retryImport(req, req.params.id)));
  // ISO installs: start the VM, the installation is done, or give up
  app.post('/api/admin/templates/imports/:id/start', { schema: { params: id } }, async (req) => startInstallVm(req, req.params.id));
  app.post('/api/admin/templates/imports/:id/installed', { schema: { params: id } }, async (req, reply) => reply.code(202).send(await finishInstall(req, req.params.id)));
  app.post('/api/admin/templates/imports/:id/cancel', { schema: { params: id } }, async (req) => cancelInstall(req, req.params.id));
  app.delete('/api/admin/templates/imports/:id', { schema: { params: id } }, async (req) => removeImport(req, req.params.id));
}
