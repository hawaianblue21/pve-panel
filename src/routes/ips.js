// Customer public addresses: IPv4 per server, its optional IPv6 /64, reverse DNS for both.
import { serverIps, assignIp, releaseIp, setPtr, setIpv6 } from '../ipam.js';

const vm = { type: 'object', required: ['vmid'], properties: { vmid: { type: 'integer', minimum: 1 } } };
const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export default async function ipRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/vms/:vmid/ips', { schema: { params: vm } }, async (req) => serverIps(req.account, req.params.vmid));

  app.post('/api/vms/:vmid/ips', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { params: vm } },
    async (req, reply) => reply.code(201).send(await assignIp(req, req.params.vmid)));

  app.delete('/api/ips/:id', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { params: id } },
    async (req) => releaseIp(req, req.params.id));

  app.put('/api/ips/:id/ptr', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { params: id, body: { type: 'object', required: ['hostname'], additionalProperties: false, properties: { hostname: { type: 'string', maxLength: 253 }, family: { type: 'integer', enum: [4, 6] } } } },
  }, async (req) => setPtr(req, req.params.id, req.body.hostname, req.body.family ?? 4));

  app.put('/api/ips/:id/ipv6', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { params: id, body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
  }, async (req) => setIpv6(req, req.params.id, req.body.enabled));
}
