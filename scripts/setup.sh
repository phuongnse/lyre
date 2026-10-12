#!/usr/bin/env bash
# Installs every dependency the checks need. Safe to run repeatedly.
# Each part of the repository adds its own steps here when it is created.
set -euo pipefail
cd "$(dirname "$0")/.."

node --version
