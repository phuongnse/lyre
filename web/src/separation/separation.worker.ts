import init, { SeparationFault } from '../lyre-wasm/lyre_wasm.js'
import { SourceError } from '../source-error'
import { SEPARATION_FORMAT } from '../source-audio'
import { decode, separate } from './separate'
import { replyForFault, SeparationReply, SeparationRequest } from './separation-messages'
import { openSeparator } from './separator-session'

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
  try {
    const [left, right] = await decode(request.source)
    const tracks = await separate(session, left, right, (done, total) =>
      postMessage({ type: 'progress', backend, done, total } satisfies SeparationReply),
    )
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
  }
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
