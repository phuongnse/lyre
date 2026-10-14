// @vitest-environment node
import { expect, test } from 'vitest'
import { SeparationFaultKind } from '../lyre-wasm/lyre_wasm.js'
import { replyForFault } from './separation-messages'

test('a peak fault names the rule vocals-peak and carries its peak in dB', () => {
  expect(replyForFault({ kind: SeparationFaultKind.VocalsPeak, measuredDb: 6.5 })).toEqual({
    type: 'broken-run',
    rule: 'vocals-peak',
    value: 6.5,
  })
})

test.each([
  [SeparationFaultKind.VocalsNotFinite, 'vocals-not-finite', 0],
  [SeparationFaultKind.KaraokeNotFinite, 'karaoke-not-finite', 1234],
])('a not-finite fault of kind %i names the rule %s and carries the sample', (kind, rule, sample) => {
  expect(replyForFault({ kind, sample })).toEqual({ type: 'broken-run', rule, value: sample })
})

test('a refused step is a source the page cannot read', () => {
  expect(replyForFault({ kind: SeparationFaultKind.Refused })).toEqual({ type: 'failed', problem: 'unreadable' })
})

test('a broken-run fault without its value is a source the page cannot read', () => {
  expect(replyForFault({ kind: SeparationFaultKind.VocalsPeak })).toEqual({ type: 'failed', problem: 'unreadable' })
})
