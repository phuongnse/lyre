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
    // Only the first group's lines show at these times.
    for (const [text, start, end] of timing.slice(0, 7)) {
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

// The two rows of the Lyrics area, top first.
const rowsIn = (region: Locator) => [region.getByRole('paragraph').nth(0), region.getByRole('paragraph').nth(1)]

// toHaveText would normalise the whitespace, so the bytes are compared.
async function expectRows(region: Locator, expected: string[]): Promise<void> {
  const rows = rowsIn(region)
  await expect(region.getByRole('paragraph')).toHaveCount(2)
  await expect
    .poll(async () => [await rows[0].textContent(), await rows[1].textContent()].map((text) => Buffer.from(text ?? '').toString('hex')))
    .toEqual(expected.map((text) => Buffer.from(text).toString('hex')))
}

test('each row holds its display line byte for byte', async ({ page }) => {
  const { region, video } = await openFixture(page)
  const lyrics = readFileSync(new URL('../../fixtures/song/lyrics.txt', import.meta.url), 'utf8')
  const lines = lyrics.split(/\r\n|\n|\r/).filter((line) => /\S/.test(line))
  await seek(video, 1)
  await expectRows(region, [lines[0], lines[1]])
  await seek(video, 5)
  await expectRows(region, [lines[2], ''])
})

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

test('at 1.0 s the top row starts after the Countdown, which sits at the left edge', async ({ page }) => {
  const { region, video } = await openFixture(page)
  await seek(video, 1)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  const box = (await region.boundingBox())!
  const countdown = (await countdownsIn(region).boundingBox())!
  const first = (await syllableIn(region)('Mưa').boundingBox())!
  near(countdown.x, box.x)
  near(first.x, countdown.x + countdown.width)
})

test('at 1.0 s the bottom row ends at the right edge of the Lyrics area', async ({ page }) => {
  const { region, video } = await openFixture(page)
  await seek(video, 1)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  const box = (await region.boundingBox())!
  const last = (await syllableIn(region)('sông').boundingBox())!
  near(last.x + last.width, box.x + box.width)
})

test('at 5.0 s only "Trăng lên" shows, in the top row, with its Countdown inside the Lyrics area', async ({ page }) => {
  const { region, video } = await openFixture(page)
  await seek(video, 5)
  await expectRows(region, ['Trăng lên', ''])
  const box = (await region.boundingBox())!
  const countdown = (await countdownsIn(region).boundingBox())!
  expect(countdown.x).toBeGreaterThanOrEqual(box.x - 1)
  expect(countdown.y).toBeGreaterThanOrEqual(box.y - 1)
  expect(countdown.x + countdown.width).toBeLessThanOrEqual(box.x + box.width + 1)
  expect(countdown.y + countdown.height).toBeLessThanOrEqual(box.y + box.height + 1)
})

test('after a seek from 5.0 s back to 1.0 s, the first two lines show in their rows again', async ({ page }) => {
  const { region, video } = await openFixture(page)
  await seek(video, 5)
  await expectRows(region, ['Trăng lên', ''])
  await seek(video, 1)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
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

const countdownsIn = (region: Locator) => region.getByRole('progressbar', { name: 'Countdown' })
const countdownsInParagraph = (region: Locator, i: number) =>
  region.getByRole('paragraph').nth(i).getByRole('progressbar', { name: 'Countdown' })

// The fixture's first line has countdown steps ending at 0.5, 1.0, 1.5 and 2.0 s.
test('before the first line, the countdown counts one dot per step', async ({ page }) => {
  const { region, video } = await openFixture(page)
  const first = countdownsIn(region).first()
  for (const [seconds, value] of [
    [0.25, 0],
    [0.75, 1],
    [1.25, 2],
    [1.75, 3],
    [2.15, 4],
  ]) {
    await seek(video, seconds)
    await expect(first).toHaveAttribute('aria-valuenow', String(value))
  }
})

test('the line after the 5 s break has a countdown, and the line after the 300 ms break has none', async ({ page }) => {
  const { region, video } = await openFixture(page)
  await seek(video, 1)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  await expect(countdownsInParagraph(region, 0)).toHaveCount(1)
  await expect(countdownsInParagraph(region, 1)).toHaveCount(0)
  await seek(video, 5)
  await expectRows(region, ['Trăng lên', ''])
  await expect(countdownsInParagraph(region, 0)).toHaveCount(1)
})

// The line after the 5 s break has countdown steps ending at 8.4, 8.9, 9.4 and 9.9 s.
test('after a seek forward into a countdown and then back, each countdown matches the new time', async ({ page }) => {
  const { region, video } = await openFixture(page)
  const countdowns = countdownsIn(region)
  await seek(video, 9)
  await expect(countdowns).toHaveCount(1)
  await expect(countdowns).toHaveAttribute('aria-valuenow', '2')
  await seek(video, 0.75)
  await expect(countdowns).toHaveCount(1)
  await expect(countdowns).toHaveAttribute('aria-valuenow', '1')
})

test('changed dots have the highlight fill and a white outline, the others white with a black outline', async ({
  page,
}) => {
  const { region, video } = await openFixture(page)
  const first = countdownsIn(region).first()
  await seek(video, 1.25)
  await expect(first).toHaveAttribute('aria-valuenow', '2')
  const dots = await first.evaluate((element) =>
    [...element.children].map((dot) => {
      const computed = getComputedStyle(dot, '::before')
      return { fill: computed.color, outline: computed.webkitTextStrokeColor }
    }),
  )
  // #A100FB is the highlight colour from docs/ui-conventions.md#highlight-colour.
  const changed = { fill: 'rgb(161, 0, 251)', outline: 'rgb(255, 255, 255)' }
  const unchanged = { fill: 'rgb(255, 255, 255)', outline: 'rgb(0, 0, 0)' }
  expect(dots).toEqual([changed, changed, unchanged, unchanged])
})

// Returns the fraction of pixels that differ between two PNG screenshots. A
// pixel differs when any channel is off by more than 64 of 255, which leaves
// out the slightly different blending at glyph edges.
async function differentPixels(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([first, second]) => {
      const pixels = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        return context.getImageData(0, 0, bitmap.width, bitmap.height)
      }
      const [one, two] = [await pixels(first), await pixels(second)]
      if (one.width !== two.width || one.height !== two.height) return 1
      let different = 0
      for (let i = 0; i < one.data.length; i += 4) {
        for (let channel = 0; channel < 4; channel++) {
          if (Math.abs(one.data[i + channel] - two.data[i + channel]) > 64) {
            different++
            break
          }
        }
      }
      return different / (one.width * one.height)
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

// Screenshots the left 90% of `text` while it is current at `during`, then
// the same region at `after`. Returns the fraction of pixels that differ.
async function sungPartShift(
  page: Page,
  region: Locator,
  video: Locator,
  text: string,
  during: number,
  after: number,
  nextIsDone: () => Promise<void>,
): Promise<number> {
  const target = syllableIn(region)(text)
  // The lyrics lie over the video, whose test pattern moves. Hiding the video
  // keeps its pixels out of the comparison and leaves the layout as it is.
  await video.evaluate((element) => (element.style.visibility = 'hidden'))
  await seek(video, during)
  await expect(target).toHaveAttribute('aria-current', 'true')
  await target.scrollIntoViewIfNeeded()
  const box = (await target.boundingBox())!
  const clip = { x: box.x, y: box.y, width: box.width * 0.9, height: box.height }
  const before = await page.screenshot({ clip })
  await seek(video, after)
  await expect(target).not.toHaveAttribute('aria-current')
  await nextIsDone()
  return differentPixels(page, before, await page.screenshot({ clip }))
}

test('the sung part of "bên" lies over its text, and does not move when it is fully sung', async ({ page }) => {
  const { region, video } = await openFixture(page)
  const shift = await sungPartShift(page, region, video, 'bên', 4.385, 4.45, () =>
    expect(syllableIn(region)('sông')).toHaveAttribute('aria-current', 'true'),
  )
  expect(shift).toBeLessThanOrEqual(0.01)
})

test('the sung part of "nhẹ" lies over its text, and does not move when it is fully sung', async ({ page }) => {
  const { region, video } = await openFixture(page)
  const shift = await sungPartShift(page, region, video, 'nhẹ', 3.17, 3.3, async () => {
    for (const text of ['Mưa', 'rơi', 'nhẹ']) await expect(syllableIn(region)(text)).not.toHaveAttribute('aria-current')
  })
  expect(shift).toBeLessThanOrEqual(0.01)
})
