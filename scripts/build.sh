#!/usr/bin/env bash
# Builds every part of the repository that exists: the core, the web client and the Android app.
set -euo pipefail
cd "$(dirname "$0")/.."

built=0
# Each part adds its build here when it is created, and sets built=1.

if [[ -f core/Cargo.toml ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # Run cargo inside core/ so rustup picks up core/rust-toolchain.toml.
  (
    cd core
    cargo build --workspace --locked
    cargo build -p lyre-wasm --target wasm32-unknown-unknown --locked
  )
  built=1
fi

if [[ "$built" == 0 ]]; then
  echo "Nothing to build yet."
fi
