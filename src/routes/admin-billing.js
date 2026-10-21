// Admin portal: invoices, payments, wallets, prices and the billing settings.
import { audit } from '../db.js';
import * as billing from '../billing.js';
import { runDunning, setPaused, sendReminder, dunningOverview } from '../dunning.js';

const NUMBER = { type: 'object', required: ['number'], properties: { number: { type: 'string', maxLength: 40 } } };

export default async function adminBillingRoutes(app) {
  app.get('/api/admin/billing', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['unpaid', 'paid', 'void', 'refunded', 'overdue', 'reported'] }, q: { type: 'string', maxLength: 100 } } } },
  }, async (req) => ({ ...billing.adminOverview(req.query), dunning: dunningOverview() }));

  app.get('/api/admin/billing/invoices/:number', { schema: { params: NUMBER } }, async (req) => billing.adminInvoice(req.params.number));

  app.post('/api/admin/billing/invoices/:number/mark-paid', {
    schema: { params: NUMBER, body: { type: 'object', required: ['reference'], additionalProperties: false, properties: { reference: { type: 'string', maxLength: 120 }, note: { type: 'string', maxLength: 500 } } } },
  }, async (req) => billing.adminMarkPaid(req, req.params.number, req.body));

  app.post('/api/admin/billing/invoices/:number/void', {
    schema: { params: NUMBER, body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } } },
  }, async (req) => billing.adminVoid(req, req.params.number, req.body.reason));

  // dunning: pause or resume, a reminder now; refunds (wallet or recorded outside the panel)
  app.post('/api/admin/billing/invoices/:number/dunning', {
    schema: { params: NUMBER, body: { type: 'object', required: ['paused'], additionalProperties: false, properties: { paused: { type: 'boolean' } } } },
  }, async (req) => setPaused(req, req.params.number, req.body.paused));
  app.post('/api/admin/billing/invoices/:number/reminder', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, schema: { params: NUMBER },
  }, async (req) => sendReminder(req, req.params.number));
  app.post('/api/admin/billing/invoices/:number/refund', {
    schema: {
      params: NUMBER,
      body: {
        type: 'object', required: ['via', 'reason'], additionalProperties: false,
        properties: { via: { type: 'string', enum: ['wallet', 'external'] }, reference: { type: 'string', maxLength: 120 }, reason: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (req) => billing.adminRefund(req, req.params.number, req.body));
  app.post('/api/admin/billing/dunning/run', async (req) => runDunning({ log: req.log }));

  app.post('/api/admin/billing/wallets/:userId', {
    schema: {
      params: { type: 'object', properties: { userId: { type: 'integer', minimum: 1 } } },
      body: { type: 'object', required: ['amount', 'reason'], additionalProperties: false, properties: { amount: { type: 'integer' }, reason: { type: 'string', maxLength: 200 } } },
    },
  }, async (req) => billing.adjustWallet(req, req.params.userId, req.body.amount, req.body.reason));

  app.put('/api/admin/billing/servers/:vmid/price', {
    schema: {
      params: { type: 'object', properties: { vmid: { type: 'integer', minimum: 1 } } },
      body: { type: 'object', required: ['priceMonthly'], additionalProperties: false, properties: { priceMonthly: { type: ['integer', 'null'] } } },
    },
  }, async (req) => billing.setServerPrice(req, req.params.vmid, req.body.priceMonthly));

  app.post('/api/admin/billing/auto-renew/run', async (req) => billing.runAutoRenew(req.log));

  app.get('/api/admin/settings/billing', async () => billing.billingSettings());
  app.put('/api/admin/settings/billing', { bodyLimit: 64 * 1024, schema: { body: { type: 'object', minProperties: 1 } } }, async (req) => {
    const saved = billing.saveBillingSettings(req.body);
    const redacted = JSON.parse(JSON.stringify(req.body, (k, v) => (['secretKey', 'callbackToken', 'serverKey'].includes(k) ? (v ? '(changed)' : undefined) : v)));
    audit(req, null, 'admin_billing_settings', redacted);
    return saved;
  });
}
