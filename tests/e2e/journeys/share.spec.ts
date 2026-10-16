import { expect, Page, test } from '@playwright/test'
import { buildForDevice, chooseSongFile, unlockedDeviceCode } from './song-file'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })
// The first call builds lyre-cli, so cargo may compile first.
test.setTimeout(180_000)

const CANNOT_OPEN = 'This song cannot be opened on this device.'
// The device-access vector's "One data character changed" code.
const CHANGED_DEVICE_CODE = 'lyre1pqd77ag0nlwzjnaqkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dkpfn6rh'

const thisDevice = (page: Page) => page.getByRole('region', { name: 'This device' })
const shareSection = (page: Page) => page.getByRole('region', { name: 'Share this song' })

async function expectPlays(page: Page): Promise<void> {
  const video = page.getByLabel('Song video')
  await expect(video).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1)
}

test('the owner shares a song with another device, which plays it without Share, and a third device cannot', async ({
  browser,
}, testInfo) => {
  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext({ baseURL: 'http://localhost:4173' })))
  const [owner, recipient, third] = await Promise.all(contexts.map((context) => context.newPage()))
  const ownerCode = await unlockedDeviceCode(owner)
  const recipientCode = await unlockedDeviceCode(recipient)
  const thirdCode = await unlockedDeviceCode(third)
  expect(new Set([ownerCode, recipientCode, thirdCode]).size).toBe(3)
  const recipientFingerprint = await thisDevice(recipient).locator('dt:has-text("Fingerprint") + dd').innerText()

  const { song, access } = await buildForDevice(ownerCode, testInfo.outputPath('v1'))
  await chooseSongFile(owner, [song, access])
  await expectPlays(owner)
  await owner.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(shareSection(owner)).toContainText('A share cannot be undone.')
  await shareSection(owner).getByRole('textbox', { name: 'Device code' }).fill(recipientCode)
  await owner.getByRole('button', { name: 'Make the access file' }).click()
  await expect(shareSection(owner).locator('dt:has-text("Fingerprint") + dd')).toHaveText(recipientFingerprint)
  await expect(owner.getByRole('alert')).toHaveCount(0)
  const download = owner.waitForEvent('download')
  await shareSection(owner).getByRole('link', { name: 'Download the access file' }).click()
  const shared = testInfo.outputPath('shared/shared.lyrekey')
  await (await download).saveAs(shared)

  await chooseSongFile(recipient, [song, shared])
  await expectPlays(recipient)
  await expect(recipient.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0)
  await expect(recipient.getByRole('alert')).toHaveCount(0)

  // The third device holds the song file, the shared access file and the second device's code.
  await chooseSongFile(third, [song, shared])
  await expect(third.getByRole('alert')).toHaveText(CANNOT_OPEN)
  await expect(third.getByLabel('Song video')).toHaveCount(0)
  await expect(third.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0)
  await Promise.all(contexts.map((context) => context.close()))
})

test('a device code with one character changed gets one message and gives no fingerprint or file', async ({
  page,
}, testInfo) => {
  const code = await unlockedDeviceCode(page)
  const { song, access } = await buildForDevice(code, testInfo.outputPath('v1'))
  await chooseSongFile(page, [song, access])
  await expectPlays(page)

  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await shareSection(page).getByRole('textbox', { name: 'Device code' }).fill(CHANGED_DEVICE_CODE)
  await page.getByRole('button', { name: 'Make the access file' }).click()
  await expect(page.getByRole('alert')).toHaveText('This is not a valid device code.')
  await expect(shareSection(page)).not.toContainText('Fingerprint')
  await expect(shareSection(page).getByRole('link')).toHaveCount(0)
})
