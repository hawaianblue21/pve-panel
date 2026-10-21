// README screenshots, taken from the seeded test stack in the PVE Panel App UI.
// Skipped in normal runs. To refresh docs/screenshots:
//   SCREENSHOTS=1 npx playwright test test/e2e/screenshots.spec.mjs
import path from 'node:path';
import { test, expect } from '@playwright/test';

const OUT = path.resolve('docs/screenshots');
const A = () => process.env.E2E_ADMIN_URL;
const C = () => process.env.E2E_CUSTOMER_URL;
const VIEW = { width: 1440, height: 900 };

test.skip(!process.env.SCREENSHOTS, 'only when SCREENSHOTS=1');

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}
const shot = async (page, name) => { await page.waitForTimeout(900); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

test('README screenshots', async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await (await browser.newContext({ viewport: VIEW })).newPage();
  const visitor = await (await browser.newContext({ viewport: VIEW })).newPage();
  await visitor.goto(C());
  await expect(visitor.locator('#login-form')).toBeVisible();
  await shot(visitor, 'sign-in');

  await signIn(admin, A(), 'admin@example.com', 'correct-horse-battery');
  const put = (p, data) => admin.request.put(`${A()}${p}`, { data });
  const post = (p, data) => admin.request.post(`${A()}${p}`, { data });
  // sample setup: billing, plans, block storage, public IPs (with IPv6), a second cluster
  const lena = (await (await admin.request.get(`${A()}/api/admin/users`)).json()).find((u) => u.email === 'lena@example.com');
  await put('/api/admin/settings/billing', { enabled: true, taxRate: 11, bank: { enabled: true, instructions: 'Bank transfer to Example Bank 123-456' } });
  await post(`/api/admin/billing/wallets/${lena.id}`, { amount: 1_500_000, reason: 'Initial credit' });
  await put('/api/admin/vms/101/expiry', { expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() });
  for (const [name, cores, mem, disk, price] of [['Starter', 1, 1024, 20, 75_000], ['Plus', 2, 4096, 60, 180_000], ['Pro', 4, 8192, 120, 350_000]]) {
    await post('/api/admin/plans', { name, cores, memoryMb: mem, diskGb: disk, priceMonthly: price });
  }
  await put('/api/admin/settings/volumes', { enabled: true, tiers: [{ id: 'nvme', name: 'NVMe', storage: 'VMStorage', pricePerGb: 1500 }, { id: 'archive', name: 'Archive', pricePerGb: 300 }] });
  await post('/api/admin/ipam/pools', {
    name: 'Jakarta public A', cidr: '198.51.100.0/28', gateway: '198.51.100.1', bridge: 'vmbr1', priceMonthly: 50_000,
    ipv6Cidr: '2001:db8:100::/56', ipv6Gateway: 'fe80::1',
  });
  await put('/api/admin/settings/ipam', { enabled: true, ipv6Enabled: true });
  // backups on the simulated Proxmox Backup Server (window not open now: only the manual backup runs)
  await post('/api/admin/backups/servers', { name: 'pbs-jkt', url: process.env.E2E_PBS_URL, tokenId: 'panel@pbs!panel', tokenSecret: 'pbs-secret', datastore: 'ds-customer' });
  const daily = await (await post('/api/admin/backups/policies', { name: 'Daily 7', frequency: 'daily', keepDaily: 7 })).json();
  await post('/api/admin/backups/policies', { name: 'Long retention', frequency: 'daily', keepDaily: 14, keepWeekly: 8, addonPrice: 25_000 });
  const h = new Date().getUTCHours();
  await put('/api/admin/backups/settings', { enabled: true, defaultPolicyId: daily.id, windowStart: (h + 3) % 24, windowEnd: (h + 5) % 24 });
  await post('/api/admin/clusters', { key: 'dc2', name: 'Jakarta DC2', url: process.env.E2E_SECOND_PVE_URL, tokenId: 'panel@pve!panel', tokenSecret: 'x' }).catch(() => {});

  const customer = await (await browser.newContext({ viewport: VIEW })).newPage();
  await signIn(customer, C(), 'lena@example.com', 'another-long-password');
  const cr = (p, data) => customer.request.post(`${C()}${p}`, { data });
  await cr('/api/vms/101/ips', {});
  await cr('/api/volumes', { label: 'db-data', tier: 'nvme', sizeGb: 50, vmid: 101 });
  await cr('/api/vms/101/snapshots', { name: 'before_upgrade' });
  await customer.request.put(`${C()}/api/vms/101/snapshot-schedule`, { data: { frequency: 'daily', hour: 2, keep: 2 } });
  await cr('/api/vms/101/backups', {});
  await expect.poll(async () => (await (await customer.request.get(`${C()}/api/vms/101/backups`)).json()).points?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  await customer.goto(C());
  await expect(customer.locator('.server-row').first()).toBeVisible();
  await shot(customer, 'customer-dashboard');
  await customer.locator('.server-row[data-vmid="101"]').click();
  await expect(customer.locator('.specs')).toBeVisible();
  await shot(customer, 'server-details');
  await customer.locator('[data-tab=snapshots]').click();
  await expect(customer.locator('#snap-schedule-form')).toBeVisible();
  await shot(customer, 'customer-snapshots');
  await customer.locator('[data-tab=backups]').click();
  await customer.locator('[data-bk-point]').first().locator('[data-bk-browse]').click();
  await customer.locator('.bk-browser [data-bk-path="/var"]').click();
  await expect(customer.locator('.bk-browser')).toContainText('www');
  await shot(customer, 'customer-backups');
  await customer.locator('#nav-storage').click();
  await shot(customer, 'customer-storage');
  await customer.locator('#nav-billing').click();
  await shot(customer, 'customer-billing');
  await customer.locator('#new-server').click();
  await expect(customer.locator('#create-form')).toBeVisible();
  await shot(customer, 'provisioning');

  await admin.goto(A());
  await expect(admin.locator('.overview .node-table')).toBeVisible();
  await shot(admin, 'admin-dashboard');
  for (const [tab, name] of [['hosts', 'admin-clusters-hosts'], ['updates', 'admin-fleet-updates'], ['plans', 'admin-plans'], ['ipam', 'admin-public-ips'], ['about', 'admin-about']]) {
    await admin.locator(`[data-admin-tab=${tab}]`).click();
    await shot(admin, name);
  }
  await admin.locator('[data-admin-tab=backups]').click();
  await expect(admin.locator('[data-pbs]').first()).toContainText('Online');
  await shot(admin, 'admin-backups');
  await admin.locator('[data-bk-view=servers]').click();
  await admin.locator('[data-bk-srv=all]').click();
  await shot(admin, 'admin-backup-servers');
  await put('/api/admin/backups/settings', { enabled: false });
});
