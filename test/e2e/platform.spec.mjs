// Account → Appearance and Sign-in methods; Settings → Branding and Single sign-on; Activity filters.
import { test, expect } from '@playwright/test';

async function signInCustomer(page) {
  await page.goto(process.env.E2E_CUSTOMER_URL);
  await page.locator('#login-form [name=email]').fill('lena@example.com');
  await page.locator('#login-form [name=password]').fill('another-long-password');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}
async function signInAdmin(page) {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('a customer picks their own scheme and dark mode; it sticks after a reload', async ({ page }) => {
  await signInCustomer(page);
  await page.locator('#nav-account').click();
  await page.locator('[data-my-mode="dark"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.locator('[data-my-scheme="orchid"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'orchid');
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  expect(bg).not.toBe('#f3f0f8');                                     // the dark variant, not the light one
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'orchid');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  // back to the panel default
  await page.locator('#nav-account').click();
  await page.locator('[data-my-scheme=""]').click();
  await page.locator('[data-my-mode="system"]').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-mode', /./);
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'harbor');
});

test('branding: name and logo from Settings appear on the customer sign-in page', async ({ browser }) => {
  const admin = await browser.newPage();
  await signInAdmin(admin);
  await admin.locator('[data-admin-tab=settings]').click();
  await admin.locator('#branding-form [name=name]').fill('Acme Cloud');
  await admin.locator('#branding-form [name=supportUrl]').fill('mailto:help@example.com');
  await admin.locator('#branding-form button.primary').click();
  await expect(admin.locator('.toast').last()).toContainText('Branding saved');
  await admin.locator('[data-brand-upload="logo"]').setInputFiles({
    name: 'logo.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="#0d7068"/></svg>'),
  });
  await expect(admin.locator('.branding-preview img').first()).toBeVisible();

  const customer = await browser.newPage();
  await customer.goto(process.env.E2E_CUSTOMER_URL);
  await expect(customer.locator('.login-box [data-brand]')).toHaveText('Acme Cloud');
  await expect(customer.locator('.login-art img.brand-logo')).toBeVisible();
  expect(await customer.locator('.login-art img.brand-logo').evaluate((i) => i.naturalWidth > 0 && i.getBoundingClientRect().height === 30)).toBe(true);
  await expect(customer.locator('[data-support-link]').first()).toHaveAttribute('href', 'mailto:help@example.com');
  await expect(customer).toHaveTitle(/Acme Cloud/);

  // back to the defaults
  await admin.locator('[data-brand-remove="logo"]').click();
  await admin.locator('#branding-form [name=name]').fill('');
  await admin.locator('#branding-form [name=supportUrl]').fill('');
  await admin.locator('#branding-form button.primary').click();
  await expect(admin.locator('.branding-preview').first()).toContainText('Built-in');
});

test('single sign-on providers are listed in Settings; switching one on needs its secret', async ({ page }) => {
  await signInAdmin(page);
  await page.locator('[data-admin-tab=settings]').click();
  await expect(page.locator('form[data-sso]')).toHaveCount(3);
  const google = page.locator('form[data-sso="google"]');
  await google.locator('[name=clientId]').fill('abc.apps.googleusercontent.com');
  await google.locator('[name=enabled]').check();
  await google.locator('button.primary').click();
  await expect(page.locator('.toast').last()).toContainText('client ID and secret');
});

test('activity: filter by customers and open an event', async ({ page }) => {
  await signInAdmin(page);
  await page.locator('[data-admin-tab=activity]').click();
  await page.locator('#activity-filter [name=actor]').selectOption('customer');
  await page.locator('#activity-filter button.btn:not(.ghost)').click();
  const first = page.locator('tr[data-activity]').first();
  await expect(first).toContainText('Customer');
  await first.click();
  await expect(page.locator('.activity-more')).toContainText('Event');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
});
