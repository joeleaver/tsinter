#!/usr/bin/env python3
"""lane.py <spec.json> <lane: node|wn|wasm> <outdir> [--no-build]
spec: {entry, cwd, dynamic?, npmStatic?, timeout?, cases:[{name,args,stdin?}]}
Writes <outdir>/<case>.{out,err,exit,cpu} and build.log/build.exit."""
import json, os, resource, subprocess, sys, time

W = "/home/joe/dev/tsinter/.claude/worktrees/agent-a16bf40c249d36838"
NODE = os.path.expanduser("~/.nvm/versions/node/v24.18.1/bin/node")
ENV = dict(os.environ)
ENV["PATH"] = os.path.dirname(NODE) + ":" + ENV["PATH"]
ENV["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
ENV["SCRIPTC_TEST_WORKERS"] = "4"

spec_path, lane, out = sys.argv[1], sys.argv[2], os.path.abspath(sys.argv[3])
nobuild = "--no-build" in sys.argv
spec = json.load(open(spec_path))
os.makedirs(out, exist_ok=True)
TO = spec.get("timeout", 600)


def cpu():
    r = resource.getrusage(resource.RUSAGE_CHILDREN)
    return r.ru_utime + r.ru_stime


def run_case(cmd, c):
    stdin = open(os.path.join(spec["cwd"], c["stdin"]), "rb") if c.get("stdin") else subprocess.DEVNULL
    c0 = cpu(); t0 = time.time()
    try:
        p = subprocess.run(cmd + c["args"], cwd=spec["cwd"], stdin=stdin, capture_output=True, timeout=TO, env=ENV)
        so, se, rc = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        so, se, rc = e.stdout or b"", (e.stderr or b"") + b"\n[TIMEOUT]\n", 124
    b = os.path.join(out, c["name"])
    open(b + ".out", "wb").write(so)
    open(b + ".err", "wb").write(se)
    open(b + ".exit", "w").write(f"{rc}\n")
    open(b + ".cpu", "w").write(f"{cpu() - c0:.3f}\n")
    open(b + ".wall", "w").write(f"{time.time() - t0:.3f}\n")


if lane == "node":
    for c in spec["cases"]:
        run_case([NODE, "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--stack-size=" + str(spec.get("nodeStack", 984)), spec["entry"]], c)
elif lane == "wn":
    binp = os.path.join(out, "prog.bin")
    if not nobuild:
        flags = []
        if spec.get("dynamic"): flags.append("--dynamic")
        for n in spec.get("npmStatic", []): flags += ["--npm-static", n]
        t0 = time.time()
        p = subprocess.run([NODE, W + "/packages/cli/dist/main.js", "build", spec["entry"], "--backend", "wasm-native", "-o", binp] + flags,
                           cwd=spec["cwd"], capture_output=True, env=ENV)
        open(os.path.join(out, "build.log"), "wb").write(p.stdout + p.stderr)
        open(os.path.join(out, "build.exit"), "w").write(f"{p.returncode} {time.time() - t0:.0f}s\n")
        if p.returncode != 0:
            print(f"BUILD FAILED rc={p.returncode}"); sys.exit(1)
    for c in spec["cases"]:
        run_case([binp], c)
elif lane == "wasm":
    ps = dict(spec); ps["outDir"] = out
    ps["cases"] = [dict(c, stdin=os.path.join(spec["cwd"], c["stdin"])) if c.get("stdin") else c for c in spec["cases"]]
    pj = os.path.join(out, "probe.json"); json.dump(ps, open(pj, "w"))
    e = dict(ENV); e["PROBE_SPEC"] = pj
    p = subprocess.run(["corepack", "pnpm@10", "exec", "vitest", "run", "tests/harness/zz-realprobe.test.ts", "-t", "realprobe"], cwd=W, capture_output=True, env=e)
    open(os.path.join(out, "vitest.log"), "wb").write(p.stdout + p.stderr)
    bl = open(os.path.join(out, "build.log")).read() if os.path.exists(os.path.join(out, "build.log")) else "NO BUILD LOG"
    if not bl.startswith("ok"):
        print("BUILD FAILED"); sys.exit(1)
else:
    sys.exit("bad lane")
print("done", lane, out)
