"""Paths shared by the top-10 harness scripts (modeled on ../../real-apps-round3/harness/common.py).

REPO   the tsinter checkout this harness lives in (derived from this file's location)
WORK   ~/.cache/tsinter-dl/top10 on nico-top: dl/ (tarballs + SHA256SUMS), src/<name>/ (extracted trees with
       their installed deps), tools/ (bun), specs/, res/
NODE   the oracle: the `node` on PATH (nico-top's ~/tools Node v24.18.1, what nico.sh puts first on PATH)
Third-party code only ever lives under WORK on nico-top, never in the repo and never on the laptop."""
import json, os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
TOP = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(TOP, "..", ".."))
WORK = os.path.expanduser("~/.cache/tsinter-dl/top10")
DL = os.path.join(WORK, "dl")
SRC = os.path.join(WORK, "src")
RES = os.path.join(WORK, "res")
NODE = shutil.which("node") or "node"
CLI = os.path.join(REPO, "packages", "cli", "dist", "main.js")
DRIVERS = os.path.join(TOP, "drivers")
ROUND3 = os.path.join(REPO, "tests", "real-apps-round3")
LOADER = os.path.join(HERE, "node-src-loader.mjs")


def projects():
    return json.load(open(os.path.join(HERE, "projects.json")))["projects"]


def workloads():
    return json.load(open(os.path.join(HERE, "workloads.json")))
