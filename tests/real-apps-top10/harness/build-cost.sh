#!/bin/bash
# build-cost.sh <tag> : the wasm-lane build cost of the multi-package projects. Run it on nico-top:
#   nico.sh <worktree> -- bash tests/real-apps-top10/harness/build-cost.sh <tag>
# For n8n, deepseek, opendesign: one wasm-lane CLI build, its wall time and the
# peak RSS of the whole process tree (node CLI + its tsgo server), sampled
# every 0.2 s. Output lines: "== <tag> <project> wall=<s> peakRSS=<MB> rc=<rc> diags=<n>".
TAG=$1
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
S=$HOME/.cache/tsinter-dl/top10/src
OUT=$HOME/.cache/tsinter-dl/top10/cost-$TAG
mkdir -p $OUT
tree_rss() { # sum RSS (kB) of $1 and all descendants
  local pids=$1 all=$1 kids
  while [ -n "$pids" ]; do
    kids=$(for p in $pids; do pgrep -P $p; done | tr '\n' ' ')
    all="$all $kids"; pids=$kids
  done
  ps -o rss= -p $(echo $all | tr ' ' ',') 2>/dev/null | awk '{s+=$1} END {print s+0}'
}
for spec in "n8n packages/workflow packages/workflow/.top10/n8n-main.ts" "deepseek apps/cli apps/cli/src/bin.ts" "opendesign apps/daemon apps/daemon/src/cli.ts"; do
  set -- $spec; p=$1; cwd=$S/$p/$2; entry=$S/$p/$3
  [ -f "$entry" ] || { echo "== $TAG $p MISSING ENTRY $entry"; continue; }
  t0=$(date +%s.%N)
  (cd $cwd && exec node --max-old-space-size=11000 $REPO/packages/cli/dist/main.js build $entry --backend wasm -o $OUT/$p.wasm > $OUT/$p.log 2>&1) &
  pid=$!; peak=0
  while kill -0 $pid 2>/dev/null; do
    r=$(tree_rss $pid); [ "$r" -gt "$peak" ] && peak=$r
    sleep 0.2
  done
  wait $pid; rc=$?
  t1=$(date +%s.%N)
  echo "== $TAG $p wall=$(awk "BEGIN {printf \"%.1f\", $t1 - $t0}") peakRSS=$((peak / 1024))MB rc=$rc diags=$(grep -c 'error SC' $OUT/$p.log)"
done
