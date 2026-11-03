#!/usr/bin/env python3
"""Tables from results/{npm,repo}.jsonl.gz: verdicts, ranked families, greedy unlock order, crash groups.
Works from the committed compact results alone. Writes results/tables-<stratum>.md and prints it.
Run from this directory with python3 -I report.py npm|repo [--unmatched]"""
import collections, gzip, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
RESULTS = os.environ.get("SURVEY_RESULTS", os.path.join(HERE, "results"))
sys.path.insert(0, HERE)
from families import TITLES, classify  # noqa: E402

# npm.ts SHIMMED_BUILTINS: Node builtins the embedded engine's island provides.
ENGINE_BUILTINS = set("""events path process fs child_process os diagnostics_channel module url tty util util/types buffer string_decoder crypto
stream stream/promises stream/consumers stream/web fs/promises async_hooks readline path/posix path/win32 assert assert/strict punycode querystring
constants console timers timers/promises zlib domain dns worker_threads perf_hooks http https net tls v8""".split())
NOT_LANGUAGE = {"dep-edge"}  # consequences of a dependency, not this package's constructs
ENV = {"tsc:missing-dep", "tsc:knock-on", "tsc:ambient"}  # mostly the survey environment, not a compiler gap


def load(stratum):
    with gzip.open(os.path.join(RESULTS, stratum + ".jsonl.gz"), "rt") as fh:
        return [json.loads(l) for l in fh]


def analyze_pkg(p):
    fams = collections.defaultdict(lambda: {"sites": 0, "hard": 0, "init": 0, "reached": 0, "gated": 0, "nongate": 0})
    for k, code, t, n, msg, shape, *_ in p["sites"]:
        f = classify(code, msg, shape)
        if f is None:
            continue
        e = fams[f]
        e["sites"] += n
        if k in ("D", "B"):
            e["hard"] += n
        if k == "G":
            e["gated"] += n
        else:
            e["nongate"] += n
        if k == "F":
            e["reached"] += n
        if k in ("D", "B", "G") or (k == "F" and t == 1):
            e["init"] += n
    for reason, n in p.get("offenders", []):
        code = reason.split(":", 1)[0] if reason.startswith("SC") else "SC1090"
        f = classify(code, reason.split(": ", 1)[-1], "") or "other"
        e = fams[f]
        e["sites"] += 1
        e["hard"] += 1
        e["init"] += 1
    p["fams"] = fams
    # Per-file families, past-gate (G) sites left out; a file whose every site is past-gate is not a unit.
    per_file = collections.defaultdict(set)
    gated_only = set()
    seen_ng = set()
    for k, code, t, n, msg, shape, *rest in p["sites"]:
        if not rest:
            continue
        if k == "G":
            gated_only.update(rest[0])
            continue
        seen_ng.update(rest[0])
        f = classify(code, msg, shape)
        if f is None or f in NOT_LANGUAGE or f in ENV:
            continue
        for i in rest[0]:
            per_file[i].add(f)
    p["fileFams"] = [per_file.get(i, set()) for i in range(p.get("files", 0)) if i in seen_ng or i not in gated_only]
    lang = {f for f in fams if f not in NOT_LANGUAGE}
    # Knock-on references count only when nothing else explains them.
    if len(lang) > 1:
        lang.discard("binding:blocked")
    hard = {f for f, e in fams.items() if (e["hard"] or e["gated"]) and f in lang}
    p["lang"] = lang
    p["lang_ng"] = {f for f in lang if fams[f]["nongate"] or fams[f]["hard"]}
    p["hardset"] = hard
    p["initset"] = {f for f, e in fams.items() if e["init"] and f in lang}
    if p["analyzed"] == 0 or (p["statements"][0] == 0 and not fams):
        p["verdict"] = "no-result"  # nothing analyzed, or nothing lowered: "clean" would be vacuous
    elif lang and lang <= ENV:
        p["verdict"] = "dep-unavailable"
    elif hard - ENV or (hard and lang - ENV):
        p["verdict"] = "blocked"
    elif lang:
        p["verdict"] = "deferred-only"
    else:
        p["verdict"] = "clean"
    p["partial"] = p["timeouts"] + len(p["crashes"]) + len(p["processCrashes"]) + p["budgetSkipped"] > 0
    return p


def greedy(pkgs, key):
    """Each round fixes the family that cleans the most packages now; while nothing can clean a package
    outright, it takes the family with the most leverage: sum over blocked packages of 1/(families left)."""
    remaining = [set(key(p)) for p in pkgs]
    start_clean = sum(1 for r in remaining if not r)
    fixed, steps, cum = set(), [], start_clean
    while True:
        cands = collections.Counter()
        lever = collections.Counter()
        for r in remaining:
            if len(r) == 1:
                cands[next(iter(r))] += 1
            for f in r:
                lever[f] += 1.0 / len(r)
        if not lever:
            break
        best = max(lever, key=lambda f: (cands[f], lever[f], f))
        fixed.add(best)
        gained = cands[best]
        cum += gained
        affected = sum(1 for r in remaining if best in r)
        for r in remaining:
            r.discard(best)
        steps.append((best, gained, cum, affected))
    return start_clean, steps


def crash_groups(pkgs):
    groups = collections.defaultdict(list)
    for p in pkgs:
        for c in p["crashes"]:
            m = re.sub(r"/[^\s'\"]+", "<path>", c["message"])
            m = re.sub(r"'[^']{0,80}'", "'_'", m)[:110]
            top = (c.get("stack") or [""])[0][:60]
            groups[(m, top)].append(p["name"])
        for c in p["processCrashes"]:
            tail = (c.get("stderr") or "").strip().split("\n")
            line = next((x for x in tail if re.search(r"Error|FATAL|panic|heap", x)), tail[0] if tail else "")
            groups[(f"process exit code={c.get('code')} signal={c.get('signal')}: " + re.sub(r"/[^\s'\"]+", "<path>", line)[:90], "")].append(p["name"])
        if p.get("compileCrash"):
            c = p["compileCrash"]
            groups[("compile: " + re.sub(r"/[^\s'\"]+", "<path>", c["message"])[:100], (c.get("stack") or [""])[0][:60])].append(p["name"])
    return sorted(groups.items(), key=lambda kv: -len(set(kv[1])))


def main():
    stratum = sys.argv[1]
    pkgs = [analyze_pkg(p) for p in load(stratum)]
    out = []
    w = out.append
    label = {"npm": "Stratum A, npm tarballs", "repo": "Stratum B, TypeScript source repos"}[stratum]
    w(f"# {label}\n")
    v = collections.Counter(p["verdict"] for p in pkgs)
    n = len(pkgs)
    w(f"Packages: {n}. " + ", ".join(f"{k}: {v[k]}" for k in ["clean", "deferred-only", "blocked", "dep-unavailable", "no-result"]) + ".\n")
    w(f"Partial analysis (at least one entry timed out or crashed): {sum(p['partial'] for p in pkgs)}. "
      f"Timed-out entries: {sum(p['timeouts'] for p in pkgs)}. Analyzer crashes: {sum(len(p['crashes']) for p in pkgs)}. "
      f"Process crashes: {sum(len(p['processCrashes']) for p in pkgs)}. Entries skipped on the time budget: {sum(p['budgetSkipped'] for p in pkgs)}.\n")
    if stratum == "repo":
        ent = sum(p["analyzed"] for p in pkgs)
        pf = sum(p["preflightFailedEntries"] for p in pkgs)
        w(f"Entries analyzed: {ent}; stopped at the type-check gate: {pf} ({100 * pf / max(1, ent):.0f}%). The past-gate pass re-lowered "
          f"{sum(p.get('gateEntries', 0) for p in pkgs)} of them with checker errors ignored; {sum(p.get('gateFailures', 0) for p in pkgs)} of those "
          f"crashed or timed out (expected on programs that do not type-check; not counted as compiler bugs). Sites seen only there are "
          f"counted as hard refusals and shown in the past-gate column.\n")
    if stratum == "npm":
        tr = [p for p in pkgs if p["verdict"] == "clean"]
        treeok = [p for p in tr if not p.get("closure") or (p.get("tree") and not p["tree"]["preflightFailed"] and p["tree"]["sites"] == 0 and not p["tree"]["fallbacks"])]
        w(f"Of the clean packages, {sum(p['statements'][0] < 20 for p in tr)} are shims under 20 statements.\n")
        w(f"Clean with dependencies too: {len(treeok)} of {len(tr)} clean packages stay clean once their closure is compiled.\n")
    w("Verdict breakdown by hard refusal (a build-time diagnostic or package-level fallback, not a deferred fence), top families:\n")
    hardc = collections.Counter(f for p in pkgs if p["verdict"] == "blocked" for f in p["hardset"])
    w("| family | blocked packages |\n|---|---|")
    for f, c in hardc.most_common(10):
        w(f"| {f}: {TITLES.get(f, f)[:90]} | {c} |")
    w("")
    w("## Ranked families (packages affected)\n")
    w("Hard = packages with at least one build-time refusal or package-level fallback in the family. Reached = deferred fences on the entry path. "
      "Init = packages with an unconditional module-level site, which dies at load.\n")
    w("| # | family | packages | hard | init | past-gate only | sites | sites/pkg (median) |\n|---|---|---|---|---|---|---|---|")
    fam = collections.defaultdict(list)
    for p in pkgs:
        for f, e in p["fams"].items():
            fam[f].append((p["name"], e))
    order = sorted(fam.items(), key=lambda kv: (-len(kv[1]), -sum(e["sites"] for _, e in kv[1])))
    rank = 0
    for f, rows in order:
        rank += 1
        sites = sorted(e["sites"] for _, e in rows)
        w(f"| {rank} | `{f}` {TITLES.get(f, 'consequence of a dependency that did not compile' if f == 'dep-edge' else f)[:110]} | {len(rows)} | "
          f"{sum(1 for _, e in rows if e['hard'])} | {sum(1 for _, e in rows if e['init'])} | {sum(1 for _, e in rows if e['gated'] and not e['hard'])} | {sum(sites)} | {sites[len(sites) // 2]} |")
    w("")
    pop = [p for p in pkgs if p["verdict"] != "no-result" and not p["partial"]]
    w("## Greedy unlock order\n")
    w(f"Population: {len(pop)} packages with a complete analysis ({n - len(pop)} partial or empty results are left out; they cannot be called clean). "
      "A package counts as clean once every family it has is fixed. Each step takes the family that cleans the most packages; "
      "when none can finish a package, the one with the most leverage. `tsc:missing-dep` is the survey environment, so it is treated as already fixed; "
      "packages whose every entry stopped at preflight are left out, because nothing past the type check was seen.\n")
    variants = {
        "npm": [("Every family, deferred fences included", lambda p: p["lang"]),
                ("Build-time refusals only (the build passes; deferred fences remain)", lambda p: p["hardset"]),
                ("Loads: no build-time refusal and no unconditional module-level fence", lambda p: p["initset"])],
        # In TypeScript nearly every refusal is build-time, so the build-only and loads views repeat this one.
        "repo": [("Every family, sites seen only past the type-check gate left out (the reliable view)", lambda p: p["lang_ng"]),
                 ("Every family, past-gate sites included (types degraded by missing dependencies inflate types:shape)", lambda p: p["lang"])],
    }[stratum]
    for title, key in variants:
        k = (lambda kk: (lambda p: kk(p) - ENV))(key)
        pruned = [p for p in pop if p["preflightFailedEntries"] < p["analyzed"] or p.get("gateEntries")]
        s0, steps = greedy(pruned, k)
        w(f"### {title}\n")
        w(f"Population with at least one entry past preflight: {len(pruned)}. Clean at the start: {s0}.\n")
        w("| step | fix | newly clean | cumulative clean | % | packages touched |\n|---|---|---|---|---|---|")
        for i, (f, g, c, a) in enumerate(steps, 1):
            w(f"| {i} | `{f}` | {g} | {c} | {100 * c / max(1, len(pruned)):.0f}% | {a} |")
        w("")
    w("## Named members inside the stdlib and module families (packages affected)\n")
    for famname in ["stdlib:js", "stdlib:node", "module:builtin", "module:form"]:
        named = collections.defaultdict(set)
        for p in pkgs:
            for k, code, t, n, msg, shape, *_ in p["sites"]:
                if classify(code, msg, shape) != famname or k == "G":
                    continue
                m2 = re.match(r"'([^']{1,60})'", msg) or re.search(r"the '([^']+)' (module|package)", msg)
                key2 = m2.group(1) if m2 else re.sub(r"'[^']*'", "_", msg)[:60]
                key2 = re.sub(r"^new (\w+)\(.*", r"new \1(...)", key2)
                named[key2].add(p["name"])
        top = sorted(named.items(), key=lambda kv: -len(kv[1]))[:20]
        if top:
            w(f"`{famname}`: " + "; ".join(f"{k2} {len(v)}" for k2, v in top) + "\n")
    w("### Per file (supplementary)\n")
    units = [ff for p in pop for ff in p["fileFams"]]
    for ff in units:
        if len(ff) > 1:
            ff.discard("binding:blocked")
    fam_files = collections.Counter(f for ff in units for f in ff)
    s0, steps = greedy([{"u": ff} for ff in units], lambda u: u["u"])
    w(f"The same greedy with each source file as the unit (an entry file or a file a site sits in; {len(units)} files, {s0} without a site; "
      "past-gate sites left out, and files seen only past the gate dropped). "
      "At package granularity nearly every package has a long tail of families, so this view separates the broad fixes from the rare ones.\n")
    w("| step | fix | files with the family | newly clean files | cumulative | % |\n|---|---|---|---|---|---|")
    for i, (f, g, c, a) in enumerate(steps[:30], 1):
        w(f"| {i} | `{f}` | {fam_files[f]} | {g} | {c} | {100 * c / max(1, len(units)):.0f}% |")
    w("")
    if stratum == "npm":
        w("## QuickJS embed estimate\n")
        nc = [p for p in pop if p["verdict"] != "clean"]
        ok = [p for p in nc if not set(b for b in (p.get("builtins") or [])) - ENGINE_BUILTINS]
        miss = collections.Counter(b for p in nc for b in set(p.get("builtins") or []) if b not in ENGINE_BUILTINS)
        w(f"Upper bound: {len(ok)} of {len(nc)} non-clean packages import only builtins the island shims, so a whole-package hand-off to the engine could load them. "
          f"Builtins outside the shim list: {dict(miss.most_common(10))}. Static clean today: {sum(p['verdict'] == 'clean' for p in pop)}.\n")
        cold = [p for p in pop if p["verdict"] == "clean"]
        w(f"Combined bound (static clean or engine-servable): {len(cold) + len(ok)} of {len(pop)}.\n")
    if stratum == "npm":
        s = sum(p["statements"][0] for p in pkgs)
        f = sum(p["statements"][1] for p in pkgs)
        w(f"Statement coverage across sweeps (double counts shared modules): {f} of {s} statements fenced ({100 * f / max(1, s):.0f}%).\n")
    groups = crash_groups(pkgs)
    w("## Analyzer crashes by cause\n")
    if not groups:
        w("None.\n")
    else:
        w("| packages | entries | cause | where |\n|---|---|---|---|")
        for (m, top), names in groups:
            w(f"| {len(set(names))} | {len(names)} | {m.replace('|', '/')} | {top} |")
        w("")
        for (m, top), names in groups:
            w(f"- {m[:70]}: {', '.join(sorted(set(names))[:12])}")
        w("")
    for code, title in [("SC9001", "Internal compiler errors (SC9001: the IR validator rejected what lowering produced)"),
                        ("SC3001", "WasmGC emitter refusals (SC3001), first entry of each package only")]:
        g = collections.defaultdict(lambda: [0, set()])
        for p in pkgs:
            for k, c2, t, n2, msg, shape, *_ in p["sites"]:
                if c2 != code:
                    continue
                key = re.sub(r"\bin \S+: ", "", msg)
                key = re.sub(r'"[^"]*"', '"_"', key)
                key = re.sub(r"'[^']*'", "'_'", key)
                key = re.sub(r"%\w+|\d+", "N", key).replace(" — please report this", "")
                key = re.sub(r"; build with the LLVM backend.*", "", key)[:120]
                g[key][0] += n2
                g[key][1].add(p["name"])
        w(f"## {title}\n")
        if not g:
            w("None.\n")
            continue
        w("| packages | sites | cause | examples |\n|---|---|---|---|")
        for key, (n2, names) in sorted(g.items(), key=lambda kv: -len(kv[1][1])):
            w(f"| {len(names)} | {n2} | {key.replace('|', '/')} | {', '.join(sorted(names)[:6])} |")
        w("")
    nf = sorted(len(p["lang"]) for p in pop if p["verdict"] != "clean")
    if nf:
        w(f"Families per non-clean package: median {nf[len(nf) // 2]}, 90th percentile {nf[int(len(nf) * 0.9)]}, max {nf[-1]}.\n")
    tos = [p["name"] for p in pkgs if p["timeouts"]]
    if tos:
        w(f"Timeouts in: {', '.join(tos)}\n")
    nores = [p["name"] for p in pkgs if p["verdict"] == "no-result"]
    if nores:
        w(f"No result: {', '.join(f"{p['name']} ({p['entries']} entries{', ' + p['planError'] if p.get('planError') else ''})" for p in pkgs if p['verdict'] == 'no-result')}\n")
    w("## Lists\n")
    w("Clean: " + ", ".join(sorted(p["name"] for p in pkgs if p["verdict"] == "clean")) + "\n")
    text = "\n".join(out)
    open(os.path.join(RESULTS, f"tables-{stratum}.md"), "w").write(text)
    print(text)
    if "--unmatched" in sys.argv:
        c = collections.Counter()
        for p in pkgs:
            for k, code, t, n2, msg, shape, *_ in p["sites"]:
                if classify(code, msg, shape) == "other":
                    c[code + " " + re.sub(r"'[^']*'", "_", msg)[:120]] += 1
        print("\nUNMATCHED (rows, not sites)")
        for k2, n2 in c.most_common(70):
            print(n2, k2)


main()
