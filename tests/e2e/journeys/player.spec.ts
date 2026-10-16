import { readFileSync, writeFileSync } from 'node:fs'
import { expect, Page, test } from '@playwright/test'
import {
  buildForDevice,
  Choice,
  chooseSongFile,
  fixture,
  openSongFile,
  openV1Fixture,
  unlockedDeviceCode,
} from './song-file'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })
// Each journey builds its song with lyre-cli, so cargo may compile first.
test.setTimeout(180_000)

const OLD_VERSION = 'This song file is from an older version of Lyre and no longer plays.'

function octets(name: string, buffer: Buffer): Choice {
  return { name, mimeType: 'application/octet-stream', buffer }
}

test('the Player plays the fixture song with its karaoke track', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))

  await openV1Fixture(page)
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

// Listens to the video's sound with a Web Audio analyser. After this,
// window.lyreTone() returns the frequency in Hz of the loudest part of the
// sound, or 0 for silence. The fixture's karaoke track is a 440 Hz tone and its
// original track is an 880 Hz tone. Call it after a click, so the page has user
// activation and the audio context may run.
async function listen(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const video = document.querySelector('video') as HTMLVideoElement
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    const source = context.createMediaElementSource(video)
    source.connect(analyser)
    analyser.connect(context.destination)
    await context.resume()
    if (context.state !== 'running') throw new Error('The audio context is not running.')
    const bins = new Float32Array(analyser.frequencyBinCount)
    ;(window as unknown as { lyreTone: () => number }).lyreTone = () => {
      analyser.getFloatFrequencyData(bins)
      let loudest = 0
      for (let i = 1; i < bins.length; i++) if (bins[i] > bins[loudest]) loudest = i
      return bins[loudest] < -100 ? 0 : (loudest * context.sampleRate) / analyser.fftSize
    }
  })
}

const tone = (page: Page) => page.evaluate(() => (window as unknown as { lyreTone: () => number }).lyreTone())
const seconds = (page: Page) => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)
const poll = { intervals: [50], timeout: 2000 }

// Counts the seeks of the video, so a test can show that none happened.
async function countSeeks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement
    const counted = window as unknown as { lyreSeeks: number }
    counted.lyreSeeks = 0
    video.addEventListener('seeking', () => counted.lyreSeeks++)
  })
}
const seeks = (page: Page) => page.evaluate(() => (window as unknown as { lyreSeeks: number }).lyreSeeks)

function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test('the Player starts on Karaoke and shows which track is chosen', async ({ page }) => {
  await openV1Fixture(page)
  const karaoke = page.getByRole('radio', { name: 'Karaoke' })
  const original = page.getByRole('radio', { name: 'Original' })
  await expect(karaoke).toBeChecked()
  await expect(original).not.toBeChecked()
  await original.click()
  await expect(original).toBeChecked()
  await expect(karaoke).not.toBeChecked()
})

test('switching to Original during playback keeps the position and changes only the sound', async ({ page }) => {
  const problems = watchProblems(page)
  await openV1Fixture(page)
  await expect(page.getByLabel('Song video')).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await listen(page)
  await countSeeks(page)
  await expect.poll(() => tone(page), poll).toBeGreaterThan(300)
  await expect.poll(() => tone(page), poll).toBeLessThan(660)

  const before = await seconds(page)
  await page.getByRole('radio', { name: 'Original' }).click()
  const after = await seconds(page)
  // The stated tolerance: the position moves forward by less than half a second.
  expect(after).toBeGreaterThanOrEqual(before)
  expect(after - before).toBeLessThan(0.5)
  await expect
    .poll(async () => ((await tone(page)) > 660 ? await seconds(page) : -1), poll)
    .toBeGreaterThanOrEqual(after)

  expect(await seeks(page)).toBe(0)
  await expect(page.getByRole('radio', { name: 'Original' })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Karaoke' })).not.toBeChecked()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('switching to Original while paused plays Original from the paused position', async ({ page }) => {
  const problems = watchProblems(page)
  await openV1Fixture(page)
  await expect(page.getByLabel('Song video')).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await listen(page)
  await countSeeks(page)
  await expect.poll(() => seconds(page), poll).toBeGreaterThan(0.8)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  const paused = await seconds(page)

  await page.getByRole('radio', { name: 'Original' }).click()
  await expect(page.getByRole('radio', { name: 'Original' })).toBeChecked()
  expect(await seconds(page)).toBe(paused)
  expect(await seeks(page)).toBe(0)

  await page.getByRole('button', { name: 'Play' }).click()
  await expect
    .poll(async () => ((await tone(page)) > 660 ? await seconds(page) : -1), poll)
    .toBeGreaterThanOrEqual(paused)
  expect(await seconds(page)).toBeLessThan(paused + 1)
  expect(await seeks(page)).toBe(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('a truncated song file shows that it is damaged, and nothing plays', async ({ page }, testInfo) => {
  const code = await unlockedDeviceCode(page)
  const { song, access } = await buildForDevice(code, testInfo.outputPath('v1'))
  const file = readFileSync(song)
  const truncated = testInfo.outputPath('v1/truncated.lyre')
  writeFileSync(truncated, file.subarray(0, file.length - 1000))
  await chooseSongFile(page, [truncated, access])
  await expect(page.getByRole('alert')).toHaveText('This song file is damaged or incomplete.')
  await expect(page.getByLabel('Song video')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
})

test('a song whose video this browser cannot play says so, and nothing plays', async ({ page }) => {
  await openV1Fixture(page, 'h265.toml')
  // The journey tests the message only while Playwright's Chromium has no H.265 decoder.
  const supported = await page.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'))
  expect(supported).toBe(false)

  await expect(page.getByRole('alert')).toHaveText("This device cannot play this song's video.")
  await expect(page.getByLabel('Song video')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
  // The song is not kept in the library.
  await expect(page.getByRole('list', { name: 'Library' })).toHaveCount(0)
})

test('a version-0 song file shows the old-version message, and nothing plays or is kept', async ({ page }) => {
  await openSongFile(page, fixture)
  await expect(page.getByRole('alert')).toHaveText(OLD_VERSION)
  await expect(page.getByLabel('Song video')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Library' })).toHaveCount(0)
  // Nothing was kept, also after a reload.
  await page.reload()
  await expect(page.getByRole('list', { name: 'Library' })).toHaveCount(0)
})

test('a file that is not a song file shows that, and nothing plays', async ({ page }) => {
  await openSongFile(page, octets('notes.lyre', Buffer.from('These are notes, not a song.\n')))
  await expect(page.getByRole('alert')).toHaveText('This file is not a song file.')
  await expect(page.getByLabel('Song video')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
})
