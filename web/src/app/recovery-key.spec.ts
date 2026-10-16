import { describe, expect, it } from 'vitest'
import { keepRecoveryPublicKey, readRecoveryPublicKey, recoveryKeyStorageKey } from './recovery-key'

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

  it('returns undefined when the entry has whitespace or padding', () => {
    const bytes = Uint8Array.from(KEY_HEX.match(/../g)!, (pair) => parseInt(pair, 16))
    const stored = toBase64Url(bytes)
    expect(readRecoveryPublicKey(storageWith(`${stored.slice(0, 20)} ${stored.slice(20)}`))).toBeUndefined()
    expect(readRecoveryPublicKey(storageWith(`${stored}\n`))).toBeUndefined()
    expect(readRecoveryPublicKey(storageWith(`${stored}=`))).toBeUndefined()
  })

  it('returns undefined when the entry uses the standard base64 characters', () => {
    const bytes = new Uint8Array(33).fill(0xfb)
    const standard = btoa(String.fromCharCode(...bytes))
    expect(standard).toMatch(/[+/]/)
    expect(readRecoveryPublicKey(storageWith(toBase64Url(bytes)))).toEqual(bytes)
    expect(readRecoveryPublicKey(storageWith(standard))).toBeUndefined()
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

// A lock manager that runs one request at a time, as the browser's does for one name.
function serialLocks(): LockManager {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    request: (_name: string, callback: () => unknown) => {
      const run = tail.then(callback)
      tail = run.catch(() => undefined)
      return run
    },
  } as unknown as LockManager
}

// A storage that keeps its entries in a map and records each value written.
function fakeStorage(stored: Map<string, string>, writes: string[]): Storage {
  return {
    setItem: (key: string, value: string) => {
      writes.push(value)
      stored.set(key, value)
    },
    getItem: (key: string) => stored.get(key) ?? null,
  } as unknown as Storage
}

describe('keepRecoveryPublicKey', () => {
  const locks = serialLocks()

  it('writes base64url that readRecoveryPublicKey reads back', async () => {
    const bytes = Uint8Array.from(KEY_HEX.match(/../g)!, (pair) => parseInt(pair, 16))
    const written = new Map<string, string>()
    const storage = {
      setItem: (key: string, value: string) => void written.set(key, value),
      getItem: (key: string) => written.get(key) ?? null,
    } as unknown as Storage
    expect(await keepRecoveryPublicKey(bytes, storage, locks)).toBe('kept')
    expect([...written.keys()]).toEqual([recoveryKeyStorageKey])
    expect(written.get(recoveryKeyStorageKey)).toBe(toBase64Url(bytes))
    expect(written.get(recoveryKeyStorageKey)).toMatch(/^[A-Za-z0-9_-]{44}$/)
    expect(readRecoveryPublicKey(storage)).toEqual(bytes)
  })

  it('reports a failure when the storage is blocked', async () => {
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('blocked', 'QuotaExceededError')
      },
    } as unknown as Storage
    expect(await keepRecoveryPublicKey(new Uint8Array(33).fill(2), blocked, locks)).toBe('failed')
  })

  it('reports a failure when the browser has no Web Locks, and writes nothing', async () => {
    const stored = new Map<string, string>()
    const writes: string[] = []
    expect(await keepRecoveryPublicKey(new Uint8Array(33).fill(2), fakeStorage(stored, writes), undefined)).toBe(
      'failed',
    )
    expect(writes).toEqual([])
  })

  it('never replaces a key that is already kept', async () => {
    const first = new Uint8Array(33).fill(2)
    const second = new Uint8Array(33).fill(3)
    const stored = new Map<string, string>()
    const storage = fakeStorage(stored, [])
    expect(await keepRecoveryPublicKey(first, storage, locks)).toBe('kept')
    expect(await keepRecoveryPublicKey(second, storage, locks)).toBe('exists')
    expect(readRecoveryPublicKey(storage)).toEqual(first)
  })

  it('keeps one key when two confirmations overlap', async () => {
    const first = new Uint8Array(33).fill(2)
    const second = new Uint8Array(33).fill(3)
    const stored = new Map<string, string>()
    const writes: string[] = []
    const storage = fakeStorage(stored, writes)
    const results = await Promise.all([
      keepRecoveryPublicKey(first, storage, locks),
      keepRecoveryPublicKey(second, storage, locks),
    ])
    expect(results).toEqual(['kept', 'exists'])
    expect(writes).toEqual([toBase64Url(first)])
    expect(readRecoveryPublicKey(storage)).toEqual(first)
  })
})
