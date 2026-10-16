// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, expect, test, vi } from 'vitest'
import { DeviceKey, initSync } from './lyre-wasm/lyre_wasm.js'
import {
  ByteSource,
  ChunkRef,
  DeviceAccess,
  openSongFile,
  ShareError,
  SongFileError,
  SongFileProblem,
} from './song-file'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return bytes
}

// The bytes of the `xxd` dump under the doc's "Hex dump" heading.
function xxdDump(file: string): Uint8Array<ArrayBuffer> {
  const doc = readFileSync(new URL(`../../docs/reference/${file}`, import.meta.url), 'utf8')
  const dump = doc.split('### Hex dump')[1].split('```text\n')[1].split('```')[0]
  return fromHex(
    dump
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(line.indexOf(': ') + 2).split('  ')[0])
      .join('')
      .replaceAll(' ', ''),
  )
}

// The known-answer example, read from the format doc's hex dump so the tests
// keep no second copy of its bytes.
function example(): Uint8Array<ArrayBuffer> {
  const bytes = xxdDump('song-file-format-v0.md')
  expect(bytes.length).toBe(307)
  return bytes
}

// The version-1 known-answer example, read the same way.
function exampleV1(): Uint8Array<ArrayBuffer> {
  const bytes = xxdDump('song-file-format-v1.md')
  expect(bytes.length).toBe(580)
  return bytes
}

// The device-access vector's access file for the version-1 example, read from
// the doc's hex block.
function vectorAccessFile(): Uint8Array<ArrayBuffer> {
  const doc = readFileSync(new URL('../../docs/reference/device-access.md', import.meta.url), 'utf8')
  const hex = doc.split('The whole 179-byte access file')[1].split('```text\n')[1].split('```')[0]
  const bytes = fromHex(hex.replaceAll('\n', ''))
  expect(bytes.length).toBe(179)
  return bytes
}

// The vector's device key: PRF output 0..31.
const vectorKey = () => new DeviceKey(Uint8Array.from({ length: 32 }, (_, i) => i))

// The access file with one byte of its entry changed, so it no longer opens.
function changedAccessFile(): Uint8Array<ArrayBuffer> {
  const bytes = vectorAccessFile()
  bytes[bytes.length - 1] ^= 1
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

async function problemOf(source: ByteSource, access?: DeviceAccess): Promise<SongFileProblem | undefined> {
  try {
    ;(await openSongFile(source, access)).close()
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
  // details, the lyrics, the timing, the karaoke init and the original init
  // when opening, then the karaoke init and segment when playing.
  expect(ranges).toEqual([
    [0, 32],
    [32, 200],
    [200, 211],
    [211, 221],
    [221, 241],
    [241, 270],
    [272, 305],
    [241, 270],
    [270, 272],
  ])
  expect(ranges).not.toContainEqual([0, file.length])
  // The original track's segment is at [305, 307).
  for (const [, end] of ranges) expect(end).toBeLessThanOrEqual(305)
})

test('each track gives the type its song file stores', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.karaoke.type).toBe('audio/webm; codecs="opus"')
  expect(song.original.type).toBe('audio/mp4; codecs="mp4a.40.2"')
  song.close()
})

test('the fixture song gives the types of its video and audio tracks', async () => {
  const song = await openSongFile(new Blob([fixtureSong()]))
  expect(song.video?.type).toBe('video/webm; codecs="vp09.00.40.08"')
  expect(song.karaoke.type).toBe('audio/webm; codecs="opus"')
  expect(song.original.type).toBe('audio/webm; codecs="opus"')
  song.close()
})

test('the original init is read for its type, and gives its container init bytes when read again', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(text(await song.read(song.original.init))).toBe('oi')
  expect(text(await song.read(song.original.segments[0]))).toBe('os')
  song.close()
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
  expect(song.lyricsRows(6000)).toEqual({ top: 2, bottom: undefined })
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

const ref = (position: number, offset: number, length: number, startMs: number, durationMs: number): ChunkRef => ({
  position,
  offset,
  length,
  startMs,
  durationMs,
})

test('the karaoke track lists its chunks with their times', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.karaoke.init).toMatchObject(ref(3, 241, 29, 0, 0))
  expect(song.karaoke.segments).toHaveLength(1)
  expect(song.karaoke.segments[0]).toMatchObject(ref(4, 270, 2, 0, 1000))
  song.close()
})

test('the original track lists its chunks with their times', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.original.init).toMatchObject(ref(5, 272, 33, 0, 0))
  expect(song.original.segments).toHaveLength(1)
  expect(song.original.segments[0]).toMatchObject(ref(6, 305, 2, 0, 1000))
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
  expect(await problemOf(new Blob([example().slice(0, 306)]))).toBe('damaged')
})

test('a file that ends inside its index is damaged', async () => {
  expect(await problemOf(new Blob([example().slice(0, 100)]))).toBe('damaged')
})

test('a timing that does not match the lyrics is damaged', async () => {
  const file = example()
  file[221] = 0x03
  expect(await problemOf(new Blob([file]))).toBe('damaged')
})

test('a karaoke type other than Opus in WebM is damaged', async () => {
  const file = example()
  file[243] = 0x41
  expect(await problemOf(new Blob([file]))).toBe('damaged')
})

test('an original type in the wrong container is damaged, though its segments are not read', async () => {
  const file = example()
  // Byte 274 starts the original track's type: 'audio/mp4' becomes 'video/mp4'.
  file.set(new TextEncoder().encode('video'), 274)
  expect(await problemOf(new Blob([file]))).toBe('damaged')
})

test('a source that fails to read is damaged', async () => {
  const failing: ByteSource = {
    size: 307,
    slice: () => ({ arrayBuffer: () => Promise.reject(new Error('read failed')) }) as unknown as Blob,
  }
  expect(await problemOf(failing)).toBe('damaged')
})

test('a version-1 file opens with the vector access file after a changed one, and gives the one that opened it', async () => {
  const key = vectorKey()
  const changed = new Blob([changedAccessFile()])
  const vector = new Blob([vectorAccessFile()])
  const access: DeviceAccess = { files: [changed, vector], key: () => Promise.resolve(key) }
  const song = await openSongFile(new Blob([exampleV1()]), access)
  expect(song.accessFile).toBe(vector)
  expect(song.songId).toBe('000102030405060708090a0b0c0d0e0f')
  expect(song.details.title).toBe('Mưa')
  expect(text(await song.read(song.karaoke.init))).toBe('ki')
  song.close()
  key.free()
})

test('a song opened with an owner access file shares with another device, which opens it without share', async () => {
  const key = vectorKey()
  const other = new DeviceKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
  const song = await openSongFile(new Blob([exampleV1()]), {
    files: [new Blob([vectorAccessFile()])],
    key: () => Promise.resolve(key),
  })
  expect(song.share).toBeDefined()
  const shared = await song.share!(other.deviceCode)
  expect(shared.fingerprint).toBe(other.fingerprint)

  const recipient = await openSongFile(new Blob([exampleV1()]), {
    files: [shared.accessFile],
    key: () => Promise.resolve(other),
  })
  expect(recipient.songId).toBe(song.songId)
  expect(recipient.share).toBeUndefined()
  expect(
    await problemOf(new Blob([exampleV1()]), { files: [shared.accessFile], key: () => Promise.resolve(key) }),
  ).toBe('cannot-open')
  recipient.close()
  song.close()
  other.free()
  key.free()
})

test('sharing with a changed device code rejects as invalid-code, and after close as failed', async () => {
  const key = vectorKey()
  const other = new DeviceKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
  const song = await openSongFile(new Blob([exampleV1()]), {
    files: [new Blob([vectorAccessFile()])],
    key: () => Promise.resolve(key),
  })
  const code = other.deviceCode
  const changed = code.slice(0, -1) + (code.endsWith('q') ? 'p' : 'q')
  await expect(song.share!(changed)).rejects.toBeInstanceOf(ShareError)
  await expect(song.share!(changed)).rejects.toMatchObject({ problem: 'invalid-code' })
  await expect(song.share!('')).rejects.toMatchObject({ problem: 'invalid-code' })
  song.close()
  await expect(song.share!(code)).rejects.toMatchObject({ problem: 'failed' })
  other.free()
  key.free()
})

test('a version-0 song has no share', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.share).toBeUndefined()
  song.close()
})

test('a version-1 file is refused as cannot-open when no chosen access file opens it', async () => {
  const key = vectorKey()
  const song = new Blob([exampleV1()])
  const keyOf = () => Promise.resolve(key)
  const changed = new Blob([changedAccessFile()])
  expect(await problemOf(song, { files: [changed], key: keyOf })).toBe('cannot-open')
  expect(await problemOf(song, { files: [changed, new Blob([new Uint8Array(179)])], key: keyOf })).toBe('cannot-open')
  expect(await problemOf(song, undefined)).toBe('cannot-open')
  key.free()
})

test('a version-1 file with no access file is refused before the device is asked for its key', async () => {
  const key = vi.fn(() => Promise.resolve(undefined))
  await expect(openSongFile(new Blob([exampleV1()]), { files: [], key })).rejects.toMatchObject({
    problem: 'cannot-open',
  })
  expect(key).not.toHaveBeenCalled()
})

test('a version-1 file is refused as cannot-open for another device and when the device is not unlocked', async () => {
  const other = new DeviceKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
  const files = [new Blob([vectorAccessFile()])]
  expect(await problemOf(new Blob([exampleV1()]), { files, key: () => Promise.resolve(other) })).toBe('cannot-open')
  expect(await problemOf(new Blob([exampleV1()]), { files, key: () => Promise.resolve(undefined) })).toBe('cannot-open')
  other.free()
})

test('a version-1 file with one index byte changed is refused as cannot-open', async () => {
  const key = vectorKey()
  const bytes = exampleV1()
  bytes[177] ^= 1
  const files = [new Blob([vectorAccessFile()])]
  expect(await problemOf(new Blob([bytes]), { files, key: () => Promise.resolve(key) })).toBe('cannot-open')
  key.free()
})

test('a version-1 file cut short inside its header or its index is refused as cannot-open', async () => {
  const key = vectorKey()
  const files = [new Blob([vectorAccessFile()])]
  const access = { files, key: () => Promise.resolve(key) }
  expect(await problemOf(new Blob([exampleV1().slice(0, 200)]), access)).toBe('cannot-open')
  expect(await problemOf(new Blob([exampleV1().slice(0, 100)]), access)).toBe('cannot-open')
  key.free()
})

test('a version-0 file is refused as old-version when opened with device access, without asking for the key', async () => {
  const key = vi.fn(() => Promise.resolve(undefined))
  await expect(
    openSongFile(new Blob([example()]), { files: [new Blob([vectorAccessFile()])], key }),
  ).rejects.toMatchObject({ problem: 'old-version' })
  await expect(openSongFile(new Blob([example()]), { files: [], key })).rejects.toMatchObject({
    problem: 'old-version',
  })
  expect(key).not.toHaveBeenCalled()
})

test('a version-0 file still opens without device access, as a song made on the page does', async () => {
  const song = await openSongFile(new Blob([example()]))
  expect(song.accessFile).toBeUndefined()
  expect(song.details.title).toBe('Mưa')
  song.close()
})
