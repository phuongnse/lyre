import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FileChooser, Page } from '@playwright/test'

const run = promisify(execFile)

// scripts/e2e.sh builds the fixture song here with lyre-cli before the journeys run.
export const fixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture.lyre', import.meta.url))
// The same song with a male vocal role, built from tests/fixtures/song/male.toml.
export const maleFixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture-male.lyre', import.meta.url))
// The same song with an H.265 video type, which Playwright's Chromium cannot play, built from
// tests/fixtures/song/h265.toml.
export const h265Fixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture-h265.lyre', import.meta.url))

// One file or several, as Playwright's `setFiles` takes them.
export type Choice = Parameters<FileChooser['setFiles']>[0]

// Chooses `file` (one choice or several) with the Player's open button on the current page.
export async function chooseSongFile(page: Page, file: Choice): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open a song file' }).click()
  await (await chooser).setFiles(file)
}

export async function openSongFile(page: Page, file: Choice): Promise<void> {
  await page.goto('/')
  await chooseSongFile(page, file)
}

// Builds the fixture song as version 1, with an access file for `deviceCode`, into `dir`. Each call
// makes a fresh content key, so the two files belong together. It runs lyre-cli as scripts/e2e.sh
// does, so cargo may compile first.
export async function buildForDevice(deviceCode: string, dir: string): Promise<{ song: string; access: string }> {
  const song = `${dir}/fixture-v1.lyre`
  const access = `${dir}/fixture-v1.lyrekey`
  const manifest = fileURLToPath(new URL('../../fixtures/song/song.toml', import.meta.url))
  await run(
    'cargo',
    ['run', '--locked', '-q', '-p', 'lyre-cli', '--', 'build', manifest, song, '--device-code', deviceCode, '--access', access],
    { cwd: fileURLToPath(new URL('../../../core', import.meta.url)) },
  )
  return { song, access }
}
