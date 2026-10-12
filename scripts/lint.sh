#!/usr/bin/env bash
# Formatting, linters and type checks for every part that exists, and the Markdown link check.
# On a NexKit pull request it checks only the parts that the change can affect (D16).
# The link check always runs.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/parts.sh

# Each part adds its linters here when it is created.
if [[ -f core/Cargo.toml ]] && checks core; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # Run cargo inside core/ so rustup picks up core/rust-toolchain.toml.
  (
    cd core
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
  )
fi

if [[ -f web/package.json ]] && checks web; then
  if [[ ! -f web/src/lyre-wasm/lyre_wasm.js ]]; then
    echo "web/src/lyre-wasm is missing: run scripts/build.sh first." >&2
    exit 1
  fi
  (
    cd web
    npm run lint
    npm run format:check
    npm run typecheck
  )
fi

if [[ -f tests/e2e/package.json ]] && checks e2e; then
  (cd tests/e2e && npm run typecheck)
fi

if [[ -f android/settings.gradle.kts ]] && checks android; then
  export PATH="$HOME/.local/bin:$PATH"
  # The generated bindings are not ours to format.
  (cd android && ktlint '**/*.kt' '**/*.kts' '!**/build/**' '!app/src/main/java/uniffi/**')
fi

node scripts/check-links.mjs
