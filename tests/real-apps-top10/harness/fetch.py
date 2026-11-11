#!/usr/bin/env python3
"""fetch.py [name...] : download, verify, extract and install the selected projects (nico-top only).

Per project (projects.json):
  1. codeload tar.gz of the pinned commit -> WORK/dl/<name>-<sha12>.tar.gz; its sha256 goes to
     WORK/dl/SHA256SUMS and must equal the one recorded in results/downloads.txt when one is recorded.
  2. extracted to WORK/src/<name>/ (first path component stripped).
  3. dependencies installed from the project's own lockfile with lifecycle scripts OFF:
       npm   npm ci --ignore-scripts --no-audit --no-fund
       pnpm  corepack pnpm@<v> install --frozen-lockfile --ignore-scripts [--filter ...]
       bun   bun install --frozen-lockfile --ignore-scripts (bun from WORK/tools, SHASUMS256-checked)
     npm ci / pnpm --frozen-lockfile / bun --frozen-lockfile verify every tarball against the lockfile's
     integrity hashes and refuse a lockfile that does not match package.json.
No project script (build, install, prepare, postinstall, ...) is ever run. Logs: WORK/src/<name>.install.log."""
import hashlib, os, subprocess, sys, tarfile, urllib.request, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DL, SRC, TOP, WORK, projects  # noqa: E402

RECORD = os.path.join(TOP, "results", "downloads.txt")
TOOLS = os.path.join(WORK, "tools")
BUN = {"1.4.4": None}  # version -> expected zip sha256 is read from the release's SHASUMS256.txt


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def recorded():
    r = {}
    if os.path.exists(RECORD):
        for line in open(RECORD):
            parts = line.split()
            if len(parts) >= 2 and not line.startswith("#"):
                r[parts[1]] = parts[0]
    return r


def get(url, dst):
    if not os.path.exists(dst):
        tmp = dst + ".part"
        print(f"  download {url}", flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": "tsinter-real-apps-harness"})
        with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
            while b := r.read(1 << 20):
                f.write(b)
        os.rename(tmp, dst)
    return sha256(dst)


def bun(version):
    d = os.path.join(TOOLS, f"bun-{version}")
    exe = os.path.join(d, "bun-linux-x64", "bun")
    if os.path.exists(exe):
        return exe
    os.makedirs(d, exist_ok=True)
    base = f"https://github.com/oven-sh/bun/releases/download/bun-v{version}"
    sums = os.path.join(d, "SHASUMS256.txt")
    get(base + "/SHASUMS256.txt", sums)
    want = [l.split()[0] for l in open(sums) if l.strip().endswith("bun-linux-x64.zip")]
    z = os.path.join(d, "bun-linux-x64.zip")
    got = get(base + "/bun-linux-x64.zip", z)
    assert want and want[0] == got, f"bun zip sha256 mismatch: {got} vs {want}"
    with open(os.path.join(DL, "SHA256SUMS"), "a") as f:
        f.write(f"{got}  bun-{version}-linux-x64.zip\n")
    zipfile.ZipFile(z).extractall(d)
    os.chmod(exe, 0o755)
    return exe


def install(p, root):
    pm = p["pm"]
    env = dict(os.environ, COREPACK_ENABLE_DOWNLOAD_PROMPT="0", CI="1", HUSKY="0", npm_config_ignore_scripts="true")
    if pm == "npm":
        cmd = ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"] + p.get("installFlags", [])
    elif pm.startswith("pnpm@"):
        cmd = ["corepack", pm, "install", "--frozen-lockfile", "--ignore-scripts", "--config.confirmModulesPurge=false"]
        for f in p.get("filter", []):
            cmd += ["--filter", f]
        cmd += p.get("installFlags", [])
    elif pm.startswith("bun@"):
        cmd = [bun(pm[4:]), "install", "--frozen-lockfile", "--ignore-scripts"]
    else:
        sys.exit(f"unknown pm {pm}")
    log = os.path.join(SRC, p["name"] + ".install.log")
    print("  " + " ".join(cmd), flush=True)
    with open(log, "wb") as f:
        r = subprocess.run(cmd, cwd=root, env=env, stdout=f, stderr=subprocess.STDOUT)
    print(f"  install exit {r.returncode} (log {log})", flush=True)
    return r.returncode


def main():
    want = sys.argv[1:]
    os.makedirs(DL, exist_ok=True)
    os.makedirs(SRC, exist_ok=True)
    rec = recorded()
    for p in projects():
        if want and p["name"] not in want:
            continue
        name, sha = p["name"], p["sha"]
        print(f"== {name} {p['repo']}@{sha[:12]}", flush=True)
        fn = f"{name}-{sha[:12]}.tar.gz"
        tgz = os.path.join(DL, fn)
        h = get(f"https://codeload.github.com/{p['repo']}/tar.gz/{sha}", tgz)
        if fn in rec and rec[fn] != h:
            sys.exit(f"  SHA256 MISMATCH for {fn}: {h} vs recorded {rec[fn]}")
        print(f"  sha256 {h}  {fn}" + ("  (matches record)" if fn in rec else "  (new)"), flush=True)
        sums = os.path.join(DL, "SHA256SUMS")
        lines = open(sums).read().splitlines() if os.path.exists(sums) else []
        if f"{h}  {fn}" not in lines:
            open(sums, "a").write(f"{h}  {fn}\n")
        root = os.path.join(SRC, name)
        mark = os.path.join(root, ".top10-extracted")
        if not os.path.exists(mark):
            os.makedirs(root, exist_ok=True)
            with tarfile.open(tgz) as t:
                for m in t.getmembers():
                    parts = m.name.split("/", 1)
                    if len(parts) < 2 or not parts[1]:
                        continue
                    m.name = parts[1]
                    if m.issym() or m.islnk():
                        if m.linkname.startswith("/") or ".." in m.linkname.split("/") and m.islnk():
                            continue
                    t.extract(m, root, filter="data")
            open(mark, "w").write(sha + "\n")
        if not os.path.exists(os.path.join(root, ".top10-installed")):
            if install(p, root) == 0:
                open(os.path.join(root, ".top10-installed"), "w").write("ok\n")


main()
