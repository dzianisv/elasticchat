import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://elasticchat.vercel.app';

test('replay: /?q=... auto-sends the question', async ({ page }) => {
  test.setTimeout(120_000);

  const q = 'What is CUDA?';
  await page.goto(`${BASE_URL}/?q=${encodeURIComponent(q)}`);

  // The user message bubble should appear without the user typing anything.
  await page.waitForFunction(
    (txt) => {
      const userBubbles = document.querySelectorAll(
        '[data-slot="aui_user-message-root"]',
      );
      for (const u of userBubbles) {
        if ((u.textContent || '').includes(txt)) return true;
      }
      return false;
    },
    q,
    { timeout: 30_000 },
  );

  // And the assistant should respond with non-empty content.
  await page.waitForFunction(
    () => {
      const el = document.querySelector(
        '[data-slot="aui_assistant-message-content"]',
      );
      return !!el && (el.textContent || '').length > 80;
    },
    { timeout: 60_000 },
  );

  await page.screenshot({
    path: 'test-results/replay-after.png',
    fullPage: true,
  });
});

test('latest GPU question: answer mentions a GPU, not just a CPU', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(BASE_URL);

  await page
    .getByPlaceholder('Ask about NVIDIA blog posts...')
    .fill('When was the latest NVIDIA GPU released?');
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => {
      const el = document.querySelector(
        '[data-slot="aui_assistant-message-content"]',
      );
      return !!el && (el.textContent || '').length > 200;
    },
    { timeout: 90_000 },
  );

  const text = (
    await page
      .locator('[data-slot="aui_assistant-message-content"]')
      .first()
      .innerText()
  ).toLowerCase();

  console.log('=== latest-GPU answer ===');
  console.log(text);

  // The answer must mention an actual GPU product, not just a CPU/platform.
  expect(text).toMatch(
    /(geforce|rtx|blackwell|hopper|ampere|ada|rubin|b\d{3}|h\d{3}|a\d{3}|rtx pro|gpu)/i,
  );

  // Sanity: it should not claim the latest *GPU* is a CPU.
  expect(text).not.toMatch(/latest\s+(nvidia\s+)?gpu[^.]*?\b(vera|grace|bluefield)\b/i);

  await page.screenshot({
    path: 'test-results/gpu-answer.png',
    fullPage: true,
  });
});

test('eval page: lists test cases + replay links', async ({ page }) => {
  await page.goto(`${BASE_URL}/eval`);

  await expect(page.getByRole('heading', { name: /G-Eval results/i })).toBeVisible();

  const replayLinks = await page
    .getByRole('link', { name: /Replay/i })
    .count();
  expect(replayLinks).toBeGreaterThan(0);

  // The first replay link should target the chat with a ?q= param
  const firstHref = await page
    .getByRole('link', { name: /Replay/i })
    .first()
    .getAttribute('href');
  expect(firstHref).toMatch(/\/\?q=/);

  await page.screenshot({ path: 'test-results/eval-page.png', fullPage: true });
});
