import { readFileSync } from 'node:fs'
import { expect, Locator, Page, test } from '@playwright/test'
import { fixture, maleFixture, openSongFile } from './song-file'

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

// Opens the fixture song, or `file`, and waits until its video can seek. Returns
// the Lyrics region and the video.
async function openFixture(page: Page, file = fixture): Promise<{ region: Locator; video: Locator }> {
  await openSongFile(page, file)
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
  // White is the unsung fill. The sung fill is the vocal role colour.
  await expect(syllable('sông')).toHaveCSS('color', 'rgb(255, 255, 255)')
})

// The two rows of the Lyrics area, top first.
const rowsIn = (region: Locator) => [region.getByRole('paragraph').nth(0), region.getByRole('paragraph').nth(1)]

// toHaveText would normalise the whitespace, so the bytes are compared.
async function expectRows(region: Locator, expected: string[]): Promise<void> {
  const rows = rowsIn(region)
  await expect(region.getByRole('paragraph')).toHaveCount(2)
  await expect
    .poll(async () =>
      [await rows[0].textContent(), await rows[1].textContent()].map((text) => Buffer.from(text ?? '').toString('hex')),
    )
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

test('at 1.0 s the top row starts after the Countdown, which sits at the left gap', async ({ page }) => {
  const { region, video } = await openFixture(page)
  await seek(video, 1)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  const box = (await region.boundingBox())!
  const countdown = (await countdownsIn(region).boundingBox())!
  const first = (await syllableIn(region)('Mưa').boundingBox())!
  const gap = 0.3 * (await region.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)))
  near(countdown.x, box.x + gap)
  near(first.x, countdown.x + countdown.width)
})

test('at 1.0 s the bottom row ends at the right gap of the Lyrics area', async ({ page }) => {
  const { region, video } = await openFixture(page)
  await seek(video, 1)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  const box = (await region.boundingBox())!
  const last = (await syllableIn(region)('sông').boundingBox())!
  const gap = 0.3 * (await region.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)))
  near(last.x + last.width, box.x + box.width - gap)
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

test('sung syllables have the vocal role fill and a white outline, unsung ones white with a black outline', async ({
  page,
}) => {
  const { region, video } = await openFixture(page)
  const syllable = syllableIn(region)
  await seek(video, 4)
  await expect(syllable('về')).toHaveAttribute('aria-current', 'true')
  const style = (text: string) =>
    syllable(text).evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        fill: computed.color,
        outline: computed.webkitTextStrokeColor,
        filter: computed.filter,
        textShadow: computed.textShadow,
      }
    })
  // #FF0000 is the female vocal role colour from docs/ui-conventions.md#vocal-role-colours.
  const sung = await style('Mưa')
  expect(sung.fill).toBe('rgb(255, 0, 0)')
  expect(sung.outline).toBe('rgb(255, 255, 255)')
  const unsung = await style('sông')
  expect(unsung.fill).toBe('rgb(255, 255, 255)')
  expect(unsung.outline).toBe('rgb(0, 0, 0)')
  // Both keep the same crisp black shadow, a drop-shadow filter with no blur.
  // It lies under the outline, which text-shadow would not.
  expect(sung.filter).toBe(unsung.filter)
  for (const { filter, textShadow } of [sung, unsung]) {
    expect(filter.startsWith('drop-shadow(rgb(0, 0, 0) '), filter).toBe(true)
    expect(filter.endsWith(' 0px)'), filter).toBe(true)
    expect(textShadow).toBe('none')
  }
})

test('in a male song, sung syllables are blue with a white outline', async ({ page }) => {
  const { region, video } = await openFixture(page, maleFixture)
  const syllable = syllableIn(region)
  await seek(video, 4)
  await expect(syllable('về')).toHaveAttribute('aria-current', 'true')
  // #0000FF is the male vocal role colour from docs/ui-conventions.md#vocal-role-colours.
  await expect(syllable('Mưa')).toHaveCSS('color', 'rgb(0, 0, 255)')
  await expect(syllable('Mưa')).toHaveCSS('-webkit-text-stroke-color', 'rgb(255, 255, 255)')
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

// The line after the 5 s break has countdown steps ending at 8.4, 8.9, 9.4 and 9.9 s.
test('changed dots have the vocal role fill and a white outline, the others white with a black outline', async ({
  page,
}) => {
  const { region, video } = await openFixture(page)
  const countdown = countdownsIn(region)
  await seek(video, 9.5)
  await expect(countdown).toHaveAttribute('aria-valuenow', '3')
  const dots = await countdown.evaluate((element) =>
    [...element.children].map((dot) => {
      const computed = getComputedStyle(dot, '::before')
      return { fill: computed.color, outline: computed.webkitTextStrokeColor }
    }),
  )
  // The dots have the same shadow as the syllables.
  const filters = await countdown.evaluate((element) =>
    [...element.children].map((dot) => getComputedStyle(dot).filter),
  )
  const syllableFilter = await syllableIn(region)('Trăng').evaluate((element) => getComputedStyle(element).filter)
  expect(filters).toEqual(Array(4).fill(syllableFilter))
  // #FF0000 is the female vocal role colour from docs/ui-conventions.md#vocal-role-colours.
  const changed = { fill: 'rgb(255, 0, 0)', outline: 'rgb(255, 255, 255)' }
  const unchanged = { fill: 'rgb(255, 255, 255)', outline: 'rgb(0, 0, 0)' }
  expect(dots).toEqual([changed, changed, changed, unchanged])
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
  const clip = {
    x: box.x,
    y: box.y,
    width: box.width * 0.9,
    height: box.height,
  }
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

// Hides the video and every syllable and dot but `target`, and puts a plain
// green backdrop on the region. The video's test pattern moves, and the
// neighbouring glyphs would fall inside the scanned area. The backdrop goes on
// the region and never on a syllable, as its shadow would lie over a syllable's
// background. Returns the region's font size in pixels, which is 1 em.
async function isolate(region: Locator, video: Locator, target: Locator): Promise<number> {
  await video.evaluate((element) => (element.style.visibility = 'hidden'))
  const handle = await target.elementHandle()
  const em = await region.evaluate((section, keep) => {
    section.style.background = 'rgb(0, 160, 0)'
    for (const element of section.querySelectorAll<HTMLElement>('.syllable, .dot')) {
      if (element !== keep) element.style.visibility = 'hidden'
    }
    return parseFloat(getComputedStyle(section).fontSize)
  }, handle)
  await target.scrollIntoViewIfNeeded()
  return em
}

// What edgeScan measures, with widths in em.
interface EdgeScan {
  // The fraction of scanned lines whose first bright pixel from the edge is white.
  whiteFraction: number
  // The median width of the dark band past that pixel, to the right and below.
  rightBand: number
  bottomBand: number
  // The number of pixels in the scanned area in the female vocal role red.
  redPixels: number
}

// Screenshots `target` from `from` of its width, with 0.3 em more to the right
// and below, on a plain green backdrop with everything else hidden, and scans in
// from the right edge along every pixel row and from the bottom edge up every
// column. The first bright pixel on a line is the outer edge of the white
// outline, or of the white fill when the outline is black. A line is white when
// that pixel or the next one in is white, which leaves out the blending at the
// glyph's edge. The dark pixels between it and the edge are the shadow band,
// with the black outline outside the glyph for an unsung one.
async function edgeScan(
  page: Page,
  region: Locator,
  video: Locator,
  target: Locator,
  from = 0,
): Promise<EdgeScan> {
  const em = await isolate(region, video, target)
  const box = (await target.boundingBox())!
  const area = (await region.boundingBox())!
  const left = Math.max(box.x + from * box.width, area.x)
  const top = Math.max(box.y, area.y)
  const right = Math.min(box.x + box.width + 0.3 * em, area.x + area.width)
  const bottom = Math.min(box.y + box.height + 0.3 * em, area.y + area.height)
  const clip = { x: left, y: top, width: right - left, height: bottom - top }
  const png = await page.screenshot({ clip })
  const scan = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    const channels = (x: number, y: number) => {
      const i = (y * width + x) * 4
      return [data[i], data[i + 1], data[i + 2]]
    }
    // Scans the `length` pixels of one line from its end, as pixel positions.
    const line = (at: (position: number) => number[], length: number) => {
      for (let position = length - 1; position >= 0; position--) {
        const pixel = at(position)
        if (Math.max(...pixel) >= 200) {
          let dark = 0
          for (let after = position + 1; after < length; after++) {
            if (Math.max(...at(after)) < 80) dark++
          }
          // Where the outline meets the backdrop instead of the shadow, the edge
          // pixel is white blended with green, so the next one in is checked too.
          const inner = position > 0 ? at(position - 1) : pixel
          return {
            white: Math.max(Math.min(...pixel), Math.min(...inner)) >= 200,
            dark,
          }
        }
      }
      return undefined
    }
    const rows = Array.from({ length: height }, (_, y) => line((x) => channels(x, y), width))
    const columns = Array.from({ length: width }, (_, x) => line((y) => channels(x, y), height))
    let redPixels = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] >= 200 && data[i + 1] < 80 && data[i + 2] < 80) redPixels++
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
    const found = [...rows, ...columns].filter((result) => result !== undefined)
    const darkOf = (results: typeof rows) =>
      median(results.filter((result) => result !== undefined).map((result) => result.dark))
    return {
      whiteFraction: found.filter((result) => result.white).length / Math.max(found.length, 1),
      rightBand: darkOf(rows),
      bottomBand: darkOf(columns),
      redPixels,
    }
  }, png.toString('base64'))
  return {
    whiteFraction: scan.whiteFraction,
    rightBand: scan.rightBand / em,
    bottomBand: scan.bottomBand / em,
    redPixels: scan.redPixels,
  }
}

// What leadingEdgeScan measures.
interface LeadingEdgeScan {
  // The pixel rows and columns whose first bright or dark pixel was found.
  rows: number
  columns: number
  // The fraction of those rows and columns where that pixel is black.
  blackRows: number
  blackColumns: number
}

// Screenshots the left `swept` of `target`, from 0.3 em before it and above it,
// on a plain green backdrop with everything else hidden. Scans in from the left
// along every pixel row and down from the top along every column. The first
// pixel on a line that is bright (a channel of 200 or more) or dark (all
// channels under 80) is the glyph's leading edge. The green backdrop, and white
// blended with it, count as neither. A line is black when that pixel is dark,
// which is the unsung black outline showing where the sung white one should be.
// Lines with no bright pixel are left out, as they only cross the shadow.
async function leadingEdgeScan(
  page: Page,
  region: Locator,
  video: Locator,
  target: Locator,
  swept: number,
): Promise<LeadingEdgeScan> {
  const em = await isolate(region, video, target)
  const box = (await target.boundingBox())!
  const area = (await region.boundingBox())!
  const left = Math.max(box.x - 0.3 * em, area.x)
  const top = Math.max(box.y - 0.3 * em, area.y)
  const right = Math.min(box.x + swept * box.width, area.x + area.width)
  const bottom = Math.min(box.y + box.height, area.y + area.height)
  const clip = { x: left, y: top, width: right - left, height: bottom - top }
  const png = await page.screenshot({ clip })
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    // Scans one line from its start and returns 'dark' or 'bright' for its first
    // such pixel. A line with no bright pixel at all misses the glyph and only
    // holds shadow, so it returns undefined.
    const line = (at: (position: number) => number, length: number) => {
      let first: 'dark' | 'bright' | undefined
      for (let position = 0; position < length; position++) {
        const i = at(position) * 4
        const strongest = Math.max(data[i], data[i + 1], data[i + 2])
        if (strongest >= 200) return first ?? 'bright'
        if (strongest < 80) first ??= 'dark'
      }
      return undefined
    }
    const rows = Array.from({ length: height }, (_, y) => line((x) => y * width + x, width))
    const columns = Array.from({ length: width }, (_, x) => line((y) => y * width + x, height))
    const found = (lines: (string | undefined)[]) => lines.filter((result) => result !== undefined)
    const black = (lines: (string | undefined)[]) =>
      found(lines).filter((result) => result === 'dark').length / Math.max(found(lines).length, 1)
    return {
      rows: found(rows).length,
      columns: found(columns).length,
      blackRows: black(rows),
      blackColumns: black(columns),
    }
  }, png.toString('base64'))
}

test('at 4.0 s the fully sung "Mưa" has an unbroken white outline and a black shadow band past it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 4)
  await expect(syllableIn(region)('Mưa')).toHaveClass(/sung/)
  const scan = await edgeScan(page, region, video, syllableIn(region)('Mưa'))
  expect(scan.whiteFraction).toBeGreaterThanOrEqual(0.95)
  expect(scan.rightBand).toBeGreaterThanOrEqual(0.08)
  expect(scan.bottomBand).toBeGreaterThanOrEqual(0.08)
})

test('at 4.0 s the unsung "bên" has a dark band of outline and shadow past its white fill', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 4)
  await expect(syllableIn(region)('về')).toHaveAttribute('aria-current', 'true')
  await expect(syllableIn(region)('bên')).not.toHaveClass(/sung/)
  // The outline's 0.06 em outside the glyph, and at least 0.08 em of shadow.
  const scan = await edgeScan(page, region, video, syllableIn(region)('bên'))
  expect(scan.rightBand).toBeGreaterThanOrEqual(0.14)
  expect(scan.bottomBand).toBeGreaterThanOrEqual(0.14)
})

// "về" runs 3.8 to 4.1 s, so at 4.0 s two thirds of it is swept. The scan covers
// its left quarter, the "v", and leaves out the marks over "ê" and their shadows.
test('at 4.0 s no black outline shows behind the sweep at the left of "về"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 4)
  await expect(syllableIn(region)('về')).toHaveAttribute('aria-current', 'true')
  const scan = await leadingEdgeScan(page, region, video, syllableIn(region)('về'), 0.25)
  expect(scan.rows).toBeGreaterThan(0)
  expect(scan.blackRows).toBe(0)
})

// "Em" runs 3.5 to 3.8 s, so at 3.65 s half of it is swept. The rows cover the
// "E" and part of the "m". The columns cover only the "E", as the valley of the
// "m" holds the shadow of its first hump.
test('at 3.65 s no black outline shows behind the sweep at the left or top of "Em"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 3.65)
  await expect(syllableIn(region)('Em')).toHaveAttribute('aria-current', 'true')
  const rowScan = await leadingEdgeScan(page, region, video, syllableIn(region)('Em'), 0.4)
  expect(rowScan.rows).toBeGreaterThan(0)
  expect(rowScan.blackRows).toBe(0)
  const columnScan = await leadingEdgeScan(page, region, video, syllableIn(region)('Em'), 0.3)
  expect(columnScan.columns).toBeGreaterThan(0)
  expect(columnScan.blackColumns).toBe(0)
})

test('at 4.0 s the part of "về" ahead of the sweep keeps its white fill and black outline', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 4)
  await expect(syllableIn(region)('về')).toHaveAttribute('aria-current', 'true')
  // The sweep is two thirds along, so the last fifth is still ahead of it.
  const scan = await edgeScan(page, region, video, syllableIn(region)('về'), 0.8)
  expect(scan.redPixels).toBe(0)
  expect(scan.rightBand).toBeGreaterThanOrEqual(0.14)
})

// The line after the 5 s break has countdown steps ending at 8.4, 8.9, 9.4 and 9.9 s.
test('at 9.5 s the third countdown dot has an unbroken white outline and a black shadow band past it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 9.5)
  await expect(countdownsIn(region)).toHaveAttribute('aria-valuenow', '3')
  const dot = countdownsIn(region).locator('.dot').nth(2)
  await expect(dot).toHaveClass(/changed/)
  const scan = await edgeScan(page, region, video, dot)
  expect(scan.whiteFraction).toBeGreaterThanOrEqual(0.95)
  expect(scan.rightBand).toBeGreaterThanOrEqual(0.08)
  expect(scan.bottomBand).toBeGreaterThanOrEqual(0.08)
})
