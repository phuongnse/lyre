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

const syllables = ['Mưa', 'rơi', 'nhẹ', 'Em', 'về', 'bên', 'sông']

for (const [width, height] of [
  [1280, 720],
  [390, 844],
  [844, 390],
]) {
  test(`at ${width}×${height} both rows lie over the bottom of the video`, async ({ page }) => {
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
    expect(stage.y + stage.height - top.y).toBeLessThanOrEqual(stage.height / 3 + tolerance)
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
    const gap = 0.3 * (await fontSizeOf(region))
    for (const text of syllables) {
      const syllable = await boxOf(region.getByText(text, { exact: true }))
      expect(syllable.x).toBeGreaterThanOrEqual(stage.x + gap - tolerance)
      expect(syllable.x + syllable.width).toBeLessThanOrEqual(stage.x + stage.width - gap + tolerance)
    }
    const top = await boxOf(region.getByRole('paragraph').nth(0))
    expect(stage.y + stage.height - top.y).toBeLessThanOrEqual(stage.height / 3 + tolerance)
  })
}

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)

for (const [width, height] of [
  [1280, 720],
  [390, 844],
]) {
  test(`at ${width}×${height} the lyrics keep one gap at the sides, below the bottom row and between the rows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    const { region, video } = await openFixture(page)
    await seek(video, 4)
    await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
    const gap = 0.3 * (await fontSizeOf(region))
    const stage = await boxOf(video)
    // The Countdown's box includes its gap to the line, so its width is the dots margin.
    const dots = await boxOf(region.getByRole('progressbar', { name: 'Countdown' }))
    const first = await boxOf(region.getByText('Mưa', { exact: true }))
    const last = await boxOf(region.getByText('sông', { exact: true }))
    const top = await boxOf(region.getByRole('paragraph').nth(0))
    const bottom = await boxOf(region.getByRole('paragraph').nth(1))
    near(first.x, stage.x + gap + dots.width)
    near(last.x + last.width, stage.x + stage.width - gap)
    near(stage.y + stage.height - (bottom.y + bottom.height), gap)
    near(bottom.y - (top.y + top.height), gap)
  })
}

test('at 9.5 s the Countdown is at the left gap and the top row is where it was at 4.0 s', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 4)
  await expectRows(region, ['Mưa rơi nhẹ', 'Em về bên sông'])
  const before = await boxOf(region.getByRole('paragraph').nth(0))
  await seek(video, 9.5)
  await expectRows(region, ['Trăng lên', ''])
  const gap = 0.3 * (await fontSizeOf(region))
  const stage = await boxOf(video)
  const countdown = await boxOf(region.getByRole('progressbar', { name: 'Countdown' }))
  const top = await boxOf(region.getByRole('paragraph').nth(0))
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

test('at 5.0 s the Countdown lies inside the video', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const { region, video } = await openFixture(page)
  await seek(video, 5)
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
