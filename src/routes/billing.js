// Customer portal: billing (wallet, invoices, renewals) and the payment-gateway
// notifications (public, authenticated per gateway in billing.js).
import * as billing from '../billing.js';

const NUMBER = { type: 'object', required: ['number'], properties: { number: { type: 'string', pattern: '^[A-Z0-9]{1,8}-\\d{6}-\\d{4}$' } } };
const VMID = { type: 'object', required: ['vmid'], properties: { vmid: { type: 'integer', minimum: 1 } } };

export default async function billingRoutes(app) {
  // ---- gateway → panel ------------------------------------------------------------------
  for (const gateway of ['xendit', 'midtrans']) {
    app.post(`/api/billing/webhooks/${gateway}`, {
      bodyLimit: 256 * 1024,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    }, async (req, reply) => {
      const r = await billing.webhook(gateway, req);
      return reply.code(r.status).send(r.body);
    });
  }

  // ---- signed-in customers -------------------------------------------------------------------
  const auth = { preHandler: app.authenticate };

  app.get('/api/billing', auth, async (req) => billing.customerOverview(req.account.id));

  app.get('/api/billing/invoices/:number', { ...auth, schema: { params: NUMBER } },
    async (req) => billing.invoiceForCustomer(req.account.id, req.params.number));

  app.post('/api/billing/renewals', {
    ...auth,
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', required: ['vmid', 'months'], additionalProperties: false, properties: { vmid: { type: 'integer', minimum: 1 }, months: { type: 'integer', enum: billing.MONTH_OPTIONS } } } },
  }, async (req, reply) => reply.code(201).send(await billing.createRenewal(req, req.body.vmid, req.body.months)));

  app.post('/api/billing/topups', {
    ...auth,
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', required: ['amount'], additionalProperties: false, properties: { amount: { type: 'integer' } } } },
  }, async (req, reply) => reply.code(201).send(billing.createTopup(req, req.body.amount)));

  app.post('/api/billing/invoices/:number/pay', {
    ...auth,
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: {
      params: NUMBER,
      body: { type: 'object', required: ['method'], additionalProperties: false, properties: { method: { type: 'string', enum: ['wallet', 'xendit', 'midtrans', 'bank'] }, reference: { type: 'string', maxLength: 120 } } },
    },
  }, async (req) => billing.pay(req, req.params.number, req.body.method, req.body));

  app.put('/api/billing/servers/:vmid/auto-renew', {
    ...auth, schema: { params: VMID, body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
  }, async (req) => billing.setAutoRenew(req, req.params.vmid, req.body.enabled));

  app.put('/api/billing/profile', {
    ...auth,
    schema: { body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 120 }, address: { type: 'string', maxLength: 300 }, taxId: { type: 'string', maxLength: 60 } } } },
  }, async (req) => billing.saveProfile(req.account.id, req.body));
}
