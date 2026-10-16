// What the passkey check and the device code share: reading a passkey's backup
// flags and handling the buffers WebAuthn gives back.

// The backup flags of a passkey: whether it can sync (BE) and whether it has
// synced (BS).
export type BackupFlags = { eligible: boolean; state: boolean }

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

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function bytesOf(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source)
}
