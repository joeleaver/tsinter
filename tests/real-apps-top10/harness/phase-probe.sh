#!/bin/bash
# phase-probe.sh <project> [minutes=20] [interval-seconds=60] : where a slow top-10 wasm compile spends its time.
# Compiles the project's entry once (backend wasm, its npmStatic) with packages/compiler/dist under a hard
# timeout, and every <interval> seconds asks Node for a diagnostic report (--report-on-signal), printing the
# top JS frames of each. On nico-top through nico.sh (third-party code only runs there):
#   nico.sh <worktree> -- bash tests/real-apps-top10/harness/phase-probe.sh rea 20
# Reports land in ${SURVEY_TOP10_RES:-~/.cache/tsinter-dl/top10/res}/<project>/phase/.
H=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$H/../../.." && pwd)
P=$1; MIN=${2:-20}; EVERY=${3:-60}
RES=${SURVEY_TOP10_RES:-$HOME/.cache/tsinter-dl/top10/res}
OUT=$RES/$P/phase
rm -rf "$OUT"; mkdir -p "$OUT"
read -r ENTRY CWD NPM < <(python3 -I - "$H" "$P" <<'EOF'
import json, os, sys
h, p = sys.argv[1], sys.argv[2]
w = json.load(open(os.path.join(h, "workloads.json")))[p]
root = os.path.expanduser(f"~/.cache/tsinter-dl/top10/src/{p}")
e = w["entry"]
e = os.path.join(root, w.get("driverDir", ".top10"), e[len("@drivers/"):]) if e.startswith("@drivers/") else os.path.join(root, e)
n = w.get("npmStatic", "auto")
print(e, os.path.join(root, w.get("cwd", ".")), n if isinstance(n, str) else ",".join(n))
EOF
)
[ -f "$ENTRY" ] || { echo "entry $ENTRY missing (run lane.py $P node once to place the drivers)"; exit 2; }
cat > "$OUT/driver.mjs" <<EOF
import { compile } from "$REPO/packages/compiler/dist/index.js";
const t0 = Date.now();
const npm = process.argv[3];
const r = await compile(process.argv[2], { outPath: "$OUT/program.wasm", outDir: "$OUT", backend: "wasm",
  ...(npm === "auto" ? { npmStatic: "auto" } : npm ? { npmStatic: npm.split(",") } : {}) });
console.log("COMPILE", r.ok ? "ok" : "refused " + r.diagnostics.length, ((Date.now() - t0) / 1000).toFixed(0) + "s");
if (!r.ok) {
  const c = new Map();
  for (const d of r.diagnostics) c.set(d.code, (c.get(d.code) ?? 0) + 1);
  console.log("CODES", JSON.stringify([...c].sort((a, b) => b[1] - a[1])));
  (await import("node:fs")).writeFileSync("$OUT/build.json", JSON.stringify(r.diagnostics, null, 1));
}
EOF
cd "$CWD" || exit 2
timeout -s KILL "$((MIN * 60))" node --max-old-space-size="${SURVEY_HEAP_MB:-11000}" --report-on-signal --report-signal=SIGUSR2 \
  --report-directory="$OUT" --report-compact "$OUT/driver.mjs" "$ENTRY" "$NPM" > "$OUT/driver.log" 2>&1 &
TPID=$!
sleep 2
NPID=$(pgrep -P "$TPID" -x node || echo "")
t=0
while kill -0 "$TPID" 2>/dev/null; do
  sleep "$EVERY"; t=$((t + EVERY))
  [ -n "$NPID" ] && kill -0 "$NPID" 2>/dev/null || break
  before=$(ls "$OUT"/report*.json 2>/dev/null | wc -l)
  kill -USR2 "$NPID" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(ls "$OUT"/report*.json 2>/dev/null | wc -l)" -gt "$before" ] && break; sleep 1; done
  rep=""; [ "$(ls "$OUT"/report*.json 2>/dev/null | wc -l)" -gt "$before" ] && rep=$(ls -t "$OUT"/report*.json | head -1)
  rss=$(ps -o rss= -p "$NPID" 2>/dev/null | tr -d ' ')
  kids=$(ps -o pid=,etime=,rss=,comm= --ppid "$NPID" 2>/dev/null | tr -s ' ' | tr '\n' ';')
  echo "== t=${t}s rss=${rss}k children: $kids"
  [ -z "$rep" ] && echo "  no report within 10s (the main thread is blocked outside JS: a synchronous checker call into tsgo, or GC)"
  [ -n "$rep" ] && python3 -I -c "
import json,sys
r=json.load(open(sys.argv[1]))
st=r.get('javascriptStack',{}).get('stack',[])
print('  ' + r.get('javascriptStack',{}).get('message','')[:120])
for f in st[:14]: print('   ', f.strip()[:200])
" "$rep"
done
wait "$TPID"; echo "exit $?"
cat "$OUT/driver.log" | tail -20
