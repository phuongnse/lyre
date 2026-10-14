import { SongWriteErrorKind, SongWriteFault, SongWriter, TrackKind, VocalRole } from './lyre-wasm/lyre_wasm.js'
import { SongDetailsInput, SongRefusal } from './original-track-messages'
import { PackagedTrack } from './original-track'

// Writes a song file through the core: stage 9 of processing
// (docs/domain/knowledge.md#processing). The core's writer runs every check
// the reader runs, so the web client never lays out song file bytes itself.
// The code uses no DOM, so it can run in a Web Worker.

// The core refused the song for a reason the page names. Its text never
// reaches the UI.
export class SongRefused extends Error {
  constructor(readonly reason: SongRefusal) {
    super(reason)
    this.name = 'SongRefused'
  }
}

// Writes the song file from its 16-byte song ID, its details, the lyrics'
// bytes, the timing as each syllable's start and end in lyric order, and its
// tracks. The lyrics' bytes go to the core unchanged (D5). The caller has
// loaded the core. A refusal the page names throws SongRefused.
export function writeSong(o: {
  songId: Uint8Array
  details: SongDetailsInput
  lyrics: Uint8Array
  timesMs: Uint32Array
  original: PackagedTrack
  karaoke: PackagedTrack
  video: PackagedTrack | null
  thumbnail: Uint8Array | null
}): Uint8Array {
  const { title, artist, composer, vocalRole } = o.details
  const role = vocalRole === 'male' ? VocalRole.Male : VocalRole.Female
  const writer = new SongWriter(o.songId, title, artist, composer, role, o.lyrics, o.timesMs)
  try {
    if (o.thumbnail !== null) writer.setThumbnail(o.thumbnail)
    if (o.video !== null) addTrack(writer, TrackKind.Video, o.video)
    addTrack(writer, TrackKind.Karaoke, o.karaoke)
    addTrack(writer, TrackKind.Original, o.original)
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

// Gives the writer a track's start, stored type, init bytes and segments.
function addTrack(writer: SongWriter, kind: TrackKind, track: PackagedTrack): void {
  writer.setTrack(kind, track.startMs, track.storedType, track.init)
  for (const segment of track.segments) writer.addSegment(kind, segment.durationMs, segment.bytes)
}
