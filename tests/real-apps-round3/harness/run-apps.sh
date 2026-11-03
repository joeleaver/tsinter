#!/bin/bash
# run-apps.sh [spec...] : for each spec (default: the 9 unpatched apps), the Node oracle, then the
# wasm-native and wasm lanes, each in its own 16 GB memory cap, one at a time; then cmp.py.
# Results: $WORK/res/<spec>/{node,wn,wasm}/ and $WORK/res/<spec>/cmp.txt
H=$(cd "$(dirname "$0")" && pwd)
WORK=${RA_WORK:-$HOME/.cache/tsinter-dl/work/real-apps-round3}
specs=("$@")
[ ${#specs[@]} -eq 0 ] && specs=(chess toml papa polka expr marked markedlib diff semver)
cap() { systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 "$@"; }
for s in "${specs[@]}"; do
  o=$WORK/res/$s
  mkdir -p "$o"
  for lane in ${LANES:-node wn wasm}; do
    echo "== $s $lane $(date +%T)"
    cap python3 -I "$H/lane.py" "$WORK/specs/$s.json" "$lane" "$o/$lane"
  done
  python3 -I "$H/cmp.py" "$o/node" "$o/wn" "$o/wasm" | tee "$o/cmp.txt"
done
