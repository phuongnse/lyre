// @vitest-environment node
import { readFileSync } from 'node:fs'
import { env, InferenceSession } from 'onnxruntime-web/webgpu'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { ModelRunner } from '../alignment/align-song'
import { KARAOKE_TYPE } from '../karaoke-track'
import { AlignerKind, ChunkKind, initSync, readVocabulary, SongReader } from '../lyre-wasm/lyre_wasm.js'
import { FakeModelFiles } from '../models/fake-model-files'
import { loadModel } from '../models/model-download'
import { SessionCreator } from '../onnx-session'
import { PackagedTrack } from '../original-track'
import { SeparatorRunner } from '../separation/separate'
import { separatorRunner } from '../separation/separator-session'
import { SessionFault } from '../session-backend'
import { openSongFile } from '../song-file'
import { AudioFormat } from '../source-audio'
import { FakeWorkingAreas } from './fake-working-areas'
import { realSongModels } from './song-models'
import { SongMedia, SongModels, songStages, SongTaskInput } from './song-task'
import { runTask, TaskReport } from './task'

const fixture = (path: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${path}`, import.meta.url)))

const taskId = 'task-1'
const SOURCE_SECONDS = 10
const STAGES = ['read-source', 'extract-audio', 'separate', 'align', 'lay-out', 'package-media', 'write-song']
// The core separates and aligns the whole 10 s song, which takes a few seconds.
const TIMEOUT_MS = 60_000

const aligners = {
  'lyric-alignment': {
    kind: 'lyric-alignment',
    model: 'test-lyric-alignment-model',
    vocabulary: 'test-lyric-alignment-vocab',
    file: 'models/lyric-alignment-vocab.json',
  },
} as const

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// Fetches each test model file from tests/fixtures/models/.
const fakeFetch = (): typeof fetch =>
  (async (input: RequestInfo | URL) =>
    new Response(fixture(`models/${String(input).split('/').at(-1)!}`))) as typeof fetch

// The three model files of a task, as the page gives them: loaded and checked.
async function checkedFiles(aligner: (typeof aligners)[keyof typeof aligners]) {
  const options = { files: new FakeModelFiles(), fetch: fakeFetch(), baseUri: 'http://lyre.test/' }
  return {
    separator: await loadModel('test-mel-roformer', options),
    model: await loadModel(aligner.model, options),
    vocabulary: await loadModel(aligner.vocabulary, options),
  }
}

// Runs the committed test separator file, as the web client does, on
// WebAssembly in Node. `segments.count` counts the segments it ran.
async function openTestSeparator(
  graph: Uint8Array,
  segments: { count: number },
): Promise<{ run: SeparatorRunner; release(): Promise<void> }> {
  env.wasm.numThreads = 1
  env.wasm.proxy = false
  env.wasm.wasmBinary = readFileSync(
    new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url),
  )
  const session = await InferenceSession.create(graph, { executionProviders: ['wasm'] })
  const run = separatorRunner(session)
  return {
    run: async (spec) => {
      segments.count++
      return run(spec)
    },
    release: () => session.release(),
  }
}

// A stand-in aligner that gives every token the same probability in every
// frame, as log probabilities, as in align-song.spec.ts.
function alignerStandIn(kind: AlignerKind, file: Uint8Array): ModelRunner {
  const vocabulary = readVocabulary(kind, file)!
  const tokens = vocabulary.tokens.length
  vocabulary.free()
  const value = Math.log(1 / tokens)
  return async (input) => new Float32Array((input.length / 320 - 1) * tokens).fill(value)
}

function fakeModels(o: { aligner: keyof typeof aligners; segments: { count: number } }): SongModels {
  return {
    openSeparator: (graph) => openTestSeparator(graph, o.segments),
    async openAligner(kind) {
      return { run: alignerStandIn(kind, fixture(aligners[o.aligner].file)), release: async () => {} }
    },
  }
}

// A 440 Hz sine in `format`, in pieces of 1 s.
async function* sine(format: AudioFormat): AsyncGenerator<Float32Array[]> {
  for (let second = 0; second < SOURCE_SECONDS; second++) {
    const plane = new Float32Array(format.sampleRate)
    for (let i = 0; i < plane.length; i++) {
      plane[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (second * format.sampleRate + i)) / format.sampleRate)
    }
    yield Array.from({ length: format.channels }, () => plane.slice())
  }
}

// Two 5,000 ms segments, so the tracks last as long as the source.
const track = (storedType: string): PackagedTrack => ({
  startMs: 0,
  storedType,
  init: new Uint8Array([1, 2, 3, 4]),
  segments: [
    { durationMs: 5_000, bytes: new Uint8Array([5, 6, 7, 8]) },
    { durationMs: 5_000, bytes: new Uint8Array([9, 10, 11, 12]) },
  ],
})

// Media work for a 10 s audio-only source. `karaokeFrames` records how many
// frames of karaoke audio makeKaraoke got.
function fakeMedia(): SongMedia & { karaokeFrames: number } {
  return {
    karaokeFrames: 0,
    async readSource() {
      return { duration: SOURCE_SECONDS, startOffset: 0, hasVideo: false, audioType: 'audio/webm; codecs="opus"' }
    },
    decode: (_file, format) => sine(format),
    async packageOriginal(_file, type) {
      return track(type)
    },
    async makeKaraoke(audio) {
      for await (const planes of audio) this.karaokeFrames += planes[0]!.length
      return track(KARAOKE_TYPE)
    },
    async packageVideo() {
      return null
    },
    async makeThumbnail() {
      return null
    },
  }
}

async function run(o: { lyrics?: Uint8Array; aligner?: keyof typeof aligners; models?: SongModels }): Promise<{
  reports: TaskReport[]
  areas: FakeWorkingAreas
  segments: { count: number }
  media: ReturnType<typeof fakeMedia>
  models: SongModels
}> {
  const aligner = aligners[o.aligner ?? 'lyric-alignment']
  const { separator, model, vocabulary } = await checkedFiles(aligner)
  const input: SongTaskInput = {
    source: new Blob([new Uint8Array(16)]),
    lyrics: o.lyrics ?? fixture('song/lyrics.txt'),
    details: { title: 'Test song', artist: 'Test artist', composer: '' },
    vocalRole: 'female',
    separator,
    aligner: { kind: aligner.kind, model, vocabulary },
  }
  const segments = { count: 0 }
  const media = fakeMedia()
  const models = o.models ?? fakeModels({ aligner: o.aligner ?? 'lyric-alignment', segments })
  const reports: TaskReport[] = []
  const areas = new FakeWorkingAreas()
  await runTask({ taskId, stages: songStages(input, media, models), areas, report: (report) => reports.push(report) })
  return { reports, areas, segments, media, models }
}

// The bytes of the song file's Lyrics chunk, read through the core.
async function lyricsChunk(song: Uint8Array): Promise<Uint8Array> {
  const header = song.subarray(0, 32)
  const index = song.subarray(32, 32 + SongReader.indexLength(header))
  const reader = new SongReader(header, index, song.length)
  try {
    const entries = reader.entries()
    const lyrics = entries.find((entry) => entry.kind === ChunkKind.Lyrics)!
    const bytes = song.slice(lyrics.offset, lyrics.offset + lyrics.length)
    for (const entry of entries) entry.free()
    return bytes
  } finally {
    reader.free()
  }
}

describe('a song task', () => {
  for (const aligner of Object.keys(aligners) as (keyof typeof aligners)[]) {
    test(
      `with the test separator and the ${aligner} test aligner, gives a song file with the lyrics byte for byte`,
      async () => {
        const lyrics = fixture('song/lyrics.txt')
        const { reports, areas, media, segments, models } = await run({ lyrics, aligner })

        // The task is given checked files and has no way to load a model file.
        expect('load' in models).toBe(false)

        const done = reports.at(-1)
        expect(done?.type).toBe('done')
        const song = (done as { song?: Uint8Array }).song!
        const opened = await openSongFile(new Blob([song as Uint8Array<ArrayBuffer>]))
        expect(opened.details).toEqual({ title: 'Test song', artist: 'Test artist', composer: '', vocalRole: 'female' })
        expect(opened.lyrics).toHaveLength(9)
        opened.close()
        expect(await lyricsChunk(song)).toEqual(fixture('song/lyrics.txt'))
        // The supplied bytes were not changed on the way either (D5).
        expect(lyrics).toEqual(fixture('song/lyrics.txt'))
        // The 10 s source went through the test separator in 5 segments.
        expect(segments.count).toBe(5)
        // The karaoke track came from separation, resampled to 48 kHz.
        expect(media.karaokeFrames).toBe(SOURCE_SECONDS * 48_000)
        expect(areas.areas.has(taskId)).toBe(false)
      },
      TIMEOUT_MS,
    )
  }

  test(
    'runs the stages in the order of processing, and each reports progress',
    async () => {
      const { reports } = await run({})
      const progress = reports.filter((report) => report.type === 'progress')
      expect([...new Set(progress.map((report) => report.stage))]).toEqual(STAGES)
      // Each stage starts after the one before it has ended.
      expect(progress.map((report) => report.index)).toEqual(
        [...progress.map((report) => report.index)].sort((a, b) => a - b),
      )
      for (const stage of STAGES) {
        expect(progress.some((report) => report.stage === stage && report.fraction !== undefined)).toBe(true)
      }
    },
    TIMEOUT_MS,
  )

  test(
    'separates with the test separator and goes on to alignment',
    async () => {
      const { reports } = await run({})
      const progress = reports.filter((report) => report.type === 'progress')
      const first = (stage: string) => progress.findIndex((report) => report.stage === stage)
      expect(first('separate')).toBeGreaterThanOrEqual(0)
      expect(first('align')).toBeGreaterThan(first('separate'))
      expect(reports.at(-1)?.type).toBe('done')
    },
    TIMEOUT_MS,
  )

  test(
    'fails at alignment when a syllable has no character the vocabulary knows, names its place and removes the working area',
    async () => {
      const { reports, areas } = await run({ lyrics: new TextEncoder().encode('Mưa rơi ♪ nhẹ\n') })
      expect(reports.at(-1)).toEqual({
        type: 'failed',
        stage: 'align',
        reason: 'alignment-failed',
        unknown: { lyricLine: 0, syllable: 2 },
      })
      expect(reports.some((report) => report.type === 'done')).toBe(false)
      expect(areas.areas.has(taskId)).toBe(false)
    },
    TIMEOUT_MS,
  )
})

// A session creator that records each backend it is asked for and never opens
// one, as a device whose GPU or CPU cannot run the model.
function refusingCreator(): { create: SessionCreator; tried: string[] } {
  const tried: string[] = []
  return {
    tried,
    create: async (_graph, backend) => {
      tried.push(backend)
      throw new Error('no kernel')
    },
  }
}

describe('a song task whose model session cannot open', () => {
  // Gives the browser a GPU adapter, which is the one thing a task looks for.
  const withAdapter = () => vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test.each(['webgpu', 'wasm'] as const)(
    'fails the separate stage on %s only, and never tries the other backend',
    async (backend) => {
      withAdapter()
      const { create, tried } = refusingCreator()
      const models = realSongModels('http://lyre.test/', backend, create)
      const { reports, areas } = await run({ models })

      expect(reports.at(-1)).toEqual({ type: 'failed', stage: 'separate', reason: 'separation-failed' })
      expect(tried).toEqual([backend])
      expect(areas.areas.has(taskId)).toBe(false)
    },
    TIMEOUT_MS,
  )

  test('fails the separate stage on WebGPU without trying anything when the browser gives no adapter', async () => {
    vi.stubGlobal('navigator', {})
    const { create, tried } = refusingCreator()
    const models = realSongModels('http://lyre.test/', 'webgpu', create)
    const { reports } = await run({ models })

    expect(reports.at(-1)).toEqual({ type: 'failed', stage: 'separate', reason: 'separation-failed' })
    expect(tried).toEqual([])
  })

  test.each(['webgpu', 'wasm'] as const)(
    'gives the aligner a SessionFault on %s only, and never tries the other backend',
    async (backend) => {
      withAdapter()
      const { create, tried } = refusingCreator()
      const models = realSongModels('http://lyre.test/', backend, create)

      await expect(models.openAligner(AlignerKind.LyricAlignment, new Uint8Array(1))).rejects.toBeInstanceOf(
        SessionFault,
      )
      expect(tried).toEqual([backend])
    },
  )
})
