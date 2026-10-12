import { ChunkKind, SongFileFault, SongReader } from './lyre-wasm/lyre_wasm.js'

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

export interface OpenedSong {
  durationMs: number
  video?: MediaTrack
  karaoke: MediaTrack
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
    // plays. The thumbnail is not shown yet, and the original track is not played.
    for (const chunk of chunks) {
      if ([ChunkKind.SongDetails, ChunkKind.Lyrics, ChunkKind.Timing].includes(chunk.kind)) {
        const bytes = await readRange(source, chunk.offset, chunk.offset + chunk.length)
        core(() => reader.readChunk(chunk.position, bytes))
      }
    }
    const track = (init: ChunkKind, segment: ChunkKind): MediaTrack | undefined => {
      const first = chunks.find((chunk) => chunk.kind === init)
      return first && { init: first, segments: chunks.filter((chunk) => chunk.kind === segment) }
    }
    const karaoke = track(ChunkKind.KaraokeInit, ChunkKind.KaraokeSegment)
    if (!karaoke) throw new SongFileError('damaged')
    let closed = false
    return {
      durationMs: reader.durationMs,
      video: track(ChunkKind.VideoInit, ChunkKind.VideoSegment),
      karaoke,
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
