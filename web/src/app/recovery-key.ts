import { fromBase64Url } from './device-passkey'

// The owner's recovery public key, which a made song is encrypted for (D31 in
// docs/decisions.md). The page keeps only this public key, as base64url of its
// 33-byte compressed form. It is not secret. This file only reads it: the
// recovery key screen writes it.

// The storage key of the recovery public key.
export const recoveryKeyStorageKey = 'lyre-recovery-public-key'

// The compressed form of a public key on the curve.
const KEY_BYTES = 33

// The stored recovery public key, or undefined when none is kept. An entry
// that is not base64url, or not 33 bytes long, counts as none. The core checks
// that the bytes are a point on the curve when it writes the song. Storage is
// looked up inside the try, because reading `localStorage` throws when the
// site's storage is blocked.
export function readRecoveryPublicKey(storage?: Storage): Uint8Array<ArrayBuffer> | undefined {
  try {
    storage ??= localStorage
    const stored = storage.getItem(recoveryKeyStorageKey)
    if (stored === null) return undefined
    const key = fromBase64Url(stored)
    return key.length === KEY_BYTES ? key : undefined
  } catch {
    return undefined
  }
}
