#!/bin/bash
# coverage-one.sh <project> [extra coverage flags...] : `tsinter coverage` on one project's workload entry
# (its workloads.json cwd/entry/npmStatic/dynamic), output to ~/.cache/tsinter-dl/top10/res/<project>/coverage.txt.
# A quick read of every remaining blocker and the --npm-static statuses. On nico-top only (through nico.sh).
H=$(cd "$(dirname "$0")" && pwd)
p=$1; shift
read -r cwd entry flags < <(python3 -I - "$H" "$p" <<'PY'
import json, os, sys
h, p = sys.argv[1], sys.argv[2]
w = json.load(open(os.path.join(h, "workloads.json")))[p]
src = os.path.expanduser("~/.cache/tsinter-dl/top10/src/" + p)
ns = w.get("npmStatic", "auto")
f = (["--dynamic"] if w.get("dynamic") else []) + (["--npm-static", ns if isinstance(ns, str) else ",".join(ns)] if ns else [])
print(os.path.join(src, w["cwd"]), os.path.join(src, w["entry"]), " ".join(f))
PY
)
o=$HOME/.cache/tsinter-dl/top10/res/$p; mkdir -p "$o"
cd "$cwd" && NO_COLOR=1 node ${SURVEY_HEAP_MB:+--max-old-space-size=$SURVEY_HEAP_MB} "$H/../../../packages/cli/dist/main.js" coverage "$entry" $flags "$@" > "$o/coverage.txt" 2>&1
echo "coverage exit $?"; wc -l "$o/coverage.txt"; head -c 20000 "$o/coverage.txt"
