# Song file format, version 0

A song file is one `.lyre` file that holds one song: its media, the lyrics,
the timing, the song details and an optional thumbnail. The media is the
karaoke track, the original track and, if there is one, the video. The source
itself is not stored. Only what Lyre made from it is.

Version 0 is unencrypted and for development only. It is used in M1 and M2,
rejected from M3 and never published (see the
[architecture](../architecture.md#song-file-encrypted-from-m3)).
It is not protection of any kind: anyone with the file can read every byte.

The terms in this doc are defined in the [concepts](../domain/concepts.md).
All integers are unsigned and little-endian. Sizes use 1 KiB = 1,024 bytes
and 1 MiB = 1,048,576 bytes.

## Reading model

The client passes bytes and the core does no file work. A player never needs
the whole file in memory:

1. The client reads bytes 0 to 32 and the core parses the [header](#header).
   The header gives the index length, which is `entry_count × 24` bytes.
2. The client reads the [index](#index) and passes it with the total file
   size. The core checks every structural rule using only these two: the
   chunk order and counts, every chunk's offset and length, the segment times
   and the file size.
3. The client reads any chunk at the offset and length its index entry gives.
   The core parses the chunk together with its index entry.

The core checks the timing against the lyrics once it has both chunks.

To seek, the player finds the media segment whose
`[start_ms, start_ms + duration_ms)` holds the wanted time, then reads only
that segment and the ones after it. Streaming from Google Drive *(planned for
M7)* reads the same byte ranges.

## Header

The header is 32 bytes.

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 8 | `magic` | `89 4C 59 52 45 0D 0A 1A` |
| 8 | 2 | `version` | u16, `0` |
| 10 | 2 | `reserved` | u16, must be `0` |
| 12 | 4 | `entry_count` | u32, the number of index entries |
| 16 | 16 | `song_id` | 16 random bytes, chosen when the song is made |

The index starts at offset 32.

A reader rejects the file when the magic is wrong, the version is not 0 or the
reserved field is not 0.

*Why this magic:* it follows the pattern of PNG's. The first byte is not
ASCII, so the file is not mistaken for text. `LYRE` names it. A text-mode
transfer that changes line ends alters the CR LF, so the magic no longer
matches.

## Index

The index is `entry_count` entries of 24 bytes each, one per chunk, in the
order the chunks are stored.

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 2 | `type` | u16, the [chunk type](#chunk-types) |
| 2 | 2 | `reserved` | u16, must be `0` |
| 4 | 4 | `length` | u32, the chunk's stored bytes |
| 8 | 8 | `offset` | u64, from the start of the file |
| 16 | 4 | `start_ms` | u32, for media segments only, otherwise `0` |
| 20 | 4 | `duration_ms` | u32, for media segments only, otherwise `0` |

Rules:

- **No gaps and no overlap.** The first chunk starts at
  `32 + 24 × entry_count`. Each next chunk starts at the previous chunk's
  offset plus its length.
- **The file ends at the last chunk.** The last chunk's offset plus its length
  equals the file size. So the index alone shows a truncated or padded file.
- **Segments are contiguous within a track.** A track's first segment starts
  at 0 to 50 ms, and each next one starts where the previous one ended
  (`start_ms + duration_ms`). This applies to the video, karaoke and original
  tracks.
- **Unused fields are zero.** `start_ms` and `duration_ms` are 0 on every
  chunk that is not a media segment.

*Why a first segment may start late:* in some sources the audio starts a few
milliseconds after the video. Letting that track start up to 50 ms late keeps
it in sync, and the index still records each segment's true time.

*Why fixed sizes:* a fixed grammar is simple to bound and to fuzz *(planned
for M3)*, and a reader finds any chunk without scanning.

## Chunk types

Chunks come in this order, and no other type or order is accepted:

| Type | Chunk | Count |
| --- | --- | --- |
| 1 | Song details | exactly 1 |
| 2 | Thumbnail | 0 or 1 |
| 3 | Lyrics | exactly 1 |
| 4 | Timing | exactly 1 |
| 16 | Video init segment | 0 or 1 |
| 17 | Video media segment | 1 to 4,096 after a video init segment, otherwise 0 |
| 18 | Karaoke init segment | exactly 1 |
| 19 | Karaoke media segment | 1 to 4,096 |
| 20 | Original init segment | exactly 1 |
| 21 | Original media segment | 1 to 4,096 |

- **The video is optional.** The video init segment and the video media
  segments are both present or both absent. A song made from an audio file has
  no video.
- **The thumbnail is optional.** The web client makes it from the source: the
  frame at the middle of a video, or the cover art of an audio source, fitted
  within 640×360. An audio source without cover art has none. The web client writes it
  into the song file. Songs built by hand for tests may have none.
- **Both audio tracks are cut at about the same times.** The original track
  has the same number of segments as the karaoke track. Each original
  segment's start and end (`start_ms + duration_ms`) are within 50 ms of those
  of the karaoke segment at the same position, because the original keeps its
  own codec's frame length. Switching between Karaoke and Original then keeps
  the position.
- **The song's duration is the karaoke track's end**, its last segment's
  `start_ms + duration_ms`.
- **The video matches the song.** The video's end, its last segment's
  `start_ms + duration_ms`, is within 1,000 ms of the song's duration. Video segments may be cut at other times
  than the audio, because they must start on a keyframe.

### Song details

Four fields in this order: the title, the artist, the composer and the vocal
role. The title, the artist and the composer are each a u16 byte length, then
that many UTF-8 bytes. The vocal role is one byte after the composer.

- The title has 1 to 1,024 bytes. The artist and the composer have 0 to 1,024
  bytes, where 0 means not known.
- Each text field is valid UTF-8 with no NUL character.
- Each text field is stored as supplied.
- The vocal role is `1` for male or `2` for female. It records one role for
  the whole song, so it covers solo songs. Any other value, or a missing byte,
  is rejected. Roles per lyric line come with M8.
- No bytes are left after the vocal role.

### Thumbnail

JPEG bytes, 1 byte to 1 MiB. The core treats them as opaque and checks only
the size. The client's image decoder checks the image.

### Lyrics

The lyrics exactly as supplied, byte for byte
([D5](../decisions.md#d5-supplied-lyrics-are-authoritative--agreed)). A
leading byte-order mark is kept.

- 1 to 1,048,576 bytes.
- Valid UTF-8 with no NUL character.
- At least one word with letters, as in
  [design knowledge](../domain/knowledge.md#lyrics).

How the core reads lyric lines and syllables from these bytes is set out in
[lyric lines and syllables](#lyric-lines-and-syllables).

### Timing

A u32 `count`, then `count` pairs of u32 `start_ms` and u32 `end_ms`, one
pair per syllable, in lyric order. The chunk is exactly `4 + 8 × count`
bytes.

- `count` is 1 to 65,536, and equals the number of syllables in the lyrics.
- Each syllable starts before it ends: `start_ms < end_ms`.
- Syllables do not overlap: each `end_ms` is at most the next syllable's
  `start_ms`.
- The last `end_ms` is at most the song's duration.

### Media segments

Init segment chunks are 4 to 65,793 bytes: the stored type and the
container's init bytes. Media segments are 1 byte to 64 MiB. An audio segment
has a `duration_ms` of 1 to 10,000. A video segment has 1 to 20,000. The
[media](#media) section says what these bytes hold. The core treats the media
as opaque and checks only the sizes, counts and times, and the container part
of each stored type. The client's decoders check the media itself.

*Why opaque:* the core does no media work, so it has no media parser to keep
in step with the decoders.

## Lyric lines and syllables

Both clients must count syllables the same way, because timing pairs are
matched to syllables by position. The core's lyrics parsing implements
exactly these rules:

- **The stored bytes are kept.** A leading U+FEFF (byte-order mark) stays in
  the lyrics chunk. Reading lines and syllables skips one leading U+FEFF.
- **Line ends.** A line ends at LF, at CRLF (one line end, not two) or at a
  lone CR. U+2028, U+2029, U+0085, VT and FF do not end a line.
- **Syllables.** Within a line, every character for which Rust's
  `char::is_whitespace` is true separates syllables. A syllable is a longest
  non-empty run of other characters. Runs of separators never make empty
  syllables, the same as `str::split_whitespace`.
- **Lyric lines.** A lyric line is a line with at least one syllable. Blank
  and whitespace-only lines stay in the stored bytes but are not lyric lines,
  as in [design knowledge](../domain/knowledge.md#lyrics).
- **Timing order.** The timing lists the syllables of every lyric line in
  order, from the first lyric line to the last.

These rules differ from Rust's `str::lines`, which does not end a line at a
lone CR, so the core has its own line splitter.

| Lyrics, as escaped text | Lyric lines | Syllables |
| --- | --- | --- |
| `"\u{FEFF}a\n"` | 1 | 1 |
| `"a b\r\nc"` | 2 | 3 |
| `"a\rb"` | 2 | 2 |
| `"a\r\r\nb"` | 2 (the blank line between is not a lyric line) | 2 |
| `"a\u{2028}b"` | 1 | 2 |
| `"a \t\u{00A0} b\n\n"` | 1 | 2 |
| `"a\n \t\nb"` | 2 (the whitespace-only line is not a lyric line) | 2 |

## Display lines

Display lines are not stored in the song file. The core lays them out at play
time from the lyrics, the timing and the text widths the client measures
([D17](../decisions.md#d17-display-lines-are-laid-out-at-play-time--agreed)).
The rules for a good split are in
[design knowledge](../domain/knowledge.md#lyrics).

## Media

Lyre keeps the source's video and original audio as they were coded, and only
repackages them. The karaoke track is the only media it encodes
([D24](../decisions.md#d24-sources-are-repackaged-and-only-the-karaoke-track-is-encoded--agreed)).
Each track is stored so that Media Source Extensions (MSE) can stream it: a
browser appends each chunk to a `SourceBuffer` as it reads it.

- **Container.** WebM, in the MSE WebM byte stream format, with
  `TimecodeScale` 1,000,000 so timestamps are in milliseconds. Or, for a codec
  WebM cannot hold, fragmented MP4 in the MSE ISO BMFF byte stream format.
  Fragmented MP4 is the MP4 layout that is streamed in pieces. D24 says which
  container a codec gets.
- **Init segment chunk.** It starts with the track's stored type:

  | Size | Field | Value |
  | --- | --- | --- |
  | 2 | `type_length` | u16, 1 to 255 |
  | `type_length` | `type` | The track's MSE type, in printable ASCII (`20` to `7E`), for example `video/mp4; codecs="avc1.640028"` |
  | 1 to 65,536 | `init` | The container's init bytes, up to the end of the chunk |

  The container's init bytes hold exactly one track. In WebM they are the
  EBML header, then the Segment element with its Info and Tracks elements. In
  fragmented MP4 they are the `ftyp` and `moov` boxes.
- **Stored type checks.** The core checks only the
  container part of each type. The video's type starts with `video/webm;` or
  `video/mp4;`. The original track's starts with `audio/webm;` or
  `audio/mp4;`. The karaoke track's is exactly `audio/webm; codecs="opus"`.
  The core does not read the `codecs` value. The device's decoders decide
  whether it plays.
- **Media segment chunk.** One or more whole Clusters of that track, or one
  or more whole `moof` and `mdat` box pairs. It starts
  on a keyframe that needs no earlier frame. Its first frame's presentation
  time, rounded down to a whole millisecond, equals the index entry's
  `start_ms`. A writer never puts a track's first segment at 0 when its
  first frame is later.
- **Video.** The video is the source's coded frames, at any codec,
  resolution and frame rate the device plays. A video segment runs from one
  keyframe to a later one, and lasts at most 20,000 ms.
- **Audio.** The karaoke track is Opus, 48 kHz, stereo, with the MSE type
  `audio/webm; codecs="opus"`. The original track is the source's audio as it
  was coded. The karaoke track and the original track are separate chunk
  sequences, each with one track.
- **The type is checked first.** The stored type lets a player ask
  `MediaSource.isTypeSupported`, or Media3 its decoders *(planned for M4)*,
  before it reads a segment. When the device cannot play a type, the web
  Player shows the plain message of D24 and plays nothing. The message names
  the track, as in "This device cannot play this song's video." Naming the
  codec, as in "This device cannot play H.265 video", is *(planned for M4)*.

*Why VP9 and Opus in the tests:* Playwright's Chromium has no H.264 or AAC
decoder. So the fixture songs and the web journeys use VP9 video and Opus
audio, and other codecs are checked on real devices. One journey stores an
H.265 type that Playwright's Chromium cannot play, to check the message.

*Why these play through Media3 (planned for M4):* Media3 plays WebM and
fragmented MP4 segments through its DASH source, with a data source that reads
the chunks. The device's decoders decide which codecs play.

## Limits

A reader rejects the whole file when any value is outside these limits.

| What | Limit |
| --- | --- |
| Header | exactly 32 bytes |
| Index entry | exactly 24 bytes |
| `entry_count` | 7 to 16,384 |
| File size | at most 4,294,967,295 bytes (2³² − 1) |
| Song details chunk | 8 to 3,079 bytes |
| Title | 1 to 1,024 bytes |
| Artist, composer | 0 to 1,024 bytes each |
| Vocal role | 1 byte, `1` (male) or `2` (female) |
| Thumbnail chunk | 0 or 1, of 1 to 1,048,576 bytes |
| Lyrics chunk | 1 to 1,048,576 bytes |
| Timing chunk | exactly `4 + 8 × count` bytes, 12 to 524,292 |
| Syllables (`count`) | 1 to 65,536 |
| Init segment chunk | 4 to 65,793 bytes |
| Stored type | 1 to 255 printable ASCII bytes |
| Container init bytes | 1 to 65,536 bytes |
| Media segment chunk | 1 to 67,108,864 bytes (64 MiB) |
| Audio media segment `duration_ms` | 1 to 10,000 |
| Video media segment `duration_ms` | 1 to 20,000 |
| Audio cut tolerance | 50 ms between each original segment's start and end and those of the karaoke segment at the same position |
| Media segments per track | 1 to 4,096 |
| First media segment `start_ms` | 0 to 50 ms in each track |
| Song duration | 1 to 3,600,000 ms (1 hour) |
| Video end | within 1,000 ms of the song duration |

Some limits, such as 1 hour, are working values for development.
A later format version may raise them.

## Room for encryption (M3)

Version 0 leaves room for M3 to encrypt and authenticate the file without
changing how a player reads it:

- **The magic and the version stay at the same offsets in every version**, so
  a reader can always tell which version it has, and reject version 0 from M3.
- **Each chunk is an independent unit.** M3 can encrypt and authenticate each
  chunk on its own, with its position in the index bound in, so chunks cannot
  be swapped or reordered. A chunk's stored length may grow by an
  authentication tag.
- **The header and the index can be authenticated as their own unit**, before
  any chunk is read.

The scheme is [D31](../decisions.md#d31-song-files-are-encrypted-shared-and-recovered-with-one-scheme--agreed).
Its encrypted byte layout is specified in
[song file format, version 1](song-file-format-v1.md). The core reads and
writes version 1, and the clients move to it in M3 *(planned for M3)*.
Encryption decides who can open a song file. It does not stop copying once a
song is open.

## Known-answer example

This 307-byte song file is the core's known-answer example. It holds:

- `song_id`: the bytes `00` to `0F`;
- song details: the title "Mưa", with no artist and no composer, and the
  vocal role female (11 bytes);
- lyrics: `"Mưa rơi\n"` (10 bytes), which is 1 lyric line with 2 syllables;
- timing: 2 syllables, from 0 to 500 ms and from 500 to 1,000 ms (20 bytes);
- the karaoke track: the stored type `audio/webm; codecs="opus"` with the
  init bytes `"ki"`, and one media segment `"ks"` from 0 ms, lasting
  1,000 ms;
- the original track: the stored type `audio/mp4; codecs="mp4a.40.2"` (AAC
  in fragmented MP4) with the init bytes `"oi"`, and one media segment `"os"`
  from 0 ms, lasting 1,000 ms;
- no video and no thumbnail.

The init bytes and the media segments are 2-byte placeholders, not playable
media. This is valid version 0, because the core does not check media
content. It keeps the example small enough to check by hand. The original
track's type shows that it keeps its own codec and container.

### Annotated bytes

```text
offset  bytes                                    meaning
------  ---------------------------------------  -----------------------------
                                                 Header
   0    89 4C 59 52 45 0D 0A 1A                  magic
   8    00 00                                    version 0
  10    00 00                                    reserved
  12    07 00 00 00                              entry_count 7
  16    00 01 02 03 04 05 06 07                  song_id
  24    08 09 0A 0B 0C 0D 0E 0F                  song_id
                                                 Index entry 1: song details
  32    01 00  00 00  0B 00 00 00                type 1, reserved, length 11
  40    C8 00 00 00 00 00 00 00                  offset 200
  48    00 00 00 00  00 00 00 00                 start_ms 0, duration_ms 0
                                                 Index entry 2: lyrics
  56    03 00  00 00  0A 00 00 00                type 3, reserved, length 10
  64    D3 00 00 00 00 00 00 00                  offset 211
  72    00 00 00 00  00 00 00 00                 start_ms 0, duration_ms 0
                                                 Index entry 3: timing
  80    04 00  00 00  14 00 00 00                type 4, reserved, length 20
  88    DD 00 00 00 00 00 00 00                  offset 221
  96    00 00 00 00  00 00 00 00                 start_ms 0, duration_ms 0
                                                 Index entry 4: karaoke init
 104    12 00  00 00  1D 00 00 00                type 18, reserved, length 29
 112    F1 00 00 00 00 00 00 00                  offset 241
 120    00 00 00 00  00 00 00 00                 start_ms 0, duration_ms 0
                                                 Index entry 5: karaoke segment
 128    13 00  00 00  02 00 00 00                type 19, reserved, length 2
 136    0E 01 00 00 00 00 00 00                  offset 270
 144    00 00 00 00  E8 03 00 00                 start_ms 0, duration_ms 1000
                                                 Index entry 6: original init
 152    14 00  00 00  21 00 00 00                type 20, reserved, length 33
 160    10 01 00 00 00 00 00 00                  offset 272
 168    00 00 00 00  00 00 00 00                 start_ms 0, duration_ms 0
                                                 Index entry 7: original segment
 176    15 00  00 00  02 00 00 00                type 21, reserved, length 2
 184    31 01 00 00 00 00 00 00                  offset 305
 192    00 00 00 00  E8 03 00 00                 start_ms 0, duration_ms 1000
                                                 Chunk 1: song details
 200    04 00  4D C6 B0 61                       title, 4 bytes: "Mưa"
 206    00 00                                    artist, 0 bytes
 208    00 00                                    composer, 0 bytes
 210    02                                       vocal role 2, female
                                                 Chunk 2: lyrics
 211    4D C6 B0 61 20 72 C6 A1 69 0A            "Mưa rơi\n"
                                                 Chunk 3: timing
 221    02 00 00 00                              count 2
 225    00 00 00 00  F4 01 00 00                 "Mưa": 0 to 500 ms
 233    F4 01 00 00  E8 03 00 00                 "rơi": 500 to 1000 ms
                                                 Chunk 4: karaoke init
 241    19 00                                    type_length 25
 243    61 75 64 69 6F 2F 77 65 62 6D 3B 20 63   type (25 bytes): audio/webm; c
 256    6F 64 65 63 73 3D 22 6F 70 75 73 22      type, continued: odecs="opus"
 268    6B 69                                    init "ki", a placeholder
                                                 Chunk 5: karaoke segment
 270    6B 73                                    "ks", a placeholder
                                                 Chunk 6: original init
 272    1D 00                                    type_length 29
 274    61 75 64 69 6F 2F 6D 70 34 3B 20 63 6F   type (29 bytes): audio/mp4; co
 287    64 65 63 73 3D 22 6D 70 34 61 2E 34 30   type, continued: decs="mp4a.40
 300    2E 32 22                                 type, continued: .2"
 303    6F 69                                    init "oi", a placeholder
                                                 Chunk 7: original segment
 305    6F 73                                    "os", a placeholder
 307                                             end of file
```

### Hex dump

The same 307 bytes as an `xxd` dump. `xxd -r` turns it back into the file.

```text
00000000: 894c 5952 450d 0a1a 0000 0000 0700 0000  .LYRE...........
00000010: 0001 0203 0405 0607 0809 0a0b 0c0d 0e0f  ................
00000020: 0100 0000 0b00 0000 c800 0000 0000 0000  ................
00000030: 0000 0000 0000 0000 0300 0000 0a00 0000  ................
00000040: d300 0000 0000 0000 0000 0000 0000 0000  ................
00000050: 0400 0000 1400 0000 dd00 0000 0000 0000  ................
00000060: 0000 0000 0000 0000 1200 0000 1d00 0000  ................
00000070: f100 0000 0000 0000 0000 0000 0000 0000  ................
00000080: 1300 0000 0200 0000 0e01 0000 0000 0000  ................
00000090: 0000 0000 e803 0000 1400 0000 2100 0000  ............!...
000000a0: 1001 0000 0000 0000 0000 0000 0000 0000  ................
000000b0: 1500 0000 0200 0000 3101 0000 0000 0000  ........1.......
000000c0: 0000 0000 e803 0000 0400 4dc6 b061 0000  ..........M..a..
000000d0: 0000 024d c6b0 6120 72c6 a169 0a02 0000  ...M..a r..i....
000000e0: 0000 0000 00f4 0100 00f4 0100 00e8 0300  ................
000000f0: 0019 0061 7564 696f 2f77 6562 6d3b 2063  ...audio/webm; c
00000100: 6f64 6563 733d 226f 7075 7322 6b69 6b73  odecs="opus"kiks
00000110: 1d00 6175 6469 6f2f 6d70 343b 2063 6f64  ..audio/mp4; cod
00000120: 6563 733d 226d 7034 612e 3430 2e32 226f  ecs="mp4a.40.2"o
00000130: 696f 73                                  ios
```

SHA-256 of the whole file:

```text
6334dbaa7990515e0b1585e51963f4f73a537dfaff43c422c07f6b7f8494e5a6
```

### Invalid variants

Each variant changes the example in one way. A reader rejects each one.

| Change | Rule it breaks |
| --- | --- |
| Byte 0 is `88` instead of `89` | The magic is wrong. |
| Bytes 8 and 9 are `01 00` | The version is not 0. |
| The last byte is removed (306 bytes) | The last chunk ends after the end of the file. |
| One byte is added at the end (308 bytes) | The last chunk does not end at the end of the file. |
| Byte 210, the vocal role, is `03` | The vocal role is not known. |
| Byte 221, the timing count, is `03` | The timing chunk is not `4 + 8 × 3` bytes, and 3 is not the lyrics' 2 syllables. |
| Byte 196, the original segment's `duration_ms`, is `B5` (949) | The original segment ends 51 ms from the karaoke segment's. |
| Byte 243 is `41` (`A`) | The karaoke track's stored type is not exactly `audio/webm; codecs="opus"`. |
