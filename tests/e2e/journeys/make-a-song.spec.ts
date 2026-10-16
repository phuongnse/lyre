import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, Page, test } from '@playwright/test'
import { chooseSongFile, Choice, seedRecoveryKey, unlockedDeviceCode } from './song-file'
import { openWith } from './webauthn'

// Chromium refuses WebAuthn on IP address origins, so these journeys use localhost.
test.use({ baseURL: 'http://localhost:4173' })

// scripts/e2e.sh makes these with tests/fixtures/source/make.sh before the journeys run.
const source = (name: string) => fileURLToPath(new URL(`../../../artifacts/e2e/sources/${name}`, import.meta.url))

// The tags that make.sh writes. The artist is a decomposed "Hà" (NFD), two spaces, then a precomposed "Nội" (NFC).
const title = 'Mưa rơi nhẹ'
const artist = 'Ha\u0300  N\u1ed9i'
const composer = 'Lê Văn Thử'

const text = (name: string, value: string): Choice => ({ name, mimeType: 'text/plain', buffer: Buffer.from(value) })

const validLyrics = text('lyrics.txt', 'Mưa rơi\n')

// The lyrics the fixture song's test aligner can place.
const fixtureLyrics = fileURLToPath(new URL('../../fixtures/song/lyrics.txt', import.meta.url))

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

// Opens the main page at `url`, presses Make a song and waits for the section.
async function openSection(page: Page, url = '/'): Promise<void> {
  await page.goto(url)
  await page.getByRole('button', { name: 'Make a song', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make a song', exact: true })).toBeVisible()
}

// Opens the main page at `url` with a virtual passkey authenticator that has
// PRF unless `hasPrf` is false, presses Make a song and waits for the section.
async function openDeviceSection(page: Page, url: string, hasPrf = true): Promise<void> {
  await openWith(page, url, { hasPrf, backupEligible: false })
  await page.getByRole('button', { name: 'Make a song', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make a song', exact: true })).toBeVisible()
}

// Picks `file` with the button named `button`.
async function pick(page: Page, button: string, file: Choice): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: button, exact: true }).click()
  await (await chooser).setFiles(file)
}

// The test models, with the task on WebAssembly.
const TEST_PAGE = '/#/?model=test&backend=wasm'

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

// Picks song.webm, which plays for real in the task's worker, and the lyrics (the fixture's by default), chooses a role and presses Make the song.
async function start(page: Page, lyrics: Choice = fixtureLyrics): Promise<void> {
  await pick(page, 'Choose a source', source('song.webm'))
  await expect(page.getByText('Source: song.webm')).toBeVisible()
  await pick(page, 'Choose the lyrics', lyrics)
  await expect(page.getByText('Lyrics: lyrics.txt')).toBeVisible()
  await page.getByRole('radio', { name: 'Female', exact: true }).click()
  await makeTheSong(page).click()
}

// Holds ONNX Runtime's WebAssembly file back, so the task stays in separation until it is cancelled.
async function holdSeparation(page: Page): Promise<void> {
  await page.context().route('**/ort/*.wasm', () => {})
}

const stageLine = /Stage \d of 7/

test('the first run downloads each test model file once, and a run after a reload downloads none', async ({
  page,
}) => {
  const problems = watchProblems(page)
  await seedRecoveryKey(page)
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/test-models/')) requests.push(request.url())
  })
  await holdSeparation(page)
  await openDeviceSection(page, TEST_PAGE)
  await start(page)
  await expect(page.getByText(stageLine)).toBeVisible()
  expect(requests).toHaveLength(3)
  expect(new Set(requests).size).toBe(3)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Cancelled')).toBeVisible()

  await page.reload()
  await openSection(page, TEST_PAGE)
  await start(page)
  await expect(page.getByText(stageLine)).toBeVisible()
  expect(requests).toHaveLength(3)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Cancelled')).toBeVisible()
  expect(problems).toEqual([])
})

test('a test separator file with one byte changed stops the run before any stage, and names the file', async ({
  page,
}) => {
  await seedRecoveryKey(page)
  await page.route('**/test-models/mel-roformer.onnx', async (route) => {
    const response = await route.fetch()
    const body = await response.body()
    body[10] ^= 0x01
    await route.fulfill({ response, body })
  })
  await openDeviceSection(page, TEST_PAGE)
  await start(page)
  await expect(
    page.getByText('The model file test-mel-roformer failed its check. It was deleted and not used.'),
  ).toBeVisible()
  await expect(page.getByText(stageLine)).toHaveCount(0)
  await expect(makeTheSong(page)).toBeEnabled()
})

test('while the task runs, the page shows the current stage and a progress bar, and Cancel removes the working area', async ({
  page,
}) => {
  const problems = watchProblems(page)
  await seedRecoveryKey(page)
  await holdSeparation(page)
  await openDeviceSection(page, TEST_PAGE)
  await start(page)
  await expect(page.getByText('Stage 3 of 7: Separate the vocals')).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'Stage progress' })).toBeVisible()
  await expect.poll(() => workingAreas(page)).toHaveLength(1)
  await expect(makeTheSong(page)).toBeDisabled()

  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Cancelled')).toBeVisible()
  await expect.poll(() => workingAreas(page)).toEqual([])
  await expect(page.getByRole('list', { name: 'Library' }).getByRole('listitem')).toHaveCount(0)
  // The picked files, the details and the role stay as they were.
  await expect(page.getByText('Source: song.webm')).toBeVisible()
  await expect(page.getByText('Lyrics: lyrics.txt')).toBeVisible()
  await expect(field(page, 'Title')).toHaveValue('song')
  await expect(page.getByRole('radio', { name: 'Female', exact: true })).toBeChecked()
  await expect(makeTheSong(page)).toBeEnabled()
  expect(problems).toEqual([])
})

test('lyrics the aligner cannot time show one message, keep no song and leave the fields as they were', async ({
  page,
}) => {
  const problems = watchProblems(page)
  await seedRecoveryKey(page)
  await openDeviceSection(page, TEST_PAGE)
  await start(page, text('lyrics.txt', 'Mưa rơi ♪\n'))
  await expect(page.getByRole('alert')).toHaveText(
    'The song could not be made: alignment failed. Syllable 3 of lyric line 1 could not be timed.',
  )
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect.poll(() => workingAreas(page)).toEqual([])
  await expect(page.getByRole('list', { name: 'Library' }).getByRole('listitem')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Download the song file' })).toHaveCount(0)
  // The picked files, the details and the role stay as they were.
  await expect(page.getByText('Source: song.webm')).toBeVisible()
  await expect(page.getByText('Lyrics: lyrics.txt')).toBeVisible()
  await expect(field(page, 'Title')).toHaveValue('song')
  await expect(page.getByRole('radio', { name: 'Female', exact: true })).toBeChecked()
  await expect(makeTheSong(page)).toBeEnabled()
  expect(problems).toEqual([])
})

test('while another tab holds the task lock, Make the song says so and starts nothing', async ({ page }) => {
  const problems = watchProblems(page)
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/test-models/')) requests.push(request.url())
  })
  const other = await page.context().newPage()
  await other.goto('/')
  await other.evaluate(
    () =>
      new Promise<void>((held) => {
        void navigator.locks.request('lyre-task', () => {
          held()
          return new Promise(() => {})
        })
      }),
  )
  await openSection(page, TEST_PAGE)
  await start(page)
  await expect(page.getByRole('alert')).toHaveText('Another tab is making a song.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByText(stageLine)).toHaveCount(0)
  expect(await workingAreas(page)).toEqual([])
  expect(requests).toEqual([])
  await expect(makeTheSong(page)).toBeEnabled()
  expect(problems).toEqual([])
})

// The fixture's syllables, which the test aligner times on the source.
const SYLLABLES = ['Mưa', 'rơi', 'nhẹ', 'Em', 'về', 'bên', 'sông', 'Trăng', 'lên']

const songSeconds = (page: Page) =>
  page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)

// Counts the seeks of the Player's video, so a journey can show that none happened.
async function countSeeks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement
    const counted = window as unknown as { lyreSeeks: number }
    counted.lyreSeeks = 0
    video.addEventListener('seeking', () => counted.lyreSeeks++)
  })
}
const seeks = (page: Page) => page.evaluate(() => (window as unknown as { lyreSeeks: number }).lyreSeeks)

// Whether any of the fixture's syllables is the current one.
async function syllableCurrent(page: Page): Promise<boolean> {
  const region = page.getByRole('region', { name: 'Lyrics' })
  for (const text of SYLLABLES) {
    for (const syllable of await region.getByText(text, { exact: true }).all()) {
      if ((await syllable.getAttribute('aria-current')) === 'true') return true
    }
  }
  return false
}

const CANNOT_OPEN = 'This song cannot be opened on this device.'

// Picks song.webm and the fixture lyrics, sets the details and the role, and presses Make the song.
async function makeFixtureSong(page: Page): Promise<void> {
  await pick(page, 'Choose a source', source('song.webm'))
  await expect(page.getByText('Source: song.webm')).toBeVisible()
  await pick(page, 'Choose the lyrics', fixtureLyrics)
  await expect(page.getByText('Lyrics: lyrics.txt')).toBeVisible()
  await field(page, 'Title').fill('Bài hát mới')
  await field(page, 'Artist').fill('Nguyễn Thị Hà')
  await field(page, 'Composer').fill('Trần Văn Lê')
  await page.getByRole('radio', { name: 'Female', exact: true }).click()
  await makeTheSong(page).click()
}

// Downloads the link named `name` and returns the file's suggested name and path.
async function download(page: Page, name: string): Promise<{ name: string; path: string }> {
  const link = page.getByRole('link', { name, exact: true })
  await expect(link).toBeVisible()
  const pending = page.waitForEvent('download')
  await link.click()
  const done = await pending
  return { name: done.suggestedFilename(), path: await done.path() }
}

test('a finished song plays in the Player with its access file, is kept in the library, keeps the position on a switch and downloads as song.lyre and song.lyrekey', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const problems = watchProblems(page)
  await seedRecoveryKey(page)
  await openDeviceSection(page, TEST_PAGE)
  await makeFixtureSong(page)

  await expect(page.getByLabel('Song video')).toBeVisible({ timeout: 150_000 })
  const library = page.getByRole('list', { name: 'Library' })
  await expect(library.getByRole('listitem')).toHaveCount(1)

  await countSeeks(page)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const poll = { intervals: [50] }
  await expect.poll(() => syllableCurrent(page), poll).toBe(true)
  await expect.poll(() => songSeconds(page), poll).toBeGreaterThan(0.3)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  const paused = await songSeconds(page)
  const seeksBefore = await seeks(page)
  await page.getByRole('radio', { name: 'Original' }).click()
  await expect(page.getByRole('radio', { name: 'Original' })).toBeChecked()
  expect(await songSeconds(page)).toBe(paused)
  expect(await seeks(page)).toBe(seeksBefore)

  const song = await download(page, 'Download the song file')
  expect(song.name).toBe('song.lyre')
  const songBytes = readFileSync(song.path)
  // Bytes 8 and 9 of the header are the version.
  expect(songBytes.readUInt16LE(8)).toBe(1)
  const access = await download(page, 'Download the access file')
  expect(access.name).toBe('song.lyrekey')
  expect(readFileSync(access.path).length).toBeGreaterThan(0)

  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])

  // The made song stays in the library after a reload.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open a song file' })).toBeVisible()
  await expect(library.getByRole('listitem')).toHaveCount(1)
})

test("a second device, with another device code, cannot open the made song with the first device's access file", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  await seedRecoveryKey(page)
  await openDeviceSection(page, TEST_PAGE)
  await makeFixtureSong(page)
  await expect(page.getByLabel('Song video')).toBeVisible({ timeout: 150_000 })
  const song = await download(page, 'Download the song file')
  const access = await download(page, 'Download the access file')
  const songPath = testInfo.outputPath('song.lyre')
  const accessPath = testInfo.outputPath('song.lyrekey')
  writeFileSync(songPath, readFileSync(song.path))
  writeFileSync(accessPath, readFileSync(access.path))

  // The first device's code, from the unlock the run already made.
  const thisDevice = page.getByRole('region', { name: 'This device' })
  await thisDevice.getByRole('button', { name: 'Show the device code' }).click()
  const firstCode = await thisDevice.getByText(/^lyre1p[02-9ac-hj-np-z]{59}$/).innerText()

  // A fresh browser context has its own virtual passkey, so its device code differs.
  const other = await browser.newContext({ baseURL: 'http://localhost:4173' })
  try {
    const otherPage = await other.newPage()
    expect(await unlockedDeviceCode(otherPage)).not.toBe(firstCode)
    await chooseSongFile(otherPage, [songPath, accessPath])
    await expect(otherPage.getByRole('alert')).toHaveText(CANNOT_OPEN)
    await expect(otherPage.getByLabel('Song video')).toHaveCount(0)
  } finally {
    await other.close()
  }
})

test('with no recovery key, Make the song says so, fetches no model file and creates no passkey', async ({ page }) => {
  const problems = watchProblems(page)
  const requests = watchModelRequests(page)
  await openDeviceSection(page, TEST_PAGE)
  await start(page)
  await expect(page.getByRole('alert')).toHaveText('Create a recovery key before making your first song.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByText(stageLine)).toHaveCount(0)
  expect(await workingAreas(page)).toEqual([])
  expect(requests).toEqual([])
  expect(await page.evaluate(() => localStorage.getItem('lyre-device-passkey'))).toBeNull()
  await expect(makeTheSong(page)).toBeEnabled()
  expect(problems).toEqual([])
})

test('with a passkey that has no PRF, Make the song says the device has no device code and fetches no model file', async ({
  page,
}) => {
  const requests = watchModelRequests(page)
  await seedRecoveryKey(page)
  await openDeviceSection(page, TEST_PAGE, false)
  await start(page)
  await expect(
    page.getByRole('alert').filter({ hasText: 'This device has no device code, so it cannot make songs.' }),
  ).toHaveCount(1)
  await expect(page.getByText(stageLine)).toHaveCount(0)
  expect(await workingAreas(page)).toEqual([])
  expect(requests).toEqual([])
  await expect(makeTheSong(page)).toBeEnabled()
})
