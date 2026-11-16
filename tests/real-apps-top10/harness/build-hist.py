"""build-hist.py <build.log> : groups a lane build's diagnostics by cause (code + message with the
quoted names, numbers and instantiation suffixes normalized), most frequent first, with the count and
the first file:line of each, plus how many sites sit in the program vs node_modules."""
import re
import sys
from collections import Counter, defaultdict

HEAD = re.compile(r"^(?P<file>/\S+?):(?P<line>\d+):(?P<col>\d+) - error (?P<code>SC\d+): (?P<msg>.*)$")
JSONLINE = re.compile(r'^(?P<code>SC\d+) \{"file":"(?P<file>[^"]+)","start":(?P<start>\d+).*?\} (?P<msg>.*)$')


def norm(msg: str) -> str:
    msg = re.sub(r"\s*\(instantiating .*$", "", msg)
    msg = re.sub(r"'[^']*'", "'…'", msg)
    msg = re.sub(r"\d+", "N", msg)
    return msg[:170]


counts: Counter = Counter()
first: dict = {}
where: dict = defaultdict(lambda: [0, 0])
for raw in open(sys.argv[1], errors="replace"):
    line = raw.rstrip("\n")
    m = HEAD.match(line) or JSONLINE.match(line)
    if not m:
        continue
    f = m.group("file")
    key = f"{m.group('code')} {norm(m.group('msg'))}"
    counts[key] += 1
    where[key][0 if "/node_modules/" in f else 1] += 1
    if key not in first:
        short = f.split("/top10/src/paperclip/")[-1]
        pos = m.group("line") if "line" in m.groupdict() and m.group("line") else "@" + m.group("start")
        first[key] = f"{short}:{pos}"
total = sum(counts.values())
print(f"{total} diagnostics, {len(counts)} distinct causes")
for key, n in counts.most_common(40):
    nm, prog = where[key]
    print(f"{n:5d}  prog {prog:4d} nm {nm:4d}  {key}\n         first: {first[key]}")
