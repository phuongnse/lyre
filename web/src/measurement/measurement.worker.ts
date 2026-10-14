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
import { readMemory, StageMemory, watchStage, watchWasmMemories } from './memory'
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
// tracks or an error's text. Each stage's figures include the highest memory
// seen in it. The WebAssembly memory is the total of every memory in this
// worker, the core's and ONNX Runtime's, and it never shrinks.
addEventListener('message', (event: MessageEvent<MeasurementRequest>) => {
  if (event.data.type !== 'run') return
  void run(event.data).then(
    () => reply({ type: 'done' }),
    (error: unknown) => reply(replyForError(error)),
  )
})

async function run(request: MeasurementRequest): Promise<void> {
  // Before anything loads, so ONNX Runtime's memory is counted too.
  const wasm = watchWasmMemories()
  const read = () => readMemory(wasm)
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', request.baseUri) })
  reply({ type: 'stage', stage: 'extract' })
  const extractStart = performance.now()
  const {
    result: [left, right],
    memory,
  } = await watchStage(read, () => decode(request.source))
  reply({ type: 'extracted', extractMs: performance.now() - extractStart, memory })
  // The lyric bytes go to the core as they are (D5).
  const lyrics = await bytesOf(request.lyrics)
  const steps: MeasurementSteps = {
    separate: (backend) => separateOn(request, backend, left, right, read),
    measure: (candidate, backend, vocals) => measureOn(request, candidate, backend, vocals, lyrics, read),
  }
  await measureBackends(request.backends, request.candidates, steps, reply)
}

// Separates the source on `backend`, and gives the vocals as 16 kHz mono for
// the candidates. The separator's load time is not part of the separate time,
// but its memory is part of the stage's.
async function separateOn(
  request: MeasurementRequest,
  backend: Backend,
  left: Float32Array,
  right: Float32Array,
  read: () => StageMemory,
): Promise<{ vocals: Float32Array; separateMs: number; sumCheckDb: number; memory: StageMemory }> {
  const { result, memory } = await watchStage(read, async (sample) => {
    const [graph, weights] = await Promise.all([bytesOf(request.separator.graph), bytesOf(request.separator.weights)])
    const { session } = await openSeparator(graph, weights, {
      baseUri: request.baseUri,
      forced: backend,
      measuring: true,
    })
    try {
      sample()
      const separateStart = performance.now()
      const tracks = await separate(session, left, right, sample)
      const separateMs = performance.now() - separateStart
      const sumCheckDb = tracks.energyDb
      // The getter copies the vocals out of the core, so it is read once.
      const planar = tracks.vocals
      tracks.free()
      return { vocals: vocalsForAlignment(planar), separateMs, sumCheckDb }
    } finally {
      await session.release().catch(() => undefined)
    }
  })
  return { ...result, memory }
}

// Times the lyrics on the vocals with one candidate on `backend`, and
// measures the timing against the hand-written one. The memory covers loading
// the model as well as aligning.
async function measureOn(
  request: MeasurementRequest,
  { kind, graph, vocabulary }: MeasurementRequest['candidates'][number],
  backend: Backend,
  vocals: Float32Array,
  lyrics: Uint8Array,
  read: () => StageMemory,
): Promise<{
  loadMs: number
  alignMs: number
  medianMs: number
  p90Ms: number
  within100Ms: number
  memory: StageMemory
}> {
  const { result, memory } = await watchStage(read, async (sample) => {
    let session: InferenceSession | undefined
    try {
      // The load time covers reading the checked bytes and opening the session.
      const loadStart = performance.now()
      const [graphBytes, vocabularyBytes] = await Promise.all([bytesOf(graph), bytesOf(vocabulary)])
      session = (await openSession(graphBytes, { baseUri: request.baseUri, forced: backend, measuring: true })).session
      const loadMs = performance.now() - loadStart
      sample()
      const alignStart = performance.now()
      const runner = alignerRunner(session, kinds[kind])
      const timing = await alignSong(vocals, lyrics, kinds[kind], vocabularyBytes, runner, sample)
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
  })
  return { ...result, memory }
}

// The reply for a run that stopped: a source that has no audio or cannot be
// read. The error's own text is never sent.
function replyForError(error: unknown): MeasurementReply {
  if (error instanceof SourceError) return { type: 'failed', problem: error.problem }
  return { type: 'failed', problem: 'unreadable' }
}
