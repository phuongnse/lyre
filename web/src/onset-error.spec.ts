// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import {
  initSync,
  MeasureFault,
  measureOnsetError,
  parseTimingFile,
  TimingFileErrorKind,
  TimingFileFault,
} from './lyre-wasm/lyre_wasm.js'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const lyrics = encode('a b c\n\nd e')
// The hand-written timing of the known-answer vector.
const timingFile = encode('# start end syllable\n0 500 a\n1000 1500 b\n2000 2500 c\n\n3000 3500 d\n4000 4500 e\n')
const alignedStarts = Uint32Array.of(50, 1150, 1900, 3300, 4000)

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

function handStarts(): Uint32Array {
  const syllables = parseTimingFile(timingFile, lyrics)
  const starts = Uint32Array.from(syllables, (syllable) => syllable.startMs)
  for (const syllable of syllables) syllable.free()
  return starts
}

function caught(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

test('the core measures the onset error of the known-answer vector', () => {
  const starts = handStarts()
  expect(Array.from(starts)).toEqual([0, 1000, 2000, 3000, 4000])
  const measured = measureOnsetError(starts, alignedStarts)
  expect({
    errorsMs: Array.from(measured.errorsMs),
    medianMs: measured.medianMs,
    p90Ms: measured.p90Ms,
    within100Ms: measured.within100Ms,
  }).toEqual({ errorsMs: [50, 150, 100, 300, 0], medianMs: 100, p90Ms: 240, within100Ms: 0.6 })
  measured.free()
})

test('the core refuses timings with different syllable counts', () => {
  const fault = caught(() => measureOnsetError(handStarts(), alignedStarts.subarray(0, 4)))
  expect(fault).toBeInstanceOf(MeasureFault)
  const { handCount, alignedCount } = fault as MeasureFault
  expect({ handCount, alignedCount }).toEqual({ handCount: 5, alignedCount: 4 })
  ;(fault as MeasureFault).free()
})

test('a refused timing file names the line and the rule', () => {
  const fault = caught(() => parseTimingFile(encode('0 500 a\n400 900 b\n'), lyrics))
  expect(fault).toBeInstanceOf(TimingFileFault)
  const { line, kind } = fault as TimingFileFault
  expect({ line, kind }).toEqual({ line: 2, kind: TimingFileErrorKind.Overlap })
  ;(fault as TimingFileFault).free()
})
