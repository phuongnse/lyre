import {
  ChunkKind,
  DeviceKey,
  VocalRole as CoreVocalRole,
  SongFileFault,
  SongFileFaultKind,
  SongReader,
  ShareFault,
  ShareFaultKind,
} from './lyre-wasm/lyre_wasm.js'

// Opens a song file through the core, following the reading model of
// docs/reference/song-file-format-v0.md and, for version 1,
// docs/reference/song-file-format-v1.md#reading-model: the header, then the
// index, then one chunk at a time. The whole file is never read at once. Load
// the core first.

// The bytes every header start with: enough to tell the version and its header length.
const HEADER_START_LENGTH = 32

// The bytes of a song file. A File or a Blob is one.
export interface ByteSource {
  readonly size: number
  slice(start: number, end: number): Blob
}

// Why a file was refused. The core's own messages are not meant for users.
export type SongFileProblem = 'not-a-song-file' | 'damaged' | 'cannot-open' | 'old-version'

// What a version-1 song file needs to open: the access files the owner chose,
// and this page load's device key. `key` resolves to undefined when the device
// is not unlocked. It is the core's opaque handle and is never freed here.
export interface DeviceAccess {
  files: readonly Blob[]
  key: () => Promise<DeviceKey | undefined>
}

export class SongFileError extends Error {
  constructor(readonly problem: SongFileProblem) {
    super(problem)
    this.name = 'SongFileError'
  }
}

// Why a song could not be shared: the device code is not valid, or the core
// could not make the access file.
export type ShareProblem = 'invalid-code' | 'failed'

export class ShareError extends Error {
  constructor(readonly problem: ShareProblem) {
    super(problem)
    this.name = 'ShareError'
  }
}

// What sharing gives: the other device's fingerprint, to compare with the one
// that device shows, and a recipient access file for it.
export interface SharedAccess {
  fingerprint: string
  accessFile: Blob
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
  // The MSE type the song file stores for the track, such as
  // 'video/webm; codecs="vp09.00.40.08"'.
  type: string
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
  // The access file that opened a version-1 song file. A version-0 file has none.
  accessFile?: Blob
  // Shares the song with the device that has this device code, through the
  // core. It is there only for a song opened with an owner access file. It
  // rejects with a ShareError.
  share?(deviceCode: string): Promise<SharedAccess>
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
  // Reads one media chunk and returns its bytes as the core gives them back. For
  // an init segment, these are the container's init bytes, without the stored type.
  read(chunk: ChunkRef): Promise<Uint8Array<ArrayBuffer>>
  // Frees the core's reader. Reading after this fails.
  close(): void
}

// Opens a song file. A version-1 file opens with the first of the `access`
// files that fits it and this device's key. A version-0 file is refused as
// 'old-version' when `access` is given. Only a song given to the Player through
// its input, from the check pages, opened without `access`, may still be
// version 0.
export async function openSongFile(source: ByteSource, access?: DeviceAccess): Promise<OpenedSong> {
  let header = await readRange(source, 0, Math.min(HEADER_START_LENGTH, source.size))
  const headerLength = core(() => SongReader.headerLength(header))
  // A version-1 file cut short in its header or index cannot be opened, as it
  // cannot be told from one that fails its tag.
  const shortRead: SongFileProblem = headerLength === HEADER_START_LENGTH ? 'damaged' : 'cannot-open'
  // Only a song given to the Player through its input, opened without device
  // access, may still be version 0. The check comes before any access file is
  // read or any unlock.
  if (headerLength === HEADER_START_LENGTH && access) throw new SongFileError('old-version')
  if (headerLength > header.length) header = await readRange(source, 0, headerLength, shortRead)
  const indexLength = core(() => SongReader.indexLength(header))
  const index = await readRange(source, headerLength, headerLength + indexLength, shortRead)
  let reader: SongReader
  let accessFile: Blob | undefined
  let deviceKey: DeviceKey | undefined
  if (headerLength === HEADER_START_LENGTH) {
    reader = core(() => new SongReader(header, index, source.size))
  } else {
    // No access file can open it, so the owner is not asked to unlock for nothing.
    if (!access || access.files.length === 0) throw new SongFileError('cannot-open')
    const key = await access.key()
    if (!key) throw new SongFileError('cannot-open')
    const opened = await openEncrypted(header, index, source.size, key, access.files)
    reader = opened.reader
    accessFile = opened.accessFile
    deviceKey = key
  }
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
    // The song details, the lyrics, the timing and each track's init chunk, which
    // holds its stored type, are checked before anything plays. The thumbnail is not
    // shown yet, and the original track's segments are read only when the singer
    // switches to it.
    const checked = [
      ChunkKind.SongDetails,
      ChunkKind.Lyrics,
      ChunkKind.Timing,
      ChunkKind.VideoInit,
      ChunkKind.KaraokeInit,
      ChunkKind.OriginalInit,
    ]
    for (const chunk of chunks) {
      if (checked.includes(chunk.kind)) {
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
      if (!first) return undefined
      const type = reader.storedType(first.position)
      if (type === undefined) throw new SongFileError('damaged')
      return { type, init: first, segments: chunks.filter((chunk) => chunk.kind === segment) }
    }
    const video = track(ChunkKind.VideoInit, ChunkKind.VideoSegment)
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
    const owner = reader.isOwner
    const ownerFile = accessFile
    const ownerKey = deviceKey
    return {
      songId: reader.songId,
      accessFile,
      share:
        owner && ownerFile && ownerKey
          ? async (deviceCode) => {
              if (closed) throw new ShareError('failed')
              let bytes: Uint8Array
              try {
                bytes = new Uint8Array(await ownerFile.arrayBuffer())
              } catch {
                throw new ShareError('failed')
              }
              if (closed) throw new ShareError('failed')
              try {
                const shared = reader.share(ownerKey, bytes, deviceCode)
                const copy = {
                  fingerprint: shared.fingerprint,
                  accessFile: new Blob([Uint8Array.from(shared.accessFile)]),
                }
                shared.free()
                return copy
              } catch (error) {
                if (!(error instanceof ShareFault)) throw error
                const problem = error.kind === ShareFaultKind.DeviceCode ? 'invalid-code' : 'failed'
                error.free()
                throw new ShareError(problem)
              }
            }
          : undefined,
      details,
      durationMs: reader.durationMs,
      video,
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

// Tries each access file in order. A refusal to open means the file does not
// fit this song or this device, so the next one is tried. Any other fault
// ends the attempt.
async function openEncrypted(
  header: Uint8Array<ArrayBuffer>,
  index: Uint8Array<ArrayBuffer>,
  fileSize: number,
  key: DeviceKey,
  files: readonly Blob[],
): Promise<{ reader: SongReader; accessFile: Blob }> {
  for (const accessFile of files) {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await accessFile.arrayBuffer())
    } catch {
      continue
    }
    try {
      return { reader: SongReader.openEncrypted(header, index, fileSize, key, bytes), accessFile }
    } catch (error) {
      if (!(error instanceof SongFileFault)) throw error
      const cannotOpen = error.kind === SongFileFaultKind.CannotOpen
      const problem = problemOf(error)
      error.free()
      if (!cannotOpen) throw new SongFileError(problem)
    }
  }
  throw new SongFileError('cannot-open')
}

// Reads the bytes in [start, end). A read error or a short read means the file
// is damaged or incomplete, unless the caller names another problem.
async function readRange(
  source: ByteSource,
  start: number,
  end: number,
  problem: SongFileProblem = 'damaged',
): Promise<Uint8Array<ArrayBuffer>> {
  let buffer: ArrayBuffer
  try {
    buffer = await source.slice(start, end).arrayBuffer()
  } catch {
    throw new SongFileError(problem)
  }
  if (buffer.byteLength !== end - start) throw new SongFileError(problem)
  return new Uint8Array(buffer)
}

// Calls the core and turns its refusal into a SongFileError.
function core<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    if (!(error instanceof SongFileFault)) throw error
    const problem = problemOf(error)
    error.free()
    throw new SongFileError(problem)
  }
}

function problemOf(fault: SongFileFault): SongFileProblem {
  if (fault.kind === SongFileFaultKind.CannotOpen) return 'cannot-open'
  if (fault.kind === SongFileFaultKind.OldVersion) return 'old-version'
  return fault.notASongFile ? 'not-a-song-file' : 'damaged'
}
