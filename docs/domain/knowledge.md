# Design knowledge

This document explains what makes a good karaoke song, what is hard about
making one on a user's device, and which mistakes Lyre must avoid. The
[decisions](../decisions.md) and [concepts](concepts.md) build on it. Each rule
gives its reason, so it can be weighed against new requirements instead of
being followed blindly.

## What makes a good karaoke song

- **The right words.** Singers read the screen, not the audio. A wrong word
  breaks the song, so the supplied lyrics are the truth (D5). Lyre never runs
  speech recognition to "fix" them.
- **Timing per syllable.** Vietnamese is sung syllable by syllable, and each
  space-separated token is one syllable. The highlight sweeps across each
  syllable while it is sung.
- **A clean karaoke track.** Leftover vocals in the karaoke track are the most
  noticed fault after wrong words.
- **The original track.** Singers switch to the original to learn a part, so
  both tracks stay in the song and stay in sync.
- **The highlight follows the lead singer.** It ends where the lead stops,
  not where a backing ad-lib trails off.

## Lyrics

- **Keep the exact bytes.** Store the supplied text exactly, including blank
  lines and whitespace, separately from the timing derived from it. Compare
  and hash the exact bytes. A lyric correction creates a new version of the
  song's lyrics; the owner's original file is never edited.
- **Input limits.** UTF-8, at most 1 MiB (1,048,576 bytes) as supplied, at
  least one word with letters, no NUL characters. A leading byte-order mark
  is kept with the bytes and skipped when reading lines and syllables.
- **Lines and syllables.** LF, CRLF or a lone CR ends a line. Each line that
  holds a syllable is a lyric line, one sung phrase. Blank and
  whitespace-only lines stay in the bytes but are not lyric lines. Any
  Unicode whitespace character, such as a tab or a no-break space, separates
  syllables, and a run of whitespace never makes an empty syllable.
- **Pair lyrics by exact name.** A lyrics file belongs to a source only when
  both have exactly the same name stem: `Song.mp4` and `Song.txt`. Lyrics for
  a whole source are never assigned to a section cut from it, because the
  section sings only part of them.
- **Normalise only to search.** Vietnamese search ignores case and diacritics,
  but display and storage keep the text exactly as written.
- **Display lines are not lyric lines.** A long lyric line can be shown as
  several display lines. The split uses the owner's punctuation, real pauses
  in the singing (0.18 s (180 ms) or longer) and the measured width of the
  text. It never adds punctuation and never changes the number of lyric lines.
- **Do not split Vietnamese words.** Many Vietnamese words have two or more
  syllables ("kỷ niệm", "nụ cười"). A display split inside one reads badly. A
  split should also avoid ending a line on a linking word ("và", "của",
  "những", "một") or starting one with a trailing modifier ("xưa", "này",
  "ấy"). The core finds word boundaries with a Wiktionary list of
  multi-syllable words, plus short lists written for Lyre for linking words
  and trailing modifiers. See
  [D18](../decisions.md#d18-vietnamese-word-boundaries-from-a-word-list--agreed).
- **Choosing a layout.** The core picks the fewest display lines that fit.
  Among those, it prefers splits at punctuation or pauses, then plain splits,
  then splits that end on a linking word or start with a trailing modifier.
  A split at punctuation or a pause counts as good even next to such a word,
  because the owner's punctuation and the singer's pause show where the
  phrase really breaks, while the short lists only guess. A remaining tie
  goes to the most even line widths, which read better while singing. A run
  that cannot be split without breaking a listed word stays whole, even when
  it is wider than the screen, because a broken word reads worse than a
  clipped line.

## Processing

The stages, in order:

1. **Read the source.** Duration, streams, and title, artist and composer
   tags. The source needs an audio stream; video is optional. Its video and
   audio must be in codecs the making device can play, in the stored types
   D24 gives them, or the source is refused. The reason names the track and
   the codec.
2. **Extract the audio** of the song, or of the section, at full quality.
3. **Separate** vocals from the karaoke track.
4. **Align** the supplied syllables against the vocals.
5. **Clean up** vocals left in the karaoke track *(planned for M8)*.
6. **Classify vocal roles** *(planned for M8)*.
7. **Lay out the display lines** and their timing.
8. **Package the playback media:** repackage the source's video and
   original audio as coded, encode the karaoke track (Opus) and make the
   thumbnail
   ([D24](../decisions.md#d24-sources-are-repackaged-and-only-the-karaoke-track-is-encoded--agreed)).
9. **Write the song file** and remove everything the task made on the way.

What was learned:

- **Alignment and role classification are the heaviest stages,** then
  separation. In a browser, on a desktop or a phone, they set what Lyre can do, so the
  M2 measurements choose the aligner's file and confirm the separator (D15, D26, D29).
- **Check separation by sum.** Vocals plus karaoke track should add back up to
  the original, without clipping and at plausible levels. A large difference
  means a broken run. Two rules apply. The energy rule: the original's energy
  over the energy of what the two tracks leave out must be at least 10 dB. The
  mark is provisional until the model measurement page confirms or changes it.
  The clipping rule: vocals or the karaoke track may not peak more than 1 dB
  above the original's own peak. A sample over 1.0 alone does not fail, because
  decoded loud masters already exceed it.
- **Scan the whole vocal track for leftovers,** not only where lyrics are
  sung. Laughs, calls, harmonies and ad-libs have no lyric text but still leak
  into the karaoke track.
- **Wordless backing vocals can pass for an instrument.** Separators trained
  to tell voices from instruments can take sustained, wordless backing vowels
  in a high register for an instrument, so they leak into the karaoke track.
  In the owner's test of a duet, the male backing vocals on the same phrase
  were removed. More time shifts and the fine-tuned `htdemucs_ft` vocals model
  did not help. M2 accepts these leftovers, and M8 cleans them up
  ([D22](../decisions.md#d22-the-separator-target-splits-lead-and-backing-vocals--agreed)).
- **Remove a leftover only when a second separator agrees.** Separators
  sometimes put a shared instrument in both outputs. Removing on the word of
  one separator damages the music. D15 has one separator, so the clean-up
  waits for M8, with the vocal roles.
- **Forced alignment times only the supplied syllables.** The core takes a
  CTC model's per-frame log-probabilities for the whole song and the model's
  vocabulary. It finds the most likely path through the syllables' tokens,
  in timing order. It never recognises words (D5, D15). Each syllable is
  matched to the vocabulary through a folded copy that handles case, Unicode
  normalisation and punctuation. The lyric bytes never change. A syllable
  with no character the vocabulary knows, such as "2" or "♪", is not guessed:
  alignment fails and names its lyric line and position, without quoting it.
  Frames, vocabulary size, entry length, syllables and the work grid have
  limits. Each syllable also gets a confidence score, the model's average
  probability over its frames.
- **The core aligns in 30 s windows with 2 s of overlap.** Every window
  starts on the 20 ms frame grid, so its frames line up with the song's.
  Each overlap is cut at its middle, so every frame comes from exactly one
  window. The last window is padded with silence to 30 s. A window with too
  few frames for its part of the song is refused, never padded or guessed.
- **Distrust very long word spans.** The aligner can stretch the first word
  over a long instrumental intro and still report high confidence. Check long
  spans against the nearest sung onsets.
- **A trimmed section keeps sync without re-encoding the video.** A section
  cut from a source starts at the source's keyframe at or before the chosen
  start, because coded video can only start on a keyframe. Both audio tracks
  are cut at that same time, and the karaoke track is encoded from audio
  decoded on that timeline. The end needs no keyframe. The cost is that a
  section may start up to one keyframe gap early, at most 20 s. A source
  whose keyframes are more than 20 s apart, or with one group of frames over
  64 MiB, is refused *(planned for M2)*. It cannot be cut into the song
  file's [media segments](../reference/song-file-format-v0.md#limits)
  without re-encoding.
- **Sources can start at a nonzero time.** Some containers start their
  timeline after zero. Player time then differs from source time, which moves
  section cut points and timing unless it is corrected once, at the start.
  Repackaging *(planned for M2)* corrects it by rewriting the container
  timestamps. It shifts every track by the same amount, so that the earliest
  track starts at 0. A track that started a few milliseconds later, such as
  audio after its video, keeps that gap and so keeps its sync. The song file
  lets a track's first segment start up to 50 ms late for this
  ([index rules](../reference/song-file-format-v0.md#index)).
- **A lyric correction is cheap only when the sung structure stays the same.**
  Changing words in place: re-time only the changed lines against the stored
  original track. Whitespace only: keep the timing. A different number of
  words or lines: process the song again.
- **Fail rather than guess.** When the words cannot be timed with confidence,
  or the singers cannot be told apart, processing fails with a clear reason.
  A song with wrong timing or colours looks finished but is not.

## Vocal roles and duets

- **Each role has a fixed colour,** the same on both clients and kept
  readable over video by the lyric outline and shadow. See the
  [vocal role colours](../ui-conventions.md#vocal-role-colours).
- **Sung text uses only the role colours,** as Vietnamese karaoke does. A
  song file records one role for the whole song, so its sung lyrics take that
  colour.
- **A duet needs proof** *(planned for M8)*. A line is a duet only when two distinct lead singers
  sing the same words at similar loudness. Overlapping voices, backing
  harmonies and ad-libs never make a duet.
- **Vowels are not enough** *(planned for M8)*. A backing singer holding only the vowels can
  score well against the lead's words. Consonants show who actually sang
  them.
- **Lead and backing separation can hide a duet** *(planned for M8)* by putting two equal
  singers in one track. Separating male from female voices catches that case.
- **Decide roles per clause, not per display line** *(planned for M8)*. A few missed words
  should not flip a colour in the middle of a sung clause. Change a colour
  only at a punctuation boundary or a measurable pause.
- **Ambiguity fails** *(planned for M8)*. If the number of singers or their voices are
  ambiguous, processing fails instead of guessing.

## Running on the user's device

- **Models are large.** Separation and alignment model files are hundreds
  of megabytes to more than a gigabyte each (see the
  [models reference](../reference/models.md)). They are downloaded once, checked against their pinned
  SHA-256 hash, and kept. A model that fails the check is deleted, never run.
- **The web has hard limits.** WebGPU runs on the machine's real GPU, but
  slower than native code, and a browser tab has limited memory. Long songs
  are processed in chunks. An operation WebGPU cannot run falls back to the
  CPU, which is much slower.
- **GitHub Pages sets no HTTP headers.** The web client is a static site on
  GitHub Pages ([D9](../decisions.md#d9-lyre-has-no-server--agreed)), which
  lets a site set none of its own headers. So its Content Security Policy is
  a `<meta>` tag, placed first in `<head>`, because it
  covers only what comes after it. A `<meta>` policy cannot carry
  `frame-ancestors`, `sandbox`, `report-uri` or `report-to`. Another site can
  therefore frame the page, and policy violations are not reported.
- **A worker gets no policy from the page.** A same-origin Web Worker takes
  its Content Security Policy from its own response's headers, not from the
  page's `<meta>` tag. GitHub Pages sends none, so code inside a worker, such
  as ONNX Runtime Web, runs without one. The page's policy still decides
  which worker URLs it may start: each comes from the `lyre#worker` Trusted
  Types policy, which allows only the site's own origin.
- **The page is not cross-origin isolated.** Without the COOP and COEP
  headers, the page has no `SharedArrayBuffer`. The WebAssembly backend of
  ONNX Runtime Web then runs on one thread, much slower than WebGPU. That is
  why making a song needs WebGPU
  ([D25](../decisions.md#d25-requirements-for-making-songs--proposed)). The
  [model measurement page](../roadmap.md#early-checks-on-real-devices)
  still measures that case for information *(planned for M2)*.
- **Phones get hot.** Long processing in a phone's browser slows down as the
  device heats up. The page shows progress and Cancel while it runs.
- **The browser may clear storage.** Songs, models and tasks kept by a web
  page can be removed by the browser unless persistent storage is granted.
  Lyre asks for it and says what happens without it.

## Models and licences

[D15](../decisions.md#d15-models-for-separation-and-alignment--agreed),
[D20](../decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed) and
[D29](../decisions.md#d29-the-aligner-is-lyric-alignment--agreed) chose the models for separation and alignment.
[D21](../decisions.md#d21-pinned-model-files-and-the-separator-target--agreed)
pinned their files, which the [models reference](../reference/models.md) lists:

| Purpose | Model | Status | Licence |
| --- | --- | --- | --- |
| Separation | Demucs v4 `htdemucs` (community fp32 ONNX export, STFT outside the file) | chosen (D15, D21) | code MIT, no separate grant stated for the weights |
| Alignment | Meta Omnilingual ASR CTC-300M (sherpa-onnx int8 ONNX export) | no longer a candidate (D29) | Apache-2.0 for code and models |
| Separation | UVR MDX-Net Inst HQ 4 | fallback | not yet confirmed in writing |
| Alignment on weak devices | Whisper base multilingual with forced decoding | fallback | MIT |
| Alignment | `nguyenvulebinh/lyric-alignment` (wav2vec2 for Vietnamese lyrics, as Lyre's fp32 and int8 ONNX export) | chosen (D29), int8 or fp32 by measurement | CC-BY-NC-4.0 |
| Alignment | other Vietnamese wav2vec2 fine-tunes and MMS | not a candidate | CC-BY-NC-4.0 |
| Separation | RoFormer separators | not used (heavy) | unclear for some |

- **Non-commercial licences are allowed while Lyre is non-commercial.** A
  CC-BY-NC-4.0 model may be used with the attribution its licence requires.
  Commercial use would need every such model replaced first (D20).
- **"Not stated" is not permission.** A model without a clear licence must
  have one before Lyre distributes it or downloads it for other people. A
  licence that grants nothing for the weights is not permission either. This
  applies to the Demucs weights, where the repository states no separate
  grant.
- Every model needs an ONNX export that runs in ONNX Runtime Web on WebGPU.
  M2 measures whether the separator and the aligner's int8 and fp32 files run fast enough there.
- **The aligner's vocabulary is Vietnamese.** Lyrics in other languages may be
  timed worse or refused (D29).
- The models for vocal roles and for the leftover check are chosen when M8 is
  broken down. So is the lead and backing separator for
  [D23](../decisions.md#d23-backing-vocals-as-their-own-track--proposed).

## What the protection does and does not do

What it does (D6):

- A song file opens only on a device that has an access file for it, wrapped
  for that device's key.
- On Android the device key is held by the device's secure hardware. On the
  web it is held by the OS through a device-bound passkey (D8). Copying the
  app's data or the browser profile to another machine does not copy it.
- A changed or truncated song file fails its authentication and is rejected
  as a whole.

### What the protection does not do

- **It does not stop a recipient.** A recipient's device decrypts the song to
  play it. Someone in control of that device, or recording its screen and
  sound, can capture the media. This is out of scope (D6).
- **It is not DRM.** Lyre must never describe itself as DRM or as preventing
  copying.
- **Shares are permanent.** Without a server, a share cannot be revoked (D9).
- **Deleting is not secure erasure.** Removing the files a task made does not
  erase them from SSDs, snapshots or backups. Lyre does not claim it does.
- **Losing every device and the recovery key loses the songs.** Nobody can
  open them again, by design.
