import { test, expect } from '@playwright/test';

test('UI: render assistant markdown + clickable source links', async ({ page }) => {
  test.setTimeout(120_000);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  await page.goto(baseUrl);

  await page
    .getByPlaceholder('Ask about NVIDIA blog posts...')
    .fill('What is DGX Spark?');
  await page.keyboard.press('Enter');

  // Wait for the assistant bubble to render real content
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-slot="aui_assistant-message-content"]');
      return !!el && (el.textContent || '').length > 200;
    },
    { timeout: 60_000 }
  );

  // Wait until a Sources link to nvidia.com appears (signals streaming complete)
  await page
    .waitForFunction(
      () => document.body.innerText.includes('blogs.nvidia.com'),
      { timeout: 60_000 }
    )
    .catch(() => {});

  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/ui-after-response.png', fullPage: true });

  const linkCount = await page
    .locator('[data-slot="aui_assistant-message-content"] a')
    .count();
  console.log('clickable links in assistant bubble:', linkCount);
  expect(linkCount).toBeGreaterThan(0);

  // Foldable tool call display should be present
  const toolCalls = await page.getByText(/tool calls?/i).count();
  expect(toolCalls).toBeGreaterThan(0);
});
