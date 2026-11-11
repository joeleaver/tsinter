#!/usr/bin/env python3
"""lane.py <project> <lane: node|wasm|wn> : run one project's workload on one lane (nico-top only).

Round 3's lane.py (../../real-apps-round3/harness/lane.py), adapted:
  - the spec comes from workloads.json: {cwd, entry, nodeEntry?, npmStatic?, dynamic?, timeout?, cases:[{name,args,stdin?}]}
    with cwd/entry relative to WORK/src/<project>/; drivers named "@drivers/x" are copied from ../drivers/ into
    WORK/src/<project>/<driverDir>/ (default .top10/) first, so they resolve the project's modules.
  - node  runs nodeEntry (default entry) under Node with node-src-loader.mjs (the project's own source, run
          the way its dev runner runs it).
  - wasm  compile({backend: "wasm"}) + run in-process through a copy of tests/harness/wasm-differential.test.ts
          (argv hook) + this directory's realprobe-tail.ts.txt, written to tests/harness/zz-realprobe.test.ts
          for the run and removed afterwards (never commit it).
  - wn    `tsinter build --backend wasm-native` and run the binary.
  - every lane gets the same environment (ENV below plus HOME = a fresh WORK/home/<project>/), so a CLI that
    reads or writes its config dir sees the same state; cases run in order.
Writes WORK/res/<project>/<lane>/<case>.{out,err,exit,cpu|time,wall} + build.log/build.exit/build.json."""
import json, os, resource, shutil, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CLI, DRIVERS, HERE, LOADER, NODE, REPO, RES, SRC, WORK, workloads  # noqa: E402

proj, lane = sys.argv[1], sys.argv[2]
W = workloads()[proj]
root = os.path.join(SRC, proj)
out = os.path.join(RES, proj, lane)
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out, exist_ok=True)
TO = W.get("timeout", 600)
cwd = os.path.join(root, W.get("cwd", "."))
home = os.path.join(WORK, "home", proj)


def place(e):
    if not e.startswith("@drivers/"):
        return os.path.join(root, e)
    ddir = os.path.join(root, W.get("driverDir", ".top10"))
    os.makedirs(ddir, exist_ok=True)
    src = os.path.join(DRIVERS, e[len("@drivers/"):])
    dst = os.path.join(ddir, os.path.basename(src.rstrip("/")))
    if os.path.isdir(src):
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst)
    else:
        shutil.copyfile(src, dst)
    return dst


entry = place(W["entry"])
node_entry = place(W["nodeEntry"]) if W.get("nodeEntry") else entry
for extra in W.get("driverFiles", []):
    place(extra)

ENV = {"PATH": os.path.dirname(NODE) + ":/usr/bin:/bin", "HOME": home, "TERM": "dumb", "NO_COLOR": "1", "CI": "1",
       "TZ": "UTC", "LANG": "C.UTF-8", "COLUMNS": "100", "LINES": "40"}
ENV.update(W.get("env", {}))


def fresh_home():
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home, exist_ok=True)


def cpu():
    r = resource.getrusage(resource.RUSAGE_CHILDREN)
    return r.ru_utime + r.ru_stime


def run_case(cmd, c):
    clean(c)
    stdin = open(os.path.join(cwd, c["stdin"]), "rb") if c.get("stdin") else subprocess.DEVNULL
    c0 = cpu(); t0 = time.time()
    try:
        p = subprocess.run(cmd + c["args"], cwd=cwd, stdin=stdin, capture_output=True, timeout=TO, env=ENV)
        so, se, rc = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        so, se, rc = e.stdout or b"", (e.stderr or b"") + b"\n[TIMEOUT]\n", 124
    b = os.path.join(out, c["name"])
    collect(c, b)
    open(b + ".out", "wb").write(so)
    open(b + ".err", "wb").write(se)
    open(b + ".exit", "w").write(f"{rc}\n")
    open(b + ".cpu", "w").write(f"{cpu() - c0:.3f}\n")
    open(b + ".wall", "w").write(f"{time.time() - t0:.3f}\n")


def collect(c, b):
    """case "collect": [paths relative to cwd] -> <case>.files (each file's path and bytes, or MISSING), so a
    CLI that writes its result to disk is compared on what it wrote; "clean" paths are removed before a run."""
    parts = []
    for rel in c.get("collect", []):
        f = os.path.join(cwd, rel)
        parts.append(f"=== {rel}\n".encode() + (open(f, "rb").read() if os.path.isfile(f) else b"MISSING\n"))
    if parts:
        open(b + ".files", "wb").write(b"".join(parts))


def clean(c):
    for rel in c.get("clean", []):
        f = os.path.join(cwd, rel)
        shutil.rmtree(f, ignore_errors=True) if os.path.isdir(f) else (os.path.exists(f) and os.remove(f))


def make_probe():
    src = open(os.path.join(REPO, "tests/harness/wasm-differential.test.ts")).read()
    hook = 'const argv: readonly string[] = ["scriptc", modulePath];'
    assert src.count(hook) == 1, "argv hook site moved"
    src = src.replace(hook, 'const argv: readonly string[] = ["scriptc", modulePath, ...(((globalThis as any).__probeArgv as string[] | undefined) ?? [])];')
    p = os.path.join(REPO, "tests/harness/zz-realprobe.test.ts")
    open(p, "w").write(src + "\n" + open(os.path.join(HERE, "realprobe-tail.ts.txt")).read())
    return p


npm_static = W.get("npmStatic", "auto")
fresh_home()
if lane in ("node", "node2"):  # node2: a second oracle run, to check the workload is deterministic
    for c in W["cases"]:
        loader = "file://" + LOADER + ("?full=1" if W.get("nodeEmit") == "full" else "")
        run_case([NODE, "--import", loader, "--stack-size=" + str(W.get("nodeStack", 984)), node_entry], c)
elif lane == "wn":
    binp = os.path.join(out, "prog.bin")
    flags = []
    if W.get("dynamic"): flags.append("--dynamic")
    if npm_static: flags += ["--npm-static", npm_static if isinstance(npm_static, str) else ",".join(npm_static)]
    t0 = time.time()
    try:
        heap = [f"--max-old-space-size={os.environ['SURVEY_HEAP_MB']}"] if os.environ.get("SURVEY_HEAP_MB") else []
        p = subprocess.run([NODE] + heap + [CLI, "build", entry, "--backend", "wasm-native", "-o", binp] + flags,
                           cwd=cwd, capture_output=True, env=dict(os.environ), timeout=3600)
        log, rc = p.stdout + p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        log, rc = (e.stdout or b"") + (e.stderr or b"") + b"\n[BUILD TIMEOUT]\n", 124
    open(os.path.join(out, "build.log"), "wb").write(log)
    open(os.path.join(out, "build.exit"), "w").write(f"{rc} {time.time() - t0:.0f}s\n")
    if rc != 0:
        print(f"BUILD FAILED rc={rc}"); sys.exit(1)
    fresh_home()
    for c in W["cases"]:
        run_case([binp], c)
elif lane == "wasm":
    ps = {"entry": entry, "cwd": cwd, "outDir": out, "dynamic": W.get("dynamic", False), "npmStatic": npm_static or None,
          "env": ENV, "cases": [dict(c, stdin=os.path.join(cwd, c["stdin"])) if c.get("stdin") else c for c in W["cases"]]}
    pj = os.path.join(out, "probe.json"); json.dump(ps, open(pj, "w"))
    e = dict(os.environ); e["PROBE_SPEC"] = pj
    if os.environ.get("SURVEY_HEAP_MB"):  # the vitest worker (a forked child) gets Node's default heap otherwise
        e["NODE_OPTIONS"] = f"--max-old-space-size={os.environ['SURVEY_HEAP_MB']}"
    probe = make_probe()
    t0 = time.time()
    try:
        p = subprocess.run([os.path.join(REPO, "node_modules/.bin/vitest"), "run", "tests/harness/zz-realprobe.test.ts", "-t", "realprobe"],
                           cwd=REPO, capture_output=True, env=e, timeout=7200)
        vlog = p.stdout + p.stderr
    except subprocess.TimeoutExpired as ex:
        vlog = (ex.stdout or b"") + (ex.stderr or b"") + b"\n[VITEST TIMEOUT]\n"
    finally:
        os.remove(probe)
    open(os.path.join(out, "vitest.log"), "wb").write(vlog)
    bl = open(os.path.join(out, "build.log")).read() if os.path.exists(os.path.join(out, "build.log")) else "NO BUILD LOG"
    if bl.startswith("ok"):
        for c in W["cases"]:
            if c.get("collect"):
                print(f"note: {c['name']} collect on the wasm lane reads the files after ALL cases ran (cases run in-process)")
                collect(c, os.path.join(out, c["name"]))
    open(os.path.join(out, "build.exit"), "w").write(("0" if bl.startswith("ok") else "1") + f" {time.time() - t0:.0f}s\n")
    if not bl.startswith("ok"):
        print("BUILD FAILED" + ("" if bl != "NO BUILD LOG" else " (no build log; see vitest.log)")); sys.exit(1)
else:
    sys.exit("bad lane")
print("done", proj, lane, out)
