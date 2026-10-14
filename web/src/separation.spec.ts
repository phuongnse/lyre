// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { initSync, Separation, SeparationFaultKind } from './lyre-wasm/lyre_wasm.js'

const SPEC_LEN = 4 * 1025 * 801

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// What the core throws when `step` fails.
function faultOf(step: () => unknown): { kind: SeparationFaultKind; measuredDb?: number; sample?: number } {
  try {
    step()
  } catch (fault) {
    const separationFault = fault as {
      kind: SeparationFaultKind
      measuredDb?: number
      sample?: number
      free(): void
    }
    const read = { kind: separationFault.kind, measuredDb: separationFault.measuredDb, sample: separationFault.sample }
    separationFault.free()
    return read
  }
  throw new Error('the step did not fail')
}

test('the core reports 5 segments for 400,000 samples and gives tracks as long as the input', () => {
  const silence = new Float32Array(400_000)
  const separation = new Separation(silence, silence)
  expect(separation.segmentCount).toBe(5)
  for (let index = 0; index < separation.segmentCount; index++) {
    const spec = separation.input(index)
    expect(spec.length).toBe(SPEC_LEN)
    // The model's output in the same shape.
    separation.output(index, spec)
  }
  const tracks = separation.finish()
  expect(tracks.vocals.length).toBe(800_000)
  expect(tracks.karaoke.length).toBe(800_000)
  tracks.free()
  separation.free()
})

test('the core fails the broken-run check at sample 0 when the model outputs NaN', () => {
  const sine = Float32Array.from({ length: 50_000 }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44_100))
  const separation = new Separation(sine, sine)
  expect(separation.segmentCount).toBe(1)
  separation.input(0)
  separation.output(0, new Float32Array(SPEC_LEN).fill(NaN))
  const fault = faultOf(() => separation.finish())
  expect(fault.kind).toBe(SeparationFaultKind.VocalsNotFinite)
  expect(fault.sample).toBe(0)
  expect(fault.measuredDb).toBeUndefined()
  separation.free()
})

test('the core refuses audio with channels of different lengths', () => {
  const fault = faultOf(() => new Separation(new Float32Array(3), new Float32Array(2)))
  expect(fault.kind).toBe(SeparationFaultKind.Refused)
})
