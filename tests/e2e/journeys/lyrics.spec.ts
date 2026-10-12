import { readFileSync } from 'node:fs'
import { expect, Locator, Page, test } from '@playwright/test'
import { fixture, openSongFile } from './song-file'

// The fixture's syllables, with their times in seconds from
// tests/fixtures/song/timing.txt.
const timing: [string, number, number][] = [
  ['Mưa', 2, 2.3],
  ['rơi', 2.3, 2.6],
  ['nhẹ', 2.6, 3.2],
  ['Em', 3.5, 3.8],
  ['về', 3.8, 4.1],
  ['bên', 4.1, 4.4],
  ['sông', 4.4, 4.9],
  ['Trăng', 9.9, 10.4],
  ['lên', 10.4, 11],
]

// Opens the fixture song and waits until its video can seek. Returns the
// Lyrics region and the video.
async function openFixture(page: Page): Promise<{ region: Locator; video: Locator }> {
  await openSongFile(page, fixture)
  const video = page.getByLabel('Song video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1)
  return { region: page.getByRole('region', { name: 'Lyrics' }), video }
}

const syllableIn = (region: Locator) => (text: string) => region.getByText(text, { exact: true })

// Pauses the video at `seconds`.
async function seek(video: Locator, seconds: number): Promise<void> {
  await video.evaluate((element: HTMLVideoElement, time) => {
    element.pause()
    element.currentTime = time
  }, seconds)
}

test('at each chosen time, only the syllable whose timing covers it is current', async ({ page }) => {
  const { region, video } = await openFixture(page)
  const syllable = syllableIn(region)
  for (const seconds of [2.15, 2.9, 3.95, 4.6]) {
    await seek(video, seconds)
    for (const [text, start, end] of timing) {
      if (start <= seconds && seconds < end) {
        await expect(syllable(text)).toHaveAttribute('aria-current', 'true')
      } else {
        await expect(syllable(text)).not.toHaveAttribute('aria-current')
      }
    }
  }
})

test('after a seek back, the highlight moves to the syllable at the new time', async ({ page }) => {
  const { region, video } = await openFixture(page)
  const syllable = syllableIn(region)
  await page.getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.3)
  await page.getByRole('button', { name: 'Pause' }).click()

  await seek(video, 4.6)
  await expect(syllable('sông')).toHaveAttribute('aria-current', 'true')
  await seek(video, 2.45)
  await expect(syllable('rơi')).toHaveAttribute('aria-current', 'true')
  await expect(syllable('sông')).not.toHaveAttribute('aria-current')
  // White is the unsung fill. The sung fill is the highlight colour.
  await expect(syllable('sông')).toHaveCSS('color', 'rgb(255, 255, 255)')
})

test('each display line holds its lyric line byte for byte', async ({ page }) => {
  const { region } = await openFixture(page)
  const lyrics = readFileSync(new URL('../../fixtures/song/lyrics.txt', import.meta.url), 'utf8')
  const expected = lyrics.split(/\r\n|\n|\r/).filter((line) => /\S/.test(line))
  const paragraphs = region.getByRole('paragraph')
  await expect(paragraphs).toHaveCount(expected.length)
  // toHaveText would normalise the whitespace, so the bytes are compared.
  const shown = await paragraphs.allTextContents()
  expect(shown).toHaveLength(expected.length)
  shown.forEach((text, i) => expect(Buffer.from(text).equals(Buffer.from(expected[i])), text).toBe(true))
})

test('sung syllables have the highlight fill and a white outline, unsung ones white with a black outline', async ({
  page,
}) => {
  const { region, video } = await openFixture(page)
  const syllable = syllableIn(region)
  await seek(video, 2.9)
  await expect(syllable('nhẹ')).toHaveAttribute('aria-current', 'true')
  const style = (text: string) =>
    syllable(text).evaluate((element) => {
      const computed = getComputedStyle(element)
      return { fill: computed.color, outline: computed.webkitTextStrokeColor, shadow: computed.textShadow }
    })
  // #A100FB is the highlight colour from docs/ui-conventions.md#highlight-colour.
  const sung = await style('Mưa')
  expect(sung.fill).toBe('rgb(161, 0, 251)')
  expect(sung.outline).toBe('rgb(255, 255, 255)')
  const unsung = await style('Em')
  expect(unsung.fill).toBe('rgb(255, 255, 255)')
  expect(unsung.outline).toBe('rgb(0, 0, 0)')
  // Both keep the crisp black shadow: black, with no blur.
  for (const { shadow } of [sung, unsung]) {
    expect(shadow.startsWith('rgb(0, 0, 0)'), shadow).toBe(true)
    expect(shadow.endsWith(' 0px'), shadow).toBe(true)
  }
})
