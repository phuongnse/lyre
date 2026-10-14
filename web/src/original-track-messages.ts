// What the page sends the original track worker: the source and the stored
// type the core gave its primary audio track. To make the tracks, it also
// sends the file that stands in for the karaoke track, and the stored type the
// core gave the primary video track, if any. To make the thumbnail, it sends
// only the source. To make the song file, it also sends the lyrics and timing
// files, a random 16-byte song ID, the song's details, and the page's base URI
// to load the core from.
export type PackageRequest =
  | { type: 'package'; file: File; storedType: string }
  | { type: 'thumbnail'; file: File }
  | { type: 'make-audio'; file: File; karaokeFile: File; storedType: string; videoType?: string }
  | {
      type: 'make-song'
      baseUri: string
      file: File
      karaokeFile: File
      lyrics: File
      timing: File
      storedType: string
      videoType?: string
      songId: Uint8Array
      details: SongDetailsInput
    }

// The song's details, exactly as the song file stores them. An empty artist
// or composer means not known.
export interface SongDetailsInput {
  title: string
  artist: string
  composer: string
  vocalRole: VocalRole
}

export type VocalRole = 'male' | 'female'

// Where a segment starts and ends on the song's timeline, in milliseconds.
export interface SegmentTimes {
  startMs: number
  endMs: number
}

// Why a source's video is refused, for the page to name in its message.
export type VideoRefusal = 'keyframe gap' | 'group too large'

// Why the core refused a song: lyrics that are not valid, a timing file that
// does not fit the lyrics, or a timing that ends after the song.
export type SongRefusal = 'lyrics' | 'timing-file' | 'past-end'

// What the worker answers: a summary of the packaged track, the segment times
// of the tracks made, the thumbnail's JPEG bytes (null when the source gives
// none), the song file's bytes, or a failure. The tracks themselves stay in
// the worker. A failure carries only one of the VideoRefusal or SongRefusal
// codes, never the error's text.
export type PackageReply =
  | { type: 'done'; storedType: string; segmentCount: number; durationMs: number }
  | {
      type: 'audio-done'
      original: SegmentTimes[]
      karaoke: SegmentTimes[]
      video?: SegmentTimes[]
      songDurationMs: number
    }
  | { type: 'thumbnail-done'; bytes: Uint8Array | null }
  | { type: 'song-done'; bytes: Uint8Array }
  | { type: 'failed'; reason?: VideoRefusal | SongRefusal }
