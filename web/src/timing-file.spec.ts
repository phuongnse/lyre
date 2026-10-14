// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { initSync, parseTimingFile, TimingFileErrorKind, TimingFileFault } from './lyre-wasm/lyre_wasm.js'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const lyrics = encode('a b c\n\nd e')
// A hand-written timing of five syllables.
const timingFile = encode('# start end syllable\n0 500 a\n1000 1500 b\n2000 2500 c\n\n3000 3500 d\n4000 4500 e\n')

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

function caught(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

test('the core reads the starts of a timing file in lyric order', () => {
  const syllables = parseTimingFile(timingFile, lyrics)
  const starts = Array.from(syllables, (syllable) => syllable.startMs)
  for (const syllable of syllables) syllable.free()
  expect(starts).toEqual([0, 1000, 2000, 3000, 4000])
})

test('a refused timing file names the line and the rule', () => {
  const fault = caught(() => parseTimingFile(encode('0 500 a\n400 900 b\n'), lyrics))
  expect(fault).toBeInstanceOf(TimingFileFault)
  const { line, kind } = fault as TimingFileFault
  expect({ line, kind }).toEqual({ line: 2, kind: TimingFileErrorKind.Overlap })
  ;(fault as TimingFileFault).free()
})
