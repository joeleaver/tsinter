#!/bin/bash
# rerun-openclaw.sh : openclaw's first wasm build ran the vitest worker out of its default ~2 GB JS heap
# (FATAL ERROR: Ineffective mark-compacts near heap limit). Re-run its build on both lanes with an 11 GB
# heap (inside nico.sh's 14G cap) to see what the compiler says when it has the memory.
#   nico.sh <worktree> -- bash tests/real-apps-top10/harness/rerun-openclaw.sh
H=$(cd "$(dirname "$0")" && pwd)
export SURVEY_HEAP_MB=${SURVEY_HEAP_MB:-11000}
LANES="wasm wn" FORCE_WN=1 bash "$H/run-all.sh" openclaw
