#!/usr/bin/env bash
# End-to-end journeys against the built web client, once tests/e2e exists.
# Playwright serves web/dist with tests/e2e/serve.mjs, at / and at /lyre/. The report and traces go to artifacts/e2e/.
# lyre-cli builds the version-0 fixture song into artifacts/e2e/, because song files are never committed. Only the journeys that check the Player refuses version 0 open it.
# The other journeys build their version-1 songs themselves, for the page's device code.
# They read the source fixtures, which tests/fixtures/source/make.sh makes with ffmpeg into artifacts/e2e/sources/.
# On a NexKit pull request it runs only when the change can affect the journeys (D16).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/parts.sh

if [[ ! -d tests/e2e ]]; then
  echo "No end-to-end tests yet."
  exit 0
fi
if ! checks e2e; then
  exit 0
fi
if [[ ! -f web/dist/index.html ]]; then
  echo "web/dist is missing: run scripts/build.sh first." >&2
  exit 1
fi
export PATH="$HOME/.cargo/bin:$PATH"
(cd core && cargo run --locked -q -p lyre-cli -- build ../tests/fixtures/song/song.toml ../artifacts/e2e/fixture.lyre)
tests/fixtures/source/make.sh artifacts/e2e/sources
(cd tests/e2e && npx playwright test)
