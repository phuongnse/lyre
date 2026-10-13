import { afterEach, expect, test, vi } from 'vitest'
import { ChunkRef, MediaTrack, OpenedSong } from '../song-file'
import { playSong, unplayableMedia } from './media-source-playback'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const OPUS = 'audio/webm; codecs="opus"'
const AAC = 'audio/mp4; codecs="mp4a.40.2"'

// A SourceBuffer that records what is done to it, and finishes each update on
// a later task, as a browser does.
class FakeSourceBuffer extends EventTarget {
  updating = false
  readonly calls: string[] = []

  appendBuffer(bytes: Uint8Array): void {
    this.update(`append ${new TextDecoder().decode(bytes)}`)
  }

  remove(): void {
    this.update('remove')
  }

  changeType(type: string): void {
    if (this.updating) throw new DOMException('The buffer is updating.', 'InvalidStateError')
    this.calls.push(`changeType ${type}`)
  }

  private update(call: string): void {
    if (this.updating) throw new DOMException('The buffer is updating.', 'InvalidStateError')
    this.calls.push(call)
    this.updating = true
    setTimeout(() => {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    })
  }
}

// A MediaSource that opens when the test says so, with buffers of the types
// it is given.
class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource
  readyState = 'open'
  duration = 0
  readonly types: string[] = []
  readonly buffer = new FakeSourceBuffer()

  constructor() {
    super()
    FakeMediaSource.last = this
  }

  addSourceBuffer(type: string): FakeSourceBuffer {
    this.types.push(type)
    return this.buffer
  }

  endOfStream(): void {}
}

function chunk(position: number, durationMs = 0): ChunkRef {
  return { position, offset: 0, length: 0, startMs: 0, durationMs }
}

function track(type: string, init: number): MediaTrack {
  return { type, init: chunk(init), segments: [chunk(init + 1, 1000)] }
}

// A song with no video, a karaoke track of Opus in WebM and an original track
// of `originalType`. Reading a chunk gives its name.
function song(originalType: string): OpenedSong {
  const names = ['ki', 'ks', 'oi', 'os']
  return {
    songId: '00112233445566778899aabbccddeeff',
    details: { title: 'Mưa', artist: '', composer: '', vocalRole: 'female' },
    durationMs: 1000,
    karaoke: track(OPUS, 0),
    original: track(originalType, 2),
    lyrics: [],
    layOut: () => [],
    sweepPosition: () => 0,
    countdownLines: [],
    dotsSwept: () => 0,
    lyricsRows: () => ({ top: undefined, bottom: undefined }),
    read: (ref) => Promise.resolve(new TextEncoder().encode(names[ref.position])),
    close: () => undefined,
  }
}

// Starts playing `opened` on Karaoke with a fake MediaSource, and waits until
// the karaoke track is appended.
async function playKaraoke(
  opened: OpenedSong,
): Promise<{ switchAudio(track: MediaTrack): void; source: FakeMediaSource }> {
  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL: () => 'blob:song', revokeObjectURL: () => undefined }),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  const onError = vi.fn()
  const playback = playSong(document.createElement('video'), opened, opened.karaoke, onError)
  const source = FakeMediaSource.last
  source.dispatchEvent(new Event('sourceopen'))
  await vi.waitFor(() => expect(source.buffer.calls).toEqual(['append ki', 'append ks']))
  expect(source.types).toEqual([OPUS])
  expect(onError).not.toHaveBeenCalled()
  return { switchAudio: (track) => playback.switchAudio(track), source }
}

test('switching to an audio track of another type changes the buffer type before its init segment', async () => {
  const opened = song(AAC)
  const { switchAudio, source } = await playKaraoke(opened)
  switchAudio(opened.original)
  await vi.waitFor(() => expect(source.buffer.calls).toContain('append os'))
  expect(source.buffer.calls).toEqual([
    'append ki',
    'append ks',
    'remove',
    `changeType ${AAC}`,
    'append oi',
    'append os',
  ])

  switchAudio(opened.karaoke)
  await vi.waitFor(() => expect(source.buffer.calls).toHaveLength(10))
  expect(source.buffer.calls.slice(6)).toEqual(['remove', `changeType ${OPUS}`, 'append ki', 'append ks'])
})

test('switching to an audio track of the same type keeps the buffer type', async () => {
  const opened = song(OPUS)
  const { switchAudio, source } = await playKaraoke(opened)
  switchAudio(opened.original)
  await vi.waitFor(() => expect(source.buffer.calls).toContain('append os'))
  expect(source.buffer.calls).toEqual(['append ki', 'append ks', 'remove', 'append oi', 'append os'])
})

test('the first track this browser cannot play is named, the video first', () => {
  const opened: OpenedSong = { ...song(AAC), video: track('video/mp4; codecs="hvc1.1.6.L93.B0"', 4) }
  const supported = new Set<string>()
  vi.stubGlobal('MediaSource', { isTypeSupported: (type: string) => supported.has(type) })
  expect(unplayableMedia(opened)).toBe('video')
  supported.add('video/mp4; codecs="hvc1.1.6.L93.B0"')
  expect(unplayableMedia(opened)).toBe('karaoke')
  supported.add(OPUS)
  expect(unplayableMedia(opened)).toBe('original')
  supported.add(AAC)
  expect(unplayableMedia(opened)).toBeUndefined()
})
