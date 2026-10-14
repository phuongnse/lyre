// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { initSync, Separation, SeparationFault } from '../lyre-wasm/lyre_wasm.js'
import { Backend } from '../separation/backend'
import { SessionFault } from '../session-backend'
import { measureBackends, MeasurementSteps } from './measure-backends'
import { MeasurementReply, MeasurementRequest } from './measurement-messages'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

const candidates: MeasurementRequest['candidates'] = [
  { candidate: 'lyric-alignment-fp32', kind: 'lyric-alignment', graph: new Blob(), vocabulary: new Blob() },
  { candidate: 'lyric-alignment-int8', kind: 'lyric-alignment', graph: new Blob(), vocabulary: new Blob() },
]

const alignMemory = { wasmBytes: 300, heapBytes: 400 }
const separateMemory = { wasmBytes: 100, heapBytes: 200 }
// Two syllables, each a start then an end.
const timesMs = Uint32Array.of(100, 400, 500, 900)
const figures = {
  loadMs: 1,
  alignMs: 2,
  memory: alignMemory,
  timesMs,
}

// Stand-in WAV files, which name the backend that made them.
const tracksOf = (backend: Backend) => ({
  vocals: Uint8Array.of(backend === 'webgpu' ? 1 : 2),
  karaoke: Uint8Array.of(backend === 'webgpu' ? 3 : 4),
})

// Stand-in steps that succeed unless `fail` throws for the backend, or the
// backend and candidate. Each measure step gives `measuredFigures`.
function steps(
  fail: { separate?: (backend: Backend) => unknown; measure?: (candidate: string) => unknown } = {},
  measuredFigures: Awaited<ReturnType<MeasurementSteps['measure']>> = figures,
) {
  const separatedOn: Backend[] = []
  const measured: { candidate: string; backend: Backend; vocals: Float32Array }[] = []
  const result: MeasurementSteps = {
    async separate(backend) {
      separatedOn.push(backend)
      const error = fail.separate?.(backend)
      if (error !== undefined) throw error
      return {
        vocals: Float32Array.of(backend === 'webgpu' ? 1 : 2),
        tracks: tracksOf(backend),
        separateMs: 10,
        memory: separateMemory,
      }
    },
    async measure({ candidate }, backend, vocals) {
      measured.push({ candidate, backend, vocals })
      const error = fail.measure?.(candidate)
      if (error !== undefined) throw error
      return measuredFigures
    },
  }
  return { separatedOn, measured, steps: result }
}

// The fault of a separation of a sine whose model outputs NaN, which fails the
// broken-run check's not-finite rule for the vocals.
function failedBrokenRun(): unknown {
  const sine = Float32Array.from({ length: 50_000 }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44_100))
  const separation = new Separation(sine, sine)
  const spec = new Float32Array(4 * 1025 * 801).fill(NaN)
  for (let index = 0; index < separation.segmentCount; index++) {
    separation.input(index)
    separation.output(index, spec)
  }
  try {
    separation.finish().free()
  } catch (fault) {
    return fault
  } finally {
    separation.free()
  }
  throw new Error('the broken-run check passed')
}

async function run(backends: readonly Backend[], measurementSteps: MeasurementSteps): Promise<MeasurementReply[]> {
  const replies: MeasurementReply[] = []
  await measureBackends(backends, candidates, measurementSteps, (reply) => replies.push(reply))
  return replies
}

// The replies that end a candidate's run on a backend.
const ends = (replies: MeasurementReply[]) =>
  replies.filter((reply) => reply.type === 'measured' || reply.type === 'candidate-failed')

describe('a measurement on each backend', () => {
  test('separates once per backend and measures every candidate on that backend, in order', async () => {
    const { separatedOn, measured, steps: fake } = steps()
    const replies = await run(['webgpu', 'wasm'], fake)
    expect(separatedOn).toEqual(['webgpu', 'wasm'])
    expect(measured.map(({ candidate, backend }) => `${candidate} ${backend}`)).toEqual([
      'lyric-alignment-fp32 webgpu',
      'lyric-alignment-int8 webgpu',
      'lyric-alignment-fp32 wasm',
      'lyric-alignment-int8 wasm',
    ])
    // Each backend's candidates run on its own vocals.
    expect(measured.map(({ vocals }) => vocals[0])).toEqual([1, 1, 2, 2])
    expect(replies.filter((reply) => reply.type === 'separated')).toEqual([
      { type: 'separated', backend: 'webgpu', separateMs: 10, memory: separateMemory },
      { type: 'separated', backend: 'wasm', separateMs: 10, memory: separateMemory },
    ])
    expect(replies.filter((reply) => reply.type === 'stage')).toEqual([
      { type: 'stage', stage: 'separate', backend: 'webgpu' },
      { type: 'stage', stage: 'align', backend: 'webgpu', candidate: 'lyric-alignment-fp32' },
      { type: 'stage', stage: 'align', backend: 'webgpu', candidate: 'lyric-alignment-int8' },
      { type: 'stage', stage: 'separate', backend: 'wasm' },
      { type: 'stage', stage: 'align', backend: 'wasm', candidate: 'lyric-alignment-fp32' },
      { type: 'stage', stage: 'align', backend: 'wasm', candidate: 'lyric-alignment-int8' },
    ])
    expect(ends(replies)).toEqual([
      { type: 'measured', candidate: 'lyric-alignment-fp32', backend: 'webgpu', ...figures },
      { type: 'measured', candidate: 'lyric-alignment-int8', backend: 'webgpu', ...figures },
      { type: 'measured', candidate: 'lyric-alignment-fp32', backend: 'wasm', ...figures },
      { type: 'measured', candidate: 'lyric-alignment-int8', backend: 'wasm', ...figures },
    ])
  })

  test('gives a candidate whose session fails to open the model reason, and still measures the next one', async () => {
    const { steps: fake } = steps({
      measure: (candidate) => (candidate === 'lyric-alignment-fp32' ? new SessionFault('model') : undefined),
    })
    expect(ends(await run(['wasm'], fake))).toEqual([
      {
        type: 'candidate-failed',
        candidate: 'lyric-alignment-fp32',
        backend: 'wasm',
        ran: true,
        problem: { kind: 'model' },
      },
      { type: 'measured', candidate: 'lyric-alignment-int8', backend: 'wasm', ...figures },
    ])
  })

  test('marks every candidate on a backend whose separation failed as not run, with its reason, and measures the next backend', async () => {
    const { measured, steps: fake } = steps({
      separate: (backend) => (backend === 'webgpu' ? new SessionFault('webgpu-unavailable') : undefined),
    })
    const replies = await run(['webgpu', 'wasm'], fake)
    const problem = { kind: 'webgpu-unavailable' }
    expect(ends(replies)).toEqual([
      { type: 'candidate-failed', candidate: 'lyric-alignment-fp32', backend: 'webgpu', ran: false, problem },
      { type: 'candidate-failed', candidate: 'lyric-alignment-int8', backend: 'webgpu', ran: false, problem },
      { type: 'measured', candidate: 'lyric-alignment-fp32', backend: 'wasm', ...figures },
      { type: 'measured', candidate: 'lyric-alignment-int8', backend: 'wasm', ...figures },
    ])
    expect(measured.every(({ backend }) => backend === 'wasm')).toBe(true)
  })

  test('marks every candidate on WebGPU as not run with the broken-run rule and value when the separation there fails it, and measures WebAssembly', async () => {
    const fault = failedBrokenRun()
    expect(fault).toBeInstanceOf(SeparationFault)
    const { steps: fake } = steps({ separate: (backend) => (backend === 'webgpu' ? fault : undefined) })
    const replies = ends(await run(['webgpu', 'wasm'], fake))
    expect(replies.slice(0, 2)).toEqual(
      ['lyric-alignment-fp32', 'lyric-alignment-int8'].map((candidate) => ({
        type: 'candidate-failed',
        candidate,
        backend: 'webgpu',
        ran: false,
        problem: { kind: 'broken-run', rule: 'vocals-not-finite', value: 0 },
      })),
    )
    expect(replies.slice(2).map((reply) => [reply.type, reply.backend])).toEqual([
      ['measured', 'wasm'],
      ['measured', 'wasm'],
    ])
  })

  test("sends each backend's tracks right after its separation figures, and none for a separation that failed", async () => {
    const { steps: fake } = steps({
      separate: (backend) => (backend === 'webgpu' ? new SessionFault('webgpu-unavailable') : undefined),
    })
    const replies = await run(['webgpu', 'wasm'], fake)
    const separatedAt = replies.findIndex((reply) => reply.type === 'separated')
    expect(replies[separatedAt]).toMatchObject({ type: 'separated', backend: 'wasm' })
    expect(replies[separatedAt + 1]).toEqual({ type: 'tracks', backend: 'wasm', ...tracksOf('wasm') })
    expect(replies.filter((reply) => reply.type === 'tracks')).toHaveLength(1)
  })

  test('sends the tracks of every backend that separated, each after its own figures', async () => {
    const { steps: fake } = steps()
    const replies = await run(['webgpu', 'wasm'], fake)
    expect(
      replies
        .filter((reply) => reply.type === 'separated' || reply.type === 'tracks')
        .map((reply) => [reply.type, reply.backend]),
    ).toEqual([
      ['separated', 'webgpu'],
      ['tracks', 'webgpu'],
      ['separated', 'wasm'],
      ['tracks', 'wasm'],
    ])
    for (const backend of ['webgpu', 'wasm'] as const) {
      const at = replies.findIndex((reply) => reply.type === 'separated' && reply.backend === backend)
      expect(replies[at + 1]).toEqual({ type: 'tracks', backend, ...tracksOf(backend) })
    }
  })

  test('with WebAssembly forced, measures only WebAssembly', async () => {
    const { separatedOn, measured, steps: fake } = steps()
    await run(['wasm'], fake)
    expect(separatedOn).toEqual(['wasm'])
    expect(measured.every(({ backend }) => backend === 'wasm')).toBe(true)
  })
})
