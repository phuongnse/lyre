// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { initSync, ModelCheck } from './lyre-wasm/lyre_wasm.js'

// The 56-byte two-block test vector of FIPS 180-2.
const twoBlock = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

function check(bytes: Uint8Array): { id: string; passed: boolean } {
  const modelCheck = ModelCheck.start('test-two-block')
  if (!modelCheck) throw new Error('test-two-block is pinned')
  for (const piece of [bytes.subarray(0, 1), bytes.subarray(1, 40), bytes.subarray(40)]) {
    modelCheck.feed(piece)
  }
  const result = modelCheck.result()
  const outcome = { id: result.id, passed: result.passed }
  result.free()
  modelCheck.free()
  return outcome
}

test('the core passes the pinned bytes fed in uneven pieces', () => {
  expect(check(twoBlock)).toEqual({ id: 'test-two-block', passed: true })
})

test('the core fails the bytes with one byte changed', () => {
  const changed = twoBlock.slice()
  changed[20] ^= 0x01
  expect(check(changed)).toEqual({ id: 'test-two-block', passed: false })
})

test('the core starts no check for an unknown model', () => {
  expect(ModelCheck.start('no-such-model')).toBeUndefined()
})
