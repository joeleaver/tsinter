#!/usr/bin/env python3
"""perf.py [reps=3] [cpu=23] : chess.js CPU time (user+sys of the child), Node on the unpatched source,
Node on the minimally patched source (chess-min, the same source the lanes compile) and the wasm-native
binary of chess-min (built by lane.py into WORK/res/chess-min/wn/prog.bin). Every run is pinned to one
core with taskset; the three subjects are interleaved inside each repetition; median of reps.
Run it inside a memory cap. Raw rows go to WORK/res/perf-raw.txt; the table to stdout."""
import os, resource, statistics, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import APPS, NODE, WORK

reps = int(sys.argv[1]) if len(sys.argv) > 1 else 3
cpu = sys.argv[2] if len(sys.argv) > 2 else "23"
KIWI = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
W = [("startup (`bogus`, exit 2)", ["bogus"]), ("play 1 300", ["play", "1", "300"]), ("fuzztext 1 1500", ["fuzztext", "1", "1500"]),
     ("perft 5 (4.87M nodes)", ["perft", "5"]), ("perft 4 kiwipete", ["perft", "4", KIWI]), ("fuzz 1 60 (verbose moves, SAN, undo)", ["fuzz", "1", "60"])]
NODEARGS = [NODE, "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "main.ts"]
S = [("node-orig", f"{APPS}/chess", NODEARGS), ("node-patched", f"{APPS}/chess-min", NODEARGS),
     ("wn", f"{APPS}/chess-min", [f"{WORK}/res/chess-min/wn/prog.bin"])]
res = {}
raw = open(f"{WORK}/res/perf-raw.txt", "w")
for r in range(reps):
    for wname, args in W:
        outs = {}
        for sname, cwd, cmd in S:
            b = resource.getrusage(resource.RUSAGE_CHILDREN)
            p = subprocess.run(["taskset", "-c", cpu] + cmd + args, cwd=cwd, capture_output=True)
            a = resource.getrusage(resource.RUSAGE_CHILDREN)
            t = (a.ru_utime - b.ru_utime) + (a.ru_stime - b.ru_stime)
            res.setdefault((wname, sname), []).append(t)
            outs[sname] = (p.returncode, p.stdout)
            raw.write(f"rep{r} {wname} | {sname} cpu={t:.3f} rc={p.returncode} maxrss_children={a.ru_maxrss}KB\n")
            raw.flush()
        same = len(set(outs.values())) == 1
        raw.write(f"rep{r} {wname} | outputs identical: {same}\n")
print("| workload | Node, original src (bigint keys) | Node, patched src (same as compiled) | wasm-native | wn / Node-patched |")
print("|---|---|---|---|---|")
for wname, _ in W:
    m = {s: statistics.median(res[(wname, s)]) for s, _, _ in S}
    ratio = f"{m['wn'] / m['node-patched']:.2f}×" if m["node-patched"] > 0 else "—"
    print(f"| {wname} | {m['node-orig']:.2f} | {m['node-patched']:.2f} | {m['wn']:.2f} | {ratio} |")
