# lyre-cli

`lyre-cli` is a developer tool in the core workspace. It builds a
[version 0](song-file-format-v0.md) song file from small fixtures, with the
timing written by hand. Given a device code, it builds an encrypted
[version 1](song-file-format-v1.md) song file and an access file instead. The
Player can then be built and tested before Lyre can make songs itself.

Version 0 is the default and is for development only. The files it writes are
unencrypted, and anyone with one can read every byte.

The terms in this doc are defined in the [concepts](../domain/concepts.md).

## Building a song file

```sh
lyre-cli build <manifest.toml> <out.lyre>
```

From the repository root, this builds the fixture song:

```sh
(cd core && cargo run -p lyre-cli -- build ../tests/fixtures/song/song.toml ../artifacts/fixture.lyre)
```

- The command reads the [manifest](#manifest) and every file it names, then
  checks the song the way the core's writer does.
- The output file is written only when the whole song is accepted. Its folder
  is created when missing.
- It exits with 0 on success, 1 when the song is rejected and 2 when the
  arguments are wrong.
- An error goes to stderr. It names the rule broken and, for the timing file,
  the line. It never quotes lyric text.

The built file is not committed. Tests build it from the fixtures when they
run: `scripts/e2e.sh` builds it into `artifacts/e2e/fixture.lyre` for the
Player journeys. It also builds `male.toml` into
`artifacts/e2e/fixture-male.lyre`, and `h265.toml` into
`artifacts/e2e/fixture-h265.lyre`. A journey that needs a version-1 file
builds it during the test, with the helper `buildForDevice` in
`tests/e2e/journeys/song-file.ts`, because the device code exists only once
the page has made it. The `inspect` command in the [repository
layout](../architecture.md#repository-layout) is not built yet.

## Building an encrypted song file

```sh
lyre-cli build <manifest.toml> <out.lyre> --device-code <code> --access <out.lyrekey>
```

- The command writes a version-1 song file and an
  [access file](device-access.md#access-file) for the device with that
  [device code](../domain/concepts.md). Anyone with a different device key
  cannot open the access file.
- The two options go together, in this order, after the two paths. Giving them
  is what selects version 1. With only one of them, or in another order, the
  command prints the usage and writes nothing. Without them it writes version
  0, as above. Version 0 stays the default until the web Player reads
  version 1.
- Every build makes a fresh content key. The key is written only inside the
  access file, wrapped for the device. It is never printed or logged.
- The access file holds one entry for the song, with the owner role.
- The [format](song-file-format-v1.md) needs a recovery wrap. The tool seals
  it to a random recovery key that it makes and drops. So these files cannot
  be recovered with a recovery key.
- Both files are built before either is written. The song file is written
  first. If writing the access file then fails, the song file stays without
  one.
- It exits with 0 on success, 1 when the song is rejected or a file cannot be
  written, and 2 when the arguments or the device code are wrong. With exit 2
  nothing is written.

## Manifest

The manifest is a TOML file. Paths in it are relative to the manifest's
folder, or absolute. Unknown fields are rejected.

| Field | Meaning |
| --- | --- |
| `song_id` | The song ID, written as exactly 32 hex digits. It is fixed rather than random, so the same fixtures always give the same bytes. |
| `lyrics` | The lyrics file. Its bytes are stored exactly as they are (D5). |
| `timing` | The [timing file](#timing-file). |
| `thumbnail` | The thumbnail image. Optional. |
| `[details]` | The song details: `title`, a required `vocal_role` of `"male"` or `"female"`, and optionally `artist` and `composer`. A missing artist or composer is stored as empty, which means not known. |
| `[video]` | The video track. Optional. |
| `[karaoke]` | The karaoke track. |
| `[original]` | The original track. |

Each track has `type`, `init`, the init segment file, and `segments`, a list
of media segments in order. Each segment has a `file` and a `duration_ms`.

- `type` is the track's MSE type, which the song file stores, such as
  `'video/webm; codecs="vp09.00.40.08"'`. Write it as a TOML literal string,
  in single quotes, so its double quotes need no escapes. It is required and
  has no default, because a default could label a track with the wrong codec.
  The core checks only its container part, as the
  [media](song-file-format-v0.md#media) section describes.
- The media files are init and media segments, cut beforehand as the
  [media](song-file-format-v0.md#media) section describes. `lyre-cli` treats
  them as opaque bytes, as the core does. The init segment file holds only
  the container's init bytes. `lyre-cli` adds the stored type.
- Durations are written by hand. A segment's duration runs from its first
  Cluster's timestamp to the next segment's, so each segment's start matches
  its media.

## Timing file

The timing file is UTF-8 text with one syllable per line. A line gives the
start in milliseconds, the end in milliseconds, then the syllable exactly as
it is in the lyrics, separated by whitespace:

```text
# start end syllable
0 300 Mưa
300 600 rơi
```

- Lines are numbered from 1, and every line counts, including comments and
  blank lines.
- Blank lines, and lines whose first non-space character is `#`, are skipped.
- Lines end with LF or CRLF. A leading byte-order mark is skipped.
- Times are written in ASCII digits and fit in 32 bits.
- The timed lines follow the syllables of the lyrics in order, one line per
  syllable. A syllable must match the lyrics byte for byte.

The file is rejected at the first line that breaks a rule. Nothing is
written. The rules are checked in this order on each line:

| Error | When |
| --- | --- |
| Malformed | The line is not valid UTF-8, or does not have exactly a start, an end and a syllable. |
| Missing syllable | The line names the syllable after the one expected, so the expected one was missed. When the file ends before the last syllable, the error points at the line after the last line. |
| Not in the lyrics | The line names any other syllable, or comes after the last syllable of the lyrics. |
| Goes backwards | The syllable ends at or before its start, or starts before the previous syllable starts. |
| Overlaps | The syllable starts before the previous syllable ends. |

A syllable may start exactly when the previous one ends. After these checks,
the core's rules still apply: for example, the last syllable must end by the
end of the song.

The parser lives in the core (`lyre-core`), so the web client can read a
timing file the same way through `lyre-wasm`.

## The fixture song

`tests/fixtures/song/` holds a synthetic 12-second song. No file in it comes
from real media.

- **Video.** A 160×90 VP9 test pattern at 15 frames per second, in six
  two-second segments.
- **Karaoke track.** A 440 Hz Opus tone, in six segments of about two
  seconds.
- **Original track.** The same at 880 Hz, so a test can tell which track
  plays.
- **Thumbnail.** A JPEG frame of the test pattern.
- **Lyrics.** Three short made-up Vietnamese lines, not from any real song.
- **Male variant.** `male.toml` is the same song with a male vocal role, for
  the vocal role colour journey. A lyre-cli test keeps it equal to `song.toml`
  apart from its header comment and vocal role.
- **H.265 variant.** `h265.toml` is the same song with the video type
  `video/mp4; codecs="hvc1.1.6.L93.B0"`, an H.265 type. Playwright's
  Chromium cannot play it, so the Player journey checks the cannot-play
  message with it. Its video bytes are still the VP9 fixture's, and are never
  read. A lyre-cli test keeps it equal to `song.toml` apart from its header
  comment and video type.
- **Timing.** Written by hand for those lyrics. The first lyric line starts
  at 2,000 ms, after a lead-in. The second follows a 300 ms break. The third
  starts 5,000 ms after the second ends. So the fixture has both gaps that
  come before [countdown dots](../ui-conventions.md#countdown-dots): the start
  of the song and a break of 5 s or longer.

`make.sh` next to them holds the ffmpeg commands that made the media and the
thumbnail. Running it again recreates them. It needs ffmpeg built with libvpx
and libopus. ffmpeg versions may give different bytes, and the tests do not
depend on exact media bytes. If the segment times change, update the
durations in `song.toml`.

## The source fixtures

`tests/fixtures/source/make.sh <out-dir>` makes small synthetic sources for
the source check journeys: an MP4, a WebM and an MP3 with tags, a WebM with
no audio, a WebM whose timeline starts at 1.5 s, `cover.mp3`, an MP3 whose
cover art is a 1000×1000 PNG, and `karaoke.webm`, which stands in for a
karaoke track. No real media is used.
They are not committed: `scripts/e2e.sh` makes them into
`artifacts/e2e/sources/`. It needs ffmpeg built with libx264, libvpx, libopus
and libmp3lame. `scripts/setup.sh` installs ffmpeg for the journeys when it
is missing.

Every source holds a 2 s sine at 440 Hz and 48 kHz. The WebM (Opus) and MP3
fixtures check decoding. `karaoke.webm` is audio only: a 3 s sine at 660 Hz
in Opus. It is longer than the sources, so making the audio tracks from it
and `song.webm` also checks that it is cut to the source's length. The MP4 holds AAC audio, which not every Chromium
build decodes. Its journey makes Chromium report that it has no AAC decoder,
so the MP4 checks the no-audio refusal instead.

The source check journeys also check the cannot-play reasons. One makes
Chromium report that it cannot play H.264, and checks that the MP4 names its
video next to its tags. Another does the same for Opus with the WebM. The MP3
is stored as `audio/mp4; codecs="mp4a.6B"`, which Playwright's Chromium does
not accept. So its journeys expect the MP3 audio reason next to its details,
or no reason in a browser that accepts the type. A last one makes Chromium
report that it cannot encode Opus, and checks that making the audio tracks
shows only the cannot-encode-audio message.

The song file journeys make a song file on the source check page from a
source, `karaoke.webm`, a one-line lyrics file and a timing file, and open it
in the Player. `song.webm` gives a song file with video and a thumbnail,
which plays, and whose Karaoke and Original switch keeps the position while
paused. `song.mp3` gives one with no video and no thumbnail. Playwright's
Chromium refuses its original track's type, so its journey expects the
Player's cannot-play message there, and playback in a browser that accepts
the type. A timing that ends at 5 s, after the 2 s song, gets the page's
refusal and no download.

The thumbnail journeys check the thumbnail the web client makes. `song.webm`
gives its middle frame as a JPEG of 64×36. `cover.mp3` gives its PNG cover
art re-encoded as a JPEG and scaled down to 360×360. `song.mp3` has no cover
art and gives no thumbnail.

The files under `tests/fixtures/` total about 67 KB. A test fails when they
pass 72 KiB. The cap keeps the fixtures small and synthetic, so no source
media, song files made from real media or model weights get committed.
