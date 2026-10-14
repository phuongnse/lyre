import { TimingCheckFault } from '../lyre-wasm/lyre_wasm.js'
import { Backend } from '../separation/backend'
import { TestAligner } from './aligner-session'

// What the page sends the aligner check worker: the test aligner to run, its
// checked files and the lyrics file the user picked.
export type AlignerCheckRequest = {
  type: 'run'
  aligner: TestAligner
  graph: Blob
  vocabulary: Blob
  lyrics: Blob
  baseUri: string
  forced?: Backend
}

// What the worker answers: progress, the number of syllables timed, or the
// kind of failure. Never the lyric text or an error's text.
export type AlignerCheckReply =
  | { type: 'progress'; backend: Backend; done: number; total: number }
  | { type: 'aligned'; backend: Backend; syllables: number }
  | { type: 'failed'; problem: 'timing' | 'other' }

// The reply for a failed run. A timing the song file's timing check refused
// has its own problem. The error's own text is never sent.
export function replyForError(error: unknown): AlignerCheckReply {
  if (error instanceof TimingCheckFault) {
    error.free()
    return { type: 'failed', problem: 'timing' }
  }
  return { type: 'failed', problem: 'other' }
}
