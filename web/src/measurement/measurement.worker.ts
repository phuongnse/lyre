import { InferenceSession } from 'onnxruntime-web/webgpu'
import init, { AlignerKind, measureOnsetError, SeparationFault } from '../lyre-wasm/lyre_wasm.js'
import { alignSong } from '../alignment/align-song'
import { alignerRunner } from '../alignment/aligner-session'
import { openSession } from '../onnx-session'
import { decode, separate } from '../separation/separate'
import { replyForFault } from '../separation/separation-messages'
import { openSeparator } from '../separation/separator-session'
import { SourceError } from '../source-error'
import { CandidateKind } from './candidates'
import { candidateFailure, MeasurementReply, MeasurementRequest } from './measurement-messages'
import { vocalsForAlignment } from './vocals'

// The model files could not be opened as a separator.
class ModelError extends Error {}

const kinds: Record<CandidateKind, AlignerKind> = {
  omnilingual: AlignerKind.Omnilingual,
  'lyric-alignment': AlignerKind.LyricAlignment,
}

const reply = (message: MeasurementReply) => postMessage(message)

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

// Measures each candidate aligner against a hand-written timing, off the
// page's main thread (docs/reference/models.md#measurement-method). It
// separates the source once, then times the lyrics on the vocals with each
// candidate in turn: stages 3 and 4 of processing
// (docs/architecture.md#processing-planned-for-m2). It answers with figures,
// never with the lyric text, the tracks or an error's text.
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
  const vocals = await separatedVocals(request)
  // The lyric bytes go to the core as they are (D5).
  const lyrics = await bytesOf(request.lyrics)
  for (const { candidate, kind, graph, vocabulary } of request.candidates) {
    reply({ type: 'stage', stage: 'align', candidate })
    let session: InferenceSession | undefined
    try {
      // The load time covers reading the checked bytes and opening the session.
      const loadStart = performance.now()
      const [graphBytes, vocabularyBytes] = await Promise.all([bytesOf(graph), bytesOf(vocabulary)])
      const opened = await openSession(graphBytes, { baseUri: request.baseUri, forced: request.forced })
      session = opened.session
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
      reply({ type: 'measured', candidate, backend: opened.backend, loadMs, alignMs, medianMs, p90Ms, within100Ms })
    } catch (error) {
      // A candidate that cannot run is a finding, so the next one still runs.
      reply(candidateFailure(candidate, error))
    } finally {
      await session?.release().catch(() => undefined)
    }
  }
}

// Decodes and separates the source once, and gives the vocals as 16 kHz mono
// for every candidate. The separator's load time is not part of the separate time.
async function separatedVocals(request: MeasurementRequest): Promise<Float32Array> {
  reply({ type: 'stage', stage: 'extract' })
  const extractStart = performance.now()
  const [left, right] = await decode(request.source)
  const extractMs = performance.now() - extractStart
  reply({ type: 'stage', stage: 'separate' })
  const [graph, weights] = await Promise.all([bytesOf(request.separator.graph), bytesOf(request.separator.weights)])
  const { session } = await openSeparator(graph, weights, {
    baseUri: request.baseUri,
    forced: request.forced,
  }).catch(() => {
    throw new ModelError()
  })
  try {
    const separateStart = performance.now()
    const tracks = await separate(session, left, right, () => undefined)
    const sumCheckDb = tracks.energyDb
    // The getter copies the vocals out of the core, so it is read once.
    const planar = tracks.vocals
    tracks.free()
    const vocals = vocalsForAlignment(planar)
    reply({ type: 'separated', extractMs, separateMs: performance.now() - separateStart, sumCheckDb })
    return vocals
  } finally {
    await session.release()
  }
}

// The reply for a run that stopped. The error's own text is never sent.
function replyForError(error: unknown): MeasurementReply {
  if (error instanceof SeparationFault) {
    const failure = replyForFault({ kind: error.kind, measuredDb: error.measuredDb })
    error.free()
    // A sum check failure or a refused step, as on the separation check page.
    return failure.type === 'sum-check-failed' ? failure : { type: 'failed', problem: 'unreadable' }
  }
  if (error instanceof SourceError) return { type: 'failed', problem: error.problem }
  if (error instanceof ModelError) return { type: 'failed', problem: 'model' }
  return { type: 'failed', problem: 'unreadable' }
}
