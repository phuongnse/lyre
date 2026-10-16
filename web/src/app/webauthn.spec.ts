import { describe, expect, test } from 'vitest'
import { readBackupFlags } from './webauthn'

// Authenticator data of `length` bytes whose flags byte is `flags`.
function authData(flags: number, length = 37): ArrayBuffer {
  const bytes = new Uint8Array(length)
  bytes[32] = flags
  return bytes.buffer
}

describe('readBackupFlags', () => {
  test.each([
    [0x00, false, false],
    [0x08, true, false],
    [0x18, true, true],
    // UP (0x01), UV (0x04) and AT (0x40) are set, but neither backup flag.
    [0x45, false, false],
  ])('reads flags byte %i as BE %s and BS %s', (flags, eligible, state) => {
    expect(readBackupFlags(authData(flags))).toEqual({ eligible, state })
  })

  test('refuses authenticator data shorter than 37 bytes', () => {
    expect(() => readBackupFlags(authData(0x18, 36))).toThrow(RangeError)
  })
})
