import { expect, Page, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { buildForDevice, chooseSongFile } from './song-file'
import { openWith } from './webauthn'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })
// The first call builds lyre-cli, so cargo may compile first.
test.setTimeout(180_000)

const CANNOT_OPEN = 'This song cannot be opened on this device.'
// The device code of the device-access vector, which is not this page's device.
const VECTOR_DEVICE_CODE = 'lyre1pq2czcfjxetpl79tc2t9k7l75l0xaevqdhv9g28pgd4qwvu0lqswqzflvara'

const library = (page: Page) => page.getByRole('list', { name: 'Library' })

// Opens the page with a device-bound passkey, and shows the device code, so the
// device is unlocked and a refusal cannot come from a failed unlock.
async function unlockedDeviceCode(page: Page): Promise<string> {
  await openWith(page, '/', { hasPrf: true, backupEligible: false })
  await page
    .getByRole('region', { name: 'This device' })
    .getByRole('button', { name: 'Show the device code' })
    .click()
  return page
    .getByRole('region', { name: 'This device' })
    .getByText(/^lyre1p[02-9ac-hj-np-z]{59}$/)
    .innerText()
}

async function expectPlays(page: Page): Promise<void> {
  const video = page.getByLabel('Song video')
  await expect(video).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1)
}

async function expectRefused(page: Page): Promise<void> {
  await expect(page.getByRole('alert')).toHaveText(CANNOT_OPEN)
  await expect(page.getByLabel('Song video')).toHaveCount(0)
  await expect(library(page)).toHaveCount(0)
  // Nothing was kept, also after a reload.
  await page.reload()
  await expect(library(page)).toHaveCount(0)
}

test('the version-1 fixture plays with the access file built for the page device code', async ({ page }, testInfo) => {
  const code = await unlockedDeviceCode(page)
  const { song, access } = await buildForDevice(code, testInfo.outputPath('v1'))

  await chooseSongFile(page, [song, access])
  await expectPlays(page)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('the song file alone cannot be opened', async ({ page }, testInfo) => {
  const code = await unlockedDeviceCode(page)
  const { song } = await buildForDevice(code, testInfo.outputPath('v1'))

  await chooseSongFile(page, [song])
  await expectRefused(page)
})

test("an access file for another device's code cannot open the song", async ({ page }, testInfo) => {
  const code = await unlockedDeviceCode(page)
  const { song } = await buildForDevice(code, testInfo.outputPath('v1'))
  const other = await buildForDevice(VECTOR_DEVICE_CODE, testInfo.outputPath('other'))

  await chooseSongFile(page, [song, other.access])
  await expectRefused(page)
})

test('a song file with one index byte changed cannot be opened', async ({ page }, testInfo) => {
  const code = await unlockedDeviceCode(page)
  const { song, access } = await buildForDevice(code, testInfo.outputPath('v1'))
  const buffer = await readFile(song)
  // The first byte after the 177-byte header is the index.
  buffer[177] ^= 1
  const changed = testInfo.outputPath('v1/changed.lyre')
  await writeFile(changed, buffer)

  await chooseSongFile(page, [changed, access])
  await expectRefused(page)
})

test('after a reload, choosing the kept version-1 song in the library plays it', async ({ page }, testInfo) => {
  const code = await unlockedDeviceCode(page)
  const { song, access } = await buildForDevice(code, testInfo.outputPath('v1'))

  await chooseSongFile(page, [song, access])
  await expectPlays(page)
  await expect(library(page).getByRole('listitem')).toHaveCount(1)
  await page.reload()

  await page.getByRole('button', { name: 'Mưa rơi nhẹ' }).click()
  await expectPlays(page)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
