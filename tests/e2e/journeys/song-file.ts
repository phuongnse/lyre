import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FileChooser, Page, test } from '@playwright/test'
import { openWith } from './webauthn'

const run = promisify(execFile)

// scripts/e2e.sh builds the fixture song here with lyre-cli before the journeys run. It is a
// version-0 file, which the Player no longer plays, so only the refusal journeys use it. The
// other journeys build version-1 songs with `buildForDevice`.
export const fixture = fileURLToPath(new URL('../../../artifacts/e2e/fixture.lyre', import.meta.url))

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

// The manifests of tests/fixtures/song: the fixture song, the same song with a male vocal role, and
// the same song with an H.265 video type, which Playwright's Chromium cannot play.
export type Manifest = 'song.toml' | 'male.toml' | 'h265.toml'

// Builds the fixture song from `manifest` as version 1, with an access file for `deviceCode`, into
// `dir`. Each call makes a fresh content key, so the two files belong together. It runs lyre-cli as
// scripts/e2e.sh does, so cargo may compile first.
export async function buildForDevice(
  deviceCode: string,
  dir: string,
  manifest: Manifest = 'song.toml',
): Promise<{ song: string; access: string }> {
  const name = manifest.replace(/\.toml$/, '')
  const song = `${dir}/${name}-v1.lyre`
  const access = `${dir}/${name}-v1.lyrekey`
  const manifestPath = fileURLToPath(new URL(`../../fixtures/song/${manifest}`, import.meta.url))
  await run(
    'cargo',
    ['run', '--locked', '-q', '-p', 'lyre-cli', '--', 'build', manifestPath, song, '--device-code', deviceCode, '--access', access],
    { cwd: fileURLToPath(new URL('../../../core', import.meta.url)) },
  )
  return { song, access }
}

// Opens the page with a device-bound passkey, and shows the device code, so the
// device is unlocked and a refusal cannot come from a failed unlock. Chromium refuses
// WebAuthn on IP address origins, so the journeys that call it use `localhost`.
export async function unlockedDeviceCode(page: Page): Promise<string> {
  await openWith(page, '/', { hasPrf: true, backupEligible: false })
  await page
    .getByRole('region', { name: 'This device' })
    .getByRole('button', { name: 'Show the device code' })
    .click()
  return page
    .getByRole('region', { name: 'This device' })
    .getByText(/^lyre1p[02-9ac-hj-np-z]{59}$/)
    .innerText()
}

// Opens the page, builds the fixture song of `manifest` for the page's device code and chooses it
// with its access file. The files go into the running test's output directory.
export async function openV1Fixture(page: Page, manifest: Manifest = 'song.toml'): Promise<void> {
  const code = await unlockedDeviceCode(page)
  const { song, access } = await buildForDevice(code, test.info().outputPath('v1'), manifest)
  await chooseSongFile(page, [song, access])
}

// A documented recovery public key (docs/reference/device-access.md#recovery-key), as
// the recovery key screen will keep it: base64url of its 33-byte compressed form.
const RECOVERY_KEY = Buffer.from(
  '02585a2882fca9a0ee8cf896c3ac8e515402d3c85d91384bce2dce930ce3ce5307',
  'hex',
).toString('base64url')

// Keeps the recovery public key in this page's storage on every load.
export async function seedRecoveryKey(page: Page): Promise<void> {
  await page.addInitScript((key) => localStorage.setItem('lyre-recovery-public-key', key), RECOVERY_KEY)
}
