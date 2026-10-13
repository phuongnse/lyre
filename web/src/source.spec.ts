// @vitest-environment node
import { expect, test } from 'vitest'
import { readSource, SourceError, SourceFacts, sourceDetailsFrom } from './source'

function facts(overrides: Partial<SourceFacts> = {}): SourceFacts {
  return { audioTracks: 1, videoTracks: 1, firstTimestamp: 0, endTimestamp: 2, tags: {}, ...overrides }
}

function problemOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof SourceError ? error.problem : 'other'
  }
  return undefined
}

test('a timeline that starts late gives its start offset, and a duration counted from zero', () => {
  const details = sourceDetailsFrom(facts({ firstTimestamp: 1.5, endTimestamp: 3.5 }))
  expect(details.startOffset).toBe(1.5)
  expect(details.duration).toBe(2)
})

test('a negative first timestamp from encoder priming is not a start offset', () => {
  const details = sourceDetailsFrom(facts({ firstTimestamp: -0.0065, endTimestamp: 2 }))
  expect(details.startOffset).toBe(0)
  expect(details.duration).toBe(2)
})

test('a source without audio is refused with no-audio', () => {
  expect(problemOf(() => sourceDetailsFrom(facts({ audioTracks: 0 })))).toBe('no-audio')
})

test('the streams say whether the source holds video', () => {
  expect(sourceDetailsFrom(facts()).hasVideo).toBe(true)
  expect(sourceDetailsFrom(facts({ videoTracks: 0 })).hasVideo).toBe(false)
})

test('tags are kept byte for byte', () => {
  // A decomposed "Hà" (NFD), two spaces and a precomposed "Nội" (NFC), with edge spaces.
  const artist = 'Hà  Nội '
  const title = ' Mưa rơi nhẹ'
  const details = sourceDetailsFrom(facts({ tags: { title, artist, raw: { '©wrt': 'Lê  Văn Thử' } } }))
  expect(details.title).toBe(title)
  expect(details.artist).toBe(artist)
  expect(details.composer).toBe('Lê  Văn Thử')
})

test('the composer comes from the raw tag of each container', () => {
  for (const key of ['©wrt', 'TCOM', 'COMPOSER']) {
    expect(sourceDetailsFrom(facts({ tags: { raw: { [key]: 'Lê Văn Thử' } } })).composer).toBe('Lê Văn Thử')
  }
})

test('a missing or empty tag, or a raw composer that is not text, is absent', () => {
  const details = sourceDetailsFrom(facts({ tags: { title: '', raw: { TCOM: new Uint8Array([65]) } } }))
  expect(details).not.toHaveProperty('title')
  expect(details).not.toHaveProperty('artist')
  expect(details).not.toHaveProperty('composer')
})

test('a file that is not a readable source is refused with unreadable', async () => {
  const text = new Blob([new TextEncoder().encode('These are notes, not a song.\n')], { type: 'text/plain' })
  await expect(readSource(text)).rejects.toEqual(new SourceError('unreadable'))
  await expect(readSource(new Blob([]))).rejects.toEqual(new SourceError('unreadable'))
})
