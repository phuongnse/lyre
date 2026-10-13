import { fileURLToPath } from 'node:url'
import { expect, Page, test } from '@playwright/test'
import { Choice } from './song-file'

// scripts/e2e.sh makes these with tests/fixtures/source/make.sh before the journeys run.
const source = (name: string) => fileURLToPath(new URL(`../../../artifacts/e2e/sources/${name}`, import.meta.url))

// The tags that make.sh writes. The artist is a decomposed "Hà" (NFD), two spaces, then a precomposed "Nội" (NFC).
const title = 'Mưa rơi nhẹ'
const artist = 'Hà  Nội'
const composer = 'Lê Văn Thử'

// Opens the source check page and picks `file` with its button.
async function chooseSource(page: Page, file: Choice): Promise<void> {
  await page.goto('/#/source-check')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose a source' }).click()
  await (await chooser).setFiles(file)
}

const details = (page: Page) => page.getByRole('definition')
const labelled = (page: Page, name: string) => page.getByLabel(name, { exact: true })

// The number of seconds in a row such as "2.00 s".
async function secondsIn(page: Page, name: string): Promise<number> {
  const text = (await labelled(page, name).textContent()) ?? ''
  expect(text).toMatch(/^\d+\.\d{2} s$/)
  return parseFloat(text)
}

// Checks a tag row's text byte for byte, or that the row is missing.
async function expectTag(page: Page, name: string, expected: string | undefined): Promise<void> {
  if (expected === undefined) {
    await expect(labelled(page, name)).toHaveCount(0)
    return
  }
  const text = await labelled(page, name).textContent()
  expect(Buffer.from(text ?? '').toString('hex')).toBe(Buffer.from(expected).toString('hex'))
}

const cases = [
  { file: 'song.mp4', streams: 'Video and audio', tags: { Title: title, Artist: artist, Composer: composer } },
  { file: 'song.webm', streams: 'Video and audio', tags: { Title: undefined, Artist: artist, Composer: undefined } },
  { file: 'song.mp3', streams: 'Audio only', tags: { Title: title, Artist: artist, Composer: composer } },
]

for (const { file, streams, tags } of cases) {
  test(`${file} shows its duration, streams and exact tags`, async ({ page }) => {
    // A CSP or Trusted Types violation is logged to the console as an error.
    const problems: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    page.on('pageerror', (error) => problems.push(error.message))

    await chooseSource(page, source(file))
    await expect(labelled(page, 'Source details')).toBeVisible()
    expect(Math.abs((await secondsIn(page, 'Duration')) - 2)).toBeLessThanOrEqual(0.1)
    await expect(labelled(page, 'Timeline starts at')).toHaveCount(0)
    await expect(labelled(page, 'Streams')).toHaveText(streams)
    for (const [name, value] of Object.entries(tags)) await expectTag(page, name, value)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(problems).toEqual([])
  })
}

test('a video without audio shows only the no-audio message', async ({ page }) => {
  await chooseSource(page, source('video-only.webm'))
  await expect(page.getByRole('alert')).toHaveText('This file has no audio, so a song cannot be made from it.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(details(page)).toHaveCount(0)
})

test('a text file shows only the cannot-read message', async ({ page }) => {
  const buffer = Buffer.from('These are notes, not a song.\n')
  await chooseSource(page, { name: 'notes.txt', mimeType: 'text/plain', buffer })
  await expect(page.getByRole('alert')).toHaveText('This file is not a video or audio file Lyre can read.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(details(page)).toHaveCount(0)
})

test('a timeline that starts at 1.5 s shows its start offset and a duration counted from zero', async ({ page }) => {
  await chooseSource(page, source('late.webm'))
  await expect(labelled(page, 'Source details')).toBeVisible()
  expect(Math.abs((await secondsIn(page, 'Duration')) - 2)).toBeLessThanOrEqual(0.1)
  expect(Math.abs((await secondsIn(page, 'Timeline starts at')) - 1.5)).toBeLessThanOrEqual(0.05)
})

test('reading a source sends nothing: every request is a same-origin GET with no body', async ({ page }) => {
  await page.goto('/#/source-check')
  await expect(page.getByRole('button', { name: 'Choose a source' })).toBeEnabled()
  const origin = new URL(page.url()).origin
  const requests: { method: string; body: string | null; origin: string }[] = []
  page.on('request', (request) =>
    requests.push({ method: request.method(), body: request.postData(), origin: new URL(request.url()).origin }),
  )

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose a source' }).click()
  await (await chooser).setFiles(source('song.mp4'))
  await expect(labelled(page, 'Composer')).toBeVisible()

  for (const request of requests) expect(request).toEqual({ method: 'GET', body: null, origin })
})

test('the main page has no link to the source check page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open a song file' })).toBeVisible()
  await expect(page.locator('a[href*="source-check"]')).toHaveCount(0)
})

test("the built web client ships Mediabunny's licence notice", async ({ request }) => {
  const response = await request.get('/3rdpartylicenses.txt')
  expect(response.ok()).toBe(true)
  const text = await response.text()
  expect(text).toContain('mediabunny')
  expect(text).toContain('Mozilla Public License Version 2.0')
})
