# Song file format, version 1

Version 1 is the encrypted, authenticated song file format from M3. One
`.lyre` file holds one song, with each chunk encrypted separately. The scheme
is
[D31](../decisions.md#d31-song-files-are-encrypted-shared-and-recovered-with-one-scheme--agreed).

The core writes and reads version 1 next to version 0, and its tests check
the [known-answer example](#known-answer-example). The web Player reads
version 1. Writing it in the clients is planned for M3 *(planned for M3)*.

Encryption decides who can open a song file. It does not stop copying once
a song is open. See
[what the protection does not do](../domain/knowledge.md#what-the-protection-does-not-do).

The terms are defined in the [concepts](../domain/concepts.md).
All integers are unsigned and little-endian. Sizes use 1 KiB = 1,024 bytes
and 1 MiB = 1,048,576 bytes. Offsets are from the start of the file unless
a table says otherwise.

## Reading model

The client passes bytes and the core does no file work. A player never needs
the whole file in memory:

1. The client reads bytes 0–176 (177 bytes). The core parses the
   [header](#header): the magic, version 1, reserved 0 and `entry_count`
   within the [limits](#limits). The index length is `entry_count × 24`
   bytes. These structural checks do not authenticate the header yet.
2. The client opens the content key through the core, from an
   [access file](device-access.md#access-file) or the
   [recovery wrap](#recovery-wrap). It receives only an opaque handle,
   as the [core rules](../architecture.md#core-rules) require.
3. The client reads the index and the 16-byte tag after it, and passes the
   total file size. The core checks the [header and index tag](#header-and-index-authentication)
   before it trusts any index field. It then checks every
   [index rule](#index), including chunk order, counts, lengths, offsets,
   segment times and the file size.
4. The client reads a chunk at its authenticated offset and length.
   The core [decrypts it](#chunk-encryption) with its index entry and
   position, then checks its [contents](#chunk-contents).

Any failure refuses the whole file. No plaintext from a failed chunk is
returned or played. The details, lyrics and timing are read and checked
before anything plays. The core checks the timing against the lyrics once
it has both chunks.

Seeking reads only the media segments needed, using the same
`[start_ms, start_ms + duration_ms)` ranges as
[version 0](song-file-format-v0.md#reading-model). Streaming from Google
Drive *(planned for M7)* reads the same byte ranges.
A changed media segment is caught when it is read. The file is then refused
and playback stops. A player may play the start before reaching a changed
segment further on, but it never plays changed content.

*Why:* checking every media segment before playback would require reading
the whole file. Authenticating each segment before use keeps seeking and
streaming possible.

## Header

The header is exactly 177 bytes.

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 8 | `magic` | `89 4C 59 52 45 0D 0A 1A` |
| 8 | 2 | `version` | u16, `1` |
| 10 | 2 | `reserved` | u16, must be `0` |
| 12 | 4 | `entry_count` | u32, the number of index entries |
| 16 | 16 | `song_id` | 16 random bytes, chosen when the song is made |
| 32 | 32 | `salt` | Fresh random bytes on every write, never reused |
| 64 | 65 | `recovery_enc` | HPKE encapsulated key for the recovery wrap |
| 129 | 48 | `recovery_sealed` | Sealed content key and its authentication tag |

The index starts at offset 177. The recovery wrap occupies the last
113 header bytes and is readable before the content key is known.

A reader rejects a wrong magic, any version other than 1 (including
version 0), a nonzero reserved field or an entry count outside the limits.

*Why:* the magic and version keep version 0's offsets, following its
[room for encryption](song-file-format-v0.md#room-for-encryption-m3).
The fixed recovery wrap size keeps the header simple to bound.

### Recovery wrap

HPKE means hybrid public key encryption. The recovery wrap seals the
32-byte content key to the owner's recovery public key. It uses
[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180) base mode with
DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. This is the same
suite as the [access file's HPKE wrap](device-access.md#hpke-wrap).

`recovery_enc` is a 65-byte SEC1 uncompressed P-256 point: `04`, then the
32-byte big-endian x and y coordinates. It must be a valid point on the
curve, with both coordinates less than the field prime and no point at
infinity. HPKE serializes the recipient public key in that uncompressed
form internally too, as RFC 9180 requires.
`recovery_sealed` is the ciphertext of the 32-byte content key followed
by its 16-byte tag.

The HPKE `info` is this fixed 70-byte concatenation. Offsets are within
`info`. There are no separators or terminating NUL:

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 21 | UTF-8 bytes of `lyre/v1/recovery-wrap` |
| 21 | 16 | The header's `song_id` |
| 37 | 33 | The owner's recovery public key in compressed SEC1 form |

Additional authenticated data (`aad`) is empty. The wrap is the single
seal at sequence 0 of a fresh HPKE sender context. A reader opens it with
the recovery private key, the same `info` and empty `aad`. A failed open
refuses the file. The content key is not used before the open succeeds.

The wrap is written on every write of the song file. Sharing does not
change it or any other song file bytes (D6, D7).
The [devices and access reference](device-access.md#key-pair) defines how
the recovery key pair is derived. The header tag covers the whole wrap.

*Why:* the wrap must be read before the content key is known, so it sits
in the clear header. Its fixed size ties version 1 to this P-256 HPKE suite.
Changing the scheme needs a new format version.

## Index

The index has the same 24-byte entries as
[version 0](song-file-format-v0.md#index), in chunk storage order.
Every version-0 index rule still applies, with these differences:

- `length` is the stored ciphertext length plus its 16-byte tag. It equals
  the plaintext length plus 16.
- The first chunk starts at `177 + 24 × entry_count + 16`.
  The extra 16 bytes are the header and index tag.
- Chunk lengths use the [stored limits](#limits) below.

There are no gaps or overlaps. Each next chunk starts at the previous
chunk's offset plus its stored length. The file ends at the last chunk.
Segment time rules are unchanged. A truncated or padded file is rejected
before playback, using the authenticated index and the total file size.

## Keys

Each song has one random 32-byte content key. A rewrite keeps that key,
so earlier access files still open the song (D31).
HKDF-SHA256 derives two 32-byte keys for each write:

```text
header_key = HKDF-SHA256(salt = header salt, IKM = content key,
                        info = "lyre/v1/song-file/header", L = 32)
chunk_key  = HKDF-SHA256(salt = header salt, IKM = content key,
                        info = "lyre/v1/song-file/chunk", L = 32)
```

IKM means input keying material. HKDF-SHA256 is defined in
[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869).
The `info` strings are UTF-8 (ASCII) bytes without a terminator.
They follow the `lyre/v1/...` label scheme of the
[devices and access reference](device-access.md).
The fresh per-write salt makes both keys unique to each write.

*Why:* separate labels keep the header key separate from the chunk key.
The header never shares a key and nonce pair with a chunk.

## Header and index authentication

One 16-byte AES-256-GCM tag authenticates the header and index together:

| Input | Value |
| --- | --- |
| Key | `header_key` |
| Nonce | 12 zero bytes |
| Plaintext | Empty |
| Associated data | The 177 header bytes followed by all index bytes, exactly as stored |

Associated data is authenticated without being encrypted.
The tag is stored immediately after the index, at
`177 + 24 × entry_count`. There is no ciphertext for the empty plaintext.
`header_key` is used for nothing else.

The core checks this tag before trusting any index field or reading a
chunk. A wrong content key, a changed header or index byte, or a changed
tag fails authentication. These authentication failures cannot be told
apart. Structural header errors can be rejected earlier.

## Chunk encryption

Each chunk uses AES-256-GCM with `chunk_key`. Its stored bytes are the
ciphertext followed by a 16-byte tag. A reader authenticates the chunk
before returning its plaintext.

The nonce is 12 bytes. Offsets are within the nonce:

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 8 | `position` | Zero-based index position as a u64, little-endian |
| 8 | 4 | Zero padding | `00 00 00 00` |

The associated data is exactly 50 bytes. Offsets are within that data:

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 2 | `version` | The header's u16 version, `1` |
| 2 | 16 | `song_id` | The header's song ID |
| 18 | 4 | `entry_count` | The header's u32 entry count |
| 22 | 4 | `position` | Zero-based index position as a u32 |
| 26 | 24 | Index entry | This chunk's complete index entry, exactly as stored |

This binds the version, song ID, total chunk count, position and every
field of the chunk's index entry. Moving or swapping chunks fails their
authentication. Putting a chunk under another file's header or index
also fails.

*Why:* positions give unique nonces within a write. The fresh salt makes
the keys unique across writes, so key and nonce pairs are never reused.

## Chunk contents

After decryption, the chunk types, order, counts and grammars are exactly
those of [version 0](song-file-format-v0.md#chunk-types).
Readers check all of those rules and the
[lyric lines and syllables](song-file-format-v0.md#lyric-lines-and-syllables)
rules. The [media contents](song-file-format-v0.md#media) are unchanged.

The lyrics are exactly the supplied bytes
([D5](../decisions.md#d5-supplied-lyrics-are-authoritative--agreed)).
During decryption, the core does not decode, normalise or change them.
Lyric parsing reads those unchanged bytes by the linked rules.

## Limits

A reader rejects the whole file when any value is outside these limits.
Each stored chunk length is its version-0 plaintext length plus 16 bytes:

| What | Limit |
| --- | --- |
| Header | exactly 177 bytes |
| Index entry | exactly 24 bytes |
| Header and index tag | exactly 16 bytes |
| `entry_count` | 7 to 16,384 |
| File size | at most 4,294,967,295 bytes (2³² − 1) |
| Song details chunk, stored | 24 to 3,095 bytes |
| Thumbnail chunk, stored | 0 or 1, of 17 to 1,048,592 bytes |
| Lyrics chunk, stored | 17 to 1,048,592 bytes |
| Timing chunk, stored | exactly `4 + 8 × count + 16` bytes, 28 to 524,308 |
| Init segment chunk, stored | 20 to 65,809 bytes |
| Media segment chunk, stored | 17 to 67,108,880 bytes |

Everything else is as in [version 0's limits](song-file-format-v0.md#limits),
including plaintext sizes, syllable counts, song duration and segment times.

## Known-answer example

The core's tests check the full file bytes, the derived keys, the hex dump,
the SHA-256 and the [recovery wrap vector](#recovery-wrap-vector) below. They
are computed by code, never by hand.

The inputs are the same chunk contents as the
[version-0 example](song-file-format-v0.md#known-answer-example), with:

- `song_id`: the bytes `00` to `0F`;
- `salt`: the bytes `20` to `3F`;
- content key: the bytes `40` to `5F`;
- the recovery seed and HPKE ephemeral input of the
  [recovery wrap vector](#recovery-wrap-vector).

The example has seven index entries and no video or thumbnail.
Its layout is fixed:

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 177 | Header | Bytes 0–176 |
| 177 | 168 | Index | Bytes 177–344, seven entries |
| 345 | 16 | Header and index tag | Bytes 345–360 |
| 361 | 27 | Song details chunk | 11 plaintext bytes plus tag |
| 388 | 26 | Lyrics chunk | 10 plaintext bytes plus tag |
| 414 | 36 | Timing chunk | 20 plaintext bytes plus tag |
| 450 | 45 | Karaoke init chunk | 29 plaintext bytes plus tag |
| 495 | 18 | Karaoke media segment | 2 plaintext bytes plus tag |
| 513 | 49 | Original init chunk | 33 plaintext bytes plus tag |
| 562 | 18 | Original media segment | 2 plaintext bytes plus tag |

The file size is 580 bytes. The init bytes and media segments remain
the version-0 example's small placeholders, not playable media.

### Derived keys

The two keys that the [key derivation](#keys) gives for the example's salt
and content key. Do not use these values for real keys.

| Key | Value |
| --- | --- |
| `header_key` | `383aa6bc9d171f238935ff3e00360b231517f4922ab218af0e4814adadad4ae5` |
| `chunk_key` | `79eb134071396417529fc06d20b0669ad3a8dfd4c40c0ffb8971eb2f4f0e115a` |

### Hex dump

The same 580 bytes as an `xxd` dump. `xxd -r` turns it back into the file.

```text
00000000: 894c 5952 450d 0a1a 0100 0000 0700 0000  .LYRE...........
00000010: 0001 0203 0405 0607 0809 0a0b 0c0d 0e0f  ................
00000020: 2021 2223 2425 2627 2829 2a2b 2c2d 2e2f   !"#$%&'()*+,-./
00000030: 3031 3233 3435 3637 3839 3a3b 3c3d 3e3f  0123456789:;<=>?
00000040: 04af d5d8 459f adab 9ff6 be66 4571 08ef  ....E......fEq..
00000050: 67e2 fd8a fee4 a2d2 952a 0d03 2ce2 8652  g........*..,..R
00000060: 502c cc50 45d1 18ea cc6c 2904 8c3a c2a5  P,.PE....l)..:..
00000070: 136f 143d 2012 e52f 5954 26dc 49c0 c1b6  .o.= ../YT&.I...
00000080: 1ace 08f3 17ec 72da 00c4 5d1d dc25 4ba1  ......r...]..%K.
00000090: ca45 e744 438c 3296 d24e 9d38 e44a 6a24  .E.DC.2..N.8.Jj$
000000a0: c651 9a4e 0f77 e910 bfb5 7424 a361 0dfb  .Q.N.w....t$.a..
000000b0: 4001 0000 001b 0000 0069 0100 0000 0000  @........i......
000000c0: 0000 0000 0000 0000 0003 0000 001a 0000  ................
000000d0: 0084 0100 0000 0000 0000 0000 0000 0000  ................
000000e0: 0004 0000 0024 0000 009e 0100 0000 0000  .....$..........
000000f0: 0000 0000 0000 0000 0012 0000 002d 0000  .............-..
00000100: 00c2 0100 0000 0000 0000 0000 0000 0000  ................
00000110: 0013 0000 0012 0000 00ef 0100 0000 0000  ................
00000120: 0000 0000 00e8 0300 0014 0000 0031 0000  .............1..
00000130: 0001 0200 0000 0000 0000 0000 0000 0000  ................
00000140: 0015 0000 0012 0000 0032 0200 0000 0000  .........2......
00000150: 0000 0000 00e8 0300 0040 a3cb 685a b730  .........@..hZ.0
00000160: 8cd4 027c 6371 a8bf ba24 e38f 06e1 f83c  ...|cq...$.....<
00000170: 739b eb24 d730 13a0 d854 8292 7be7 5f47  s..$.0...T..{._G
00000180: 2e76 16a5 58b5 0fbb 2294 c5ed 7b75 ba9f  .v..X..."...{u..
00000190: 9a13 01ff 4447 29d7 0f0f 92f1 882a 1447  ....DG)......*.G
000001a0: daab 2a83 514f 25c3 43cc df09 fe84 4830  ..*.QO%.C.....H0
000001b0: 03fb 2334 f6b9 403f 5848 571c 6e4c 156a  ..#4..@?XHW.nL.j
000001c0: 8f30 3f83 3cab 2046 3d6a 50e2 b800 5ef4  .0?.<. F=jP...^.
000001d0: bdcb 0f98 ca6c 91b4 ebd9 b731 56e5 0876  .....l.....1V..v
000001e0: 3147 151e 243d fc1b 8fea fef9 da0e 3a60  1G..$=........:`
000001f0: 614b 3edc ac8f 409a 4758 938e 266e e71d  aK>...@.GX..&n..
00000200: 7cb2 6fb9 ccbd fa98 9205 f9b1 c7c9 57d7  |.o...........W.
00000210: 263a dd17 3ee1 64c6 556b d444 73a3 4549  &:..>.d.Uk.Ds.EI
00000220: c84d 3dd4 3909 8523 93ee 3f33 8273 9a03  .M=.9..#..?3.s..
00000230: 4924 3b44 22d8 2174 ee0f 1464 c717 4284  I$;D".!t...d..B.
00000240: acaa d358                                ...X
```

SHA-256 of the whole file:

```text
6925da4868149bf695801d237ae876fbc2e0db787eea403b8405b3bd1d67fb12
```

### Recovery wrap vector

This vector seals one content key to a recovery public key. The core's tests
read it. The recovery public key is the one in the
[recovery key](device-access.md#recovery-key) row for the same seed. The
ephemeral input is the 32-byte `ikmE` that RFC 9180 gives to `DeriveKeyPair`
to make the sender's ephemeral key. Production code draws it from the
system's random source. Do not use these values for real keys.

| Item | Value |
| --- | --- |
| Recovery seed | `606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f` |
| Recovery public key | `02585a2882fca9a0ee8cf896c3ac8e515402d3c85d91384bce2dce930ce3ce5307` |
| `song_id` | `000102030405060708090a0b0c0d0e0f` |
| Content key | `404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f` |
| Ephemeral input (`ikmE`) | `808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f` |
| `info` | `6c7972652f76312f7265636f766572792d77726170000102030405060708090a0b0c0d0e0f02585a2882fca9a0ee8cf896c3ac8e515402d3c85d91384bce2dce930ce3ce5307` |
| `recovery_enc` | `04afd5d8459fadab9ff6be66457108ef67e2fd8afee4a2d2952a0d032ce28652502ccc5045d118eacc6c29048c3ac2a5136f143d2012e52f595426dc49c0c1b61a` |
| `recovery_sealed` | `ce08f317ec72da00c45d1ddc254ba1ca45e744438c3296d24e9d38e44a6a24c6519a4e0f77e910bfb57424a3610dfb40` |

Opening `recovery_enc` and `recovery_sealed` with the recovery private key,
this `info` and empty `aad` gives the content key. A changed byte of
`recovery_sealed`, another `song_id` or another recovery private key fails
authentication. A `recovery_enc` that is not an uncompressed point on the
curve is refused before any open.

### Invalid variants

Each variant changes the example in one way. A reader rejects each one.
Chunk authentication failures are caught before that chunk is used, as
the [reading model](#reading-model) requires.

| Change | Why it is rejected |
| --- | --- |
| Version 0: bytes 8–9 are `00 00`, as in the version-0 example | The version is not 1. |
| Byte 0 is changed | The magic is wrong. |
| A byte of `song_id`, salt or recovery wrap (16–176) is changed | The header and index tag fails. |
| A byte of the index (177–344) is changed | The header and index tag fails. |
| A byte of the header and index tag (345–360) is changed | The header and index tag fails. |
| A byte of any chunk's ciphertext or tag is changed | That chunk's authentication fails. No changed plaintext is used. |
| The last byte is removed (579 bytes) | The last chunk ends past the file. This fails before playback. |
| A byte is added at the end (581 bytes) | The last chunk no longer ends at the end of the file. |
| The karaoke and original media segments, both 18 bytes, are swapped | Each chunk fails authentication at its position. |
| Two index entries are swapped or reordered | The header and index tag fails. |
| A chunk is dropped and the index is edited | The header and index tag fails. |
| A wrong content key is used | The header and index tag fails. |
