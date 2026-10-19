// Automatic snapshots on the Snapshots tab of a server.
import { test, expect } from '@playwright/test';

test('switch on daily automatic snapshots and switch them off again', async ({ page }) => {
  await page.goto(process.env.E2E_CUSTOMER_URL);
  await page.locator('#login-form [name=email]').fill('lena@example.com');
  await page.locator('#login-form [name=password]').fill('another-long-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#vm-list .unit[data-vmid="101"]').click();
  await page.locator('[data-tab=snapshots]').click();
  const f = page.locator('#snap-schedule-form');
  await expect(f.locator('[data-weekday]')).toBeHidden();
  await f.locator('[name=frequency]').selectOption('weekly');
  await expect(f.locator('[data-weekday]')).toBeVisible();
  await f.locator('[name=weekday]').selectOption('1');
  await f.locator('[name=hour]').selectOption('3');
  await f.locator('[name=keep]').selectOption('2');
  await f.locator('button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('Automatic snapshots on');
  await expect(page.locator('#snap-schedule-form')).toContainText('Next:');
  await expect(page.locator('#snap-schedule-form [name=frequency]')).toHaveValue('weekly');
  await page.locator('#snap-schedule-form [name=frequency]').selectOption('off');
  await page.locator('#snap-schedule-form button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('Automatic snapshots off');
});
