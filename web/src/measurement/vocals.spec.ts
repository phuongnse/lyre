import { expect, test } from 'vitest'
import { vocalsForAlignment } from './vocals'

// Planar stereo at 44.1 kHz: the left channel, then the right.
function stereoSine(seconds: number, rate = 44_100): Float32Array {
  const frames = seconds * rate
  const planar = new Float32Array(2 * frames)
  for (let i = 0; i < frames; i++) {
    const value = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate)
    planar[i] = value
    planar[frames + i] = value
  }
  return planar
}

test('1 s of 44.1 kHz stereo vocals gives 1 s of 16 kHz mono audio', () => {
  expect(vocalsForAlignment(stereoSine(1))).toHaveLength(16_000)
})

test('the mono audio keeps the sine', () => {
  const mono = vocalsForAlignment(stereoSine(1))
  // Away from the edges, the 440 Hz sine keeps its 0.5 peak.
  const peak = mono.subarray(1_000, 15_000).reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  expect(peak).toBeGreaterThan(0.49)
  expect(peak).toBeLessThan(0.51)
})

test('the left and right channels are averaged', () => {
  const frames = 44_100
  const planar = new Float32Array(2 * frames)
  // The left channel at 0.5 and the right at -0.5 cancel out.
  planar.fill(0.5, 0, frames)
  planar.fill(-0.5, frames)
  for (const value of vocalsForAlignment(planar)) expect(value).toBe(0)
})
