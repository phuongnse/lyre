import { AudioSample, AudioSampleSource, NullTarget, Output, Quality, WebMOutputFormat } from 'mediabunny'
import {
  MAX_AUDIO_SEGMENT_MS,
  MAX_FIRST_SEGMENT_START_MS,
  MediaSegment,
  PackagedTrack,
  PackageError,
  Piece,
  checkTrackLimits,
  concat,
} from './original-track'
import { AudioFormat, decodeAudio } from './source-audio'
import { SourceError } from './source-error'

// Encodes the karaoke track: part of stage 8 of processing
// (docs/domain/knowledge.md#processing). It is the only audio that is encoded
// (D24). Until separation exists, a second picked file stands in for it. Its
// audio is decoded on its own timeline, fitted to the original track's length
// and encoded to Opus. It is then cut where the original track is cut, so
// switching tracks keeps the position. The code uses no DOM, so it can run in
// a Web Worker.

// The stored type and format the song file format sets for the karaoke track
// (docs/reference/song-file-format-v0.md#media).
export const KARAOKE_TYPE = 'audio/webm; codecs="opus"'
export const KARAOKE_FORMAT: AudioFormat = { sampleRate: 48000, channels: 2 }
// A common quality for stereo music in Opus.
export const KARAOKE_BITRATE = 128_000

// How far apart the two tracks' segment starts and ends may be.
export const MAX_CUT_DISTANCE_MS = 50

// Fits audio to exactly `targetFrames` frames: it cuts what comes after them,
// and adds silence when the audio ends before them.
export class FitToLength {
  private written = 0

  constructor(
    private readonly targetFrames: number,
    private readonly channels: number,
  ) {}

  // Returns `planes`, cut so the total never passes the target.
  push(planes: Float32Array[]): Float32Array[] {
    const frames = planes[0]?.length ?? 0
    const kept = Math.max(0, Math.min(frames, this.targetFrames - this.written))
    this.written += kept
    return kept === frames ? planes : planes.map((plane) => plane.subarray(0, kept))
  }

  // Returns the silence still needed to reach the target, which may be none.
  finish(): Float32Array[] {
    const missing = Math.max(0, this.targetFrames - this.written)
    this.written += missing
    return Array.from({ length: this.channels }, () => new Float32Array(missing))
  }
}

// Groups pieces, in time order, into one segment per span of the original
// track. `cutsMs` are where the original's segments start, after its first.
// Each cut goes to the piece start nearest it that keeps the segment at 1 to
// 10,000 ms. A cut with no such piece start within 50 ms is refused. The
// track starts at the first piece, and the last segment ends at `endMs`.
// Pieces that start at or after `endMs` are left out: the Opus encoder holds
// back a few milliseconds and sends them in one more packet, which can start
// at the end.
export function cutAtTimes(
  allPieces: Piece[],
  endMs: number,
  cutsMs: number[],
): { startMs: number; segments: MediaSegment[] } {
  for (let i = 1; i < allPieces.length; i++) {
    if (allPieces[i]!.startMs < allPieces[i - 1]!.startMs) throw new PackageError('pieces out of order')
  }
  const pieces = allPieces.filter((piece) => piece.startMs < endMs)
  const first = pieces[0]
  if (first === undefined) throw new PackageError('no pieces before the end')
  // Encoder priming can give a tiny negative time. The track still starts at 0.
  const startMs = Math.max(0, first.startMs)
  if (startMs > MAX_FIRST_SEGMENT_START_MS) throw new PackageError('audio starts late')
  const startOf = (index: number) => (index === 0 ? startMs : pieces[index]!.startMs)

  // The index of the piece that starts each segment.
  const starts = [0]
  for (const [cutIndex, cut] of cutsMs.entries()) {
    const previous = starts[starts.length - 1]!
    const isLast = cutIndex === cutsMs.length - 1
    let nearest: number | undefined
    for (let i = previous + 1; i < pieces.length; i++) {
      const edge = pieces[i]!.startMs
      const length = edge - startOf(previous)
      // Piece starts only grow, so every later one is too far as well.
      if (length > MAX_AUDIO_SEGMENT_MS) break
      if (length < 1) continue
      // The last cut also leaves the last segment within the limit.
      if (isLast && endMs - edge > MAX_AUDIO_SEGMENT_MS) continue
      if (nearest === undefined || Math.abs(edge - cut) < Math.abs(pieces[nearest]!.startMs - cut)) nearest = i
    }
    if (nearest === undefined || Math.abs(pieces[nearest]!.startMs - cut) > MAX_CUT_DISTANCE_MS) {
      throw new PackageError('cut too far')
    }
    starts.push(nearest)
  }

  const segments = starts.map((index, segmentIndex) => {
    const next = starts[segmentIndex + 1]
    const end = next === undefined ? endMs : pieces[next]!.startMs
    const bytes = concat(pieces.slice(index, next).map((piece) => piece.bytes))
    return { durationMs: end - startOf(index), bytes }
  })
  const last = segments[segments.length - 1]!
  if (last.durationMs < 1 || last.durationMs > MAX_AUDIO_SEGMENT_MS) throw new PackageError('segment too long')
  return { startMs, segments }
}

// Whether this browser can encode the karaoke track. The page asks before it
// starts any work.
export async function canEncodeKaraoke(): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: 'opus',
      sampleRate: KARAOKE_FORMAT.sampleRate,
      numberOfChannels: KARAOKE_FORMAT.channels,
      bitrate: KARAOKE_BITRATE,
    })
    return support.supported === true
  } catch {
    return false
  }
}

// Makes the karaoke track from the audio of `file`, fitted to the end of
// `original` and cut where it is cut. A file without audio is refused with
// 'no-audio'. Any other failure is a PackageError.
export async function makeKaraoke(file: Blob, original: PackagedTrack): Promise<PackagedTrack> {
  try {
    // Where the original's segments start, and where it ends.
    const originalStarts: number[] = []
    let endMs = original.startMs
    for (const segment of original.segments) {
      originalStarts.push(endMs)
      endMs += segment.durationMs
    }
    const { sampleRate, channels } = KARAOKE_FORMAT
    const fit = new FitToLength(Math.round((endMs * sampleRate) / 1000), channels)

    const init: Uint8Array[] = []
    const pieces: Piece[] = []
    // Mediabunny may reuse its buffers, so every callback keeps a copy.
    const addInit = (data: Uint8Array) => {
      init.push(data.slice())
    }
    // A Cluster for every Opus packet, so a segment can end at any packet.
    const format = new WebMOutputFormat({
      appendOnly: true,
      minimumClusterDuration: 0,
      onEbmlHeader: addInit,
      onSegmentHeader: addInit,
      onCluster: (data, _position, timestamp) =>
        // Rounding to a microsecond first keeps 1.5 s from becoming 1499.9999 ms.
        pieces.push({ startMs: Math.floor(Math.round(timestamp * 1e6) / 1000), bytes: data.slice() }),
    })
    const output = new Output({ format, target: new NullTarget() })
    const source = new AudioSampleSource({ codec: 'opus', quality: new Quality({ bitrate: KARAOKE_BITRATE }) })
    output.addAudioTrack(source)
    await output.start()

    let written = 0
    const encode = async (planes: Float32Array[]) => {
      const frames = planes[0]?.length ?? 0
      if (frames === 0) return
      const data = new Float32Array(frames * channels)
      planes.forEach((plane, index) => data.set(plane, index * frames))
      const sample = new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: channels,
        sampleRate,
        timestamp: written / sampleRate,
      })
      try {
        await source.add(sample)
      } finally {
        sample.close()
      }
      written += frames
    }
    for await (const planes of decodeAudio(file, KARAOKE_FORMAT)) {
      const fitted = fit.push(planes)
      await encode(fitted)
      // The rest is past the original's end, so it is not decoded. Leaving
      // the loop closes the file.
      if ((fitted[0]?.length ?? 0) < (planes[0]?.length ?? 0)) break
    }
    await encode(fit.finish())
    await output.finalize()

    const { startMs, segments } = cutAtTimes(pieces, endMs, originalStarts.slice(1))
    const initBytes = concat(init)
    checkTrackLimits(
      initBytes.length,
      segments.map((segment) => segment.bytes.length),
    )
    return { startMs, storedType: KARAOKE_TYPE, init: initBytes, segments }
  } catch (error) {
    // The error's own text is never shown, and it may hold parts of the file.
    if (error instanceof SourceError || error instanceof PackageError) throw error
    throw new PackageError('unexpected')
  }
}
