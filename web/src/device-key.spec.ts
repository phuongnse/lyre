// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { DeviceKey, DeviceKeyFault, DeviceKeyFaultKind, initSync } from './lyre-wasm/lyre_wasm.js'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// Vector 2 of the device access reference: the bytes 00 to 1f.
const PRF_OUTPUT = Uint8Array.from({ length: 32 }, (_, i) => i)
const DEVICE_CODE = 'lyre1pq2czcfjxetpl79tc2t9k7l75l0xaevqdhv9g28pgd4qwvu0lqswqzflvara'
const FINGERPRINT = '1458 7998 1818 4050 3333'

function fault(run: () => unknown): DeviceKeyFault {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceKeyFault)
    return error as DeviceKeyFault
  }
  throw new Error('expected a DeviceKeyFault')
}

describe('the web device key', () => {
  test('gives the vector device code and fingerprint and zeroes the PRF output', () => {
    const prf = PRF_OUTPUT.slice()
    const key = new DeviceKey(prf)
    expect(key.deviceCode).toBe(DEVICE_CODE)
    expect(key.fingerprint).toBe(FINGERPRINT)
    expect(prf).toEqual(new Uint8Array(32))
    key.free()
  })

  test('refuses a PRF output of 31 bytes with a fault of kind PrfLength, and zeroes it', () => {
    const prf = new Uint8Array(31).fill(9)
    const refused = fault(() => new DeviceKey(prf))
    expect(refused.kind).toBe(DeviceKeyFaultKind.PrfLength)
    expect(prf).toEqual(new Uint8Array(31))
    refused.free()
  })

  test('shows only the device code and the fingerprint', () => {
    const members = Object.getOwnPropertyNames(DeviceKey.prototype).sort()
    expect(members).toEqual(['__destroy_into_raw', 'constructor', 'deviceCode', 'fingerprint', 'free'])
    const key = new DeviceKey(PRF_OUTPUT.slice())
    expect(Object.getOwnPropertyNames(key)).toEqual(['__wbg_ptr'])
    key.free()
  })
})
