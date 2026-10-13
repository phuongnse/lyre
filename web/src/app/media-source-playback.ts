import { ChunkRef, MediaTrack, OpenedSong } from '../song-file'

// Streams a song's video and one audio track into a video element through Media
// Source Extensions. Each track plays by the type its song file stores
// (docs/reference/song-file-format-v0.md#media).

// How far ahead of the play position media is appended. Chromium caps each
// buffer at a size a long song would exceed, and memory stays bounded.
const AHEAD_SECONDS = 30

// The media of a song that a device may be unable to play.
export type SongMedia = 'video' | 'karaoke' | 'original'

// The first of the song's video, karaoke track and original track whose stored
// type this browser cannot play, or undefined when it can play them all.
export function unplayableMedia(song: OpenedSong): SongMedia | undefined {
  if (song.video && !MediaSource.isTypeSupported(song.video.type)) return 'video'
  if (!MediaSource.isTypeSupported(song.karaoke.type)) return 'karaoke'
  if (!MediaSource.isTypeSupported(song.original.type)) return 'original'
  return undefined
}

export interface Playback {
  // Replaces the streamed audio with `track` from the play position on. The
  // video goes on and the play position does not move. Both tracks are cut at
  // about the same times, so the new audio fits where the old audio was. A
  // track of another type changes the buffer's type.
  switchAudio(track: MediaTrack): void
  // Stops the streaming.
  stop(): void
}

// Starts streaming `song`'s video and the `audio` track into `video`. Calls
// `onError` once if the media cannot be read, appended or decoded.
export function playSong(video: HTMLVideoElement, song: OpenedSong, audio: MediaTrack, onError: () => void): Playback {
  const mediaSource = new MediaSource()
  const url = URL.createObjectURL(mediaSource)
  const feeders: TrackFeeder[] = []
  let audioFeeder: TrackFeeder | undefined
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
  // The chunks of `track` that are still to be played: its init segment, then
  // the segments from the one that holds the play position.
  const remaining = (track: MediaTrack) => {
    const position = video.currentTime * 1000
    let from = 0
    track.segments.forEach((segment, index) => {
      if (segment.startMs <= position) from = index
    })
    return [track.init, ...track.segments.slice(from)]
  }
  const open = () => {
    try {
      mediaSource.duration = song.durationMs / 1000
      if (song.video) {
        const buffer = mediaSource.addSourceBuffer(song.video.type)
        const chunks = [song.video.init, ...song.video.segments]
        feeders.push(new TrackFeeder(buffer, song.video.type, chunks, song, video, finish, fail))
      }
      const buffer = mediaSource.addSourceBuffer(audio.type)
      audioFeeder = new TrackFeeder(buffer, audio.type, remaining(audio), song, video, finish, fail)
      feeders.push(audioFeeder)
    } catch {
      fail()
      return
    }
    feed()
  }
  const switchAudio = (track: MediaTrack) => {
    if (stopped) return
    // Before the source opens, the track is the one to stream first.
    if (audioFeeder) audioFeeder.replace(track.type, remaining(track))
    else audio = track
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
  return {
    switchAudio,
    stop() {
      if (!stopped) stop()
    },
  }
}

// Appends one track's init segment, then its media segments in order, one at a
// time, while they start no more than AHEAD_SECONDS after the play position.
class TrackFeeder {
  // The type of the chunks to append. It differs from the buffer's type after a
  // replacement with a track of another type, until the old media is removed.
  private type: string
  done = false
  private next = 0
  private busy = false
  private stopped = false
  // Set by replace, until the old audio is removed from the buffer.
  private clearPending = false
  // Counts replacements, so a read that began before one is dropped.
  private generation = 0

  constructor(
    private readonly buffer: SourceBuffer,
    // The type the buffer was created with, or last changed to.
    private bufferType: string,
    private chunks: ChunkRef[],
    private readonly song: OpenedSong,
    private readonly video: HTMLVideoElement,
    private readonly onDone: () => void,
    private readonly onError: () => void,
  ) {
    this.type = bufferType
    buffer.addEventListener('updateend', this.appended)
    buffer.addEventListener('error', this.onError)
  }

  feed(): void {
    if (this.busy || this.stopped) return
    if (this.clearPending) {
      // The buffer's updateend feeds again.
      if (this.buffer.updating) return
      this.clearPending = false
      this.busy = true
      try {
        this.buffer.remove(0, Infinity)
      } catch {
        this.onError()
      }
      return
    }
    if (this.done) return
    if (this.next === this.chunks.length) {
      this.done = true
      this.onDone()
      return
    }
    const chunk = this.chunks[this.next]
    if (chunk.startMs / 1000 > this.video.currentTime + AHEAD_SECONDS) return
    if (this.type !== this.bufferType) {
      // The old media is removed, so the new init segment comes next.
      try {
        this.buffer.changeType(this.type)
        this.bufferType = this.type
      } catch {
        this.onError()
        return
      }
    }
    this.busy = true
    const generation = this.generation
    this.song.read(chunk).then(
      (bytes) => {
        if (this.stopped) return
        if (generation !== this.generation) {
          this.busy = false
          this.feed()
          return
        }
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

  // Drops what is buffered and streams `chunks`, of the given `type`, instead,
  // from the first.
  replace(type: string, chunks: ChunkRef[]): void {
    this.type = type
    this.chunks = chunks
    this.next = 0
    this.done = false
    this.clearPending = true
    this.generation++
    this.feed()
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
