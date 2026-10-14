import { SeparatorCheckReply, SeparatorCheckRequest } from './check-messages'
import { openSeparator, runSegment, SPEC_SHAPE } from './separator-session'

const size = (shape: number[]) => shape.reduce((product, length) => product * length)

// Opens the test separator and runs one segment of silence, off the page's
// main thread. It answers with the shape, never with model bytes.
addEventListener('message', (event: MessageEvent<SeparatorCheckRequest>) => {
  if (event.data.type !== 'run') return
  void run(event.data).then(
    (reply) => postMessage(reply),
    () => postMessage({ type: 'failed' } satisfies SeparatorCheckReply),
  )
})

async function run(request: SeparatorCheckRequest): Promise<SeparatorCheckReply> {
  const graph = new Uint8Array(await request.separator.arrayBuffer())
  const { backend, session } = await openSeparator(graph, { baseUri: request.baseUri, forced: request.forced })
  try {
    const stemsSpec = await runSegment(session, new Float32Array(size(SPEC_SHAPE)))
    return { type: 'ran', backend, stemsSpec: [...stemsSpec.dims] }
  } finally {
    await session.release()
  }
}
