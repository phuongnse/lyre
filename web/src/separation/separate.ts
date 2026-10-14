import { InferenceSession } from 'onnxruntime-web/webgpu'
import { SeparatedTracks, Separation } from '../lyre-wasm/lyre_wasm.js'
import { decodeAudio, SEPARATION_FORMAT } from '../source-audio'
import { runWindow } from './separator-session'

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

// Separates decoded 44.1 kHz stereo audio into vocals and a karaoke track in
// an open separator session, window by window: stage 3 of processing
// (docs/architecture.md#processing-planned-for-m2). `onProgress` gets the
// windows done out of the total, first with none done. The caller has loaded
// the core and frees the tracks. A refused step or a failed sum check throws
// the core's SeparationFault.
export async function separate(
  session: InferenceSession,
  left: Float32Array,
  right: Float32Array,
  onProgress: (done: number, total: number) => void,
): Promise<SeparatedTracks> {
  const separation = new Separation(left, right)
  try {
    const total = separation.windowCount
    onProgress(0, total)
    for (let index = 0; index < total; index++) {
      const input = separation.input(index)
      // Each getter copies the values out of the core, so each is read once.
      const x = input.x
      const xt = input.xt
      input.free()
      const { xOut, xtOut } = await runWindow(session, x, xt)
      try {
        separation.output(index, xOut.data as Float32Array, xtOut.data as Float32Array)
      } finally {
        xOut.dispose()
        xtOut.dispose()
      }
      onProgress(index + 1, total)
    }
    return separation.finish()
  } finally {
    separation.free()
  }
}
