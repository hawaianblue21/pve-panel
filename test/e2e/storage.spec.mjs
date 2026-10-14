// Block storage: the owner sets up tiers in the admin portal; a customer creates a
// volume on her server, enlarges it, detaches it (server shut down), attaches it
// again and finally deletes a detached volume.
import { test, expect } from '@playwright/test';

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('set up tiers, create, enlarge, detach, attach and delete a volume', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  await admin.locator('[data-admin-tab=volumes]').click();
  const f = admin.locator('#volume-settings');
  const first = f.locator('[data-tier-row]').first();
  await first.locator('[name=tierId]').fill('nvme');
  await first.locator('[name=name]').fill('NVMe');
  await first.locator('[name=storage]').fill('VMStorage');
  await first.locator('[name=pricePerGb]').fill('1500');
  await f.locator('[data-tier-add]').click();
  const second = f.locator('[data-tier-row]').nth(1);
  await second.locator('[name=tierId]').fill('archive');
  await second.locator('[name=name]').fill('Archive');
  await second.locator('[name=pricePerGb]').fill('300');
  await f.locator('[name=enabled]').check();
  await f.locator('button.primary').click();
  await expect(admin.locator('.toast').last()).toContainText('Block storage settings saved');

  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.request.post(`${process.env.E2E_CUSTOMER_URL}/api/vms/101/power/stop`);
  await customer.locator('#nav-storage').click();
  const form = customer.locator('#volume-form');
  await form.locator('[name=label]').fill('db-data');
  await form.locator('[name=vmid]').selectOption('101');
  await customer.locator('[data-size="100"]').click();
  await expect(form.locator('button.primary')).toContainText('Rp 150.000');
  await form.locator('button.primary').click();
  const row = customer.locator('tr[data-volume]', { hasText: 'db-data' });
  await expect(row).toContainText('100 GB');
  await expect(row).toContainText('Lena web');

  await row.locator('[data-vol-resize]').click();
  await customer.locator('#prompt-input').fill('150');
  await customer.locator('#prompt-ok').click();
  await expect(row).toContainText('150 GB');

  await expect(async () => {
    const s = await customer.request.get(`${process.env.E2E_CUSTOMER_URL}/api/vms/101`);
    expect((await s.json()).status).toBe('stopped');
  }).toPass();
  await row.locator('[data-vol-detach]').click();
  await customer.locator('#confirm-ok').click();
  await expect(row).toContainText('Not attached');

  await row.locator('[data-vol-attach]').click();
  await row.locator('[data-attach-go]').click();
  await expect(row).not.toContainText('Not attached');
  await expect(row.locator('.mono')).toHaveText('/dev/sdb');

  // a second, archive volume: detach and delete it
  await form.locator('[name=label]').fill('scratch');
  await form.locator('[name=vmid]').selectOption('101');
  await form.locator('input[name=tier][value=archive]').check();
  await form.locator('button.primary').click();
  const scratch = customer.locator('tr[data-volume]', { hasText: 'scratch' });
  await expect(scratch).toContainText('Archive');
  await scratch.locator('[data-vol-detach]').click();
  await customer.locator('#confirm-ok').click();
  await scratch.locator('[data-vol-delete]').click();
  await customer.locator('#prompt-input').fill('scratch');
  await customer.locator('#prompt-ok').click();
  await expect(customer.locator('tr[data-volume]', { hasText: 'scratch' })).toHaveCount(0);

  await admin.locator('[data-admin-tab=volumes]').click();
  await expect(admin.locator('.volumes-admin table').first()).toContainText('lena@example.com');
  await expect(admin.locator('.volumes-admin table').first()).toContainText('db-data');
});
