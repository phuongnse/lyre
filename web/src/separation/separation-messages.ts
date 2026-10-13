import { SeparationFaultKind } from '../lyre-wasm/lyre_wasm.js'
import { SourceProblem } from '../source-error'
import { Backend } from './backend'

// What the page sends the separation worker: the source and the checked separator files.
export type SeparationRequest = {
  type: 'run'
  source: File
  graph: Blob
  weights: Blob
  baseUri: string
  forced?: Backend
}

// The sum check rule a run failed (docs/architecture.md#processing-planned-for-m2).
export type SumCheckRule = 'energy' | 'vocals-peak' | 'karaoke-peak'

// What the worker answers: progress, then the lengths of the tracks or why the
// run failed. The tracks themselves and the error's text stay in the worker.
export type SeparationReply =
  | { type: 'progress'; backend: Backend; done: number; total: number }
  | { type: 'separated'; backend: Backend; sourceSeconds: number; vocalsSeconds: number; karaokeSeconds: number }
  | { type: 'sum-check-failed'; rule: SumCheckRule; measuredDb: number }
  | { type: 'failed'; problem: SourceProblem | 'model' }

const RULES: Partial<Record<SeparationFaultKind, SumCheckRule>> = {
  [SeparationFaultKind.Energy]: 'energy',
  [SeparationFaultKind.VocalsPeak]: 'vocals-peak',
  [SeparationFaultKind.KaraokePeak]: 'karaoke-peak',
}

// The reply for a fault the core threw. A refused step names no rule, so it
// is a source the page cannot read.
export function replyForFault(fault: { kind: SeparationFaultKind; measuredDb?: number }): SeparationReply {
  const rule = RULES[fault.kind]
  if (rule === undefined || fault.measuredDb === undefined) return { type: 'failed', problem: 'unreadable' }
  return { type: 'sum-check-failed', rule, measuredDb: fault.measuredDb }
}
