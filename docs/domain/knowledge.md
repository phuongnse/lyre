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
  in the singing (about 0.18 s or longer) and the measured width of the text.
  It never adds punctuation and never changes the number of lyric lines.
- **Do not split Vietnamese words.** Many Vietnamese words have two or more
  syllables ("kỷ niệm", "nụ cười"). A display split inside one reads badly. A
  split should also avoid ending a line on a linking word ("và", "của",
  "những", "một") or starting one with a trailing modifier ("xưa", "này",
  "ấy"). The `underthesea` word segmenter with a curated list does this in
  Python. Lyre needs an equivalent that runs on the device.

## Processing

The stages, in order:

1. **Read the source.** Duration, streams, and title, artist and composer
   tags. The source needs an audio stream; video is optional.
2. **Extract the audio** of the song, or of the section, at full quality.
3. **Separate** vocals from the karaoke track.
4. **Align** the supplied syllables against the vocals.
5. **Clean up** vocals left in the karaoke track *(planned for M8)*.
6. **Classify vocal roles** *(planned for M8)*.
7. **Lay out the display lines** and their timing.
8. **Build the playback media** and the thumbnail.
9. **Write the song file** and remove everything the task made on the way.

What was learned:

- **Alignment and role classification are the heaviest stages,** then
  separation. On a phone or in a browser they set what Lyre can do, so the
  M2 measurements confirm the models chosen in D15.
- **Check separation by sum.** Vocals plus karaoke track should add back up to
  the original, without clipping and at plausible levels. A large difference
  means a broken run.
- **Scan the whole vocal track for leftovers,** not only where lyrics are
  sung. Laughs, calls, harmonies and ad-libs have no lyric text but still leak
  into the karaoke track.
- **Remove a leftover only when a second separator agrees.** Separators
  sometimes put a shared instrument in both outputs. Removing on the word of
  one separator damages the music. D15 has one separator, so the clean-up
  waits for M8, with the vocal roles.
- **Distrust very long word spans.** The aligner can stretch the first word
  over a long instrumental intro and still report high confidence. Check long
  spans against the nearest sung onsets.
- **Trimming and re-encoding can drift out of sync.** Copy audio without
  re-encoding only for the full, untrimmed timeline in a widely supported
  codec. Otherwise re-encode both tracks from the same decoded audio.
- **Sources can start at a nonzero time.** Some containers start their
  timeline after zero. Player time then differs from source time, which moves
  section cut points and timing unless it is corrected once, at the start.
- **A lyric correction is cheap only when the sung structure stays the same.**
  Changing words in place: re-time only the changed lines against the stored
  original track. Whitespace only: keep the timing. A different number of
  words or lines: process the song again.
- **Fail rather than guess.** When the words cannot be timed with confidence,
  or the singers cannot be told apart, processing fails with a clear reason.
  A song with wrong timing or colours looks finished but is not.

## Vocal roles and duets

*(planned for M8)*

- **A duet needs proof.** A line is a duet only when two distinct lead singers
  sing the same words at similar loudness. Overlapping voices, backing
  harmonies and ad-libs never make a duet.
- **Vowels are not enough.** A backing singer holding only the vowels can
  score well against the lead's words. Consonants show who actually sang
  them.
- **Lead and backing separation can hide a duet** by putting two equal
  singers in one track. Separating male from female voices catches that case.
- **Decide roles per clause, not per display line.** A few missed words
  should not flip a colour in the middle of a sung clause. Change a colour
  only at a punctuation boundary or a measurable pause.
- **Ambiguity fails.** If the number of singers or their voices are
  ambiguous, processing fails instead of guessing.

## Running on the user's device

- **Models are large.** Separation and alignment models are tens to hundreds
  of megabytes each (about 81 MB and 365 MB in D15). They are downloaded once, checked against their pinned
  SHA-256 hash, and kept. A model that fails the check is deleted, never run.
- **The web has hard limits.** WebGPU runs on the machine's real GPU, but
  slower than native code, and a browser tab has limited memory. Long songs
  are processed in chunks. An operation WebGPU cannot run falls back to the
  CPU, which is much slower.
- **Phones get hot.** Long processing on Android slows down as the device
  heats up. Processing runs as a foreground task the user can see and cancel.
- **The browser may clear storage.** Songs, models and tasks kept by a web
  page can be removed by the browser unless persistent storage is granted.
  Lyre asks for it and says what happens without it.

## Models and licences

[D15](../decisions.md#d15-models-for-separation-and-alignment--agreed) chose
the models for separation and alignment:

| Purpose | Model | Status | Licence |
| --- | --- | --- | --- |
| Separation | Demucs v4 `htdemucs` (fp16 ONNX, about 81 MB) | chosen (D15) | code MIT, no separate grant stated for the weights |
| Alignment | Meta Omnilingual ASR CTC-300M (int8 ONNX, about 365 MB) | chosen (D15) | Apache-2.0 for code and models |
| Separation | UVR MDX-Net Inst HQ 4 | fallback | not yet confirmed in writing |
| Alignment on weak devices | Whisper base multilingual with forced decoding | fallback | MIT |
| Alignment | Vietnamese wav2vec2 fine-tunes, `nguyenvulebinh/lyric-alignment` and MMS | not used | CC-BY-NC-4.0 |
| Separation | RoFormer separators | not used | unclear or non-commercial |

- **"Not stated" is not permission.** A model without a clear licence must
  have one before Lyre distributes it or downloads it for other people. This
  applies to the Demucs weights, where the repository states no separate
  grant.
- Every model needs an ONNX export that runs in ONNX Runtime Web and ONNX
  Runtime for Android. M2 confirms that the D15 models run fast enough there.
- The models for vocal roles and for the leftover check are chosen when M8 is
  broken down.

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
