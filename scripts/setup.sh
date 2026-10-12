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

if [[ -f android/settings.gradle.kts ]]; then
  # The Android versions are pinned in one place: the Gradle version catalog.
  catalog=android/gradle/libs.versions.toml
  catalog_version() { sed -nE "s/^$1 = \"([^\"]+)\"/\1/p" "$catalog"; }
  compile_sdk=$(catalog_version compileSdk)
  ndk=$(catalog_version ndk)
  ktlint=$(catalog_version ktlint)
  # Pinned tools that are not in the catalog. Each download is checked against its SHA-256 hash.
  cmdline_tools=15859902
  cmdline_tools_sha256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
  cargo_ndk=4.1.2
  ktlint_sha256=a3fd620207d5c40da6ca789b95e7f823c54e854b7fade7f613e91096a3706d75

  java_major=$(java -version 2>&1 | sed -nE '1s/.*version "([0-9]+).*/\1/p')
  if [[ "${java_major:-0}" -lt 17 ]]; then
    sudo apt-get install -y openjdk-17-jdk-headless
  fi

  export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
  sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  if [[ ! -x "$sdkmanager" ]]; then
    tmp=$(mktemp -d)
    curl -sSfL "https://dl.google.com/android/repository/commandlinetools-linux-${cmdline_tools}_latest.zip" -o "$tmp/tools.zip"
    echo "$cmdline_tools_sha256  $tmp/tools.zip" | sha256sum --check --quiet
    unzip -q "$tmp/tools.zip" -d "$tmp"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm -rf "$tmp"
  fi
  platform="android-$compile_sdk.0"
  if [[ ! -d "$ANDROID_HOME/platforms/$platform" || ! -d "$ANDROID_HOME/ndk/$ndk" ]]; then
    yes | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
    "$sdkmanager" --sdk_root="$ANDROID_HOME" "platforms;$platform" "ndk;$ndk"
  fi

  export PATH="$HOME/.cargo/bin:$PATH"
  if [[ "$(cargo ndk --version 2>/dev/null)" != "cargo-ndk $cargo_ndk" ]]; then
    cargo install cargo-ndk --version "$cargo_ndk" --locked
  fi

  if [[ "$("$HOME/.local/bin/ktlint" --version 2>/dev/null)" != *"$ktlint"* ]]; then
    tmp=$(mktemp -d)
    curl -sSfL "https://github.com/ktlint/ktlint/releases/download/$ktlint/ktlint" -o "$tmp/ktlint"
    echo "$ktlint_sha256  $tmp/ktlint" | sha256sum --check --quiet
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$tmp/ktlint" "$HOME/.local/bin/ktlint"
    rm -rf "$tmp"
  fi

  # Fetches the Gradle distribution that the wrapper pins.
  (cd android && ./gradlew --version)
fi
