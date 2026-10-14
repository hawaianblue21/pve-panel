// API tokens: customers manage their own on the customer portal (/api/tokens),
// administrators theirs on the admin portal (/api/admin/tokens; owners see all).
import { CUSTOMER_SCOPES, listTokens, createToken, revokeToken, allAdminTokens, revokeAnyAdminToken } from '../tokens.js';

const id = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const body = (portal) => ({
  type: 'object', required: ['name'], additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 60 },
    days: { type: ['integer', 'null'] },
    ...(portal === 'customer'
      ? { scopes: { type: 'array', maxItems: CUSTOMER_SCOPES.length, items: { type: 'string', enum: CUSTOMER_SCOPES } } }
      : { readOnly: { type: 'boolean' } }),
  },
});

/** Customer portal. */
export async function customerTokenRoutes(app) {
  app.addHook('preHandler', app.authenticate);
  app.get('/api/tokens', async (req) => ({ tokens: listTokens(req.account, 'customer'), scopes: CUSTOMER_SCOPES }));
  app.post('/api/tokens', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { body: body('customer') } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(createToken(req, 'customer', req.body));
  });
  app.delete('/api/tokens/:id', { schema: { params: id } }, async (req) => revokeToken(req, 'customer', req.params.id));
}

/** Admin portal (registered inside the admin routes, so RBAC applies). */
export async function adminTokenRoutes(app) {
  app.get('/api/admin/tokens', async (req) => ({ tokens: listTokens(req.account, 'admin') }));
  app.post('/api/admin/tokens', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { body: body('admin') } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(createToken(req, 'admin', req.body));
  });
  app.delete('/api/admin/tokens/:id', { schema: { params: id } }, async (req) => revokeToken(req, 'admin', req.params.id));
  app.get('/api/admin/tokens/all', async () => ({ tokens: allAdminTokens() }));
  app.delete('/api/admin/tokens/all/:id', { schema: { params: id } }, async (req) => revokeAnyAdminToken(req, req.params.id));
}
