import { SeparatorCheckReply, SeparatorCheckRequest } from './check-messages'
import { openSeparator, runWindow, X_SHAPE, XT_SHAPE } from './separator-session'

const size = (shape: number[]) => shape.reduce((product, length) => product * length)

// Opens the test separator and runs one window of silence, off the page's
// main thread. It answers with the shapes, never with model bytes.
addEventListener('message', (event: MessageEvent<SeparatorCheckRequest>) => {
  if (event.data.type !== 'run') return
  void run(event.data).then(
    (reply) => postMessage(reply),
    () => postMessage({ type: 'failed' } satisfies SeparatorCheckReply),
  )
})

async function run(request: SeparatorCheckRequest): Promise<SeparatorCheckReply> {
  const [graph, weights] = await Promise.all(
    [request.graph, request.weights].map(async (blob) => new Uint8Array(await blob.arrayBuffer())),
  )
  const { backend, session } = await openSeparator(graph, weights, { baseUri: request.baseUri, forced: request.forced })
  try {
    const { xOut, xtOut } = await runWindow(session, new Float32Array(size(X_SHAPE)), new Float32Array(size(XT_SHAPE)))
    return { type: 'ran', backend, xOut: [...xOut.dims], xtOut: [...xtOut.dims] }
  } finally {
    await session.release()
  }
}
