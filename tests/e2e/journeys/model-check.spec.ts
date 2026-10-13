import { expect, Page, test } from '@playwright/test'

// The name of the error OPFS gives for models/test-two-block, or 'found' when the file is kept.
async function keptTestModel(page: Page): Promise<string> {
  return page.evaluate(async () => {
    try {
      const models = await (await navigator.storage.getDirectory()).getDirectoryHandle('models')
      await models.getFileHandle('test-two-block')
      return 'found'
    } catch (error) {
      return (error as DOMException).name
    }
  })
}

test('the first use downloads the test model with progress in bytes, and a later use downloads nothing', async ({
  page,
}) => {
  // A CSP violation, such as a refused download, is logged as an error.
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/test-models/')) requests.push(request.url())
  })

  await page.goto('/#/model-check')
  await page.getByRole('button', { name: 'Download the test model' }).click()
  await expect(page.getByRole('status')).toHaveText('The model file test-two-block passed its check and is kept.')
  await expect(page.getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute(
    'aria-valuetext',
    'test-two-block: 56 of 56 bytes',
  )
  expect(requests).toHaveLength(1)
  expect(await keptTestModel(page)).toBe('found')

  await page.reload()
  await page.getByRole('button', { name: 'Download the test model' }).click()
  await expect(page.getByRole('status')).toHaveText('The model file test-two-block passed its check and is kept.')
  expect(requests).toHaveLength(1)
  expect(problems).toEqual([])
})

test('a served test model with one byte changed is named as failed and is not kept', async ({ page }) => {
  await page.route('**/test-models/**', async (route) => {
    const response = await route.fetch()
    const body = await response.body()
    body[10] ^= 0x01
    await route.fulfill({ response, body })
  })

  await page.goto('/#/model-check')
  await page.getByRole('button', { name: 'Download the test model' }).click()
  await expect(page.getByRole('status')).toHaveText(
    'The model file test-two-block failed its check. It was deleted and not used.',
  )
  await expect(page.getByRole('button', { name: 'Download the test model' })).toBeEnabled()
  await expect(page.getByRole('status')).not.toContainText('passed')
  expect(await keptTestModel(page)).toBe('NotFoundError')
})
