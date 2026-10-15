import {
  align,
  AlignerKind,
  alignerLogProbs,
  AlignerWindows,
  checkTiming,
  readVocabulary,
} from '../lyre-wasm/lyre_wasm.js'

// Runs the aligner on one window's input and gives its raw output.
export type ModelRunner = (input: Float32Array) => Promise<Float32Array>

// When one syllable is sung, in milliseconds from the start of the song, and
// how sure the aligner is of it.
export interface SyllableTiming {
  startMs: number
  endMs: number
  confidence: number
}

export interface AlignmentProgress {
  done: number
  total: number
}

// A step the core refused without a fault of its own: the vocabulary file
// could not be read, or the model's output was not whole frames.
export class AlignmentRunError extends Error {
  constructor(readonly problem: 'vocabulary' | 'output') {
    super()
  }
}

// The aligner's audio is 16 kHz, so 16 samples to the millisecond.
const SAMPLES_PER_MS = 16

// Times every syllable of the lyrics from 16 kHz mono audio: stage 4 of
// processing (docs/architecture.md#processing). The core plans
// the windows and checks the model's output as frames. Then it joins them and
// times the syllables, with the same audio to tell where the singing stops.
// Last it checks the timing as a song file needs it. The caller has loaded the core. A refused step throws
// the core's own fault, unchanged.
export async function alignSong(
  audio: Float32Array,
  lyrics: Uint8Array,
  kind: AlignerKind,
  vocabularyFile: Uint8Array,
  runModel: ModelRunner,
  onProgress: (progress: AlignmentProgress) => void,
): Promise<SyllableTiming[]> {
  const vocabulary = readVocabulary(kind, vocabularyFile)
  if (vocabulary === undefined) throw new AlignmentRunError('vocabulary')
  // Each getter copies the values out of the core, so each is read once.
  const tokens = vocabulary.tokens
  const blank = vocabulary.blank
  vocabulary.free()
  const windows = new AlignerWindows(audio, tokens.length)
  try {
    const total = windows.windowCount
    const frameUs = windows.frameUs
    onProgress({ done: 0, total })
    for (let index = 0; index < total; index++) {
      const output = await runModel(windows.window(index))
      const logProbs = alignerLogProbs(kind, output, tokens.length)
      if (logProbs === undefined) throw new AlignmentRunError('output')
      windows.addFrames(index, logProbs)
      onProgress({ done: index + 1, total })
    }
    const frames = windows.finish()
    const songMs = Math.ceil(audio.length / SAMPLES_PER_MS)
    // The lyric bytes go to the core as they are (D5). Each syllable ends at
    // the next start, or where the audio falls silent.
    const timing = align(lyrics, frames, tokens, blank, frameUs, audio, songMs).map((syllable) => {
      const { startMs, endMs, confidence } = syllable
      syllable.free()
      return { startMs, endMs, confidence }
    })
    checkTiming(Uint32Array.from(timing.flatMap(({ startMs, endMs }) => [startMs, endMs])), lyrics, songMs)
    return timing
  } finally {
    windows.free()
  }
}
