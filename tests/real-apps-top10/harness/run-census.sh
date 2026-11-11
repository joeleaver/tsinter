#!/bin/bash
# run-census.sh [project...] : the blocker census (blockers.py), at the type-check gate and past it, then
# collect.py. On nico-top through nico.sh:
#   nico.sh <worktree> -- bash tests/real-apps-top10/harness/run-census.sh [project...]
# Writes ../results/blockers-census${SURVEY_CENSUS_TAG}.txt and ../results/blockers-census-past-gate${TAG}.txt
# (+ collect.py's files). openclaw runs alone with its own tag: its analysis outgrows the 14G cap, and an
# OOM kill takes the whole nico.sh unit with it.
H=$(cd "$(dirname "$0")" && pwd)
R=$H/../results
T=${SURVEY_CENSUS_TAG:-}
mkdir -p "$R"
python3 -I "$H/blockers.py" "$@" > "$R/blockers-census$T.txt" 2>&1
SITES_PAST_GATE=1 python3 -I "$H/blockers.py" "$@" > "$R/blockers-census-past-gate$T.txt" 2>&1
python3 -I "$H/collect.py"
tail -40 "$R/blockers-census$T.txt"
