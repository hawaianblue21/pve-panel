// Backups: an owner connects a Proxmox Backup Server, adds a policy and switches backups on.
import { test, expect } from '@playwright/test';

test('connect a backup server, add a policy, switch backups on', async ({ page }) => {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('[data-admin-tab=backups]').click();
  await expect(page.locator('.notice')).toContainText('No backup server is connected yet');

  await page.locator('[data-bk-view=connect]').first().click();
  const f = page.locator('#pbs-form');
  await f.locator('[name=name]').fill('pbs-jkt');
  await f.locator('[name=url]').fill(process.env.E2E_PBS_URL);
  await f.locator('[name=tokenId]').fill('panel@pbs!panel');
  await f.locator('[name=tokenSecret]').fill('pbs-secret');
  await expect(f.locator('button.primary')).toBeDisabled();
  await f.locator('[data-pbs-test]').click();
  await expect(page.locator('#pbs-form .notice')).toContainText('Connected: Proxmox Backup Server 4.0.14');
  await page.locator('#pbs-form [name=datastore]').selectOption('ds-customer');
  await page.locator('#pbs-form button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('pbs-jkt connected');
  await expect(page.locator('[data-pbs]').first()).toContainText('Online');
  await expect(page.locator('[data-pbs]').first()).toContainText('3.4×');

  await page.locator('[data-bk-view=policies]').click();
  await page.locator('[data-bk-new]').click();
  const p = page.locator('#bk-policy');
  await p.locator('[name=name]').fill('Daily 7');
  await p.locator('[name=keepDaily]').fill('7');
  await p.locator('button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('Policy added');
  await expect(page.locator('[data-policy]').first()).toContainText('Daily · keep 7 daily');

  await page.locator('[data-bk-view=overview]').click();
  const s = page.locator('#bk-settings');
  await s.locator('[name=defaultPolicyId]').selectOption({ label: 'Daily 7' });
  await s.locator('[name=enabled]').check();
  await s.locator('button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('Backup settings saved');
  await expect(page.locator('#bk-settings')).toBeVisible();
  await expect(page.locator('.settings-head .pill')).toContainText('On');

  // Leave the shared stack as found: no scheduler side effects for other specs.
  await page.locator('#bk-settings [name=enabled]').uncheck();
  await page.locator('#bk-settings button.primary').click();
  await expect(page.locator('.settings-head .pill')).toContainText('Off');
});
