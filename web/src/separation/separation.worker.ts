import init, { Separation, SeparationFault } from '../lyre-wasm/lyre_wasm.js'
import { SourceError } from '../source-error'
import { decodeAudio, SEPARATION_FORMAT } from '../source-audio'
import { replyForFault, SeparationReply, SeparationRequest } from './separation-messages'
import { openSeparator, runWindow } from './separator-session'

// The model files could not be opened as a separator.
class ModelError extends Error {}

// Separates a source's audio into vocals and a karaoke track, off the page's
// main thread: stage 3 of processing (docs/architecture.md#processing-planned-for-m2).
// It answers with progress and lengths, never with the tracks or the error's text.
addEventListener('message', (event: MessageEvent<SeparationRequest>) => {
  if (event.data.type !== 'run') return
  void run(event.data).then(
    (reply) => postMessage(reply),
    (error: unknown) => postMessage(replyForError(error)),
  )
})

async function run(request: SeparationRequest): Promise<SeparationReply> {
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', request.baseUri) })
  const [graph, weights] = await Promise.all(
    [request.graph, request.weights].map(async (blob) => new Uint8Array(await blob.arrayBuffer())),
  )
  const { backend, session } = await openSeparator(graph, weights, {
    baseUri: request.baseUri,
    forced: request.forced,
  }).catch(() => {
    throw new ModelError()
  })
  let separation: Separation | undefined
  try {
    const [left, right] = await decode(request.source)
    separation = new Separation(left, right)
    const total = separation.windowCount
    postMessage({ type: 'progress', backend, done: 0, total } satisfies SeparationReply)
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
      postMessage({ type: 'progress', backend, done: index + 1, total } satisfies SeparationReply)
    }
    const tracks = separation.finish()
    // The tracks are not kept yet, so only their lengths leave the worker.
    const vocals = tracks.vocals.length
    const karaoke = tracks.karaoke.length
    tracks.free()
    const rate = SEPARATION_FORMAT.sampleRate
    return {
      type: 'separated',
      backend,
      sourceSeconds: left.length / rate,
      vocalsSeconds: vocals / 2 / rate,
      karaokeSeconds: karaoke / 2 / rate,
    }
  } finally {
    await session.release()
    separation?.free()
  }
}

// Decodes the whole source at 44.1 kHz stereo, because the core's separation
// needs all of it.
async function decode(source: File): Promise<[Float32Array, Float32Array]> {
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

// The reply for a failed run. The error's own text is never sent.
function replyForError(error: unknown): SeparationReply {
  if (error instanceof SeparationFault) {
    const reply = replyForFault({ kind: error.kind, measuredDb: error.measuredDb })
    error.free()
    return reply
  }
  if (error instanceof SourceError) return { type: 'failed', problem: error.problem }
  if (error instanceof ModelError) return { type: 'failed', problem: 'model' }
  return { type: 'failed', problem: 'unreadable' }
}
