#!/usr/bin/env bash
# Unit tests for every part that exists, and the tests of the scripts themselves.
# On a NexKit pull request it tests only the parts that the change can affect (D16).
# The tests of the scripts always run.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/parts.sh

# Each part adds its unit tests here when it is created.
if [[ -f core/Cargo.toml ]] && checks core; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # Run cargo inside core/ so rustup picks up core/rust-toolchain.toml.
  (cd core && cargo test --workspace --locked)
fi

if [[ -f web/package.json ]] && checks web; then
  if [[ ! -f web/src/lyre-wasm/lyre_wasm.js ]]; then
    echo "web/src/lyre-wasm is missing: run scripts/build.sh first." >&2
    exit 1
  fi
  # The web tests open the fixture song, which lyre-cli builds into artifacts/test/, because song files are never committed.
  export PATH="$HOME/.cargo/bin:$PATH"
  (cd core && cargo run --locked -q -p lyre-cli -- build ../tests/fixtures/song/song.toml ../artifacts/test/fixture.lyre)
  (cd web && npm test)
fi

if [[ -f android/settings.gradle.kts ]] && checks android; then
  if [[ ! -f android/app/src/main/java/uniffi/lyre_ffi/lyre_ffi.kt || ! -f core/target/debug/liblyre_ffi.so ]]; then
    echo "The Kotlin bindings or the host core library are missing: run scripts/build.sh first." >&2
    exit 1
  fi
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
  (cd android && ./gradlew --console=plain testDebugUnitTest)
fi

node --test scripts/*.test.mjs
