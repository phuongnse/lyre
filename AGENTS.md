# Lyre agent instructions

## Before you start

- Read [docs/product-brief.md](docs/product-brief.md) and [docs/decisions.md](docs/decisions.md)
  before any product or architecture work.
- [docs/architecture.md](docs/architecture.md) is the target structure.
- [docs/domain/concepts.md](docs/domain/concepts.md) defines the vocabulary. Use those
  terms in code, file formats and UI.
- [docs/domain/knowledge.md](docs/domain/knowledge.md) explains why the design rules exist.
  Check it before changing lyrics, processing, the song file format or access behaviour.

## Language

Use English for source code, comments, configuration, commit messages,
issues and repository documentation. The owner may discuss things in
Vietnamese.

## Working rules

- Docs are the source of truth. An issue links to the relevant section; it
  does not copy it. If a change alters agreed behaviour, update the doc in the
  same change. When a change makes any statement in the docs false, including
  summaries such as the README status, the roadmap or the concepts table, fix
  it in the same change. See
  [docs/delivery.md](docs/delivery.md#keeping-the-docs-current).
- Keep the [decisions](docs/decisions.md) status words exact: **Agreed**
  means agreed, and **Proposed** means still open. Never present a proposal as
  agreed.
- Each issue is one behaviour and fits in a single agent session. Aim for 2–5
  acceptance criteria that a test or command can verify. More than five is a
  signal to check whether the issue holds more than one behaviour. If it does,
  split it. If every criterion checks the same behaviour, more are fine. A plan
  is not revised only to cut the number of criteria. Split anything larger than
  one session before starting. Its text names the concepts it touches, because
  NexKit chooses the issue's [profile](docs/delivery.md#profiles) from the
  issue text alone.
- Build in vertical slices. Every milestone ends with something that runs
  end to end and is covered by an automated test.
- Every behaviour change needs a test. Use known-answer vectors for the song
  file format and crypto. Use Playwright for web journeys. Test denied access
  as well as allowed access.
- Supplied lyrics are kept exactly. No code may change, normalise for
  storage, recognise or correct lyric text (D5).
- Logic that both clients need lives in the Rust core, never in a client.
  Content keys and private keys never reach UI state, logs or error messages.
- Never claim the protection is DRM or stops copying. See
  [what the protection does not do](docs/domain/knowledge.md#what-the-protection-does-not-do).
- Never commit secrets, tokens, model weights, source media, song files made
  from real media, local logs or machine snapshots.

## Working through NexKit

- All work goes through NexKit, as described in
  [docs/delivery.md](docs/delivery.md). The exception is changes in paths
  NexKit may not change: those are hand-made pull requests.
- NexKit merges its pull request once the checks pass and the AI review
  approves, while its `merge.auto` setting is on. With it off, only the owner
  merges.

Writing on GitHub, for issues, plans, pull request descriptions and reviews:

- Lead with the point. Use short sentences and one idea per bullet.
- Say what changes in behaviour, and why, before naming types or files.
- Put decisions and risks the owner must judge in their own short section.
- Keep implementation detail out of the main text, or in a `<details>` block.

## Commands

Run from the repository root. Each script is also a NexKit check and a CI step.

| Script | What it does |
| --- | --- |
| `scripts/setup.sh` | Installs what the checks need, including the Rust toolchain pinned in `core/rust-toolchain.toml` with rustfmt, Clippy and the WebAssembly and `aarch64-linux-android` targets, `wasm-bindgen-cli` at the version the core pins, the web client's packages with `npm ci`, and the Playwright packages and Chromium for `tests/e2e` (with Chromium's system libraries when `CI` is set). For `android/` it installs JDK 17, the Android SDK platform and NDK pinned in `android/gradle/libs.versions.toml`, `cargo-ndk`, ktlint and the Gradle wrapper's distribution. Safe to run repeatedly. |
| `scripts/build.sh` | Builds every part that exists: the core workspace, `lyre-wasm` for `wasm32-unknown-unknown`, the `lyre-wasm` JavaScript package in `web/src/lyre-wasm`, the web client with `vite build`, and the Android app: `lyre-ffi` for `arm64-v8a`, its Kotlin bindings in `android/app/src/main/java/uniffi` and the debug APK, which must contain the native library. Run it before `scripts/lint.sh` and `scripts/test.sh`, which need the generated files. |
| `scripts/lint.sh` | Linters and format checks for every part that exists (`cargo fmt --check` and Clippy with warnings as errors for the core; oxlint, the Prettier check and `tsc --noEmit` for `web/`; `tsc --noEmit` for `tests/e2e`; ktlint for `android/`, without the generated bindings), and the Markdown link and anchor check |
| `scripts/test.sh` | Unit tests for every part that exists (`cargo test` for the core workspace, Vitest for `web/`, the JVM unit tests of `android/` through Gradle), and the tests of the scripts |
| `scripts/e2e.sh` | Playwright journeys in Chromium against the built web client, which it serves from `web/dist` with `vite preview`, once `tests/e2e` exists. Run `scripts/build.sh` first. The report and traces go to `artifacts/e2e/`. |

A script runs the checks of the parts of the repository that exist and skips
the parts not built yet (D14). An issue that creates a part adds that part's
steps to the scripts and its commands to this table.
