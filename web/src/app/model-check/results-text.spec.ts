import { expect, test } from 'vitest'
import { Result, resultsText, Row } from './results-text'

const device: Row[] = [
  { id: 'device-browser', label: 'Browser', value: 'Chrome 140' },
  { id: 'device-webgpu', label: 'WebGPU', value: 'Not available' },
]

const measured: Result = {
  name: 'Test lyric-alignment on WebAssembly',
  rows: [
    { id: 'a', label: 'Separate', value: '0.42 s' },
    { id: 'b', label: 'Within 100 ms', value: '80%' },
  ],
}

test('holds the device block, then each result as a block of label: value lines', () => {
  expect(resultsText(device, [measured])).toBe(
    [
      'Device',
      'Browser: Chrome 140',
      'WebGPU: Not available',
      '',
      'Test lyric-alignment on WebAssembly',
      'Separate: 0.42 s',
      'Within 100 ms: 80%',
    ].join('\n'),
  )
})

test('leaves the device block out before the device is known', () => {
  expect(resultsText(undefined, [measured]).startsWith('Test lyric-alignment on WebAssembly\n')).toBe(true)
  expect(resultsText(undefined, [])).toBe('')
})

test('copies a failed run that never started with its name, "Not run." and its reason', () => {
  const failed: Result = {
    name: 'Test lyric-alignment on WebGPU',
    rows: [],
    failure: { ran: false, reason: 'WebGPU is not available.' },
  }
  expect(resultsText(undefined, [failed])).toBe(
    ['Test lyric-alignment on WebGPU', 'Not run.', 'WebGPU is not available.'].join('\n'),
  )
})

test('copies a failed run that started with its name and reason only', () => {
  const failed: Result = {
    name: 'Test lyric-alignment on WebGPU',
    rows: [],
    failure: { ran: true, reason: 'The run ran out of memory.' },
  }
  const text = resultsText(undefined, [failed])
  expect(text).toBe(['Test lyric-alignment on WebGPU', 'The run ran out of memory.'].join('\n'))
  expect(text).not.toContain('Not run.')
})
