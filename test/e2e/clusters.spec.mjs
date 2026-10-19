// Connecting a second Proxmox cluster from the Hosts tab: test, connect, see its
// nodes, remove it again.
import { test, expect } from '@playwright/test';

test('connect and remove a second cluster', async ({ page }) => {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('[data-admin-tab=hosts]').click();
  await page.locator('[data-cluster-add]').click();
  const f = page.locator('#cluster-form');
  await expect(f.locator('button.primary')).toBeDisabled();
  await f.locator('[name=key]').fill('dc3');
  await f.locator('[name=name]').fill('Jakarta DC3');
  await f.locator('[name=url]').fill(process.env.E2E_SECOND_PVE_URL);
  await f.locator('[name=tokenId]').fill('panel@pve!panel');
  await f.locator('[name=tokenSecret]').fill('x');
  await f.locator('[data-cluster-test]').click();
  await expect(page.locator('#cluster-form .notice')).toContainText('Connected');
  await expect(page.locator('#cluster-form .notice')).toContainText('pve3');
  await expect(page.locator('#cluster-form .notice')).toContainText('VMID used elsewhere (102)');
  await page.locator('#cluster-form button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('Jakarta DC3 connected');

  const row = page.locator('tr[data-cluster]', { hasText: 'Jakarta DC3' });
  await expect(row).toContainText('Online');
  await expect(row).toContainText('pve3');
  await expect(page.locator('.clusters .notice')).toContainText('102');
  await expect(page.locator('tr[data-node="pve3"]')).toContainText('cluster Jakarta DC3');

  await row.locator('[data-cluster-remove]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('tr[data-cluster]', { hasText: 'Jakarta DC3' })).toHaveCount(0);
  await expect(page.locator('tr[data-node="pve3"]')).toHaveCount(0);
});
