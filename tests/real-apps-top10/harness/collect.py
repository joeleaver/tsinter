#!/usr/bin/env python3
"""collect.py : copy the run's small result files from WORK/res into ../results/ (nico-top; then rsync back).

  results/downloads.txt          sha256 of every download (WORK/dl/SHA256SUMS)
  results/node/<p>.txt           the Node oracle per case: exit code, stdout/stderr sizes and sha256
  results/build/<p>.wasm.log     the wasm lane's build result (diagnostics: code, location, message)
  results/build/<p>.codes.txt    diagnostic codes histogram
  results/cmp/<p>.txt            cmp.py's per-case verdicts
  results/summary.tsv            one row per project: node cases ok, build verdict, #diagnostics, run verdicts
The census (blockers.py) output is written to results/ by run-census.sh directly."""
import collections, glob, hashlib, json, os, re, shutil, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DL, RES, TOP, workloads  # noqa: E402

R = os.path.join(TOP, "results")
for d in ("node", "build", "cmp"):
    os.makedirs(os.path.join(R, d), exist_ok=True)
if os.path.exists(os.path.join(DL, "SHA256SUMS")):
    lines = sorted(set(open(os.path.join(DL, "SHA256SUMS")).read().splitlines()), key=lambda l: l.split()[-1])
    open(os.path.join(R, "downloads.txt"), "w").write(
        "# sha256  file   (codeload GitHub tarballs of the pinned commits; bun from its release SHASUMS256.txt)\n" + "\n".join(lines) + "\n")
rows = ["project\tnode_cases\tnode_exit0\twasm_build\tdiagnostics\ttop_codes\trun_verdicts"]
for p in workloads():
    nd = os.path.join(RES, p, "node")
    cases = sorted(glob.glob(os.path.join(nd, "*.exit")))
    out = []
    ok = 0
    for f in cases:
        b = f[:-5]
        rc = open(f).read().strip()
        ok += rc == "0"
        so, se = open(b + ".out", "rb").read(), open(b + ".err", "rb").read()
        out.append(f"{os.path.basename(b):16} exit={rc:4} stdout={len(so):7}B {hashlib.sha256(so).hexdigest()[:16]}  stderr={len(se):6}B {hashlib.sha256(se).hexdigest()[:16]}")
    open(os.path.join(R, "node", p + ".txt"), "w").write("\n".join(out) + "\n")
    wd = os.path.join(RES, p, "wasm")
    bl = open(os.path.join(wd, "build.log")).read() if os.path.exists(os.path.join(wd, "build.log")) else "NO BUILD LOG\n"
    open(os.path.join(R, "build", p + ".wasm.log"), "w").write(bl)
    if bl.startswith("ok"):
        verdict, nd_, codes = "builds", 0, ""
    elif bl.startswith("INTERNAL ERROR") or bl.startswith("NO BUILD LOG"):
        verdict, nd_, codes = "internal-error", 0, ""
    else:
        cs = collections.Counter(l.split(" ", 1)[0] for l in bl.splitlines() if l.strip())
        verdict, nd_ = "refuses", sum(cs.values())
        codes = " ".join(f"{c}:{n}" for c, n in cs.most_common(6))
        open(os.path.join(R, "build", p + ".codes.txt"), "w").write("\n".join(f"{n:6d} {c}" for c, n in cs.most_common()) + "\n")
    cmpf = os.path.join(RES, p, "cmp.txt")
    runs = ""
    if os.path.exists(cmpf):
        shutil.copyfile(cmpf, os.path.join(R, "cmp", p + ".txt"))
        if verdict == "builds":
            vs = collections.Counter(m.group(1) for m in re.finditer(r"^  \S+\s+(MATCH|REFUSED|CRASH|SILENT|MISSING)", open(cmpf).read(), re.M))
            runs = " ".join(f"{k}:{n}" for k, n in vs.items())
    rows.append(f"{p}\t{len(cases)}\t{ok}\t{verdict}\t{nd_}\t{codes}\t{runs}")
open(os.path.join(R, "summary.tsv"), "w").write("\n".join(rows) + "\n")
print("\n".join(rows))
