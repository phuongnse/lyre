import { provideZonelessChangeDetection } from '@angular/core'
import { ComponentFixture, TestBed } from '@angular/core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { SONG_FILE_OPENER } from '../core'
import { FakeLibraryStore } from '../fake-library-store'
import { ByteSource, DeviceAccess, OpenedSong, SongFileError } from '../song-file'
import { DEVICE_KEY } from './device-passkey'
import { LIBRARY_STORE } from './library'
import { Player } from './player.component'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Opener = (source: ByteSource, access?: DeviceAccess) => Promise<OpenedSong>

// Renders the Player with `opener` and `store`, then chooses `files` in it.
async function chooseFile(
  opener: Opener,
  store = new FakeLibraryStore(),
  files: File | File[] = new File(['hello'], 'song.lyre'),
): Promise<HTMLElement> {
  return (await chooseFileIn(opener, store, files)).nativeElement as HTMLElement
}

async function chooseFileIn(
  opener: Opener,
  store: FakeLibraryStore,
  files: File | File[],
): Promise<ComponentFixture<Player>> {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SONG_FILE_OPENER, useValue: opener },
      { provide: LIBRARY_STORE, useValue: store },
      { provide: DEVICE_KEY, useValue: () => Promise.resolve(undefined) },
    ],
  })
  const fixture = TestBed.createComponent(Player)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  const input = element.querySelector('input[type="file"]') as HTMLInputElement
  // jsdom has no DataTransfer to build a FileList.
  Object.defineProperty(input, 'files', { value: Array.isArray(files) ? files : [files] })
  input.dispatchEvent(new Event('change'))
  await fixture.whenStable()
  return fixture
}

// A song that opens but plays nothing. jsdom has no Media Source Extensions,
// no media playback and no ResizeObserver, so the Player gets stand-ins that do
// nothing. The stand-in MediaSource supports the types `supported` accepts.
function openedSong(supported: (type: string) => boolean = () => true): OpenedSong {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.stubGlobal(
    'MediaSource',
    class extends EventTarget {
      static isTypeSupported = supported
    },
  )
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL: () => 'blob:song', revokeObjectURL: () => undefined }),
  )
  return {
    songId: '00112233445566778899aabbccddeeff',
    details: { title: 'Mưa rơi nhẹ', artist: 'Lyre fixtures', composer: '', vocalRole: 'female' },
    durationMs: 1000,
    video: {
      type: 'video/webm; codecs="vp09.00.40.08"',
      init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 },
      segments: [],
    },
    karaoke: {
      type: 'audio/webm; codecs="opus"',
      init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 },
      segments: [],
    },
    original: {
      type: 'audio/mp4; codecs="mp4a.40.2"',
      init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 },
      segments: [],
    },
    lyrics: [],
    layOut: () => [],
    sweepPosition: () => 0,
    countdownLines: [],
    dotsSwept: () => 0,
    lyricsRows: () => ({ top: undefined, bottom: undefined }),
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
  expect(kept).not.toHaveProperty('vocalRole')
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

test('a song file made on the page is kept in the library as the same Blob', async () => {
  const store = new FakeLibraryStore()
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SONG_FILE_OPENER, useValue: () => Promise.resolve(openedSong()) },
      { provide: LIBRARY_STORE, useValue: store },
      { provide: DEVICE_KEY, useValue: () => Promise.resolve(undefined) },
    ],
  })
  const fixture = TestBed.createComponent(Player)
  await fixture.whenStable()
  const blob = new Blob(['song bytes'], { type: 'application/octet-stream' })
  await fixture.componentInstance.openMade(blob)
  await vi.waitFor(() => expect(store.songs.size).toBe(1))
  expect(store.songs.get('00112233445566778899aabbccddeeff')?.file).toBe(blob)
  // Stops the playback while the stand-ins are still in place.
  fixture.destroy()
})

test('a file that fails to open is not kept', async () => {
  const store = new FakeLibraryStore()
  const element = await chooseFile(() => Promise.reject(new SongFileError('damaged')), store)
  expect(store.songs.size).toBe(0)
  expect(element.querySelector('ul')).toBeNull()
})

test('a song whose original track cannot play here shows that, plays nothing and is not kept', async () => {
  const store = new FakeLibraryStore()
  const asked: string[] = []
  const song = openedSong((type) => {
    asked.push(type)
    return !type.startsWith('audio/mp4')
  })
  const close = vi.spyOn(song, 'close')
  const element = await chooseFile(() => Promise.resolve(song), store)
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
    "This device cannot play this song's original track.",
  )
  expect(asked).toEqual([song.video?.type, song.karaoke.type, song.original.type])
  expect(element.querySelector('video')).toBeNull()
  expect(element.querySelector('[aria-label="Track"]')).toBeNull()
  expect(close).toHaveBeenCalled()
  expect(store.songs.size).toBe(0)
})

test('a song whose video cannot play here names the video', async () => {
  const element = await chooseFile(() => Promise.resolve(openedSong((type) => !type.startsWith('video/'))))
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
    "This device cannot play this song's video.",
  )
  expect(element.querySelector('video')).toBeNull()
})

test('a song given through the input opens, is not kept, and the Player has no open button or library', async () => {
  const store = new FakeLibraryStore()
  const keep = vi.spyOn(store, 'keep')
  const song = openedSong()
  const opened: unknown[] = []
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: SONG_FILE_OPENER,
        useValue: (source: unknown) => {
          opened.push(source)
          return Promise.resolve(song)
        },
      },
      { provide: LIBRARY_STORE, useValue: store },
      { provide: DEVICE_KEY, useValue: () => Promise.resolve(undefined) },
    ],
  })
  const fixture = TestBed.createComponent(Player)
  const bytes = new Blob(['measured song'])
  fixture.componentRef.setInput('song', bytes)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  await vi.waitFor(() => expect(element.querySelector('video')).not.toBeNull())
  expect(opened).toEqual([bytes])
  expect(element.querySelector('[aria-label="Song video"]')).not.toBeNull()
  expect([...element.querySelectorAll('button')].map((button) => button.textContent?.trim())).not.toContain(
    'Open a song file',
  )
  expect(element.querySelector('input[type="file"]')).toBeNull()
  expect(element.querySelector('lyre-library')).toBeNull()
  await fixture.whenStable()
  expect(keep).not.toHaveBeenCalled()
  expect(store.songs.size).toBe(0)
  // Stops the playback while the stand-ins are still in place.
  fixture.destroy()
})

test('choosing a song file with an access file gives the opener only the .lyrekey file as an access file', async () => {
  const song = new File(['song bytes'], 'song.lyre')
  const access = new File(['access bytes'], 'device.LYREKEY')
  const calls: { source: ByteSource; access?: DeviceAccess }[] = []
  const fixture = await chooseFileIn(
    (source, access) => {
      calls.push({ source, access })
      return Promise.resolve(openedSong())
    },
    new FakeLibraryStore(),
    [access, song],
  )
  expect(calls).toHaveLength(1)
  expect(calls[0].source).toBe(song)
  expect(calls[0].access?.files).toEqual([access])
  // Stops the playback while the stand-ins are still in place.
  fixture.destroy()
})

test('a song the opener cannot open shows the cannot-open message, no video, and keeps nothing', async () => {
  const store = new FakeLibraryStore()
  const element = await chooseFile(() => Promise.reject(new SongFileError('cannot-open')), store)
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
    'This song cannot be opened on this device.',
  )
  expect(element.querySelector('video')).toBeNull()
  expect(element.querySelector('ul')).toBeNull()
  expect(store.songs.size).toBe(0)
})

test('the library keeps the access file that opened a song, and choosing it passes that file back', async () => {
  const store = new FakeLibraryStore()
  const access = new File(['access bytes'], 'device.lyrekey')
  const calls: (DeviceAccess | undefined)[] = []
  const fixture = await chooseFileIn(
    (_source, deviceAccess) => {
      calls.push(deviceAccess)
      return Promise.resolve({ ...openedSong(), accessFile: access })
    },
    store,
    [new File(['song bytes'], 'song.lyre'), access],
  )
  await vi.waitFor(() => expect(store.songs.size).toBe(1))
  expect(store.songs.get('00112233445566778899aabbccddeeff')?.accessFile).toBe(access)

  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  const button = element.querySelector('ul[aria-label="Library"] button') as HTMLButtonElement
  button.click()
  await vi.waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]?.files).toEqual([access])
  // Stops the playback while the stand-ins are still in place.
  fixture.destroy()
})
