// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { initSync } from './lyre-wasm/lyre_wasm.js'
import { readSource, SourceError, SourceFacts, sourceDetailsFrom } from './source'

// The stored types come from the WebAssembly core.
beforeAll(() => initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) }))

// A VP9 and Opus source, the codecs Playwright's Chromium plays.
function facts(overrides: Partial<SourceFacts> = {}): SourceFacts {
  return {
    audioTracks: 1,
    videoTracks: 1,
    firstTimestamp: 0,
    endTimestamp: 2,
    tags: {},
    videoCodec: { codec: 'vp9', parameters: 'vp09.00.10.08' },
    audioCodec: { codec: 'opus', parameters: 'opus' },
    ...overrides,
  }
}

const playsEverything = () => true

function problemOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof SourceError ? error.problem : 'other'
  }
  return undefined
}

test('a timeline that starts late gives its start offset, and a duration counted from zero', () => {
  const details = sourceDetailsFrom(facts({ firstTimestamp: 1.5, endTimestamp: 3.5 }), playsEverything)
  expect(details.startOffset).toBe(1.5)
  expect(details.duration).toBe(2)
})

test('a negative first timestamp from encoder priming is not a start offset', () => {
  const details = sourceDetailsFrom(facts({ firstTimestamp: -0.0065, endTimestamp: 2 }), playsEverything)
  expect(details.startOffset).toBe(0)
  expect(details.duration).toBe(2)
})

test('a source without audio is refused with no-audio', () => {
  expect(problemOf(() => sourceDetailsFrom(facts({ audioTracks: 0 }), playsEverything))).toBe('no-audio')
})

test('the streams say whether the source holds video', () => {
  expect(sourceDetailsFrom(facts(), playsEverything).hasVideo).toBe(true)
  expect(sourceDetailsFrom(facts({ videoTracks: 0 }), playsEverything).hasVideo).toBe(false)
})

test('tags are kept byte for byte', () => {
  // A decomposed "Hà" (NFD), two spaces and a precomposed "Nội" (NFC), with edge spaces.
  const artist = 'Hà  Nội '
  const title = ' Mưa rơi nhẹ'
  const details = sourceDetailsFrom(facts({ tags: { title, artist, raw: { '©wrt': 'Lê  Văn Thử' } } }), playsEverything)
  expect(details.title).toBe(title)
  expect(details.artist).toBe(artist)
  expect(details.composer).toBe('Lê  Văn Thử')
})

test('the composer comes from the raw tag of each container', () => {
  for (const key of ['©wrt', 'TCOM', 'COMPOSER']) {
    expect(sourceDetailsFrom(facts({ tags: { raw: { [key]: 'Lê Văn Thử' } } }), playsEverything).composer).toBe(
      'Lê Văn Thử',
    )
  }
})

test('a missing or empty tag, or a raw composer that is not text, is absent', () => {
  const details = sourceDetailsFrom(
    facts({ tags: { title: '', raw: { TCOM: new Uint8Array([65]) } } }),
    playsEverything,
  )
  expect(details).not.toHaveProperty('title')
  expect(details).not.toHaveProperty('artist')
  expect(details).not.toHaveProperty('composer')
})

test('a source this browser plays is not refused', () => {
  const asked: string[] = []
  const details = sourceDetailsFrom(facts(), (type) => {
    asked.push(type)
    return true
  })
  expect(details).not.toHaveProperty('cannotPlay')
  expect(asked).toEqual(['video/webm; codecs="vp09.00.10.08"', 'audio/webm; codecs="opus"'])
})

test('H.264 video this browser cannot play is refused, naming the video', () => {
  const source = facts({ videoCodec: { codec: 'avc', parameters: 'avc1.640028' } })
  const details = sourceDetailsFrom(source, (type) => !type.includes('avc1'))
  expect(details.cannotPlay).toEqual({ track: 'video', codec: 'avc' })
  // The details are still read.
  expect(details.duration).toBe(2)
})

test('FLAC audio is refused even when this browser says it can play it', () => {
  const details = sourceDetailsFrom(facts({ audioCodec: { codec: 'flac', parameters: 'flac' } }), playsEverything)
  expect(details.cannotPlay).toEqual({ track: 'audio', codec: 'flac' })
})

test('the video is named when neither track plays', () => {
  const details = sourceDetailsFrom(facts(), () => false)
  expect(details.cannotPlay).toEqual({ track: 'video', codec: 'vp9' })
})

test('a track whose codec Mediabunny does not know is refused', () => {
  const details = sourceDetailsFrom(facts({ audioCodec: { codec: null, parameters: null } }), playsEverything)
  expect(details.cannotPlay).toEqual({ track: 'audio', codec: null })
})

test('an audio-only source checks only its audio', () => {
  const details = sourceDetailsFrom(facts({ videoTracks: 0, videoCodec: null }), (type) => type.startsWith('audio/'))
  expect(details).not.toHaveProperty('cannotPlay')
})

test('a file that is not a readable source is refused with unreadable', async () => {
  const text = new Blob([new TextEncoder().encode('These are notes, not a song.\n')], { type: 'text/plain' })
  await expect(readSource(text)).rejects.toEqual(new SourceError('unreadable'))
  await expect(readSource(new Blob([]))).rejects.toEqual(new SourceError('unreadable'))
})
