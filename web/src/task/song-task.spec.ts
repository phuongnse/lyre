// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { ModelRunner } from '../alignment/align-song'
import { KARAOKE_TYPE } from '../karaoke-track'
import { AlignerKind, ChunkKind, initSync, readVocabulary, SongReader } from '../lyre-wasm/lyre_wasm.js'
import { FakeModelFiles } from '../models/fake-model-files'
import { loadModel } from '../models/model-download'
import { PackagedTrack } from '../original-track'
import { SeparatorRunner } from '../separation/separate'
import { openSongFile } from '../song-file'
import { AudioFormat } from '../source-audio'
import { FakeWorkingAreas } from './fake-working-areas'
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
  omnilingual: {
    kind: 'omnilingual',
    model: 'test-omnilingual-model',
    vocabulary: 'test-omnilingual-tokens',
    file: 'models/omnilingual-tokens.txt',
  },
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

// Fetches each test model file from tests/fixtures/models/, with one byte
// changed in the file named `damaged`.
function fakeFetch(damaged?: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const name = String(input).split('/').at(-1)!
    const bytes = fixture(`models/${name}`)
    if (name === damaged) bytes[0] ^= 0xff
    return new Response(bytes)
  }) as typeof fetch
}

// The separator's window sizes (docs/reference/models.md#htdemucs).
const X_LENGTH = 4 * 2048 * 336
const XT_LENGTH = 2 * 343_980

// Computes what the test separator file computes: each output holds four
// copies of its input, one per stem, each multiplied by 0.125.
function separatorStandIn(windows: { count: number }): SeparatorRunner {
  const stems = (input: Float32Array) => {
    const out = new Float32Array(input.length * 4)
    for (let stem = 0; stem < 4; stem++) {
      for (let i = 0; i < input.length; i++) out[stem * input.length + i] = input[i]! * 0.125
    }
    return out
  }
  return async (x, xt) => {
    expect(x.length).toBe(X_LENGTH)
    expect(xt.length).toBe(XT_LENGTH)
    windows.count++
    return { xOut: stems(x), xtOut: stems(xt), dispose() {} }
  }
}

// A stand-in aligner that gives every token the same probability in every
// frame, as in align-song.spec.ts: logits for Omnilingual, log probabilities
// for lyric-alignment.
function alignerStandIn(kind: AlignerKind, file: Uint8Array): ModelRunner {
  const vocabulary = readVocabulary(kind, file)!
  const tokens = vocabulary.tokens.length
  vocabulary.free()
  const value = kind === AlignerKind.Omnilingual ? 0 : Math.log(1 / tokens)
  return async (input) => new Float32Array((input.length / 320 - 1) * tokens).fill(value)
}

function fakeModels(o: { aligner: keyof typeof aligners; damaged?: string; windows: { count: number } }): SongModels {
  const files = new FakeModelFiles()
  return {
    load: (id) => loadModel(id, { files, fetch: fakeFetch(o.damaged), baseUri: 'http://lyre.test/' }),
    async openSeparator() {
      return { run: separatorStandIn(o.windows), release: async () => {} }
    },
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

async function run(o: { lyrics?: Uint8Array; aligner?: keyof typeof aligners; damaged?: string }): Promise<{
  reports: TaskReport[]
  areas: FakeWorkingAreas
  windows: { count: number }
  media: ReturnType<typeof fakeMedia>
}> {
  const aligner = aligners[o.aligner ?? 'omnilingual']
  const input: SongTaskInput = {
    source: new Blob([new Uint8Array(16)]),
    lyrics: o.lyrics ?? fixture('song/lyrics.txt'),
    details: { title: 'Test song', artist: 'Test artist', composer: '' },
    vocalRole: 'female',
    separator: { graph: 'test-htdemucs-graph', weights: 'test-htdemucs-weights' },
    aligner: { kind: aligner.kind, model: aligner.model, vocabulary: aligner.vocabulary },
  }
  const windows = { count: 0 }
  const media = fakeMedia()
  const models = fakeModels({ aligner: o.aligner ?? 'omnilingual', damaged: o.damaged, windows })
  const reports: TaskReport[] = []
  const areas = new FakeWorkingAreas()
  await runTask({ taskId, stages: songStages(input, media, models), areas, report: (report) => reports.push(report) })
  return { reports, areas, windows, media }
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
        const { reports, areas, media } = await run({ lyrics, aligner })

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
    'fails at alignment when a syllable has no character the vocabulary knows, and removes the working area',
    async () => {
      const { reports, areas } = await run({ lyrics: new TextEncoder().encode('Mưa rơi ♪ nhẹ\n') })
      expect(reports.at(-1)).toEqual({ type: 'failed', stage: 'align', reason: 'alignment-failed' })
      expect(reports.some((report) => report.type === 'done')).toBe(false)
      expect(areas.areas.has(taskId)).toBe(false)
    },
    TIMEOUT_MS,
  )

  test(
    'fails before separation when a model file fails its check, and hands over no song',
    async () => {
      const { reports, areas, windows } = await run({ damaged: 'htdemucs_fwd.onnx.data' })
      expect(reports.at(-1)).toEqual({ type: 'failed', stage: 'separate', reason: 'model-check-failed' })
      expect(windows.count).toBe(0)
      expect(reports.some((report) => report.type === 'done')).toBe(false)
      expect(areas.areas.has(taskId)).toBe(false)
    },
    TIMEOUT_MS,
  )
})
