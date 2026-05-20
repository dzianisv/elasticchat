import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://elasticchat.vercel.app';

test.describe('ElasticChat E2E', () => {
  test('page loads with chat input', async ({ page }) => {
    await page.goto(BASE_URL);
    const input = page.getByPlaceholder('Ask about NVIDIA blog posts...');
    await expect(input).toBeVisible({ timeout: 15000 });
  });

  test('chat shows assistant response in real browser', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(BASE_URL);

    const input = page.getByPlaceholder('Ask about NVIDIA blog posts...');
    await expect(input).toBeVisible({ timeout: 15000 });

    await input.fill('What is DGX Spark?');
    await page.keyboard.press('Enter');

    // Wait for actual assistant text to render
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-slot="aui_assistant-message-content"]');
        return !!el && (el.textContent || '').length > 80;
      },
      { timeout: 60_000 }
    );

    const text = await page
      .locator('[data-slot="aui_assistant-message-content"]')
      .first()
      .innerText();

    expect(text.toLowerCase()).toMatch(/nvidia|dgx|spark|gpu/);
  });

  test('chat API returns streaming UIMessage response with citations', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/chat`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        id: 'test',
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [{ type: 'text', text: 'what latest gpu was released by nvidia' }],
          },
        ],
        trigger: 'submit-message',
      },
    });
    expect(response.ok()).toBeTruthy();

    const body = await response.text();
    const lines = body.split('\n').filter((l) => l.startsWith('data: '));
    let text = '';
    for (const line of lines) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'text-delta') text += data.delta;
      } catch {}
    }

    expect(text.length).toBeGreaterThan(50);
    expect(text.toLowerCase()).toMatch(/nvidia|gpu|rtx|geforce|blackwell|hopper|vera|rubin/i);
    expect(text.toLowerCase()).toMatch(/nvidia\.com|blogs\.nvidia/i);
  });
});
