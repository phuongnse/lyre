// @vitest-environment node
import { expect, test } from 'vitest'
import { SeparationFaultKind } from '../lyre-wasm/lyre_wasm.js'
import { replyForFault } from './separation-messages'

test.each([
  [SeparationFaultKind.Energy, 'energy', 9.9],
  [SeparationFaultKind.VocalsPeak, 'vocals-peak', 1.1],
  [SeparationFaultKind.KaraokePeak, 'karaoke-peak', 2.5],
])('a sum check fault of kind %i names the rule %s and carries its measured dB', (kind, rule, measuredDb) => {
  expect(replyForFault({ kind, measuredDb })).toEqual({ type: 'sum-check-failed', rule, measuredDb })
})

test('a refused step is a source the page cannot read', () => {
  expect(replyForFault({ kind: SeparationFaultKind.Refused })).toEqual({ type: 'failed', problem: 'unreadable' })
})

test('a sum check fault without its measured dB is a source the page cannot read', () => {
  expect(replyForFault({ kind: SeparationFaultKind.Energy })).toEqual({ type: 'failed', problem: 'unreadable' })
})
