// Backups: an owner connects a Proxmox Backup Server, adds a policy, switches backups on,
// backs a server up by hand, follows the run and excludes the server.
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

  // a window that is not open now, so only the manual backup below runs
  const h = new Date().getUTCHours();
  await s.locator('[name=windowStart]').selectOption(String((h + 3) % 24));
  await s.locator('[name=windowEnd]').selectOption(String((h + 5) % 24));
  await s.locator('button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('Backup settings saved');

  // Servers: back one up now, follow it under Runs
  await page.locator('[data-bk-view=servers]').click();
  const first = page.locator('#bk-servers tbody tr[data-bk-vm]').first();
  await expect(first).toContainText('No backup yet');
  const vmid = await first.getAttribute('data-bk-vm');
  await first.locator('[data-bk-now]').click();
  await expect(page.locator('.toast').last()).toContainText('Backup started');
  await expect(async () => {
    await page.locator('[data-admin-tab=backups]').click();
    await page.locator('[data-bk-view=runs]').click();
    await expect(page.locator('#bk-runs tbody tr').first()).toContainText('OK', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('#bk-runs tbody tr').first()).toContainText('Manual');

  // exclude it and include it again
  await page.locator('[data-bk-view=servers]').click();
  await page.locator('[data-bk-srv=all]').click();
  const row = page.locator(`#bk-servers tr[data-bk-vm="${vmid}"]`);
  await expect(row).toContainText('Protected');
  await row.locator('[data-bk-exclude]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('.toast').last()).toContainText('Excluded from backups');
  await expect(page.locator(`#bk-servers tr[data-bk-vm="${vmid}"]`)).toContainText('Excluded');
  await page.locator(`#bk-servers tr[data-bk-vm="${vmid}"] [data-bk-exclude]`).click();
  await expect(page.locator('.toast').last()).toContainText('Included in backups');

  // Leave the shared stack as found: no scheduler side effects for other specs.
  await page.locator('[data-bk-view=overview]').click();
  await page.locator('#bk-settings [name=enabled]').uncheck();
  await page.locator('#bk-settings button.primary').click();
  await expect(page.locator('.settings-head .pill')).toContainText('Off');
});

test('a customer backs up a server, browses the files, protects the backup and opens a restore', async ({ page, request }) => {
  // backups on (window not open now, so only the manual backup runs)
  const admin = await request.newContext?.({ baseURL: process.env.E2E_ADMIN_URL }) ?? request;
  const login = await admin.post(`${process.env.E2E_ADMIN_URL}/api/auth/login`, { data: { email: 'admin@example.com', password: 'correct-horse-battery' } });
  expect(login.ok()).toBeTruthy();
  const h = new Date().getUTCHours();
  const on = await admin.put(`${process.env.E2E_ADMIN_URL}/api/admin/backups/settings`, { data: { enabled: true, windowStart: (h + 3) % 24, windowEnd: (h + 5) % 24, manualPerDay: 2 } });
  expect(on.ok()).toBeTruthy();

  await page.goto(process.env.E2E_CUSTOMER_URL);
  await page.locator('#login-form [name=email]').fill('lena@example.com');
  await page.locator('#login-form [name=password]').fill('another-long-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#vm-list .unit[data-vmid="101"]').click();
  await page.locator('[data-tab=backups]').click();
  await expect(page.locator('.bk-status')).toContainText('Every day, keeps 7 daily');

  await page.locator('[data-bk-now]').click();
  await expect(page.locator('.toast').last()).toContainText('Backup started');
  await expect(page.locator('.bk-status')).toContainText('1 of 2 own backups left today', { timeout: 20_000 });
  await expect(page.locator('.bk-status')).not.toContainText('Running', { timeout: 20_000 });
  const point = page.locator('[data-bk-point]').first();
  await expect(point).toContainText('latest');

  // files
  await point.locator('[data-bk-browse]').click();
  await page.locator('.bk-browser [data-bk-path="/etc"]').click();
  const dl = page.locator('.bk-browser a[download]').first();
  await expect(dl).toHaveAttribute('href', /download\?path=%2Fetc%2Fhostname/);
  const [download] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  expect(download.suggestedFilename()).toBe('hostname');
  await page.locator('[data-bk-close]').click();

  // protect
  await point.locator('[data-bk-protect]').click();
  await expect(page.locator('.toast').last()).toContainText('Backup protected');
  await expect(page.locator('[data-bk-point]').first()).toContainText('protected');

  // restore: both ways are offered; cancel
  await page.locator('[data-bk-point]').first().locator('[data-bk-restore]').click();
  const f = page.locator('#bk-restore-form');
  await expect(f.locator('[name=hostname]')).toBeVisible();
  await expect(f.locator('[data-bk-first]')).toBeHidden();
  const replace = f.locator('[name=mode][value=replace]');
  if (await replace.isEnabled()) {
    await replace.check();
    await expect(f.locator('[data-bk-first]')).toBeVisible();
  }
  await f.locator('[data-bk-cancel]').click();
  await expect(page.locator('#bk-restore-form')).toHaveCount(0);

  // unprotect and switch backups off again for the other specs
  await page.locator('[data-bk-point]').first().locator('[data-bk-protect]').click();
  await expect(page.locator('.toast').last()).toContainText('Backup unprotected');
  expect((await admin.put(`${process.env.E2E_ADMIN_URL}/api/admin/backups/settings`, { data: { enabled: false } })).ok()).toBeTruthy();
});
