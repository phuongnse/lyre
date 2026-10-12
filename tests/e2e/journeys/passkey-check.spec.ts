import { expect, Page, test } from '@playwright/test'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })

declare global {
  interface Window {
    // The PRF output the authenticator returned, copied before the page wipes it.
    __testPrf?: number[]
  }
}

type Authenticator = { hasPrf: boolean; backupEligible: boolean }

// Opens the passkey check page with a virtual platform authenticator, and
// returns the text of every console message the page writes.
async function openWith(page: Page, { hasPrf, backupEligible }: Authenticator): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf,
      defaultBackupEligibility: backupEligible,
      defaultBackupState: false,
    },
  })
  await page.addInitScript(() => {
    const original = PublicKeyCredential.prototype.getClientExtensionResults
    PublicKeyCredential.prototype.getClientExtensionResults = function () {
      const results = original.call(this)
      const first = results.prf?.results?.first
      if (first !== undefined) {
        const bytes = ArrayBuffer.isView(first)
          ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
          : new Uint8Array(first)
        window.__testPrf = Array.from(bytes)
      }
      return results
    }
  })
  const messages: string[] = []
  page.on('console', (message) => messages.push(message.text()))
  await page.goto('/#/passkey-check')
  return messages
}

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
  const output = await page.evaluate(() => window.__testPrf)
  if (returned) expect(output).toHaveLength(32)
  else expect(output).toBeUndefined()

  if (output !== undefined) {
    const bytes = Buffer.from(output)
    const encodings = [
      bytes.toString('hex'),
      bytes.toString('hex').toUpperCase(),
      bytes.toString('base64'),
      bytes.toString('base64url'),
      output.join(','),
    ]
    const text = await page.evaluate(() => document.body.innerText)
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    for (const encoding of encodings) {
      expect(text).not.toContain(encoding)
      expect(html).not.toContain(encoding)
      for (const message of consoleMessages) expect(message).not.toContain(encoding)
    }
  }

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
