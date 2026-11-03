#!/usr/bin/env python3
"""blockers.py [app...] : the refusal census of each unpatched app, by the survey's families.

For each app: sites.mjs (analyze(), lowered as the WasmGC lanes lower) lists every reached root
refusal site — compile diagnostics (D) and deferred runtime fences (F). Each site is classified with
tests/real-apps-round3/survey/families.py; cascades (sites that only repeat a blocker reported
elsewhere) are dropped, as are sites in the trial's own driver file. Writes WORK/res/sites/<app>.json
and prints, per app, family -> root-site count with an example, plus the census over all apps.
Run with `python3 -I` (one analyze() at a time, inside a memory cap)."""
import collections, json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, NODE, WORK

sys.path.insert(0, os.path.join(HERE, "..", "survey"))
from families import TITLES, classify  # noqa: E402

CAP = ["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=16G", "-p", "MemorySwapMax=0"]
APPS = ["chess", "toml", "papa", "polka", "expr", "marked", "markedlib", "diff", "semver"]
want = sys.argv[1:] or APPS
os.makedirs(f"{WORK}/res/sites", exist_ok=True)
census = collections.defaultdict(collections.Counter)
for app in want:
    spec = json.load(open(f"{WORK}/specs/{app}.json"))
    out = f"{WORK}/res/sites/{app}.json"
    p = subprocess.run(CAP + [NODE, os.path.join(HERE, "sites.mjs"), spec["entry"], ",".join(spec.get("npmStatic", []))],
                       cwd=spec["cwd"], capture_output=True)
    if p.returncode != 0:
        print(f"## {app}: sites.mjs failed: {p.stderr.decode()[-400:]}")
        continue
    open(out, "wb").write(p.stdout)
    sites = json.loads(p.stdout)
    fam = collections.Counter()
    ex = {}
    seen = set()
    driver = os.path.realpath(spec["entry"])
    for s in sites:
        f = classify(s["code"], s["message"], s["shape"])
        if f is None:
            continue
        key = (s["file"], s["line"], s["col"], s["message"])
        if key in seen:
            continue
        seen.add(key)
        if os.path.realpath(s["file"]) == driver:
            f = "driver:" + f
        fam[f] += 1
        ex.setdefault(f, f"{s['kind']} {s['code']} {os.path.relpath(s['file'], spec['cwd'])}:{s['line']} {s['src'][:80]} -- {s['message'][:110]}")
    print(f"## {app}: {sum(fam.values())} root sites ({len(sites)} reached, cascades included)")
    for f, n in fam.most_common():
        print(f"  {n:4d} {f:18} e.g. {ex[f]}")
        if not f.startswith("driver:"):
            census[f][app] += n
print("\n## census (apps, root sites) — driver sites excluded")
for f, c in sorted(census.items(), key=lambda kv: (-len(kv[1]), -sum(kv[1].values()))):
    print(f"  {len(c)} apps {sum(c.values()):4d} sites  {f:18} {TITLES.get(f, '')[:70]}  {dict(c.most_common())}")
