import { fileURLToPath } from 'node:url'
import { Browser, expect, Page, test } from '@playwright/test'
import { buildForDevice, fixture, unlockedDeviceCode } from './song-file'
import { expectNotInPage, openWith } from './webauthn'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })
// The set-up makes two songs in the browser, and one journey builds a song with lyre-cli, so cargo may compile first.
test.setTimeout(240_000)

// scripts/e2e.sh makes these with tests/fixtures/source/make.sh before the journeys run.
const source = (name: string) => fileURLToPath(new URL(`../../../artifacts/e2e/sources/${name}`, import.meta.url))
const text = (name: string, value: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(value) })

const KEY = 'lyre-recovery-public-key'
const WORDS_REFUSED = 'These are not the 24 words of a recovery key. Check each word and try again.'
const NOT_RESTORED = 'This file does not open with this recovery key.'

const recoverySection = (page: Page) => page.getByRole('region', { name: 'Recovery key' })
const restoreSection = (page: Page) => page.getByRole('region', { name: 'Restore songs' })
const wordsField = (page: Page) => restoreSection(page).getByRole('textbox', { name: 'Recovery words' })
const results = (page: Page) => restoreSection(page).getByRole('list', { name: 'Restore results' })
const library = (page: Page) => page.getByRole('list', { name: 'Library' })

// The owner's first device made a recovery key and two songs for itself. They are made once for the journeys.
let words: string[]
let recoveryPublicKey: string
let songs: string[]

// Every text that would give the words away: every run of three words in a row, in uppercase too.
function leaks(words: string[]): string[] {
  const runs = words.slice(2).map((_, i) => words.slice(i, i + 3).join(' '))
  return [...runs, ...runs.map((run) => run.toUpperCase())]
}

// Creates a recovery key in the page, and keeps its public part.
async function createRecoveryKey(page: Page): Promise<string[]> {
  await recoverySection(page).getByRole('button', { name: 'Create a recovery key' }).click()
  const items = recoverySection(page).getByRole('list', { name: 'Recovery words' }).getByRole('listitem')
  await expect(items).toHaveCount(24)
  const words = (await items.allInnerTexts()).map((word) => word.trim())
  await recoverySection(page).getByRole('button', { name: 'I have kept my recovery key' }).click()
  await expect(items).toHaveCount(0)
  return words
}

// Makes a song file on the source check page, for this device and the kept recovery key, and
// downloads it to `path`.
async function makeSong(page: Page, path: string): Promise<void> {
  await page.goto('/#/source-check')
  await page.reload()
  const pick = async (button: string, file: Parameters<Page['setInputFiles']>[1]) => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: button }).click()
    await (await chooser).setFiles(file)
  }
  await pick('Choose a source', source('song.webm'))
  await expect(page.getByLabel('Source details', { exact: true })).toBeVisible()
  await pick('Choose a karaoke track', source('karaoke.webm'))
  await pick('Choose the lyrics', text('lyrics.txt', 'Mưa rơi\n'))
  await pick('Choose a timing file', text('timing.txt', '0 500 Mưa\n500 1000 rơi\n'))
  await page.getByRole('radio', { name: 'Female' }).click()
  await page.getByRole('button', { name: 'Make the song file' }).click()
  const link = page.getByRole('link', { name: 'Download the song file' })
  await expect(link).toBeVisible({ timeout: 60_000 })
  const download = page.waitForEvent('download')
  await link.click()
  await (await download).saveAs(path)
}

// A new device: a fresh browser context with its own passkey, storage and library, unlocked.
async function newDevice(browser: Browser): Promise<{ page: Page; console: string[]; code: string }> {
  const context = await browser.newContext({ baseURL: 'http://localhost:4173' })
  const page = await context.newPage()
  const messages: string[] = []
  page.on('console', (message) => messages.push(message.text()))
  const code = await unlockedDeviceCode(page)
  return { page, console: messages, code }
}

async function restore(page: Page, wordsText: string, files: string[]): Promise<void> {
  await wordsField(page).fill(wordsText)
  const chooser = page.waitForEvent('filechooser')
  await restoreSection(page).getByRole('button', { name: 'Choose song files' }).click()
  await (await chooser).setFiles(files)
  await restoreSection(page).getByRole('button', { name: 'Restore the songs' }).click()
}

async function expectPlays(page: Page): Promise<void> {
  const video = page.getByLabel('Song video')
  await expect(video).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1)
}

test.describe.serial('restoring songs on a new device', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:4173' })
    const page = await context.newPage()
    await openWith(page, '/', { hasPrf: true, backupEligible: false })
    words = await createRecoveryKey(page)
    recoveryPublicKey = (await page.evaluate((key) => localStorage.getItem(key), KEY))!
    songs = [testInfo.outputPath('first.lyre'), testInfo.outputPath('second.lyre')]
    for (const path of songs) await makeSong(page, path)
    await context.close()
  })

  test('a new device restores both songs with the words, lists them in the library, plays them and offers Share', async ({
    browser,
  }) => {
    const { page, console: messages } = await newDevice(browser)
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull()
    await expect(library(page)).toHaveCount(0)

    await restore(page, words.join(' '), songs)
    await expect(results(page).getByRole('listitem')).toHaveText(['first.lyre: restored', 'second.lyre: restored'])
    await expect(page.getByRole('alert')).toHaveCount(0)

    // The words left the field at the press and are nowhere in the page, the storage or the console.
    await expect(wordsField(page)).toHaveValue('')
    const storage = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }))
    for (const [name, value] of [...storage.local, ...storage.session]) {
      for (const secret of leaks(words)) {
        expect(name).not.toContain(secret)
        expect(value).not.toContain(secret)
      }
    }
    await expectNotInPage(page, messages, leaks(words))

    // The device keeps the recovery public key, so its next songs are wrapped for the same recovery key.
    expect(Object.fromEntries(storage.local)[KEY]).toBe(recoveryPublicKey)
    expect(storage.session).toEqual([])
    await expect(recoverySection(page).getByText("This device keeps your recovery key's public part.", { exact: false })).toBeVisible()
    await expect(recoverySection(page).getByRole('button', { name: 'Create a recovery key' })).toHaveCount(0)

    // Both songs are in the library, also after a reload, and each plays with Share offered.
    await page.reload()
    await expect(library(page).getByRole('listitem')).toHaveCount(2)
    for (const index of [0, 1]) {
      await library(page).getByRole('listitem').nth(index).getByRole('button').click()
      await expectPlays(page)
      await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await page.reload()
      await expect(library(page).getByRole('listitem')).toHaveCount(2)
    }
  })

  test('words with one word changed give one alert and restore nothing', async ({ browser }) => {
    const { page } = await newDevice(browser)
    // A word that is not in the list, and a word missing: the core refuses both before it reads a file.
    const changed = [...words]
    changed[5] = 'notaword'
    for (const wrong of [changed.join(' '), words.slice(1).join(' ')]) {
      await restore(page, wrong, songs)
      await expect(page.getByRole('alert')).toHaveText(WORDS_REFUSED)
      await expect(wordsField(page)).toHaveValue('')
      await expect(results(page)).toHaveCount(0)
      await expect(library(page)).toHaveCount(0)
      await expect(restoreSection(page)).not.toContainText(': restored')
      expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull()
    }
    await page.reload()
    await expect(page.getByRole('button', { name: 'Open a song file' })).toBeVisible()
    await expect(library(page)).toHaveCount(0)
  })

  test('a song of a thrown-away recovery key and a version-0 song are not restored, and the owner’s song is', async ({
    browser,
  }, testInfo) => {
    const { page, code } = await newDevice(browser)
    const built = await buildForDevice(code, testInfo.outputPath('cli'))
    await restore(page, words.join(' '), [built.song, songs[0], fixture])
    await expect(results(page).getByRole('listitem')).toHaveText([
      `song-v1.lyre: not restored. ${NOT_RESTORED}`,
      'first.lyre: restored',
      `fixture.lyre: not restored. ${NOT_RESTORED}`,
    ])
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(library(page).getByRole('listitem')).toHaveCount(1)
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(recoveryPublicKey)
  })

  test('a restore that opens no song keeps no recovery public key', async ({ browser }, testInfo) => {
    const { page, code } = await newDevice(browser)
    const built = await buildForDevice(code, testInfo.outputPath('cli'))
    await restore(page, words.join(' '), [built.song])
    await expect(results(page).getByRole('listitem')).toHaveText([`song-v1.lyre: not restored. ${NOT_RESTORED}`])
    await expect(library(page)).toHaveCount(0)
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull()
    await expect(recoverySection(page).getByRole('button', { name: 'Create a recovery key' })).toBeVisible()
  })
})
