#!/usr/bin/env python3
"""check-repros.py <file>... : run each single-file repro under Node and on both lanes (via lane.py, one
lane at a time, each in a 16 GB memory cap) and classify it:
  MATCH     builds, same exit and stdout as Node
  SILENT    builds, same exit status as Node, different stdout   (a silent divergence)
  LOUD      builds, exits differently (a named runtime refusal or trap)
  REFUSED   the build refuses (named diagnostic)
Outputs under WORK/res/repros/<name>/{node,wn,wasm}."""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, WORK

CAP = ["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=16G", "-p", "MemorySwapMax=0"]


def rd(p):
    return open(p, "rb").read() if os.path.exists(p) else None


for f in sys.argv[1:]:
    f = os.path.abspath(f)
    name = os.path.basename(f).rsplit(".", 1)[0]
    o = os.path.join(WORK, "res", "repros", name)
    os.makedirs(o, exist_ok=True)
    spec = os.path.join(o, "spec.json")
    json.dump({"entry": f, "cwd": os.path.dirname(f), "timeout": 120, "cases": [{"name": "run", "args": []}]}, open(spec, "w"))
    res = []
    for lane in ["node", "wn", "wasm"]:
        subprocess.run(CAP + ["python3", "-I", os.path.join(HERE, "lane.py"), spec, lane, os.path.join(o, lane)], capture_output=True)
        if lane == "node":
            continue
        d = os.path.join(o, lane)
        if not (rd(os.path.join(d, "build.exit")) or b"1").startswith(b"0"):
            res.append(f"{lane}=REFUSED")
        elif rd(os.path.join(d, "run.exit")) != rd(os.path.join(o, "node", "run.exit")):
            res.append(f"{lane}=LOUD")
        elif rd(os.path.join(d, "run.out")) != rd(os.path.join(o, "node", "run.out")):
            res.append(f"{lane}=SILENT")
        else:
            res.append(f"{lane}=MATCH")
    print(f"{os.path.relpath(f)}: {' '.join(res)}")
