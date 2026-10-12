import { provideZonelessChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { expect, test } from 'vitest'
import { FakeLibraryStore } from '../fake-library-store'
import { OpenedSong } from '../song-file'
import { Library, LIBRARY_STORE } from './library'

function library(store: FakeLibraryStore): Library {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: LIBRARY_STORE, useValue: store }],
  })
  return TestBed.inject(Library)
}

function song(songId: string, title: string): OpenedSong {
  return {
    songId,
    details: { title, artist: 'An artist', composer: '' },
    durationMs: 1000,
    karaoke: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    original: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    read: () => Promise.reject(new Error('not read in these tests')),
    close: () => undefined,
  }
}

test('keeping the same song twice lists it once, with the details of the last file', async () => {
  const kept = library(new FakeLibraryStore())
  await kept.keep(song('00112233445566778899aabbccddeeff', 'First name'), new Blob(['one']))
  await kept.keep(song('00112233445566778899aabbccddeeff', 'Second name'), new Blob(['two']))
  expect(kept.songs().map((entry) => [entry.songId, entry.title])).toEqual([
    ['00112233445566778899aabbccddeeff', 'Second name'],
  ])
})

test('the songs may be cleared when the browser refuses persistent storage', async () => {
  const kept = library(new FakeLibraryStore(false))
  await kept.keep(song('00112233445566778899aabbccddeeff', 'Mưa'), new Blob(['one']))
  expect(kept.mayBeCleared()).toBe(true)
})

test('the songs are not said to be cleared when the browser grants persistent storage', async () => {
  const kept = library(new FakeLibraryStore(true))
  await kept.keep(song('00112233445566778899aabbccddeeff', 'Mưa'), new Blob(['one']))
  expect(kept.mayBeCleared()).toBe(false)
})

test('a store that fails leaves the library empty, and keeping does not throw', async () => {
  const store = new FakeLibraryStore()
  store.keep = () => Promise.reject(new Error('IndexedDB is blocked'))
  const kept = library(store)
  await expect(kept.keep(song('00112233445566778899aabbccddeeff', 'Mưa'), new Blob(['one']))).resolves.toBeUndefined()
  expect(kept.songs()).toEqual([])
  expect(kept.mayBeCleared()).toBe(false)
})
