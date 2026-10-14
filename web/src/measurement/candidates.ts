import { Backend } from '../separation/backend'

// The aligners the measurement compares (docs/reference/models.md#measurement-method),
// and the test aligner that stands in for them with ?model=test.
export type Candidate = 'lyric-alignment-fp32' | 'lyric-alignment-int8' | 'test-lyric-alignment'

// Which of the core's aligner kinds a candidate is.
export type CandidateKind = 'lyric-alignment'

// A candidate's kind and the IDs of its pinned model and vocabulary files.
export interface CandidateFiles {
  kind: CandidateKind
  graph: string
  vocabulary: string
}

export const candidateFiles: Record<Candidate, CandidateFiles> = {
  'lyric-alignment-fp32': {
    kind: 'lyric-alignment',
    graph: 'lyric-alignment-fp32',
    vocabulary: 'lyric-alignment-vocab',
  },
  'lyric-alignment-int8': {
    kind: 'lyric-alignment',
    graph: 'lyric-alignment-int8',
    vocabulary: 'lyric-alignment-vocab',
  },
  'test-lyric-alignment': {
    kind: 'lyric-alignment',
    graph: 'test-lyric-alignment-model',
    vocabulary: 'test-lyric-alignment-vocab',
  },
}

// The candidates a run measures, in order. `test` gives the test aligner.
export function candidatesFor(test: boolean): readonly Candidate[] {
  return test ? ['test-lyric-alignment'] : ['lyric-alignment-fp32', 'lyric-alignment-int8']
}

// The ID of the separator's pinned file. `test` gives the test separator.
export function separatorFile(test: boolean): 'test-mel-roformer' | 'mel-roformer-fp16' {
  return test ? 'test-mel-roformer' : 'mel-roformer-fp16'
}

// The backend a run measures: WebGPU. A forced WebAssembly, as ?backend=wasm
// gives, measures only WebAssembly instead.
export function backendsFor(forced: Backend | undefined): Backend[] {
  return forced === 'wasm' ? ['wasm'] : ['webgpu']
}
