// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { lyricsAreValid } from './lyrics-file'
import { initSync } from './lyre-wasm/lyre_wasm.js'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

test('a file of lyrics is valid', async () => {
  expect(await lyricsAreValid(new Blob(['Mưa rơi\n']))).toBe(true)
})

test('a file with no letters is not valid lyrics', async () => {
  expect(await lyricsAreValid(new Blob(['123\n']))).toBe(false)
})

test('a file that is not UTF-8 is not valid lyrics', async () => {
  expect(await lyricsAreValid(new Blob([new Uint8Array([0xff, 0xfe])]))).toBe(false)
})
