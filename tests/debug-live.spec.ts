import { test, expect } from '@playwright/test';

test('debug: real user flow on live site', async ({ page }) => {
  test.setTimeout(120_000);

  const consoleLines: string[] = [];
  const networkRequests: string[] = [];
  const networkResponses: Array<{ url: string; status: number; body?: string }> = [];

  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));
  page.on('request', (req) => {
    if (req.url().includes('/api/')) networkRequests.push(`${req.method()} ${req.url()}`);
  });
  page.on('response', async (resp) => {
    if (resp.url().includes('/api/')) {
      let body = '';
      try {
        body = (await resp.text()).slice(0, 2000);
      } catch {}
      networkResponses.push({ url: resp.url(), status: resp.status(), body });
    }
  });

  const baseUrl = process.env.BASE_URL || 'https://elasticchat.vercel.app';
  await page.goto(baseUrl);
  await page.screenshot({ path: 'test-results/01-initial.png', fullPage: true });

  const input = page.getByPlaceholder('Ask about NVIDIA blog posts...');
  await expect(input).toBeVisible({ timeout: 15000 });

  await input.fill('When recent nvidia gpu were released?');
  await page.screenshot({ path: 'test-results/02-typed.png', fullPage: true });

  await page.keyboard.press('Enter');

  // Wait for actual assistant text to land. The assistant-ui Thread renders
  // assistant messages with data-slot="aui_assistant-message-content".
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-slot="aui_assistant-message-content"]')
      return el && (el.textContent || '').length > 80
    },
    { timeout: 60000 }
  ).catch(() => {})

  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/03-after-send.png', fullPage: true });

  const allText = await page.evaluate(() => document.body.innerText);
  const assistantBubbles = await page
    .locator('[data-slot="aui_assistant-message-content"]')
    .allInnerTexts();

  console.log('=== ALL VISIBLE TEXT ===');
  console.log(allText);
  console.log('=== ASSISTANT BUBBLES (.justify-start .rounded-lg) ===');
  console.log(JSON.stringify(assistantBubbles, null, 2));
  console.log('=== CONSOLE LINES ===');
  console.log(consoleLines.join('\n'));
  console.log('=== /api/* REQUESTS ===');
  console.log(networkRequests.join('\n'));
  console.log('=== /api/* RESPONSES (status only) ===');
  for (const r of networkResponses) {
    console.log(`${r.status} ${r.url}`);
  }
  console.log('=== FIRST /api/chat RESPONSE BODY (first 2000 chars) ===');
  const chatResp = networkResponses.find((r) => r.url.includes('/api/chat'));
  console.log(chatResp?.body || '(no /api/chat response captured)');
});
