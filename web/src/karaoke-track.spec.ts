// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { cutAtTimes, FitToLength, MAX_CUT_DISTANCE_MS } from './karaoke-track'
import { MAX_AUDIO_SEGMENT_MS, MediaSegment, PackageError, Piece } from './original-track'

// Opus pieces of `stepMs` from `firstMs`, after a first piece at 0 when
// `firstMs` is above 0. Each piece's one byte is its index, so a moved or
// lost piece shows.
function pieces(firstMs: number, stepMs: number, endMs: number): Piece[] {
  const made: Piece[] = firstMs > 0 ? [{ startMs: 0, bytes: new Uint8Array([0]) }] : []
  for (let start = firstMs; start < endMs; start += stepMs) {
    made.push({ startMs: start, bytes: new Uint8Array([made.length % 256]) })
  }
  return made
}

// Where each segment starts and ends.
function spans(startMs: number, segments: MediaSegment[]): [number, number][] {
  let start = startMs
  return segments.map(({ durationMs }) => {
    const span: [number, number] = [start, start + durationMs]
    start += durationMs
    return span
  })
}

function expectNear(karaoke: [number, number][], original: [number, number][]): void {
  expect(karaoke.length).toBe(original.length)
  for (const [index, [start, end]] of karaoke.entries()) {
    expect(Math.abs(start - original[index]![0])).toBeLessThanOrEqual(MAX_CUT_DISTANCE_MS)
    expect(Math.abs(end - original[index]![1])).toBeLessThanOrEqual(MAX_CUT_DISTANCE_MS)
    expect(end - start).toBeGreaterThanOrEqual(1)
    expect(end - start).toBeLessThanOrEqual(MAX_AUDIO_SEGMENT_MS)
  }
}

describe('cutAtTimes', () => {
  test("cuts 20 ms packets at an AAC original's cut times into as many segments, each within 50 ms", () => {
    const made = pieces(0, 20, 35_000)
    // Where AAC fragments of 1024 frames at 48 kHz fall, grouped into segments of up to 10 s.
    const original: [number, number][] = [
      [0, 9_984],
      [9_984, 19_989],
      [19_989, 29_995],
      [29_995, 35_000],
    ]
    const { startMs, segments } = cutAtTimes(made, 35_000, [9_984, 19_989, 29_995])
    expect(startMs).toBe(0)
    expectNear(spans(startMs, segments), original)
    // Every piece is kept once, in order.
    const bytes = segments.flatMap((segment) => [...segment.bytes])
    expect(bytes).toEqual(made.map((piece) => piece.bytes[0]))
  })

  test('takes a farther packet edge when the nearest would make a segment over 10,000 ms', () => {
    // Edges at 0, 8, 28, …, 9,988, 10,008: the nearest to 10,000 is 10,008.
    const made = pieces(8, 20, 15_000)
    const { startMs, segments } = cutAtTimes(made, 15_000, [10_000])
    expect(spans(startMs, segments)).toEqual([
      [0, 9_988],
      [9_988, 15_000],
    ])
  })

  test('keeps the last segment within 10,000 ms when the original ends 10,000 ms after its last cut', () => {
    // Edges at 0, 12, 32, …, 4,992, 5,012: the nearest to 5,000 is 4,992, which leaves 10,008 ms.
    const made = pieces(12, 20, 15_000)
    const { startMs, segments } = cutAtTimes(made, 15_000, [5_000])
    expect(spans(startMs, segments)).toEqual([
      [0, 5_012],
      [5_012, 15_000],
    ])
  })

  test('refuses a cut with no packet edge within 50 ms', () => {
    const made = pieces(0, 1_000, 5_000)
    expect(() => cutAtTimes(made, 5_000, [2_500])).toThrow(PackageError)
  })

  test("leaves out the encoder's last packet when it starts at the end", () => {
    // 2,000 ms of audio as 101 packets: the last holds what the encoder held back.
    const made = pieces(0, 20, 2_020)
    const { startMs, segments } = cutAtTimes(made, 2_000, [])
    expect(spans(startMs, segments)).toEqual([[0, 2_000]])
    expect([...segments[0]!.bytes]).toEqual(made.slice(0, 100).map((piece) => piece.bytes[0]))
  })

  test('refuses pieces out of order, and pieces that all start at or after the end', () => {
    const made = pieces(0, 20, 100)
    expect(() => cutAtTimes([made[1]!, made[0]!], 100, [])).toThrow(PackageError)
    expect(() => cutAtTimes(made, 0, [])).toThrow(PackageError)
  })
})

// Pushes `total` frames of stereo audio in pieces of `size`, counting up, and
// returns everything that came out.
function fit(total: number, size: number, target: number): Float32Array[] {
  const fitter = new FitToLength(target, 2)
  const out: Float32Array[][] = []
  for (let start = 0; start < total; start += size) {
    const frames = Math.min(size, total - start)
    const left = Float32Array.from({ length: frames }, (_, i) => (start + i + 1) / 10_000)
    out.push(fitter.push([left, left.map((value) => -value)]))
  }
  out.push(fitter.finish())
  return [0, 1].map((channel) => Float32Array.from(out.flatMap((planes) => [...planes[channel]!])))
}

describe('FitToLength', () => {
  test('pads a short track with silence to exactly the target', () => {
    const [left, right] = fit(1_000, 256, 1_500)
    expect(left!.length).toBe(1_500)
    expect(right!.length).toBe(1_500)
    expect(left![999]).toBeCloseTo(0.1)
    expect(right![999]).toBeCloseTo(-0.1)
    expect([...left!.subarray(1_000)].every((value) => value === 0)).toBe(true)
    expect([...right!.subarray(1_000)].every((value) => value === 0)).toBe(true)
  })

  test('cuts a long track to exactly the target and keeps its first frames', () => {
    const [left, right] = fit(2_000, 256, 1_500)
    expect(left!.length).toBe(1_500)
    expect(right!.length).toBe(1_500)
    for (let i = 0; i < 1_500; i++) {
      expect(left![i]).toBe(Math.fround((i + 1) / 10_000))
      expect(right![i]).toBe(-Math.fround((i + 1) / 10_000))
    }
  })

  test('adds nothing when the track already has the target length', () => {
    const fitter = new FitToLength(512, 2)
    expect(fitter.push([new Float32Array(512), new Float32Array(512)])[0]!.length).toBe(512)
    expect(fitter.finish().map((plane) => plane.length)).toEqual([0, 0])
  })
})
