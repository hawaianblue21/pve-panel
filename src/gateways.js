// Payment gateways: Xendit (Invoice API) and Midtrans (Snap).
//
// Both: the panel creates a checkout and sends the customer to the gateway's
// payment page; the gateway notifies the panel. A notification is never trusted
// on its own: it is authenticated (Xendit: callback token; Midtrans: SHA-512
// signature) and the payment is then confirmed by asking the gateway's API for
// the status and the amount.
//
//   Xendit   POST https://api.xendit.co/v2/invoices, GET /v2/invoices/{id}
//            Basic auth: secret key + ":"; webhook header x-callback-token
//   Midtrans POST https://app(.sandbox).midtrans.com/snap/v1/transactions
//            GET  https://api(.sandbox).midtrans.com/v2/{order_id}/status
//            Basic auth: server key + ":"; signature_key =
//            SHA512(order_id + status_code + gross_amount + server key)

import crypto from 'node:crypto';

export class GatewayError extends Error {
  constructor(message, status = 502) { super(message); this.statusCode = status; this.expose = true; }
}

// Tests only: point the gateways at a local mock ({"xendit": "...", "midtransApp": "...", "midtransApi": "..."})
let testEndpoints = {};
try { testEndpoints = JSON.parse(process.env.BILLING_TEST_ENDPOINTS || '{}'); } catch { testEndpoints = {}; }

const basic = (key) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;

async function call(method, url, key, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: basic(key), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new GatewayError(`The payment provider can't be reached (${err.cause?.code ?? err.name})`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = data?.message ?? data?.error_messages?.join(', ') ?? data?.status_message ?? text.slice(0, 200);
    throw new GatewayError(`The payment provider answered ${res.status}: ${msg}`);
  }
  return data;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---- Xendit ---------------------------------------------------------------------------------

const xenditBase = () => testEndpoints.xendit || 'https://api.xendit.co';

export const xendit = {
  async create({ secretKey, orderId, amount, email, description, durationSeconds, successUrl, failureUrl }) {
    const inv = await call('POST', `${xenditBase()}/v2/invoices`, secretKey, {
      external_id: orderId, amount, currency: 'IDR', payer_email: email || undefined, description,
      invoice_duration: durationSeconds,
      ...(successUrl ? { success_redirect_url: successUrl } : {}), ...(failureUrl ? { failure_redirect_url: failureUrl } : {}),
    });
    if (!inv?.id || !inv?.invoice_url) throw new GatewayError('Xendit did not return a payment page');
    return { gatewayId: inv.id, url: inv.invoice_url, expiresAt: inv.expiry_date ?? null };
  },

  /** Webhook → { orderId, gatewayId } when the token matches, else null. */
  authenticate(headers, body, callbackToken) {
    if (!callbackToken || !safeEqual(headers['x-callback-token'], callbackToken)) return null;
    if (!body?.id || !body?.external_id) return null;
    return { orderId: String(body.external_id), gatewayId: String(body.id) };
  },

  /** The truth from the API: { paid, amount, failed, method }. */
  async status({ secretKey, gatewayId }) {
    const inv = await call('GET', `${xenditBase()}/v2/invoices/${encodeURIComponent(gatewayId)}`, secretKey);
    const st = String(inv?.status ?? '').toUpperCase();
    return {
      paid: st === 'PAID' || st === 'SETTLED', failed: st === 'EXPIRED',
      amount: Number(inv?.paid_amount ?? inv?.amount ?? 0), orderId: inv?.external_id ?? null,
      method: [inv?.payment_method, inv?.payment_channel].filter(Boolean).join(' ') || null,
    };
  },
};

// ---- Midtrans (Snap) -------------------------------------------------------------------------

const midtransApp = (sandbox) => testEndpoints.midtransApp || `https://app${sandbox ? '.sandbox' : ''}.midtrans.com`;
const midtransApi = (sandbox) => testEndpoints.midtransApi || `https://api${sandbox ? '.sandbox' : ''}.midtrans.com`;

export const midtrans = {
  async create({ serverKey, sandbox, orderId, amount, email, name, items, finishUrl }) {
    const r = await call('POST', `${midtransApp(sandbox)}/snap/v1/transactions`, serverKey, {
      transaction_details: { order_id: orderId, gross_amount: amount },
      customer_details: { email: email || undefined, first_name: name || undefined },
      item_details: items,
      ...(finishUrl ? { callbacks: { finish: finishUrl } } : {}),
    });
    if (!r?.redirect_url) throw new GatewayError('Midtrans did not return a payment page');
    return { gatewayId: r.token ?? null, url: r.redirect_url, expiresAt: null };
  },

  authenticate(headers, body, serverKey) {
    if (!serverKey || !body?.order_id || body.signature_key == null) return null;
    const expected = crypto.createHash('sha512')
      .update(`${body.order_id}${body.status_code}${body.gross_amount}${serverKey}`).digest('hex');
    if (!safeEqual(String(body.signature_key).toLowerCase(), expected)) return null;
    return { orderId: String(body.order_id), gatewayId: body.transaction_id ? String(body.transaction_id) : null };
  },

  async status({ serverKey, sandbox, orderId }) {
    const s = await call('GET', `${midtransApi(sandbox)}/v2/${encodeURIComponent(orderId)}/status`, serverKey);
    const ts = String(s?.transaction_status ?? '');
    const fraud = String(s?.fraud_status ?? 'accept');
    return {
      paid: ts === 'settlement' || (ts === 'capture' && fraud === 'accept'),
      failed: ['deny', 'cancel', 'expire', 'failure'].includes(ts),
      amount: Math.round(Number(s?.gross_amount ?? 0)), orderId: s?.order_id ?? null,
      method: s?.payment_type ?? null,
    };
  },
};
