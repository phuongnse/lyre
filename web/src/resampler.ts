// A streaming resampler for planar audio: a windowed-sinc low-pass filter
// with a Kaiser window. It calculates each output frame from the same input
// frames and weights however the input is split, so pieces of any size give
// bit-identical output. Input before frame 0, and after the last frame once
// flushed, counts as silence.

// The Kaiser window's shape. About 8.6 keeps the stopband near -90 dB.
const KAISER_BETA = 8.6
// The filter keeps this share of the lower of the two Nyquist frequencies.
const PASSBAND = 0.95
// Zero crossings of the sinc kept on each side, at the output's cut-off.
const ZERO_CROSSINGS = 16

export class Resampler {
  // Output frame n sits at input position n * step / phases.
  private readonly phases: number
  private readonly step: number
  // The filter's half-width in input frames, and its cut-off in cycles per input frame.
  private readonly halfWidth: number
  private readonly cutoff: number
  private readonly kaiserScale: number
  // One row of 2 * halfWidth weights per phase, filled when first needed.
  private readonly rows: (Float64Array | undefined)[]
  // The input not yet used, one plane per channel. Frame `start` is first.
  private planes: Float32Array[]
  private start = 0
  private buffered = 0
  // Input frames received so far, and the next output frame.
  private received = 0
  private next = 0
  private flushed = false

  constructor(
    inputRate: number,
    outputRate: number,
    private readonly channels: number,
  ) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) {
      throw new RangeError('The sample rates must be positive whole numbers.')
    }
    const divisor = gcd(inputRate, outputRate)
    this.phases = outputRate / divisor
    this.step = inputRate / divisor
    this.cutoff = (PASSBAND / 2) * Math.min(1, outputRate / inputRate)
    this.halfWidth = Math.ceil(ZERO_CROSSINGS / (2 * this.cutoff))
    this.kaiserScale = 1 / besselI0(KAISER_BETA)
    this.rows = new Array<Float64Array | undefined>(this.phases)
    this.planes = Array.from({ length: channels }, () => new Float32Array(0))
  }

  // Takes the next input frames and returns the output frames ready so far.
  push(planes: Float32Array[]): Float32Array[] {
    if (this.flushed) throw new Error('The resampler was already flushed.')
    if (planes.length !== this.channels) throw new RangeError('The input has the wrong number of channels.')
    const frames = planes[0]?.length ?? 0
    if (this.passThrough()) {
      this.received += frames
      return planes
    }
    this.append(planes, frames)
    this.received += frames
    // Output n needs input up to frame i0 + halfWidth.
    return this.emit((i0) => i0 + this.halfWidth < this.received)
  }

  // Returns the last output frames, with silence after the input. In total
  // there are ceil(inputFrames * outputRate / inputRate) output frames.
  flush(): Float32Array[] {
    if (this.flushed) throw new Error('The resampler was already flushed.')
    this.flushed = true
    if (this.passThrough()) return this.planes.map(() => new Float32Array(0))
    const total = Math.ceil((this.received * this.phases) / this.step)
    return this.emit(() => this.next < total)
  }

  private passThrough(): boolean {
    return this.phases === this.step
  }

  private append(planes: Float32Array[], frames: number): void {
    // Drops the input that no later output needs.
    const keepFrom = Math.max(this.start, Math.floor((this.next * this.step) / this.phases) - this.halfWidth + 1)
    const drop = Math.min(keepFrom - this.start, this.buffered)
    const kept = this.buffered - drop
    const capacity = this.planes[0]?.length ?? 0
    for (let channel = 0; channel < this.channels; channel++) {
      let plane = this.planes[channel]!
      if (kept + frames > capacity) {
        const grown = new Float32Array(Math.max(kept + frames, capacity * 2))
        grown.set(plane.subarray(drop, this.buffered))
        plane = grown
        this.planes[channel] = plane
      } else if (drop > 0) {
        plane.copyWithin(0, drop, this.buffered)
      }
      plane.set(planes[channel]!, kept)
    }
    this.start += drop
    this.buffered = kept + frames
  }

  // Makes output frames while `ready` says the next one can be made.
  private emit(ready: (i0: number) => boolean): Float32Array[] {
    const out: number[][] = this.planes.map(() => [])
    const taps = 2 * this.halfWidth
    for (;;) {
      // Integer maths, so the position is exact.
      const position = this.next * this.step
      const phase = position % this.phases
      const i0 = (position - phase) / this.phases
      if (!ready(i0)) break
      const row = this.row(phase)
      // The taps cover input frames i0 - halfWidth + 1 to i0 + halfWidth.
      const first = i0 - this.halfWidth + 1
      for (let channel = 0; channel < this.channels; channel++) {
        const plane = this.planes[channel]!
        let sum = 0
        for (let tap = 0; tap < taps; tap++) {
          const frame = first + tap
          if (frame < 0 || frame >= this.received) continue
          sum += row[tap]! * plane[frame - this.start]!
        }
        out[channel]!.push(sum)
      }
      this.next++
    }
    return out.map((samples) => Float32Array.from(samples))
  }

  // The weights for output frames at `phase` / phases past an input frame.
  private row(phase: number): Float64Array {
    let row = this.rows[phase]
    if (row === undefined) {
      row = new Float64Array(2 * this.halfWidth)
      const fraction = phase / this.phases
      for (let tap = 0; tap < row.length; tap++) {
        const x = tap - this.halfWidth + 1 - fraction
        row[tap] = this.kernel(x)
      }
      this.rows[phase] = row
    }
    return row
  }

  // The filter at x input frames from the output's position.
  private kernel(x: number): number {
    const u = x / this.halfWidth
    if (Math.abs(u) >= 1) return 0
    const window = besselI0(KAISER_BETA * Math.sqrt(1 - u * u)) * this.kaiserScale
    return 2 * this.cutoff * sinc(2 * this.cutoff * x) * window
  }
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

function sinc(x: number): number {
  if (x === 0) return 1
  const y = Math.PI * x
  return Math.sin(y) / y
}

// The modified Bessel function of the first kind, order zero, from its series.
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const half = x / 2
  for (let k = 1; k < 50; k++) {
    term *= (half / k) * (half / k)
    sum += term
    if (term < sum * 1e-17) break
  }
  return sum
}
