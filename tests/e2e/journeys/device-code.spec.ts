import { expect, Locator, Page, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { buildForDevice } from './song-file'
import { encodingsOf, expectNotInPage, openWith, returnedPrf } from './webauthn'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })

const CODE = /^lyre1p[02-9ac-hj-np-z]{59}$/
const FINGERPRINT = /^\d{4}( \d{4}){4}$/
const NO_PRF = 'This browser cannot give this device a device code, because its passkeys return no PRF output.'
const CAN_SYNC = 'This device gets no device code, because its passkey can sync to other devices.'

const section = (page: Page) => page.getByRole('region', { name: 'This device' })
const showButton = (page: Page) => section(page).getByRole('button', { name: 'Show the device code' })
const qrImage = (page: Page) => section(page).getByRole('img', { name: 'QR code of the device code' })
const copyButton = (page: Page) => section(page).getByRole('button', { name: 'Copy the device code' })
const codeText = (page: Page): Locator => section(page).getByText(CODE)
const fingerprintText = (page: Page): Locator => section(page).getByText(FINGERPRINT)

async function press(page: Page): Promise<void> {
  await showButton(page).click()
}

async function databases(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await indexedDB.databases()).map((database) => database.name ?? '').sort())
}

// Checks that no encoding of the PRF output reached the page, its storage, its
// cookies or the console, and that the page stored nothing but the passkey's ID.
async function expectNoLeak(
  page: Page,
  consoleMessages: string[],
  databasesBefore: string[],
  returned: boolean,
): Promise<void> {
  const output = await returnedPrf(page)
  if (returned) expect(output).toHaveLength(32)
  else expect(output).toBeUndefined()
  const encodings = output === undefined ? [] : encodingsOf(output)
  await expectNotInPage(page, consoleMessages, encodings)

  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
  }))
  expect(stored.session).toEqual([])
  expect(stored.cookie).toBe('')
  // Only the passkey's credential ID, and only once it has given a key.
  expect(stored.local.map(([key]) => key)).toEqual(returned ? ['lyre-device-passkey'] : [])
  for (const [key, value] of stored.local) {
    for (const encoding of encodings) {
      expect(key).not.toContain(encoding)
      expect(value).not.toContain(encoding)
    }
  }
  expect(await databases(page)).toEqual(databasesBefore)
}

async function expectNoCode(page: Page): Promise<void> {
  await expect(codeText(page)).toHaveCount(0)
  await expect(fingerprintText(page)).toHaveCount(0)
  await expect(qrImage(page)).toHaveCount(0)
  await expect(copyButton(page)).toHaveCount(0)
}

test('a device-bound passkey with PRF shows the device code, the fingerprint and a QR code, and the same ones after a reload', async ({
  page,
}) => {
  const consoleMessages = await openWith(page, '/', { hasPrf: true, backupEligible: false })
  await expect(showButton(page)).toBeVisible()
  const databasesBefore = await databases(page)
  await expectNoCode(page)

  await press(page)
  await expect(codeText(page)).toBeVisible()
  await expect(fingerprintText(page)).toBeVisible()
  await expect(qrImage(page)).toBeVisible()
  const code = await codeText(page).innerText()
  const fingerprint = await fingerprintText(page).innerText()
  expect(code).toHaveLength(65)
  await expectNoLeak(page, consoleMessages, databasesBefore, true)

  await page.reload()
  await expectNoCode(page)
  await press(page)
  await expect(codeText(page)).toHaveText(code)
  await expect(fingerprintText(page)).toHaveText(fingerprint)
  await expect(qrImage(page)).toBeVisible()
  await expectNoLeak(page, consoleMessages, databasesBefore, true)
})

test('lyre-cli builds a version-1 song and an access file for the device code on the page', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  await openWith(page, '/', { hasPrf: true, backupEligible: false })
  await press(page)
  const code = await codeText(page).innerText()

  const { song, access } = await buildForDevice(code, testInfo.outputPath('device'))

  const songBytes = await readFile(song)
  expect([...songBytes.subarray(0, 8)]).toEqual([0x89, 0x4c, 0x59, 0x52, 0x45, 0x0d, 0x0a, 0x1a])
  expect([...songBytes.subarray(8, 10)]).toEqual([1, 0])
  const accessBytes = await readFile(access)
  expect(accessBytes).toHaveLength(179)
  expect([...accessBytes.subarray(0, 8)]).toEqual([0x89, 0x4c, 0x4b, 0x45, 0x59, 0x0d, 0x0a, 0x1a])
})

test('a later press in the same page load shows the same code', async ({ page }) => {
  await openWith(page, '/', { hasPrf: true, backupEligible: false })
  await press(page)
  const code = await codeText(page).innerText()
  await press(page)
  await expect(codeText(page)).toHaveText(code)
})

test('a passkey without PRF gets one message and no device code', async ({ page }) => {
  const consoleMessages = await openWith(page, '/', { hasPrf: false, backupEligible: false })
  const databasesBefore = await databases(page)
  await press(page)
  await expect(section(page).getByRole('status').first()).toHaveText(NO_PRF)
  await expectNoCode(page)
  await expectNoLeak(page, consoleMessages, databasesBefore, false)
})

test('a passkey that can sync gets one message and no device code', async ({ page }) => {
  const consoleMessages = await openWith(page, '/', { hasPrf: true, backupEligible: true })
  const databasesBefore = await databases(page)
  await press(page)
  await expect(section(page).getByRole('status').first()).toHaveText(CAN_SYNC)
  await expectNoCode(page)
  await expectNoLeak(page, consoleMessages, databasesBefore, false)
})

test('Copy the device code puts exactly the shown code on the clipboard and says it is copied', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openWith(page, '/', { hasPrf: true, backupEligible: false })
  await press(page)
  const code = await codeText(page).innerText()
  await copyButton(page).click()
  await expect(section(page).getByText('The device code is copied.')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
})

test('Copy the device code says the browser refused when the clipboard rejects the write', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }),
    })
  })
  await openWith(page, '/', { hasPrf: true, backupEligible: false })
  await press(page)
  await expect(codeText(page)).toBeVisible()
  await copyButton(page).click()
  await expect(section(page).getByText('The browser refused to copy the device code.')).toBeVisible()
  await expect(section(page).getByText('The device code is copied.')).toHaveCount(0)
})
