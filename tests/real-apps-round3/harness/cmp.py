#!/usr/bin/env python3
"""cmp.py <nodedir> <lanedir>... : per case MATCH / diffs"""
import os, sys, glob
nd = sys.argv[1]
def rd(p, mode="rb"):
    return open(p, mode).read() if os.path.exists(p) else None
for ld in sys.argv[2:]:
    print("==", ld, (rd(os.path.join(ld, "build.exit"), "r") or "").strip())
    for f in sorted(glob.glob(os.path.join(nd, "*.exit"))):
        b = os.path.basename(f)[:-5]
        o = os.path.join(ld, b)
        if not os.path.exists(o + ".exit"):
            print(f"  {b:14} MISSING"); continue
        st = []
        if rd(f) != rd(o + ".exit"): st.append(f"EXIT({rd(f,'r').strip()} vs {rd(o+'.exit','r').strip()})")
        if rd(os.path.join(nd, b + ".out")) != rd(o + ".out"): st.append("STDOUT-DIFF")
        if rd(os.path.join(nd, b + ".err")) != rd(o + ".err"): st.append("stderr-diff")
        cpu = lambda d: (rd(os.path.join(d, b + ".cpu"), "r") or rd(os.path.join(d, b + ".time"), "r") or "?").strip()
        err = (rd(o + ".err") or b"")[:200].decode("utf8", "replace").replace("\n", " ")
        print(f"  {b:14} {' '.join(st) or 'MATCH':30} cpu node={cpu(nd)} lane={cpu(ld)}" + (f"  err={err}" if st else ""))
