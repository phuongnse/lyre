// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { checkTiming, initSync } from '../lyre-wasm/lyre_wasm.js'
import { candidateFailure } from './measurement-messages'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

describe("the measurement worker's reply for a candidate's error", () => {
  test('is a timing failure of that candidate for a timing the song file timing check refused', () => {
    const lyrics = new TextEncoder().encode('Mưa rơi\n')
    let fault: unknown
    try {
      // An odd count of times is refused.
      checkTiming(Uint32Array.of(1), lyrics, 40_000)
    } catch (error) {
      fault = error
    }
    expect(fault).toBeDefined()
    expect(candidateFailure('test-omnilingual', fault)).toEqual({
      type: 'candidate-failed',
      candidate: 'test-omnilingual',
      problem: 'timing',
    })
  })

  test("is another failure of that candidate for any other error, without the error's text", () => {
    const reply = candidateFailure('lyric-alignment-int8', new Error('Mưa rơi'))
    expect(reply).toEqual({ type: 'candidate-failed', candidate: 'lyric-alignment-int8', problem: 'other' })
    expect(JSON.stringify(reply)).not.toContain('Mưa')
  })
})
