import { SeparatedTracks, Separation } from '../lyre-wasm/lyre_wasm.js'
import { decodeAudio, SEPARATION_FORMAT } from '../source-audio'

// Runs the separator on one segment: the spectrogram `spec` in the shape
// SPEC_SHAPE. It gives the vocals' spectrogram. `dispose` frees it once the
// core has read it.
export type SeparatorRunner = (spec: Float32Array) => Promise<{ vocalsSpec: Float32Array; dispose(): void }>

// Decodes the whole source at 44.1 kHz stereo, because the core's separation
// needs all of it. It gives the left channel, then the right.
export async function decode(source: Blob): Promise<[Float32Array, Float32Array]> {
  const pieces: Float32Array[][] = [[], []]
  for await (const planes of decodeAudio(source, SEPARATION_FORMAT)) {
    pieces[0]!.push(planes[0]!)
    pieces[1]!.push(planes[1]!)
  }
  return [concatenate(pieces[0]!), concatenate(pieces[1]!)]
}

function concatenate(pieces: Float32Array[]): Float32Array {
  const joined = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0))
  let offset = 0
  for (const piece of pieces) {
    joined.set(piece, offset)
    offset += piece.length
  }
  return joined
}

// Separates decoded 44.1 kHz stereo audio into vocals and a karaoke track
// with a separator runner, segment by segment: stage 3 of processing
// (docs/architecture.md#processing). `onProgress` gets the
// segments done out of the total, first with none done. The caller has loaded
// the core and frees the tracks. A refused step or a failed broken-run check
// throws the core's SeparationFault.
export async function separate(
  runSegment: SeparatorRunner,
  left: Float32Array,
  right: Float32Array,
  onProgress: (done: number, total: number) => void,
): Promise<SeparatedTracks> {
  const separation = new Separation(left, right)
  try {
    const total = separation.segmentCount
    onProgress(0, total)
    for (let index = 0; index < total; index++) {
      const spec = separation.input(index)
      const { vocalsSpec, dispose } = await runSegment(spec)
      try {
        separation.output(index, vocalsSpec)
      } finally {
        dispose()
      }
      onProgress(index + 1, total)
    }
    return separation.finish()
  } finally {
    separation.free()
  }
}
