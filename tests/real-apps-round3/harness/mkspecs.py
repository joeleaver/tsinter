#!/usr/bin/env python3
"""mkspecs.py : write WORK/specs/*.json (the per-app case lists lane.py runs)."""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import APPS as R, WORK

os.makedirs(WORK + "/specs", exist_ok=True)


def dump(name, d):
    json.dump(d, open(f"{WORK}/specs/{name}.json", "w"), indent=1)


KIWI = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"


def chess(d):
    return {"entry": f"{R}/{d}/main.ts", "cwd": f"{R}/{d}", "cases": [
        {"name": "perft4", "args": ["perft", "4"]},
        {"name": "kiwipete", "args": ["perft", "3", KIWI]},
        {"name": "pgn", "args": ["pgn", "bench.pgn", "200"]},
        {"name": "play1", "args": ["play", "1", "300"]},
        {"name": "play42", "args": ["play", "42", "300"]},
        {"name": "usage", "args": ["bogus"]},
        {"name": "fuzz1", "args": ["fuzz", "1", "100"]},
        {"name": "fuzz7", "args": ["fuzz", "7", "100"]},
        {"name": "fuzz99", "args": ["fuzz", "99", "100"]}]}


for d in ["chess", "chess-v", "chess-min"]:
    dump(d, chess(d))
# the round-2 fuzz workloads (text fuzz + game fuzz) and deep perft, on any chess dir
for d in ["chess-v", "chess-min"]:
    s = chess(d)
    s["cases"] = [{"name": f"text{k}", "args": ["fuzztext", str(k), "1500"]} for k in (1, 2, 3, 4)] + [
        {"name": f"fuzzg{k}", "args": ["fuzz", str(k), "60"]} for k in (5, 11, 23, 12345)]
    dump(d + "-fuzz", s)
    s = chess(d)
    s["cases"] = [
        {"name": "perft5", "args": ["perft", "5"]},
        {"name": "kiwi4", "args": ["perft", "4", KIWI]},
        {"name": "pos3", "args": ["perft", "5", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"]},
        {"name": "pos4", "args": ["perft", "4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1"]},
        {"name": "pos5", "args": ["perft", "4", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8"]},
        {"name": "fuzzbig", "args": ["fuzz", "12345", "250"]}]
    dump(d + "-deep", s)

dump("toml", {"entry": f"{R}/toml/main.ts", "cwd": f"{R}/toml", "cases": [
    {"name": "spec-json", "args": ["json", "work/toml-spec-example.toml"]},
    {"name": "spec-rt", "args": ["roundtrip", "work/toml-spec-example.toml"]},
    {"name": "mise-json", "args": ["json", "work/mise.toml"]},
    {"name": "big-stats", "args": ["stats", "work/big.toml"]},
    {"name": "big-rt", "args": ["roundtrip", "work/big.toml"]},
    {"name": "errors", "args": ["errors"]},
    {"name": "missing", "args": ["json", "work/nope.toml"]}]})

dump("papa", {"entry": f"{R}/papa/main.mjs", "cwd": f"{R}/papa", "npmStatic": ["papaparse"], "cases": [
    {"name": "header", "args": ["work/sample-header.csv", "--header"]},
    {"name": "long", "args": ["work/long-sample.csv", "--dynamic-typing"]},
    {"name": "verylong", "args": ["work/verylong-sample.csv", "--header", "--dynamic-typing"]},
    {"name": "bom", "args": ["work/utf-8-bom-sample.csv", "--header"]},
    {"name": "unparse", "args": ["unparse"]}]})

dump("polka", {"entry": f"{R}/polka/main.mjs", "cwd": f"{R}/polka", "npmStatic": ["polka", "trouter", "matchit", "@polka/url", "@arr/every"],
               "cases": [{"name": "api", "args": []}]})

dump("expr", {"entry": f"{R}/expr/main.mjs", "cwd": f"{R}/expr", "npmStatic": ["expr-eval"], "cases": [{"name": "builtin", "args": []}]})

dump("marked", {"entry": f"{R}/marked/bin/marked.js", "cwd": f"{R}/marked", "cases": [
    {"name": "doc", "args": ["-i", "work/doc.md"]},
    {"name": "readme", "args": ["-i", "work/readme.md"]},
    {"name": "string", "args": ["--gfm", "-s", "**hi** _there_ <b>x</b>"]},
    {"name": "tokens", "args": ["-t", "-i", "work/readme.md"]},
    {"name": "nogfm", "args": ["--no-gfm", "--breaks", "-i", "work/doc.md"]},
    {"name": "missing", "args": ["-i", "work/missing.md"]},
    {"name": "version", "args": ["--version"]},
    {"name": "positional", "args": ["work/doc.md"]}]})

dump("markedlib", {"entry": f"{R}/markedlib/main.ts", "cwd": f"{R}/markedlib", "npmStatic": ["marked"], "cases": [
    {"name": "doc", "args": ["work/doc.md"]},
    {"name": "readme", "args": ["work/readme.md"]},
    {"name": "tokens", "args": ["work/doc.md", "--tokens"]},
    {"name": "nogfm", "args": ["work/doc.md", "--no-gfm"]}]})

dump("diff", {"entry": f"{R}/diff/main.ts", "cwd": f"{R}/diff", "cases": [
    {"name": "toml", "args": ["files", "work/a.toml", "work/b.toml"]},
    {"name": "chess", "args": ["files", "work/a.ts", "work/b.ts"]},
    {"name": "words", "args": ["words", "the quick brown fox", "the slow brown dog"]},
    {"name": "chars", "args": ["chars", "kitten sitting", "sitting kitten"]},
    {"name": "fuzz1", "args": ["fuzz", "1", "300"]},
    {"name": "usage", "args": []}]})

for d in ["semver", "semver-p"]:  # semver-p: semver-patch.py's hoisted-require variant
    dump(d, {"entry": f"{R}/{d}/main.cjs", "cwd": f"{R}/{d}", "cases": [
        {"name": "table", "args": ["table"]},
        {"name": "fuzz3", "args": ["fuzz", "3", "500"]},
        {"name": "resolve", "args": ["resolve", "deps.txt"]},
        {"name": "usage", "args": []}]})
print("specs in", WORK + "/specs")
