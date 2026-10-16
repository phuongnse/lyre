#!/usr/bin/env bash
# End-to-end journeys against the built web client, once tests/e2e exists.
# Playwright serves web/dist with tests/e2e/serve.mjs, at / and at /lyre/. The report and traces go to artifacts/e2e/.
# lyre-cli builds the version-0 fixture song into artifacts/e2e/, because song files are never committed. Only the journeys that check the Player refuses version 0 open it.
# The other journeys build their version-1 songs themselves, for the page's device code.
# They read the source fixtures, which tests/fixtures/source/make.sh makes with ffmpeg into artifacts/e2e/sources/.
# Then it boots the Android emulator headless, installs the app and runs its instrumented tests (the device tests), once android exists.
# The emulator is installed by scripts/setup.sh and its log goes to artifacts/e2e/emulator.log. It is shut down when the script ends.
# On a NexKit pull request each part runs only when the change can affect it (D16).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/parts.sh

if [[ ! -d tests/e2e ]]; then
  echo "No end-to-end tests yet."
elif checks e2e; then
  if [[ ! -f web/dist/index.html ]]; then
    echo "web/dist is missing: run scripts/build.sh first." >&2
    exit 1
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  (cd core && cargo run --locked -q -p lyre-cli -- build ../tests/fixtures/song/song.toml ../artifacts/e2e/fixture.lyre)
  tests/fixtures/source/make.sh artifacts/e2e/sources
  (cd tests/e2e && npx playwright test)
fi

if [[ -f android/settings.gradle.kts ]] && checks device; then
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
  adb="$ANDROID_HOME/platform-tools/adb"
  emulator="$ANDROID_HOME/emulator/emulator"
  avdmanager="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
  system_image=$(sed -nE 's/^systemImage = "([^"]+)"/\1/p' android/gradle/libs.versions.toml)
  if [[ ! -f android/app/src/main/jniLibs/x86_64/liblyre_ffi.so ]]; then
    echo "The x86_64 native library is missing: run scripts/build.sh first." >&2
    exit 1
  fi
  if [[ ! -x "$emulator" || ! -x "$adb" ]]; then
    echo "The Android emulator is missing: run scripts/setup.sh first." >&2
    exit 1
  fi
  mkdir -p artifacts/e2e/avd
  # avdmanager and the emulator must look in the same folder.
  export ANDROID_AVD_HOME="$PWD/artifacts/e2e/avd"
  echo no | "$avdmanager" create avd -n lyre -k "$system_image" --force
  "$emulator" -avd lyre -port 5554 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect >artifacts/e2e/emulator.log 2>&1 &
  emulator_pid=$!
  trap '"$adb" -s emulator-5554 emu kill >/dev/null 2>&1 || true; kill "$emulator_pid" 2>/dev/null || true; wait' EXIT
  deadline=$((SECONDS + 300))
  until [[ "$("$adb" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
    if ! kill -0 "$emulator_pid" 2>/dev/null || ((SECONDS >= deadline)); then
      echo "The Android emulator did not boot. See artifacts/e2e/emulator.log." >&2
      exit 1
    fi
    sleep 2
  done
  (cd android && ANDROID_SERIAL=emulator-5554 ./gradlew --console=plain connectedDebugAndroidTest)
fi
