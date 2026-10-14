import { expect, Page, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Loading ONNX Runtime's WebAssembly and running two windows on one thread takes a while.
const RUN_TIMEOUT = 60_000

const lyrics = fileURLToPath(new URL('../../fixtures/song/lyrics.txt', import.meta.url))

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

for (const aligner of ['Omnilingual', 'lyric-alignment']) {
  test(`forcing WebAssembly, the ${aligner} test aligner times every syllable of the lyrics on the test audio`, async ({
    page,
  }) => {
    const problems = await watch(page)

    await page.goto('/#/model-check')
    await page.getByRole('radio', { name: aligner, exact: true }).check()
    await page.getByRole('checkbox', { name: 'Force WebAssembly' }).check()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Align test audio' }).click()
    await (await chooser).setFiles(lyrics)

    await expect(page.getByText('Aligned on WebAssembly: 2 of 2 windows done')).toBeVisible({ timeout: RUN_TIMEOUT })
    await expect(page.getByText('9 syllables timed. The song file timing check accepted the timing.')).toBeVisible()
    expect(await violations(page)).toEqual([])
    expect(problems).toEqual([])
  })
}
