// What the page sends the original track worker: the source and the stored
// type the core gave its primary audio track. To make the tracks, it also
// sends the file that stands in for the karaoke track, and the stored type the
// core gave the primary video track, if any. To make the thumbnail, it sends
// only the source.
export type PackageRequest =
  | { type: 'package'; file: File; storedType: string }
  | { type: 'thumbnail'; file: File }
  | { type: 'make-audio'; file: File; karaokeFile: File; storedType: string; videoType?: string }

// Where a segment starts and ends on the song's timeline, in milliseconds.
export interface SegmentTimes {
  startMs: number
  endMs: number
}

// Why a source's video is refused, for the page to name in its message.
export type VideoRefusal = 'keyframe gap' | 'group too large'

// What the worker answers: a summary of the packaged track, the segment times
// of the tracks made, the thumbnail's JPEG bytes (null when the source gives
// none), or a failure. The tracks themselves stay in the worker.
// A failure carries only one of the VideoRefusal codes, never the error's
// text.
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
  | { type: 'failed'; reason?: VideoRefusal }
