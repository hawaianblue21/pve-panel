// Support: a customer opens a ticket from the server page, an agent answers in
// the ticket desk, the customer sees the answer; the help center finds articles.
import { test, expect } from '@playwright/test';

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('ticket: customer asks about a server, agent answers with a note and a reply, customer sees only the reply', async ({ browser }) => {
  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.locator('.unit[data-vmid="101"]').click();
  await customer.locator('[data-help-server]').click();
  await expect(customer.locator('#ticket-form [name=vmid]')).toHaveValue('101');
  await customer.locator('#ticket-form [name=subject]').fill('Website down after restart');
  await customer.locator('#ticket-form [name=body]').fill('Since this morning the site on web01 does not answer.');
  await customer.locator('#ticket-form [name=priority]').selectOption('high');
  await customer.locator('#ticket-form button.primary').click();
  await expect(customer.locator('.conversation .msg')).toHaveCount(1);
  const number = (await customer.locator('.lede .mono').textContent()).replace('#', '');

  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  await admin.locator('[data-admin-tab=tickets]').click();
  await admin.locator(`[data-open-ticket="${number}"]`).click();
  await expect(admin.locator('.desk-side')).toContainText('lena@example.com');
  await admin.locator('#desk-reply [name=body]').fill('Checked the firewall: rule missing.');
  await admin.locator('#desk-reply [name=internal]').check();
  await admin.locator('#desk-reply button.primary').click();
  await expect(admin.locator('.msg-internal')).toContainText('rule missing');
  await admin.locator('#desk-reply [name=body]').fill('Please run `sudo netplan apply`, then try again.');
  await admin.locator('#desk-reply button.primary').click();
  await expect(admin.locator('.conversation .msg')).toHaveCount(3);
  await expect(admin.locator('[data-ticket-field=status]')).toHaveValue('waiting');

  await customer.reload();
  await expect(customer.locator('#nav-support .nav-badge')).toHaveText('1');
  await expect(customer.locator('.conversation')).toContainText('sudo netplan apply');
  await expect(customer.locator('.conversation')).not.toContainText('rule missing');
  await expect(customer.locator('.conversation code')).toHaveText('sudo netplan apply');
  await customer.locator('#reply-form [name=body]').fill('That fixed it, thank you!');
  await customer.locator('#reply-form button.primary').click();
  await expect(customer.locator('.conversation .msg')).toHaveCount(3);
  await expect(customer.locator('#nav-support .nav-badge')).toHaveCount(0);
});

test('knowledge base: an agent publishes an article, the customer finds it, votes, and misses are listed', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  await admin.locator('[data-admin-tab=kb]').click();
  await admin.locator('[data-kb-new]').click();
  await admin.locator('#kb-form [name=title]').fill('Take a snapshot before risky changes');
  await admin.locator('#kb-form [name=category]').fill('Servers');
  await admin.locator('#kb-form [name=body]').fill('## Steps\n1. Open the server\n2. Choose **Snapshots** and take one');
  await admin.locator('[data-kb-mode=preview]').click();
  await expect(admin.locator('.kb-preview strong')).toHaveText('Snapshots');
  await admin.locator('#kb-form [name=status]').selectOption('published');
  await admin.locator('#kb-form button.primary').click();
  await expect(admin.locator('.toast').last()).toContainText('published');

  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.locator('#nav-help').click();
  await expect(customer.locator('.help-grid')).toContainText('Take a snapshot before risky changes');
  await customer.locator('#help-search [name=q]').fill('snapshot');
  await customer.locator('#help-search button').click();
  await customer.locator('.help-results a').first().click();
  await expect(customer.locator('.kb-article h4')).toHaveText('Steps');
  await customer.locator('[data-kb-vote=yes]').click();
  await expect(customer.locator('.kb-feedback')).toContainText('Thanks');
  await customer.locator('#nav-help').click();
  await customer.locator('#help-search [name=q]').fill('mount an nfs share');
  await customer.locator('#help-search button').click();
  await expect(customer.locator('#help-results')).toContainText('Nothing found');

  await admin.locator('[data-kb-back]').click();
  await expect(admin.locator('.gap-row')).toContainText('mount an nfs share');
});
