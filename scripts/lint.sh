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

node scripts/check-links.mjs
