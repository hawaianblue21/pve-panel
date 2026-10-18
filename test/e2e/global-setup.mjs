// Starts the stack once and seeds what the browser tests need.
import { startStack } from '../support/stack.mjs';
import { startMockGateways } from '../support/mock-gateways.mjs';

export default async function globalSetup() {
  const gw = await startMockGateways();
  const stack = await startStack({ env: { BILLING_TEST_ENDPOINTS: JSON.stringify(gw.endpoints), ROLLOUT_INTERVAL_SECONDS: '2' } });
  await stack.offerTemplates();
  const lena = await stack.customerWith('lena@example.com', { limits: {} });
  const admin = await stack.adminSession();
  await admin.put('/api/admin/vms/101', { userId: lena.userId, label: 'Lena web' });

  process.env.E2E_CUSTOMER_URL = stack.customerUrl;
  process.env.E2E_ADMIN_URL = stack.adminUrl;
  process.env.E2E_MOCK_URL = stack.mock.url;
  process.env.E2E_XENDIT = JSON.stringify({ secretKey: gw.xenditKey, callbackToken: gw.xenditToken });
  return async () => { await stack.stop(); await gw.close(); };
}
