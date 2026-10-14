// Simulated Xendit (Invoice API) and Midtrans (Snap + status API) for tests.
//   /xendit/v2/invoices            POST create, GET /:id status
//   /midtrans-app/snap/v1/transactions  POST create
//   /midtrans-api/v2/:order/status      GET status
// gw.pay(orderId, { amount }) marks an order paid (at the given amount).
//   /checkout/:id  the Xendit payment page for browser tests: "Pay" marks the order
//                  paid, sends the callback to the panel and returns to the shop.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startMockGateways({ xenditKey = 'xnd_secret', xenditToken = 'xnd_callback', midtransKey = 'mt_server' } = {}) {
  const orders = new Map();   // orderId → { gateway, id, amount, paid, paidAmount, failed }
  const calls = [];
  let n = 0;
  let base = '';
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const authOk = (req, key) => req.headers.authorization === `Basic ${Buffer.from(`${key}:`).toString('base64')}`;

  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const u = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: u.pathname, body });
      if (u.pathname === '/xendit/v2/invoices' && req.method === 'POST') {
        if (!authOk(req, xenditKey)) return json(res, 401, { error_code: 'INVALID_API_KEY', message: 'API key is invalid' });
        const id = `inv_${++n}`;
        orders.set(body.external_id, { gateway: 'xendit', id, amount: body.amount, paid: false, back: body.success_redirect_url });
        return json(res, 200, { id, external_id: body.external_id, status: 'PENDING', amount: body.amount, invoice_url: `${base}/checkout/${id}`, expiry_date: new Date(Date.now() + 86400e3).toISOString() });
      }
      let m = /^\/checkout\/([\w-]+)$/.exec(u.pathname);
      if (m) {
        const [orderId, o] = [...orders].find(([, x]) => x.id === m[1]) ?? [];
        if (!o) return json(res, 404, { message: 'not found' });
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end(`<!doctype html><title>Test checkout</title><h1>Test checkout</h1><p>Order ${orderId}: IDR ${o.amount}</p>
            <form method="post"><button id="mock-pay">Pay</button></form>`);
        }
        o.paid = true; o.paidAmount = o.amount;
        const hook = `${new URL(o.back).origin}/api/billing/webhooks/xendit`;
        fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-callback-token': xenditToken },
          body: JSON.stringify({ id: o.id, external_id: orderId, status: 'PAID', amount: o.amount, paid_amount: o.amount }) })
          .catch(() => {})
          .finally(() => { res.writeHead(303, { location: o.back }); res.end(); });
        return;
      }
      m = /^\/xendit\/v2\/invoices\/(.+)$/.exec(u.pathname);
      if (m && req.method === 'GET') {
        if (!authOk(req, xenditKey)) return json(res, 401, { message: 'API key is invalid' });
        const [orderId, o] = [...orders].find(([, x]) => x.id === m[1]) ?? [];
        if (!o) return json(res, 404, { message: 'not found' });
        return json(res, 200, { id: o.id, external_id: orderId, amount: o.amount, status: o.paid ? 'PAID' : o.failed ? 'EXPIRED' : 'PENDING', paid_amount: o.paid ? o.paidAmount : undefined, payment_method: o.paid ? 'QR_CODE' : undefined, payment_channel: o.paid ? 'QRIS' : undefined });
      }
      if (u.pathname === '/midtrans-app/snap/v1/transactions' && req.method === 'POST') {
        if (!authOk(req, midtransKey)) return json(res, 401, { error_messages: ['Access denied'] });
        const sum = body.item_details.reduce((a, i) => a + i.price * i.quantity, 0);
        if (sum !== body.transaction_details.gross_amount) return json(res, 400, { error_messages: ['transaction_details.gross_amount is not equal to the sum of item_details'] });
        const token = `snap_${++n}`;
        orders.set(body.transaction_details.order_id, { gateway: 'midtrans', id: token, amount: body.transaction_details.gross_amount, paid: false });
        return json(res, 201, { token, redirect_url: `https://app.sandbox.midtrans.example/snap/v4/redirection/${token}` });
      }
      m = /^\/midtrans-api\/v2\/(.+)\/status$/.exec(u.pathname);
      if (m && req.method === 'GET') {
        if (!authOk(req, midtransKey)) return json(res, 401, { status_message: 'Access denied' });
        const o = orders.get(decodeURIComponent(m[1]));
        if (!o) return json(res, 404, { status_code: '404', status_message: "Transaction doesn't exist." });
        return json(res, 200, {
          status_code: o.paid ? '200' : '201', order_id: decodeURIComponent(m[1]), transaction_id: `tx-${o.id}`,
          gross_amount: `${(o.paid ? o.paidAmount : o.amount).toFixed(2)}`, payment_type: 'qris',
          transaction_status: o.paid ? 'settlement' : o.failed ? 'expire' : 'pending', fraud_status: 'accept',
        });
      }
      json(res, 404, { error: 'not found' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  return {
    calls, orders, xenditKey, xenditToken, midtransKey,
    endpoints: { xendit: `${base}/xendit`, midtransApp: `${base}/midtrans-app`, midtransApi: `${base}/midtrans-api` },
    pay(orderId, { amount } = {}) { const o = orders.get(orderId); o.paid = true; o.paidAmount = amount ?? o.amount; },
    expire(orderId) { orders.get(orderId).failed = true; },
    /** What Xendit posts to the webhook (it carries no secret besides the header). */
    xenditCallback(orderId, token = xenditToken) {
      const o = orders.get(orderId);
      return { headers: { 'x-callback-token': token }, body: { id: o.id, external_id: orderId, status: 'PAID', amount: o.amount, paid_amount: o.paidAmount } };
    },
    /** What Midtrans posts, signed with the server key. */
    midtransNotification(orderId, { key = midtransKey, grossAmount } = {}) {
      const o = orders.get(orderId);
      const gross = grossAmount ?? `${o.amount.toFixed(2)}`;
      const statusCode = '200';
      return { headers: {}, body: {
        order_id: orderId, status_code: statusCode, gross_amount: gross, transaction_status: 'settlement', fraud_status: 'accept',
        transaction_id: `tx-${o.id}`, signature_key: crypto.createHash('sha512').update(`${orderId}${statusCode}${gross}${key}`).digest('hex'),
      } };
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}
