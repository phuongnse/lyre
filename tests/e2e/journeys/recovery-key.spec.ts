import { expect, Page, test } from '@playwright/test'
import { expectNotInPage } from './webauthn'

const section = (page: Page) => page.getByRole('region', { name: 'Recovery key' })
const createButton = (page: Page) => section(page).getByRole('button', { name: 'Create a recovery key' })
const keptButton = (page: Page) => section(page).getByRole('button', { name: 'I have kept my recovery key' })
const wordItems = (page: Page) => section(page).getByRole('list', { name: 'Recovery words' }).getByRole('listitem')
const qrImage = (page: Page) => section(page).getByRole('img', { name: 'QR code of the recovery key' })
const keptText = (page: Page) => section(page).getByText("This device keeps your recovery key's public part.", { exact: false })
const LOSS = 'If you lose every device and your recovery key, your songs cannot be opened again.'

// Collects the console before the page loads, and the names of its databases.
async function open(page: Page): Promise<string[]> {
  const messages: string[] = []
  page.on('console', (message) => messages.push(message.text()))
  await page.goto('/')
  await expect(section(page)).toBeVisible()
  return messages
}

async function databases(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await indexedDB.databases()).map((database) => database.name ?? '').sort())
}

// Every text that would give the words away: all of them, in uppercase too, and
// every run of three words in a row.
function leaks(words: string[]): string[] {
  const runs = words.slice(2).map((_, i) => words.slice(i, i + 3).join(' '))
  return [words.join(' '), words.join(' ').toUpperCase(), ...runs, ...runs.map((run) => run.toUpperCase())]
}

test('creating a recovery key shows 24 words and a QR code once, and keeps only the public key', async ({ page }) => {
  const consoleMessages = await open(page)
  const databasesBefore = await databases(page)
  await expect(createButton(page)).toBeVisible()
  await expect(wordItems(page)).toHaveCount(0)
  await expect(qrImage(page)).toHaveCount(0)
  await expect(section(page).getByText(LOSS)).toBeVisible()

  await createButton(page).click()
  await expect(wordItems(page)).toHaveCount(24)
  await expect(qrImage(page)).toBeVisible()
  await expect(section(page).getByText(LOSS)).toBeVisible()
  const words = (await wordItems(page).allInnerTexts()).map((word) => word.trim())
  expect(words).toHaveLength(24)
  for (const word of words) expect(word).toMatch(/^[a-z]+$/)
  // Nothing is kept before the owner confirms.
  expect(await page.evaluate(() => Object.entries(localStorage))).toEqual([])

  await keptButton(page).click()
  await expect(wordItems(page)).toHaveCount(0)
  await expect(qrImage(page)).toHaveCount(0)
  await expect(keptText(page)).toBeVisible()
  await expect(createButton(page)).toHaveCount(0)
  await expect(section(page).getByText(LOSS)).toBeVisible()

  await page.reload()
  await expect(section(page)).toBeVisible()
  await expect(keptText(page)).toBeVisible()
  await expect(wordItems(page)).toHaveCount(0)
  await expect(qrImage(page)).toHaveCount(0)
  await expect(createButton(page)).toHaveCount(0)

  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
  }))
  expect(stored.local).toEqual([['lyre-recovery-public-key', expect.stringMatching(/^[A-Za-z0-9_-]{44}$/)]])
  expect(stored.session).toEqual([])
  expect(stored.cookie).toBe('')
  expect(await databases(page)).toEqual(databasesBefore)

  const secrets = leaks(words)
  await expectNotInPage(page, consoleMessages, secrets)
  for (const [key, value] of stored.local) {
    for (const secret of secrets) {
      expect(key).not.toContain(secret)
      expect(value).not.toContain(secret)
    }
  }
})

test('a recovery key that is not confirmed is not kept, and a reload makes a new one', async ({ page }) => {
  await open(page)
  await createButton(page).click()
  await expect(wordItems(page)).toHaveCount(24)

  await page.reload()
  await expect(section(page)).toBeVisible()
  await expect(wordItems(page)).toHaveCount(0)
  await expect(qrImage(page)).toHaveCount(0)
  await expect(createButton(page)).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('lyre-recovery-public-key'))).toBeNull()
})

test('two tabs that show a key keep only the first one confirmed', async ({ context, page }) => {
  await open(page)
  const other = await context.newPage()
  await open(other)
  await createButton(page).click()
  await createButton(other).click()
  await expect(wordItems(page)).toHaveCount(24)
  await expect(wordItems(other)).toHaveCount(24)

  await keptButton(page).click()
  await expect(keptText(page)).toBeVisible()
  const kept = await page.evaluate(() => localStorage.getItem('lyre-recovery-public-key'))
  expect(kept).toMatch(/^[A-Za-z0-9_-]{44}$/)

  // The other tab drops its words at once, and the key stays the first one.
  await expect(wordItems(other)).toHaveCount(0)
  await expect(qrImage(other)).toHaveCount(0)
  await expect(section(other).getByRole('alert')).toContainText('Another tab already kept a recovery key')
  await expect(createButton(other)).toHaveCount(0)
  expect(await other.evaluate(() => localStorage.getItem('lyre-recovery-public-key'))).toBe(kept)
})
