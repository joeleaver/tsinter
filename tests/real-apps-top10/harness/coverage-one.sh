#!/bin/bash
# coverage-one.sh <project> [extra coverage flags...] : `tsinter coverage` on one project's workload entry
# (its workloads.json cwd/entry/npmStatic/dynamic), output to ~/.cache/tsinter-dl/top10/res/<project>/coverage.txt.
# A quick read of every remaining blocker and the --npm-static statuses. On nico-top only (through nico.sh).
H=$(cd "$(dirname "$0")" && pwd)
p=$1; shift
read -r cwd entry flags < <(python3 -I - "$H" "$p" <<'PY'
import json, os, shutil, sys
h, p = sys.argv[1], sys.argv[2]
w = json.load(open(os.path.join(h, "workloads.json")))[p]
src = os.path.expanduser("~/.cache/tsinter-dl/top10/src/" + p)
ns = w.get("npmStatic", "auto")
f = (["--dynamic"] if w.get("dynamic") else []) + (["--npm-static", ns if isinstance(ns, str) else ",".join(ns)] if ns else [])
def place(e):  # lane.py's placement: an @drivers/ file is copied into the project's driverDir
    if not e.startswith("@drivers/"):
        return os.path.join(src, e)
    ddir = os.path.join(src, w.get("driverDir", ".top10"))
    os.makedirs(ddir, exist_ok=True)
    s = os.path.join(h, "..", "drivers", e[len("@drivers/"):])
    d = os.path.join(ddir, os.path.basename(s.rstrip("/")))
    if os.path.isdir(s):
        shutil.rmtree(d, ignore_errors=True)
        shutil.copytree(s, d)
    else:
        shutil.copyfile(s, d)
    return d
for extra in w.get("driverFiles", []):
    place(extra)
print(os.path.join(src, w["cwd"]), place(w["entry"]), " ".join(f))
PY
)
o=$HOME/.cache/tsinter-dl/top10/res/$p; mkdir -p "$o"
cd "$cwd" && NO_COLOR=1 node ${SURVEY_HEAP_MB:+--max-old-space-size=$SURVEY_HEAP_MB} "$H/../../../packages/cli/dist/main.js" coverage "$entry" $flags "$@" > "$o/coverage.txt" 2>&1
echo "coverage exit $?"; wc -l "$o/coverage.txt"; head -c 20000 "$o/coverage.txt"
