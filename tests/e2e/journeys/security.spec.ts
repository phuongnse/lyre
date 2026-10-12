import { expect, test } from '@playwright/test'
import { coreVersion } from './core-version'

test('the page sets its policy first in <head> and logs no error or violation', async ({ page }) => {
  // A CSP or Trusted Types violation is logged to the console as an error.
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))

  await page.goto('/')
  await expect(page.getByText(`Lyre core ${coreVersion()}`)).toBeVisible()

  const first = await page.evaluate(() => {
    const element = document.head.firstElementChild
    return {
      httpEquiv: element?.getAttribute('http-equiv'),
      content: element?.getAttribute('content'),
    }
  })
  expect(first.httpEquiv).toBe('Content-Security-Policy')
  expect(first.content).toContain("require-trusted-types-for 'script'")
  expect(problems).toEqual([])
})

test('the page refuses markup that script assigns as a string', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(`Lyre core ${coreVersion()}`)).toBeVisible()
  await expect(
    page.evaluate(() => {
      document.body.innerHTML = '<b>x</b>'
    }),
  ).rejects.toThrow(/TrustedHTML/)
})
