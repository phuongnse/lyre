import { describe, expect, test } from 'vitest'
import { runPasskeyCheck } from './passkey-check'

// Authenticator data of `length` bytes whose flags byte is `flags`.
function authData(flags: number, length = 37): ArrayBuffer {
  const bytes = new Uint8Array(length)
  bytes[32] = flags
  return bytes.buffer
}

// A stand-in for navigator.credentials. Its passkey has `flags` and returns
// `prfOutput` from a sign-in, when given.
function fakeCredentials(flags: number, prfOutput?: Uint8Array): CredentialsContainer {
  return {
    create: async () => ({
      rawId: new Uint8Array(16).buffer,
      response: { getAuthenticatorData: () => authData(flags) },
    }),
    get: async () => ({
      getClientExtensionResults: () => ({ prf: prfOutput === undefined ? {} : { results: { first: prfOutput } } }),
    }),
  } as unknown as CredentialsContainer
}

describe('runPasskeyCheck', () => {
  test('reports that a device-bound passkey with a PRF output works, and wipes the output', async () => {
    const output = new Uint8Array(32).fill(0xab)
    const outcome = await runPasskeyCheck(fakeCredentials(0x45, output))
    expect(outcome).toEqual({ result: 'works', flags: { eligible: false, state: false } })
    expect(output.every((byte) => byte === 0)).toBe(true)
  })

  test('refuses a passkey that can sync, without asking for a PRF output', async () => {
    const credentials = fakeCredentials(0x08, new Uint8Array(32).fill(1))
    credentials.get = () => Promise.reject(new Error('get must not be called'))
    expect(await runPasskeyCheck(credentials)).toEqual({
      result: 'refused-sync',
      flags: { eligible: true, state: false },
    })
  })

  test('reports PRF missing when the sign-in returns no PRF output', async () => {
    expect(await runPasskeyCheck(fakeCredentials(0x00))).toEqual({
      result: 'prf-missing',
      flags: { eligible: false, state: false },
    })
  })

  test('reports PRF missing when the PRF output is empty', async () => {
    expect((await runPasskeyCheck(fakeCredentials(0x00, new Uint8Array(0)))).result).toBe('prf-missing')
  })

  test('keeps only the name of the error when the check fails', async () => {
    const credentials = fakeCredentials(0x00)
    credentials.create = () => Promise.reject(new DOMException('secret details', 'NotAllowedError'))
    const outcome = await runPasskeyCheck(credentials)
    expect(outcome).toEqual({ result: 'failed', errorName: 'NotAllowedError' })
    expect(JSON.stringify(outcome)).not.toContain('secret details')
  })
})
