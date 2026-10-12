#!/usr/bin/env bash
# Unit tests for every part that exists, and the tests of the scripts themselves.
set -euo pipefail
cd "$(dirname "$0")/.."

# Each part adds its unit tests here when it is created.
if [[ -f core/Cargo.toml ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # Run cargo inside core/ so rustup picks up core/rust-toolchain.toml.
  (cd core && cargo test --workspace --locked)
fi

node --test scripts/*.test.mjs
