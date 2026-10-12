#!/usr/bin/env bash
# Formatting, linters and type checks for every part that exists, and the Markdown link check.
set -euo pipefail
cd "$(dirname "$0")/.."

# Each part adds its linters here when it is created.
if [[ -f core/Cargo.toml ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # Run cargo inside core/ so rustup picks up core/rust-toolchain.toml.
  (
    cd core
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
  )
fi

if [[ -f web/package.json ]]; then
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

node scripts/check-links.mjs
