import { readFileSync } from 'node:fs'

// The core's version is the one in [workspace.package] of core/Cargo.toml.
export function coreVersion(): string {
  const cargoToml = readFileSync(new URL('../../../core/Cargo.toml', import.meta.url), 'utf8')
  const match = /^\[workspace\.package\][^[]*?^version = "([^"]+)"/m.exec(cargoToml)
  if (!match) throw new Error('No version in [workspace.package] of core/Cargo.toml')
  return match[1]
}
