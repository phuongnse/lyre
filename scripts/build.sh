#!/usr/bin/env bash
# Builds every part of the repository that exists: the core, the web client and the Android app.
# On a NexKit pull request it builds only the parts that the change can affect, and what they build on (D16).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/parts.sh

built=0
# Each part adds its build here when it is created, and sets built=1.

if [[ -f core/Cargo.toml ]] && needs core; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # Run cargo inside core/ so rustup picks up core/rust-toolchain.toml.
  (
    cd core
    cargo build --workspace --locked
    cargo build -p lyre-wasm --target wasm32-unknown-unknown --release --locked
    # lyre_wasm does not call word lookup yet, so the linker would drop the word list from it.
    # Measure the list on a small module that calls lookup, built with and without it (D18).
    size_example=(-p lyre-core --example word_list_size --target wasm32-unknown-unknown --release --locked)
    size_wasm=target/wasm32-unknown-unknown/release/examples/word_list_size.wasm
    cargo build "${size_example[@]}"
    cp "$size_wasm" target/word_list_size.with.wasm
    cargo build "${size_example[@]}" --no-default-features
    cp "$size_wasm" target/word_list_size.without.wasm
    node ../scripts/word-list-size.mjs target/word_list_size.with.wasm target/word_list_size.without.wasm
  )
  built=1
fi

if [[ -f web/package.json ]] && needs web; then
  export PATH="$HOME/.cargo/bin:$PATH"
  # The generated package is not committed: it is always rebuilt from the core.
  wasm-bindgen --target web --out-dir web/src/lyre-wasm core/target/wasm32-unknown-unknown/release/lyre_wasm.wasm
  (cd web && npm run build)
  built=1
fi

if [[ -f android/settings.gradle.kts ]] && needs android; then
  export PATH="$HOME/.cargo/bin:$PATH"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
  ndk=$(sed -nE 's/^ndk = "([^"]+)"/\1/p' android/gradle/libs.versions.toml)
  export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$ndk"
  # The generated files are not committed: they are always rebuilt from the core.
  # The core block above built the host liblyre_ffi.so that the bindings are read from,
  # and the uniffi-bindgen tool that reads it.
  (
    cd core
    cargo ndk -t arm64-v8a -o ../android/app/src/main/jniLibs build -p lyre-ffi --release --locked --no-default-features
    target/debug/uniffi-bindgen generate --library target/debug/liblyre_ffi.so --language kotlin --no-format \
      --out-dir ../android/app/src/main/java
  )
  (cd android && ./gradlew --console=plain assembleDebug)
  # Read the whole listing first: grep -q would close the pipe early and fail the pipeline.
  apk_files=$(unzip -l android/app/build/outputs/apk/debug/app-debug.apk)
  if ! grep -q 'lib/arm64-v8a/liblyre_ffi.so' <<<"$apk_files"; then
    echo "liblyre_ffi.so is missing from the APK." >&2
    exit 1
  fi
  built=1
fi

if [[ "$built" == 0 ]]; then
  echo "Nothing to build yet."
fi
