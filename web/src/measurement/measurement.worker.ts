import { InferenceSession } from 'onnxruntime-web/webgpu'
import init, { AlignerKind, measureOnsetError } from '../lyre-wasm/lyre_wasm.js'
import { alignSong } from '../alignment/align-song'
import { alignerRunner } from '../alignment/aligner-session'
import { openSession } from '../onnx-session'
import { Backend } from '../separation/backend'
import { decode, separate } from '../separation/separate'
import { openSeparator } from '../separation/separator-session'
import { SourceError } from '../source-error'
import { CandidateKind } from './candidates'
import { measureBackends, MeasurementSteps } from './measure-backends'
import { MeasurementReply, MeasurementRequest } from './measurement-messages'
import { vocalsForAlignment } from './vocals'

const kinds: Record<CandidateKind, AlignerKind> = {
  omnilingual: AlignerKind.Omnilingual,
  'lyric-alignment': AlignerKind.LyricAlignment,
}

const reply = (message: MeasurementReply) => postMessage(message)

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

// Measures each candidate aligner against a hand-written timing, off the
// page's main thread (docs/reference/models.md#measurement-method). It
// decodes the source once. Then, on each backend in turn, it separates the
// source and times the lyrics on the vocals with each candidate: stages 3 and
// 4 of processing (docs/architecture.md#processing-planned-for-m2). Every
// session opens in measurement mode, so a backend's figures always come from
// that backend. It answers with figures, never with the lyric text, the
// tracks or an error's text.
addEventListener('message', (event: MessageEvent<MeasurementRequest>) => {
  if (event.data.type !== 'run') return
  void run(event.data).then(
    () => reply({ type: 'done' }),
    (error: unknown) => reply(replyForError(error)),
  )
})

async function run(request: MeasurementRequest): Promise<void> {
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', request.baseUri) })
  reply({ type: 'stage', stage: 'extract' })
  const extractStart = performance.now()
  const [left, right] = await decode(request.source)
  reply({ type: 'extracted', extractMs: performance.now() - extractStart })
  // The lyric bytes go to the core as they are (D5).
  const lyrics = await bytesOf(request.lyrics)
  const steps: MeasurementSteps = {
    separate: (backend) => separateOn(request, backend, left, right),
    measure: (candidate, backend, vocals) => measureOn(request, candidate, backend, vocals, lyrics),
  }
  await measureBackends(request.backends, request.candidates, steps, reply)
}

// Separates the source on `backend`, and gives the vocals as 16 kHz mono for
// the candidates. The separator's load time is not part of the separate time.
async function separateOn(
  request: MeasurementRequest,
  backend: Backend,
  left: Float32Array,
  right: Float32Array,
): Promise<{ vocals: Float32Array; separateMs: number; sumCheckDb: number }> {
  const [graph, weights] = await Promise.all([bytesOf(request.separator.graph), bytesOf(request.separator.weights)])
  const { session } = await openSeparator(graph, weights, {
    baseUri: request.baseUri,
    forced: backend,
    measuring: true,
  })
  try {
    const separateStart = performance.now()
    const tracks = await separate(session, left, right, () => undefined)
    const separateMs = performance.now() - separateStart
    const sumCheckDb = tracks.energyDb
    // The getter copies the vocals out of the core, so it is read once.
    const planar = tracks.vocals
    tracks.free()
    return { vocals: vocalsForAlignment(planar), separateMs, sumCheckDb }
  } finally {
    await session.release().catch(() => undefined)
  }
}

// Times the lyrics on the vocals with one candidate on `backend`, and
// measures the timing against the hand-written one.
async function measureOn(
  request: MeasurementRequest,
  { kind, graph, vocabulary }: MeasurementRequest['candidates'][number],
  backend: Backend,
  vocals: Float32Array,
  lyrics: Uint8Array,
): Promise<{ loadMs: number; alignMs: number; medianMs: number; p90Ms: number; within100Ms: number }> {
  let session: InferenceSession | undefined
  try {
    // The load time covers reading the checked bytes and opening the session.
    const loadStart = performance.now()
    const [graphBytes, vocabularyBytes] = await Promise.all([bytesOf(graph), bytesOf(vocabulary)])
    session = (await openSession(graphBytes, { baseUri: request.baseUri, forced: backend, measuring: true })).session
    const loadMs = performance.now() - loadStart
    const alignStart = performance.now()
    const runner = alignerRunner(session, kinds[kind])
    const timing = await alignSong(vocals, lyrics, kinds[kind], vocabularyBytes, runner, () => undefined)
    const alignMs = performance.now() - alignStart
    const errors = measureOnsetError(
      request.handStartsMs,
      Uint32Array.from(timing, (syllable) => syllable.startMs),
    )
    const { medianMs, p90Ms, within100Ms } = errors
    errors.free()
    return { loadMs, alignMs, medianMs, p90Ms, within100Ms }
  } finally {
    await session?.release().catch(() => undefined)
  }
}

// The reply for a run that stopped: a source that has no audio or cannot be
// read. The error's own text is never sent.
function replyForError(error: unknown): MeasurementReply {
  if (error instanceof SourceError) return { type: 'failed', problem: error.problem }
  return { type: 'failed', problem: 'unreadable' }
}
