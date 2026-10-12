import { KeptSong, LibraryStore } from './library-store'

// An in-memory library store for tests. `granted` is what the browser answers
// about persistent storage.
export class FakeLibraryStore implements LibraryStore {
  readonly songs = new Map<string, KeptSong>()

  constructor(private readonly granted = true) {}

  async list(): Promise<KeptSong[]> {
    return [...this.songs.values()].sort((a, b) => b.openedAt - a.openedAt)
  }

  async keep(song: KeptSong): Promise<void> {
    this.songs.set(song.songId, song)
  }

  async persisted(): Promise<boolean> {
    return this.granted
  }

  async persist(): Promise<boolean> {
    return this.granted
  }
}
