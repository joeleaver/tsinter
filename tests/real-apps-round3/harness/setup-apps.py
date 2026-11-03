#!/usr/bin/env python3
"""setup-apps.py [app...] : (re)create WORK/apps/<app> from the verified downloads plus this harness's drivers.

The only edits to third-party files are Node-preserving setup, the same for every lane and for Node:
import specifiers made resolvable by Node's type stripping (`./x.js` -> `./x.ts` in TS sources,
`./pgn` -> `./pgn.js`), and marked's CLI pointed at its TypeScript source instead of the built bundle.
Workloads (CSV/TOML/Markdown/PGN/diff inputs) come from the packages themselves or are generated here.
Run with `python3 -I`."""
import glob, os, re, shutil, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import APPS, DL, DRIVERS, NODE

ALL = ["chess", "toml", "papa", "polka", "expr", "marked", "markedlib", "diff", "semver"]
want = sys.argv[1:] or ALL


def fresh(name):
    d = os.path.join(APPS, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    return d


def cp(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, dst)


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(s)


def js_to_ts_imports(root):
    for f in glob.glob(root + "/**/*.ts", recursive=True):
        s = open(f).read()
        t = re.sub(r"""(from\s+['"]\.\.?/[^'"]*)\.js(['"])""", r"\1.ts\2", s)
        t = re.sub(r"""(import\(['"]\.\.?/[^'"]*)\.js(['"]\))""", r"\1.ts\2", t)
        if t != s:
            open(f, "w").write(t)


def node_modules(d, pkgs):
    for name, dl in pkgs:
        cp(os.path.join(DL, dl, "package"), os.path.join(d, "node_modules", name))


TSCONFIG = '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext", "allowImportingTsExtensions": true, "noEmit": true, "allowJs": true } }\n'

if "chess" in want:
    d = fresh("chess")
    for f in ["chess.ts", "node.ts", "pgn.js", "pgn.d.ts"]:
        cp(f"{DL}/chess.js/package/src/{f}", f"{d}/src/{f}")
    s = open(f"{d}/src/chess.ts").read().replace("from './pgn'\n", "from './pgn.js'\n")
    write(f"{d}/src/chess.ts", s)
    cp(f"{DRIVERS}/chess-main.ts", f"{d}/main.ts")
    cp(f"{DRIVERS}/chess-nobigint-head.ts", f"{d}/nobigint-head.ts")
    write(f"{d}/package.json", '{ "type": "module" }\n')
    write(f"{d}/tsconfig.json", TSCONFIG)
    cp(f"{DRIVERS}/chess-gen-bench-pgn.ts", f"{d}/gen-bench-pgn.ts")
    subprocess.run([NODE, "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "gen-bench-pgn.ts", "bench.pgn"], cwd=d, check=True)
    os.remove(f"{d}/gen-bench-pgn.ts")

if "toml" in want:
    d = fresh("toml")
    cp(f"{DL}/smol-toml/src/src", f"{d}/src")
    js_to_ts_imports(f"{d}/src")
    cp(f"{DRIVERS}/toml-main.ts", f"{d}/main.ts")
    write(f"{d}/package.json", '{ "type": "module" }\n')
    write(f"{d}/tsconfig.json", TSCONFIG)
    cp(f"{DL}/smol-toml/src/bench/testfiles/toml-spec-example.toml", f"{d}/work/toml-spec-example.toml")
    cp(f"{DL}/smol-toml/src/mise.toml", f"{d}/work/mise.toml")
    # big.toml: the first ~3000 lines of the 5 MB benchmark file, cut at a table header
    lines = open(f"{DL}/smol-toml/src/bench/testfiles/5mb-mixed.toml").read().split("\n")
    cut = next(i for i in range(3000, len(lines)) if lines[i].startswith("["))
    write(f"{d}/work/big.toml", "\n".join(lines[:cut]) + "\n")

if "papa" in want:
    d = fresh("papa")
    node_modules(d, [("papaparse", "papaparse")])
    cp(f"{DRIVERS}/papa-main.mjs", f"{d}/main.mjs")
    for f in ["sample-header.csv", "long-sample.csv", "verylong-sample.csv", "utf-8-bom-sample.csv"]:
        cp(f"{DL}/papaparse/package/tests/{f}", f"{d}/work/{f}")

if "polka" in want:
    d = fresh("polka")
    node_modules(d, [("polka", "polka"), ("trouter", "trouter"), ("matchit", "matchit"), ("@polka/url", "polka_url"), ("@arr/every", "arr_every")])
    cp(f"{DRIVERS}/polka-main.mjs", f"{d}/main.mjs")

if "expr" in want:
    d = fresh("expr")
    node_modules(d, [("expr-eval", "expr-eval")])
    cp(f"{DRIVERS}/expr-main.mjs", f"{d}/main.mjs")

if "marked" in want:
    # marked's own CLI (bin/marked.js -> bin/main.js), its library from the TypeScript source
    d = fresh("marked")
    for x in ["bin", "src", "man", "package.json"]:
        cp(f"{DL}/marked/src/{x}", f"{d}/{x}")
    s = open(f"{d}/bin/main.js").read()
    assert "from '../lib/marked.esm.js'" in s
    write(f"{d}/bin/main.js", s.replace("from '../lib/marked.esm.js'", "from '../src/marked.ts'"))
    cp(f"{DL}/marked/src/README.md", f"{d}/work/readme.md")
    cp(f"{DL}/marked/src/docs/USING_ADVANCED.md", f"{d}/work/doc.md")

if "markedlib" in want:
    d = fresh("markedlib")
    node_modules(d, [("marked", "marked")])
    cp(f"{DRIVERS}/markedlib-main.ts", f"{d}/main.ts")
    write(f"{d}/package.json", '{ "type": "module" }\n')
    cp(f"{DL}/marked/src/README.md", f"{d}/work/readme.md")
    cp(f"{DL}/marked/src/docs/USING_ADVANCED.md", f"{d}/work/doc.md")

if "diff" in want:
    d = fresh("diff")
    cp(f"{DL}/diff/src/src", f"{d}/src")
    js_to_ts_imports(f"{d}/src")
    cp(f"{DRIVERS}/diff-main.ts", f"{d}/main.ts")
    write(f"{d}/package.json", '{ "type": "module" }\n')
    write(f"{d}/tsconfig.json", TSCONFIG)
    cp(f"{DL}/smol-toml/src/bench/testfiles/toml-spec-example.toml", f"{d}/work/a.toml")
    t = open(f"{d}/work/a.toml").read()
    write(f"{d}/work/b.toml", t.replace("TOML", "Toml").replace("[database]", "[db]\nnew = true\n\n[database]").replace("\n\n", "\n", 3))
    cp(f"{DL}/chess.js/package/src/chess.ts", f"{d}/work/a.ts")
    t = open(f"{d}/work/a.ts").read()
    write(f"{d}/work/b.ts", re.sub(r"\bbigint\b", "number", t).replace("0n\n", "0\n"))

if "semver" in want:
    d = fresh("semver")
    cp(f"{DL}/semver/package", f"{d}/lib")
    os.remove(f"{d}/lib/package.json")
    cp(f"{DRIVERS}/semver-main.cjs", f"{d}/main.cjs")
    write(f"{d}/deps.txt", "left ^1.0.0\nleft ~1.0.0\nleft >=2.0.0-beta\nleft 2.x\nright ^0.2.0\nright >=1.0.0-rc.0\nright *\nmissing ^1\nleft 1.0.0 - 1.1.0\nright <0.2.0 || >0.2.4\n")

print("set up:", " ".join(a for a in ALL if a in want), "in", APPS)
