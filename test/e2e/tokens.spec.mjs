// API tokens: a customer creates one on the account page, uses it, revokes it;
// an administrator creates a read-only token.
import { test, expect } from '@playwright/test';

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('create, use and revoke API tokens', async ({ browser, request }) => {
  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.locator('#nav-account').click();
  const card = customer.locator('#api-tokens');
  await card.locator('[name=name]').fill('deploy script');
  await card.locator('input[name=scope][value=power]').check();
  await card.locator('.token-form button.primary').click();
  const token = (await card.locator('#new-token').textContent()).trim();
  expect(token).toMatch(/^pvc_\d+_/);
  await expect(card.locator('.snippet')).toContainText(`Bearer ${token}`);
  await card.locator('[data-token-done]').click();
  await expect(card.locator('#new-token')).toHaveCount(0);
  await expect(card.locator('tr[data-token]')).toContainText('Power');

  const ok = await request.get(`${process.env.E2E_CUSTOMER_URL}/api/vms`, { headers: { authorization: `Bearer ${token}` } });
  expect(ok.status()).toBe(200);
  await expect(card.locator('tr[data-token]')).toContainText('deploy script');

  await card.locator('[data-token-revoke]').click();
  await customer.locator('#confirm-ok').click();
  await expect(card.locator('tr[data-token]')).toHaveCount(0);
  const gone = await request.get(`${process.env.E2E_CUSTOMER_URL}/api/vms`, { headers: { authorization: `Bearer ${token}` } });
  expect(gone.status()).toBe(401);

  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  await admin.locator('[data-admin-tab=account]').click();
  const a = admin.locator('#admin-tokens');
  await a.locator('[name=name]').fill('monitoring');
  await a.locator('.token-form button.primary').click();
  const at = (await a.locator('#new-token').textContent()).trim();
  expect(at).toMatch(/^pva_\d+_/);
  const r = await request.get(`${process.env.E2E_ADMIN_URL}/api/admin/vms`, { headers: { authorization: `Bearer ${at}` } });
  expect(r.status()).toBe(200);
  await a.locator('[data-token-done]').click();
  await expect(a.locator('tr[data-token]')).toContainText('Read only');
  await expect(a.locator('tr[data-any-token]')).toContainText('admin@example.com');
});
