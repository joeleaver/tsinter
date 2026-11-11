#!/bin/bash
# run-all.sh [project...] : for each project (default: all of workloads.json): the Node oracle twice (node,
# node2: the second run checks the workload is deterministic), then the wasm lane, then wasm-native when
# the wasm build succeeded (FORCE_WN=1: always), one at a time, then cmp.py. Run it on nico-top through
# nico.sh (its 14G cap and heavy lock):
#   nico.sh <worktree> -- bash tests/real-apps-top10/harness/run-all.sh [project...]
# Results: ~/.cache/tsinter-dl/top10/res/<project>/{node,node2,wasm,wn}/, .../determinism.txt, .../cmp.txt
H=$(cd "$(dirname "$0")" && pwd)
RES=${SURVEY_TOP10_RES:-$HOME/.cache/tsinter-dl/top10/res}
projects=("$@")
[ ${#projects[@]} -eq 0 ] && mapfile -t projects < <(python3 -I -c "import json; print('\n'.join(json.load(open('$H/workloads.json'))))")
for p in "${projects[@]}"; do
  o=$RES/$p
  mkdir -p "$o"
  for lane in ${LANES:-node node2 wasm wn}; do
    if [ "$lane" = wn ] && [ -z "$FORCE_WN" ] && ! grep -q '^0' "$o/wasm/build.exit" 2>/dev/null; then
      echo "== $p wn skipped (the wasm build did not succeed; both lanes share the frontend)"; continue
    fi
    echo "== $p $lane $(date +%T)"
    python3 -I "$H/lane.py" "$p" "$lane"
  done
  [ -d "$o/node2" ] && python3 -I "$H/cmp.py" "$o/node" "$o/node2" > "$o/determinism.txt"
  dirs=("$o/node"); for l in wasm wn; do [ -d "$o/$l" ] && dirs+=("$o/$l"); done
  python3 -I "$H/cmp.py" "${dirs[@]}" | tee "$o/cmp.txt"
done
