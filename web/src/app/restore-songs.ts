import { InjectionToken, inject } from '@angular/core'
import { loadCore, SONG_FILE_OPENER } from '../core'
import { DeviceKey, RecoveryKey, RestoreFault, SongReader } from '../lyre-wasm/lyre_wasm.js'
import { ByteSource, DeviceAccess, OpenedSong } from '../song-file'
import { DEVICE_KEY } from './device-passkey'
import { Library } from './library'
import { keepRecoveryPublicKey, readRecoveryPublicKey } from './recovery-key'

// Restores songs on a new device (docs/ui-conventions.md#restoring-songs). The
// owner's recovery words go to the core, which makes an owner access file for
// this device from each song file's recovery wrap. Each restored song is kept
// in the library, like a song made on this device. The words and the keys stay
// in the core's handles. Nothing is logged, and no error's text is shown.

// The bytes every header start with: enough to tell the header's length.
const HEADER_START_LENGTH = 32

// What a restore ended with: the core refused the words, the device could not be
// unlocked, or each file was tried. `keptKey` is true when the restore kept the
// recovery public key on a device that had none.
export type RestoreOutcome =
  | { status: 'words-refused' }
  | { status: 'no-device' }
  | { status: 'done'; results: { name: string; restored: boolean }[]; keptKey: boolean }

export interface RestoreDeps {
  load: () => Promise<void>
  deviceKey: () => Promise<DeviceKey | undefined>
  openSong: (source: ByteSource, access?: DeviceAccess) => Promise<OpenedSong>
  library: Pick<Library, 'keep' | 'songs'>
}

// Restores the songs in `files` with the recovery `words`. The core checks the
// words first, before the device unlock and before any file is read.
export async function restoreSongs(words: string, files: readonly File[], deps: RestoreDeps): Promise<RestoreOutcome> {
  await deps.load()
  let key: RecoveryKey
  try {
    key = RecoveryKey.fromWords(words)
  } catch (error) {
    if (!(error instanceof RestoreFault)) throw error
    error.free()
    return { status: 'words-refused' }
  }
  try {
    const deviceKey = await deps.deviceKey()
    if (!deviceKey) return { status: 'no-device' }
    const results: { name: string; restored: boolean }[] = []
    for (const file of files) {
      let restored = false
      try {
        const start = new Uint8Array(await file.slice(0, HEADER_START_LENGTH).arrayBuffer())
        const length = SongReader.headerLength(start)
        const header = new Uint8Array(await file.slice(0, length).arrayBuffer())
        const access = key.restore(header, deviceKey)
        const song = await deps.openSong(file, {
          files: [new Blob([Uint8Array.from(access)])],
          key: async () => deviceKey,
        })
        try {
          await deps.library.keep(song, file)
          // The library swallows a storage error, so look for the song.
          restored = deps.library.songs().some((kept) => kept.songId === song.songId)
        } finally {
          song.close()
        }
      } catch {
        restored = false
      }
      results.push({ name: file.name, restored })
    }
    let keptKey = false
    if (results.some((result) => result.restored) && readRecoveryPublicKey() === undefined) {
      keptKey = (await keepRecoveryPublicKey(key.publicKey)) === 'kept'
    }
    return { status: 'done', results, keptKey }
  } finally {
    key.free()
  }
}

// The page gets the restorer by injection, so tests can replace it.
export const SONG_RESTORER = new InjectionToken<(words: string, files: readonly File[]) => Promise<RestoreOutcome>>(
  'SONG_RESTORER',
  {
    providedIn: 'root',
    factory: () => {
      const deps: RestoreDeps = {
        load: loadCore,
        deviceKey: inject(DEVICE_KEY),
        openSong: inject(SONG_FILE_OPENER),
        library: inject(Library),
      }
      return (words, files) => restoreSongs(words, files, deps)
    },
  },
)
