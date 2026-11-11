#!/usr/bin/env python3
"""peek.py owner/repo [path...] : read-only look at a GitHub repo for the selection step.

Prints the root listing, the root package.json summary (name, bin, main, packageManager, engines,
workspaces, scripts' names), and for each extra path its listing or package.json summary.
Uses only `gh api` GET calls; nothing is downloaded or run."""
import base64, json, subprocess, sys


def gh(path):
    p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    return json.loads(p.stdout) if p.returncode == 0 else None


def pkg(repo, path):
    d = gh(f"repos/{repo}/contents/{path}")
    if not d or "content" not in d:
        print(f"  {path}: none")
        return
    try:
        p = json.loads(base64.b64decode(d["content"]))
    except Exception as e:  # noqa: BLE001
        print(f"  {path}: unparsable ({e})")
        return
    print(f"  {path}: name={p.get('name')} bin={p.get('bin')} main={p.get('main')} type={p.get('type')}")
    print(f"    exports={json.dumps(p.get('exports'))[:300]}")
    print(f"    pm={p.get('packageManager')} engines={p.get('engines')} workspaces={p.get('workspaces')}")
    print(f"    scripts={list((p.get('scripts') or {}).keys())[:20]}")
    print(f"    deps={list((p.get('dependencies') or {}).keys())[:40]}")


def ls(repo, path):
    d = gh(f"repos/{repo}/contents/{path}")
    if isinstance(d, list):
        print(f"  {path or '/'}: " + " ".join(x["name"] + ("/" if x["type"] == "dir" else "") for x in d)[:900])
    else:
        print(f"  {path or '/'}: not a dir")


repo = sys.argv[1]
print("===", repo)
ls(repo, "")
pkg(repo, "package.json")
for extra in sys.argv[2:]:
    (pkg if extra.endswith(".json") else ls)(repo, extra)
