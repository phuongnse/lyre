import { InjectionToken } from '@angular/core'
import { loadCore } from '../core'
import { NewRecoveryKey } from '../lyre-wasm/lyre_wasm.js'
import { fromBase64Url, toBase64Url } from './device-passkey'

// The owner's recovery public key, which a made song is encrypted for (D31 in
// docs/decisions.md). The page keeps only this public key, as base64url of its
// 33-byte compressed form. It is not secret. The Recovery key section writes
// it once the owner confirms they kept the words, and song making reads it.

// The storage key of the recovery public key.
export const recoveryKeyStorageKey = 'lyre-recovery-public-key'

// The compressed form of a public key on the curve.
const KEY_BYTES = 33

// base64url without padding. 33 bytes give exactly 44 characters and no
// padding. `atob` alone is too lax: it skips whitespace and accepts '+' and '/'.
const BASE64URL = /^[A-Za-z0-9_-]+$/

// The stored recovery public key, or undefined when none is kept. An entry
// that is not base64url, or not 33 bytes long, counts as none. The core checks
// that the bytes are a point on the curve when it writes the song. Storage is
// looked up inside the try, because reading `localStorage` throws when the
// site's storage is blocked.
export function readRecoveryPublicKey(storage?: Storage): Uint8Array<ArrayBuffer> | undefined {
  try {
    storage ??= localStorage
    const stored = storage.getItem(recoveryKeyStorageKey)
    if (stored === null || !BASE64URL.test(stored)) return undefined
    const key = fromBase64Url(stored)
    return key.length === KEY_BYTES ? key : undefined
  } catch {
    return undefined
  }
}

// Keeps the recovery public key, as base64url without padding. False when the
// site's storage refuses the write. Storage is looked up inside the try,
// because reading `localStorage` throws when the site's storage is blocked.
export function keepRecoveryPublicKey(key: Uint8Array, storage?: Storage): boolean {
  try {
    storage ??= localStorage
    storage.setItem(recoveryKeyStorageKey, toBase64Url(key))
    return true
  } catch {
    return false
  }
}

// A recovery key that was just made: the words to show once, the QR code of
// them, and the public part to keep.
export type NewRecovery = {
  words: string[]
  qr: { size: number; modules: Uint8Array }
  publicKey: Uint8Array
}

// Makes a recovery key in the core and copies out what the page shows. The
// handle is freed at once, because nothing can make its words again.
export async function makeRecoveryKey(load: () => Promise<void> = loadCore): Promise<NewRecovery> {
  await load()
  const made = new NewRecoveryKey()
  try {
    const qr = made.qrCode
    try {
      return {
        words: made.words.split(' '),
        qr: { size: qr.size, modules: qr.modules },
        publicKey: made.publicKey,
      }
    } finally {
      qr.free()
    }
  } finally {
    made.free()
  }
}

// The page gets the maker by injection, so tests can replace it.
export const RECOVERY_KEY_MAKER = new InjectionToken<() => Promise<NewRecovery>>('RECOVERY_KEY_MAKER', {
  providedIn: 'root',
  factory: () => makeRecoveryKey,
})
