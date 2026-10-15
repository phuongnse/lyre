# Lyre roadmap

## How work is planned

- **Milestones are vertical slices.** Each one ends with something a person
  can use, covered by automated tests, including at least one end-to-end
  journey.
- **Rolling wave.** Only the current milestone is broken into issues. The next
  milestone is broken down when the current one is nearly done, using what was
  learned.
- **Issue size.** One issue is one behaviour, aiming for 2–5 acceptance
  criteria that a test or command can verify. More than five is a signal to
  check whether the issue holds more than one behaviour. If it does, split it.
  If every criterion checks the same behaviour, more are fine. A plan is not
  revised only to cut the number of criteria. It must fit in a single NexKit
  agent session.
  If a NexKit plan reports `too_large`, split the issue into parts and add each
  as a sub-issue of the parent, in order and in the parent's milestone. See
  [delivery.md](delivery.md).
- **Docs first.** An issue links to the doc sections it implements. When an
  issue changes agreed behaviour, it updates the docs in the same pull request.
- **Cross-cutting qualities are built in, not added later.** Every milestone
  includes:
  - exact lyrics, byte for byte (D5);
  - bounded parsing of every file Lyre reads;
  - denied-access tests from M3;
  - every client from M4: a feature is done when it works in every client
    that has it (D27).

## Milestones

| | Milestone | Status | Done when |
| --- | --- | --- | --- |
| **M0** | Foundation | Done | The core, the web client and the Android app build; CI runs build, lint, unit and Playwright E2E for real; NexKit is installed with those checks. |
| **M1** | Karaoke playback | Done | The web client opens a development song file and plays it: video, Karaoke / Original switch, lyrics highlighted syllable by syllable, display lines that never split a Vietnamese word. |
| **M2** | Making songs on the device | Done | In the browser, the owner turns a source and its lyrics into a song: models downloaded and checked, separation and alignment on WebGPU, progress and cancel. A model measurement page measures the aligner's int8 and fp32 files (D29) on real devices and confirms the separator. |
| **M3** | Devices, encryption and sharing | Next | Every song file is encrypted. Each device has a device code; the owner shares a song with a device code; other devices cannot open it; the recovery key restores the owner's songs on a new device. |
| **M4** | Android | Planned | The Android app plays songs and shows a device code to receive shared songs, with its device key in Android Keystore. Songs made in the web client play in the Android app. |
| **M5** | Library and queue | Planned | Library, queue in order or shuffled, search by title, artist, composer and lyrics that ignores Vietnamese diacritics, thumbnails, lyric corrections. |
| **M6** | Clip editor | Planned | The owner cuts several sections from one source, each with its own details and lyrics, and each becomes a song. |
| **M7** | Google Drive | Planned | The user picks Drive files or folders; songs play from Drive before they finish downloading and stay playable offline once cached. |
| **M8** | Vocal roles | Planned | Each lyric line is coloured by its own vocal role, with duets only on proof and a clear failure on ambiguity. |
| **M9** | Hardening and release | Planned | Fuzzing of every parser, an independent review of the crypto, model licences settled, the web client released on GitHub Pages and the Android app ready to install. |

Milestones after M3 may be reordered when the owner's needs change. M0–M3
stay in this order.

## M0 — Foundation

Only what NexKit may not change, or needs before it can start, is done by
hand (D14):

- `.nexkit/config.json` and the NexKit workflow, with the checks `build`,
  `lint`, `test` and `e2e` and the `setup` step;
- the CI workflow, which runs the same scripts on pushes, and on `main` after
  NexKit merges;
- the check scripts, which skip the parts not built yet, with the Markdown
  link check in `lint`;
- the rules on `main`, the agent credential secret and `nexkit doctor`.

The rest are NexKit issues in this order. Each one follows the
[repository layout](architecture.md#repository-layout), pins its toolchain
and lock files, adds its part's checks to the scripts and lists its commands
in `AGENTS.md`.

1. Create the Rust workspace in `core/` with `lyre-core` exposing one trivial
   function, for example the core's version, plus `lyre-wasm` and `lyre-ffi`
   bindings for it. Rustfmt and Clippy with warnings as errors.
2. Create `web/` with TypeScript, oxlint, Prettier and Vitest.
   The page shows the core's version through WebAssembly.
3. Add a Playwright project in `tests/e2e` that serves the built web client
   and checks that the page shows the core's version.
4. Create `android/` with Gradle, Kotlin, Jetpack Compose and ktlint. A JVM
   unit test calls the core's version through the Kotlin bindings.

Done when all four are merged and the checks run real builds and tests for
the core, the web client and the Android app.

## M1 — Karaoke playback

The first slice plays a song before Lyre can make one. Test songs are built
from fixtures by `lyre-cli`, with timing written by hand, so playback can be
built and tested without models.

M1 delivered, in this order:

1. Reference doc for song file format version 0.
2. Lyrics parsing in the core: exact bytes, limits, lyric lines and syllables.
3. Song file version 0 in the core: write and read, with bounds; `lyre-cli`
   builds one from prepared media, lyrics and a timing file.
4. Display line layout in the core: splits at punctuation, pauses and width,
   never inside a Vietnamese word
   ([D18](decisions.md#d18-vietnamese-word-boundaries-from-a-word-list--agreed)).
5. Rebuild the web client on Angular and Angular Material, with the Material 3
   theme, the string catalogue and the page showing the core's version (D19,
   [UI conventions](ui-conventions.md)).
6. Web Player: open a song file and play the video with the karaoke track.
7. Web Player: lyrics highlighted syllable by syllable, in sync with playback.
8. Web Player: switch between Karaoke and Original without losing position.
9. A small library: the songs opened on this device, with their details.
10. A passkey check page (see [early checks](#early-checks-on-real-devices)).

Done when all ten were merged and the owner accepted the Player.

## M2 — Making songs on the device

The second slice makes a song in the browser from a source and its lyrics.
It was built in small steps. Each step had a check page, so it could be tried
before the next one used it.

M2 delivered, in this order:

1. A task runner in a Web Worker, with progress, cancel and cleanup, and a
   task check page.
2. Reading a source and its details, with a source check page.
3. Repackaging the original track and the video, and encoding the Opus
   karaoke track
   ([D24](decisions.md#d24-sources-are-repackaged-and-only-the-karaoke-track-is-encoded--agreed)).
   A source with keyframes more than 20 s apart, or a group of frames over
   64 MiB, is refused. A late start is shifted to 0.
4. The thumbnail, and a version-0 song file written in the web client from a
   hand-written timing.
5. Model download, SHA-256 check and keeping, with a model check page.
6. Separation with Mel-Band RoFormer and the check for a broken run
   ([D28](decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed)),
   with a separation check page.
7. Forced alignment in the core, in 30 s windows, with syllable ends at
   silence
   ([D29](decisions.md#d29-the-aligner-is-lyric-alignment--agreed)).
8. The model tool, which makes the aligner's ONNX files.
9. The model measurement page, with **Play with this timing** and **Copy
   results**. Its first measurement chose the fp32 file of `lyric-alignment`
   ([D30](decisions.md#d30-the-aligner-file-is-fp32--agreed)) and showed that
   Mel-Band RoFormer met the time target. See the
   [results](reference/models.md#measurement-results).
10. The Make a song section: the check of the requirements of
    [D25](decisions.md#d25-requirements-for-making-songs--agreed) (a WebGPU
    adapter and 8 GB of memory), progress, **Cancel**, the one-tab lock, the
    library and the download link.

Done when all ten were merged.

The message that names the codec in the Player, as in "This device cannot
play H.265 video", was not built. It is planned for M4, with Android's
Player.

## Early checks on real devices

- The owner runs both checks on real devices, because the CI runners have no
  GPU, passkeys or phones.
- The passkey check page is built in M1. It reports whether a device-bound
  passkey with the PRF extension works in each target browser and OS (D8).
  Its results are in [passkey check results](#passkey-check-results).
- The passkey check page is served at `#/passkey-check` of the web client, for
  example <https://phuongnse.github.io/lyre/#/passkey-check>. The main page
  does not link to it.
- The model measurement page was built first in M2 ([D20](decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)).
  It runs the separator (D28) and both files of the `lyric-alignment` aligner
  (D29).
  It runs on WebGPU, as making a song does
  (see [knowledge](domain/knowledge.md#running-on-the-users-device)). It
  reports time and memory as the browser reports it. The
  [models reference](reference/models.md#measurement-method) sets the method.
  Its first part is the measurement section of the model check page, at
  `#/model-check`. Each run measures WebGPU only,
  without the download time yet.
- The owner chose fp32 over int8 by watching each one's timing in the Player
  ([D26](decisions.md#d26-the-owner-chooses-the-aligner-by-watching-its-timing-in-the-player--agreed),
  [D30](decisions.md#d30-the-aligner-file-is-fp32--agreed)).
  After a measurement, **Play with this timing** on the model check page's
  Player plays the source with that file's timing.
  The choice and its reason are recorded in the
  [measurement results](reference/models.md#measurement-results).

### Passkey check results

The owner ran the page on one Windows 11 machine, in Edge and Chrome.
No other OS or browser was run.

| OS and version | Browser and version | Result | Backup eligible | Backed up |
| --- | --- | --- | --- | --- |
| Windows 11 26H2 | Edge 155 | Works | no | no |
| Windows 11 26H2 | Chrome 155, passkey saved to Google Password Manager (Chrome's default) | Refused because the passkey can sync | yes | yes |
| Windows 11 26H2 | Chrome 155, passkey saved to Windows Hello | Works | no | no |

- **Device code:** Windows 11 with Edge 155, and with Chrome 155 when the
  passkey is saved to Windows Hello.
- **No device code:** Chrome saves a passkey to Google Password Manager by
  default. That passkey can sync, so Lyre refuses it
  ([D8](decisions.md#d8-device-keys-are-bound-to-the-device-not-the-apps-storage--agreed)).
  A user who keeps the default gets no device code.
- **Not checked:** every other OS and browser, including Android phones,
  Apple devices (macOS and iOS), Linux and Firefox. The web client is meant
  to work on a phone too ([product goals](product-brief.md#product-goals)).
  There, D8's backup-flag and PRF checks of the passkey decide whether a
  device code is offered on the device itself. No run showed PRF missing on
  a device-bound passkey.

**Risks for the owner:** Chrome's default leaves many Chrome users without
a device code. Phones and Apple devices are unproven before M3. No fallback
is added, because D8 forbids a key kept in browser storage.

## Later milestones

Each is broken down when the one before it is nearly done. Open points they
must settle:

- **M3:** the reference doc for the encrypted format, access files and
  recovery, reviewed before implementation. What the web client tells a user
  whose passkey was refused because it can sync.
- **M4:** Android playback and device keys
  ([D27](decisions.md#d27-the-android-app-plays-and-receives-songs--agreed));
  the lowest Android version, and emulator tests in CI.
- **M8:** settle [D23](decisions.md#d23-backing-vocals-as-their-own-track--proposed), backing vocals as their own track,
  and choose a lead and backing separator with a clear licence.
- **M9:** licences for every model that is downloaded for other people, and
  the attribution D18 needs in both clients.
