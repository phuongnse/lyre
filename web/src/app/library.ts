import { Injectable, InjectionToken, inject, signal } from '@angular/core'
import { indexedDbStore, KeptSong, LibraryStore } from '../library-store'
import { OpenedSong } from '../song-file'

// Components get the library's storage by injection, so tests can replace it.
export const LIBRARY_STORE = new InjectionToken<LibraryStore>('LIBRARY_STORE', {
  providedIn: 'root',
  factory: indexedDbStore,
})

// The library: the songs opened on this device. Playback never depends on it,
// so a storage error leaves it as it was and is neither shown nor logged.
@Injectable({ providedIn: 'root' })
export class Library {
  private readonly store = inject(LIBRARY_STORE)
  private readonly songList = signal<KeptSong[]>([])
  private readonly mayBeClearedFlag = signal(false)
  // The kept songs, the most recently opened first.
  readonly songs = this.songList.asReadonly()
  // True when the library holds songs and the browser has not granted persistent storage.
  readonly mayBeCleared = this.mayBeClearedFlag.asReadonly()

  constructor() {
    // Only checks the storage on load. Asking for it waits until a song is kept.
    void this.update(async () => {
      const songs = await this.store.list()
      return { songs, mayBeCleared: songs.length > 0 && !(await this.store.persisted()) }
    })
  }

  // Keeps `file`, the song file `song` was opened from, then asks the browser
  // for persistent storage.
  keep(song: OpenedSong, file: Blob): Promise<void> {
    return this.update(async () => {
      const { title, artist, composer } = song.details
      await this.store.keep({ songId: song.songId, title, artist, composer, openedAt: Date.now(), file })
      const songs = await this.store.list()
      return { songs, mayBeCleared: !((await this.store.persisted()) || (await this.store.persist())) }
    })
  }

  // Sets the signals once `change` has read everything it needs.
  private async update(change: () => Promise<{ songs: KeptSong[]; mayBeCleared: boolean }>): Promise<void> {
    try {
      const { songs, mayBeCleared } = await change()
      this.songList.set(songs)
      this.mayBeClearedFlag.set(mayBeCleared)
    } catch {
      // Some browsers block IndexedDB, for example in private windows.
    }
  }
}
