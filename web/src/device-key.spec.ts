// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { DeviceKey, DeviceKeyFault, DeviceKeyFaultKind, devicePrfSalt, initSync } from './lyre-wasm/lyre_wasm.js'

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

  test('gives a 33 by 33 QR code of 1089 modules', () => {
    const key = new DeviceKey(PRF_OUTPUT.slice())
    const qr = key.qrCode
    expect(qr.size).toBe(33)
    expect(qr.modules).toBeInstanceOf(Uint8Array)
    expect(qr.modules).toHaveLength(1089)
    expect(qr.modules.every((module) => module <= 1)).toBe(true)
    // The top left finder pattern: a dark ring around a dark centre.
    expect(Array.from(qr.modules.slice(0, 7))).toEqual([1, 1, 1, 1, 1, 1, 1])
    qr.free()
    key.free()
  })

  test('shows only the device code, the fingerprint and the QR code', () => {
    const members = Object.getOwnPropertyNames(DeviceKey.prototype).sort()
    expect(members).toEqual(['__destroy_into_raw', 'constructor', 'deviceCode', 'fingerprint', 'free', 'qrCode'])
    const key = new DeviceKey(PRF_OUTPUT.slice())
    expect(Object.getOwnPropertyNames(key)).toEqual(['__wbg_ptr'])
    key.free()
  })
})

describe('the PRF salt', () => {
  test('is the fixed Lyre salt as UTF-8', () => {
    expect(new TextDecoder().decode(devicePrfSalt())).toBe('lyre/v1/device-key/prf')
  })
})
