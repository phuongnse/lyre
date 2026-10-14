import { makeKaraoke } from './karaoke-track'
import init, {
  parseTimingFile,
  SongWriteErrorKind,
  SongWriteFault,
  SongWriter,
  TimingFileErrorKind,
  TimingFileFault,
  TrackKind,
  VocalRole,
} from './lyre-wasm/lyre_wasm.js'
import { PackageReply, PackageRequest, SegmentTimes, SongRefusal } from './original-track-messages'
import { PackagedTrack, packageOriginal } from './original-track'
import { makeThumbnail } from './thumbnail'
import { checkVideoEnd, packageVideo, videoRefusal } from './video-track'

// Packages a source's audio into the original track, and can then make the
// karaoke track cut at its times and the video track, and makes a source's
// thumbnail, off the page's main thread. It can also make all of these and
// write them, with the lyrics and the timing, into a song file through the
// core. It answers with a summary or the song file, never with the error's
// text.
addEventListener('message', (event: MessageEvent<PackageRequest>) => {
  const request = event.data
  if (request.type === 'package') {
    void packageOriginal(request.file, request.storedType).then(
      ({ storedType, segments }) =>
        postMessage({
          type: 'done',
          storedType,
          segmentCount: segments.length,
          durationMs: segments.reduce((sum, segment) => sum + segment.durationMs, 0),
        } satisfies PackageReply),
      () => postMessage({ type: 'failed' } satisfies PackageReply),
    )
  } else if (request.type === 'thumbnail') {
    void makeThumbnail(request.file).then(
      (bytes) =>
        postMessage({ type: 'thumbnail-done', bytes } satisfies PackageReply, bytes === null ? [] : [bytes.buffer]),
      () => postMessage({ type: 'failed' } satisfies PackageReply),
    )
  } else if (request.type === 'make-audio') {
    void makeAudio(request.file, request.karaokeFile, request.storedType, request.videoType).then(
      (reply) => postMessage(reply),
      (error: unknown) => {
        // Only a fixed reason code crosses, never the error's text.
        const reason = videoRefusal(error)
        postMessage((reason === undefined ? { type: 'failed' } : { type: 'failed', reason }) satisfies PackageReply)
      },
    )
  } else if (request.type === 'make-song') {
    void makeSong(request).then(
      (bytes) => postMessage({ type: 'song-done', bytes } satisfies PackageReply, [bytes.buffer]),
      (error: unknown) => {
        // Only a fixed reason code crosses, never the error's text.
        const reason = error instanceof SongRefused ? error.reason : videoRefusal(error)
        postMessage((reason === undefined ? { type: 'failed' } : { type: 'failed', reason }) satisfies PackageReply)
      },
    )
  }
})

// The core refused the song for a reason the page names. Its text never
// reaches the UI.
class SongRefused extends Error {
  constructor(readonly reason: SongRefusal) {
    super(reason)
    this.name = 'SongRefused'
  }
}

async function makeAudio(
  file: File,
  karaokeFile: File,
  storedType: string,
  videoType: string | undefined,
): Promise<PackageReply> {
  const original = await packageOriginal(file, storedType)
  const karaoke = await makeKaraoke(karaokeFile, original)
  const karaokeTimes = segmentTimes(karaoke)
  // The song lasts as long as its karaoke track.
  const songDurationMs = karaokeTimes[karaokeTimes.length - 1]!.endMs
  const reply: PackageReply = {
    type: 'audio-done',
    original: segmentTimes(original),
    karaoke: karaokeTimes,
    songDurationMs,
  }
  // An audio-only source gives no video.
  const video = videoType === undefined ? null : await packageVideo(file, videoType)
  if (video !== null) {
    checkVideoEnd(video, songDurationMs)
    reply.video = segmentTimes(video)
  }
  return reply
}

// Reads the timing file against the lyrics, then makes every track and the
// thumbnail, and writes the song file through the core. The lyrics' bytes go
// to the core unchanged (D5).
async function makeSong(request: Extract<PackageRequest, { type: 'make-song' }>): Promise<Uint8Array> {
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', request.baseUri) })
  const lyrics = new Uint8Array(await request.lyrics.arrayBuffer())
  const timing = new Uint8Array(await request.timing.arrayBuffer())
  // A timing file that does not fit the lyrics fails before any media work.
  const timesMs = readTimes(timing, lyrics)

  const original = await packageOriginal(request.file, request.storedType)
  const karaoke = await makeKaraoke(request.karaokeFile, original)
  const karaokeTimes = segmentTimes(karaoke)
  const songDurationMs = karaokeTimes[karaokeTimes.length - 1]!.endMs
  const video = request.videoType === undefined ? null : await packageVideo(request.file, request.videoType)
  if (video !== null) checkVideoEnd(video, songDurationMs)
  const thumbnail = await makeThumbnail(request.file)

  const { title, artist, composer, vocalRole } = request.details
  const role = vocalRole === 'male' ? VocalRole.Male : VocalRole.Female
  const writer = new SongWriter(request.songId, title, artist, composer, role, lyrics, timesMs)
  try {
    if (thumbnail !== null) writer.setThumbnail(thumbnail)
    if (video !== null) addTrack(writer, TrackKind.Video, video)
    addTrack(writer, TrackKind.Karaoke, karaoke)
    addTrack(writer, TrackKind.Original, original)
    return writer.write()
  } catch (error) {
    if (!(error instanceof SongWriteFault)) throw error
    const kind = error.kind
    error.free()
    if (kind === SongWriteErrorKind.PastEnd) throw new SongRefused('past-end')
    if (kind === SongWriteErrorKind.Lyrics) throw new SongRefused('lyrics')
    throw new Error('refused')
  } finally {
    writer.free()
  }
}

// Each syllable's start and end, in lyric order, from the timing file read
// against the lyrics by the core.
function readTimes(timing: Uint8Array, lyrics: Uint8Array): Uint32Array {
  let syllables
  try {
    syllables = parseTimingFile(timing, lyrics)
  } catch (error) {
    if (!(error instanceof TimingFileFault)) throw error
    const kind = error.kind
    error.free()
    throw new SongRefused(kind === TimingFileErrorKind.Lyrics ? 'lyrics' : 'timing-file')
  }
  const times = Uint32Array.from(syllables.flatMap(({ startMs, endMs }) => [startMs, endMs]))
  for (const syllable of syllables) syllable.free()
  return times
}

// Gives the writer a track's start, stored type, init bytes and segments.
function addTrack(writer: SongWriter, kind: TrackKind, track: PackagedTrack): void {
  writer.setTrack(kind, track.startMs, track.storedType, track.init)
  for (const segment of track.segments) writer.addSegment(kind, segment.durationMs, segment.bytes)
}

function segmentTimes({ startMs, segments }: PackagedTrack): SegmentTimes[] {
  let start = startMs
  return segments.map(({ durationMs }) => {
    const times = { startMs: start, endMs: start + durationMs }
    start = times.endMs
    return times
  })
}
