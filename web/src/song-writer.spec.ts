// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { initSync, SongReader } from './lyre-wasm/lyre_wasm.js'
import { PackagedTrack } from './original-track'
import { openSongFile } from './song-file'
import { PieceSink, SONG_FILE, SongRefused, writeSong } from './song-writer'
import { FakeWorkingAreas } from './task/fake-working-areas'

const KARAOKE_TYPE = 'audio/webm; codecs="opus"'
const ORIGINAL_TYPE = 'audio/mp4; codecs="mp4a.40.2"'
const SEGMENT_BYTES = 1_048_576
const SEGMENTS = 64
const MiB = 1_048_576

let memory: WebAssembly.Memory

beforeAll(() => {
  memory = initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) }).memory
})

// A track of `count` segments of 1,000 ms that share one buffer.
function track(storedType: string, init: string, count: number, bytes: Uint8Array): PackagedTrack {
  return {
    startMs: 0,
    storedType,
    init: new TextEncoder().encode(init),
    segments: Array.from({ length: count }, () => ({ durationMs: 1_000, bytes })),
  }
}

const song = (karaoke: PackagedTrack, original: PackagedTrack, timesMs: number[]) => ({
  songId: new Uint8Array(16).map((_, i) => i),
  details: { title: 'Mưa', artist: '', composer: '', vocalRole: 'female' as const },
  lyrics: new TextEncoder().encode('Mưa rơi\n'),
  timesMs: Uint32Array.from(timesMs),
  karaoke,
  original,
  video: null,
  thumbnail: null,
})

describe('writing a song file in pieces', () => {
  test('holds at most one media segment in WebAssembly memory and gives the whole indexed file', async () => {
    const bytes = new Uint8Array(SEGMENT_BYTES).fill(7)
    const before = memory.buffer.byteLength
    let head: Uint8Array | undefined
    let total = 0
    const out: PieceSink = {
      async write(piece) {
        head ??= piece.slice()
        total += piece.length
      },
    }
    await writeSong({
      ...song(track(KARAOKE_TYPE, 'ki', SEGMENTS, bytes), track(ORIGINAL_TYPE, 'oi', SEGMENTS, bytes), [
        0,
        500,
        500,
        SEGMENTS * 1_000,
      ]),
      out,
    })

    // 128 MiB of segments went through, and the memory grew by far less.
    expect(memory.buffer.byteLength - before).toBeLessThan(4 * MiB)
    // The pieces add up to the file size the index holds: the last chunk's end.
    const header = head!.subarray(0, 32)
    const index = head!.subarray(32, 32 + SongReader.indexLength(header))
    const reader = new SongReader(header, index, total)
    try {
      const entries = reader.entries()
      const last = entries.at(-1)!
      expect(last.offset + last.length).toBe(total)
      expect(total).toBeGreaterThan(2 * SEGMENTS * SEGMENT_BYTES)
      for (const entry of entries) entry.free()
    } finally {
      reader.free()
    }
  })

  test('written into a working file, gives a song file that opens', async () => {
    const areas = new FakeWorkingAreas()
    const area = await areas.create('task')
    const file = await area.open(SONG_FILE)
    const bytes = new Uint8Array([1, 2])
    await writeSong({
      ...song(track(KARAOKE_TYPE, 'ki', 1, bytes), track(ORIGINAL_TYPE, 'oi', 1, bytes), [0, 500, 500, 1_000]),
      out: file,
    })
    await file.close()

    const opened = await openSongFile(await area.read(SONG_FILE))
    expect(opened.details).toEqual({ title: 'Mưa', artist: '', composer: '', vocalRole: 'female' })
    opened.close()
  })

  test('refuses a timing that ends after the song before it gives any piece', async () => {
    const bytes = new Uint8Array([1, 2])
    const pieces: Uint8Array[] = []
    const refusal = writeSong({
      ...song(track(KARAOKE_TYPE, 'ki', 1, bytes), track(ORIGINAL_TYPE, 'oi', 1, bytes), [0, 500, 500, 1_500]),
      out: { write: async (piece) => void pieces.push(piece) },
    })
    await expect(refusal).rejects.toEqual(new SongRefused('past-end'))
    expect(pieces).toEqual([])
  })
})
