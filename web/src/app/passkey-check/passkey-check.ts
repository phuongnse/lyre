import { InjectionToken } from '@angular/core'

// The check for D8 (docs/decisions.md): does a device-bound passkey return a
// PRF output in this browser and OS? It makes no device key and keeps nothing.

// The backup flags of a passkey: whether it can sync (BE) and whether it has
// synced (BS).
export type BackupFlags = { eligible: boolean; state: boolean }

export type Outcome =
  | { result: 'works'; flags: BackupFlags }
  | { result: 'refused-sync'; flags: BackupFlags }
  | { result: 'prf-missing'; flags: BackupFlags }
  | { result: 'failed'; errorName: string }

const name = 'Lyre passkey check'

// The flags byte follows the 32-byte RP ID hash. The sign count follows it, so
// authenticator data is at least 37 bytes long.
const flagsOffset = 32
const minimumLength = 37
const backupEligibleBit = 0x08
const backupStateBit = 0x10

export function readBackupFlags(authData: ArrayBuffer): BackupFlags {
  if (authData.byteLength < minimumLength) throw new RangeError('Authenticator data is too short')
  const flags = new Uint8Array(authData)[flagsOffset]
  return { eligible: (flags & backupEligibleBit) !== 0, state: (flags & backupStateBit) !== 0 }
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length))
}

function bytesOf(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source)
}

// Creates a test passkey, reads its backup flags and asks it for one PRF output.
// The output is wiped at once: only whether one came back is reported. The
// error's message is never passed on, only its name.
export async function runPasskeyCheck(credentials: CredentialsContainer = navigator.credentials): Promise<Outcome> {
  try {
    const created = (await credentials.create({
      publicKey: {
        rp: { name },
        user: { id: randomBytes(16), name, displayName: name },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
        extensions: { prf: {} },
      },
    })) as PublicKeyCredential | null
    if (!created) throw new Error()

    const flags = readBackupFlags((created.response as AuthenticatorAttestationResponse).getAuthenticatorData())
    // D8 refuses a passkey that can sync, even before it has synced.
    if (flags.eligible) return { result: 'refused-sync', flags }

    const asserted = (await credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: 'public-key', id: created.rawId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: randomBytes(32) } } },
      },
    })) as PublicKeyCredential | null
    if (!asserted) throw new Error()

    const output = asserted.getClientExtensionResults().prf?.results?.first
    if (output === undefined || output.byteLength === 0) return { result: 'prf-missing', flags }
    bytesOf(output).fill(0)
    return { result: 'works', flags }
  } catch (error) {
    // Browsers make DOMException an Error, but some environments, such as jsdom, do not.
    const named = error instanceof Error || error instanceof DOMException
    return { result: 'failed', errorName: named ? error.name : 'Error' }
  }
}

// The page gets the check by injection, so tests can replace it.
export const PASSKEY_CHECK = new InjectionToken<() => Promise<Outcome>>('PASSKEY_CHECK', {
  providedIn: 'root',
  factory: () => () => runPasskeyCheck(),
})
