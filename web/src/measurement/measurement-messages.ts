import { TimingCheckFault } from '../lyre-wasm/lyre_wasm.js'
import { Backend } from '../separation/backend'
import { SumCheckRule } from '../separation/separation-messages'
import { SourceProblem } from '../source-error'
import { Candidate, CandidateKind } from './candidates'

// What the page sends the measurement worker: the source, the lyrics file,
// the starts of the hand-written timing, and the checked files of the
// separator and of each candidate, in the order to run them.
export type MeasurementRequest = {
  type: 'run'
  source: File
  lyrics: Blob
  handStartsMs: Uint32Array
  separator: { graph: Blob; weights: Blob }
  candidates: { candidate: Candidate; kind: CandidateKind; graph: Blob; vocabulary: Blob }[]
  baseUri: string
  forced?: Backend
}

// The stage a run is in.
export type MeasurementStage = 'extract' | 'separate' | 'align'

// What the worker answers: the stage it starts, the figures of the shared
// stages, each candidate's figures or failure, and the end of the run. A
// failed sum check or source ends the run. Times are in milliseconds. Never
// the lyric text, the tracks or an error's text.
export type MeasurementReply =
  | { type: 'stage'; stage: MeasurementStage; candidate?: Candidate }
  | { type: 'separated'; extractMs: number; separateMs: number; sumCheckDb: number }
  | {
      type: 'measured'
      candidate: Candidate
      backend: Backend
      loadMs: number
      alignMs: number
      medianMs: number
      p90Ms: number
      within100Ms: number
    }
  | { type: 'candidate-failed'; candidate: Candidate; problem: 'timing' | 'other' }
  | { type: 'sum-check-failed'; rule: SumCheckRule; measuredDb: number }
  | { type: 'failed'; problem: SourceProblem | 'model' }
  | { type: 'done' }

// The reply for a candidate that failed. A timing the song file's timing
// check refused has its own problem. The error's own text is never sent.
export function candidateFailure(candidate: Candidate, error: unknown): MeasurementReply {
  if (error instanceof TimingCheckFault) {
    error.free()
    return { type: 'candidate-failed', candidate, problem: 'timing' }
  }
  return { type: 'candidate-failed', candidate, problem: 'other' }
}
