#!/usr/bin/env bash
# Formatting, linters and type checks for every part that exists, and the Markdown link check.
set -euo pipefail
cd "$(dirname "$0")/.."

# Each part adds its linters here when it is created.
node scripts/check-links.mjs
