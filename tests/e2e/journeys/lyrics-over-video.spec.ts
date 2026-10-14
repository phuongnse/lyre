import { expect, Locator, Page, test } from '@playwright/test'
import { fixture, openSongFile } from './song-file'

// Opens the fixture song and waits until its video can seek. Returns the Lyrics
// region and the video.
async function openFixture(page: Page): Promise<{ region: Locator; video: Locator }> {
  await openSongFile(page, fixture)
  const video = page.getByLabel('Song video')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1)
  return { region: page.getByRole('region', { name: 'Lyrics' }), video }
}

// Pauses the video at `seconds`.
async function seek(video: Locator, seconds: number): Promise<void> {
  await video.evaluate((element: HTMLVideoElement, time) => {
    element.pause()
    element.currentTime = time
  }, seconds)
}

// Waits until the two rows show `expected`.
async function expectRows(region: Locator, expected: string[]): Promise<void> {
  await expect(region.getByRole('paragraph')).toHaveCount(2)
  await expect
    .poll(async () => [
      await region.getByRole('paragraph').nth(0).textContent(),
      await region.getByRole('paragraph').nth(1).textContent(),
    ])
    .toEqual(expected)
}

async function boxOf(locator: Locator) {
  return (await locator.boundingBox())!
}

// One pixel of tolerance for rounding.
const tolerance = 1

const fontSizeOf = (region: Locator) => region.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))

const fontWeightOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).fontWeight)

// The lyric font size for a video `height` pixels tall: 1/10 of it, never under 16 px.
const expectedFontSize = (height: number) => Math.max(height / 10, 16)

// The lines of a row box that the lyric font's metrics give, as y positions. The
// canvas gives the font box above and below the baseline, and a temporary 1cap
// block gives the height of a capital. Neither depends on the text shown.
async function metricsOf(region: Locator) {
  return region.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d')!
    context.font = getComputedStyle(element).font
    const box = context.measureText('')
    const cap = document.createElement('div')
    cap.style.cssText = 'display:block;height:1cap;position:absolute;visibility:hidden'
    element.appendChild(cap)
    const capHeight = cap.getBoundingClientRect().height
    cap.remove()
    return { ascent: box.fontBoundingBoxAscent, descent: box.fontBoundingBoxDescent, capHeight }
  })
}

// Where a row's descender line and cap-height line lie, from its box.
function linesOf(
  row: { y: number; height: number },
  { ascent, descent, capHeight }: { ascent: number; descent: number; capHeight: number },
) {
  const halfLeading = (row.height - ascent - descent) / 2
  return {
    descender: row.y + halfLeading + ascent + descent,
    cap: row.y + halfLeading + ascent - capHeight,
  }
}

const syllables = ['Mưa', 'rơi', 'nhẹ', 'Em', 'về', 'bên', 'sông']

for (const [width, height] of [
  [1280, 720],
  [390, 844],
  [844, 390],
]) {
  test(`at ${width}×${height} both rows lie over the bottom 35% of the video`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const { region, video } = await openFixture(page)
    await seek(video, 1)
    await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
    const stage = await boxOf(video)
    const top = await boxOf(region.getByRole('paragraph').nth(0))
    const bottom = await boxOf(region.getByRole('paragraph').nth(1))
    for (const row of [top, bottom]) {
      expect(row.x).toBeGreaterThanOrEqual(stage.x - tolerance)
      expect(row.y).toBeGreaterThanOrEqual(stage.y - tolerance)
      expect(row.x + row.width).toBeLessThanOrEqual(stage.x + stage.width + tolerance)
      expect(row.y + row.height).toBeLessThanOrEqual(stage.y + stage.height + tolerance)
    }
    expect(bottom.y + bottom.height).toBeGreaterThanOrEqual(stage.y + 0.9 * stage.height - tolerance)
    expect(stage.y + stage.height - top.y).toBeLessThanOrEqual(0.35 * stage.height + tolerance)
  })
}

for (const [width, height] of [
  [1280, 720],
  [390, 844],
  [844, 390],
]) {
  test(`at ${width}×${height} the lyrics are 1/10 of the video's height and fit inside it`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const { region, video } = await openFixture(page)
    await seek(video, 4)
    await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
    const stage = await boxOf(video)
    expect(Math.abs((await fontSizeOf(region)) - expectedFontSize(stage.height))).toBeLessThan(0.5)
    const metrics = await metricsOf(region)
    const [topRow, bottomRow] = [
      linesOf(await boxOf(region.getByRole('paragraph').nth(0)), metrics),
      linesOf(await boxOf(region.getByRole('paragraph').nth(1)), metrics),
    ]
    const gap = bottomRow.cap - topRow.descender
    for (const text of syllables) {
      const syllable = await boxOf(region.getByText(text, { exact: true }))
      expect(syllable.x).toBeGreaterThanOrEqual(stage.x + gap - tolerance)
      expect(syllable.x + syllable.width).toBeLessThanOrEqual(stage.x + stage.width - gap + tolerance)
    }
    const top = await boxOf(region.getByRole('paragraph').nth(0))
    expect(stage.y + stage.height - top.y).toBeLessThanOrEqual(0.35 * stage.height + tolerance)
  })
}

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)

for (const [width, height] of [
  [1280, 720],
  [390, 844],
]) {
  test(`at ${width}×${height} the space below the bottom row equals the visible gap between the rows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    const { region, video } = await openFixture(page)
    await seek(video, 4)
    await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
    const metrics = await metricsOf(region)
    const stage = await boxOf(video)
    const top = linesOf(await boxOf(region.getByRole('paragraph').nth(0)), metrics)
    const bottom = linesOf(await boxOf(region.getByRole('paragraph').nth(1)), metrics)
    near(stage.y + stage.height - bottom.descender, bottom.cap - top.descender)
  })

  test(`at ${width}×${height} the Countdown and the end of the bottom line are one visible gap from the sides`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    const { region, video } = await openFixture(page)
    await seek(video, 4)
    await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
    const metrics = await metricsOf(region)
    const stage = await boxOf(video)
    const top = linesOf(await boxOf(region.getByRole('paragraph').nth(0)), metrics)
    const bottom = linesOf(await boxOf(region.getByRole('paragraph').nth(1)), metrics)
    const gap = bottom.cap - top.descender
    const countdown = await boxOf(region.getByRole('progressbar', { name: 'Countdown' }))
    const last = await boxOf(region.getByText('sông', { exact: true }))
    near(countdown.x - stage.x, gap)
    near(stage.x + stage.width - (last.x + last.width), gap)
  })
}

test('at 9.5 s the Countdown is at the left margin and the top row is where it was at 4.0 s', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 4)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  const before = await boxOf(region.getByRole('paragraph').nth(0))
  const bottomAt4 = await boxOf(region.getByRole('paragraph').nth(1))
  await seek(video, 9.5)
  await expectRows(region, ['Trăng lên', ''])
  const stage = await boxOf(video)
  const countdown = await boxOf(region.getByRole('progressbar', { name: 'Countdown' }))
  const top = await boxOf(region.getByRole('paragraph').nth(0))
  // The visible gap between the rows, found from the rows at 4.0 s.
  const metrics = await metricsOf(region)
  const gap = linesOf(bottomAt4, metrics).cap - linesOf(before, metrics).descender
  near(countdown.x, stage.x + gap)
  near(top.y, before.y)
})

test('the lyric text and the Countdown are bold', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 4)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  expect(await fontWeightOf(region.getByText('Mưa', { exact: true }))).toBe('700')
  await seek(video, 1)
  const countdown = region.getByRole('progressbar', { name: 'Countdown' })
  await expect(countdown).toBeVisible()
  expect(await fontWeightOf(countdown)).toBe('700')
})

test('at 6.0 s the Countdown lies inside the video', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 6)
  await expectRows(region, ['Trăng lên', ''])
  const stage = await boxOf(video)
  const countdown = await boxOf(region.getByRole('progressbar', { name: 'Countdown' }))
  expect(countdown.x).toBeGreaterThanOrEqual(stage.x - tolerance)
  expect(countdown.y).toBeGreaterThanOrEqual(stage.y - tolerance)
  expect(countdown.x + countdown.width).toBeLessThanOrEqual(stage.x + stage.width + tolerance)
  expect(countdown.y + countdown.height).toBeLessThanOrEqual(stage.y + stage.height + tolerance)
})

test('after the viewport shrinks, the font size follows the video and every syllable stays inside it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 1)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  expect(Math.abs((await fontSizeOf(region)) - expectedFontSize((await boxOf(video)).height))).toBeLessThan(0.5)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(async () => Math.abs((await fontSizeOf(region)) - expectedFontSize((await boxOf(video)).height)))
    .toBeLessThan(0.5)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  const stage = await boxOf(video)
  for (const text of syllables) {
    const syllable = await boxOf(region.getByText(text, { exact: true }))
    expect(syllable.x).toBeGreaterThanOrEqual(stage.x - tolerance)
    expect(syllable.x + syllable.width).toBeLessThanOrEqual(stage.x + stage.width + tolerance)
  }
})
