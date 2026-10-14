// @vitest-environment node
import { expect, test } from 'vitest'
import { backendsFor } from './candidates'

test('with no backend forced, a run measures WebGPU, then WebAssembly', () => {
  expect(backendsFor(undefined)).toEqual(['webgpu', 'wasm'])
})

test('with WebAssembly forced, as ?backend=wasm does, a run measures only WebAssembly', () => {
  expect(backendsFor('wasm')).toEqual(['wasm'])
})
