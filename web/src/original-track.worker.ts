import { KARAOKE_FORMAT, makeKaraoke } from './karaoke-track'
import init, { parseTimingFile, TimingFileErrorKind, TimingFileFault } from './lyre-wasm/lyre_wasm.js'
import { wavPlanes } from './measurement/wav'
import { PackageReply, PackageRequest, SegmentTimes } from './original-track-messages'
import { PackagedTrack, packageOriginal } from './original-track'
import { Resampler } from './resampler'
import { PieceSink, SONG_FILE, SongRefused, writeSong } from './song-writer'
import { readSource } from './source'
import { decodeAudio, SEPARATION_FORMAT } from './source-audio'
import { opfsWorkingAreas, TASK_LOCK } from './task/working-area'
import { makeThumbnail } from './thumbnail'
import { checkVideoEnd, packageVideo, videoRefusal } from './video-track'

// Packages a source's audio into the original track, and can then make the
// karaoke track cut at its times and the video track, and makes a source's
// thumbnail, off the page's main thread. It can also make all of these and
// write them, with the lyrics and the timing, into a song file through the
// core. It can also make a song from a source, the karaoke track and the
// timing of a measurement, for the model check page to play. It answers with
// a summary or the song file, never with the error's text.
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
  } else if (request.type === 'make-measured-song') {
    void makeMeasuredSong(request).then(
      (bytes) => postMessage({ type: 'song-done', bytes } satisfies PackageReply, [bytes.buffer]),
      // The page has one message for any failure, so no reason crosses.
      () => postMessage({ type: 'failed' } satisfies PackageReply),
    )
  }
})

async function makeAudio(
  file: File,
  karaokeFile: File,
  storedType: string,
  videoType: string | undefined,
): Promise<PackageReply> {
  const original = await packageOriginal(file, storedType)
  const karaoke = await makeKaraoke(decodeAudio(karaokeFile, KARAOKE_FORMAT), original)
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
  const karaoke = await makeKaraoke(decodeAudio(request.karaokeFile, KARAOKE_FORMAT), original)
  const karaokeTimes = segmentTimes(karaoke)
  const songDurationMs = karaokeTimes[karaokeTimes.length - 1]!.endMs
  const video = request.videoType === undefined ? null : await packageVideo(request.file, request.videoType)
  if (video !== null) checkVideoEnd(video, songDurationMs)
  const thumbnail = await makeThumbnail(request.file)

  return writeInArea((out) =>
    writeSong({
      songId: request.songId,
      details: request.details,
      lyrics,
      timesMs,
      original,
      karaoke,
      video,
      thumbnail,
      out,
    }),
  )
}

// The last extension of a file name, such as ".webm".
const EXTENSION = /\.[^.]*$/

// About 1 s of 44.1 kHz audio: how much of the karaoke track is resampled at a time.
const KARAOKE_PIECE_FRAMES = 44_100

// Makes a song from the source, a candidate aligner's timing and the karaoke
// track of its backend's separation, and writes it through the core. It has
// no thumbnail. Its title is the source's title tag, or else the file name
// without its extension. The artist and composer come from the tags, and the
// vocal role is female. The lyrics' bytes go to the core unchanged (D5).
async function makeMeasuredSong(request: Extract<PackageRequest, { type: 'make-measured-song' }>): Promise<Uint8Array> {
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', request.baseUri) })
  const details = await readSource(request.file)
  if (details.audioType === undefined) throw new Error('no audio type')
  const lyrics = new Uint8Array(await request.lyrics.arrayBuffer())
  const original = await packageOriginal(request.file, details.audioType)
  const planes = wavPlanes(new Uint8Array(await request.karaokeWav.arrayBuffer()))
  const karaoke = await makeKaraoke(resampled(planes), original)
  const karaokeTimes = segmentTimes(karaoke)
  // The song lasts as long as its karaoke track.
  const songDurationMs = karaokeTimes[karaokeTimes.length - 1]!.endMs
  const video = details.videoType === undefined ? null : await packageVideo(request.file, details.videoType)
  if (video !== null) checkVideoEnd(video, songDurationMs)
  return writeInArea((out) =>
    writeSong({
      songId: request.songId,
      details: {
        title: details.title ?? request.file.name.replace(EXTENSION, ''),
        artist: details.artist ?? '',
        composer: details.composer ?? '',
        vocalRole: 'female',
      },
      lyrics,
      timesMs: request.timesMs,
      original,
      karaoke,
      video,
      thumbnail: null,
      out,
    }),
  )
}

// Writes a song file in pieces into a fresh working area, under the task
// lock so the startup cleanup never removes it mid-write, and reads it back.
// The area is removed at the end, also after an error.
async function writeInArea(write: (out: PieceSink) => Promise<unknown>): Promise<Uint8Array> {
  return navigator.locks.request(TASK_LOCK, async () => {
    const areas = opfsWorkingAreas()
    const taskId = crypto.randomUUID()
    try {
      const area = await areas.create(taskId)
      const file = await area.open(SONG_FILE)
      try {
        await write(file)
      } catch (error) {
        await file.close().catch(() => {})
        throw error
      }
      await file.close()
      return new Uint8Array(await (await area.read(SONG_FILE)).arrayBuffer())
    } finally {
      await areas.remove(taskId).catch(() => {})
    }
  })
}

// The separation's planes, at 44.1 kHz, resampled to KARAOKE_FORMAT a piece at a time.
async function* resampled([left, right]: Float32Array[]): AsyncGenerator<Float32Array[]> {
  const resampler = new Resampler(SEPARATION_FORMAT.sampleRate, KARAOKE_FORMAT.sampleRate, KARAOKE_FORMAT.channels)
  const frames = left!.length
  for (let start = 0; start < frames; start += KARAOKE_PIECE_FRAMES) {
    const end = Math.min(frames, start + KARAOKE_PIECE_FRAMES)
    yield resampler.push([left!.subarray(start, end), right!.subarray(start, end)])
  }
  yield resampler.flush()
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

function segmentTimes({ startMs, segments }: PackagedTrack): SegmentTimes[] {
  let start = startMs
  return segments.map(({ durationMs }) => {
    const times = { startMs: start, endMs: start + durationMs }
    start = times.endMs
    return times
  })
}
