import { expect, test } from '@playwright/test'
import { coreVersion } from './core-version'

// GitHub Pages serves the site from /lyre/. Routes live after the # in the URL.
test('the app works from the /lyre/ sub-path, deep links included', async ({ page }) => {
  const failures: string[] = []
  page.on('requestfailed', (request) => failures.push(`${request.url()} ${request.failure()?.errorText}`))
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.url()} ${response.status()}`)
  })

  for (const path of ['/lyre/', '/lyre/#/no/such/page']) {
    await page.goto(path)
    await expect(page.getByText(`Lyre core ${coreVersion()}`)).toBeVisible()
  }
  expect(failures).toEqual([])
})
