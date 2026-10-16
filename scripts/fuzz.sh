#!/usr/bin/env bash
# Fuzzes every parser of untrusted input in the core: one cargo fuzz target each (core/fuzz).
# Usage: scripts/fuzz.sh [seconds]. Each target runs for that many seconds, 10 by default.
# The seeds are written on every run into artifacts/fuzz/seeds. The corpus and any crash go to artifacts/fuzz/.
# scripts/test.sh runs this script whenever the core is checked.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

seconds=${1:-10}
if ! [[ "$seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: scripts/fuzz.sh [seconds]" >&2
  exit 2
fi

# The nightly toolchain is pinned in one file. Everything else uses the stable one.
nightly=$(sed -nE 's/^channel = "([^"]+)"/\1/p' core/fuzz/rust-toolchain.toml)
if [[ -z "$nightly" ]]; then
  echo "core/fuzz/rust-toolchain.toml names no channel." >&2
  exit 1
fi

# cargo-fuzz builds for the target it was built for by default, and a prebuilt musl binary cannot use a sanitizer.
host=$(rustc +"$nightly" -vV | sed -n 's/^host: //p')

root=$PWD/artifacts/fuzz
rm -rf "$root/seeds"
# Run cargo inside core/ so rustup picks up core/rust-toolchain.toml.
(cd core && cargo run --locked -q -p lyre-cli --example fuzz_seeds -- ../tests/fixtures/song/song.toml "$root/seeds")

targets=$(cd core && cargo fuzz list)
for target in $targets; do
  if [[ -z "$(ls -A "$root/seeds/$target" 2>/dev/null)" ]]; then
    echo "No seed was written for the fuzz target $target." >&2
    exit 1
  fi
done

for target in $targets; do
  echo "Fuzzing $target for $seconds s"
  mkdir -p "$root/corpus/$target" "$root/crashes"
  # The first directory is the writable corpus. The second holds the seeds, which libFuzzer only reads.
  # -O builds with optimisations and -a keeps debug assertions, so integer overflow panics.
  (
    cd core
    cargo +"$nightly" fuzz run --target "$host" -O -a "$target" "$root/corpus/$target" "$root/seeds/$target" -- \
      -max_total_time="$seconds" -timeout=5 -artifact_prefix="$root/crashes/$target-"
  )
done
