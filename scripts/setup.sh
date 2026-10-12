#!/usr/bin/env bash
# Installs every dependency the checks need. Safe to run repeatedly.
# Each part of the repository adds its own steps here when it is created.
set -euo pipefail
cd "$(dirname "$0")/.."

node --version

if [[ -f core/Cargo.toml ]]; then
  if ! command -v rustup >/dev/null 2>&1 && [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  # rustup reads core/rust-toolchain.toml: toolchain, components and targets.
  (cd core && rustup toolchain install && cargo --version)
fi
