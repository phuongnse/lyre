# lyre-cli

`lyre-cli` is a developer tool in the core workspace. It builds a
[version 0](song-file-format-v0.md) song file from small fixtures, with the
timing written by hand. The Player can then be built and tested before Lyre
can make songs itself.

Version 0 is for development only. The files it writes are unencrypted, and
anyone with one can read every byte.

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
`artifacts/e2e/fixture-male.lyre`. The `inspect` command in the [repository
layout](../architecture.md#repository-layout) is not built yet.

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

Each track has `init`, the init segment file, and `segments`, a list of media
segments in order. Each segment has a `file` and a `duration_ms`.

- The media files are WebM init and media segments, cut beforehand as the
  [media](song-file-format-v0.md#media) section describes. `lyre-cli` treats
  them as opaque bytes, as the core does.
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

The files under `tests/fixtures/` total about 58 KB. A test fails when they
pass 64 KiB.
