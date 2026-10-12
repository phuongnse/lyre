import { ChunkRef, OpenedSong } from '../song-file'

// Streams a song's video and karaoke track into a video element through Media
// Source Extensions. docs/reference/song-file-format-v0.md#media sets the types.
const VIDEO_TYPE = 'video/webm; codecs="vp09.00.40.08"'
const AUDIO_TYPE = 'audio/webm; codecs="opus"'

// How far ahead of the play position media is appended. Chromium caps each
// buffer at a size a long song would exceed, and memory stays bounded.
const AHEAD_SECONDS = 30

// Starts streaming `song` into `video`. Calls `onError` once if the media cannot
// be read, appended or decoded. Returns a function that stops the streaming.
export function playSong(video: HTMLVideoElement, song: OpenedSong, onError: () => void): () => void {
  const mediaSource = new MediaSource()
  const url = URL.createObjectURL(mediaSource)
  const feeders: TrackFeeder[] = []
  let stopped = false

  const fail = () => {
    if (!stopped) {
      stop()
      onError()
    }
  }
  const feed = () => feeders.forEach((feeder) => feeder.feed())
  const finish = () => {
    if (feeders.every((feeder) => feeder.done) && mediaSource.readyState === 'open') mediaSource.endOfStream()
  }
  const open = () => {
    try {
      mediaSource.duration = song.durationMs / 1000
      const tracks = [song.video && { track: song.video, type: VIDEO_TYPE }, { track: song.karaoke, type: AUDIO_TYPE }]
      for (const entry of tracks) {
        if (!entry) continue
        const buffer = mediaSource.addSourceBuffer(entry.type)
        const chunks = [entry.track.init, ...entry.track.segments]
        feeders.push(new TrackFeeder(buffer, chunks, song, video, finish, fail))
      }
    } catch {
      fail()
      return
    }
    feed()
  }

  function stop() {
    stopped = true
    feeders.forEach((feeder) => feeder.stop())
    mediaSource.removeEventListener('sourceopen', open)
    video.removeEventListener('timeupdate', feed)
    video.removeEventListener('error', fail)
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }

  mediaSource.addEventListener('sourceopen', open, { once: true })
  video.addEventListener('timeupdate', feed)
  video.addEventListener('error', fail)
  video.src = url
  return () => {
    if (!stopped) stop()
  }
}

// Appends one track's init segment, then its media segments in order, one at a
// time, while they start no more than AHEAD_SECONDS after the play position.
class TrackFeeder {
  done = false
  private next = 0
  private busy = false
  private stopped = false

  constructor(
    private readonly buffer: SourceBuffer,
    private readonly chunks: ChunkRef[],
    private readonly song: OpenedSong,
    private readonly video: HTMLVideoElement,
    private readonly onDone: () => void,
    private readonly onError: () => void,
  ) {
    buffer.addEventListener('updateend', this.appended)
    buffer.addEventListener('error', this.onError)
  }

  feed(): void {
    if (this.busy || this.done || this.stopped) return
    if (this.next === this.chunks.length) {
      this.done = true
      this.onDone()
      return
    }
    const chunk = this.chunks[this.next]
    if (chunk.startMs / 1000 > this.video.currentTime + AHEAD_SECONDS) return
    this.busy = true
    this.song.read(chunk).then(
      (bytes) => {
        if (this.stopped) return
        try {
          this.buffer.appendBuffer(bytes)
          this.next++
        } catch {
          this.onError()
        }
      },
      () => {
        if (!this.stopped) this.onError()
      },
    )
  }

  stop(): void {
    this.stopped = true
    this.buffer.removeEventListener('updateend', this.appended)
    this.buffer.removeEventListener('error', this.onError)
  }

  private readonly appended = () => {
    this.busy = false
    this.feed()
  }
}
