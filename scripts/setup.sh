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
  # The command-line tool must match the wasm-bindgen crate version exactly.
  wbg_version=$(sed -nE 's/^wasm-bindgen = "=([^"]+)"/\1/p' core/Cargo.toml)
  if [[ "$(wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $wbg_version" ]]; then
    (cd core && cargo install wasm-bindgen-cli --version "$wbg_version" --locked)
  fi
fi

if [[ -f web/package.json ]]; then
  (cd web && npm ci)
fi

if [[ -f tests/e2e/package.json ]]; then
  (
    cd tests/e2e
    npm ci
    # CI runners also need Chromium's system libraries. A developer machine keeps its own.
    if [[ -n "${CI:-}" ]]; then
      npx playwright install --with-deps chromium
    else
      npx playwright install chromium
    fi
  )
fi
