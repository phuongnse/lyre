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
  - both clients from M4: a feature is done when it works on the web and on
    Android.

## Milestones

| | Milestone | Status | Done when |
| --- | --- | --- | --- |
| **M0** | Foundation | Done | The core, the web client and the Android app build; CI runs build, lint, unit and Playwright E2E for real; NexKit is installed with those checks. |
| **M1** | Karaoke playback | Next | The web client opens a development song file and plays it: video, Karaoke / Original switch, lyrics highlighted syllable by syllable, display lines that never split a Vietnamese word. |
| **M2** | Making songs on the device | Planned | In the browser, the owner turns a source and its lyrics into a song: models downloaded and checked, separation and alignment on WebGPU, progress and cancel. A model measurement page compares the two aligners of D20 on real devices and confirms the separator. |
| **M3** | Devices, encryption and sharing | Planned | Every song file is encrypted. Each device has a device code; the owner shares a song with a device code; other devices cannot open it; the recovery key restores the owner's songs on a new device. |
| **M4** | Android | Planned | The Android app plays, makes and shares songs like the web client, with its device key in Android Keystore. Songs move between web and Android both ways. |
| **M5** | Library and queue | Planned | Library, queue in order or shuffled, search by title, artist, composer and lyrics that ignores Vietnamese diacritics, thumbnails, lyric corrections. |
| **M6** | Clip editor | Planned | The owner cuts several sections from one source, each with its own details and lyrics, and each becomes a song. |
| **M7** | Google Drive | Planned | The user picks Drive files or folders; songs play from Drive before they finish downloading and stay playable offline once cached. |
| **M8** | Vocal roles | Planned | Lyrics are coloured by vocal role, with duets only on proof and a clear failure on ambiguity. |
| **M9** | Hardening and release | Planned | Fuzzing of every parser, an independent review of the crypto, model licences settled, the web client published on GitHub Pages and the Android app ready to install. |

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

Outline, broken into issues when M0 is nearly done:

1. Reference doc for song file format version 0.
2. Lyrics parsing in the core: exact bytes, limits, lyric lines and syllables.
3. Song file version 0 in the core: write and read, with bounds; `lyre-cli`
   builds one from a source, lyrics and a timing file.
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

## Early checks on real devices

- The owner runs both checks on real devices, because the CI runners have no
  GPU, passkeys or phones.
- The passkey check page is built in M1. It reports whether a device-bound
  passkey with the PRF extension works in each target browser and OS (D8). Its
  results are recorded in the docs before M3 is broken down.
- The model measurement page is built first in M2 ([D20](decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)).
  It runs the D15 separator and both candidate aligners, Omnilingual and
  `lyric-alignment`, on WebGPU and on the one-thread WebAssembly fallback
  (see [knowledge](domain/knowledge.md#running-on-the-users-device)). It
  reports time, peak memory and syllable onset error against a few
  hand-timed Vietnamese songs.
- Its results choose the aligner. They are recorded in the docs before the
  later M2 work relies on that choice.

## Later milestones

Each is broken down when the one before it is nearly done. Open points they
must settle:

- **M2:** the measurement page comes first. It compares Omnilingual and
  `lyric-alignment`. The aligner with the lower syllable onset error, among
  those that run on the target devices, is chosen
  ([D20](decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)). A newer decision replaces D15 if the separator
  misses its target.
- **M3:** the passkey check results (D8); the reference doc for the encrypted
  format, access files and recovery, reviewed before implementation.
- **M4:** split in two when broken down: Android playback and device keys
  first, then making songs on Android; the lowest Android version, and
  emulator tests in CI.
- **M9:** licences for every model that is downloaded for other people, and
  the attribution D18 needs in both clients.
