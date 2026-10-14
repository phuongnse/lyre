import { AlignmentRunError } from '../alignment/align-song'
import { AlignmentFault, SeparationFault, TimingCheckFault, WindowFault } from '../lyre-wasm/lyre_wasm.js'
import { Backend } from '../separation/backend'
import { replyForFault, SumCheckRule } from '../separation/separation-messages'
import { isOutOfMemory, SessionFault } from '../session-backend'
import { SourceProblem } from '../source-error'
import { Candidate, CandidateKind } from './candidates'
import { StageMemory } from './memory'

// What the page sends the measurement worker: the source, the lyrics file,
// the checked files of the separator and of each candidate, in the order to
// run them, and the backends to run them on, in order.
export type MeasurementRequest = {
  type: 'run'
  source: File
  lyrics: Blob
  separator: { graph: Blob; weights: Blob }
  candidates: { candidate: Candidate; kind: CandidateKind; graph: Blob; vocabulary: Blob }[]
  baseUri: string
  backends: Backend[]
}

// The stage a run is in.
export type MeasurementStage = 'extract' | 'separate' | 'align'

// Why a run of one candidate on one backend failed: WebGPU is not available,
// the model could not be loaded on the backend, the run ran out of memory,
// the separation failed the sum check, the core refused the alignment, the
// song file timing check refused the timing, or anything else.
export type RunProblem =
  | { kind: 'webgpu-unavailable' | 'model' | 'out-of-memory' | 'alignment-refused' | 'timing' | 'other' }
  | { kind: 'sum-check'; rule: SumCheckRule; measuredDb: number }

// What the worker answers: the stage it starts, the extract time, each
// backend's separation figures and its tracks as WAV files, each candidate's
// figures or failure on each backend, and the end of the run. Only a source
// that cannot be read ends the run early. Times are in milliseconds and memory
// is in bytes: the highest seen in the stage. A candidate's timing is each
// syllable's start then end, in lyric order, in milliseconds. Never the lyric
// text or an error's text.
export type MeasurementReply =
  | { type: 'stage'; stage: MeasurementStage; backend?: Backend; candidate?: Candidate }
  | { type: 'extracted'; extractMs: number; memory: StageMemory }
  | { type: 'separated'; backend: Backend; separateMs: number; sumCheckDb: number; memory: StageMemory }
  // The vocals and the karaoke track of one backend's separation, as WAV files for the page's players.
  | { type: 'tracks'; backend: Backend; vocals: Uint8Array<ArrayBuffer>; karaoke: Uint8Array<ArrayBuffer> }
  | {
      type: 'measured'
      candidate: Candidate
      backend: Backend
      loadMs: number
      alignMs: number
      memory: StageMemory
      timesMs: Uint32Array<ArrayBuffer>
    }
  // `ran` is false when the separation on the backend failed, so the candidate did not run.
  | { type: 'candidate-failed'; candidate: Candidate; backend: Backend; ran: boolean; problem: RunProblem }
  | { type: 'failed'; problem: SourceProblem }
  | { type: 'done' }

// Why a run failed, from the error it threw. A core fault is freed once read.
// The error's own text is never sent.
export function runProblem(error: unknown): RunProblem {
  if (error instanceof SessionFault) return { kind: error.problem }
  if (error instanceof SeparationFault) {
    const reply = replyForFault({ kind: error.kind, measuredDb: error.measuredDb })
    error.free()
    // A refused step names no rule.
    return reply.type === 'sum-check-failed'
      ? { kind: 'sum-check', rule: reply.rule, measuredDb: reply.measuredDb }
      : { kind: 'other' }
  }
  if (error instanceof TimingCheckFault) {
    error.free()
    return { kind: 'timing' }
  }
  if (error instanceof AlignmentFault || error instanceof WindowFault) {
    error.free()
    return { kind: 'alignment-refused' }
  }
  if (error instanceof AlignmentRunError) return { kind: 'alignment-refused' }
  if (isOutOfMemory(error)) return { kind: 'out-of-memory' }
  return { kind: 'other' }
}
