#!/usr/bin/env python3
"""semver-patch.py [skip,cats|none] : WORK/apps/semver-p = setup-apps.py's semver + Node-preserving trial patches
(round 2's: hoist the bottom-of-file require block of the two cycle classes)."""
import os, re, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import APPS, DL
R = APPS + "/semver-p"
SRC = DL + "/semver/package"
skip = set(sys.argv[1].split(",")) if len(sys.argv) > 1 and sys.argv[1] != "none" else set()
on = lambda c: c not in skip
shutil.rmtree(R, ignore_errors=True)
shutil.copytree(APPS + "/semver", R)
shutil.rmtree(R + "/lib", ignore_errors=True)
shutil.copytree(SRC, R + "/lib")
os.remove(R + "/lib/package.json")
log = []


def edit(f, cat, fn):
    if not on(cat): return
    p = f"{R}/lib/{f}"
    s = open(p).read(); t = fn(s)
    if s == t: log.append(f"NOOP {cat} {f}")
    open(p, "w").write(t)
    log.append(f"{cat}:{f}")


def hoist_requires(s, keep_out=()):
    """move the trailing block of top-level `const x = require(...)` statements to the top of the file"""
    lines = s.split("\n")
    # find module.exports = class line; requires after the class body end at file bottom
    req = []
    out = []
    i = 0
    while i < len(lines):
        L = lines[i]
        if re.match(r"^const .*require\(", L) or (re.match(r"^const \{$", L)):
            blk = [L]
            while not re.search(r"require\([^)]*\)\s*$", blk[-1]):
                i += 1; blk.append(lines[i])
            if any(k in "\n".join(blk) for k in keep_out):
                pass  # dropped
            else:
                req += blk
        else:
            out.append(L)
        i += 1
    return "\n".join(req + out)

# CJS cycle idiom: `module.exports = class X {}` followed by requires at the bottom (SC1013)
edit("classes/comparator.js", "bottomrequire", lambda s: hoist_requires(s, keep_out=("require('./range')",)).replace("new Range(", "new (require('./range'))("))
edit("classes/range.js", "bottomrequire", lambda s: hoist_requires(s))
print(" | ".join(log))
