import { ChunkKind, VocalRole as CoreVocalRole, SongFileFault, SongReader } from './lyre-wasm/lyre_wasm.js'

// Opens a song file through the core, following the reading model of
// docs/reference/song-file-format-v0.md: the header, then the index, then one
// chunk at a time. The whole file is never read at once. Load the core first.

const HEADER_LENGTH = 32

// The bytes of a song file. A File or a Blob is one.
export interface ByteSource {
  readonly size: number
  slice(start: number, end: number): Blob
}

// Why a file was refused. The core's own messages are not meant for users.
export type SongFileProblem = 'not-a-song-file' | 'damaged'

export class SongFileError extends Error {
  constructor(readonly problem: SongFileProblem) {
    super(problem)
    this.name = 'SongFileError'
  }
}

// One chunk: its position in the index, where it is stored and, for a media
// segment, when it plays.
export interface ChunkRef {
  position: number
  offset: number
  length: number
  startMs: number
  durationMs: number
}

export interface MediaTrack {
  init: ChunkRef
  segments: ChunkRef[]
}

// Who sings the song. A song file records one role for the whole song.
export type VocalRole = 'male' | 'female'

// The song's title, artist and composer, exactly as the song file stores them,
// and its vocal role. An empty artist or composer means not known.
export interface SongDetails {
  title: string
  artist: string
  composer: string
  vocalRole: VocalRole
}

// One syllable of the lyrics, exactly as the song file stores it (D5), with its
// timing.
export interface LyricSyllable {
  text: string
  // The exact text between the previous syllable of the same lyric line and
  // this one. It is empty for a lyric line's first syllable.
  separator: string
  // The index of the syllable's lyric line.
  lyricLine: number
  startMs: number
  endMs: number
}

// A display line: the syllables [start, end) of one lyric line. The indices
// count every syllable of the lyrics, in order.
export interface DisplayLineSpan {
  lyricLine: number
  start: number
  end: number
}

// The display lines the two rows of the Lyrics area show: positions in the list
// `layOut` returned last, or undefined for an empty row.
export interface LyricsRows {
  top: number | undefined
  bottom: number | undefined
}

export interface OpenedSong {
  // The song ID from the header, as 32 lowercase hex digits. Two files of the
  // same song share it.
  songId: string
  details: SongDetails
  durationMs: number
  video?: MediaTrack
  karaoke: MediaTrack
  original: MediaTrack
  // Every syllable of the lyrics, in lyric order.
  lyrics: LyricSyllable[]
  // Lays out the lyrics as display lines that fit `maxWidth`, through the
  // core. `widths` holds the measured width of every syllable, in order. It
  // gives no display lines when the core refuses the widths.
  layOut(widths: number[], spaceWidth: number, maxWidth: number): DisplayLineSpan[]
  // How far the highlight has swept at media time `ms`: the syllables already
  // sung, plus the fraction of the one being sung. It is 0 once closed.
  sweepPosition(ms: number): number
  // The lyric lines that have countdown dots, in order.
  countdownLines: number[]
  // The total number of countdown dots swept at media time `ms`, across every
  // countdown, with the fraction of the dot being swept. Countdown k, counting
  // from 0, shows clamp(total - 4k, 0, 4) dots swept. It is 0 once closed.
  dotsSwept(ms: number): number
  // The display lines the top and the bottom row show at media time `ms`, for the
  // latest `layOut`. Both rows are empty before a layout, after the core refused
  // one, and once closed.
  lyricsRows(ms: number): LyricsRows
  // Reads one media chunk and returns its bytes as the core gives them back.
  read(chunk: ChunkRef): Promise<Uint8Array<ArrayBuffer>>
  // Frees the core's reader. Reading after this fails.
  close(): void
}

export async function openSongFile(source: ByteSource): Promise<OpenedSong> {
  const header = await readRange(source, 0, Math.min(HEADER_LENGTH, source.size))
  const indexLength = core(() => SongReader.indexLength(header))
  const index = await readRange(source, HEADER_LENGTH, HEADER_LENGTH + indexLength)
  const reader = core(() => new SongReader(header, index, source.size))
  try {
    const chunks = reader.entries().map((entry, position) => {
      const chunk = {
        kind: entry.kind,
        position,
        offset: entry.offset,
        length: entry.length,
        startMs: entry.startMs,
        durationMs: entry.durationMs,
      }
      entry.free()
      return chunk
    })
    // The song details, the lyrics and the timing are checked before anything
    // plays. The thumbnail is not shown yet, and the original track is read only when the
    // singer switches to it.
    for (const chunk of chunks) {
      if ([ChunkKind.SongDetails, ChunkKind.Lyrics, ChunkKind.Timing].includes(chunk.kind)) {
        const bytes = await readRange(source, chunk.offset, chunk.offset + chunk.length)
        core(() => reader.readChunk(chunk.position, bytes))
      }
    }
    const read = reader.details()
    if (!read) throw new SongFileError('damaged')
    const details: SongDetails = {
      title: read.title,
      artist: read.artist,
      composer: read.composer,
      vocalRole: read.vocalRole === CoreVocalRole.Male ? 'male' : 'female',
    }
    read.free()
    const track = (init: ChunkKind, segment: ChunkKind): MediaTrack | undefined => {
      const first = chunks.find((chunk) => chunk.kind === init)
      return first && { init: first, segments: chunks.filter((chunk) => chunk.kind === segment) }
    }
    const karaoke = track(ChunkKind.KaraokeInit, ChunkKind.KaraokeSegment)
    const original = track(ChunkKind.OriginalInit, ChunkKind.OriginalSegment)
    if (!karaoke || !original) throw new SongFileError('damaged')
    const lyrics = reader.syllables().map((syllable) => {
      const copy = {
        text: syllable.text,
        separator: syllable.separator,
        lyricLine: syllable.lyricLine,
        startMs: syllable.startMs,
        endMs: syllable.endMs,
      }
      syllable.free()
      return copy
    })
    let closed = false
    return {
      songId: reader.songId,
      details,
      durationMs: reader.durationMs,
      video: track(ChunkKind.VideoInit, ChunkKind.VideoSegment),
      karaoke,
      original,
      lyrics,
      layOut(widths, spaceWidth, maxWidth) {
        if (closed) return []
        return reader.layOut(Float64Array.from(widths), spaceWidth, maxWidth).map((span) => {
          const copy = { lyricLine: span.lyricLine, start: span.start, end: span.end }
          span.free()
          return copy
        })
      },
      sweepPosition(ms) {
        return closed ? 0 : reader.sweepPosition(ms)
      },
      countdownLines: Array.from(reader.countdownLines()),
      dotsSwept(ms) {
        return closed ? 0 : reader.dotsSwept(ms)
      },
      lyricsRows(ms) {
        if (closed) return { top: undefined, bottom: undefined }
        const rows = reader.lyricsRows(ms)
        const copy = { top: rows.top, bottom: rows.bottom }
        rows.free()
        return copy
      },
      async read(chunk) {
        const bytes = await readRange(source, chunk.offset, chunk.offset + chunk.length)
        if (closed) throw new Error('The song file is closed.')
        const media = core(() => reader.readChunk(chunk.position, bytes))
        if (!media) throw new SongFileError('damaged')
        // The binding copies the bytes out of the core's memory into a plain ArrayBuffer.
        return media as Uint8Array<ArrayBuffer>
      },
      close() {
        if (!closed) {
          closed = true
          reader.free()
        }
      },
    }
  } catch (error) {
    reader.free()
    throw error
  }
}

// Reads the bytes in [start, end). A read error or a short read means the file
// is damaged or incomplete.
async function readRange(source: ByteSource, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  let buffer: ArrayBuffer
  try {
    buffer = await source.slice(start, end).arrayBuffer()
  } catch {
    throw new SongFileError('damaged')
  }
  if (buffer.byteLength !== end - start) throw new SongFileError('damaged')
  return new Uint8Array(buffer)
}

// Calls the core and turns its refusal into a SongFileError.
function core<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    if (!(error instanceof SongFileFault)) throw error
    const problem = error.notASongFile ? 'not-a-song-file' : 'damaged'
    error.free()
    throw new SongFileError(problem)
  }
}
