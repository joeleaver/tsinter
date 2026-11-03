#!/usr/bin/env python3
"""Collapse raw per-entry records (local cache, may hold paths into third-party trees) into one compact,
committable record per package: results/{npm,repo}.jsonl.gz. Sites are deduplicated across entries and
histogrammed by (kind, code, level, message, anonymized shape). No source text survives this step.
Run with python3 -I from this directory: python3 -I collate.py npm|repo"""
import gzip, json, os, re, sys, collections

HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
RESULTS = os.environ.get("SURVEY_RESULTS", os.path.join(HERE, "results"))  # a re-run writes beside the committed tables
CACHE = os.environ.get("SURVEY_CACHE", os.path.expanduser("~/.cache/tsinter-dl/survey"))
RAW = os.environ.get("SURVEY_RAW", os.path.join(CACHE, "raw"))
RANK = {"D": 3, "B": 2, "F": 1, "U": 0, "G": 0}
INST = re.compile(r"\s*\(instantiating '[^']*'\)")
BUILTIN_REASON = re.compile(r"^(SC\d+): the '([^']+)' module is not supported yet")


def safe_id(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "__", re.sub(r"^@", "", s))


def norm(m):
    return INST.sub("", m)[:240]


def own_path(stratum, name, f):
    if stratum == "repo":
        return "/node_modules/" not in f
    if "/node_modules/" not in f:
        return False
    tail = f.rsplit("/node_modules/", 1)[1]
    return tail == name or tail.startswith(name + "/")


def jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as fh:
        for line in fh:
            if line.strip():
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass  # a line torn by a kill; the entry is simply absent
    return out


def collate(stratum, meta):
    pid = meta["id"]
    d = os.path.join(RAW, stratum)
    planf = os.path.join(d, pid + ".plan.json")
    plan = json.load(open(planf)) if os.path.exists(planf) else {"entries": []}
    rows = jsonl(os.path.join(d, pid + ".jsonl"))
    sites, offenders = {}, collections.Counter()
    crashes, timeouts, pcrash, budget = [], 0, [], 0
    analyzed = pf = 0
    compile_ok, compile_crash, tree = None, None, None
    dep_sites = 0
    stats = [0, 0]
    seen_entries = set()
    wrapper_of = {e["name"]: e.get("wrapper") for e in plan.get("entries", [])}
    entry_files = set()
    for r in rows:
        if r["entry"] in seen_entries and r["entry"] != "<startup>":
            continue
        seen_entries.add(r["entry"])
        if r.get("timeout"):
            timeouts += 1
            continue
        if r.get("budget"):
            budget += 1
            continue
        if r.get("processCrash"):
            pcrash.append({"entry": r["entry"], **r["processCrash"], "stderr": r["processCrash"].get("stderr", "")[-300:]})
            continue
        if r.get("crash"):
            crashes.append({"message": r["crash"]["message"][:300], "stack": r["crash"].get("stack", [])[:3]})
            continue
        if r["entry"] == "<tree>":
            ss = [s for s in r.get("sites", []) if s["k"] != "U"]
            tree = {"preflightFailed": r.get("preflightFailed", False), "sites": len(ss),
                    "fallbacks": sorted({n["p"] for n in r.get("npm") or []})[:20]}
            continue
        analyzed += 1
        if wrapper_of.get(r["entry"]) and r["entry"] != "<tree>":
            entry_files.add(wrapper_of[r["entry"]])
        pf += 1 if r.get("preflightFailed") else 0
        if r.get("stats") and (r.get("kind") in ("primary",) or stratum == "npm"):
            stats[0] += r["stats"].get("statementsTotal", 0)
            stats[1] += r["stats"].get("statementsFailed", 0)
        root_fell = None
        for n in r.get("npm") or []:
            if n["p"] == meta.get("name"):
                root_fell = n["d"]
        demote = False
        if root_fell is not None:
            m = BUILTIN_REASON.match(root_fell)
            if m and not (m.group(2).split("/")[0] in plan.get("builtinsAll", []) or m.group(2).replace("node:", "") in plan.get("builtins", [])):
                demote = True  # a bare dependency this entry did not opt in: not this package's refusal
            elif "does not typecheck" in root_fell or "inferred surface" in root_fell:
                demote = True
            else:
                offenders[root_fell[:200]] += 1
        comp = r.get("compile")
        if comp is not None:
            compile_ok = comp.get("ok")
            compile_crash = comp.get("crash")
        for s in (r.get("sites") or []) + ((comp or {}).get("sites") or []):
            if not own_path(stratum, meta.get("name"), s["f"] or "") and stratum == "npm":
                dep_sites += 1
                continue
            if stratum == "repo" and "/node_modules/" in (s["f"] or ""):
                dep_sites += 1
                continue
            k = s["k"]
            if demote and k == "D":
                k = "F"
            if k == "B" and s["c"] != "SC3001":
                k = "D"  # a build refusal analyze() also reports; dedupes with it below
            key = (s["f"], s.get("o", s.get("l")), s["c"], norm(s["m"]))
            prev = sites.get(key)
            if prev is None or RANK[k] > RANK[prev[0]]:
                sites[key] = (k, s.get("t", -1), s.get("s", ""))
    gate_entries, gate_crashes = 0, 0
    if stratum == "repo":
        for r in jsonl(os.path.join(RAW, "repogate", pid + ".jsonl")):
            if r.get("crash") or r.get("processCrash") or r.get("timeout") or r.get("budget"):
                gate_crashes += 1
                continue
            gate_entries += 1
            for s in r.get("sites") or []:
                if "/node_modules/" in (s["f"] or "") or s["c"] in ("SC0001", "SC0002"):
                    continue
                key = (s["f"], s.get("o", s.get("l")), s["c"], norm(s["m"]))
                if key not in sites:
                    sites[key] = ("G", s.get("t", -1), s.get("s", ""))
    hist = collections.Counter()
    files = collections.defaultdict(set)
    # Files become small integers: per-file unlock counts need membership, not names.
    universe = sorted(entry_files | {f for (f, _o, _c, _m) in sites})
    index = {f: i for i, f in enumerate(universe)}
    for (f, _o, c, m), (k, t, sh) in sites.items():
        hist[(k, c, t, m, sh)] += 1
        files[(k, c, t, m, sh)].add(index[f])
    rec = dict(meta)
    rec.update({
        "entries": len(plan.get("entries", [])), "analyzed": analyzed, "preflightFailedEntries": pf,
        "planError": plan.get("planError"), "closureFiles": plan.get("closureFiles"), "sweepTruncated": plan.get("sweepTruncated"),
        "srcFiles": plan.get("srcFiles"), "sampled": plan.get("sampled"), "builtins": plan.get("builtins"),
        "crashes": crashes, "timeouts": timeouts, "processCrashes": pcrash, "budgetSkipped": budget,
        "compileOk": compile_ok, "compileCrash": compile_crash, "tree": tree, "depSites": dep_sites,
        "statements": stats, "gateEntries": gate_entries, "gateFailures": gate_crashes, "offenders": offenders.most_common(12),
        "files": len(universe),
        "sites": [[k, c, t, n, m, sh, sorted(files[(k, c, t, m, sh)])] for (k, c, t, m, sh), n in hist.most_common()],
    })
    return rec


def main():
    stratum = sys.argv[1]
    os.makedirs(os.path.join(RESULTS), exist_ok=True)
    out = os.path.join(RESULTS, stratum + ".jsonl.gz")
    n = 0
    with gzip.GzipFile(out, "wb", mtime=0) as gz:
        if stratum == "npm":
            metas = [json.loads(l) for l in open(os.path.join(HERE, "data/npm-packages.jsonl"))]
            metas = [{"id": safe_id(m["name"]), "name": m["name"], "version": m.get("version"), "rank": m["rank"], "dependents": m["dependents"],
                      "closure": m.get("closure"), "omittedDeps": len(m.get("omitted") or [])} for m in metas if m.get("status") == "ok"]
        else:
            metas = [json.loads(l) for l in open(os.path.join(HERE, "data/repo-list.jsonl"))]
            metas = [{"id": m["id"], "name": m["repo"], "commit": m.get("commit"), "origin": m["origin"], "stars": m.get("stars"), "closure": m.get("deps"),
                      "omittedDeps": m.get("omitted"), "workspaces": m.get("workspaces"), "tsxFiles": m.get("tsxFiles")} for m in metas if m.get("status") == "ok"]
        for meta in metas:
            rec = collate(stratum, meta)
            gz.write((json.dumps(rec, separators=(",", ":")) + "\n").encode())
            n += 1
    print(stratum, n, "packages ->", out, os.path.getsize(out), "bytes")


main()
