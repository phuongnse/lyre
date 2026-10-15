import { InferenceSession } from 'onnxruntime-web/webgpu'
import init, { AlignerKind } from '../lyre-wasm/lyre_wasm.js'
import { alignSong } from '../alignment/align-song'
import { alignerRunner } from '../alignment/aligner-session'
import { openSession } from '../onnx-session'
import { Backend } from '../separation/backend'
import { decode, separate } from '../separation/separate'
import { openSeparator, separatorRunner } from '../separation/separator-session'
import { SEPARATION_FORMAT } from '../source-audio'
import { SourceError } from '../source-error'
import { CandidateKind } from './candidates'
import { measureBackends, MeasurementSteps } from './measure-backends'
import { readMemory, StageMemory, watchStage, watchWasmMemories } from './memory'
import { MeasurementReply, MeasurementRequest } from './measurement-messages'
import { vocalsForAlignment } from './vocals'
import { wavFile } from './wav'

const kinds: Record<CandidateKind, AlignerKind> = {
  'lyric-alignment': AlignerKind.LyricAlignment,
}

// The WAV files of the tracks are handed over to the page, not copied, so
// the worker keeps none.
const reply = (message: MeasurementReply) =>
  postMessage(message, message.type === 'tracks' ? [message.vocals.buffer, message.karaoke.buffer] : [])

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

// Measures each candidate aligner, off the page's main thread
// (docs/reference/models.md#measurement-method), and against a hand-written
// timing when the page gives its starts. It decodes the source once. Then, on
// each backend in turn, it separates the source and times the lyrics on the
// vocals with each candidate: stages 3 and 4 of processing
// (docs/architecture.md#processing). Every session opens in
// measurement mode, so a backend's figures always come from that backend. It
// answers with figures, and with each separation's tracks as WAV files for the
// page's players, never with the lyric text or an error's text. Each stage's
// figures include the highest memory seen in it. The WebAssembly memory is the
// total of every memory in this worker, the core's and ONNX Runtime's, and it
// never shrinks.
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
// the candidates, and both tracks as WAV files. The separator's load time is
// not part of the separate time, but its memory is part of the stage's. So is
// reading the karaoke track out of the core, but not making the WAV files.
async function separateOn(
  request: MeasurementRequest,
  backend: Backend,
  left: Float32Array,
  right: Float32Array,
  read: () => StageMemory,
): Promise<Awaited<ReturnType<MeasurementSteps['separate']>>> {
  const { result, memory } = await watchStage(read, async (sample) => {
    const graph = await bytesOf(request.separator)
    const { session } = await openSeparator(graph, {
      baseUri: request.baseUri,
      forced: backend,
      measuring: true,
    })
    try {
      sample()
      const separateStart = performance.now()
      const tracks = await separate(separatorRunner(session), left, right, sample)
      const separateMs = performance.now() - separateStart
      // Each getter copies a track out of the core, so each is read once.
      const planar = tracks.vocals
      const karaoke = tracks.karaoke
      tracks.free()
      return { vocals: vocalsForAlignment(planar), planar, karaoke, separateMs }
    } finally {
      await session.release().catch(() => undefined)
    }
  })
  const { vocals, planar, karaoke, separateMs } = result
  const rate = SEPARATION_FORMAT.sampleRate
  return {
    vocals,
    tracks: { vocals: wavFile(planar, rate), karaoke: wavFile(karaoke, rate) },
    separateMs,
    memory,
  }
}

// Times the lyrics on the vocals with one candidate on `backend`, and gives
// the timing. The memory covers loading the model as well as aligning.
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
  memory: StageMemory
  timesMs: Uint32Array<ArrayBuffer>
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
      // Each syllable's start then end, for the page to play the source with this timing.
      const timesMs = Uint32Array.from(timing.flatMap(({ startMs, endMs }) => [startMs, endMs]))
      return { loadMs, alignMs, timesMs }
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
