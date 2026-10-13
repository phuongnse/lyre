// @vitest-environment node
import { expect, test } from 'vitest'
import { Resampler } from './resampler'

const INPUT_RATE = 48000

// A 2 s sine at 440 Hz and 48 kHz, like the source fixtures.
function sine(): Float32Array {
  const samples = new Float32Array(2 * INPUT_RATE)
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / INPUT_RATE)
  return samples
}

// Resamples `input` fed in pieces of the given sizes, then the rest.
function resample(input: Float32Array, outputRate: number, sizes: number[]): Float32Array {
  const resampler = new Resampler(INPUT_RATE, outputRate, 1)
  const pieces: Float32Array[] = []
  let at = 0
  for (const size of [...sizes, input.length]) {
    const end = Math.min(input.length, at + size)
    pieces.push(...resampler.push([input.slice(at, end)]))
    at = end
  }
  pieces.push(...resampler.flush())
  const out = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0))
  let offset = 0
  for (const piece of pieces) {
    out.set(piece, offset)
    offset += piece.length
  }
  return out
}

// The frequency from the upward zero crossings between the first and the last.
function frequency(samples: Float32Array, rate: number): number {
  const crossings: number[] = []
  for (let i = 1; i < samples.length; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) crossings.push(i)
  return ((crossings.length - 1) * rate) / (crossings.at(-1)! - crossings[0]!)
}

for (const outputRate of [44100, 16000]) {
  test(`a sine resampled to ${outputRate} Hz in uneven pieces matches one whole piece`, () => {
    const input = sine()
    const whole = resample(input, outputRate, [])
    const pieces = resample(input, outputRate, [1, 997, 4096])
    expect(whole.length).toBe(Math.ceil((input.length * outputRate) / INPUT_RATE))
    expect(pieces).toEqual(whole)
    expect(Math.abs(frequency(whole, outputRate) - 440)).toBeLessThanOrEqual(2)
  })
}

test('equal rates pass the samples through unchanged', () => {
  const input = sine()
  expect(resample(input, INPUT_RATE, [1, 997, 4096])).toEqual(input)
})

test('resampling does not shift the audio in time', () => {
  const out = resample(sine(), 44100, [])
  // Away from the ends, each output frame is the sine at its own time.
  let error = 0
  for (let n = 1000; n < out.length - 1000; n++) {
    error = Math.max(error, Math.abs(out[n]! - 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44100)))
  }
  expect(error).toBeLessThan(1e-3)
})
