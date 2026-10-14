// A customer installs Windows updates from the server page.
import { test, expect } from '@playwright/test';

const pve = (path, init = {}) => fetch(`${process.env.E2E_MOCK_URL}/api2/json${path}`, {
  ...init, headers: { authorization: 'PVEAPIToken=panel@pve!panel=x', ...(init.headers ?? {}) },
});

test('installs Windows updates from the Updates tab', async ({ page }) => {
  test.setTimeout(90_000);
  // make VM 102 a running Windows server of lena
  await pve('/nodes/pve1/qemu/102/config', { method: 'PUT', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'ostype=win11' });
  await pve('/nodes/pve1/qemu/102/status/start', { method: 'POST' });
  const admin = await page.context().request;
  await admin.post(`${process.env.E2E_ADMIN_URL}/api/auth/login`, { data: { email: 'admin@example.com', password: 'correct-horse-battery' } });
  const users = await (await admin.get(`${process.env.E2E_ADMIN_URL}/api/admin/users`)).json();
  const lena = users.find((u) => u.email === 'lena@example.com');
  await admin.put(`${process.env.E2E_ADMIN_URL}/api/admin/vms/102`, { data: { userId: lena.id, label: 'Win server' } });
  await page.waitForTimeout(2500);                                   // guest agent comes up after boot

  await page.goto(process.env.E2E_CUSTOMER_URL);
  await page.locator('#login-form [name=email]').fill('lena@example.com');
  await page.locator('#login-form [name=password]').fill('another-long-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('.server-row[data-vmid="102"]').click();
  await page.locator('[data-tab="updates"]').click();
  await expect(page.locator('#update-form')).toBeVisible();

  await page.locator('#update-form [name=snapshot]').uncheck();
  await page.locator('#update-form .btn.primary').click();
  await expect(page.locator('.updates .progress-step')).toBeVisible();          // progress shown
  await expect(page.locator('.update-last')).toContainText('4 updates installed', { timeout: 60_000 });
  await page.locator('.update-last summary').click();
  await expect(page.locator('.update-last')).toContainText('KB5044284');
});

test('Linux servers get Linux package updates in the same tab', async ({ page }) => {
  await page.goto(process.env.E2E_CUSTOMER_URL);
  await page.locator('#login-form [name=email]').fill('lena@example.com');
  await page.locator('#login-form [name=password]').fill('another-long-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('.server-row[data-vmid="101"]').click();
  await page.locator('[data-tab="updates"]').click();
  await expect(page.locator('.updates h2')).toHaveText('Linux updates');
  await expect(page.locator('#update-form')).toContainText('Security updates only');
  await expect(page.locator('#update-form [name=autoRestart]')).not.toBeChecked();
  await expect(page.locator('.updates')).toContainText('Start the server to install updates');   // 101 is stopped
});
