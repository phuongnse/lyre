import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, Page, test } from '@playwright/test'

// scripts/e2e.sh builds the fixture song here with lyre-cli before the journeys run.
const fixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture.lyre', import.meta.url))

type Choice = string | { name: string; mimeType: string; buffer: Buffer }

async function openSongFile(page: Page, file: Choice): Promise<void> {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open a song file' }).click()
  await (await chooser).setFiles(file)
}

function octets(name: string, buffer: Buffer): Choice {
  return { name, mimeType: 'application/octet-stream', buffer }
}

test('the Player plays the fixture song with its karaoke track', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))

  await openSongFile(page, fixture)
  const video = page.getByLabel('Song video')
  await expect(video).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()

  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1)
  // Chromium counts the bytes it decoded. Audio is decoded, so the karaoke track plays.
  const decoded = await video.evaluate((element) => {
    const counts = element as HTMLVideoElement & {
      webkitAudioDecodedByteCount: number
      webkitVideoDecodedByteCount: number
    }
    return { audio: counts.webkitAudioDecodedByteCount, video: counts.webkitVideoDecodedByteCount }
  })
  expect(decoded.audio).toBeGreaterThan(0)
  expect(decoded.video).toBeGreaterThan(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('a truncated song file shows that it is damaged, and nothing plays', async ({ page }) => {
  const file = readFileSync(fixture)
  await openSongFile(page, octets('truncated.lyre', file.subarray(0, file.length - 1000)))
  await expect(page.getByRole('alert')).toHaveText('This song file is damaged or incomplete.')
  await expect(page.getByLabel('Song video')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
})

test('a file that is not a song file shows that, and nothing plays', async ({ page }) => {
  await openSongFile(page, octets('notes.lyre', Buffer.from('These are notes, not a song.\n')))
  await expect(page.getByRole('alert')).toHaveText('This file is not a song file.')
  await expect(page.getByLabel('Song video')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
})
