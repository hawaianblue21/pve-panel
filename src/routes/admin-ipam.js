// Admin: public IPv4 pools (optionally with an IPv6 prefix), their addresses, and IPAM settings (incl. PowerDNS).
import { audit } from '../db.js';
import {
  listIpPools, createIpPool, updateIpPool, deleteIpPool, poolAddresses, setAddressState, ipamSettings, saveIpamSettings,
} from '../ipam.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const poolBody = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 60 }, cidr: { type: 'string', maxLength: 20 }, gateway: { type: 'string', maxLength: 15 },
    bridge: { type: 'string', maxLength: 16 }, vlan: { type: ['integer', 'null'] }, dns: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 15 } },
    datacenterId: { type: ['integer', 'null'] }, priceMonthly: { type: 'integer' }, reverseZone: { type: 'string', maxLength: 80 },
    ipv6Cidr: { type: 'string', maxLength: 50 }, ipv6Gateway: { type: 'string', maxLength: 45 }, ipv6ReverseZone: { type: 'string', maxLength: 80 },
    ipv6PriceMonthly: { type: 'integer' },
  },
};

export default async function adminIpamRoutes(app) {
  app.get('/api/admin/ipam', async () => ({ pools: listIpPools(), settings: ipamSettings() }));
  app.post('/api/admin/ipam/pools', { schema: { body: { ...poolBody, required: ['name', 'cidr', 'gateway', 'bridge'] } } },
    async (req, reply) => reply.code(201).send(createIpPool(req, req.body)));
  app.put('/api/admin/ipam/pools/:id', { schema: { params: id, body: poolBody } }, async (req) => updateIpPool(req, req.params.id, req.body));
  app.delete('/api/admin/ipam/pools/:id', { schema: { params: id } }, async (req) => deleteIpPool(req, req.params.id));
  app.get('/api/admin/ipam/pools/:id/addresses', {
    schema: { params: id, querystring: { type: 'object', properties: { state: { type: 'string', enum: ['', 'free', 'assigned', 'reserved', 'cooldown', 'held'] }, q: { type: 'string', maxLength: 100 } } } },
  }, async (req) => poolAddresses(req.params.id, req.query));
  app.put('/api/admin/ipam/addresses/:id', {
    schema: { params: id, body: { type: 'object', required: ['state'], additionalProperties: false, properties: { state: { type: 'string', enum: ['free', 'reserved'] }, note: { type: 'string', maxLength: 200 } } } },
  }, async (req) => setAddressState(req, req.params.id, req.body));

  app.get('/api/admin/settings/ipam', async () => ipamSettings());
  app.put('/api/admin/settings/ipam', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' }, ipv6Enabled: { type: 'boolean' }, maxPerServer: { type: 'integer' }, cooldownHours: { type: 'integer' },
          powerdns: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', maxLength: 300 }, apiKey: { type: 'string', maxLength: 300 }, serverId: { type: 'string', maxLength: 64 } } },
        },
      },
    },
  }, async (req) => {
    const saved = saveIpamSettings(req.body);
    audit(req, null, 'admin_ipam_settings', { ...req.body, powerdns: req.body.powerdns ? { ...req.body.powerdns, apiKey: req.body.powerdns.apiKey ? '(changed)' : undefined } : undefined });
    return saved;
  });
}
