# Sourced by the check scripts (D16). Reads which parts a change can affect from scripts/parts.mjs.
# `checks NAME` is true when the part's own checks should run.
# `needs NAME` is true when the part must also be set up and built, because a checked part builds on it.
# A skipped part prints one line and returns 1. Call both from the repository root.

# No process substitution: a failure of node must stop the script under `set -e`.
parts_report=$(node scripts/parts.mjs)
declare -A part_state part_label
parts_base=-
while read -r first second rest; do
  if [[ "$first" == base ]]; then
    parts_base=$second
  else
    part_state[$first]=$second
    part_label[$first]=$rest
  fi
done <<<"$parts_report"

parts_skip() {
  echo "Skipping ${part_label[$1]}: no change since $parts_base can affect it."
  return 1
}

checks() {
  [[ "${part_state[$1]}" == checked ]] || parts_skip "$1"
}

needs() {
  [[ "${part_state[$1]}" == checked || "${part_state[$1]}" == needed ]] || parts_skip "$1"
}
