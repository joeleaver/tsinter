#!/usr/bin/env python3
"""One table across both strata (the README's ranked list): packages affected and sites per family.
For stratum B, families seen only in the past-gate pass are counted separately. python3 -I joint.py"""
import collections, os, sys

HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
sys.argv = [sys.argv[0], "npm"]
sys.path.insert(0, HERE)
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("report", os.path.join(HERE, "report.py"))
src = open(os.path.join(HERE, "report.py")).read().replace("\nmain()\n", "\n")
mod = {"__name__": "report_lib", "__file__": os.path.join(HERE, "report.py")}
exec(compile(src, "report.py", "exec"), mod)
TITLES = mod["TITLES"]

rows = collections.defaultdict(lambda: {"a": 0, "a_sites": 0, "b": 0, "b_gate": 0, "b_sites": 0, "a_hard": 0})
na = nb = 0
for stratum in ["npm", "repo"]:
    for p in mod["load"](stratum):
        p = mod["analyze_pkg"](p)
        if p["verdict"] == "no-result":
            continue
        if stratum == "npm":
            na += 1
        else:
            nb += 1
        for f, e in p["fams"].items():
            r = rows[f]
            if stratum == "npm":
                r["a"] += 1
                r["a_sites"] += e["sites"]
                r["a_hard"] += 1 if e["hard"] else 0
            else:
                if e["nongate"] or e["hard"]:
                    r["b"] += 1
                else:
                    r["b_gate"] += 1
                r["b_sites"] += e["sites"]
print(f"A = {na} npm packages, B = {nb} TypeScript repos\n")
print("| family | A pkgs | A % | A sites | B repos | B % | + B past-gate only | B sites |")
print("|---|---|---|---|---|---|---|---|")
for f, r in sorted(rows.items(), key=lambda kv: -(kv[1]["a"] / na + kv[1]["b"] / nb)):
    print(f"| `{f}` {TITLES.get(f, 'import of an npm package not compiled statically' if f == 'dep-edge' else f)[:80]} | {r['a']} | {100 * r['a'] / na:.0f}% | {r['a_sites']} | "
          f"{r['b']} | {100 * r['b'] / nb:.0f}% | {r['b_gate']} | {r['b_sites']} |")
