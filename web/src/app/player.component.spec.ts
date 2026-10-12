import { provideZonelessChangeDetection } from '@angular/core'
import { ComponentFixture, TestBed } from '@angular/core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { SONG_FILE_OPENER } from '../core'
import { FakeLibraryStore } from '../fake-library-store'
import { OpenedSong, SongFileError } from '../song-file'
import { LIBRARY_STORE } from './library'
import { Player } from './player.component'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Renders the Player with `opener` and `store`, then chooses `file` in it.
async function chooseFile(
  opener: () => Promise<OpenedSong>,
  store = new FakeLibraryStore(),
  file = new File(['hello'], 'song.lyre'),
): Promise<HTMLElement> {
  return (await chooseFileIn(opener, store, file)).nativeElement as HTMLElement
}

async function chooseFileIn(
  opener: () => Promise<OpenedSong>,
  store: FakeLibraryStore,
  file: File,
): Promise<ComponentFixture<Player>> {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SONG_FILE_OPENER, useValue: () => opener() },
      { provide: LIBRARY_STORE, useValue: store },
    ],
  })
  const fixture = TestBed.createComponent(Player)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  const input = element.querySelector('input[type="file"]') as HTMLInputElement
  // jsdom has no DataTransfer to build a FileList, and the Player reads only the first file.
  Object.defineProperty(input, 'files', { value: [file] })
  input.dispatchEvent(new Event('change'))
  await fixture.whenStable()
  return fixture
}

// A song that opens but plays nothing. jsdom has no Media Source Extensions and
// no media playback, so the Player gets stand-ins that do nothing.
function openedSong(): OpenedSong {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.stubGlobal('MediaSource', class extends EventTarget {})
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL: () => 'blob:song', revokeObjectURL: () => undefined }),
  )
  return {
    songId: '00112233445566778899aabbccddeeff',
    details: { title: 'Mưa rơi nhẹ', artist: 'Lyre fixtures', composer: '' },
    durationMs: 1000,
    karaoke: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    original: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    read: () => Promise.reject(new Error('not read in these tests')),
    close: () => undefined,
  }
}

test('a file that is not a song file shows that, and no video', async () => {
  const element = await chooseFile(() => Promise.reject(new SongFileError('not-a-song-file')))
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe('This file is not a song file.')
  expect(element.querySelector('video')).toBeNull()
})

test('a damaged file shows that, and no video', async () => {
  const element = await chooseFile(() => Promise.reject(new SongFileError('damaged')))
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe('This song file is damaged or incomplete.')
  expect(element.querySelector('video')).toBeNull()
})

test('any other failure shows the damaged message, without its details', async () => {
  const element = await chooseFile(() => Promise.reject(new Error('secret details')))
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe('This song file is damaged or incomplete.')
  expect(element.textContent).not.toContain('secret details')
})

test('a song file that opens is kept in the library with its song ID and details', async () => {
  const store = new FakeLibraryStore()
  const file = new File(['song bytes'], 'song.lyre')
  const fixture = await chooseFileIn(() => Promise.resolve(openedSong()), store, file)
  await vi.waitFor(() => expect(store.songs.size).toBe(1))
  const kept = store.songs.get('00112233445566778899aabbccddeeff')
  expect(kept).toMatchObject({ title: 'Mưa rơi nhẹ', artist: 'Lyre fixtures', composer: '' })
  expect(kept?.file).toBe(file)

  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  const list = element.querySelector('ul[aria-label="Library"]')
  expect(list?.querySelector('button')?.textContent?.trim()).toBe('Mưa rơi nhẹ')
  expect(list?.textContent).toContain('Artist: Lyre fixtures')
  // An empty composer means not known, so it is not listed.
  expect(list?.textContent).not.toContain('Composer')
  // Stops the playback while the stand-ins are still in place.
  fixture.destroy()
})

test('a file that fails to open is not kept', async () => {
  const store = new FakeLibraryStore()
  const element = await chooseFile(() => Promise.reject(new SongFileError('damaged')), store)
  expect(store.songs.size).toBe(0)
  expect(element.querySelector('ul')).toBeNull()
})
