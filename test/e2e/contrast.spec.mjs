// Every visible text must be readable (WCAG AA: 4.5:1, large text 3:1) in every
// color scheme, in light and dark mode — measured on the rendered pages.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const audit = fs.readFileSync(new URL('../support/contrast-audit.js', import.meta.url), 'utf8');
const SCHEMES = ['harbor', 'forest', 'ember', 'orchid', 'graphite'];
const C = () => process.env.E2E_CUSTOMER_URL;
const A = () => process.env.E2E_ADMIN_URL;
// All browser tests share one IP and sign-in allows 10 per minute: wait out a 429.
async function login(page, url, data) {
  for (let i = 0; i < 8; i += 1) {
    const r = await page.request.post(`${url}/api/auth/login`, { data });
    if (r.status() !== 429) { expect(r.ok()).toBeTruthy(); return; }
    await page.waitForTimeout(10_000);
  }
  throw new Error('sign-in stayed rate limited');
}

for (const mode of ['light', 'dark']) {
  test(`text contrast in every color scheme (${mode} mode)`, async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await (await browser.newContext({ colorScheme: mode })).newPage();
    await login(admin, A(), { email: 'admin@example.com', password: 'correct-horse-battery' });
    const customer = await (await browser.newContext({ colorScheme: mode })).newPage();
    await login(customer, C(), { email: 'lena@example.com', password: 'another-long-password' });
    const visitor = await (await browser.newContext({ colorScheme: mode })).newPage();

    const problems = [];
    const check = async (page, scheme, where) => {
      for (const p of await page.evaluate(audit)) problems.push(`${scheme}/${mode} ${where}: “${p.text}” ${p.ratio}:1 (needs ${p.need}:1)`);
    };
    try {
      for (const scheme of SCHEMES) {
        const r = await admin.request.put(`${A()}/api/admin/settings/appearance`, { data: { scheme } });
        expect(r.ok()).toBeTruthy();

        await visitor.goto(C());
        await expect(visitor.locator('html')).toHaveAttribute('data-scheme', scheme);
        await expect(visitor.locator('#login-form [name=email]')).toBeVisible();
        await check(visitor, scheme, 'sign-in');

        await customer.goto(C());
        await expect(customer.locator('html')).toHaveAttribute('data-scheme', scheme);
        await expect(customer.locator('.server-row').first()).toBeVisible();
        await check(customer, scheme, 'overview');
        await customer.locator('.server-row[data-vmid="101"]').click();
        await expect(customer.locator('.specs')).toBeVisible();
        await check(customer, scheme, 'server page');

        await customer.locator('#nav-account').click();
        await expect(customer.locator('.security-card').first()).toBeVisible();
        await check(customer, scheme, 'account');
        await customer.locator('#new-server').click();
        await expect(customer.locator('#create-form')).toBeVisible();
        await customer.locator('#create-form [name=hostname]').fill('contrast-check');
        await check(customer, scheme, 'new server form');

        await admin.goto(A());
        await expect(admin.locator('.overview .node-table')).toBeVisible();
        await check(admin, scheme, 'admin overview');
        for (const [tab, ready] of [['servers', '#vm-rows tr'], ['hosts', '.hosts .node-table'], ['users', 'tr[data-user]'], ['settings', '#email-form'], ['account', '.security-card'], ['about', '.about']]) {
          await admin.locator(`[data-admin-tab=${tab}]`).click();
          await expect(admin.locator(ready).first()).toBeVisible();
          await check(admin, scheme, `admin ${tab}`);
        }
      }
    } finally {
      await admin.request.put(`${A()}/api/admin/settings/appearance`, { data: { scheme: 'harbor' } });
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}
