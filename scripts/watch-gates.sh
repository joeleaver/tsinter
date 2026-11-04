#!/usr/bin/env bash
# Wait for a cloud gate to finish. Cloud sessions can't report back, but each
# gate pushes gate-results/<sha>.md to its branch. This polls origin and exits
# (printing the new file and its verdict line) as soon as a new one appears.
# Usage: scripts/watch-gates.sh [poll-seconds]   (default 120)
set -u
cd "$(dirname "$0")/.."
poll=${1:-120}
list() {
  git fetch -q --prune origin '+refs/heads/*:refs/remotes/gatewatch/*' 2>/dev/null || return 1
  for r in $(git for-each-ref --format='%(refname)' refs/remotes/gatewatch/); do
    git ls-tree --name-only "$r" gate-results/ 2>/dev/null | sed "s|^|$r |"
  done | sort
}
until base=$(list); do sleep "$poll"; done
while sleep "$poll"; do
  now=$(list) || continue
  new=$(comm -13 <(echo "$base") <(echo "$now"))
  if [ -n "$new" ]; then
    while read -r ref file; do
      echo "NEW GATE: ${ref#refs/remotes/gatewatch/} $file"
      git show "$ref:$file" | grep -m1 -i 'verdict' || true
    done <<<"$new"
    exit 0
  fi
done
