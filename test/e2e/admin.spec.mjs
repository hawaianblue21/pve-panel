import { test, expect } from '@playwright/test';

const signIn = async (page) => {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('.overview')).toBeVisible();          // the Overview tab opens first
  await page.locator('[data-admin-tab=servers]').click();
  await expect(page.locator('#vm-rows tr').first()).toBeVisible();
};

test('lists servers with the customer assignment', async ({ page }) => {
  await signIn(page);
  const row = page.locator('tr[data-vmid="101"]');
  await expect(row.locator('select')).toHaveValue(/\d+/);
  await expect(row.locator('[data-server-action="start"]')).toBeVisible();
});

test('customers tab shows the customer', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-admin-tab=users]').click();
  await expect(page.locator('tr[data-user]', { hasText: 'lena@example.com' })).toBeVisible();
});

test('about tab shows the running version', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-admin-tab=about]').click();
  await expect(page.locator('.about-version')).toContainText(/^v\d+\.\d+\.\d+/);
});

test('overview shows the nodes and opens a tab from a tile', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-admin-tab=overview]').click();
  await expect(page.locator('.overview .node-table')).toContainText('pve1');
  await expect(page.locator('.alert-list')).toContainText('pve2 memory at 90%');
  await page.locator('.kpi-link', { hasText: 'Nodes online' }).click();
  await expect(page.locator('[data-admin-tab=hosts]')).toHaveAttribute('aria-selected', 'true');
  const row = page.locator('tr[data-node="pve2"]');
  await expect(row).toContainText('PVE 9.0.10');
  await row.locator('[data-maint-on]').click();
  await page.locator('#prompt-input').fill('Disk swap');
  await page.locator('#prompt-ok').click();
  await expect(row).toContainText('Maintenance');
  await expect(row).toContainText('Disk swap');
  await row.locator('[data-maint-off]').click();
  await page.locator('#confirm-ok').click();
  await expect(row).toContainText('Online');
});
