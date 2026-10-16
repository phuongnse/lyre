import { describe, expect, it } from 'vitest'
import { readRecoveryPublicKey, recoveryKeyStorageKey } from './recovery-key'

// The recovery public key of the core's documented test vectors.
const KEY_HEX = '02585a2882fca9a0ee8cf896c3ac8e515402d3c85d91384bce2dce930ce3ce5307'

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function storageWith(value?: string): Storage {
  return {
    getItem: (key: string) => (key === recoveryKeyStorageKey ? (value ?? null) : null),
  } as Storage
}

describe('readRecoveryPublicKey', () => {
  it('returns the 33 bytes of a stored key', () => {
    const bytes = Uint8Array.from(KEY_HEX.match(/../g)!, (pair) => parseInt(pair, 16))
    expect(readRecoveryPublicKey(storageWith(toBase64Url(bytes)))).toEqual(bytes)
  })

  it('returns undefined when no key is stored', () => {
    expect(readRecoveryPublicKey(storageWith())).toBeUndefined()
  })

  it('returns undefined when the entry is not base64url', () => {
    expect(readRecoveryPublicKey(storageWith('not base64!'))).toBeUndefined()
  })

  it('returns undefined when the key is not 33 bytes long', () => {
    expect(readRecoveryPublicKey(storageWith(toBase64Url(new Uint8Array(32).fill(2))))).toBeUndefined()
    expect(readRecoveryPublicKey(storageWith(toBase64Url(new Uint8Array(34).fill(2))))).toBeUndefined()
  })

  it('returns undefined when the storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
    } as unknown as Storage
    expect(readRecoveryPublicKey(blocked)).toBeUndefined()
  })
})
