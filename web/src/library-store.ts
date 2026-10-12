// Keeps the song files opened on this device in the browser's IndexedDB, one
// record per song ID. The browser may clear this storage unless it grants
// persistent storage (docs/domain/knowledge.md#running-on-the-users-device).

// A kept song: its ID and details as the song file stores them, when it was
// last opened, in milliseconds since the epoch, and the file itself.
export interface KeptSong {
  songId: string
  title: string
  artist: string
  composer: string
  openedAt: number
  file: Blob
}

export interface LibraryStore {
  // The kept songs, the most recently opened first.
  list(): Promise<KeptSong[]>
  // Keeps `song`, replacing a kept song with the same song ID.
  keep(song: KeptSong): Promise<void>
  // Whether the browser has granted persistent storage.
  persisted(): Promise<boolean>
  // Asks the browser for persistent storage. Resolves whether it is granted.
  persist(): Promise<boolean>
}

const DATABASE = 'lyre'
const VERSION = 1
const SONGS = 'songs'

export function indexedDbStore(): LibraryStore {
  let database: Promise<IDBDatabase> | undefined
  // A failed open is tried again on the next call.
  const open = () =>
    (database ??= openDatabase().catch((error: unknown) => {
      database = undefined
      throw error
    }))
  return {
    async list() {
      const db = await open()
      const songs = await request<KeptSong[]>(db.transaction(SONGS).objectStore(SONGS).getAll())
      return songs.sort((a, b) => b.openedAt - a.openedAt)
    },
    async keep(song) {
      const db = await open()
      const transaction = db.transaction(SONGS, 'readwrite')
      transaction.objectStore(SONGS).put(song)
      await done(transaction)
    },
    async persisted() {
      return (await navigator.storage?.persisted?.()) ?? false
    },
    async persist() {
      return (await navigator.storage?.persist?.()) ?? false
    },
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available.'))
  const opening = indexedDB.open(DATABASE, VERSION)
  opening.onupgradeneeded = () => opening.result.createObjectStore(SONGS, { keyPath: 'songId' })
  return request(opening)
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('The storage request failed.'))
  })
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('The storage transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('The storage transaction was aborted.'))
  })
}
