// Billing: the owner sets up tax, bank transfer and Xendit; a customer tops up the
// wallet through the (simulated) Xendit page, renews a server for 3 months from
// the wallet, renews again by bank transfer, and finance confirms the transfer.
import { test, expect } from '@playwright/test';

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('set up billing, top up with Xendit, renew from the wallet and by bank transfer', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  const in20days = new Date(Date.now() + 20 * 86_400_000).toISOString();
  await admin.request.put(`${process.env.E2E_ADMIN_URL}/api/admin/vms/101/expiry`, { data: { expiresAt: in20days } });

  await admin.locator('[data-admin-tab=settings]').click();
  const f = admin.locator('#billing-settings-form');
  const xendit = JSON.parse(process.env.E2E_XENDIT);
  await f.locator('[name=companyName]').fill('Acme Cloud');
  await f.locator('[name=bankEnabled]').check();
  await f.locator('[name=bankInstructions]').fill('BCA 123-456-7890 a.n. Acme Cloud');
  await f.locator('[name=xenditSecretKey]').fill(xendit.secretKey);
  await f.locator('[name=xenditCallbackToken]').fill(xendit.callbackToken);
  await f.locator('[name=xenditEnabled]').check();
  await f.locator('[name=enabled]').check();
  await f.locator('button.primary').click();
  await expect(admin.locator('.toast').last()).toContainText('billing is on');
  await expect(admin.locator('#billing-settings-form [name=xenditSecretKey]')).toHaveAttribute('placeholder', /Stored/);

  // customer: wallet top-up through the payment page
  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.locator('#nav-billing').click();
  await expect(customer.locator('[data-server="101"]')).toContainText('Rp 230.000');
  await customer.locator('#topup-amount').fill('1000000');
  await customer.locator('#topup-form button').click();
  await expect(customer.locator('.invoice-doc')).toContainText('Wallet top-up');
  await customer.locator('input[name=method][value=xendit]').check();
  await customer.locator('#pay-btn').click();
  await customer.waitForURL(/\/checkout\//);
  await expect(customer.locator('h1')).toHaveText('Test checkout');
  await customer.locator('#mock-pay').click();
  await expect(customer.locator('.invoice-doc .tag')).toHaveText('Paid', { timeout: 20_000 });

  // renew 3 months from the wallet (5% discount, PPN 11%)
  await customer.locator('.back-link').click();
  await expect(customer.locator('[data-balance]')).toHaveText('Rp 1.000.000');
  const row = customer.locator('[data-server="101"]');
  await row.locator('[data-months="3"]').click();
  await expect(row.locator('[data-renew]')).toContainText('Rp 727.605');
  await row.locator('[data-renew]').click();
  await expect(customer.locator('.invoice-lines')).toContainText('Discount 5% for 3 months');
  await expect(customer.locator('.invoice-total')).toContainText('Rp 727.605');
  await customer.locator('input[name=method][value=wallet]').check();
  await customer.locator('#pay-btn').click();
  await customer.locator('#confirm-ok').click();
  await expect(customer.locator('.notice')).toContainText('end date has moved');

  // renew 1 month by bank transfer and report it
  await customer.locator('.back-link').click();
  await customer.locator('[data-server="101"] [data-renew]').click();
  await customer.locator('input[name=method][value=bank]').check();
  await expect(customer.locator('.bank-instructions')).toContainText('BCA 123-456-7890');
  await customer.locator('.bank-box [name=reference]').fill('BCA 14/10 09:12');
  await customer.locator('#pay-btn').click();
  await expect(customer.locator('.invoice-page')).toContainText('You reported a transfer');

  // the administrator confirms it
  await admin.locator('[data-admin-tab=billing]').click();
  await admin.locator('[data-billing-status=reported]').click();
  await admin.locator('tr[data-billing-invoice]').first().click();
  await expect(admin.locator('#billing-mark-paid [name=reference]')).toHaveValue('BCA 14/10 09:12');
  await admin.locator('#billing-mark-paid button').click();
  await admin.locator('#confirm-ok').click();
  await expect(admin.locator('.invoice-head .tag')).toHaveText('Paid');

  await customer.reload();
  await expect(customer.locator('.invoice-doc .tag')).toHaveText('Paid');
});
