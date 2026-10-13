import { expect, test } from 'vitest'
import { chooseBackend } from './backend'

test('forcing WebAssembly gives WebAssembly, also when there is a GPU adapter', () => {
  expect(chooseBackend('wasm', true)).toBe('wasm')
  expect(chooseBackend('wasm', false)).toBe('wasm')
})

test('with nothing forced and no GPU adapter, the backend is WebAssembly', () => {
  expect(chooseBackend(undefined, false)).toBe('wasm')
})

test('with nothing forced and a GPU adapter, the backend is WebGPU', () => {
  expect(chooseBackend(undefined, true)).toBe('webgpu')
})
