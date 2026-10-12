#!/usr/bin/env bash
# Builds every part of the repository that exists: the core, the web client and the Android app.
set -euo pipefail
cd "$(dirname "$0")/.."

built=0
# Each part adds its build here when it is created, and sets built=1.

if [[ "$built" == 0 ]]; then
  echo "Nothing to build yet."
fi
