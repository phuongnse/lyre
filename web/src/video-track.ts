import {
  BlobSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP3,
  MP4,
  NullTarget,
  Output,
  WEBM,
} from 'mediabunny'
import { VideoRefusal } from './original-track-messages'
import {
  MAX_SEGMENT_BYTES,
  MAX_VIDEO_SEGMENT_MS,
  PackagedTrack,
  PackageError,
  Piece,
  checkTrackLimits,
  concat,
  groupSegments,
  outputFormat,
} from './original-track'
import { SourceError } from './source-error'

// Repackages a source's video into the song's video track: part of stage 8 of
// processing (docs/domain/knowledge.md#processing). Its coded packets are
// copied byte for byte into WebM or fragmented MP4, by the stored type (D24),
// so its codec, resolution and frame rate stay as they were. Nothing is
// decoded or encoded. Its times are shifted like the audio's, so the tracks
// stay in sync. Every keyframe starts a Cluster or a fragment, and these are
// grouped into segments of up to 20 s, so each segment starts on a keyframe.
// The code uses no DOM, so it can run in a Web Worker.

// How far the video's end may be from the song's end. It mirrors the core's
// constant of the same name in song_file.rs.
export const VIDEO_TOLERANCE_MS = 1_000

// Rounds seconds to whole microseconds, so 1.5 s does not become 1.4999999 s.
const microseconds = (seconds: number) => Math.round(seconds * 1e6)

// Checks keyframe gaps and group sizes as packets arrive. A group is a
// keyframe and the packets after it, up to the next keyframe. It takes sizes,
// not bytes, so a check of a 64 MiB group needs no 64 MiB. Times are seconds.
export class KeyframeGroups {
  private lastKey: number | undefined
  private groupBytes = 0

  add(timestamp: number, key: boolean, bytes: number): void {
    if (this.lastKey === undefined) {
      if (!key) throw new PackageError('no first keyframe')
    } else {
      this.checkGap(timestamp)
    }
    if (key) {
      this.lastKey = timestamp
      this.groupBytes = 0
    }
    this.groupBytes += bytes
    if (this.groupBytes > MAX_SEGMENT_BYTES) throw new PackageError('group too large')
  }

  // Checks the last group against the video's end.
  finish(end: number): void {
    if (this.lastKey === undefined) throw new PackageError('no first keyframe')
    this.checkGap(end)
  }

  private checkGap(timestamp: number): void {
    if (microseconds(timestamp - this.lastKey!) > MAX_VIDEO_SEGMENT_MS * 1000) {
      throw new PackageError('keyframe gap')
    }
  }
}

// Packages the primary video track of `file`, whose stored type the core gave
// as `storedType`. A source without video gives null. Any failure is a
// PackageError.
export async function packageVideo(file: Blob, storedType: string): Promise<PackagedTrack | null> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MP3] })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (track === null) return null
    // The same start as the audio's, so both tracks keep their places.
    const timelineStart = Math.max(0, await input.getFirstTimestamp())
    const codec = await track.getCodec()
    if (codec === null) throw new PackageError('unknown codec')

    const init: Uint8Array[] = []
    const pieces: Piece[] = []
    // Mediabunny may reuse its buffers, so every callback keeps a copy.
    const startPiece = (data: Uint8Array, _position: number, timestamp: number) =>
      // Rounding to a microsecond first keeps 1.5 s from becoming 1499.9999 ms.
      pieces.push({ startMs: Math.floor(microseconds(timestamp) / 1000), bytes: data.slice() })
    const addInit = (data: Uint8Array) => {
      init.push(data.slice())
    }
    const format = outputFormat(storedType, 'video', addInit, startPiece, (data) => {
      const piece = pieces[pieces.length - 1]
      if (piece === undefined) throw new PackageError('mdat before moof')
      piece.bytes = concat([piece.bytes, data])
    })

    const output = new Output({ format, target: new NullTarget() })
    const source = new EncodedVideoPacketSource(codec)
    output.addVideoTrack(source)
    await output.start()
    const groups = new KeyframeGroups()
    let end = 0
    let first = true
    let lastDuration = 0
    for await (const packet of new EncodedPacketSink(track).packets()) {
      const timestamp = packet.timestamp - timelineStart
      // Checked before the packet is added, so a refused source is not copied further.
      groups.add(timestamp, packet.type === 'key', packet.data.length)
      const shifted = packet.clone({ timestamp })
      await source.add(shifted, first ? { decoderConfig: (await track.getDecoderConfig()) ?? undefined } : undefined)
      first = false
      // A WebM block need not store its length, so the last packet can have a
      // duration of 0. Then the one before counts.
      if (shifted.duration > 0) lastDuration = shifted.duration
      end = Math.max(end, shifted.timestamp + lastDuration)
    }
    if (first) throw new PackageError('no packets')
    groups.finish(end)
    await output.finalize()

    const { startMs, segments } = groupSegments(pieces, Math.round(end * 1000), MAX_VIDEO_SEGMENT_MS, 'video')
    const initBytes = concat(init)
    checkTrackLimits(
      initBytes.length,
      segments.map((segment) => segment.bytes.length),
    )
    return { startMs, storedType, init: initBytes, segments }
  } catch (error) {
    // The error's own text is never shown, and it may hold parts of the file.
    if (error instanceof SourceError || error instanceof PackageError) throw error
    throw new PackageError('unexpected')
  } finally {
    input.dispose()
  }
}

// Checks that the video ends within 1,000 ms of the song's end, as the core's
// writer does again.
export function checkVideoEnd(video: PackagedTrack, songDurationMs: number): void {
  const endMs = video.segments.reduce((sum, segment) => sum + segment.durationMs, video.startMs)
  if (Math.abs(endMs - songDurationMs) > VIDEO_TOLERANCE_MS) throw new PackageError('video length')
}

// The reason code a failure may carry to the page: only these two, never other text.
export function videoRefusal(error: unknown): VideoRefusal | undefined {
  if (!(error instanceof PackageError)) return undefined
  return error.message === 'keyframe gap' || error.message === 'group too large' ? error.message : undefined
}
