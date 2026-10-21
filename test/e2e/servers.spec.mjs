// Servers tab: filters, grouping by node and bulk actions (assign and unassign).
import { test, expect } from '@playwright/test';

test('filter, group by node, assign and unassign several servers at once', async ({ page }) => {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('[data-admin-tab=servers]').click();
  await expect(page.locator('tr[data-vmid="101"]')).toBeVisible();

  await page.locator('[data-vm-view=owner]').selectOption('unassigned');
  await expect(page.locator('tr[data-vmid="101"]')).toHaveCount(0);
  await page.locator('[data-vm-view=group]').check();
  await expect(page.locator('tr.group-row').first()).toContainText('pve1');

  const row = page.locator('tr[data-vmid="102"]');
  await row.locator('[data-pick-vm]').check();
  await expect(page.locator('.bulk-bar')).toContainText('1 selected');
  await page.locator('#bulk-user').selectOption({ label: 'lena@example.com' });
  await page.locator('[data-bulk=assign]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('.toast').last()).toContainText('1 done');
  await expect(page.locator('tr[data-vmid="102"]')).toHaveCount(0);       // filter: not assigned

  await page.locator('[data-vm-view=owner]').selectOption('assigned');
  await page.locator('tr[data-vmid="102"] [data-pick-vm]').check();
  await page.locator('[data-bulk=unassign]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('.toast').last()).toContainText('1 done');
  await expect(page.locator('tr[data-vmid="102"]')).toHaveCount(0);
  await expect(page.locator('.bulk-bar')).toHaveCount(0);
});
