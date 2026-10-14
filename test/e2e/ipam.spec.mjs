// Public IPv4: the owner adds a pool and switches public IPs on; a customer adds
// an address to her server, sets reverse DNS and releases it again.
import { test, expect } from '@playwright/test';

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('add a pool, give a server a public address, set reverse DNS, release it', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  await admin.locator('[data-admin-tab=ipam]').click();
  await admin.locator('[data-ipam-add]').click();
  const f = admin.locator('#ipam-pool-form');
  await f.locator('[name=name]').fill('Public A');
  await f.locator('[name=cidr]').fill('198.51.100.0/28');
  await f.locator('[name=gateway]').fill('198.51.100.1');
  await f.locator('[name=bridge]').fill('vmbr1');
  await f.locator('[name=priceMonthly]').fill('50000');
  await f.locator('button.primary').click();
  await expect(admin.locator('[data-ipam-back]')).toBeVisible();
  await expect(admin.locator('.ipam-admin .section-head h2')).toContainText('Public A');
  await admin.locator('[data-ipam-back]').click();
  const s = admin.locator('#ipam-settings');
  await s.locator('[name=enabled]').check();
  await s.locator('button.primary').click();
  await expect(admin.locator('.toast').last()).toContainText('Public IP settings saved');

  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.locator('#vm-list .unit[data-vmid="101"]').click();
  const card = customer.locator('#public-ips');
  await expect(card.locator('[data-ip-add]')).toContainText('Rp 50.000');
  await card.locator('[data-ip-add]').click();
  await customer.locator('#confirm-ok').click();
  const row = card.locator('tr[data-ip]');
  await expect(row).toContainText('198.51.100.2/28');
  await expect(row).toContainText('Set up inside the server');          // this VM has no cloud-init
  await expect(card.locator('.ip-manual')).toContainText('255.255.255.240');

  await row.locator('[data-ip-ptr]').click();
  await customer.locator('#prompt-input').fill('web.example.com');
  await customer.locator('#prompt-ok').click();
  await expect(row).toContainText('web.example.com');

  await admin.locator('tr[data-ipam-pool]').first().click();
  await admin.locator('[data-ipam-state=assigned]').click();
  await expect(admin.locator('tr[data-ipam-address]')).toHaveCount(1);
  await expect(admin.locator('tr[data-ipam-address]')).toContainText('lena@example.com');
  await expect(admin.locator('tr[data-ipam-address]')).toContainText('web.example.com');

  await row.locator('[data-ip-release]').click();
  await customer.locator('#confirm-ok').click();
  await expect(card.locator('tr[data-ip]')).toHaveCount(0);
});
