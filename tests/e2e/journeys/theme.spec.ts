import { expect, test } from '@playwright/test'

test.use({ colorScheme: 'light' })

test('the page uses the Material 3 theme from the seed colour', async ({ page }) => {
  await page.goto('/')
  const primary = await page.evaluate(() => {
    document.body.style.outlineColor = 'var(--mat-sys-primary)'
    return getComputedStyle(document.body).outlineColor
  })
  // Known answer: primary tone 40 generated from the seed #6B5778 is #6b5778
  // (web/src/_theme-colors.scss), the light scheme's primary colour.
  expect(primary).toBe('rgb(107, 87, 120)')
})
