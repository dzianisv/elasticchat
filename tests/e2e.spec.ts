import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://elasticchat.vercel.app';

test.describe('ElasticChat E2E', () => {
  test('page loads with chat input', async ({ page }) => {
    await page.goto(BASE_URL);
    const input = page.getByPlaceholder('Ask about NVIDIA blog posts...');
    await expect(input).toBeVisible({ timeout: 15000 });
  });

  test('chat input accepts text and send button works', async ({ page }) => {
    await page.goto(BASE_URL);
    const input = page.getByPlaceholder('Ask about NVIDIA blog posts...');
    await expect(input).toBeVisible({ timeout: 15000 });

    // Verify send button is disabled when empty
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeDisabled();

    // Type and verify send button enables
    await input.fill('what is NVIDIA');
    await expect(sendBtn).toBeEnabled();

    // Submit and verify user message appears
    await sendBtn.click();
    await expect(page.locator('.justify-end .rounded-lg')).toBeVisible({ timeout: 5000 });

    // Verify "Thinking..." indicator appears (streaming started)
    await expect(page.locator('text=Thinking...')).toBeVisible({ timeout: 10000 });
  });

  test('chat API returns streaming response with citations', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/chat`, {
      headers: { 'Content-Type': 'application/json' },
      data: { messages: [{ role: 'user', content: 'what latest gpu was released by nvidia' }] },
    });
    expect(response.ok()).toBeTruthy();

    const body = await response.text();
    // Parse SSE text-deltas
    const lines = body.split('\n').filter(l => l.startsWith('data: '));
    let text = '';
    for (const line of lines) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'text-delta') text += data.delta;
      } catch {}
    }

    console.log('API response:', text.slice(0, 200));
    expect(text.length).toBeGreaterThan(50);
    expect(text.toLowerCase()).toMatch(/nvidia|gpu|rtx|geforce|blackwell|hopper|vera|rubin/i);
    expect(text.toLowerCase()).toMatch(/nvidia\.com|blogs\.nvidia/i);
  });
});
