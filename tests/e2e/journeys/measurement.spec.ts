import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, FileChooser, Locator, Page, test } from '@playwright/test'

// Separating and running two test aligners on one WebAssembly thread takes a while.
const RUN_TIMEOUT = 180_000

test.setTimeout(RUN_TIMEOUT + 30_000)

// The 2 s tone, which scripts/e2e.sh makes with tests/fixtures/source/make.sh,
// with the fixture song's lyrics and hand-written timing.
const source = fileURLToPath(new URL('../../../artifacts/e2e/sources/song.webm', import.meta.url))
const lyrics = fileURLToPath(new URL('../../fixtures/song/lyrics.txt', import.meta.url))
const timing = fileURLToPath(new URL('../../fixtures/song/timing.txt', import.meta.url))

// The test separator and the test aligners, on WebAssembly.
const PAGE = '/#/model-check?model=test&backend=wasm'
const CANDIDATES = ['Test Omnilingual', 'Test lyric-alignment']

// Records every Content Security Policy or Trusted Types violation, console
// error and page error, from before the page loads.
async function watch(page: Page): Promise<string[]> {
  await page.addInitScript(() => {
    const violations: string[] = []
    Object.assign(window, { violations })
    addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective))
  })
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { violations: string[] }).violations)

// Picks `files` with the button named `button`.
async function choose(page: Page, button: string, files: Parameters<FileChooser['setFiles']>[0]): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: button, exact: true }).click()
  await (await chooser).setFiles(files)
}

// Picks the source, the lyrics and `timingFile`, then starts the measurement.
async function measure(page: Page, timingFile: Parameters<FileChooser['setFiles']>[0]): Promise<void> {
  await choose(page, 'Choose a source', source)
  await choose(page, 'Choose the lyrics', lyrics)
  await choose(page, 'Choose a timing file', timingFile)
  await page.getByRole('button', { name: 'Measure the aligners' }).click()
}

const labelled = (scope: Page | Locator, name: string) => scope.getByLabel(name, { exact: true })

test("measuring the test aligners on WebAssembly shows each one's backend, stage times, sum check and onset error, and sends nothing to another origin", async ({
  page,
}) => {
  const problems = await watch(page)
  await page.goto(PAGE)
  const origin = new URL(page.url()).origin
  const origins: string[] = []
  page.on('request', (request) => origins.push(new URL(request.url()).origin))

  await measure(page, timing)

  await expect(page.getByText('The measurement is done.')).toBeVisible({ timeout: RUN_TIMEOUT })
  for (const name of CANDIDATES) {
    const result = labelled(page, name)
    await expect(result).toBeVisible()
    await expect(labelled(result, 'Backend')).toHaveText('WebAssembly')
    for (const row of ['Extract audio', 'Separate', 'Align', 'Model load']) {
      await expect(labelled(result, row)).toHaveText(/^\d+\.\d{2} s$/)
    }
    await expect(labelled(result, 'Sum check')).toHaveText(/^-?\d+\.\d dB$/)
    await expect(labelled(result, 'Onset error median')).toHaveText(/^\d+ ms$/)
    await expect(labelled(result, 'Onset error 90th percentile')).toHaveText(/^\d+ ms$/)
    await expect(labelled(result, 'Within 100 ms')).toHaveText(/^\d+%$/)
  }
  // The test models came from the site's own origin too.
  expect(origins.length).toBeGreaterThan(0)
  for (const requestOrigin of origins) expect(requestOrigin).toBe(origin)
  expect(await violations(page)).toEqual([])
  expect(problems).toEqual([])
})

test('a timing file with an overlap gets the message naming its line, and no result', async ({ page }) => {
  await page.goto(PAGE)
  // Line 4, nhẹ, now starts at 2500 ms, before line 3, rơi, ends at 2600 ms.
  // The comment on line 1 counts as a line.
  const text = readFileSync(timing, 'utf8').replace('2600 3200 nhẹ', '2500 3200 nhẹ')
  expect(text).toContain('2500 3200 nhẹ')

  await measure(page, { name: 'timing.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })

  await expect(page.getByText('Line 4 of the timing file overlaps the line before it.')).toBeVisible()
  for (const name of CANDIDATES) await expect(labelled(page, name)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Measure the aligners' })).toBeEnabled()
})

test("the main page has no link to the model check page, and the page's code loads only when it opens", async ({
  page,
}) => {
  const scripts: Promise<string>[] = []
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') scripts.push(response.text())
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open a song file' })).toBeVisible()
  await expect(page.locator('a[href*="model-check"]')).toHaveCount(0)
  const loaded = scripts.length
  expect(loaded).toBeGreaterThan(0)
  for (const body of await Promise.all(scripts)) expect(body).not.toContain('lyre-model-check')

  await page.goto('/#/model-check')
  await expect(page.getByRole('button', { name: 'Measure the aligners' })).toBeVisible()
  const opened = await Promise.all(scripts.slice(loaded))
  expect(opened.some((body) => body.includes('lyre-model-check'))).toBe(true)
})
