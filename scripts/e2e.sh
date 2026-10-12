#!/usr/bin/env bash
# End-to-end journeys against the built web client, once tests/e2e exists.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d tests/e2e ]]; then
  echo "No end-to-end tests yet."
  exit 0
fi
# The Playwright project adds its run here when it is created.
echo "tests/e2e exists but scripts/e2e.sh does not run it yet." >&2
exit 1
