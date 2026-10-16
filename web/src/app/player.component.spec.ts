import { provideZonelessChangeDetection } from '@angular/core'
import { ComponentFixture, TestBed } from '@angular/core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { SONG_FILE_OPENER } from '../core'
import { FakeLibraryStore } from '../fake-library-store'
import { ByteSource, DeviceAccess, OpenedSong, ShareError, SharedAccess, SongFileError } from '../song-file'
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

test('a song file made on the page opens with its access file and is kept in the library', async () => {
  const store = new FakeLibraryStore()
  const access = new Blob(['access bytes'], { type: 'application/octet-stream' })
  const calls: (DeviceAccess | undefined)[] = []
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: SONG_FILE_OPENER,
        useValue: (_source: ByteSource, deviceAccess?: DeviceAccess) => {
          calls.push(deviceAccess)
          return Promise.resolve({ ...openedSong(), accessFile: access })
        },
      },
      { provide: LIBRARY_STORE, useValue: store },
      { provide: DEVICE_KEY, useValue: () => Promise.resolve(undefined) },
    ],
  })
  const fixture = TestBed.createComponent(Player)
  await fixture.whenStable()
  const song = new Blob(['song bytes'], { type: 'application/octet-stream' })
  await fixture.componentInstance.openMade(song, access)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  expect(element.querySelector('[aria-label="Song video"]')).not.toBeNull()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.files).toEqual([access])
  await vi.waitFor(() => expect(store.songs.size).toBe(1))
  expect(store.songs.get('00112233445566778899aabbccddeeff')).toMatchObject({ file: song, accessFile: access })
  // Stops the playback while the stand-ins are still in place.
  fixture.destroy()
})

test('a chosen version-0 file shows the old-version message, no video, and keeps nothing', async () => {
  const store = new FakeLibraryStore()
  const element = await chooseFile(() => Promise.reject(new SongFileError('old-version')), store)
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
    'This song file is from an older version of Lyre and no longer plays.',
  )
  expect(element.querySelector('video')).toBeNull()
  expect(element.querySelector('ul')).toBeNull()
  expect(store.songs.size).toBe(0)
})

test('the library lists a song kept without an access file as no longer playing', async () => {
  const store = new FakeLibraryStore()
  const kept = (songId: string, accessFile?: Blob) => ({
    songId,
    title: songId,
    artist: '',
    composer: '',
    openedAt: Date.now(),
    file: new Blob(['song bytes']),
    accessFile,
  })
  store.songs.set('old', kept('old'))
  store.songs.set('current', kept('current', new Blob(['access bytes'])))
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SONG_FILE_OPENER, useValue: () => Promise.reject(new SongFileError('old-version')) },
      { provide: LIBRARY_STORE, useValue: store },
      { provide: DEVICE_KEY, useValue: () => Promise.resolve(undefined) },
    ],
  })
  const fixture = TestBed.createComponent(Player)
  await fixture.whenStable()
  await vi.waitFor(() => expect(fixture.nativeElement.querySelectorAll('ul[aria-label="Library"] li')).toHaveLength(2))
  const items = [...(fixture.nativeElement as HTMLElement).querySelectorAll('ul[aria-label="Library"] li')]
  const item = (title: string) => items.find((li) => li.querySelector('button')?.textContent?.trim() === title)
  expect(item('old')?.textContent).toContain('No longer plays')
  expect(item('current')?.textContent).not.toContain('No longer plays')

  item('old')?.querySelector('button')?.click()
  await fixture.whenStable()
  expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent?.trim()).toBe(
    'This song file is from an older version of Lyre and no longer plays.',
  )
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

test('a song given through the input with an access file opens with device access and is not kept', async () => {
  const store = new FakeLibraryStore()
  const keep = vi.spyOn(store, 'keep')
  const song = openedSong()
  const deviceKey = () => Promise.resolve(undefined)
  const calls: { source: ByteSource; access?: DeviceAccess }[] = []
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: SONG_FILE_OPENER,
        useValue: (source: ByteSource, access?: DeviceAccess) => {
          calls.push({ source, access })
          return Promise.resolve(song)
        },
      },
      { provide: LIBRARY_STORE, useValue: store },
      { provide: DEVICE_KEY, useValue: deviceKey },
    ],
  })
  const fixture = TestBed.createComponent(Player)
  const bytes = new Blob(['made song'])
  const accessBlob = new Blob(['made access'])
  fixture.componentRef.setInput('song', bytes)
  fixture.componentRef.setInput('access', accessBlob)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  await vi.waitFor(() => expect(element.querySelector('video')).not.toBeNull())
  expect(calls).toHaveLength(1)
  expect(calls[0].source).toBe(bytes)
  expect(calls[0].access?.files).toEqual([accessBlob])
  expect(calls[0].access?.key).toBe(deviceKey)
  expect([...element.querySelectorAll('button')].map((button) => button.textContent?.trim())).not.toContain(
    'Open a song file',
  )
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

const shareButton = (element: HTMLElement) =>
  [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Share')
const makeButton = (element: HTMLElement) =>
  [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Make the access file')

// Opens a song with `share`, then presses Share, types `code` and presses Make the access file.
async function shareWith(
  share: (deviceCode: string) => Promise<SharedAccess>,
  code: string,
): Promise<{ fixture: ComponentFixture<Player>; element: HTMLElement }> {
  const fixture = await chooseFileIn(() => Promise.resolve({ ...openedSong(), share }), new FakeLibraryStore(), [
    new File(['song'], 'song.lyre'),
  ])
  const element = fixture.nativeElement as HTMLElement
  await vi.waitFor(() => expect(shareButton(element)).toBeDefined())
  shareButton(element)?.click()
  await fixture.whenStable()
  const input = element.querySelector('input[matInput], input.mat-mdc-input-element') as HTMLInputElement
  input.value = code
  input.dispatchEvent(new Event('input'))
  makeButton(element)?.click()
  await fixture.whenStable()
  return { fixture, element }
}

test('a song opened with an owner access file offers Share, and one without it offers none', async () => {
  const owner = await chooseFileIn(
    () => Promise.resolve({ ...openedSong(), share: () => Promise.reject() }),
    new FakeLibraryStore(),
    [new File(['song'], 'song.lyre')],
  )
  const element = owner.nativeElement as HTMLElement
  await vi.waitFor(() => expect(shareButton(element)).toBeDefined())
  owner.destroy()
  TestBed.resetTestingModule()

  const recipient = await chooseFileIn(() => Promise.resolve(openedSong()), new FakeLibraryStore(), [
    new File(['song'], 'song.lyre'),
  ])
  const other = recipient.nativeElement as HTMLElement
  await vi.waitFor(() => expect(other.querySelector('video')).not.toBeNull())
  expect(shareButton(other)).toBeUndefined()
  recipient.destroy()
})

test('Share opens a form that says a share cannot be undone', async () => {
  const fixture = await chooseFileIn(
    () => Promise.resolve({ ...openedSong(), share: () => Promise.reject() }),
    new FakeLibraryStore(),
    [new File(['song'], 'song.lyre')],
  )
  const element = fixture.nativeElement as HTMLElement
  await vi.waitFor(() => expect(shareButton(element)).toBeDefined())
  shareButton(element)?.click()
  await fixture.whenStable()
  const section = element.querySelector('section[aria-labelledby="share-heading"]')
  expect(section?.querySelector('h2')?.textContent?.trim()).toBe('Share this song')
  expect(section?.textContent).toContain('A share cannot be undone. The device you share with keeps this song.')
  expect(section?.textContent).toContain('Device code')
  expect(makeButton(element)).toBeDefined()
  fixture.destroy()
})

test('an invalid device code shows one message, no fingerprint and no download link', async () => {
  const { fixture, element } = await shareWith(() => Promise.reject(new ShareError('invalid-code')), 'lyre1nope')
  const alerts = element.querySelectorAll('[role="alert"]')
  expect(alerts).toHaveLength(1)
  expect(alerts[0].textContent?.trim()).toBe('This is not a valid device code.')
  expect(element.textContent).not.toContain('Fingerprint')
  expect(element.querySelector('a[download]')).toBeNull()
  fixture.destroy()
})

test('a share the core could not make says so and offers no link', async () => {
  const { fixture, element } = await shareWith(() => Promise.reject(new ShareError('failed')), 'lyre1code')
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe('The access file could not be made.')
  expect(element.querySelector('a[download]')).toBeNull()
  fixture.destroy()
})

test('a valid device code shows its fingerprint, the compare line and a .lyrekey download', async () => {
  const share = vi.fn<(deviceCode: string) => Promise<SharedAccess>>(() =>
    Promise.resolve({ fingerprint: 'AB12 CD34', accessFile: new Blob(['access']) }),
  )
  const { fixture, element } = await shareWith(share, ' lyre1code ')
  expect(share).toHaveBeenCalledWith('lyre1code')
  expect(element.querySelector('[role="alert"]')).toBeNull()
  expect(element.querySelector('dd')?.textContent?.trim()).toBe('AB12 CD34')
  expect(element.textContent).toContain('Check that this fingerprint matches the one on the other device')
  const link = element.querySelector('a[download]') as HTMLAnchorElement
  expect(link.textContent?.trim()).toBe('Download the access file')
  expect(link.getAttribute('download')).toBe('Mưa rơi nhẹ.lyrekey')
  expect(link.getAttribute('href')).toBe('blob:song')
  fixture.destroy()
})
