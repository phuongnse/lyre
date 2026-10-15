import { SeparationFaultKind } from '../lyre-wasm/lyre_wasm.js'
import { SourceProblem } from '../source-error'
import { Backend } from './backend'

// What the page sends the separation worker: the source and the checked separator file.
export type SeparationRequest = {
  type: 'run'
  source: File
  separator: Blob
  baseUri: string
  forced?: Backend
}

// The broken-run rule a run failed (docs/architecture.md#processing).
export type BrokenRunRule = 'vocals-not-finite' | 'karaoke-not-finite' | 'vocals-peak'

// What the worker answers: progress, then the lengths of the tracks or why the
// run failed. A broken run carries the value its rule measured: the position
// of the first sample that is not finite, or the peak in dB above the source.
// The tracks themselves and the error's text stay in the worker.
export type SeparationReply =
  | { type: 'progress'; backend: Backend; done: number; total: number }
  | { type: 'separated'; backend: Backend; sourceSeconds: number; vocalsSeconds: number; karaokeSeconds: number }
  | { type: 'broken-run'; rule: BrokenRunRule; value: number }
  | { type: 'failed'; problem: SourceProblem | 'model' }

// A broken-run value as text: a sample position as an integer, a peak in dB
// with one decimal.
export function brokenRunValue(rule: BrokenRunRule, value: number): string {
  return rule.endsWith('not-finite') ? value.toFixed(0) : value.toFixed(1)
}

const RULES: Partial<Record<SeparationFaultKind, BrokenRunRule>> = {
  [SeparationFaultKind.VocalsNotFinite]: 'vocals-not-finite',
  [SeparationFaultKind.KaraokeNotFinite]: 'karaoke-not-finite',
  [SeparationFaultKind.VocalsPeak]: 'vocals-peak',
}

// The reply for a fault the core threw. A refused step names no rule, so it
// is a source the page cannot read. A rule without its value is too.
export function replyForFault(fault: {
  kind: SeparationFaultKind
  measuredDb?: number
  sample?: number
}): SeparationReply {
  const rule = RULES[fault.kind]
  const value = fault.measuredDb ?? fault.sample
  if (rule === undefined || value === undefined) return { type: 'failed', problem: 'unreadable' }
  return { type: 'broken-run', rule, value }
}
