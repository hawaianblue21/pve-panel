// AI assistant: the owner switches it on in Settings, a customer asks, gets an
// answer with its source, and hands the problem over as a ticket.
import { test, expect } from '@playwright/test';
import { startMockLlm } from '../support/mock-llm.mjs';

let llm;
test.beforeAll(async () => { llm = await startMockLlm(); });
test.afterAll(async () => { await llm?.close(); });

async function signIn(page, url, email, password) {
  await page.goto(url);
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app-view')).toBeVisible();
}

test('owner switches the assistant on; a customer gets an answer with its source and creates a ticket from it', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin, process.env.E2E_ADMIN_URL, 'admin@example.com', 'correct-horse-battery');
  await admin.request.post(`${process.env.E2E_ADMIN_URL}/api/admin/kb`, {
    data: { title: 'Website unreachable after a restart', category: 'Network', status: 'published', body: 'Run `sudo netplan apply`.' },
  });
  await admin.locator('[data-admin-tab=settings]').click();
  const f = admin.locator('#ai-form');
  await f.locator('[name=provider]').selectOption('anthropic');
  await f.locator('[name=baseUrl]').fill(llm.url);
  await f.locator('[name=apiKey]').fill(llm.apiKey);
  await f.locator('[name=enabled]').check();
  await f.locator('button.primary').click();
  await expect(admin.locator('.toast').last()).toContainText('AI assistant is on');
  await admin.locator('[data-ai-test]').click();
  await expect(admin.locator('.toast').last()).toContainText('Hello from the model');

  const customer = await browser.newPage();
  await signIn(customer, process.env.E2E_CUSTOMER_URL, 'lena@example.com', 'another-long-password');
  await customer.locator('#nav-assistant').click();
  await customer.locator('.chip').first().click();                              // "My website is not reachable after a restart"
  await expect(customer.locator('.chat-assistant .chat-bubble').last()).toContainText('Website unreachable after a restart');
  await expect(customer.locator('.chat-sources a')).toHaveAttribute('href', /#help\/website-unreachable-after-a-restart/);

  await customer.locator('#chat-input').fill('I think it was hacked, I want a person');
  await customer.locator('#chat-input').press('Enter');
  await expect(customer.locator('.handover-card')).toContainText('Server may be hacked');
  await customer.locator('[data-handover]').click();
  await customer.locator('#confirm-ok').click();
  await expect(customer.locator('.conversation .msg').first()).toContainText('Conversation with the assistant');

  await admin.locator('[data-admin-tab=ai]').click();
  await admin.locator('[data-open-ai]').first().click();
  await expect(admin.locator('.desk-detail')).toContainText('propose_ticket');
});
