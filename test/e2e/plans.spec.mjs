// Plans: the owner adds a plan in the admin portal; a customer creates a server
// from it and pays 3 months from the wallet; later moves it to a larger plan.
import { test, expect } from '@playwright/test';

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('create a server from a paid plan, then move it to a larger plan', async ({ browser }) => {
  test.setTimeout(150_000);
  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  const A = process.env.E2E_ADMIN_URL;
  await admin.request.put(`${A}/api/admin/settings/billing`, { data: { enabled: true } });
  const users = await (await admin.request.get(`${A}/api/admin/users`)).json();
  const lena = users.find((u) => u.email === 'lena@example.com');
  await admin.request.post(`${A}/api/admin/billing/wallets/${lena.id}`, { data: { amount: 500_000, reason: 'Credit for the plan test' } });

  await admin.locator('[data-admin-tab=plans]').click();
  const f = admin.locator('#plan-form');
  await f.locator('[name=name]').fill('Starter');
  await f.locator('[name=priceMonthly]').fill('50000');
  await f.locator('[name=cores]').fill('1');
  await f.locator('[name=memoryGb]').fill('1');
  await f.locator('[name=diskGb]').fill('10');
  await f.locator('[name=description]').fill('For small websites');
  await f.locator('button.primary').click();
  await expect(admin.locator('.plans-admin table')).toContainText('Starter');
  await admin.request.post(`${A}/api/admin/plans`, { data: { name: 'Plus', cores: 2, memoryMb: 2048, diskGb: 20, priceMonthly: 90_000, sort: 5 } });

  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.locator('#new-server').click();
  const form = customer.locator('#create-form');
  await form.locator('.plan-choice', { hasText: 'Starter' }).click();
  await form.locator('[data-plan-months="3"]').click();
  // 150.000 − 5% = 142.500 + PPN 11% 15.675
  await expect(form.locator('.plan-total')).toContainText('Rp 158.175');
  await expect(customer.locator('#create-submit')).toHaveText('Pay Rp 158.175 and create');
  await customer.getByText('Debian 12').click();
  await form.locator('[name=hostname]').fill('plan-web');
  await form.locator('[name=password]').fill('supersecret-123');
  await customer.locator('#create-submit').click();
  const entry = customer.locator('.unit', { hasText: 'plan-web' });
  await expect(entry).toBeVisible();
  await expect(entry).not.toContainText(/Setting up/i, { timeout: 60_000 });
  await entry.click();
  await expect(customer.locator('.size-row')).toContainText('Plan Starter');

  await customer.locator('[data-upgrade]').click();
  await expect(customer.locator('#upgrade-form')).toContainText('Plus');
  await customer.locator('#upgrade-submit').click();
  await customer.locator('#confirm-ok').click();
  await expect(customer.locator('.toast').last()).toContainText('Now on plan Plus');
  await expect(customer.locator('.size-row')).toContainText('Plan Plus');

  await customer.locator('#nav-billing').click();
  await expect(customer.locator('.invoice-table')).toContainText('New server, plan Starter');
  await expect(customer.locator('.invoice-table')).toContainText('Upgrade server');
});
