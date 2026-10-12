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
    cargo build -p lyre-wasm --target wasm32-unknown-unknown --release --locked
  )
  built=1
fi

if [[ -f web/package.json ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # The generated package is not committed: it is always rebuilt from the core.
  wasm-bindgen --target web --out-dir web/src/lyre-wasm core/target/wasm32-unknown-unknown/release/lyre_wasm.wasm
  (cd web && npm run build)
  built=1
fi

if [[ "$built" == 0 ]]; then
  echo "Nothing to build yet."
fi
