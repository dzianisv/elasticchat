import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

test.describe('Ingestion dashboard', () => {
  test('renders heading and either a row or empty state', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`${BASE_URL}/ingest`)

    // The page must surface an "Ingestion" heading regardless of ES state.
    const heading = page.getByRole('heading', { name: /ingestion/i }).first()
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // Either we have at least one article row, OR a clear empty-state card.
    const rows = page.getByTestId('ingestion-row')
    const empty = page.getByText(/no crawl-state entries/i)

    await expect(async () => {
      const rowCount = await rows.count()
      const emptyVisible = await empty.isVisible().catch(() => false)
      expect(rowCount > 0 || emptyVisible).toBeTruthy()
    }).toPass({ timeout: 15_000 })

    // The dashboard explains where the cadence comes from.
    await expect(page.getByText(/02:00 UTC/i)).toBeVisible()
  })

  test('header links back to chat and over to G-Eval', async ({ page }) => {
    await page.goto(`${BASE_URL}/ingest`)
    await expect(page.getByRole('link', { name: /chat/i }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: /g-eval/i }).first()).toBeVisible()
  })
})
