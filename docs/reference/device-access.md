# Devices and access

This doc fixes the bytes and text of what moves between devices besides the
song file: device codes, fingerprints, access files and recovery keys.
The web device key, the device code and the fingerprint are built. Access
files and recovery keys are *(planned for M3)*. The scheme is
[D31](../decisions.md#d31-song-files-are-encrypted-shared-and-recovered-with-one-scheme--agreed).
The terms are defined in the [concepts](../domain/concepts.md).

All integers are unsigned and little-endian unless a section says
big-endian. Sizes are in bytes unless stated otherwise.

The protection is not DRM. Its limits are in
[what the protection does not do](../domain/knowledge.md#what-the-protection-does-not-do).

## Web device key

A web device derives its P-256 device key from its device-bound passkey.
The WebAuthn PRF extension gives the page a secret tied to that passkey,
after the user unlocks the device. The passkey must pass
[D8's checks](../decisions.md#d8-device-keys-are-bound-to-the-device-not-the-apps-storage--agreed).

The client passes the UTF-8 bytes of `lyre/v1/device-key/prf` as the PRF
`eval.first` input. These bytes are the fixed Lyre PRF salt.
The browser hashes them with the `WebAuthn PRF` prefix as WebAuthn defines.
The client passes the label as is, without hashing it first.

The core derives the key once per session:

1. Use the 32-byte PRF output as input keying material (IKM) for
   HKDF-SHA256, as defined in [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869).
2. Use an empty HKDF salt, the UTF-8 bytes of `lyre/v1/device-key` as
   `info`, and an output length `L` of 48 bytes.
3. Read the 48 bytes as one big-endian integer and reduce it modulo `n`,
   the P-256 group order.
4. Reject zero. Otherwise, the result is the private scalar `d`, and
   the public key is `d × G`, where `G` is P-256's standard generator.

If the PRF output is not 32 bytes or the reduced scalar is zero, the core
returns an error. The client offers no device code.

The client passes the PRF output straight to the core, then overwrites its
buffer with zeros. Clearing is best effort because JavaScript may keep
copies. The output never reaches UI state, storage or logs. The private key
stays inside the core, as the
[core rules](../architecture.md#core-rules) require.

Android generates its device key in Android Keystore instead (D8).
Its public key uses the same [device code](#device-code) encoding.

*Why 48 bytes:* reducing a wider integer keeps the bias negligible.
The versioned labels separate the PRF input, device key and recovery key.

## Device code

A device code encodes the 33-byte SEC1 compressed P-256 public key with
[Bech32m (BIP-350)](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki).
The compressed key starts with `02` or `03`, followed by the 32-byte
big-endian x coordinate. Prefix `02` means an even y coordinate, and `03`
means an odd one.

| Part | Size | Value |
| --- | --- | --- |
| Human-readable part (HRP) | 4 characters | `lyre` |
| Separator | 1 character | `1` |
| Version | 1 five-bit group | `1`, encoded as `p` |
| Public key | 53 five-bit groups | The 33-byte compressed key, converted from eight-bit groups |
| Checksum | 6 characters | Bech32m, with constant `0x2bc830a3` |

Convert the key's bytes in order, most significant bits first.
Pad the last five-bit group with zero bits. There is exactly one padding
bit, and a reader requires it to be zero. The version group is separate
from this conversion. The checksum covers the HRP and all 54 data groups,
including the version, as BIP-350 defines.

The complete code is 65 characters and starts with `lyre1p`.
Writers output lowercase. Readers accept all-lowercase or all-uppercase
text and reject mixed case. They ignore leading and trailing whitespace
only. Internal whitespace is invalid.

The QR content is exactly the device code in uppercase, without a URI
scheme or any extra text. It uses QR alphanumeric mode. Typed and scanned
codes use the same parser.

*Why Bech32m:* its checksum catches typing errors. The uppercase form fits
compactly in QR alphanumeric mode. Version 1 leaves version 0 distinct from
the development-only song file format.

## Fingerprint

The fingerprint lets people compare device codes by voice or eye.
It is derived from the key's bytes, so changing the code's case does not
change it.

1. Compute `h = SHA-256(compressed_key)`, using the 33-byte compressed key.
2. For each `i` from 0 through 4, read `h[5i..5i+5]` as a big-endian
   40-bit integer. The upper bound of the slice is excluded.
3. Take each integer modulo 10,000 and show it as four decimal digits,
   padded with leading zeros.
4. Join the five groups with single spaces.

The result has 20 digits in five groups of four. For example, its display
shape is `0123 4567 8901 2345 6789`. This is not a known-answer vector.
The last seven bytes of the hash are unused.

*Why:* comparing the fingerprint catches a device code swapped on the way.
It has about 66 bits of strength, with negligible modulo bias.
It is a short comparison aid, not a full-strength hash.

## Access file

An access file has extension `.lyrekey`. It is for one device and holds
the wrapped content keys of one or more songs. Each entry carries its own
song ID and owner or recipient role.

### Header

The header is 49 bytes. Offsets are from the start of the file.

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 8 | `magic` | `89 4C 4B 45 59 0D 0A 1A` |
| 8 | 2 | `version` | u16, `1` |
| 10 | 2 | `reserved` | u16, must be `0` |
| 12 | 4 | `entry_count` | u32, from 1 through 16,384 |
| 16 | 33 | `device_key` | SEC1 compressed P-256 public key of the device this file is for |

The entries start at offset 49.

*Why this magic:* it follows the song file's pattern: a non-ASCII first
byte, `LKEY`, CR LF and SUB. Text-mode transfers that change line ends
alter the magic.

*Why store the device key:* it is public already. A reader can give a clear
reason for rejecting a file for another device before trying HPKE.

### Entries

Each entry is 130 bytes. Offsets are from the start of that entry.

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 16 | `song_id` | The song file's song ID |
| 16 | 1 | `role` | `1` = owner, `2` = recipient |
| 17 | 65 | `enc` | HPKE encapsulated key, a SEC1 uncompressed P-256 point |
| 82 | 48 | `ct` | The sealed 32-byte content key, including its 16-byte authentication tag |

Entries are strictly increasing by `song_id`, compared lexicographically
as unsigned bytes. Duplicate song IDs are invalid.
The file size is exactly `49 + 130 × entry_count`, with no trailing bytes.

Match an entry to a song file by song ID only, never by file name or folder.
If no entry matches the song file's song ID, this access file is for other
songs. It gives no access to that song.

*Why fixed sizes and sorting:* the layout is simple to bound and fuzz.
Sorting gives one canonical order and rules out two roles for one song.

### HPKE wrap

HPKE means hybrid public key encryption. Each entry uses
[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180) base mode with this suite:

| Setting | ID | Value |
| --- | --- | --- |
| Mode | `0x00` | Base mode |
| KEM | `0x0010` | DHKEM(P-256, HKDF-SHA256) |
| KDF | `0x0001` | HKDF-SHA256 |
| AEAD | `0x0002` | AES-256-GCM |

The recipient public key is the header's `device_key`.
HPKE serializes that key internally as a 65-byte uncompressed SEC1 point,
as RFC 9180 requires. Its `enc` uses that uncompressed encoding too,
starting with `04`, then the 32-byte big-endian x and y coordinates.

The HPKE `info` is this fixed 64-byte concatenation, without separators
or a terminating NUL:

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 14 | UTF-8 bytes of `lyre/v1/access` |
| 14 | 16 | The entry's `song_id` |
| 30 | 33 | The header's compressed `device_key` |
| 63 | 1 | The entry's `role` |

Additional authenticated data (`aad`) is empty.
Each entry gets a fresh HPKE sender context with one seal at sequence 0.
The plaintext is the song's 32-byte content key. The reader opens it with
the device's private key and the same `info` and empty `aad`.
No content key or role is used before the open succeeds.

Only each entry is authenticated, not the whole access file.
Changing an entry's song ID, role, encapsulated key or ciphertext fails
when that entry is opened. Changing the header's device key either fails
the device match or the open. Removing an entry and updating the count
leaves the remaining entries valid. The device just loses access through
this file to the removed song.

The owner or recipient role controls product behaviour under
[D13](../decisions.md#d13-only-the-owner-shares-a-song--agreed).
It is not a cryptographic guarantee. HPKE base mode does not prove who
made the wrap. Anyone who already holds a content key can make a new wrap.

## Recovery key

The recovery key is a seed of 32 cryptographically random bytes.
It is created before the first song, shown once, and kept offline (D31).
The device keeps only its public key after creation or recovery.

### Words and QR content

Encode the seed as 24 words using the
[BIP39 English word list](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt)
and [BIP39's entropy encoding](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki):

1. Append the first eight bits of `SHA-256(seed)` to the seed's 256 bits.
2. Read the resulting 264 bits in big-endian bit order, most significant
   bit first in each byte.
3. Split them into 24 groups of 11 bits. Each group is a zero-based index
   into the 2,048-word English list.

The seed is the BIP39 entropy itself. BIP39's PBKDF2 mnemonic-to-seed step
is not used. There is no BIP39 passphrase.

Display lowercase words separated by single spaces.
Readers split on whitespace, accept ASCII uppercase as well as lowercase,
and require exactly 24 complete words. They do not accept word prefixes.
The decoded checksum must match the first eight bits of `SHA-256(seed)`.

The QR content is exactly those 24 words in uppercase, separated by single
spaces. It uses QR alphanumeric mode, without a URI scheme or extra text.
Typed and scanned recovery keys use the same parser.

### Key pair

The core derives the recovery key pair with HKDF-SHA256:

| Parameter | Value |
| --- | --- |
| IKM | The 32-byte seed |
| Salt | Empty |
| `info` | UTF-8 bytes of `lyre/v1/recovery-key` |
| `L` | 48 bytes |

Read the output as a big-endian integer and reduce it modulo the P-256
group order `n`, rejecting zero, as for the [web device key](#web-device-key).
The result is the private scalar `d`; the public key is `d × G`.
A zero result is an error, and no recovery key pair is accepted.

The device retains only the public key, so later songs can be wrapped
without keeping the seed or private key. The private key stays inside the
core and never reaches UI state, logs or error messages.
The recovery wrap's bytes are specified in
[song file format, version 1](song-file-format-v1.md#recovery-wrap).

*Why use the entropy itself:* D31's seed is 256 bits, shown as words.
The checksum catches mistakes without adding a second seed derivation.
The separate HKDF label keeps recovery and device keys distinct.

## Rejections

Readers reject every input below. Structural checks cover the whole access
file before its entries are used. Authentication is checked before an
entry's content key or role is used.

| Input | Rule | When checked |
| --- | --- | --- |
| Web PRF output | It must be exactly 32 bytes. | Before HKDF |
| Derived device or recovery scalar | It must not be zero after reduction modulo `n`. | During key derivation |
| Device code text | HRP must be `lyre`, case-insensitively. Mixed case, internal whitespace and characters outside Bech32m are invalid. | Before decoding the key |
| Device code length | After trimming, it must be 65 characters: one version group, 53 key groups and six checksum characters after the separator. | Before decoding the key |
| Device code checksum | It must be a valid Bech32m checksum. A Bech32 checksum is not accepted. | Before decoding the key |
| Device code version | It must be `1`. Unknown versions are rejected. | Before decoding the key |
| Device code padding | The final padding bit must be zero. Decoding must produce exactly 33 bytes. | During conversion to bytes |
| Compressed key in a device code or access header | It must start with `02` or `03`. Its x coordinate must be less than P-256's field prime `p` and yield a point on the curve. The point at infinity is invalid. | When parsing the key |
| Access file header | Magic must match, version must be `1`, and reserved must be `0`. | When parsing the header |
| Access file entry count | It must be from 1 through 16,384. | Before reading or allocating entries |
| Access file size | It must equal `49 + 130 × entry_count`. Truncated, padded and oversized files are invalid. | Before reading entries |
| Access file for another device | Its compressed `device_key` must equal this device's compressed public key, byte for byte. | After validating the header key, before HPKE |
| Access entry role | It must be `1` or `2`. | When parsing entries |
| Access entry song IDs | They must be strictly increasing as unsigned bytes, with no duplicates. | When parsing entries |
| Access entry `enc` | It must be a 65-byte SEC1 uncompressed P-256 point, starting with `04`. Both coordinates must be less than `p`, and the point must be on the curve. The point at infinity is invalid. | When parsing entries |
| Access file for another song | There must be an entry for the song file's song ID. Without it, opening that song is denied. | When matching the song |
| Changed access entry | HPKE open must succeed with the specified `info` and empty `aad`. A changed song ID, role, device key, `enc` or ciphertext fails structural checks, device matching or authentication. | Before using the content key or role |
| Recovery word count | There must be exactly 24 words. | Before decoding the seed |
| Recovery word | Each complete word must be in the BIP39 English list after ASCII case folding. Unknown words and prefixes are invalid. | While decoding the seed |
| Recovery checksum | The eight checksum bits must match the first eight bits of `SHA-256(seed)`. | Before deriving the recovery key pair |

Removing an entry with a matching count and size is not an authentication
failure. The [access file](#access-file) section describes this limit.

## Limits

| Item | Size or count |
| --- | --- |
| PRF output | Exactly 32 bytes |
| HKDF output for either key derivation | Exactly 48 bytes |
| Compressed P-256 public key | Exactly 33 bytes |
| Uncompressed P-256 public key or HPKE `enc` | Exactly 65 bytes |
| Device code, excluding surrounding whitespace | Exactly 65 characters |
| Device code version | `1` |
| Fingerprint | 20 digits, five groups of four, four separating spaces |
| Access file version | `1` |
| Access file header | Exactly 49 bytes |
| Access file entry | Exactly 130 bytes |
| Access file entries | 1 through 16,384 |
| Access file size | Exactly `49 + 130 × entry_count`, from 179 through 2,129,969 bytes |
| Song ID | Exactly 16 bytes per entry |
| HPKE `info` | Exactly 64 bytes |
| Content key | Exactly 32 bytes |
| HPKE ciphertext and tag | Exactly 48 bytes |
| Recovery seed | Exactly 32 bytes, or 256 bits |
| Recovery checksum | Exactly 8 bits |
| Recovery words | Exactly 24, from the 2,048-word BIP39 English list |

## Known-answer vectors

The web device key, the device code and the fingerprint have checked
vectors. The core changes that implement access files and recovery keys add
theirs, including invalid variants.

The vectors were worked out with an independent script that uses only
Python's standard library. The core's tests read the tables below. Each
`d` is the private scalar of a public test input. Do not use these PRF outputs
for real keys.

### Web device key

Each row gives a 32-byte PRF output, the private scalar `d` that the
[derivation](#web-device-key) gives for it, and the compressed public key
`d × G`.

| PRF output | `d` | Compressed public key |
| --- | --- | --- |
| `0000000000000000000000000000000000000000000000000000000000000000` | `daacda402b66a5b204063161002f9ceb915601223a40f9f5f6c049c03e67681d` | `037deea1f3fb8529f4d6938854578ebb0fab45139c57f945614748b160471f2adb` |
| `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` | `3e2b6b111b520f4e92288a42c330f18395abb8967c3d68d26e076b9ed761954f` | `02b02c2646cac3ff157852cb6f7fd4fbcddcb00dbb0a851c286d40e671ff041c01` |
| `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` | `6e6becdbe85b115e94f0883efaa552525e41121f7623ef2d0b6751c399e43453` | `03c540eb03806db84b0a7f90e534ed6a4788d49769b3c36aaeafe1561ed08796b2` |

A PRF output of 31 or 33 bytes is rejected with `PrfLength`. A reduced
scalar of zero is rejected with `ZeroScalar`. No real PRF output is known to
reduce to zero, so the core tests that rule with the value `n` itself.

### Device code and fingerprint

Each valid row gives a compressed public key from the table above, its
device code and its fingerprint. A reader gives the same key for the code in
lowercase, in uppercase and with whitespace around it.

| Compressed public key | Device code | Fingerprint |
| --- | --- | --- |
| `037deea1f3fb8529f4d6938854578ebb0fab45139c57f945614748b160471f2adb` | `lyre1pqd77ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dkpfn6rh` | `8777 6713 0488 7316 7196` |
| `02b02c2646cac3ff157852cb6f7fd4fbcddcb00dbb0a851c286d40e671ff041c01` | `lyre1pq2czcfjxetpl79tc2t9k7l75l0xaevqdhv9g28pgd4qwvu0lqswqzflvara` | `1458 7998 1818 4050 3333` |
| `03c540eb03806db84b0a7f90e534ed6a4788d49769b3c36aaeafe1561ed08796b2` | `lyre1pq0z5p6crspkmsjc207gw2d8ddfrc34yhdxeux64w4ls4v8kss7ttyf6nm2p` | `2627 9927 1972 9177 1269` |

Each invalid row is rejected with its reason. The reasons are the names of
the core's `DeviceCodeError` variants. Rows with a checksum that is
otherwise valid isolate the one rule they break.

| Case | Device code | Reason |
| --- | --- | --- |
| One data character changed | `lyre1pqd77ag0nlwzjnaqkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dkpfn6rh` | `Checksum` |
| Bech32 checksum, not Bech32m | `lyre1pqd77ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dk54rkx4` | `Checksum` |
| Prefix `02`, x = 1, not on the curve | `lyre1pqgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqza0yfpn` | `Key` |
| Prefix `02`, x = `p` | `lyre1pqtllllllqqqqqqgqqqqqqqqqqqqqqqqqqrllllllllllllllllll7n54t3s` | `Key` |
| Prefix `04` | `lyre1pq377ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dk4xr42f` | `Key` |
| Version 0 | `lyre1qqd77ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dkq4drhu` | `Version` |
| Padding bit set | `lyre1pqd77ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dhul8079` | `Padding` |
| Mixed case | `LYRE1PQD77ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dkpfn6rh` | `Text` |
| HRP `lyrf` | `lyrf1pqd77ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dkz3yesg` | `Text` |
| One data group too few | `lyre1pqd77ag0nlwzjnaxkjwy9g4uwhv86k3gnn3tlj3tpgaytzcz8ru4dlv6ppp` | `Length` |

### Access file

The core change implementing access files adds its vectors here
*(planned for M3)*.

### Recovery key

The core change implementing recovery keys adds its vectors here
*(planned for M3)*.
