// What the page sends the original track worker: the source and the stored
// type the core gave its primary audio track.
export type PackageRequest = { type: 'package'; file: File; storedType: string }

// What the worker answers: a summary of the packaged track, or a failure. The
// track itself and the error's text stay in the worker.
export type PackageReply =
  { type: 'done'; storedType: string; segmentCount: number; durationMs: number } | { type: 'failed' }
