import { readFileSync } from 'node:fs'
import { expect, Page, test } from '@playwright/test'
import { buildForDevice, chooseSongFile, fixture, openV1Fixture, unlockedDeviceCode } from './song-file'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })
// Each journey builds its song with lyre-cli, so cargo may compile first.
test.setTimeout(180_000)

const mayBeCleared = 'Your browser did not allow lasting storage, so it may clear these songs.'

// Chromium decides about persistent storage by its own rules, so the journeys
// replace its answer to persist() and persisted() with `granted`.
async function answerPersistence(page: Page, granted: boolean): Promise<void> {
  await page.addInitScript((granted) => {
    for (const name of ['persist', 'persisted']) {
      Object.defineProperty(StorageManager.prototype, name, { value: async () => granted })
    }
  }, granted)
}

const library = (page: Page) => page.getByRole('list', { name: 'Library' })

// Opens the fixture song and waits until the library lists it.
async function keepFixture(page: Page): Promise<void> {
  await openV1Fixture(page)
  await expect(page.getByLabel('Song video')).toBeVisible()
  await expect(library(page).getByRole('listitem')).toHaveCount(1)
}

// When each kept song was last opened, read from the web client's IndexedDB.
// The page shows no change when a song is kept again, so this tells when it is.
function keptAt(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const opening = indexedDB.open('lyre')
        opening.onerror = () => reject(opening.error)
        opening.onsuccess = () => {
          const database = opening.result
          const reading = database.transaction('songs').objectStore('songs').getAll()
          reading.onerror = () => reject(reading.error)
          reading.onsuccess = () => {
            database.close()
            resolve(reading.result.map((song: { openedAt: number }) => song.openedAt))
          }
        }
      }),
  )
}

test('after a reload, the library lists the fixture song with its details', async ({ page }) => {
  await answerPersistence(page, true)
  await keepFixture(page)
  await page.reload()

  const songs = library(page).getByRole('listitem')
  await expect(songs).toHaveCount(1)
  await expect(songs.getByRole('button', { name: 'Mưa rơi nhẹ' })).toBeVisible()
  await expect(songs).toContainText('Artist: Lyre fixtures')
  await expect(songs).toContainText('Composer: Lyre fixture composer')
})

test('after a reload, choosing the fixture song in the library plays it', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  await answerPersistence(page, true)
  await keepFixture(page)
  await page.reload()

  await page.getByRole('button', { name: 'Mưa rơi nhẹ' }).click()
  const video = page.getByLabel('Song video')
  await expect(video).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('opening the fixture song twice lists it once', async ({ page }, testInfo) => {
  await answerPersistence(page, true)
  const code = await unlockedDeviceCode(page)
  const { song, access } = await buildForDevice(code, testInfo.outputPath('v1'))
  await chooseSongFile(page, [song, access])
  await expect(page.getByLabel('Song video')).toBeVisible()
  await expect(library(page).getByRole('listitem')).toHaveCount(1)
  const [first] = await keptAt(page)

  await chooseSongFile(page, [song, access])
  await expect(page.getByLabel('Song video')).toBeVisible()
  // Waits until the second file is kept, then reads the list again from storage.
  await expect.poll(async () => (await keptAt(page)).every((openedAt) => openedAt > first)).toBe(true)
  await page.reload()
  await expect(library(page).getByRole('listitem')).toHaveCount(1)
})

test('when the browser refuses persistent storage, the library says it may clear the songs', async ({ page }) => {
  await answerPersistence(page, false)
  await keepFixture(page)
  await expect(page.getByText(mayBeCleared)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.reload()
  await expect(library(page).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByText(mayBeCleared)).toBeVisible()
})

test('when the browser grants persistent storage, the library does not say it may clear the songs', async ({
  page,
}) => {
  await answerPersistence(page, true)
  await keepFixture(page)
  await expect(page.getByText(mayBeCleared)).toHaveCount(0)

  await page.reload()
  await expect(library(page).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByText(mayBeCleared)).toHaveCount(0)
})

test('after a reload, a version-0 entry in the library is listed as no longer playing, and choosing it is refused', async ({
  page,
}) => {
  await answerPersistence(page, true)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open a song file' })).toBeVisible()
  // Writes the entry as the web client did before version 1: the song file, with no access file.
  const bytes = Array.from(readFileSync(fixture))
  await page.evaluate(
    (bytes) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('lyre', 1)
        opening.onerror = () => reject(opening.error)
        opening.onupgradeneeded = () => opening.result.createObjectStore('songs', { keyPath: 'songId' })
        opening.onsuccess = () => {
          const database = opening.result
          const writing = database.transaction('songs', 'readwrite')
          writing.objectStore('songs').put({
            songId: '00112233445566778899aabbccddeeff',
            title: 'Mưa rơi nhẹ',
            artist: '',
            composer: '',
            openedAt: Date.now(),
            file: new Blob([Uint8Array.from(bytes)]),
          })
          writing.onerror = () => reject(writing.error)
          writing.oncomplete = () => {
            database.close()
            resolve()
          }
        }
      }),
    bytes,
  )
  await page.reload()

  const songs = library(page).getByRole('listitem')
  await expect(songs).toHaveCount(1)
  await expect(songs).toContainText('No longer plays')
  await songs.getByRole('button', { name: 'Mưa rơi nhẹ' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'This song file is from an older version of Lyre and no longer plays.',
  )
  await expect(page.getByLabel('Song video')).toHaveCount(0)
})
