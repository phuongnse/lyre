// @vitest-environment node
import { expect, test } from 'vitest'
import { backendsFor, candidatesFor } from './candidates'

test('with no backend forced, a run measures only WebGPU', () => {
  expect(backendsFor(undefined)).toEqual(['webgpu'])
})

test('with WebAssembly forced, as ?backend=wasm does, a run measures only WebAssembly', () => {
  expect(backendsFor('wasm')).toEqual(['wasm'])
})

test('a real measurement compares the two lyric-alignment files', () => {
  expect(candidatesFor(false)).toEqual(['lyric-alignment-fp32', 'lyric-alignment-int8'])
})

test('a test measurement uses the lyric-alignment test aligner only', () => {
  expect(candidatesFor(true)).toEqual(['test-lyric-alignment'])
})
