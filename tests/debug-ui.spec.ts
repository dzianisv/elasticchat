import { test, expect } from '@playwright/test';

test('UI: render assistant markdown + clickable links', async ({ page }) => {
  test.setTimeout(120_000);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  await page.goto(baseUrl);

  await page.getByPlaceholder('Ask about NVIDIA blog posts...').fill('What is DGX Spark?');
  await page.getByRole('button', { name: 'Send' }).click();

  // Wait for at least one assistant bubble to appear with non-trivial content
  await page.waitForFunction(
    () => {
      const bubbles = document.querySelectorAll('.justify-start')
      for (const b of Array.from(bubbles)) {
        if ((b.textContent || '').length > 150) return true
      }
      return false
    },
    { timeout: 60_000 }
  );

  // Wait for the Sources section to appear (signals streaming complete)
  await page.waitForFunction(
    () => document.body.innerText.includes('blogs.nvidia.com'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/ui-after-response.png', fullPage: true });

  const linkCount = await page.locator('.justify-start a').count();
  console.log('clickable links in assistant bubble:', linkCount);
  expect(linkCount).toBeGreaterThan(0);
});
