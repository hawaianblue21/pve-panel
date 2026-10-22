// OS templates: an owner imports a cloud image; it is built, test-booted and listed as a template, not offered yet.
import { test, expect } from '@playwright/test';

test('import a cloud image as a template', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('[data-admin-tab=templates]').click();
  await page.locator('[data-imp-open]').click();
  const f = page.locator('#imp-form');
  await expect(f.locator('#imp-targets [data-imp-cluster="0"] [name=importStorage]')).toHaveValue('local');
  await f.locator('[name=url]').fill('https://cloud-images.example.com/noble-server-cloudimg-amd64.img');
  await f.locator('[name=checksum]').fill('b'.repeat(64));
  await f.locator('[name=name]').fill('ubuntu-2404');
  await f.locator('button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('Importing ubuntu-2404');

  const row = page.locator('#imp-list tr[data-imp]').first();
  await expect(row).toContainText('Ready', { timeout: 60_000 });
  await expect(row).toContainText('Agent');
  await expect(row).toContainText('Ubuntu 24.04.1 LTS');
  const tpl = page.locator('tr[data-template]', { hasText: 'ubuntu-2404' });
  await expect(tpl).toContainText('imported qcow2 · agent OK');
  await expect(tpl.locator('[data-f=offered]')).not.toBeChecked();
  await expect(tpl.locator('[data-f=label]')).toHaveValue('Ubuntu 24.04.1 LTS');
});

test('an ISO waits for the installation; it can be cancelled', async ({ page }) => {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('[data-admin-tab=templates]').click();
  await page.locator('[data-imp-open]').click();
  await page.locator('[data-imp-format=iso]').click();
  const f = page.locator('#imp-form');
  await expect(f.locator('[name=setup]')).toHaveValue('windows');
  await expect(f.locator('[name=virtio]')).toBeChecked();
  await expect(f.locator('#imp-targets [data-imp-cluster="0"] [name=importStorage]')).toHaveValue('local');
  await f.locator('[name=url]').fill('https://downloads.example.com/win2025-eval.iso');
  await f.locator('[name=name]').fill('win2025');
  await f.locator('button.primary').click();
  const row = page.locator('#imp-list tr[data-imp]', { hasText: 'win2025' });
  await expect(row).toContainText('Install', { timeout: 30_000 });
  await expect(row.locator('a', { hasText: 'Console in Proxmox' })).toHaveAttribute('href', /#v1:0:=qemu%2F\d+:4/);
  await expect(row.locator('[data-imp-installed]')).toBeVisible();
  await row.locator('[data-imp-cancel]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('.toast').last()).toContainText('Installation cancelled');
  await expect(page.locator('#imp-list tr[data-imp]', { hasText: 'win2025' })).toContainText('Cancelled');
});
