import { fileURLToPath } from 'node:url'
import { expect, Page, test } from '@playwright/test'
import { Choice } from './song-file'

// scripts/e2e.sh makes these with tests/fixtures/source/make.sh before the journeys run.
const source = (name: string) => fileURLToPath(new URL(`../../../artifacts/e2e/sources/${name}`, import.meta.url))

// The tags that make.sh writes. The artist is a decomposed "Hà" (NFD), two spaces, then a precomposed "Nội" (NFC).
const title = 'Mưa rơi nhẹ'
const artist = 'Ha\u0300  N\u1ed9i'
const composer = 'Lê Văn Thử'

const text = (name: string, value: string): Choice => ({ name, mimeType: 'text/plain', buffer: Buffer.from(value) })

const validLyrics = text('lyrics.txt', 'Mưa rơi\n')

// Fails the journey on console errors, such as a CSP or Trusted Types violation.
function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

// Makes this browser report that it cannot play a stored type holding `codec`,
// as a browser without that decoder does.
async function reportUnplayable(page: Page, codec: string): Promise<void> {
  await page.addInitScript((codec) => {
    const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource)
    MediaSource.isTypeSupported = (type) => !type.includes(codec) && isTypeSupported(type)
  }, codec)
}

// Makes this browser report that it can play every stored type. Playwright's
// Chromium refuses MP3 as stored, and only a playable MP3 shows all three tags.
async function reportPlayable(page: Page): Promise<void> {
  await page.addInitScript(() => {
    MediaSource.isTypeSupported = () => true
  })
}

// Opens the main page, presses Make a song and waits for the section.
async function openSection(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Make a song', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make a song', exact: true })).toBeVisible()
}

// Picks `file` with the button named `button`.
async function pick(page: Page, button: string, file: Choice): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: button, exact: true }).click()
  await (await chooser).setFiles(file)
}

const makeTheSong = (page: Page) => page.getByRole('button', { name: 'Make the song', exact: true })
const field = (page: Page, name: string) => page.getByLabel(name, { exact: true })

// A field's text as hex, so a journey compares it byte for byte.
async function hexOf(page: Page, name: string): Promise<string> {
  return Buffer.from(await field(page, name).inputValue()).toString('hex')
}

const hex = (value: string) => Buffer.from(value).toString('hex')

test('a source this browser cannot play shows the reason, and Make the song stays off', async ({ page }) => {
  const problems = watchProblems(page)
  await reportUnplayable(page, 'opus')
  await openSection(page)
  await pick(page, 'Choose a source', source('song.webm'))
  await expect(page.getByRole('alert')).toHaveText(
    "This browser cannot play this source's audio (Opus), so a song cannot be made from it.",
  )
  await expect(page.getByRole('alert')).toHaveCount(1)
  await pick(page, 'Choose the lyrics', validLyrics)
  await expect(page.getByText('Lyrics: lyrics.txt')).toBeVisible()
  await field(page, 'Title').fill('Mưa rơi nhẹ')
  await page.getByRole('radio', { name: 'Female', exact: true }).click()
  await expect(makeTheSong(page)).toBeDisabled()
  expect(problems).toEqual([])
})

const invalidLyrics: [string, Choice][] = [
  ['with no letters', text('lyrics.txt', '123\n')],
  ['that are not UTF-8', { name: 'lyrics.txt', mimeType: 'text/plain', buffer: Buffer.from([0xff, 0xfe]) }],
]

for (const [kind, lyrics] of invalidLyrics) {
  test(`lyrics ${kind} show the invalid lyrics message, and Make the song stays off`, async ({ page }) => {
    const problems = watchProblems(page)
    await reportPlayable(page)
    await openSection(page)
    await pick(page, 'Choose a source', source('song.webm'))
    await expect(page.getByText('Source: song.webm')).toBeVisible()
    await pick(page, 'Choose the lyrics', lyrics)
    await expect(page.getByRole('alert')).toHaveText('The lyrics file is not valid lyrics.')
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(field(page, 'Title')).toHaveValue('song')
    await page.getByRole('radio', { name: 'Female', exact: true }).click()
    await expect(makeTheSong(page)).toBeDisabled()
    expect(problems).toEqual([])
  })
}

test('song.mp3, playable, fills the details byte for byte from its tags', async ({ page }) => {
  const problems = watchProblems(page)
  await reportPlayable(page)
  await openSection(page)
  await pick(page, 'Choose a source', source('song.mp3'))
  await expect(page.getByText('Source: song.mp3')).toBeVisible()
  expect(await hexOf(page, 'Title')).toBe(hex(title))
  expect(await hexOf(page, 'Artist')).toBe(hex(artist))
  expect(await hexOf(page, 'Composer')).toBe(hex(composer))
  expect(problems).toEqual([])
})

test('song.webm fills the title from its file name, the artist from its tag and leaves the composer empty', async ({
  page,
}) => {
  const problems = watchProblems(page)
  await reportPlayable(page)
  await openSection(page)
  await pick(page, 'Choose a source', source('song.webm'))
  await expect(page.getByText('Source: song.webm')).toBeVisible()
  expect(await field(page, 'Title').inputValue()).toBe('song')
  expect(await hexOf(page, 'Artist')).toBe(hex(artist))
  await expect(field(page, 'Composer')).toHaveValue('')
  expect(problems).toEqual([])
})

test('Make the song is off until a source, valid lyrics, a title and a vocal role are set', async ({ page }) => {
  const problems = watchProblems(page)
  await reportPlayable(page)
  await openSection(page)
  await expect(makeTheSong(page)).toBeDisabled()
  await expect(page.getByRole('radio', { name: 'Female', exact: true })).not.toBeChecked()
  await expect(page.getByRole('radio', { name: 'Male', exact: true })).not.toBeChecked()
  await pick(page, 'Choose a source', source('song.webm'))
  await expect(page.getByText('Source: song.webm')).toBeVisible()
  await expect(makeTheSong(page)).toBeDisabled()
  await pick(page, 'Choose the lyrics', validLyrics)
  await expect(page.getByText('Lyrics: lyrics.txt')).toBeVisible()
  await expect(makeTheSong(page)).toBeDisabled()
  await page.getByRole('radio', { name: 'Male', exact: true }).click()
  await expect(makeTheSong(page)).toBeEnabled()
  await field(page, 'Title').fill('')
  await expect(makeTheSong(page)).toBeDisabled()
  await field(page, 'Title').fill('Another title')
  await expect(makeTheSong(page)).toBeEnabled()
  expect(problems).toEqual([])
})

test("the main page's initial scripts hold neither the section's code nor any check page's code", async ({ page }) => {
  const scripts: Promise<string>[] = []
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') scripts.push(response.text())
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open a song file' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  const loaded = scripts.length
  expect(loaded).toBeGreaterThan(0)
  // The main page names the tag in the template of its deferred block, so the
  // section's code is told by its component definition's selector.
  const definesSection = /selectors:\s*\[\[\s*["'`]lyre-make-song["'`]\s*\]\]/
  const checkPages = [
    'lyre-source-check',
    'lyre-model-check',
    'lyre-passkey-check',
    'lyre-task-check',
    'lyre-separation-check',
  ]
  for (const body of await Promise.all(scripts)) {
    expect(body).not.toMatch(definesSection)
    for (const selector of checkPages) expect(body).not.toContain(selector)
  }

  await page.getByRole('button', { name: 'Make a song', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make a song', exact: true })).toBeVisible()
  const opened = await Promise.all(scripts.slice(loaded))
  expect(opened.some((body) => definesSection.test(body))).toBe(true)
})
