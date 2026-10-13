import {
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  MP3,
  MP4,
  Mp4OutputFormat,
  NullTarget,
  Output,
  OutputFormat,
  WEBM,
  WebMOutputFormat,
} from 'mediabunny'
import { SourceError } from './source-error'

// Repackages a source's audio into the original track: stage 8 of processing
// (docs/domain/knowledge.md#processing). Its coded packets are copied byte for
// byte into WebM or fragmented MP4, by the stored type (D24). Nothing is
// decoded or encoded. Time counts from the timeline's start, so the track
// stays in sync with the video and the karaoke track. The code uses no DOM,
// so it can run in a Web Worker.

// The format's limits (docs/reference/song-file-format-v0.md#media). They
// mirror the core's constants of the same names in song_file.rs, and the
// core's writer enforces them again.
export const MAX_CONTAINER_INIT_BYTES = 65_536
export const MAX_SEGMENT_BYTES = 67_108_864
export const MAX_SEGMENTS = 4_096
export const MAX_AUDIO_SEGMENT_MS = 10_000
export const MAX_VIDEO_SEGMENT_MS = 20_000
export const MAX_FIRST_SEGMENT_START_MS = 50

// One media segment: whole Clusters, or whole moof and mdat pairs.
export interface MediaSegment {
  durationMs: number
  bytes: Uint8Array
}

// Mirrors the core's Track: startMs is its start_ms, 0 to 50 ms, and each
// segment starts where the previous one ends.
export interface PackagedTrack {
  startMs: number
  storedType: string
  init: Uint8Array
  segments: MediaSegment[]
}

// One Cluster, or one moof and mdat pair, and the time of its first frame in
// whole milliseconds.
export interface Piece {
  startMs: number
  bytes: Uint8Array
}

// Why packaging failed. Its text never reaches the UI.
export class PackageError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'PackageError'
  }
}

// Groups pieces, in time order, into segments of at most `maxDurationMs`
// (10 s for audio) and at most MAX_SEGMENT_BYTES. The track starts at the
// first piece, and the last segment ends at `endMs`. A piece longer or larger
// than a segment may be cannot be placed, so it is refused.
export function groupSegments(
  pieces: Piece[],
  endMs: number,
  maxDurationMs = MAX_AUDIO_SEGMENT_MS,
  track: 'audio' | 'video' = 'audio',
): { startMs: number; segments: MediaSegment[] } {
  const first = pieces[0]
  if (first === undefined) throw new PackageError('no pieces')
  for (let i = 1; i < pieces.length; i++) {
    if (pieces[i]!.startMs < pieces[i - 1]!.startMs) throw new PackageError('pieces out of order')
  }
  if (endMs <= pieces[pieces.length - 1]!.startMs) throw new PackageError('end before the last piece')
  // Encoder priming can give a tiny negative time. The track still starts at 0.
  const startMs = Math.max(0, first.startMs)
  if (startMs > MAX_FIRST_SEGMENT_START_MS) throw new PackageError(`${track} starts late`)
  // Where each piece ends: the next piece's start, or the track's end.
  const boundary = (index: number) => pieces[index + 1]?.startMs ?? endMs
  const segments: MediaSegment[] = []
  let segmentStart = startMs
  let members: Uint8Array[] = []
  let memberBytes = 0
  for (let i = 0; i < pieces.length; i++) {
    const pieceStart = i === 0 ? startMs : pieces[i]!.startMs
    const pieceBytes = pieces[i]!.bytes.length
    if (boundary(i) - pieceStart > maxDurationMs) throw new PackageError('piece too long')
    if (pieceBytes > MAX_SEGMENT_BYTES) throw new PackageError('piece too large')
    if (
      members.length > 0 &&
      (boundary(i) - segmentStart > maxDurationMs || memberBytes + pieceBytes > MAX_SEGMENT_BYTES)
    ) {
      segments.push({ durationMs: pieceStart - segmentStart, bytes: concat(members) })
      segmentStart = pieceStart
      members = []
      memberBytes = 0
    }
    members.push(pieces[i]!.bytes)
    memberBytes += pieceBytes
  }
  segments.push({ durationMs: endMs - segmentStart, bytes: concat(members) })
  return { startMs, segments }
}

// Checks a track's sizes against the format's limits. It takes sizes, not
// bytes, so a check of a 64 MiB segment needs no 64 MiB.
export function checkTrackLimits(initBytes: number, segmentBytes: number[]): void {
  if (initBytes === 0 || initBytes > MAX_CONTAINER_INIT_BYTES) throw new PackageError('init size')
  if (segmentBytes.length === 0 || segmentBytes.length > MAX_SEGMENTS) throw new PackageError('segment count')
  if (segmentBytes.some((size) => size === 0 || size > MAX_SEGMENT_BYTES)) throw new PackageError('segment size')
}

// Packages the primary audio track of `file`, whose stored type the core gave
// as `storedType`. A source without audio is refused with 'no-audio'. Any
// other failure is a PackageError.
export async function packageOriginal(file: Blob, storedType: string): Promise<PackagedTrack> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MP3] })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (track === null) throw new SourceError('no-audio')
    // Encoder priming can give a tiny negative first timestamp. That is not a
    // late start, so it does not shift the times (as in sourceDetailsFrom).
    const timelineStart = Math.max(0, await input.getFirstTimestamp())
    const codec = await track.getCodec()
    if (codec === null) throw new PackageError('unknown codec')

    const init: Uint8Array[] = []
    const pieces: Piece[] = []
    // Mediabunny may reuse its buffers, so every callback keeps a copy.
    const startPiece = (data: Uint8Array, _position: number, timestamp: number) =>
      // Rounding to a microsecond first keeps 1.5 s from becoming 1499.9999 ms.
      pieces.push({ startMs: Math.floor(Math.round(timestamp * 1e6) / 1000), bytes: data.slice() })
    const addInit = (data: Uint8Array) => {
      init.push(data.slice())
    }
    const format = outputFormat(storedType, 'audio', addInit, startPiece, (data) => {
      const piece = pieces[pieces.length - 1]
      if (piece === undefined) throw new PackageError('mdat before moof')
      piece.bytes = concat([piece.bytes, data])
    })

    const output = new Output({ format, target: new NullTarget() })
    const source = new EncodedAudioPacketSource(codec)
    output.addAudioTrack(source)
    await output.start()
    let end = 0
    let first = true
    let lastDuration = 0
    for await (const packet of new EncodedPacketSink(track).packets()) {
      const shifted = packet.clone({ timestamp: packet.timestamp - timelineStart })
      await source.add(shifted, first ? { decoderConfig: (await track.getDecoderConfig()) ?? undefined } : undefined)
      first = false
      // A WebM block need not store its length, so the last packet can have a
      // duration of 0. Audio frames keep one length, so the one before counts.
      if (shifted.duration > 0) lastDuration = shifted.duration
      end = Math.max(end, shifted.timestamp + lastDuration)
    }
    if (first) throw new PackageError('no packets')
    await output.finalize()

    const { startMs, segments } = groupSegments(pieces, Math.round(end * 1000))
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

// The container comes from the stored type the core gave (D24), so no second
// codec list is kept here. For video, every keyframe starts a Cluster or a
// fragment, so a segment can start at any keyframe.
export function outputFormat(
  storedType: string,
  kind: 'audio' | 'video',
  addInit: (data: Uint8Array) => void,
  startPiece: (data: Uint8Array, position: number, timestamp: number) => void,
  addToPiece: (data: Uint8Array) => void,
): OutputFormat {
  if (storedType.startsWith(`${kind}/webm;`)) {
    return new WebMOutputFormat({
      appendOnly: true,
      ...(kind === 'video' ? { minimumClusterDuration: 0 } : {}),
      onEbmlHeader: addInit,
      onSegmentHeader: addInit,
      onCluster: startPiece,
    })
  }
  if (storedType.startsWith(`${kind}/mp4;`)) {
    return new Mp4OutputFormat({
      fastStart: 'fragmented',
      ...(kind === 'video' ? { minimumFragmentDuration: 0 } : {}),
      onFtyp: addInit,
      onMoov: addInit,
      onMoof: startPiece,
      onMdat: addToPiece,
    })
  }
  throw new PackageError('stored type')
}

export function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
