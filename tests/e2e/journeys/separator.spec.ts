import { expect, Page, test } from '@playwright/test'

// Loading ONNX Runtime's WebAssembly and running one segment on one thread takes a while.
const RUN_TIMEOUT = 60_000

const ran = 'The test separator ran on WebAssembly. stems_spec 1×4×1025×801.'

// Records every Content Security Policy or Trusted Types violation, console
// error and page error, and every request's URL, from before the page loads.
async function watch(page: Page): Promise<{ problems: string[]; requests: string[] }> {
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
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  return { problems, requests }
}

async function runSeparator(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.getByRole('button', { name: 'Run the test separator' }).click()
  await expect(page.getByText(ran)).toBeVisible({ timeout: RUN_TIMEOUT })
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { violations: string[] }).violations)

test('forcing WebAssembly, the test separator runs one window and reports its backend and output shapes', async ({
  page,
}) => {
  const { problems } = await watch(page)

  await runSeparator(page, '/#/model-check?backend=wasm')

  expect(await violations(page)).toEqual([])
  expect(problems).toEqual([])
})

test("under /lyre/, the run loads ONNX Runtime and everything else from the page's own origin", async ({ page }) => {
  const { problems, requests } = await watch(page)

  await runSeparator(page, '/lyre/#/model-check?backend=wasm')

  const origin = new URL(page.url()).origin
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([])
  expect(requests.filter((url) => new URL(url).pathname.startsWith('/lyre/ort/') && url.endsWith('.wasm'))).toHaveLength(
    1,
  )
  expect(await violations(page)).toEqual([])
  expect(problems).toEqual([])
})
