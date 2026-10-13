# Decisions

Each decision has a status. **Agreed** means the owner has accepted it and
work may rely on it. **Proposed** means it is a working default that can still
change. Add new decisions at the end, and change an existing decision only by
recording a newer one that replaces it.

## D1. Name and file extension — Agreed

- The product is **Lyre**.
- A Lyre song file uses the extension `.lyre`.

## D2. Two clients: web and native Android — Agreed

Narrowed by [D24](#d24-sources-are-repackaged-and-only-the-karaoke-track-is-encoded--agreed).

- **Web:** Lyre runs in a desktop or mobile browser, with nothing to install.
- **Android:** a native Android app, built for the best performance the
  device can give.
- Both clients offer the same product: make songs, play them and share them.
  A song made on one client plays on the other.

## D3. Processing runs on the device that asks for it — Agreed

- Vocal separation, lyric alignment and every other processing step run on
  the user's own device, with its own CPU, GPU or NPU.
- There is no processing server.
- A device too weak for a step is slow or cannot run it. Lyre says so plainly
  and never sends the media elsewhere instead.

*Why:* the owner's media and lyrics never leave the owner's device.

## D4. Feature scope — Agreed

Lyre includes, across its milestones:

- turning a video or audio file plus its exact lyrics into a karaoke song,
  with the vocals separated and the lyrics timed word by word;
- a Player with a library, a queue, search and a Karaoke / Original audio
  switch;
- a clip editor that cuts several songs from one source file;
- playing songs from Google Drive;
- vocal roles: lyrics coloured by who sings them, for example male, female
  or duet;
- encrypted song files that only chosen devices can open (D6).

The [roadmap](roadmap.md) orders them.

## D5. Supplied lyrics are authoritative — Agreed

- The lyrics the user supplies are the truth. Lyre keeps them exactly, byte
  for byte, as UTF-8.
- Models may time the supplied words and classify who sings them. They never
  recognise, add, remove, replace or correct a word.
- When the words cannot be timed with confidence, processing fails with a
  clear reason. It never guesses.

*Why:* lyric recognition makes mistakes, especially on sung Vietnamese. A
karaoke song that shows wrong words is worse than no song.

## D6. A song opens only on the devices it was shared with — Agreed

- **Device identity.** Each device that runs Lyre has its own key pair. The
  private key never leaves the device. The public key is the device's
  **device code**, which the device shows so its user can send it to the
  owner of a song.
- **Encryption.** Every song file is encrypted. Its content key is wrapped,
  separately, for each device allowed to open it.
- **Sharing.** To share a song with someone, the song's owner enters that
  person's device code. Lyre wraps the song's content key for that device.
  The large song file itself does not change, so one copy can sit in a shared
  place such as Google Drive.
- **Anyone else cannot open it.** A person who gets the song file but whose
  device was not given access cannot play it.
- **Out of scope.** A recipient who breaks the protection on their own device
  and passes the decrypted media on. Lyre does not try to stop that, and its
  docs never claim to. Lyre is not commercial DRM.

## D7. The owner can recover their keys — Agreed

- The owner can create a **recovery key** and keep it offline.
- Every song the owner makes is also wrapped for the recovery key. On a new
  device, the recovery key restores access to every one of them.
- Without the recovery key, losing a device loses what only that device could
  open.

*Why:* a phone or computer can be lost or wiped. Without recovery, every song
made on it would be lost with it.

## D8. Device keys are bound to the device, not the app's storage — Agreed

- **Android:** the device key is generated in Android Keystore, hardware
  backed (TEE or StrongBox) and not exportable. Lyre checks key attestation.
- **Web:** the device key is bound to the machine through a passkey with the
  WebAuthn PRF extension, kept in the platform authenticator (TPM through
  Windows Hello, Secure Enclave on Apple devices, Android's own).
  - A passkey that can sync between devices is refused, because "one device"
    would become "every device on the account". Lyre reads the passkey's
    backup flags to tell.
  - A browser or OS without PRF on a device-bound passkey gets no device
    code. Lyre does not fall back to a key kept in browser storage, which a
    copied browser profile would carry to another machine.
  - The user confirms with the device's unlock (PIN, fingerprint or face)
    once per session.
- A passkey check page, built in M1 and run on real devices before M3 is
  broken down, checks PRF on device-bound passkeys in the browsers and OSes
  Lyre targets (see the
  [roadmap](roadmap.md#early-checks-on-real-devices)). Where it is missing,
  the web client offers no device code there.

*Why:* a web device is the machine, not one browser profile on it. Passkeys
are the only way a web page can use a key held by the OS and its hardware.

## D9. Lyre has no server — Agreed

- Lyre needs no Lyre server: no accounts, no licence server, no processing
  server.
- The web client is a static site, hosted on GitHub Pages.
- Shares cannot be revoked. A device that was given access to a song keeps
  it.

*Why:* D3 and D6 need no server, and a server would be one more place where
keys or media could leak.

## D10. Technology stack — Agreed

- **Shared core in Rust.** The song file format, encryption, key wrapping,
  lyric layout and timing logic are written once in Rust. The web client uses
  it compiled to WebAssembly. The Android app uses it as a native library
  through UniFFI.
- **Web:** TypeScript, with the UI stack set by
  [D19](#d19-web-client-on-angular-both-clients-on-material-3--agreed). Media
  plays through Media Source Extensions and WebCodecs. Models run in ONNX
  Runtime Web on WebGPU, with a WebAssembly fallback.
- **Android:** Kotlin, Jetpack Compose and Media3 (ExoPlayer). Models run in
  ONNX Runtime for Android, on the GPU or NPU where the device has one.
- **Models:** ONNX models with pinned versions and SHA-256 hashes, downloaded
  on first use, never bundled in the repository.

*Why:* the security-critical code exists once, so the web and Android clients
cannot disagree about the format or the crypto. Each client still uses its
platform's native media and UI stack for performance.

Open points, each settled by a later decision:

- the vocal separation and alignment models: settled by
  [D15](#d15-models-for-separation-and-alignment--agreed),
  [D20](#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed) and
  [D21](#d21-pinned-model-files-and-the-separator-target--agreed), confirmed by the M2 measurements;
- the lowest Android version and the browsers Lyre supports.

## D11. Delivery workflow — Agreed

- **Tooling:** [NexKit](https://github.com/phuongnse/nexkit) runs one issue
  per agent session.
- **Milestones:** milestones are vertical slices.
- **Issue planning:** issues are created only for the current milestone
  (rolling wave).
- **Issue size:** each issue is one behaviour, aiming for 2–5 acceptance
  criteria that a test or command can check. More than five is a signal to
  check whether the issue holds more than one behaviour. If it does, split it.
  If every criterion checks the same behaviour, more are fine. A plan is not
  revised only to cut the number of criteria.
- **Documentation:** these docs hold the product and architecture knowledge.
  Issues link to them.
- **Bootstrap:** replaced by [D14](#d14-nexkit-builds-most-of-m0--agreed).

See [delivery.md](delivery.md) for the step-by-step workflow and who does each
step.

## D12. Repository language and visibility — Agreed

- Everything in the repository and on GitHub is in English.
- The repository is public.

*Why:* Lyre's protection rests on keys held by each device, not on hiding
its code.

## D13. Only the owner shares a song — Agreed

- Sharing is offered only for songs the device's user made, or restored with
  their recovery key.
- A recipient's Lyre plays a shared song but offers no way to share it on.

*Why:* the owner decides who gets each song. A recipient who wants to pass a
song on has to ask the owner for a new share.

## D14. NexKit builds most of M0 — Agreed

Replaces the bootstrap rule of D11.

- **By hand:** only what NexKit may not change, `.github/` and `.nexkit/`,
  plus what it needs to start: the NexKit configuration and workflow, the CI
  workflow, the check scripts, the rules on `main` and the agent credential.
- **The check scripts start almost empty.** Each script runs the checks of
  the parts of the repository that exist and skips the parts not built yet.
  The lint check already checks the Markdown links of the docs. Narrowed by
  [D16](#d16-pull-request-checks-skip-the-parts-a-change-cannot-affect--agreed).
- **Through NexKit:** the core, the web client, the Playwright project and the
  Android app, one issue each. Each issue adds its part's checks to the
  scripts, so the checks grow with the code.

*Why:* only `.github/` and `.nexkit/` are out of NexKit's reach. Everything
else can be built and verified through it, issue by issue.

## D15. Models for separation and alignment — Agreed

Partly replaced by [D20](#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)
and [D21](#d21-pinned-model-files-and-the-separator-target--agreed).

The owner delegated this choice.

- **Separation:** Demucs v4 `htdemucs`, one model (not `htdemucs_ft`), as an
  fp16 ONNX file of about 81 MB. The karaoke track is the sum of its three
  non-vocal stems. The code is under MIT. The repository states no separate
  grant for the weights.
- **Alignment:** Meta Omnilingual ASR CTC-300M, as an int8 ONNX file of about
  365 MB. Code and models are under Apache-2.0. Lyre does forced alignment of
  the supplied syllables over the CTC output. It never transcribes (D5).
  Audio is aligned in windows under 40 s.
- **Not used:** RoFormer separators, because they are heavy and some licences
  are unclear. The point that CC-BY-NC-4.0 models are not used is replaced by
  [D20](#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed).
- **Fallbacks if an M2 measurement fails:** UVR MDX-Net Inst HQ 4 for
  separation, once its licence is confirmed in writing. Whisper base
  multilingual (MIT) with forced decoding for alignment on weak devices.
- **Confirmation:** the M2 measurements confirm both choices on real devices.
  If a model misses its target, a newer decision replaces this one.

*Why:* both are mainstream, run in ONNX Runtime Web and on Android, and have
the clearest licences among models that give good results.

## D16. Pull request checks skip the parts a change cannot affect — Agreed

Narrows D14.

- **Changed paths pick the parts.** When `NEXKIT_BASE_SHA` is set, the
  scripts list the paths changed since that commit, untracked files included.
  The mapping from paths to parts is in `scripts/parts.mjs`, and all five
  scripts read it.
- **A change under `scripts/` runs every part.**
- **Some checks always run.** These are the Markdown link check and the tests
  of the scripts.
- **A part that runs still builds what it needs.** The web client builds
  `lyre-wasm` from the core even when only `web/` changed. The needed part is
  set up and built, but its own lint and tests are skipped.
- **Everything runs when the base is unknown.** This covers an unset
  `NEXKIT_BASE_SHA` or one that is not a commit in the checkout. It also covers
  CI on `main` and local runs.
- **A new part, or a new dependency between parts,** updates the mapping in
  the same issue.

*Why:* one verify round for the Android app took 6 min 17 s, and about 4 min
of it set up and built the Android app. Most work changes only one part. A
wrong mapping can let a breaking change pass the pull request checks. CI on
`main` runs everything and catches it after the merge.

## D17. Display lines are laid out at play time — Agreed

- **Not stored.** The song file holds the lyrics and the timing, but no
  display lines.
- **The core lays them out at play time,** from the lyrics, the timing and
  the text widths the client measures. The rules for a good split are in
  [design knowledge](domain/knowledge.md#lyrics).

*Why:* the split depends on the width of the screen, which differs between
the device that makes a song and the device that plays it.

## D18. Vietnamese word boundaries from a word list — Agreed

The owner chose this approach. It settles how the display line layout in M1
avoids splitting a Vietnamese word (see
[knowledge](domain/knowledge.md#lyrics)).

- **Approach:** the core rules out a display line split between two
  syllables when any listed multi-syllable word covers both. When listed
  words overlap, every split they cover is ruled out, so the core never
  chooses between readings.
- **Soft rules:** two short lists written for Lyre. One holds linking words a
  display line should not end on ("và", "của", "những", "một"). The other
  holds trailing modifiers it should not start with ("xưa", "này", "ấy").
  These rules are weaker than the word rule: a split may break them, but
  never splits a listed word.
- **Data source:** the Vietnamese entries of English Wiktionary, as extracted
  by Wiktextract and published on kaikki.org. Only entries of two or more
  syllables are kept, where each syllable is Latin-script letters only.
  Proverbs are left out, because a long proverb would make a long stretch of
  a lyric line unsplittable. The dump is pinned by date and SHA-256 hash: the
  current list comes from the dump extracted on 2026-10-03 and holds 22,293
  entries. A small list written for Lyre adds words Wiktionary lacks.
- **Licence:** the Wiktionary list is under CC BY-SA 4.0. It is kept as a
  separate data file with its own CC BY-SA 4.0 notice. The code's licence
  (MIT) does not cover it. Both clients show its attribution. The lists
  written for Lyre are part of the code.
- **Matching only:** lookup builds a key from the syllables in lowercase and
  Unicode NFC, and folds old and new tone placement ("hoà" and "hòa"). The
  lyric text itself is never changed (D5).
- **Size:** the list is stored as plain text, one word per line. It adds
  292,386 bytes to an uncompressed WebAssembly module that calls word lookup.
  The limit is 500 KB (500,000 bytes) added to the uncompressed module, and
  `scripts/build.sh` fails above it. If it goes over the limit, a newer
  decision replaces this one.
- **Same everywhere:** the list is compiled into `lyre-core`, so the web and
  Android clients use the same data. It needs no network.
- **Not used:** the `underthesea` and VnCoreNLP segmenters, because their
  code is GPL-3.0 and their models are trained on the VLSP 2013 corpus, which
  allows research use only. pyvi, because its code is MIT but it does not
  state its training data. Word lists from Hồ Ngọc Đức's dictionary, because
  their copies state no clear licence. A list written only for Lyre as the
  sole source, because it would hold too few words.

*Why:* joining two words by mistake only removes a split choice, while
splitting a word reads badly. A word list errs the safe way, needs no model,
stays small and has a clear licence.

## D19. Web client on Angular, both clients on Material 3 — Agreed

Replaces the web UI stack of D10, which named React and Vite.

- **Web:** TypeScript, Angular and Angular Material.
- **Both clients use Material 3.** Angular Material on the web, Compose
  Material 3 on Android.
- **One set of design tokens** for colour scheme, typography and shape,
  generated from one seed colour.
- **Android's dynamic colour is off,** so Lyre has the same colours on both
  clients.
- **Strings:** every UI string lives in one typed runtime catalogue, not in
  Angular's built-in i18n. One build then serves every language.
- **Check pages:** lazy-loaded routes, so their code stays out of the main
  app's initial load.

[UI conventions](ui-conventions.md) says how this is applied.

*Why:* Angular Material is the maintained, official Material 3 for the web.
Material Web is in maintenance mode, and MUI still implements Material 2
components.

The seed colour is `#6B5778`. The
[vocal role colours](ui-conventions.md#vocal-role-colours) are fixed and do
not come from the seed.

## D20. Non-commercial models are allowed, and M2 compares two aligners — Agreed

Replaces the CC-BY-NC part of the "Not used" point of
[D15](#d15-models-for-separation-and-alignment--agreed), and adds a second
aligner.

- **Non-commercial licences are allowed.** Lyre is non-commercial
  ([product brief](product-brief.md#out-of-scope-for-now)). A CC-BY-NC-4.0
  model may be used, with the attribution its licence requires.
- **Commercial use needs them replaced.** Every non-commercial model must be
  replaced first.
- **Unclear is still not permission.** This covers an unclear licence and one
  that grants nothing for the weights.
- **Two aligners are compared:** Meta Omnilingual ASR CTC-300M (D15) and
  `nguyenvulebinh/lyric-alignment`, a wav2vec2 model built for Vietnamese
  lyric alignment. Its model card states CC-BY-NC-4.0. Both do only forced
  alignment of the supplied syllables. Neither transcribes (D5).
- **The choice:** among the aligners that run on the target devices, the one
  with the lower syllable onset error is chosen. The results are recorded in
  the docs.
- **The measurement page is built at the start of M2.** It needs the ONNX
  files, their download and hash check, and alignment, which M2 builds anyway.
  M1 keeps only the passkey check page.
- **Separation stays** Demucs v4 `htdemucs`, as in D15.

*Why:* `lyric-alignment` is trained on sung Vietnamese lyrics and may time
syllables better. The non-commercial limit costs nothing while commercial use
is out of scope.

## D21. Pinned model files and the separator target — Agreed

Partly replaced by [D22](#d22-the-separator-target-splits-lead-and-backing-vocals--agreed).

Says which files the models of
[D15](#d15-models-for-separation-and-alignment--agreed) and
[D20](#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)
come from, and sets the separator's target. Replaces D15's detail of the
separator file's format and size.

- **Sources.** Every model file is downloaded from Hugging Face over HTTPS.
  Each is pinned by repository, revision (a full commit), size and SHA-256.
  The [models reference](reference/models.md) lists the files.
- **Omnilingual CTC-300M:** the int8 export by sherpa-onnx,
  `csukuangfj2/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12`
  (`model.int8.onnx` and `tokens.txt`).
- **htdemucs:** the community export `webnn/stem-separator`
  (`onnx/htdemucs_fwd.onnx` and its weights file `onnx/htdemucs_fwd.onnx.data`),
  in fp32. It was converted from Meta's checkpoint `955717e8-8726e21a.th`, and
  the [model tool](reference/model-tool.md#compare_htdemucspy) compared it
  with that checkpoint. The STFT, its inverse and the normalisation around
  the network are outside the file, so Lyre does them.
- **Not hosted again.** Lyre does not host the htdemucs file itself while the
  weights' licence is unclear.
- **lyric-alignment:** Lyre's own ONNX export, made by the
  [model tool](reference/model-tool.md#make_alignerpy), in fp32 and int8. The
  owner publishes it in `phuongnse/lyric-alignment-onnx`, with its
  attribution and CC-BY-NC-4.0.
- **Separator target:** on each target device, a 4-minute song separates on
  WebGPU in no more time than the song lasts, without running out of memory.
  The karaoke track passes the
  [sum check](reference/models.md#separator-target), and the owner hears no
  clear leftover vocals. If the separator misses, a newer decision replaces
  D15, as the [roadmap](roadmap.md#later-milestones) says.

*Why:* a commit cannot change, so every device checks and runs the same bytes.
Published exports spare Lyre from making its own, except for
`lyric-alignment`, which has none. Separating no slower than the song plays
keeps the wait for a song shorter than listening to it.

## D22. The separator target splits lead and backing vocals — Agreed

Replaces the listening clause of the separator target of
[D21](#d21-pinned-model-files-and-the-separator-target--agreed).

- **Lead vocals:** the owner hears no clear leftover lead vocals in the
  karaoke track.
- **Backing vocals:** harmonies and wordless backing vocals may remain in M2.
  The leftover clean-up of M8 handles them
  ([processing](domain/knowledge.md#processing), stage 5).
- **The separator stays** htdemucs. The time, memory and sum-check parts of
  D21's target do not change.

*Why:* the owner listened to a 207 s clip of a Vietnamese duet. The male and
female lead vocals were removed well. Wordless female backing vocals stayed
clearly, while male backing vocals on the same phrase were removed. Averaging
over 4 time shifts with half-overlapping segments did not help. Neither did
the vocals model of `htdemucs_ft`, with the karaoke track as the input minus
its vocals. Lead vocals are what the singer replaces, so M2 can go on with
htdemucs.

## D23. Backing vocals as their own track — Proposed

For M8. The owner wants to keep backing vocals for singing along.

- **Separate track:** the karaoke track has no vocals. Backing vocals,
  separated from the lead vocals, are stored as a separate track.
- **Switch:** the Player offers a switch to add the backing vocals.
- **Only when quality holds:** Lyre uses this only when both male and female
  backing vocals are kept and the owner hears no distortion on a set of test
  songs.
- **Fallback:** otherwise all vocals are removed, as now.
- **Needs a lead and backing separator,** which M8 also needs for vocal
  roles. Its licence must be clear
  ([models and licences](domain/knowledge.md#models-and-licences)).
- **Settled in M8,** as an open point of the
  [roadmap](roadmap.md#later-milestones).

*Why:* backing vocals are part of how a song feels. A singer may want them
back, but not at the price of a distorted karaoke track.

## D24. Sources are repackaged, and only the karaoke track is encoded — Agreed

Narrows [D2](#d2-two-clients-web-and-native-android--agreed): a song made on
one client plays on another device only when that device decodes the song's
stored codecs.

- **No re-encoding.** Lyre never re-encodes a source's video or audio. It
  keeps the coded frames byte for byte, at the source's codec, resolution and
  frame rate.
- **Repackaging only.** Lyre moves those frames into a container that Media
  Source Extensions and Media3 stream piece by piece. That is WebM when WebM
  holds the codec (VP8, VP9, AV1, Opus, Vorbis). Otherwise it is fragmented
  MP4 (H.264, HEVC, AAC, MP3), the MP4 layout that is streamed in pieces.
- **One encoded track.** The karaoke track is the only media Lyre encodes:
  Opus, 48 kHz, stereo.
- **Refused, not converted.** A source whose video or audio the making device
  cannot play is refused with a plain reason. Lyre never converts it.
- **Plain message on playback.** A Player that cannot play a stored type says
  so plainly, for example "This device cannot play H.265 video", and plays
  nothing.

The [song file format](reference/song-file-format-v0.md#media) sets the
containers, the stored types and the limits.

*Why:* re-encoding video on a phone or in a browser is the slowest step by
far, and it loses quality. Repackaging takes seconds.
