// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { initSync } from './lyre-wasm/lyre_wasm.js'
import { ByteSource, ChunkRef, openSongFile, SongFileError, SongFileProblem } from './song-file'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// The known-answer example, read from the format doc's hex dump so the tests
// keep no second copy of its bytes.
function example(): Uint8Array<ArrayBuffer> {
  const doc = readFileSync(new URL('../../docs/reference/song-file-format-v0.md', import.meta.url), 'utf8')
  const dump = doc.split('### Hex dump')[1].split('```text\n')[1].split('```')[0]
  const hex = dump
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice(line.indexOf(': ') + 2).split('  ')[0])
    .join('')
    .replaceAll(' ', '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  expect(bytes.length).toBe(249)
  return bytes
}

// A source that records each range read from it, as [start, end).
function recording(blob: Blob): { source: ByteSource; ranges: [number, number][] } {
  const ranges: [number, number][] = []
  const source: ByteSource = {
    size: blob.size,
    slice(start, end) {
      ranges.push([start, end])
      return blob.slice(start, end)
    },
  }
  return { source, ranges }
}

async function problemOf(source: ByteSource): Promise<SongFileProblem | undefined> {
  try {
    ;(await openSongFile(source)).close()
    return undefined
  } catch (error) {
    if (error instanceof SongFileError) return error.problem
    throw error
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('opening the example reads the header, the index and single chunks, never the whole file', async () => {
  const file = example()
  const { source, ranges } = recording(new Blob([file]))
  const song = await openSongFile(source)
  expect(song.durationMs).toBe(1000)
  expect(song.video).toBeUndefined()

  const media: string[] = []
  for (const chunk of [song.karaoke.init, ...song.karaoke.segments]) media.push(text(await song.read(chunk)))
  song.close()
  expect(media).toEqual(['ki', 'ks'])

  // From the example's annotated bytes: the header, the index, the song
  // details, the lyrics, the timing, then the karaoke init and segment.
  expect(ranges).toEqual([
    [0, 32],
    [32, 200],
    [200, 211],
    [211, 221],
    [221, 241],
    [241, 243],
    [243, 245],
  ])
  expect(ranges).not.toContainEqual([0, file.length])
  // The original track's init and segment are at [245, 247) and [247, 249).
  for (const [start, end] of ranges) expect(end <= 245 || start >= 249).toBe(true)
})

test('the example gives its song ID and its details as stored', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.songId).toBe('000102030405060708090a0b0c0d0e0f')
  expect(song.details).toEqual({ title: 'Mưa', artist: '', composer: '', vocalRole: 'female' })
  song.close()
})

test('the example gives its lyrics as stored, with the timing of each syllable', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.lyrics).toEqual([
    { text: 'Mưa', separator: '', lyricLine: 0, startMs: 0, endMs: 500 },
    { text: 'rơi', separator: ' ', lyricLine: 0, startMs: 500, endMs: 1000 },
  ])
  song.close()
})

test('the core lays out the example and refuses a wrong width count', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.layOut([10, 10], 2, 100)).toEqual([{ lyricLine: 0, start: 0, end: 2 }])
  expect(song.layOut([10], 2, 100)).toEqual([])
  song.close()
  expect(song.layOut([10, 10], 2, 100)).toEqual([])
})

// scripts/test.sh builds the fixture song here with lyre-cli, because song files are never committed.
function fixtureSong(): Uint8Array<ArrayBuffer> {
  const url = new URL('../../artifacts/test/fixture.lyre', import.meta.url)
  if (!existsSync(url)) {
    throw new Error('artifacts/test/fixture.lyre is missing: run scripts/test.sh, which builds it.')
  }
  return new Uint8Array(readFileSync(url))
}

test('the rows of the fixture song follow the latest layout', async () => {
  const song = await openSongFile(new Blob([fixtureSong()]))
  expect(song.lyricsRows(1000)).toEqual({ top: undefined, bottom: undefined })
  expect(song.layOut(Array(9).fill(10), 2, 1000)).toHaveLength(3)
  expect(song.lyricsRows(1000)).toEqual({ top: 0, bottom: 1 })
  expect(song.lyricsRows(5000)).toEqual({ top: 2, bottom: undefined })
  song.close()
  expect(song.lyricsRows(1000)).toEqual({ top: undefined, bottom: undefined })
})

test('the sweep position follows the example timing', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.sweepPosition(0)).toBe(0)
  expect(song.sweepPosition(250)).toBe(0.5)
  expect(song.sweepPosition(1000)).toBe(2)
  song.close()
  expect(song.sweepPosition(250)).toBe(0)
})

test('the example has a countdown before its first lyric line', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.countdownLines).toEqual([0])
  expect(song.dotsSwept(0)).toBe(4)
  song.close()
  expect(song.dotsSwept(0)).toBe(0)
})

test('the karaoke track lists its chunks with their times', async () => {
  const song = await openSongFile(new Blob([example()]))
  const ref = (position: number, offset: number, startMs: number, durationMs: number): ChunkRef => ({
    position,
    offset,
    length: 2,
    startMs,
    durationMs,
  })
  expect(song.karaoke.init).toMatchObject(ref(3, 241, 0, 0))
  expect(song.karaoke.segments).toHaveLength(1)
  expect(song.karaoke.segments[0]).toMatchObject(ref(4, 243, 0, 1000))
  song.close()
})

test('the original track lists its chunks with their times', async () => {
  const song = await openSongFile(new Blob([example()]))
  const ref = (position: number, offset: number, startMs: number, durationMs: number): ChunkRef => ({
    position,
    offset,
    length: 2,
    startMs,
    durationMs,
  })
  expect(song.original.init).toMatchObject(ref(5, 245, 0, 0))
  expect(song.original.segments).toHaveLength(1)
  expect(song.original.segments[0]).toMatchObject(ref(6, 247, 0, 1000))
  song.close()
})

test('a small text file is not a song file', async () => {
  expect(await problemOf(new Blob(['hello']))).toBe('not-a-song-file')
})

test('a file with the wrong magic is not a song file', async () => {
  const file = example()
  file[0] = 0x88
  expect(await problemOf(new Blob([file]))).toBe('not-a-song-file')
})

test('the example without its last byte is damaged', async () => {
  expect(await problemOf(new Blob([example().slice(0, 248)]))).toBe('damaged')
})

test('a file that ends inside its index is damaged', async () => {
  expect(await problemOf(new Blob([example().slice(0, 100)]))).toBe('damaged')
})

test('a timing that does not match the lyrics is damaged', async () => {
  const file = example()
  file[221] = 0x03
  expect(await problemOf(new Blob([file]))).toBe('damaged')
})

test('a source that fails to read is damaged', async () => {
  const failing: ByteSource = {
    size: 249,
    slice: () => ({ arrayBuffer: () => Promise.reject(new Error('read failed')) }) as unknown as Blob,
  }
  expect(await problemOf(failing)).toBe('damaged')
})
