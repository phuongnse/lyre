// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AlignerKind, checkTiming, initSync, readVocabulary, WindowFault } from '../lyre-wasm/lyre_wasm.js'
import { AlignmentProgress, alignSong, ModelRunner } from './align-song'
import { testAudio } from './test-audio'

const fixture = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${path}`, import.meta.url)))

const vocabularyFiles = {
  [AlignerKind.LyricAlignment]: 'models/lyric-alignment-vocab.json',
}

// A wav2vec2-style model gives 1,499 frames for 30 s of audio.
const WINDOW_FRAMES = 1_499
const WINDOW_SAMPLES = 480_000

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

function width(kind: AlignerKind, file: Uint8Array): number {
  const vocabulary = readVocabulary(kind, file)!
  const count = vocabulary.tokens.length
  vocabulary.free()
  return count
}

// A stand-in model that gives every token the same probability in every
// frame, as log probabilities.
function standIn(kind: AlignerKind, file: Uint8Array, frames = WINDOW_FRAMES): ModelRunner {
  const tokens = width(kind, file)
  const value = Math.log(1 / tokens)
  return async (input) => {
    expect(input.length).toBe(WINDOW_SAMPLES)
    return new Float32Array(frames * tokens).fill(value)
  }
}

for (const kind of [AlignerKind.LyricAlignment]) {
  describe(`alignment with ${AlignerKind[kind]}`, () => {
    const vocabularyFile = fixture(vocabularyFiles[kind])

    async function run(lyrics: Uint8Array, runModel = standIn(kind, vocabularyFile)) {
      const progress: AlignmentProgress[] = []
      const timing = await alignSong(testAudio(), lyrics, kind, vocabularyFile, runModel, (p) => progress.push(p))
      return { timing, progress }
    }

    test('times the fixture lyrics with a timing the core accepts', async () => {
      const lyrics = fixture('song/lyrics.txt')
      const { timing } = await run(lyrics)
      expect(timing).toHaveLength(9)
      const pairs = Uint32Array.from(timing.flatMap(({ startMs, endMs }) => [startMs, endMs]))
      expect(() => checkTiming(pairs, lyrics, 40_000)).not.toThrow()
    })

    test('reports the windows done out of the total', async () => {
      const { progress } = await run(fixture('song/lyrics.txt'))
      expect(progress).toEqual([
        { done: 0, total: 2 },
        { done: 1, total: 2 },
        { done: 2, total: 2 },
      ])
    })

    test('leaves the lyric bytes unchanged', async () => {
      const lyrics = fixture('song/lyrics.txt')
      await run(lyrics)
      expect(lyrics).toEqual(fixture('song/lyrics.txt'))
    })

    test('a window with too few frames rejects with the core fault naming it', async () => {
      let timing: unknown
      const fault = await run(fixture('song/lyrics.txt'), standIn(kind, vocabularyFile, 100)).then(
        (result) => {
          timing = result.timing
        },
        (error: unknown) => error,
      )
      expect(timing).toBeUndefined()
      expect(fault).toBeInstanceOf(WindowFault)
      expect((fault as WindowFault).window).toBe(0)
      ;(fault as WindowFault).free()
    })
  })
}
