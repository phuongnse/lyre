import { AudioSampleSink, BlobSource, Input, MP3, MP4, WEBM } from 'mediabunny'
import { Resampler } from './resampler'
import { SourceError } from './source-error'

// Decodes a source's audio: stage 2 of processing
// (docs/domain/knowledge.md#processing). It decodes through WebCodecs, piece
// by piece, so neither the source nor its decoded audio is held whole. Time
// counts from the timeline's start. The code uses no DOM, so it can run in a
// Web Worker.

// The rate and channel count a stage asks for.
export interface AudioFormat {
  sampleRate: number
  channels: 1 | 2
}

export const SEPARATION_FORMAT: AudioFormat = { sampleRate: 44100, channels: 2 }
export const ALIGNMENT_FORMAT: AudioFormat = { sampleRate: 16000, channels: 1 }

// Yields the audio in `format` as planar pieces, one plane per channel. A
// source whose audio this browser cannot decode is refused with 'no-audio'
// before anything is decoded.
export async function* decodeAudio(file: Blob, format: AudioFormat): AsyncGenerator<Float32Array[]> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MP3] })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (track === null || !(await track.canDecode())) throw new SourceError('no-audio')
    // Encoder priming can give a tiny negative first timestamp. That is not a
    // late start, so it does not shift the times (as in sourceDetailsFrom).
    const timelineStart = Math.max(0, await input.getFirstTimestamp())
    let placement: Placement | undefined
    let resampler: Resampler | undefined
    let inputRate = 0
    for await (const sample of new AudioSampleSink(track).samples()) {
      let planes: Float32Array[]
      let timestamp: number
      try {
        if (resampler === undefined) {
          inputRate = sample.sampleRate
          placement = new Placement(timelineStart, inputRate)
          resampler = new Resampler(inputRate, format.sampleRate, format.channels)
        } else if (sample.sampleRate !== inputRate) {
          throw new SourceError('unreadable')
        }
        timestamp = sample.timestamp
        planes = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
          const plane = new Float32Array(sample.numberOfFrames)
          sample.copyTo(plane, { planeIndex, format: 'f32-planar' })
          return plane
        })
      } finally {
        sample.close()
      }
      const placed = placement!.place(timestamp, mixChannels(planes, format.channels))
      const out = resampler.push(placed)
      if (frameCount(out) > 0) yield out
    }
    if (resampler !== undefined) {
      const tail = resampler.flush()
      if (frameCount(tail) > 0) yield tail
    }
  } catch (error) {
    // The error's own text is never shown, and it may hold parts of the file.
    if (error instanceof SourceError) throw error
    throw new SourceError('unreadable')
  } finally {
    input.dispose()
  }
}

// Mixes planar audio to `channels`. Mono becomes stereo by copying its one
// channel. Two or more channels become mono by averaging them all. Three or
// more become stereo by keeping the first two.
export function mixChannels(planes: Float32Array[], channels: 1 | 2): Float32Array[] {
  if (planes.length === channels) return planes
  if (channels === 2) {
    const [first, second] = planes as [Float32Array, ...Float32Array[]]
    return [first, second ?? first.slice()]
  }
  const frames = planes[0]?.length ?? 0
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (const plane of planes) sum += plane[frame]!
    mono[frame] = sum / planes.length
  }
  return [mono]
}

// Places decoded pieces on a timeline that starts at zero. A piece that starts
// after what was written so far gets silence before it. Frames before what was
// written, or before zero, are dropped.
export class Placement {
  private written = 0

  constructor(
    private readonly timelineStart: number,
    private readonly sampleRate: number,
  ) {}

  place(timestamp: number, planes: Float32Array[]): Float32Array[] {
    const expected = Math.round((timestamp - this.timelineStart) * this.sampleRate)
    const frames = planes[0]?.length ?? 0
    let placed = planes
    // A difference of one frame is rounding, not a gap.
    if (expected > this.written + 1) {
      const silence = expected - this.written
      placed = planes.map((plane) => {
        const padded = new Float32Array(silence + frames)
        padded.set(plane, silence)
        return padded
      })
    } else if (expected < this.written) {
      const overlap = Math.min(this.written - expected, frames)
      placed = planes.map((plane) => plane.subarray(overlap))
    }
    this.written += placed[0]?.length ?? 0
    return placed
  }
}

function frameCount(planes: Float32Array[]): number {
  return planes[0]?.length ?? 0
}
