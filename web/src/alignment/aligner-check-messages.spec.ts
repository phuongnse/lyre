// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { checkTiming, initSync } from '../lyre-wasm/lyre_wasm.js'
import { replyForError } from './aligner-check-messages'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

describe("the aligner check worker's reply for an error", () => {
  test('is a timing problem for a timing the song file timing check refused', () => {
    const lyrics = new TextEncoder().encode('Mưa rơi\n')
    let fault: unknown
    try {
      // An odd count of times is refused.
      checkTiming(Uint32Array.of(1), lyrics, 40_000)
    } catch (error) {
      fault = error
    }
    expect(fault).toBeDefined()
    expect(replyForError(fault)).toEqual({ type: 'failed', problem: 'timing' })
  })

  test("is another problem for any other error, without the error's text", () => {
    const reply = replyForError(new Error('Mưa rơi'))
    expect(reply).toEqual({ type: 'failed', problem: 'other' })
    expect(JSON.stringify(reply)).not.toContain('Mưa')
  })
})
