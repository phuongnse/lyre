#!/usr/bin/env bash
# Installs every dependency the checks need. Safe to run repeatedly.
# Each part of the repository adds its own steps here when it is created.
# On a NexKit pull request it sets up only the parts that the change can affect, and what they build on (D16).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/parts.sh

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

if [[ -f core/Cargo.toml ]] && needs core; then
  if ! command -v rustup >/dev/null 2>&1 && [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  # rustup reads core/rust-toolchain.toml: toolchain, components and targets.
  (cd core && rustup toolchain install && cargo --version)
  # cargo fuzz needs a nightly toolchain, which core/fuzz/rust-toolchain.toml pins. Everything else builds on the stable one.
  fuzz_nightly=$(sed -nE 's/^channel = "([^"]+)"/\1/p' core/fuzz/rust-toolchain.toml)
  rustup toolchain install "$fuzz_nightly" --profile minimal
  # The version of cargo-fuzz is pinned here, with the hash of its prebuilt archive.
  fuzz_version=0.13.2
  fuzz_sha256=b5b704018b63e0f151c17a057ac53b5111e1db545d1b9f72fee79f08a545931c
  if [[ "$(cargo fuzz --version 2>/dev/null)" != "cargo-fuzz $fuzz_version" ]]; then
    if [[ $prebuilt == 1 ]]; then
      tmp=$(mktemp -d)
      fetch_checked "https://github.com/rust-fuzz/cargo-fuzz/releases/download/$fuzz_version/cargo-fuzz-$fuzz_version-x86_64-unknown-linux-musl.tar.gz" "$tmp/cargo-fuzz.tar.gz" "$fuzz_sha256"
      tar -xzf "$tmp/cargo-fuzz.tar.gz" -C "$tmp"
      mkdir -p "$HOME/.cargo/bin"
      install -m 755 "$tmp/cargo-fuzz" "$HOME/.cargo/bin/cargo-fuzz"
      rm -rf "$tmp"
    else
      (cd core && cargo install cargo-fuzz --version "$fuzz_version" --locked)
    fi
  fi
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

if [[ -f web/package.json ]] && needs web; then
  (cd web && npm ci)
fi

if [[ -f tests/e2e/package.json ]] && needs e2e; then
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
  # scripts/e2e.sh makes the source fixtures with ffmpeg (tests/fixtures/source/make.sh).
  if ! command -v ffmpeg >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends ffmpeg
  fi
fi

if [[ -f android/settings.gradle.kts ]] && needs android; then
  # The Android versions are pinned in one place: the Gradle version catalog.
  catalog=android/gradle/libs.versions.toml
  catalog_version() { sed -nE "s/^$1 = \"([^\"]+)\"/\1/p" "$catalog"; }
  compile_sdk=$(catalog_version compileSdk)
  ndk=$(catalog_version ndk)
  ktlint=$(catalog_version ktlint)
  emulator_build=$(catalog_version emulatorBuild)
  system_image=$(catalog_version systemImage)
  # Pinned tools that are not in the catalog. Each download is checked against its SHA-256 hash.
  cmdline_tools=15859902
  cmdline_tools_sha256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
  cargo_ndk=4.1.2
  cargo_ndk_sha256=dc148bebbfcd7d5355e9858530d5a69c20ce69cf3268c54b9f63c60cb4c9a966
  emulator_sha256=b08fc43d8608d2955f607f1b287beb525041e730086bdca3af152accac3af9c1
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
  # The device tests boot an x86_64 emulator, which needs KVM. Other machines skip them.
  device=0
  if [[ $prebuilt == 1 ]] && needs device; then
    device=1
    [[ -x "$ANDROID_HOME/platform-tools/adb" ]] || packages+=("platform-tools")
    [[ -d "$ANDROID_HOME/${system_image//;//}" ]] || packages+=("$system_image")
  elif [[ $prebuilt == 0 ]]; then
    echo "The Android device tests need x86_64 Linux: skipping the emulator."
  fi
  if [[ $device == 1 ]]; then
    # Makes KVM usable by every user, when it is there but locked.
    if [[ -e /dev/kvm && ! -w /dev/kvm ]]; then
      echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules >/dev/null
      sudo udevadm control --reload-rules
      sudo udevadm trigger --name-match=kvm
    fi
    # sdkmanager installs only the latest emulator, so the pinned build comes from its zip.
    # It goes in first, so that sdkmanager finds it when it installs the system image.
    # The zip is kept in ~/.cache/lyre/emulator/ and reused when its hash matches.
    emulator_zip="$HOME/.cache/lyre/emulator/emulator-linux_x64-$emulator_build.zip"
    if [[ "$("$ANDROID_HOME/emulator/emulator" -version 2>/dev/null)" != *"build_id $emulator_build"* ]]; then
      if ! echo "$emulator_sha256  $emulator_zip" | sha256sum --check --quiet >/dev/null 2>&1; then
        mkdir -p "$(dirname "$emulator_zip")"
        find "$(dirname "$emulator_zip")" -name 'emulator-linux_x64-*.zip' -delete
        fetch_checked "https://dl.google.com/android/repository/emulator-linux_x64-$emulator_build.zip" "$emulator_zip" "$emulator_sha256"
      fi
      tmp=$(mktemp -d)
      unzip -q "$emulator_zip" -d "$tmp"
      rm -rf "$ANDROID_HOME/emulator"
      mv "$tmp/emulator" "$ANDROID_HOME/emulator"
      rm -rf "$tmp"
      # The zip has no package.xml. Without it sdkmanager does not know the emulator and installs a second one.
      IFS=. read -r emulator_major emulator_minor emulator_micro < <(sed -nE 's/^Pkg\.Revision=//p' "$ANDROID_HOME/emulator/source.properties")
      cat >"$ANDROID_HOME/emulator/package.xml" <<XML
<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02" xmlns:ns5="http://schemas.android.com/repository/android/generic/02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><localPackage path="emulator" obsolete="false"><type-details xsi:type="ns5:genericDetailsType"/><revision><major>$emulator_major</major><minor>$emulator_minor</minor><micro>$emulator_micro</micro></revision><display-name>Android Emulator</display-name></localPackage></ns2:repository>
XML
    fi
  fi

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
