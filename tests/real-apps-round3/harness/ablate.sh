#!/bin/bash
# ablate.sh [cat...] : chess.js patch-category ablation. For each category: rebuild the variant with every
# patch except that one (chess-variant.py <cat> chess-abl), build it on wasm-native and run the 9 cases there,
# then build it on wasm (build only), and compare against Node on the fully patched variant (whose output
# equals Node on the unpatched source; see README). Results: $WORK/res/ablate/<cat>/{wn,wasm}, summary.txt.
H=$(cd "$(dirname "$0")" && pwd)
WORK=${RA_WORK:-$HOME/.cache/tsinter-dl/work/real-apps-round3}
cats=("$@")
[ ${#cats[@]} -eq 0 ] && cats=(bigint formulti sparse privbracket tsgocrash throwbang compound inop untypedarr looseeq pgnheaders typeofargs defparam recundef popguard pgn_in pgn_proto histsplit)
cap() { systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 "$@"; }
mkdir -p "$WORK/res/ablate"
for c in "${cats[@]}"; do
  o=$WORK/res/ablate/$c
  rm -rf "$o"; mkdir -p "$o"
  python3 -I "$H/chess-variant.py" "$c" chess-abl > "$o/variant.txt"
  sed "s|/apps/chess-min/|/apps/chess-abl/|g; s|/apps/chess-min\"|/apps/chess-abl\"|g" "$WORK/specs/chess-min.json" > "$o/spec.json"
  python3 -I -c 'import json,sys; s=json.load(open(sys.argv[1])); s["cases"]=[]; json.dump(s,open(sys.argv[2],"w"))' "$o/spec.json" "$o/spec-build.json"
  cap python3 -I "$H/lane.py" "$o/spec.json" wn "$o/wn" > /dev/null
  cap python3 -I "$H/lane.py" "$o/spec-build.json" wasm "$o/wasm" > /dev/null
  wn=$(python3 -I "$H/cmp.py" "$WORK/res/chess-v/node" "$o/wn" | tail -n +2 | awk '{print $2}' | sort | uniq -c | tr '\n' ' ')
  first=$(grep -m1 -E " - error SC| error SC" "$o/wn/build.log" | sed -E 's|.*/apps/chess-abl/||' | cut -c1-200)
  line="$c | $(cat "$o/variant.txt" | tr '\n' ' ') | wn build=$(cut -d' ' -f1 "$o/wn/build.exit") wasm build=$(cat "$o/wasm/build.exit" 2>/dev/null) | cases: $wn | $first"
  echo "$line" | tee -a "$WORK/res/ablate/summary.txt"
done
