import { expect, Page, test } from '@playwright/test'
import { Authenticator, encodingsOf, expectNotInPage, openWith as open, returnedPrf } from './webauthn'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })

const PATH = '/#/passkey-check'

// Opens the passkey check page with a virtual platform authenticator.
const openWith = (page: Page, authenticator: Authenticator) => open(page, PATH, authenticator)

// Runs the check and waits for `result`, with the user agent shown before and after.
async function runCheck(page: Page, result: string): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent)
  await expect(page.getByText(userAgent)).toBeVisible()
  await page.getByRole('button', { name: 'Run the check' }).click()
  await expect(page.getByRole('status')).toHaveText(result)
  await expect(page.getByText(userAgent)).toBeVisible()
}

// Checks that no encoding of the PRF output reached the page, its storage or
// the console. When `returned`, the authenticator must have given 32 bytes.
async function expectNoLeak(page: Page, consoleMessages: string[], returned: boolean): Promise<void> {
  const output = await returnedPrf(page)
  if (returned) expect(output).toHaveLength(32)
  else expect(output).toBeUndefined()

  if (output !== undefined) await expectNotInPage(page, consoleMessages, encodingsOf(output))

  const stored = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    databases: (await indexedDB.databases()).length,
    cookie: document.cookie,
  }))
  expect(stored).toEqual({ local: 0, session: 0, databases: 0, cookie: '' })
}

test('a device-bound passkey with PRF works', async ({ page }) => {
  const consoleMessages = await openWith(page, { hasPrf: true, backupEligible: false })
  await runCheck(page, 'Works: this device-bound passkey returned a PRF output.')
  await expect(page.getByText('Backup eligible: no')).toBeVisible()
  await expectNoLeak(page, consoleMessages, true)
})

test('a backup-eligible passkey is refused because it can sync', async ({ page }) => {
  const consoleMessages = await openWith(page, { hasPrf: true, backupEligible: true })
  await runCheck(page, 'Refused: this passkey can sync to other devices.')
  await expect(page.getByText('Backup eligible: yes')).toBeVisible()
  await expectNoLeak(page, consoleMessages, false)
})

test('a passkey without PRF reports PRF missing', async ({ page }) => {
  const consoleMessages = await openWith(page, { hasPrf: false, backupEligible: false })
  await runCheck(page, 'PRF missing: this passkey returned no PRF output.')
  await expect(page.getByText('Backup eligible: no')).toBeVisible()
  await expectNoLeak(page, consoleMessages, false)
})
