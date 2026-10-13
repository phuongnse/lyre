import { fileURLToPath } from 'node:url'
import { Page } from '@playwright/test'

// scripts/e2e.sh builds the fixture song here with lyre-cli before the journeys run.
export const fixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture.lyre', import.meta.url))
// The same song with a male vocal role, built from tests/fixtures/song/male.toml.
export const maleFixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture-male.lyre', import.meta.url))
// The same song with an H.265 video type, which Playwright's Chromium cannot play, built from
// tests/fixtures/song/h265.toml.
export const h265Fixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture-h265.lyre', import.meta.url))

export type Choice = string | { name: string; mimeType: string; buffer: Buffer }

// Chooses `file` with the Player's open button on the current page.
export async function chooseSongFile(page: Page, file: Choice): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open a song file' }).click()
  await (await chooser).setFiles(file)
}

export async function openSongFile(page: Page, file: Choice): Promise<void> {
  await page.goto('/')
  await chooseSongFile(page, file)
}
