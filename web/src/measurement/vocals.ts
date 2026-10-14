import { Resampler } from '../resampler'
import { mixChannels } from '../source-audio'

// The rate the aligners take.
const ALIGNER_RATE = 16_000

// Turns separated vocals, planar stereo at `rate` (the left channel, then the
// right), into the 16 kHz mono audio the aligners take.
export function vocalsForAlignment(planar: Float32Array, rate = 44_100): Float32Array {
  const frames = planar.length / 2
  const mono = mixChannels([planar.subarray(0, frames), planar.subarray(frames)], 1)
  const resampler = new Resampler(rate, ALIGNER_RATE, 1)
  const pieces = [resampler.push(mono)[0]!, resampler.flush()[0]!]
  const joined = new Float32Array(pieces[0]!.length + pieces[1]!.length)
  joined.set(pieces[0]!)
  joined.set(pieces[1]!, pieces[0]!.length)
  return joined
}
