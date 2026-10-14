// Admin: the overview dashboard and the Proxmox nodes (Hosts tab).
import { permissionsOf } from '../rbac.js';
import { dashboard, hostsOverview, setMaintenance } from '../hosts.js';

export default async function adminHostRoutes(app) {
  // what each administrator sees depends on their permissions (checked inside)
  app.get('/api/admin/dashboard', async (req) => dashboard(permissionsOf(req.account)));

  app.get('/api/admin/hosts', async () => hostsOverview());

  app.put('/api/admin/hosts/:node/maintenance', {
    schema: {
      params: { type: 'object', properties: { node: { type: 'string', maxLength: 63 } } },
      body: { type: 'object', required: ['maintenance'], additionalProperties: false, properties: { maintenance: { type: 'boolean' }, note: { type: 'string', maxLength: 200 } } },
    },
  }, async (req) => setMaintenance(req, req.params.node, req.body));
}
