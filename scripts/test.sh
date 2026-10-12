#!/usr/bin/env bash
# Unit tests for every part that exists, and the tests of the scripts themselves.
set -euo pipefail
cd "$(dirname "$0")/.."

# Each part adds its unit tests here when it is created.
node --test scripts/*.test.mjs
