#!/usr/bin/env python3
"""cmp.py <nodedir> <lanedir>... : per case MATCH or the difference, with a verdict.

Round 3's cmp.py (../../real-apps-round3/harness/cmp.py) plus <case>.files (what a CLI wrote to disk, see
lane.py "collect") and a verdict per case:
  MATCH     stdout, stderr, exit code and collected files identical
  REFUSED   the lane exited differently and its stderr names a tsinter diagnostic (SC####) or fence
  CRASH     a trap, a signal (exit > 128 / 999 host throw) or a timeout (124) on the lane
  SILENT    anything else that differs: the lane exited as Node did (or with an unnamed failure) and printed
            something different. This is a bug by the trial's contract."""
import glob, os, re, sys

NAMED = re.compile(rb"SC\d{4}|not supported yet|has no lowering|refus|fence", re.I)


def rd(p, mode="rb"):
    return open(p, mode).read() if os.path.exists(p) else None


def verdict(nd, ld, b):
    o = os.path.join(ld, b)
    if not os.path.exists(o + ".exit"):
        return "MISSING", []
    diffs = []
    ne, le = rd(os.path.join(nd, b + ".exit"), "r").strip(), rd(o + ".exit", "r").strip()
    if ne != le: diffs.append(f"EXIT({ne} vs {le})")
    if rd(os.path.join(nd, b + ".out")) != rd(o + ".out"): diffs.append("STDOUT-DIFF")
    if rd(os.path.join(nd, b + ".err")) != rd(o + ".err"): diffs.append("stderr-diff")
    if rd(os.path.join(nd, b + ".files")) != rd(o + ".files"): diffs.append("FILES-DIFF")
    if not diffs:
        return "MATCH", diffs
    err = rd(o + ".err") or b""
    if le in ("124", "999") or (le.isdigit() and int(le) > 128) or b"RuntimeError" in err or b"unreachable" in err:
        return "CRASH", diffs
    if ne != le and NAMED.search(err):
        return "REFUSED", diffs
    return "SILENT", diffs


def main():
    nd = sys.argv[1]
    for ld in sys.argv[2:]:
        print("==", ld, (rd(os.path.join(ld, "build.exit"), "r") or "").strip())
        for f in sorted(glob.glob(os.path.join(nd, "*.exit"))):
            b = os.path.basename(f)[:-5]
            v, diffs = verdict(nd, ld, b)
            t = lambda d: (rd(os.path.join(d, b + ".cpu"), "r") or rd(os.path.join(d, b + ".time"), "r") or "?").strip()
            err = (rd(os.path.join(ld, b + ".err")) or b"")[:240].decode("utf8", "replace").replace("\n", " ")
            print(f"  {b:14} {v:8} {' '.join(diffs):40} t node={t(nd)} lane={t(ld)}" + (f"  err={err}" if diffs else ""))


main()
