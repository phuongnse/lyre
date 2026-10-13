// What the page sends the original track worker: the source and the stored
// type the core gave its primary audio track. To make both audio tracks, it
// also sends the file that stands in for the karaoke track.
export type PackageRequest =
  | { type: 'package'; file: File; storedType: string }
  | { type: 'make-audio'; file: File; karaokeFile: File; storedType: string }

// Where a segment starts and ends on the song's timeline, in milliseconds.
export interface SegmentTimes {
  startMs: number
  endMs: number
}

// What the worker answers: a summary of the packaged track, the segment times
// of both audio tracks, or a failure. The tracks themselves and the error's
// text stay in the worker.
export type PackageReply =
  | { type: 'done'; storedType: string; segmentCount: number; durationMs: number }
  | { type: 'audio-done'; original: SegmentTimes[]; karaoke: SegmentTimes[]; songDurationMs: number }
  | { type: 'failed' }
