import { fileURLToPath } from 'node:url'
import { expect, Page, test } from '@playwright/test'
import { Choice } from './song-file'

// Chromium without a GPU gives no adapter. The page has no backend parameter here, so it checks the device.
test.use({ launchOptions: { args: ['--disable-gpu'] } })

const PAGE = '/#/?model=test'

// scripts/e2e.sh makes these with tests/fixtures/source/make.sh before the journeys run.
const source = (name: string) => fileURLToPath(new URL(`../../../artifacts/e2e/sources/${name}`, import.meta.url))

// The lyrics the fixture song's test aligner can place.
const fixtureLyrics = fileURLToPath(new URL('../../fixtures/song/lyrics.txt', import.meta.url))

const makeTheSong = (page: Page) => page.getByRole('button', { name: 'Make the song', exact: true })
const stageLine = /Stage \d of 7/

// Fails the journey on console errors, such as a CSP or Trusted Types violation.
function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

// The URLs of the test model requests, so a journey checks that none was made.
function watchModelRequests(page: Page): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/test-models/')) requests.push(request.url())
  })
  return requests
}

// Opens the main page at `url`, presses Make a song and waits for the section.
async function openSection(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByRole('button', { name: 'Make a song', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make a song', exact: true })).toBeVisible()
}

// Picks `file` with the button named `button`.
async function pick(page: Page, button: string, file: string | Choice): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: button, exact: true }).click()
  await (await chooser).setFiles(file)
}

// The names of the working areas under tasks/ in the origin private file system.
async function workingAreas(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    let tasks: FileSystemDirectoryHandle
    try {
      tasks = await root.getDirectoryHandle('tasks')
    } catch {
      return []
    }
    const names: string[] = []
    // The e2e tsconfig's DOM types lack the folder's async iterators.
    for await (const name of (tasks as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name)
    return names
  })
}

// Picks song.webm and the lyrics, chooses a role and presses Make the song.
async function start(page: Page): Promise<void> {
  await pick(page, 'Choose a source', source('song.webm'))
  await expect(page.getByText('Source: song.webm')).toBeVisible()
  await pick(page, 'Choose the lyrics', fixtureLyrics)
  await expect(page.getByText('Lyrics: lyrics.txt')).toBeVisible()
  await page.getByRole('radio', { name: 'Female', exact: true }).click()
  await makeTheSong(page).click()
}

// Fails the journey when anything past the check started: a stage, a working area or a model request.
async function expectNothingStarted(page: Page, requests: string[]): Promise<void> {
  await expect(page.getByText(stageLine)).toHaveCount(0)
  expect(await workingAreas(page)).toEqual([])
  expect(requests).toEqual([])
}

test('with no GPU adapter, Make the song names WebGPU and starts nothing', async ({ page }) => {
  const problems = watchProblems(page)
  const requests = watchModelRequests(page)
  await openSection(page, PAGE)
  await start(page)
  await expect(page.getByRole('alert')).toHaveText('This device cannot make songs. WebGPU is not available.')
  await expectNothingStarted(page, requests)
  await expect(makeTheSong(page)).toBeEnabled()
  expect(problems).toEqual([])
})

test('with an adapter and 4 GB of memory, Make the song names the memory and starts nothing', async ({ page }) => {
  const problems = watchProblems(page)
  const requests = watchModelRequests(page)
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', {
      configurable: true,
      get: () => ({ requestAdapter: async () => ({ info: {} }) }),
    })
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 })
  })
  await openSection(page, PAGE)
  await start(page)
  await expect(page.getByRole('alert')).toHaveText('This device cannot make songs. It has less than 8 GB of memory.')
  await expectNothingStarted(page, requests)
  expect(problems).toEqual([])
})
