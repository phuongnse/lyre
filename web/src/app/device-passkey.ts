import { InjectionToken, inject } from '@angular/core'
import { loadCore } from '../core'
import { DeviceKey, DeviceKeyFault, devicePrfSalt } from '../lyre-wasm/lyre_wasm.js'
import { messages } from './messages'
import { bytesOf, randomBytes, readBackupFlags } from './webauthn'

// This device's key, from a device-bound passkey with PRF (D8 in
// docs/decisions.md). The PRF output goes straight to the core, which makes
// the key and the device code. The page keeps only the passkey's credential
// ID, which is not secret.

export type DeviceOutcome =
  | {
      result: 'ready'
      deviceCode: string
      fingerprint: string
      // The QR code's modules row by row, 1 for dark, without the quiet zone.
      qr: { size: number; modules: Uint8Array }
    }
  | { result: 'refused-sync' }
  | { result: 'prf-missing' }
  | { result: 'failed' }

export type DeviceUnlock = { outcome: DeviceOutcome; key?: DeviceKey }

// The storage key of the passkey's credential ID, as base64url.
export const credentialStorageKey = 'lyre-device-passkey'

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

// Creates the device's passkey. Null when the passkey can sync, which D8
// refuses even before it has synced.
async function createPasskey(credentials: CredentialsContainer): Promise<Uint8Array | null> {
  const name = messages.devicePasskeyName
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
  return flags.eligible ? null : new Uint8Array(created.rawId)
}

// Asks the device's passkey for its unlock and its PRF output, and makes the
// device key from it. The output is wiped as soon as the core has used it. An
// error's message is never logged or passed on. The browser's own credentials
// and storage are looked up inside the try, because reading `localStorage`
// throws when the site's storage is blocked. The key is returned with a
// ready outcome, for the caller to keep for later issues.
export async function unlockDevice(
  credentials?: CredentialsContainer,
  storage?: Storage,
  load: () => Promise<void> = loadCore,
): Promise<DeviceUnlock> {
  try {
    await load()
    credentials ??= navigator.credentials
    storage ??= localStorage
    const stored = storage.getItem(credentialStorageKey)
    let id: Uint8Array
    if (stored === null) {
      const created = await createPasskey(credentials)
      if (created === null) return { outcome: { result: 'refused-sync' } }
      id = created
    } else {
      id = fromBase64Url(stored)
    }

    const asserted = (await credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: 'public-key', id: id as Uint8Array<ArrayBuffer> }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: new Uint8Array(devicePrfSalt()) } } },
      },
    })) as PublicKeyCredential | null
    if (!asserted) throw new Error()

    const authData = (asserted.response as AuthenticatorAssertionResponse).authenticatorData
    if (readBackupFlags(authData).eligible) {
      storage.removeItem(credentialStorageKey)
      return { outcome: { result: 'refused-sync' } }
    }
    const output = asserted.getClientExtensionResults().prf?.results?.first
    if (output === undefined || output.byteLength === 0) {
      storage.removeItem(credentialStorageKey)
      return { outcome: { result: 'prf-missing' } }
    }

    const prf = bytesOf(output)
    let key: DeviceKey
    try {
      key = new DeviceKey(prf as Uint8Array<ArrayBuffer>)
    } catch (fault) {
      if (fault instanceof DeviceKeyFault) fault.free()
      return { outcome: { result: 'failed' } }
    } finally {
      prf.fill(0)
    }
    storage.setItem(credentialStorageKey, toBase64Url(new Uint8Array(asserted.rawId)))
    const qr = key.qrCode
    const outcome: DeviceOutcome = {
      result: 'ready',
      deviceCode: key.deviceCode,
      fingerprint: key.fingerprint,
      qr: { size: qr.size, modules: qr.modules },
    }
    qr.free()
    return { outcome, key }
  } catch {
    return { outcome: { result: 'failed' } }
  }
}

// Keeps the first ready result for the page's lifetime: later calls ask the
// passkey nothing. The result holds the key handle, which only the core's
// opener may use, and nobody frees it. Refusals and failures are not kept.
export function keepFirstReady(unlock: () => Promise<DeviceUnlock>): () => Promise<DeviceUnlock> {
  let ready: DeviceUnlock | undefined
  let pending: Promise<DeviceUnlock> | undefined
  return async () => {
    if (ready) return ready
    pending ??= unlock()
    try {
      const unlocked = await pending
      if (unlocked.outcome.result === 'ready') ready = unlocked
      return unlocked
    } finally {
      pending = undefined
    }
  }
}

// This page load's one device unlock, shared by every part of the page that
// needs it, so the passkey is asked once.
const UNLOCKED_DEVICE = new InjectionToken<() => Promise<DeviceUnlock>>('UNLOCKED_DEVICE', {
  providedIn: 'root',
  factory: () => keepFirstReady(() => unlockDevice()),
})

// The page gets the unlock by injection, so tests can replace it.
export const DEVICE_UNLOCK = new InjectionToken<() => Promise<DeviceOutcome>>('DEVICE_UNLOCK', {
  providedIn: 'root',
  factory: () => {
    const unlocked = inject(UNLOCKED_DEVICE)
    return async () => (await unlocked()).outcome
  },
})

// The device key of the shared unlock, or undefined when the device is not
// unlocked. It is the core's opaque handle: it goes to the song file opener and
// nowhere else, never into UI state, logs or messages.
export const DEVICE_KEY = new InjectionToken<() => Promise<DeviceKey | undefined>>('DEVICE_KEY', {
  providedIn: 'root',
  factory: () => {
    const unlocked = inject(UNLOCKED_DEVICE)
    return async () => (await unlocked()).key
  },
})
