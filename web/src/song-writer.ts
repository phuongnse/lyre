import {
  NextChunk,
  SongWriteErrorKind,
  SongWriteFault,
  SongWriter,
  TrackKind,
  VocalRole,
} from './lyre-wasm/lyre_wasm.js'
import { SongDetailsInput, SongRefusal } from './original-track-messages'
import { PackagedTrack } from './original-track'

// Writes a song file through the core: stage 9 of processing
// (docs/domain/knowledge.md#processing). The core's writer runs every check
// the reader runs, so the web client never lays out song file bytes itself.
// The core gives the file out in pieces, which go to a sink one at a time, and
// only one media segment at a time passes through WebAssembly memory.
// The code uses no DOM, so it can run in a Web Worker.

// The name of the song file in a working area.
export const SONG_FILE = 'song.lyre'

// Where the pieces of a song file go, in file order.
export interface PieceSink {
  write(piece: Uint8Array<ArrayBuffer>): Promise<void>
}

// The core refused the song for a reason the page names. Its text never
// reaches the UI.
export class SongRefused extends Error {
  constructor(readonly reason: SongRefusal) {
    super(reason)
    this.name = 'SongRefused'
  }
}

// Writes the song file to `out` in pieces: the header and index, then each
// chunk in file order. The song's ID, details, the lyrics' bytes, the timing
// as each syllable's start and end in lyric order, and its tracks go to the
// core, which checks them all before the first piece. The lyrics' bytes go to
// the core unchanged (D5). The caller has loaded the core. A refusal the page
// names throws SongRefused.
//
// Without `encryptFor` it writes version 0 and returns nothing. With a device
// code and the owner's 33-byte compressed recovery public key it writes
// version 1 with a fresh content key made in the core, and returns the owner
// access file for that device. The content key never leaves the core. An
// invalid device code or recovery public key throws before any piece is
// written.
export async function writeSong(o: {
  songId: Uint8Array
  details: SongDetailsInput
  lyrics: Uint8Array
  timesMs: Uint32Array
  original: PackagedTrack
  karaoke: PackagedTrack
  video: PackagedTrack | null
  thumbnail: Uint8Array | null
  out: PieceSink
  encryptFor?: { deviceCode: string; recoveryPublicKey: Uint8Array }
}): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const { title, artist, composer, vocalRole } = o.details
  const role = vocalRole === 'male' ? VocalRole.Male : VocalRole.Female
  const writer = new SongWriter(o.songId, title, artist, composer, role, o.lyrics, o.timesMs)
  try {
    if (o.encryptFor) writer.encryptFor(o.encryptFor.deviceCode, o.encryptFor.recoveryPublicKey)
    if (o.thumbnail !== null) writer.setThumbnail(o.thumbnail)
    if (o.video !== null) addTrack(writer, TrackKind.Video, o.video)
    addTrack(writer, TrackKind.Karaoke, o.karaoke)
    addTrack(writer, TrackKind.Original, o.original)
    await o.out.write(plain(writer.start()))
    // Each track's media segments, in the order the core asks for them.
    const segments = {
      [NextChunk.VideoSegment]: o.video?.segments.values(),
      [NextChunk.KaraokeSegment]: o.karaoke.segments.values(),
      [NextChunk.OriginalSegment]: o.original.segments.values(),
    }
    for (;;) {
      const chunk = writer.nextChunk()
      if (chunk === NextChunk.End) break
      if (chunk === NextChunk.Core) {
        await o.out.write(plain(writer.coreChunk()))
        continue
      }
      const segment = segments[chunk]?.next().value
      if (segment === undefined) throw new Error('no segment')
      await o.out.write(plain(writer.segment(segment.bytes)))
    }
    return o.encryptFor ? plain(writer.accessFile()!) : undefined
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

// The core hands out copies in a plain ArrayBuffer, which the generated types
// do not say.
const plain = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>

// Gives the writer a track's start, stored type, init bytes and the length and
// duration of each segment. The segments' bytes go in later, one at a time.
function addTrack(writer: SongWriter, kind: TrackKind, track: PackagedTrack): void {
  writer.setTrack(kind, track.startMs, track.storedType, track.init)
  for (const segment of track.segments) writer.addSegment(kind, segment.durationMs, segment.bytes.length)
}
