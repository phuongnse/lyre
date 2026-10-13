// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { initSync, Separation, SeparationFaultKind } from './lyre-wasm/lyre_wasm.js'

const SEGMENT_SAMPLES = 343_980

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// The model's outputs for one window: four stems in the spectrogram and waveform branches.
function zeroOutputs(): { xOut: Float32Array; xtOut: Float32Array } {
  return { xOut: new Float32Array(4 * 4 * 2048 * 336), xtOut: new Float32Array(4 * 2 * SEGMENT_SAMPLES) }
}

// Runs the model steps of every window with all-zero outputs.
function feedZeros(separation: Separation): void {
  const { xOut, xtOut } = zeroOutputs()
  for (let index = 0; index < separation.windowCount; index++) {
    const input = separation.input(index)
    expect(input.x.length).toBe(4 * 2048 * 336)
    expect(input.xt.length).toBe(2 * SEGMENT_SAMPLES)
    input.free()
    separation.output(index, xOut, xtOut)
  }
}

test('the core reports two windows for 400,000 samples and gives tracks as long as the input', () => {
  const silence = new Float32Array(400_000)
  const separation = new Separation(silence, silence)
  expect(separation.windowCount).toBe(2)
  feedZeros(separation)
  const tracks = separation.finish()
  expect(tracks.vocals.length).toBe(800_000)
  expect(tracks.karaoke.length).toBe(800_000)
  tracks.free()
  separation.free()
})

test('the core fails the sum check when the model outputs nothing for a sine', () => {
  const sine = Float32Array.from({ length: 50_000 }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44_100))
  const separation = new Separation(sine, sine)
  expect(separation.windowCount).toBe(1)
  feedZeros(separation)
  let kind: SeparationFaultKind | undefined
  let measuredDb: number | undefined
  try {
    separation.finish()
  } catch (fault) {
    const separationFault = fault as { kind: SeparationFaultKind; measuredDb?: number; free(): void }
    kind = separationFault.kind
    measuredDb = separationFault.measuredDb
    separationFault.free()
  }
  expect(kind).toBe(SeparationFaultKind.Energy)
  expect(measuredDb).toBeCloseTo(0, 3)
  separation.free()
})

test('the core refuses audio with channels of different lengths', () => {
  let kind: SeparationFaultKind | undefined
  try {
    new Separation(new Float32Array(3), new Float32Array(2))
  } catch (fault) {
    const separationFault = fault as { kind: SeparationFaultKind; free(): void }
    kind = separationFault.kind
    separationFault.free()
  }
  expect(kind).toBe(SeparationFaultKind.Refused)
})
