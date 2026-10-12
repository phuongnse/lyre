// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { coreVersion, initSync } from './lyre-wasm/lyre_wasm.js'

test('the WebAssembly core reports the workspace version', () => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
  const manifest = readFileSync(new URL('../../core/Cargo.toml', import.meta.url), 'utf8')
  const section = manifest.match(/^\[workspace\.package\]\n((?:(?!\[).*\n?)*)/m)?.[1] ?? ''
  const expected = section.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  expect(expected).toBeTruthy()
  expect(coreVersion()).toBe(expected)
})
