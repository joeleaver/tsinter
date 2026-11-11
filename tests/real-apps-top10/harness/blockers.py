#!/usr/bin/env python3
"""blockers.py [project...] : the refusal census of each project's workload entry (nico-top only).

Round 3's blockers.py (../../real-apps-round3/harness/blockers.py) over workloads.json: for each project,
this directory's sites.mjs (round 3's, plus npmStatic "auto" and SITES_PAST_GATE; analyze(), lowered as the WasmGC lanes lower) lists every reached root refusal site —
compile diagnostics (D) and deferred runtime fences (F) — with the same npmStatic setting as the build.
Each site is classified with ../../real-apps-round3/survey/families.py; cascades are dropped, and sites in
the trial's own driver files are kept apart as "driver:<family>". Sites inside node_modules are tagged
"dep:" in the per-project listing (they are still counted: a dependency the build compiles statically is
part of what has to build). Writes WORK/res/sites/<project>.json and prints, per project, family ->
root-site count with an example, then the census over all projects (projects blocked, root sites).
SITES_PAST_GATE=1 (passed through to sites.mjs) lists the sites behind a type-check failure too and writes
WORK/res/sites-gate/ instead."""
import collections, json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DRIVERS, NODE, RES, ROUND3, SRC, WORK, workloads  # noqa: E402

sys.path.insert(0, os.path.join(ROUND3, "survey"))
from families import TITLES, classify  # noqa: E402

W = workloads()
want = sys.argv[1:] or list(W)
SD = f"{RES}/sites-gate" if os.environ.get("SITES_PAST_GATE") == "1" else f"{RES}/sites"
os.makedirs(SD, exist_ok=True)
census = collections.defaultdict(collections.Counter)
summary = {}
for proj in want:
    w = W[proj]
    root = os.path.join(SRC, proj)
    e = w["entry"]
    entry = os.path.join(root, w.get("driverDir", ".top10"), os.path.basename(e)) if e.startswith("@drivers/") else os.path.join(root, e)
    ns = w.get("npmStatic", "auto")
    out = f"{SD}/{proj}.json"
    try:
        p = subprocess.run([NODE, "--stack-size=8000", "--max-old-space-size=" + os.environ.get("SURVEY_HEAP_MB", "11000"), os.path.join(os.path.dirname(os.path.abspath(__file__)), "sites.mjs"), entry, (ns if isinstance(ns, str) else ",".join(ns)) if ns else ""],
                           cwd=os.path.join(root, w.get("cwd", ".")), capture_output=True, timeout=5400)
        rc, so, se = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        rc, so, se = 124, b"", b"TIMEOUT"
    if rc != 0:
        print(f"## {proj}: sites.mjs failed rc={rc}: {se.decode(errors='replace')[-600:]}")
        summary[proj] = {"error": se.decode(errors="replace")[-600:]}
        continue
    open(out, "wb").write(so)
    sites = json.loads(so)
    fam = collections.Counter()
    ex = {}
    seen = set()
    drivers = {os.path.realpath(entry)} | {os.path.realpath(os.path.join(root, w.get("driverDir", ".top10"), os.path.basename(d))) for d in w.get("driverFiles", [])}
    for s in sites:
        f = classify(s["code"], s["message"], s["shape"])
        if f is None:
            continue
        key = (s["file"], s["line"], s["col"], s["message"])
        if key in seen:
            continue
        seen.add(key)
        if os.path.realpath(s["file"]) in drivers:
            f = "driver:" + f
        fam[f] += 1
        tag = "dep " if "/node_modules/" in s["file"] else ""
        ex.setdefault(f, f"{tag}{s['kind']} {s['code']} {os.path.relpath(s['file'], root)}:{s['line']} {s['src'][:80]} -- {s['message'][:110]}")
    print(f"## {proj}: {sum(fam.values())} root sites ({len(sites)} reached, cascades included)")
    for f, n in fam.most_common():
        print(f"  {n:5d} {f:18} e.g. {ex[f]}")
        if not f.startswith("driver:"):
            census[f][proj] += n
    summary[proj] = dict(fam)
print("\n## census (projects blocked, root sites) — driver sites excluded")
for f, c in sorted(census.items(), key=lambda kv: (-len(kv[1]), -sum(kv[1].values()))):
    print(f"  {len(c):2d} proj {sum(c.values()):6d} sites  {f:18} {TITLES.get(f, '')[:70]}  {dict(c.most_common())}")
json.dump(summary, open(f"{SD}/summary.json", "w"), indent=1)
