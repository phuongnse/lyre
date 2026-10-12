#!/usr/bin/env bash
# Installs every dependency the checks need. Safe to run repeatedly.
# Each part of the repository adds its own steps here when it is created.
set -euo pipefail
cd "$(dirname "$0")/.."

# Downloads $1 to $2 and stops setup unless the file's SHA-256 hash is $3.
fetch_checked() {
  echo "Downloading $1"
  curl -sSfL "$1" -o "$2"
  if ! echo "$3  $2" | sha256sum --check --quiet; then
    rm -f "$2"
    echo "The SHA-256 hash of $1 does not match the hash pinned in scripts/setup.sh." >&2
    exit 1
  fi
}
# Prebuilt binaries are pinned for x86_64 Linux only. Other machines compile the tools.
prebuilt=0
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] && prebuilt=1

node --version

if [[ -f core/Cargo.toml ]]; then
  if ! command -v rustup >/dev/null 2>&1 && [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  # rustup reads core/rust-toolchain.toml: toolchain, components and targets.
  (cd core && rustup toolchain install && cargo --version)
  # The command-line tool must match the wasm-bindgen crate version exactly.
  # The version is pinned in core/Cargo.toml. The hash of its prebuilt archive is pinned here.
  wbg_version=$(sed -nE 's/^wasm-bindgen = "=([^"]+)"/\1/p' core/Cargo.toml)
  wbg_sha256=82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e
  if [[ "$(wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $wbg_version" ]]; then
    if [[ $prebuilt == 1 ]]; then
      wbg_dir="wasm-bindgen-$wbg_version-x86_64-unknown-linux-musl"
      tmp=$(mktemp -d)
      fetch_checked "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$wbg_version/$wbg_dir.tar.gz" "$tmp/wbg.tar.gz" "$wbg_sha256"
      tar -xzf "$tmp/wbg.tar.gz" -C "$tmp"
      mkdir -p "$HOME/.cargo/bin"
      install -m 755 "$tmp/$wbg_dir/wasm-bindgen" "$HOME/.cargo/bin/wasm-bindgen"
      rm -rf "$tmp"
    else
      (cd core && cargo install wasm-bindgen-cli --version "$wbg_version" --locked)
    fi
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
  cargo_ndk_sha256=dc148bebbfcd7d5355e9858530d5a69c20ce69cf3268c54b9f63c60cb4c9a966
  ktlint_sha256=a3fd620207d5c40da6ca789b95e7f823c54e854b7fade7f613e91096a3706d75

  java_major=$(java -version 2>&1 | sed -nE '1s/.*version "([0-9]+).*/\1/p')
  if [[ "${java_major:-0}" -lt 17 ]]; then
    sudo apt-get install -y openjdk-17-jdk-headless
  fi

  export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
  sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  if [[ ! -x "$sdkmanager" ]]; then
    tmp=$(mktemp -d)
    fetch_checked "https://dl.google.com/android/repository/commandlinetools-linux-${cmdline_tools}_latest.zip" "$tmp/tools.zip" "$cmdline_tools_sha256"
    unzip -q "$tmp/tools.zip" -d "$tmp"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm -rf "$tmp"
  fi
  platform="android-$compile_sdk.0"
  # Installs only the packages the SDK lacks. The runner's preinstalled SDK usually has both.
  packages=()
  [[ -d "$ANDROID_HOME/platforms/$platform" ]] || packages+=("platforms;$platform")
  [[ -d "$ANDROID_HOME/ndk/$ndk" ]] || packages+=("ndk;$ndk")
  if [[ ${#packages[@]} -gt 0 ]]; then
    echo "Downloading Android packages: ${packages[*]}"
    yes | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
    "$sdkmanager" --sdk_root="$ANDROID_HOME" "${packages[@]}"
  fi

  export PATH="$HOME/.cargo/bin:$PATH"
  if [[ "$(cargo ndk --version 2>/dev/null)" != "cargo-ndk $cargo_ndk" ]]; then
    if [[ $prebuilt == 1 ]]; then
      ndk_dir="cargo-ndk-x86_64-unknown-linux-musl-v$cargo_ndk"
      tmp=$(mktemp -d)
      fetch_checked "https://github.com/bbqsrc/cargo-ndk/releases/download/v$cargo_ndk/$ndk_dir.tgz" "$tmp/cargo-ndk.tgz" "$cargo_ndk_sha256"
      tar -xzf "$tmp/cargo-ndk.tgz" -C "$tmp"
      mkdir -p "$HOME/.cargo/bin"
      install -m 755 "$tmp/$ndk_dir/cargo-ndk" "$HOME/.cargo/bin/cargo-ndk"
      rm -rf "$tmp"
    else
      cargo install cargo-ndk --version "$cargo_ndk" --locked
    fi
  fi

  if [[ "$("$HOME/.local/bin/ktlint" --version 2>/dev/null)" != *"$ktlint"* ]]; then
    tmp=$(mktemp -d)
    fetch_checked "https://github.com/ktlint/ktlint/releases/download/$ktlint/ktlint" "$tmp/ktlint" "$ktlint_sha256"
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$tmp/ktlint" "$HOME/.local/bin/ktlint"
    rm -rf "$tmp"
  fi

  # Fetches the Gradle distribution that the wrapper pins.
  (cd android && ./gradlew --version)
fi
