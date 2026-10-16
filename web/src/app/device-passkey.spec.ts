// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { devicePrfSalt, initSync } from '../lyre-wasm/lyre_wasm.js'
import { credentialStorageKey, keepFirstReady, unlockDevice as unlock } from './device-passkey'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// Vector 2 of the device access reference: the bytes 00 to 1f.
const DEVICE_CODE = 'lyre1pq2czcfjxetpl79tc2t9k7l75l0xaevqdhv9g28pgd4qwvu0lqswqzflvara'
const FINGERPRINT = '1458 7998 1818 4050 3333'
const RAW_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
// The base64url of RAW_ID.
const STORED_ID = 'AQIDBAUGBwgJCgsMDQ4PEA'

function authData(flags: number): ArrayBuffer {
  const bytes = new Uint8Array(37)
  bytes[32] = flags
  return bytes.buffer
}

type Fake = {
  credentials: CredentialsContainer
  create: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  output: Uint8Array
}

// A stand-in for navigator.credentials. Its passkey has `createFlags` when made
// and `getFlags` when it signs in, and gives `prf` as its PRF output.
function fake({ createFlags = 0x45, getFlags = 0x45, prf = 'vector' as 'vector' | 'none' | 'empty' } = {}): Fake {
  const output = prf === 'empty' ? new Uint8Array(0) : Uint8Array.from({ length: 32 }, (_, i) => i)
  const create = vi.fn(async () => ({
    rawId: RAW_ID.buffer.slice(0),
    response: { getAuthenticatorData: () => authData(createFlags) },
  }))
  const get = vi.fn(async () => ({
    rawId: RAW_ID.buffer.slice(0),
    response: { authenticatorData: authData(getFlags) },
    getClientExtensionResults: () => ({ prf: prf === 'none' ? {} : { results: { first: output } } }),
  }))
  return { credentials: { create, get } as unknown as CredentialsContainer, create, get, output }
}

function memoryStorage(initial?: string): Storage {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(credentialStorageKey, initial)
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  }
}

// The test starts the WebAssembly module itself, so the loader does nothing.
const unlockDevice = (credentials: CredentialsContainer, storage: Storage) =>
  unlock(credentials, storage, () => Promise.resolve())

describe('unlockDevice', () => {
  test('the first run creates a passkey, shows the device code and keeps only its ID', async () => {
    const { credentials, create, get, output } = fake()
    const storage = memoryStorage()
    const { outcome, key } = await unlockDevice(credentials, storage)
    expect(outcome).toMatchObject({ result: 'ready', deviceCode: DEVICE_CODE, fingerprint: FINGERPRINT })
    expect(outcome.result === 'ready' && outcome.qr.size).toBe(33)
    expect(outcome.result === 'ready' && outcome.qr.modules).toHaveLength(1089)
    expect(key?.deviceCode).toBe(DEVICE_CODE)
    expect(create).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(1)
    expect(storage.getItem(credentialStorageKey)).toBe(STORED_ID)
    expect(storage.length).toBe(1)
    expect(output).toEqual(new Uint8Array(32))
  })

  test('a stored ID skips creating a passkey and asks that passkey', async () => {
    const { credentials, create, get } = fake()
    const { outcome } = await unlockDevice(credentials, memoryStorage(STORED_ID))
    expect(outcome.result).toBe('ready')
    expect(create).not.toHaveBeenCalled()
    const options = get.mock.calls[0][0] as CredentialRequestOptions
    expect(Array.from(new Uint8Array(options.publicKey!.allowCredentials![0].id as ArrayBuffer))).toEqual(
      Array.from(RAW_ID),
    )
    expect(options.publicKey!.userVerification).toBe('required')
  })

  test('asks for the PRF output with the core salt', async () => {
    const { credentials, get } = fake()
    await unlockDevice(credentials, memoryStorage())
    const options = get.mock.calls[0][0] as CredentialRequestOptions
    const extensions = options.publicKey!.extensions as { prf: { eval: { first: Uint8Array } } }
    expect(extensions.prf.eval.first).toEqual(devicePrfSalt())
  })

  test('creates a platform passkey that is resident and checks the user', async () => {
    const { credentials, create } = fake()
    await unlockDevice(credentials, memoryStorage())
    const options = create.mock.calls[0][0] as CredentialCreationOptions
    expect(options.publicKey!.authenticatorSelection).toEqual({
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(options.publicKey!.extensions).toEqual({ prf: {} })
  })

  test('a passkey that can sync at creation is refused without a sign-in, and nothing is kept', async () => {
    const { credentials, get } = fake({ createFlags: 0x4d })
    const storage = memoryStorage()
    expect((await unlockDevice(credentials, storage)).outcome).toEqual({ result: 'refused-sync' })
    expect(get).not.toHaveBeenCalled()
    expect(storage.length).toBe(0)
  })

  test('a passkey that can sync at sign-in is refused and its stored ID removed', async () => {
    const { credentials, output } = fake({ getFlags: 0x5d })
    const storage = memoryStorage(STORED_ID)
    const { outcome, key } = await unlockDevice(credentials, storage)
    expect(outcome).toEqual({ result: 'refused-sync' })
    expect(key).toBeUndefined()
    expect(storage.length).toBe(0)
    // The output was never given to the core, and is not zeroed here: it holds the vector.
    expect(output[31]).toBe(31)
  })

  test.each(['none', 'empty'] as const)(
    'a sign-in with %s PRF output gives prf-missing and keeps nothing',
    async (prf) => {
      const { credentials } = fake({ prf })
      const storage = memoryStorage()
      expect((await unlockDevice(credentials, storage)).outcome).toEqual({ result: 'prf-missing' })
      expect(storage.length).toBe(0)
    },
  )

  test('a PRF output of the wrong length fails and is wiped', async () => {
    const { credentials, output } = fake()
    const short = output.subarray(0, 31)
    const get = vi.fn(async () => ({
      rawId: RAW_ID.buffer.slice(0),
      response: { authenticatorData: authData(0x45) },
      getClientExtensionResults: () => ({ prf: { results: { first: short } } }),
    }))
    credentials.get = get as unknown as CredentialsContainer['get']
    const storage = memoryStorage()
    expect((await unlockDevice(credentials, storage)).outcome).toEqual({ result: 'failed' })
    expect(short).toEqual(new Uint8Array(31))
    expect(storage.length).toBe(0)
  })

  test('a refused sign-in gives failed without the error text', async () => {
    const { credentials } = fake()
    credentials.get = () => Promise.reject(new DOMException('secret detail', 'NotAllowedError'))
    const storage = memoryStorage(STORED_ID)
    const { outcome } = await unlockDevice(credentials, storage)
    expect(outcome).toEqual({ result: 'failed' })
    expect(JSON.stringify(outcome)).not.toContain('secret')
    // The passkey may still exist, so its ID stays.
    expect(storage.getItem(credentialStorageKey)).toBe(STORED_ID)
  })

  test('blocked site storage gives failed instead of throwing', async () => {
    const { credentials, get } = fake()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    try {
      const { outcome } = await unlock(credentials, undefined, () => Promise.resolve())
      expect(outcome).toEqual({ result: 'failed' })
      expect(get).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  test('the same output gives the same code on a later visit', async () => {
    const storage = memoryStorage()
    const first = await unlockDevice(fake().credentials, storage)
    const second = await unlockDevice(fake().credentials, storage)
    expect(second.outcome).toEqual(first.outcome)
  })
})

describe('keepFirstReady', () => {
  test('asks the passkey once for a ready result and then reuses it', async () => {
    const { credentials, get } = fake()
    const storage = memoryStorage()
    const unlockOnce = keepFirstReady(() => unlockDevice(credentials, storage))
    const first = (await unlockOnce()).outcome
    const second = (await unlockOnce()).outcome
    expect(first.result).toBe('ready')
    expect(second).toEqual(first)
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('does not keep a refusal', async () => {
    const { credentials, get } = fake({ prf: 'none' })
    const storage = memoryStorage()
    const unlockOnce = keepFirstReady(() => unlockDevice(credentials, storage))
    expect((await unlockOnce()).outcome.result).toBe('prf-missing')
    expect((await unlockOnce()).outcome.result).toBe('prf-missing')
    expect(get).toHaveBeenCalledTimes(2)
  })
})
