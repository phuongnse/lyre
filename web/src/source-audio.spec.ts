// @vitest-environment node
import { expect, test } from 'vitest'
import { mixChannels, Placement } from './source-audio'

const RATE = 48000

const ones = (frames: number) => new Float32Array(frames).fill(1)

test('audio that starts 0.5 s after the timeline start gets 0.5 s of leading silence', () => {
  const placement = new Placement(1.5, RATE)
  const [placed] = placement.place(2, [ones(960)])
  expect(placed!.length).toBe(0.5 * RATE + 960)
  expect(placed!.subarray(0, 0.5 * RATE).every((sample) => sample === 0)).toBe(true)
  expect(placed!.subarray(0.5 * RATE).every((sample) => sample === 1)).toBe(true)
})

test('frames before the timeline start, such as encoder priming, are dropped', () => {
  const placement = new Placement(0, RATE)
  const priming = new Float32Array(960).fill(2).fill(1, 312)
  const [first] = placement.place(-312 / RATE, [priming])
  expect(first).toEqual(ones(960 - 312))
  // The next piece follows on, without a gap or an overlap.
  const [second] = placement.place(648 / RATE, [ones(960)])
  expect(second).toEqual(ones(960))
})

test('back-to-back pieces are neither padded nor trimmed', () => {
  const placement = new Placement(0, RATE)
  let timestamp = 0
  for (const frames of [960, 1152, 1024, 480]) {
    const [placed] = placement.place(timestamp, [ones(frames)])
    expect(placed!.length).toBe(frames)
    timestamp += frames / RATE
  }
})

test('a piece that overlaps what was already written loses the overlap', () => {
  const placement = new Placement(0, RATE)
  placement.place(0, [ones(960)])
  const [placed] = placement.place(900 / RATE, [ones(100)])
  expect(placed!.length).toBe(40)
})

test('mono becomes stereo by copying its one channel', () => {
  const mono = new Float32Array([0.25, -0.5, 1])
  const [left, right] = mixChannels([mono], 2)
  expect(left).toEqual(mono)
  expect(right).toEqual(mono)
})

test('stereo becomes mono by averaging its channels', () => {
  const left = new Float32Array([1, 0.5, -1])
  const right = new Float32Array([0, -0.5, -1])
  expect(mixChannels([left, right], 1)).toEqual([new Float32Array([0.5, 0, -1])])
})

test('more than two channels become stereo by keeping the first two', () => {
  const planes = [new Float32Array([1]), new Float32Array([2]), new Float32Array([3])]
  expect(mixChannels(planes, 2)).toEqual([planes[0], planes[1]])
})

test('audio with the asked channel count is kept as it is', () => {
  const planes = [new Float32Array([1]), new Float32Array([2])]
  expect(mixChannels(planes, 2)).toBe(planes)
})
