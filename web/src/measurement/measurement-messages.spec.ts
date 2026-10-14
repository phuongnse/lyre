// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AlignmentRunError } from '../alignment/align-song'
import {
  align,
  AlignerWindows,
  AlignmentFault,
  checkTiming,
  initSync,
  Separation,
  SeparationFault,
  WindowFault,
} from '../lyre-wasm/lyre_wasm.js'
import { SessionFault } from '../session-backend'
import { runProblem } from './measurement-messages'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// What `run` threw.
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('nothing was thrown')
}

describe("the measurement worker's reason for a failed run", () => {
  test.each(['webgpu-unavailable', 'model', 'out-of-memory'] as const)(
    'is the session\'s own reason "%s" for a session that could not open',
    (problem) => {
      expect(runProblem(new SessionFault(problem))).toEqual({ kind: problem })
    },
  )

  test('is another failure for a separation step the core refused', () => {
    const fault = thrown(() => new Separation(new Float32Array(3), new Float32Array(2)))
    expect(fault).toBeInstanceOf(SeparationFault)
    expect(runProblem(fault)).toEqual({ kind: 'other' })
  })

  test('is a timing failure for a timing the song file timing check refused', () => {
    const lyrics = new TextEncoder().encode('Mưa rơi\n')
    // An odd count of times is refused.
    const fault = thrown(() => checkTiming(Uint32Array.of(1), lyrics, 40_000))
    expect(runProblem(fault)).toEqual({ kind: 'timing' })
  })

  test('is a refused alignment for an alignment the core refused', () => {
    // Lyrics that are not UTF-8 are refused.
    const fault = thrown(() => align(Uint8Array.of(0xff), new Float32Array(2), ['<blank>', 'a'], 0, 20_000, 1_000))
    expect(fault).toBeInstanceOf(AlignmentFault)
    expect(runProblem(fault)).toEqual({ kind: 'alignment-refused' })
  })

  test('is a refused alignment for a window step the core refused', () => {
    // No audio has no windows.
    const fault = thrown(() => new AlignerWindows(new Float32Array(0), 2))
    expect(fault).toBeInstanceOf(WindowFault)
    expect(runProblem(fault)).toEqual({ kind: 'alignment-refused' })
  })

  test("is a refused alignment for a model's output the core could not read", () => {
    expect(runProblem(new AlignmentRunError('output'))).toEqual({ kind: 'alignment-refused' })
  })

  test('is running out of memory for a RangeError', () => {
    expect(runProblem(new RangeError('Mưa rơi'))).toEqual({ kind: 'out-of-memory' })
  })

  test('is another failure for any other error', () => {
    expect(runProblem(new Error('Mưa rơi'))).toEqual({ kind: 'other' })
  })

  test.each([new RangeError('Mưa rơi'), new AlignmentRunError('output'), new Error('Mưa rơi')])(
    "never holds the error's text",
    (error) => {
      expect(JSON.stringify(runProblem(error))).not.toContain('Mưa')
    },
  )
})
