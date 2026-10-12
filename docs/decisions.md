# Decisions

Each decision has a status. **Agreed** means the owner has accepted it and
work may rely on it. **Proposed** means it is a working default that can still
change. Add new decisions at the end, and change an existing decision only by
recording a newer one that replaces it.

## D1. Name and file extension — Agreed

- The product is **Lyre**.
- A Lyre song file uses the extension `.lyre`.

## D2. Two clients: web and native Android — Agreed

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
- M3 starts with a spike that checks PRF on device-bound passkeys in the
  browsers and OSes Lyre targets. Where it is missing, the web client offers
  no device code there.

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
- **Web:** TypeScript, React and Vite. Media plays through Media Source
  Extensions and WebCodecs. Models run in ONNX Runtime Web on WebGPU, with a
  WebAssembly fallback.
- **Android:** Kotlin, Jetpack Compose and Media3 (ExoPlayer). Models run in
  ONNX Runtime for Android, on the GPU or NPU where the device has one.
- **Models:** ONNX models with pinned versions and SHA-256 hashes, downloaded
  on first use, never bundled in the repository.

*Why:* the security-critical code exists once, so the web and Android clients
cannot disagree about the format or the crypto. Each client still uses its
platform's native media and UI stack for performance.

Open points, each settled by a later decision:

- the vocal separation and alignment models, after the M2 measurements (see
  the [roadmap](roadmap.md));
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
- **Bootstrap:** the skeleton, CI and the tool setup are done directly, not
  through NexKit, because NexKit needs working checks first.

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
