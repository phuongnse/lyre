import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// The core's version is the one in [workspace.package] of core/Cargo.toml.
function coreVersion(): string {
  const cargoToml = readFileSync(new URL('../../../core/Cargo.toml', import.meta.url), 'utf8')
  const match = /^\[workspace\.package\][^[]*?^version = "([^"]+)"/m.exec(cargoToml)
  if (!match) throw new Error('No version in [workspace.package] of core/Cargo.toml')
  return match[1]
}

test('the page shows the core version', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(`Lyre core ${coreVersion()}`)).toBeVisible()
})
