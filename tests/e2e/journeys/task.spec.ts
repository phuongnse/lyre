import { expect, Page, test } from '@playwright/test'

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

// Starts a test task on the task check page and waits until its working area exists.
async function startTask(page: Page): Promise<void> {
  await page.goto('/#/task-check')
  await page.getByRole('button', { name: 'Start a test task' }).click()
  await expect(page.getByRole('status')).toContainText('Stage 1 of 3')
  await expect.poll(() => workingAreas(page)).toHaveLength(1)
}

test('cancelling a task during a stage removes its working area, and the page stays responsive', async ({ page }) => {
  // A Trusted Types or CSP violation, such as a refused worker URL, is logged as an error.
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))

  await startTask(page)

  // Each stage step keeps the worker busy for about 100 ms. On the main thread
  // that would delay a timer by as much.
  const lags = await page.evaluate(async () => {
    const lags: number[] = []
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 0))
      lags.push(performance.now() - start)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return lags
  })
  for (const lag of lags) expect(lag).toBeLessThan(50)
  await expect(page.getByRole('status')).toContainText(/Stage \d of 3/)

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('status')).toHaveText('Cancelled')
  await expect.poll(() => workingAreas(page)).toEqual([])
  await expect(page.getByRole('button', { name: 'Start a test task' })).toBeEnabled()
  expect(problems).toEqual([])
})

test('a reload during a task leaves no working area once the web client has started again', async ({ page }) => {
  await startTask(page)
  await page.reload()
  // The reload opens the task check page again, which shows once the web client has started.
  await expect(page.getByRole('button', { name: 'Start a test task' })).toBeEnabled()
  await expect.poll(() => workingAreas(page)).toEqual([])
})
