import init, { AlignerKind } from '../lyre-wasm/lyre_wasm.js'
import { openSession } from '../onnx-session'
import { alignSong } from './align-song'
import { AlignerCheckReply, AlignerCheckRequest, replyForError } from './aligner-check-messages'
import { alignerRunner } from './aligner-session'
import { testAudio } from './test-audio'

// Times the syllables of a lyrics file on the test audio with the lyric-alignment test aligner,
// off the page's main thread: stage 4 of processing
// (docs/architecture.md#processing-planned-for-m2). It answers with progress
// and counts, never with the lyric text or the error's text.
addEventListener('message', (event: MessageEvent<AlignerCheckRequest>) => {
  if (event.data.type !== 'run') return
  void run(event.data).then(
    (reply) => postMessage(reply),
    (error: unknown) => postMessage(replyForError(error)),
  )
})

async function run(request: AlignerCheckRequest): Promise<AlignerCheckReply> {
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', request.baseUri) })
  // The lyric bytes go to the core as they are (D5).
  const [graph, vocabulary, lyrics] = await Promise.all(
    [request.graph, request.vocabulary, request.lyrics].map(async (blob) => new Uint8Array(await blob.arrayBuffer())),
  )
  const { backend, session } = await openSession(graph, { baseUri: request.baseUri, forced: request.forced })
  try {
    const kind = AlignerKind.LyricAlignment
    const timing = await alignSong(testAudio(), lyrics, kind, vocabulary, alignerRunner(session, kind), (progress) =>
      postMessage({ type: 'progress', backend, ...progress } satisfies AlignerCheckReply),
    )
    return { type: 'aligned', backend, syllables: timing.length }
  } finally {
    await session.release()
  }
}
