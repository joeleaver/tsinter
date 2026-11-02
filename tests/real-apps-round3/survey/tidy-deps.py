#!/usr/bin/env python3
"""Folds data/{npm,repo}-deps.jsonl (one line per dependency placement) into data/deps.jsonl.gz: one line per
distinct tarball with its URL, sha256 (integrity was checked against the registry at download), and which
survey targets pulled it in. Run with python3 -I from this directory."""
import gzip, json, os, sys

HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
deps = {}
for fname, who in [("npm-deps.jsonl", None), ("repo-deps.jsonl", "repo")]:
    path = os.path.join(HERE, "data", fname)
    if not os.path.exists(path):
        continue
    for line in open(path):
        d = json.loads(line)
        key = (d["name"], d["version"])
        e = deps.setdefault(key, {"name": d["name"], "version": d["version"], "url": d["url"], "sha256": d["sha256"], "repos": 0, "npm": False})
        if who == "repo":
            e["repos"] += 1
        else:
            e["npm"] = True
with gzip.GzipFile(os.path.join(HERE, "data", "deps.jsonl.gz"), "wb", mtime=0) as gz:
    for key in sorted(deps):
        gz.write((json.dumps(deps[key], separators=(",", ":")) + "\n").encode())
print(len(deps), "distinct dependency tarballs")
