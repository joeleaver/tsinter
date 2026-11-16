"""build-sites.py <build.log> <regex> : the lane build's diagnostics whose message matches <regex>, one
per line as `file:line:col<TAB>code<TAB>message` (the log's JSON offsets resolved against the source)."""
import json
import re
import sys

JSONLINE = re.compile(r'^(?P<code>SC\d+) (?P<loc>\{.*?\}) (?P<msg>.*)$')
HEAD = re.compile(r"^(?P<file>/\S+?):(?P<line>\d+):(?P<col>\d+) - error (?P<code>SC\d+): (?P<msg>.*)$")
pat = re.compile(sys.argv[2])
cache: dict = {}


def line_col(path: str, off: int) -> tuple:
    if path not in cache:
        try:
            cache[path] = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            cache[path] = None
    text = cache[path]
    if text is None:
        return (0, 0)
    head = text[:off]
    return (head.count("\n") + 1, off - (head.rfind("\n") + 1) + 1)


seen = set()
for raw in open(sys.argv[1], errors="replace"):
    line = raw.rstrip("\n")
    m = JSONLINE.match(line)
    if m:
        try:
            loc = json.loads(m.group("loc"))
        except ValueError:
            continue
        f = loc.get("file", "")
        ln, col = line_col(f, int(loc.get("start", 0)))
        code, msg = m.group("code"), m.group("msg")
    else:
        h = HEAD.match(line)
        if not h:
            continue
        f, ln, col, code, msg = h.group("file"), h.group("line"), h.group("col"), h.group("code"), h.group("msg")
    if not pat.search(msg):
        continue
    short = f.split("/top10/src/paperclip/")[-1]
    key = (short, ln, col, msg)
    if key in seen:
        continue
    seen.add(key)
    print(f"{short}:{ln}:{col}\t{code}\t{msg[:400]}")
