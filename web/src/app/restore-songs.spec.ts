// @vitest-environment node
import { readFileSync } from 'node:fs'
import { signal } from '@angular/core'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { DeviceKey, initSync, NewRecoveryKey, RecoveryKey } from '../lyre-wasm/lyre_wasm.js'
import { openSongFile, OpenedSong } from '../song-file'
import { KeptSong } from '../library-store'
import { PieceSink, writeSong } from '../song-writer'
import { toBase64Url } from './device-passkey'
import { recoveryKeyStorageKey } from './recovery-key'
import { restoreSongs, RestoreDeps } from './restore-songs'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// Node has no localStorage and no Web Locks. These stand-ins keep the recovery public key.
const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => void stored.set(name, value),
  })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => unknown) => run() } })
})
afterEach(() => vi.unstubAllGlobals())

const track = (init: string) => ({
  startMs: 0,
  storedType: 'audio/webm; codecs="opus"',
  init: new TextEncoder().encode(init),
  segments: [{ durationMs: 1_000, bytes: new Uint8Array([1, 2]) }],
})

// A version-1 song file written for `device` and the recovery key `recovery`.
async function songFile(name: string, device: DeviceKey, recovery: Uint8Array, songId = 1): Promise<File> {
  const pieces: Uint8Array[] = []
  const out: PieceSink = { write: async (piece) => void pieces.push(piece.slice()) }
  await writeSong({
    songId: new Uint8Array(16).fill(songId),
    details: { title: 'Mưa', artist: '', composer: '', vocalRole: 'female' },
    lyrics: new TextEncoder().encode('Mưa rơi\n'),
    timesMs: Uint32Array.from([0, 500, 500, 1_000]),
    karaoke: track('ki'),
    original: track('oi'),
    video: null,
    thumbnail: null,
    out,
    encryptFor: { deviceCode: device.deviceCode, recoveryPublicKey: recovery },
  })
  return new File(pieces as BlobPart[], name)
}

function setup() {
  const device = new DeviceKey(new Uint8Array(32).fill(9))
  const kept: Record<string, OpenedSong> = {}
  const songs = signal<KeptSong[]>([])
  const opened: OpenedSong[] = []
  const deps: RestoreDeps = {
    load: async () => undefined,
    deviceKey: async () => device,
    openSong: async (source, access) => {
      const song = await openSongFile(source, access)
      opened.push(song)
      return song
    },
    library: {
      songs,
      keep: async (song, file) => {
        kept[song.songId] = song
        songs.update((list) => [...list, { songId: song.songId, title: song.details.title, file } as KeptSong])
      },
    },
  }
  return { device, deps, kept, songs, opened }
}

describe('restoring songs', () => {
  test('keeps each song that opens with the words, as an owner song, and the recovery public key', async () => {
    const { device, deps, kept } = setup()
    const recovery = new NewRecoveryKey()
    const first = await songFile('a.lyre', device, recovery.publicKey, 1)
    const second = await songFile('b.lyre', device, recovery.publicKey, 2)
    const outcome = await restoreSongs(recovery.words, [first, second], deps)
    expect(outcome).toEqual({
      status: 'done',
      results: [
        { name: 'a.lyre', restored: true },
        { name: 'b.lyre', restored: true },
      ],
      keptKey: true,
    })
    expect(Object.values(kept).every((song) => song.share !== undefined && song.accessFile !== undefined)).toBe(true)
    expect(stored.get(recoveryKeyStorageKey)).toBe(toBase64Url(recovery.publicKey))
  })

  test('reads the text of the QR code like the typed words', async () => {
    const { device, deps } = setup()
    const recovery = new NewRecoveryKey()
    const file = await songFile('a.lyre', device, recovery.publicKey)
    const outcome = await restoreSongs(recovery.words.toUpperCase(), [file], deps)
    expect(outcome).toMatchObject({ status: 'done', results: [{ restored: true }] })
  })

  test('lists a song of another recovery key as not restored and keeps nothing for it', async () => {
    const { device, deps, kept } = setup()
    const recovery = new NewRecoveryKey()
    const other = new NewRecoveryKey()
    const mine = await songFile('mine.lyre', device, recovery.publicKey, 1)
    const theirs = await songFile('theirs.lyre', device, other.publicKey, 2)
    const damaged = new File([new Uint8Array(10)], 'damaged.lyre')
    const outcome = await restoreSongs(recovery.words, [theirs, mine, damaged], deps)
    expect(outcome).toMatchObject({
      status: 'done',
      results: [
        { name: 'theirs.lyre', restored: false },
        { name: 'mine.lyre', restored: true },
        { name: 'damaged.lyre', restored: false },
      ],
    })
    expect(Object.keys(kept)).toHaveLength(1)
  })

  test('refuses words that are not a recovery key before it unlocks the device or reads a file', async () => {
    const { device, deps } = setup()
    const recovery = new NewRecoveryKey()
    const file = await songFile('a.lyre', device, recovery.publicKey)
    const unlock = vi.fn(deps.deviceKey)
    const slice = vi.spyOn(file, 'slice')
    const words = recovery.words.split(' ')
    words[3] = words[3] === 'abandon' ? 'ability' : 'abandon'
    for (const text of [words.join(' '), 'abandon', '']) {
      expect(await restoreSongs(text, [file], { ...deps, deviceKey: unlock })).toEqual({ status: 'words-refused' })
    }
    expect(unlock).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
    expect(stored.size).toBe(0)
  })

  test('restores nothing when the device is not unlocked', async () => {
    const { device, deps, kept } = setup()
    const recovery = new NewRecoveryKey()
    const file = await songFile('a.lyre', device, recovery.publicKey)
    const outcome = await restoreSongs(recovery.words, [file], { ...deps, deviceKey: async () => undefined })
    expect(outcome).toEqual({ status: 'no-device' })
    expect(kept).toEqual({})
    expect(stored.size).toBe(0)
  })

  test('never replaces a recovery public key that is already kept, and keeps none when no song restores', async () => {
    const { device, deps } = setup()
    const recovery = new NewRecoveryKey()
    const file = await songFile('a.lyre', device, recovery.publicKey)
    const stranger = await songFile('s.lyre', device, new NewRecoveryKey().publicKey)

    expect(await restoreSongs(recovery.words, [stranger], deps)).toMatchObject({ keptKey: false })
    expect(stored.size).toBe(0)

    stored.set(recoveryKeyStorageKey, toBase64Url(new NewRecoveryKey().publicKey))
    const before = stored.get(recoveryKeyStorageKey)
    expect(await restoreSongs(recovery.words, [file], deps)).toMatchObject({ keptKey: false })
    expect(stored.get(recoveryKeyStorageKey)).toBe(before)
  })

  test('does not count a song as restored when the library did not keep it', async () => {
    const { device, deps } = setup()
    const recovery = new NewRecoveryKey()
    const file = await songFile('a.lyre', device, recovery.publicKey)
    const outcome = await restoreSongs(recovery.words, [file], {
      ...deps,
      library: { songs: signal([]), keep: async () => undefined },
    })
    expect(outcome).toMatchObject({ results: [{ restored: false }], keptKey: false })
  })

  test('closes the songs it opened', async () => {
    const { device, deps, opened } = setup()
    const recovery = new NewRecoveryKey()
    const file = await songFile('a.lyre', device, recovery.publicKey)
    const closes: OpenedSong[] = []
    await restoreSongs(recovery.words, [file], {
      ...deps,
      openSong: async (source, access) => {
        const song = await deps.openSong(source, access)
        const close = song.close.bind(song)
        song.close = () => {
          closes.push(song)
          close()
        }
        return song
      },
    })
    expect(opened).toHaveLength(1)
    expect(closes).toEqual(opened)
  })

  test('the core handle shows only the public key, restore and fromWords', () => {
    expect(Object.getOwnPropertyNames(RecoveryKey.prototype).sort()).toEqual([
      '__destroy_into_raw',
      'constructor',
      'free',
      'publicKey',
      'restore',
    ])
    const recovery = new NewRecoveryKey()
    const key = RecoveryKey.fromWords(recovery.words)
    expect(Object.getOwnPropertyNames(key)).toEqual(['__wbg_ptr'])
    expect(key.publicKey).toEqual(recovery.publicKey)
    key.free()
  })
})
