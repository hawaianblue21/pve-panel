// Server lifecycle queue: a server ending soon, extended from the queue, its date removed.
import { test, expect } from '@playwright/test';

test('see servers ending soon, extend one and remove its end date', async ({ page }) => {
  const A = process.env.E2E_ADMIN_URL;
  await page.goto(A);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
  const before = (await (await page.request.get(`${A}/api/admin/vms`)).json()).find((v) => v.vmid === 101).expiry?.expiresAt ?? null;
  await page.request.put(`${A}/api/admin/vms/101/expiry`, { data: { expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() } });

  await page.locator('[data-admin-tab=lifecycle]').click();
  const row = page.locator('tr[data-lc="101"]');
  await expect(row).toContainText('Ending soon');
  await expect(row).toContainText('Lena web');
  await page.locator('[data-lc-filter=soon]').click();
  await expect(row).toBeVisible();

  await row.locator('[data-lc-extend="7"]').click();
  await expect(page.locator('.toast').last()).toContainText('extended by 7 days');
  await expect(page.locator('tr[data-lc="101"]')).toHaveCount(0);        // no longer within 7 days
  await page.locator('[data-lc-filter=all]').click();
  await page.locator('tr[data-lc="101"] [data-lc-remove]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('.toast').last()).toContainText('no end date');
  await expect(page.locator('tr[data-lc="101"]')).toHaveCount(0);

  if (before) await page.request.put(`${A}/api/admin/vms/101/expiry`, { data: { expiresAt: before } });
});
