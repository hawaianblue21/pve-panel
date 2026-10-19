// Fleet updates and jobs in the admin portal: pick servers, check pending updates,
// start a rollout (maintenance window fields), follow it ring by ring; the job list.
import { test, expect } from '@playwright/test';

test('start an update rollout from the fleet and follow it', async ({ page }) => {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('[data-admin-tab=updates]').click();

  const row = page.locator('tr[data-fleet="101"]');
  await expect(row).toContainText('Linux');
  await page.locator('[data-fleet-filter=linux]').click();
  await row.locator('[data-pick]').check();
  await expect(row).toContainText('not checked');
  await page.locator('[data-check-picked]').click();
  await expect(page.locator('.toast').last()).toContainText('Checking 1 server; nothing is installed');
  await expect(page.locator('tr[data-fleet="101"]')).toContainText('The server is not running', { timeout: 20_000 });
  const form = page.locator('#rollout-form');
  await expect(form.locator('[data-window]')).toBeHidden();
  await form.locator('[name=useWindow]').check();
  await expect(form.locator('[data-window]')).toBeVisible();
  await expect(form.locator('[data-window]')).toContainText('UTC');
  await form.locator('[name=useWindow]').uncheck();
  await expect(form.locator('[data-window]')).toBeHidden();
  await expect(form.locator('button.primary')).toHaveText('Start rollout on 1 server');
  await form.locator('[name=name]').fill('Test rollout');
  await form.locator('[name=rings]').selectOption('100');
  await form.locator('button.primary').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('.toast').last()).toContainText('Rollout started');

  const ro = page.locator('.rollout', { hasText: 'Test rollout' });
  await expect(ro).toBeVisible();
  // the server is stopped, so the run is skipped and the rollout finishes
  await expect(async () => {
    await page.locator('[data-admin-tab=updates]').click();
    await expect(page.locator('.rollout', { hasText: 'Test rollout' })).toContainText('Done', { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await page.locator('.rollout', { hasText: 'Test rollout' }).locator('[data-ro-toggle]').click();
  await expect(page.locator('.rollout', { hasText: 'Test rollout' })).toContainText('Start the server first');

  await page.locator('[data-admin-tab=jobs]').click();
  await expect(page.locator('.jobs .segmented')).toBeVisible();
  await page.locator('[data-job-filter=done]').click();
  await expect(page.locator('[data-job-filter=done]')).toHaveAttribute('aria-checked', 'true');
});
