#!/usr/bin/env python3
"""verify-downloads.py : check every app download in ~/.cache/tsinter-dl/apps against its source.

For each npm tarball: sha1 and sha512 against the registry's dist.shasum / dist.integrity, and the
sha256 recorded in SOURCE.txt when there is one. For GitHub source tarballs: the sha256 recorded in
SOURCE.txt (when none is recorded, the computed one is printed so it can be recorded). Then the
extracted package/ (and src/) trees are compared file-by-file against a fresh extraction of the
tarball, so a hand-edited cache is caught too.  Run with `python3 -I`."""
import base64, hashlib, json, os, re, subprocess, sys, tarfile, tempfile, urllib.request

D = os.path.expanduser("~/.cache/tsinter-dl/apps")
ok = True


def h(path, algo):
    m = hashlib.new(algo)
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            m.update(b)
    return m


def tree_matches(tgz, tree, strip_top):
    """every regular file in the tarball exists under tree with identical bytes"""
    bad = []
    with tarfile.open(tgz) as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            rel = m.name.split("/", 1)[1] if strip_top else m.name
            p = os.path.join(tree, rel)
            if not os.path.exists(p):
                bad.append("missing " + rel)
                continue
            if open(p, "rb").read() != t.extractfile(m).read():
                bad.append("differs " + rel)
    return bad


for app in sorted(os.listdir(D)):
    src = open(os.path.join(D, app, "SOURCE.txt")).read()
    recorded = dict((f, s) for s, f in re.findall(r"sha256: ([0-9a-f]{64})\s+(\S+)", src))
    for f in sorted(os.listdir(os.path.join(D, app))):
        p = os.path.join(D, app, f)
        if not f.endswith((".tgz", ".tar.gz")):
            continue
        s256 = h(p, "sha256").hexdigest()
        notes = []
        if f in recorded:
            notes.append("sha256 " + ("OK" if recorded[f] == s256 else "MISMATCH"))
            ok &= recorded[f] == s256
        else:
            notes.append(f"sha256 {s256} (none recorded)")
        m = re.match(r"(.+)-(\d+\.\d+\.\d+)\.tgz$", f)
        if m and "-src" not in f:
            name = re.search(r"registry\.npmjs\.org (\S+)@", src).group(1)
            meta = json.load(urllib.request.urlopen(f"https://registry.npmjs.org/{name.replace('/', '%2F')}/{m.group(2)}"))
            sha1 = h(p, "sha1").hexdigest()
            integ = "sha512-" + base64.b64encode(h(p, "sha512").digest()).decode()
            good = meta["dist"]["shasum"] == sha1 and meta["dist"]["integrity"] == integ
            notes.append(f"registry {name}@{m.group(2)} shasum+integrity " + ("OK" if good else "MISMATCH"))
            ok &= good
            bad = tree_matches(p, os.path.join(D, app, "package"), True)
        else:
            bad = tree_matches(p, os.path.join(D, app, "src"), True)
        notes.append("extracted tree " + ("OK" if not bad else f"{len(bad)} BAD: {bad[:3]}"))
        ok &= not bad
        print(f"{app:10} {f:32} " + "; ".join(notes))
print("ALL OK" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
