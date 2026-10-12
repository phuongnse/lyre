#!/usr/bin/env bash
# End-to-end journeys against the built web client, once tests/e2e exists.
# Playwright serves web/dist with `vite preview`. The report and traces go to artifacts/e2e/.
# On a NexKit pull request it runs only when the change can affect the journeys (D16).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/parts.sh

if [[ ! -d tests/e2e ]]; then
  echo "No end-to-end tests yet."
  exit 0
fi
if ! checks e2e; then
  exit 0
fi
if [[ ! -f web/dist/index.html ]]; then
  echo "web/dist is missing: run scripts/build.sh first." >&2
  exit 1
fi
(cd tests/e2e && npx playwright test)
