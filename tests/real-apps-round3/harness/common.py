"""Paths shared by the round-3 harness scripts.

REPO  the tsinter checkout this harness lives in (derived from this file; override with RA_REPO)
WORK  where app copies, specs and lane outputs go (RA_WORK; default ~/.cache/tsinter-dl/work/real-apps-round3)
DL    the verified downloads (~/.cache/tsinter-dl/apps/<name>/, see verify-downloads.py)
NODE  the oracle (RA_NODE; default nvm's v24.18.1)
Third-party code is only ever copied into WORK, never into the repo."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("RA_REPO") or os.path.abspath(os.path.join(HERE, "..", "..", ".."))
WORK = os.environ.get("RA_WORK") or os.path.expanduser("~/.cache/tsinter-dl/work/real-apps-round3")
APPS = os.path.join(WORK, "apps")
DL = os.path.expanduser("~/.cache/tsinter-dl/apps")
NODE = os.environ.get("RA_NODE") or os.path.expanduser("~/.nvm/versions/node/v24.18.1/bin/node")
CLI = os.path.join(REPO, "packages", "cli", "dist", "main.js")
DRIVERS = os.path.join(HERE, "drivers")
