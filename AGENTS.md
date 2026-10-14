# Lyre agent instructions

## Before you start

- Read [docs/product-brief.md](docs/product-brief.md) and [docs/decisions.md](docs/decisions.md)
  before any product or architecture work.
- [docs/architecture.md](docs/architecture.md) is the target structure.
- [docs/ui-conventions.md](docs/ui-conventions.md) sets how both clients build their UI.
  Read it before any UI work.
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
  See the [core rules](docs/architecture.md#core-rules).
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
| `scripts/setup.sh` | Installs what the checks need, including the Rust toolchain pinned in `core/rust-toolchain.toml` with rustfmt, Clippy and the WebAssembly and `aarch64-linux-android` targets, `wasm-bindgen-cli` at the version the core pins (from its prebuilt release binary, checked against a pinned SHA-256 hash, or with `cargo install` on machines other than x86_64 Linux), the web client's packages with `npm ci`, and the Playwright packages and Chromium for `tests/e2e` (with Chromium's system libraries when `CI` is set), with ffmpeg from apt when it is missing. For `android/` it installs JDK 17, the Android SDK platform and NDK pinned in `android/gradle/libs.versions.toml` (only the packages the SDK at `ANDROID_HOME` lacks), `cargo-ndk` (installed like `wasm-bindgen-cli`), ktlint and the Gradle wrapper's distribution. Safe to run repeatedly. |
| `scripts/build.sh` | Builds every part that exists and the change can affect: the core workspace, `lyre-wasm` for `wasm32-unknown-unknown`, the `lyre-wasm` JavaScript package in `web/src/lyre-wasm`, the web client with the Angular CLI (`ng build`) in `web/`, and the Android app: `lyre-ffi` for `arm64-v8a`, its Kotlin bindings in `android/app/src/main/java/uniffi` and the debug APK, which must contain the native library. It also prints how many bytes the Wiktionary word list adds to a WebAssembly module, and fails above 500,000 ([D18](docs/decisions.md#d18-vietnamese-word-boundaries-from-a-word-list--agreed)). Run it before `scripts/lint.sh` and `scripts/test.sh`, which need the generated files. |
| `scripts/lint.sh` | Linters and format checks for every part that exists and the change can affect (`cargo fmt --check` and Clippy with warnings as errors for the core; ESLint with angular-eslint for the TypeScript and the templates, the Prettier check and `tsc --noEmit` for `web/`; `tsc --noEmit` for `tests/e2e`; ktlint for `android/`, without the generated bindings), and the Markdown link and anchor check |
| `scripts/test.sh` | Unit tests for every part that exists and the change can affect (`cargo test` for the core workspace, Vitest through the Angular CLI for `web/`, the JVM unit tests of `android/` through Gradle, and the model tool's Python unit tests, which need only `python3` and its standard library), and the tests of the scripts. It first builds the fixture song into `artifacts/test/fixture.lyre` for the web client's tests. |
| `scripts/e2e.sh` | Playwright journeys in Chromium against the built web client, which it serves from `web/dist` with `tests/e2e/serve.mjs` at `/` and `/lyre/`, once `tests/e2e` exists. `serve.mjs` also serves the test model files of `tests/fixtures/models/` at `test-models/` under both, for the model check journeys. It first builds the fixture song with `lyre-cli` into `artifacts/e2e/fixture.lyre`, the male variant `tests/fixtures/song/male.toml` into `artifacts/e2e/fixture-male.lyre`, and the H.265 variant `tests/fixtures/song/h265.toml` into `artifacts/e2e/fixture-h265.lyre`, for the Player journeys. It makes the source fixtures with `tests/fixtures/source/make.sh` into `artifacts/e2e/sources/`, for the source check journeys. Run `scripts/build.sh` first. The report and traces go to `artifacts/e2e/`. |

A script runs the checks of the parts of the repository that exist and skips
the parts not built yet (D14). An issue that creates a part adds that part's
steps to the scripts and its commands to this table. The caches of what its
setup downloads come in a hand-made pull request, because NexKit may not
change their files (see
[delivery.md](docs/delivery.md#decisions)).

On a NexKit pull request, `NEXKIT_BASE_SHA` is set, and the scripts also skip
the parts that the changed paths cannot affect. A part that runs still builds
what it needs. With the variable unset or unknown, as in CI on `main` and in
local runs, every part runs
([D16](docs/decisions.md#d16-pull-request-checks-skip-the-parts-a-change-cannot-affect--agreed)).
An issue that adds a part, or a dependency between parts, updates the mapping
in `scripts/parts.mjs`.

### Developer tools

Run these by hand from the repository root. No check script runs them.

| Command | What it does |
| --- | --- |
| `(cd core && cargo run -p lyre-cli -- build ../tests/fixtures/song/song.toml ../artifacts/fixture.lyre)` | Builds the fixture song into a version-0 song file. See the [lyre-cli reference](docs/reference/lyre-cli.md). |
| `tests/fixtures/song/make.sh` | Recreates the fixture song's media and thumbnail. Needs ffmpeg built with libvpx and libopus. |
| `tests/fixtures/source/make.sh <out-dir>` | Makes the synthetic source fixtures in `<out-dir>`. `scripts/e2e.sh` runs it. Needs ffmpeg built with libx264, libvpx, libopus and libmp3lame. See the [lyre-cli reference](docs/reference/lyre-cli.md#the-source-fixtures). |
| `python3.12 -m venv .venv-models` then `.venv-models/bin/pip install --require-hashes --no-deps -r tools/model-tool/requirements.txt` (on Windows, `py -3.12 -m venv .venv-models` and `.venv-models\Scripts\pip`) | Creates the model tool's virtual environment: Python 3.12 and CPU-only PyTorch, with every package pinned by hash. It needs about 1.2 GB of disk. See the [model tool reference](docs/reference/model-tool.md). |
| `.venv-models/bin/python tools/model-tool/make_aligner.py --audio <file>` (on Windows, `.venv-models\Scripts\python`) | Makes the `lyric-alignment` aligner's ONNX files, fp32 and int8, with its vocabulary, in `artifacts/models/`, and checks them against PyTorch on the first 30 s of the audio. Writes the Hugging Face README only when both pass. Needs the Python 3.12 environment above, about 3 GB of disk (1.2 GB of downloads and 1.6 GB of output) and about 6 GB of memory. |
| `python3 tools/model-tool/make_test_separator.py` | Writes `mel-roformer.onnx`, a tiny stand-in for Mel-Band RoFormer with the same input and output names, shapes and types (float32), to `tests/fixtures/models/`. Its output is the input times 0.5. Needs only Python's standard library, and writes the same bytes every run. See the [model tool reference](docs/reference/model-tool.md#make_test_separatorpy). |
| `python3 tools/model-tool/make_test_aligners.py` | Writes the lyric-alignment test aligner, a tiny stand-in for its ONNX file with the same input and output names, and its small vocabulary file, to `tests/fixtures/models/`. Needs only Python's standard library, and writes the same bytes every run. See the [model tool reference](docs/reference/model-tool.md#make_test_alignerspy). |
| `.venv-models/bin/python tools/model-tool/compare_htdemucs.py --audio <file>` (on Windows, `.venv-models\Scripts\python`) | Compares the community htdemucs ONNX file with Meta's PyTorch checkpoint on the audio, and prints how close each stem is. Needs the Python 3.12 environment above, about 0.3 GB of disk for downloads and about 6 GB of memory. |
| `node scripts/wiktionary-words.mjs <dump.jsonl>` | Regenerates the core's Wiktionary word list from a kaikki.org Vietnamese dump downloaded beforehand. It refuses a dump whose SHA-256 does not match the pinned hash. See the [notice](core/lyre-core/src/words/wiktionary_words.NOTICE.md). |
