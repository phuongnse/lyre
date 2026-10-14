import { Backend } from '../separation/backend'

// The aligners the measurement compares (docs/reference/models.md#measurement-method),
// and the test aligners that stand in for them with ?model=test.
export type Candidate =
  'omnilingual-int8' | 'lyric-alignment-fp32' | 'lyric-alignment-int8' | 'test-omnilingual' | 'test-lyric-alignment'

// Which of the core's aligner kinds a candidate is.
export type CandidateKind = 'omnilingual' | 'lyric-alignment'

// A candidate's kind and the IDs of its pinned model and vocabulary files.
export interface CandidateFiles {
  kind: CandidateKind
  graph: string
  vocabulary: string
}

export const candidateFiles: Record<Candidate, CandidateFiles> = {
  'omnilingual-int8': { kind: 'omnilingual', graph: 'omnilingual-int8-model', vocabulary: 'omnilingual-tokens' },
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
  'test-omnilingual': { kind: 'omnilingual', graph: 'test-omnilingual-model', vocabulary: 'test-omnilingual-tokens' },
  'test-lyric-alignment': {
    kind: 'lyric-alignment',
    graph: 'test-lyric-alignment-model',
    vocabulary: 'test-lyric-alignment-vocab',
  },
}

// The candidates a run measures, in order. `test` gives the test aligners.
export function candidatesFor(test: boolean): readonly Candidate[] {
  return test
    ? ['test-omnilingual', 'test-lyric-alignment']
    : ['omnilingual-int8', 'lyric-alignment-fp32', 'lyric-alignment-int8']
}

// The ID of the separator's pinned file. `test` gives the test separator.
export function separatorFile(test: boolean): 'test-mel-roformer' | 'mel-roformer-fp16' {
  return test ? 'test-mel-roformer' : 'mel-roformer-fp16'
}

// The backends a run measures, in order: WebGPU, then one-thread WebAssembly.
// A forced WebAssembly gives only WebAssembly.
export function backendsFor(forced: Backend | undefined): Backend[] {
  return forced === 'wasm' ? ['wasm'] : ['webgpu', 'wasm']
}
