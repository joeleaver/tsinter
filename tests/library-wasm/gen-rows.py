# Generates the p1-*/p2-* rows of tests/library-wasm (lesson 21: rows from a spec,
# never hand-typed). Run from the repo root: python3 tests/library-wasm/gen-rows.py tests/library-wasm
# The game-* rows are hand-written sample games and are not touched here.
import json, os, sys
root = sys.argv[1]
TSCONFIG = {"compilerOptions": {"strict": True, "target": "es2022", "module": "nodenext", "allowImportingTsExtensions": True, "noEmit": True}, "include": ["*.ts"]}
PW_ALL = {
 "spawn": ([["kind","u32"]], "u64"), "query_begin": ([["mask","u32"]], "u32"), "query_next": ([["c","u32"]], "u64"),
 "get_f32": ([["e","u64"],["c","u32"],["f","u32"]], "f32"), "set_f32": ([["e","u64"],["c","u32"],["f","u32"],["v","f32"]], None),
 "rand_u64": ([], "u64"),
 "note_f64": ([["x","f64"]], None), "note_f32": ([["x","f32"]], None), "note_s32": ([["x","s32"]], None), "note_u32": ([["x","u32"]], None),
 "note_s64": ([["x","s64"]], None), "note_u64": ([["x","u64"]], None), "note_bool": ([["x","bool"]], None),
 "give_f64": ([["k","u32"]], "f64"), "give_f32": ([["k","u32"]], "f32"), "give_s32": ([["k","u32"]], "s32"), "give_u32": ([["k","u32"]], "u32"),
 "give_s64": ([["k","u32"]], "s64"), "give_u64": ([["k","u32"]], "u64"), "give_bool": ([["k","u32"]], "bool"),
 "report": ([["code","u32"],["text","string"]], None), "log": ([["msg","string"]], None),
}
TS = {"f64":"number","f32":"number","s32":"number","u32":"number","s64":"bigint","u64":"bigint","bool":"boolean","string":"string"}
def dts(names):
    lines = ['declare module "pw" {']
    for n in names:
        ps, r = PW_ALL[n]
        lines.append(f'  export function {n}({", ".join(p[0]+": "+TS[p[1]] for p in ps)}): {TS[r] if r else "void"};')
    lines.append("}")
    return "\n".join(lines) + "\n"
def profile(names, exports, report=True, prefix=None, extra=None):
    imps = {}
    for n in names:
        ps, r = PW_ALL[n]
        e = {"params": ps}
        if r: e["result"] = r
        if n == "rand_u64": e["role"] = "random"
        imps[n] = e
    p = {"profile_format": 2, "emission": "wasm", "exports": exports, "imports": {"pw": imps}}
    if report:
        p["report"] = {"module": "pw", "name": "report"}
        if prefix is not None: p["report"]["prefix"] = prefix
    if extra: p.update(extra)
    return p
def row(name, files, drive, prof=None, expect=None, refuse=None, comment=""):
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d): os.remove(os.path.join(d, f))
    json.dump(TSCONFIG, open(os.path.join(d, "tsconfig.json"), "w"), indent=2)
    for fn, text in files.items(): open(os.path.join(d, fn), "w").write(text)
    if prof is not None: open(os.path.join(d, "profile.json"), "w").write(json.dumps(prof, indent=2) + "\n")
    open(os.path.join(d, "drive.txt"), "w").write((f"# {comment}\n" if comment else "") + drive)
    if expect is not None: open(os.path.join(d, "expect.txt"), "w").write(expect)
    if refuse is not None: open(os.path.join(d, "refuse.txt"), "w").write(refuse + "\n")

NOTES = ["note_f64","note_f32","note_s32","note_u32","note_s64","note_u64","note_bool"]
GIVES = ["give_f64","give_f32","give_s32","give_u32","give_s64","give_u64","give_bool"]

# 1. every scalar class both ways, with a profile
row("p1-classes", {
 "pw.d.ts": dts(NOTES + GIVES + ["report"]),
 "main.ts": '''// Every scalar class across the boundary, both ways (design §2.2).
import * as pw from "pw";

export function echo(k: number): void {
  pw.note_f64(pw.give_f64(k));
  pw.note_f32(pw.give_f32(k));
  pw.note_s32(pw.give_s32(k));
  pw.note_u32(pw.give_u32(k));
  pw.note_s64(pw.give_s64(k));
  pw.note_u64(pw.give_u64(k));
  pw.note_bool(pw.give_bool(k));
}

export function f32Round(x: number): void {
  pw.note_f32(x);
}

export function mix(a: number, b: bigint, c: boolean, d: number, e: bigint, f: number): number {
  pw.note_s32(a);
  pw.note_u64(b);
  pw.note_bool(c);
  pw.note_f64(d);
  pw.note_s64(e);
  pw.note_f32(f);
  return a + d;
}

export function back(k: number): bigint {
  return pw.give_u64(k);
}

export function neg(): number {
  return -7;
}

export function flag(x: boolean): boolean {
  return !x;
}
'''}, "".join([f"call echo u32:{k}\n" for k in range(9)]) + '''call f32Round f64:0.1
call f32Round f64:16777217
call f32Round f64:-0
call mix s32:-5 u64:18446744073709551615 bool:true f64:2.5 s64:-9223372036854775808 f32:1.5 -> f64
call back u32:2 -> u64
call back u32:3 -> u64
call neg -> s32
call flag bool:false -> bool
call flag bool:true -> bool
''', profile(NOTES + GIVES + ["report"], {
   "echo": {"params": [["k","u32"]]}, "f32Round": {"params": [["x","f64"]]},
   "mix": {"params": [["a","s32"],["b","u64"],["c","bool"],["d","f64"],["e","s64"],["f","f32"]], "result": "f64"},
   "back": {"params": [["k","u32"]], "result": "u64"}, "neg": {"params": [], "result": "s32"},
   "flag": {"params": [["x","bool"]], "result": "bool"}}), comment="Every scalar class in and out (profile).")

# 2. no profile: defaults
row("p1-defaults", {
 "pw.d.ts": dts(["note_f64","note_s64","note_bool","give_f64","give_s64","give_bool"]),
 "main.ts": '''// No profile: number is f64, bigint s64, boolean bool; every export
// function is exported, plus an empty _initialize.
import { note_f64, note_s64, note_bool, give_f64, give_s64, give_bool } from "pw";

note_f64(1);

export function round(k: number): void {
  note_f64(give_f64(k));
  note_s64(give_s64(k));
  note_bool(give_bool(k));
}

export function add(a: number, b: bigint, c: boolean): bigint {
  note_f64(a);
  return c ? b + 1n : b - 1n;
}

export function big(): bigint {
  return 2n ** 63n;
}
'''}, '''call _initialize
call _initialize
repeat 6 round f64:$i
call add f64:0.5 s64:41 bool:true -> s64
call add f64:-0 s64:-9223372036854775808 bool:false -> s64
call big -> s64
call round f64:1
''', comment="Defaults; big() returns 2^63, out of s64: the boundary fence, then every call is poisoned.")

# 3. uncaught throw, report with prefix and code; poison
row("p1-uncaught", {
 "pw.d.ts": dts(["note_f64","report"]),
 "main.ts": '''// An exception escaping an export: report, trap, and the instance is
// stopped for good (SEMANTICS.md S140).
import * as pw from "pw";

let calls = 0;

export function step(n: number): number {
  calls++;
  pw.note_f64(calls);
  if (n === 3) throw new TypeError("step " + n + " is bad");
  try {
    if (n === 2) throw new RangeError("caught inside");
  } catch (e) {
    pw.note_f64(-1);
  }
  return calls * 10;
}

export function other(): void {
  pw.note_f64(99);
}
'''}, '''call step f64:1 -> f64
call step f64:2 -> f64
call step f64:3 -> f64
call step f64:4 -> f64
call other
''', profile(["note_f64","report"], {"step": {"params": [["n","f64"]], "result": "f64"}, "other": {"params": []}}, prefix="E "))

# 4. uncaught without a profile, string and plain-object throws
row("p1-uncaught-noprofile", {
 "pw.d.ts": dts(["note_f64"]),
 "main.ts": '''// No profile, no report import: the text is in the error buffer.
import { note_f64 } from "pw";

export function a(n: number): void {
  note_f64(n);
  if (n > 1) throw "plain string " + n;
}
'''}, '''call a f64:1
call a f64:2
call a f64:3
''')

# 5. unhandled rejection in the drain
row("p1-rejection", {
 "pw.d.ts": dts(["note_f64","report"]),
 "main.ts": '''// A rejection nobody handles is fatal at the export's drain, as in Node.
import * as pw from "pw";

export function ok(): void {
  Promise.reject(new Error("handled")).catch(() => pw.note_f64(7));
}

export function bad(): void {
  void Promise.reject(new Error("nobody listens"));
  pw.note_f64(1);
}
'''}, '''call ok
call bad
call ok
''', profile(["note_f64","report"], {"ok": {"params": []}, "bad": {"params": []}}))

# 6. drains: evaluation, then body, continuation across calls
row("p1-drain", {
 "pw.d.ts": dts(["note_f64","note_s64","report"]),
 "main.ts": '''// Module evaluation runs at the first export call, then a drain, then the
// body, then a drain. A task waiting on a promise resumes in the drain of
// the call that resolves it.
import * as pw from "pw";

pw.note_f64(1);
void Promise.resolve().then(() => pw.note_f64(2));

let wake: (() => void) | null = null;
async function task(): Promise<void> {
  pw.note_f64(10);
  await new Promise<void>((r) => {
    wake = r;
  });
  pw.note_f64(11);
  await null;
  pw.note_f64(12);
}

export function start(): void {
  pw.note_f64(3);
  void task();
  pw.note_f64(4);
}

export function tick(t: bigint): void {
  pw.note_s64(t);
  if (t === 2n && wake !== null) wake();
  void Promise.resolve(t).then((v) => pw.note_s64(v * 100n));
}
'''}, '''call start
repeat 4 tick u64:$i
''', profile(["note_f64","note_s64","report"], {"start": {"params": []}, "tick": {"params": [["t","u64"]]}}))

# 7. evaluation throws
row("p1-eval-throws", {
 "pw.d.ts": dts(["note_f64","report"]),
 "main.ts": '''// Module evaluation that throws: the first call (whichever) fails.
import * as pw from "pw";
import "./side.ts";

export function run(): void {
  pw.note_f64(2);
}
''', "side.ts": '''import * as pw from "pw";
pw.note_f64(1);
const xs: number[] = [];
if (xs.length === 0) throw new Error("no level loaded");
'''}, '''call run
call run
''', profile(["note_f64","report"], {"run": {"params": []}}))

# 8. boundary fences
row("p1-fences", {
 "pw.d.ts": dts(["note_u32","note_s32","note_s64","report"]),
 "main.ts": '''// SEMANTICS.md S143: a value that does not fit its class stops the
// instance; it never wraps.
import * as pw from "pw";

export function u(x: number): void {
  pw.note_u32(x);
}
export function s(x: number): void {
  pw.note_s32(x);
}
export function result(x: number): number {
  return x;
}
'''}, '''call u f64:4294967295
call u f64:-0
call s f64:-2147483648
call result f64:7 -> u32
call u f64:1.5
call u f64:1
''', profile(["note_u32","note_s32","note_s64","report"], {"u": {"params": [["x","f64"]]}, "s": {"params": [["x","f64"]]}, "result": {"params": [["x","f64"]], "result": "u32"}}))
row("p1-fence-result", {
 "pw.d.ts": dts(["report"]),
 "main.ts": '''// An export's result outside its class: the fence, then poison.
export function result(x: number): number {
  return x * 2;
}
export function wide(x: bigint): bigint {
  return x * 2n;
}
'''}, '''call result f64:3 -> u32
call wide u64:9223372036854775807 -> u64
call result f64:2147483648 -> u32
call result f64:1 -> u32
''', profile(["report"], {"result": {"params": [["x","f64"]], "result": "u32"}, "wide": {"params": [["x","u64"]], "result": "u64"}}))
row("p1-fence-nan", {
 "pw.d.ts": dts(["note_s64","report"]),
 "main.ts": '''import * as pw from "pw";
export function n(x: number): number {
  return x;
}
export function big(x: bigint): void {
  pw.note_s64(x * x);
}
'''}, '''call big s64:3037000499
call big s64:3037000500
''', profile(["note_s64","report"], {"n": {"params": [["x","f64"]], "result": "s32"}, "big": {"params": [["x","s64"]]}}))

# 9. Math.random from the host stream
row("p1-random", {
 "pw.d.ts": dts(["note_f64","rand_u64","report"]),
 "main.ts": '''// SEMANTICS.md S141: Math.random draws the host's stream.
import * as pw from "pw";

const first = Math.random();

export function draw(n: number): void {
  pw.note_f64(first);
  for (let i = 0; i < n; i++) pw.note_f64(Math.random());
  pw.note_f64(Math.floor(Math.random() * 6) + 1);
}
'''}, '''call draw f64:5
call draw f64:2
''', profile(["note_f64","rand_u64","report"], {"draw": {"params": [["n","f64"]]}}))

# 10. constant exports do not evaluate
row("p1-constant", {
 "pw.d.ts": dts(["note_f64","report"]),
 "main.ts": '''// A constant export (one `return <literal-typed>`) answers without module
// evaluation; the first other export call evaluates.
import * as pw from "pw";
import { ABI_VERSION } from "./abi.ts";

pw.note_f64(1);

export function version(): number {
  return ABI_VERSION;
}

export function ready(): boolean {
  return true;
}

export function run(): void {
  pw.note_f64(2);
}
''', "abi.ts": '''export const ABI_VERSION = 47;
'''}, '''call version -> u32
call ready -> bool
call version -> u32
call run
call version -> u32
call run
''', profile(["note_f64","report"], {"version": {"params": [], "result": "u32"}, "ready": {"params": [], "result": "bool"}, "run": {"params": []}}))

# 11. depth (wasm-only expected output)
row("p1-depth", {
 "pw.d.ts": dts(["note_f64","report"]),
 "main.ts": '''// SEMANTICS.md S142: the call-depth limit (here the profile's 50) stops
// the instance with an uncatchable RangeError; within it, recursion works,
// and the counter unwinds through returns and caught exceptions.
import * as pw from "pw";

function down(n: number): number {
  return n === 0 ? 0 : 1 + down(n - 1);
}

function thrower(n: number): number {
  if (n === 0) throw new Error("bottom");
  return thrower(n - 1);
}

export function deep(n: number): void {
  for (let i = 0; i < 100; i++) {
    try {
      thrower(30);
    } catch (e) {
      // unwound through 31 frames
    }
  }
  pw.note_f64(down(n));
}

export function noCatch(n: number): void {
  try {
    pw.note_f64(down(n));
  } catch (e) {
    pw.note_f64(-1);
  }
}
'''}, '''call deep f64:45
call deep f64:45
call noCatch f64:60
call deep f64:1
''', profile(["note_f64","report"], {"deep": {"params": [["n","f64"]]}, "noCatch": {"params": [["n","f64"]]}}, extra={"max_depth": 50}),
 expect='''note_f64 45
note_f64 45
report 3 "Uncaught RangeError: Maximum call stack size exceeded"
noCatch trapped
error "Uncaught RangeError: Maximum call stack size exceeded"
report 4 "tsinter: deep: the instance stopped at an earlier failure"
deep trapped
error "tsinter: deep: the instance stopped at an earlier failure"
''')

# refusals
def refusal(name, main, ref, prof=None, extra_files=None):
    files = {"pw.d.ts": dts(["note_f64","report"]), "main.ts": main}
    if extra_files: files.update(extra_files)
    row(name, files, "call run\n", prof, refuse=ref)
P = lambda ex, extra=None: profile(["note_f64","report"], ex, extra=extra)
RUN = {"run": {"params": []}}
refusal("p1-refuse-date", 'export function run(): void {\n  const t = Date.now();\n  if (t < 0) throw new Error("x");\n}\n', "SC4026 the wall clock", P(RUN))
refusal("p1-refuse-perf", 'import * as pw from "pw";\nexport function run(): void {\n  pw.note_f64(performance.now());\n}\n', "SC4026 performance.now", P(RUN))
refusal("p1-refuse-timer", 'import * as pw from "pw";\nexport function run(): void {\n  setTimeout(() => pw.note_f64(1), 10);\n}\n', "SC4026 timers", P(RUN))
refusal("p1-refuse-console", 'export function run(): void {\n  console.log("hello");\n}\n', "SC4026 the console", P(RUN))
refusal("p1-refuse-random", 'import * as pw from "pw";\nexport function run(): void {\n  pw.note_f64(Math.random());\n}\n', "SC4026 Math.random", None)
refusal("p1-refuse-process", 'import * as pw from "pw";\nexport function run(): void {\n  pw.note_f64(process.argv.length);\n}\n', "SC4026 process", P(RUN))
refusal("p1-refuse-async-export", 'export async function run(): Promise<void> {\n  await null;\n}\n', "SC4004 is an async function", None)
refusal("p1-refuse-generic-export", 'export function run<T>(x: T): T {\n  return x;\n}\n', "SC4007 is generic", None)
refusal("p1-refuse-missing-export", 'export function walk(): void {}\n', "SC4002 the entry module has no `export function` by that name", P(RUN))
refusal("p1-refuse-class-misfit", 'export function run(x: number): void {}\n', "SC4003 does not fit class s64", P({"run": {"params": [["x","s64"]]}}))
refusal("p1-refuse-unbound-import", 'import * as pw from "pw";\nexport function run(): void {\n  pw.note_f64(1);\n}\n', "SC4024 the profile's imports.pw does not declare 'note_f64'", profile(["report"], RUN))
refusal("p1-refuse-profile", 'export function run(): void {}\n', "SC4027 'emission' must be \"wasm\"", {"profile_format": 2, "emission": "c"})
refusal("p1-refuse-tla", 'import * as pw from "pw";\nawait Promise.resolve();\nexport function run(): void {\n  pw.note_f64(1);\n}\n', "SC4026 top-level await", P(RUN))

# ── review round 1 (unit 1): constants, NaN, math, depth, report texts ───
def copyrow(name, src, expect=None):
    import shutil
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d): os.remove(os.path.join(d, f))
    for f in os.listdir(src):
        if f in ("main.full",) or f.startswith("."): continue
        p = os.path.join(src, f)
        if os.path.isfile(p): shutil.copy(p, d)
    if expect is not None: open(os.path.join(d, "expect.txt"), "w").write(expect)

ERR_MAIN = '''// The failure text the module reports, for every kind of thrown value
// (SEMANTICS.md S140): Node's String() for errors and primitives, S007's
// spellings for other objects, UTF-8 with U+FFFD, cut at 4,096 bytes.
import * as pw from "pw";
class MyErr extends Error {
  constructor(m: string) {
    super(m);
    this.name = "MyErr";
  }
}
export function step(n: number): number {
  if (n === 1) throw "plain string";
  if (n === 2) throw 5;
  if (n === 3) throw new Error("ends with newline\\n");
  if (n === 4) throw new Error("x".repeat(5000));
  if (n === 5) throw new Error("uni \\u00e9\\u2603\\u{1d11e} lone \\ud800 end");
  if (n === 6) throw new MyErr("custom");
  if (n === 7) throw new Error("");
  if (n === 8) throw new Error("\\u00e9".repeat(2100));
  if (n === 9) throw null;
  if (n === 10) throw new TypeError("multi\\nline\\n\\n");
  if (n === 11) throw { a: 1 };
  if (n === 12) void Promise.resolve().then(() => {
    throw new Error("then-throw");
  });
  return n;
}
export function other(): void {
  pw.note_f64(99);
}
'''
for n in range(1, 13):
    row(f"p1-err-{n:02d}", {"pw.d.ts": dts(["note_f64","report"]), "main.ts": ERR_MAIN},
        f"call step f64:{n} -> f64\ncall other\n",
        profile(["note_f64","report"], {"step": {"params": [["n","f64"]], "result": "f64"}, "other": {"params": []}}, prefix="E "))

refusal("p1-refuse-const-u32", 'export function run(): number {\n  return -1;\n}\n', "SC4003 returns the constant -1, which is not a u32", P({"run": {"params": [], "result": "u32"}}))
refusal("p1-refuse-const-frac", 'const HALF = 1.5;\nexport function run(): number {\n  return HALF;\n}\n', "SC4003 returns the constant 1.5, which is not a s32", P({"run": {"params": [], "result": "s32"}}))
refusal("p1-refuse-node-module", 'import { cpus } from "node:os";\nexport function run(): number {\n  return cpus().length;\n}\n', "SC4026 the 'node:os' module", None)
refusal("p1-refuse-crypto", 'import { randomBytes } from "crypto";\nexport function run(): number {\n  return randomBytes(4).length;\n}\n', "SC4026 the 'crypto' module", None)
refusal("p1-refuse-microtask", 'import * as pw from "pw";\nexport function run(): void {\n  queueMicrotask(() => pw.note_f64(1));\n}\n', "SC4026 queueMicrotask", P(RUN))
refusal("p1-refuse-prefix", 'export function run(): void {}\n', "SC4027 'report.prefix' is longer than 256 bytes", {**P(RUN), "report": {"module": "pw", "name": "report", "prefix": "x" * 300}})
row("p1-nan-typed", {"pw.d.ts": dts(["note_f64","report"]), "main.ts": '''// SEMANTICS.md S146: a NaN stored into a typed array has the canonical
// payload, whatever the engine produced (Math.asin(2) is a NaN whose bits
// differ between Node and the module's own Math). Node's typed-array stores
// cannot be hooked, so this row's output is recorded.
import * as pw from "pw";

export function store(x: number): void {
  const f = new Float32Array(2);
  f[0] = Math.asin(x);
  f[1] = 0 / 0;
  const dv = new DataView(f.buffer);
  for (let i = 0; i < 8; i++) pw.note_f64(dv.getUint8(i));
}
'''}, "call store f64:2\n", profile(["note_f64","report"], {"store": {"params": [["x","f64"]]}}),
 expect="note_f64 0\nnote_f64 0\nnote_f64 192\nnote_f64 127\nnote_f64 0\nnote_f64 0\nnote_f64 192\nnote_f64 127\n")
row("p1-deep-clone", {"pw.d.ts": dts(["note_f64","report"]), "main.ts": '''// SEMANTICS.md S142: the runtime's recursive helpers count depth too, so a
// structured clone nested past max_depth stops by the counter on every
// engine (V8's own stack would end near 5,000 and wasmtime's near 6,000).
// Node clones far deeper, so this row's output is recorded.
import * as pw from "pw";

type N = { c: N | null; v: number };

export function clone(n: number): void {
  let t: N | null = null;
  for (let i = 0; i < n; i++) t = { c: t, v: i };
  const u = structuredClone(t);
  pw.note_f64(u === null ? -1 : u.v);
}
'''}, "call clone f64:100\ncall clone f64:5500\ncall clone f64:1\n", profile(["note_f64","report"], {"clone": {"params": [["n","f64"]]}}),
 expect='''note_f64 99
report 3 "Uncaught RangeError: Maximum call stack size exceeded"
clone trapped
error "Uncaught RangeError: Maximum call stack size exceeded"
report 4 "tsinter: clone: the instance stopped at an earlier failure"
clone trapped
error "tsinter: clone: the instance stopped at an earlier failure"
''')
# ── P2: pointer classes, tsinter:memory, result buffers, arity ────────────
PW_ALL.update({
 "emit_command": ([["cmd","string"]], None), "register_component": ([["name","string"]], "u32"),
 "put_bytes": ([["b","list<u8>"]], None), "put_u32s": ([["b","list<u32>"]], None), "put_f32s": ([["b","list<f32>"]], None),
 "read_text": ([["ptr","u32"],["cap","u32"]], "u32"), "get_vec3": ([["e","u64"],["c","u32"],["f","u32"],["out","u32"]], None),
})
TS.update({"list<u8>": "Uint8Array", "list<u32>": "Uint32Array", "list<f32>": "Float32Array"})
MEMDTS = '''// The program types tsinter:memory itself (the module is tsinter's; the
// Node column's shim implements the same names).
declare module "tsinter:memory" {
  export const mem: {
    scratch(n: number): number;
    alloc(n: number): number;
    free(p: number): void;
    u8(p: number): number;
    i32(p: number): number;
    u32(p: number): number;
    f32(p: number): number;
    f64(p: number): number;
    setU8(p: number, v: number): void;
    setI32(p: number, v: number): void;
    setU32(p: number, v: number): void;
    setF32(p: number, v: number): void;
    setF64(p: number, v: number): void;
    utf8(p: number, len: number): string;
    copyU8(p: number, n: number): Uint8Array;
    copyI32(p: number, n: number): Int32Array;
    copyU32(p: number, n: number): Uint32Array;
    copyF32(p: number, n: number): Float32Array;
  };
}
'''

STRS = ["log","emit_command","register_component","note_f64","report"]
row("p2-strings", {
 "pw.d.ts": dts(STRS),
 "main.ts": '''// Strings across the boundary (design §3.2): UTF-8 both ways, lone
// surrogates become U+FFFD (SEMANTICS.md S144), a string result lands in
// the result buffer (<name>_result_ptr/_len).
import * as pw from "pw";

export function say(s: string): string {
  pw.log(s);
  pw.log("len " + s.length);
  pw.emit_command("spawn " + s.toUpperCase());
  pw.note_f64(pw.register_component(s));
  return "<" + s + ">";
}

export function odd(): void {
  pw.log("lone \\ud800 high, lone \\udc00 low, pair \\ud83d\\ude00");
  pw.log("");
  pw.log("x".repeat(20000).length + " " + "y".repeat(3000));
}

export function many(n: number): void {
  for (let i = 0; i < n; i++) pw.register_component("c" + (i % 7));
  pw.log("done " + n);
}

export function echo(s: string): string {
  return s;
}
'''}, '''call say string:"hello" -> string
call say string:"h\\u00e9llo w\\u00f6rld \\u2603 \\ud834\\udd1e" -> string
call say string:"hello" -> string
call odd
call many f64:50000
call echo string:"a long result, longer than the next one" -> string
call echo string:"short" -> string
call echo string:"lone \\udc00 inbound" -> string
call echo string:"" -> string
dump
''', profile(STRS, {"say": {"params": [["s","string"]], "result": "string"}, "odd": {"params": []}, "many": {"params": [["n","f64"]]}, "echo": {"params": [["s","string"]], "result": "string"}}))

row("p2-strings-noprofile", {
 "pw.d.ts": dts(["log"]),
 "main.ts": '''// No profile: string crosses as (ptr, len); the alloc export is
// tsinter_alloc.
import { log } from "pw";

export function greet(name: string): string {
  log("hi " + name);
  return name + "!";
}
'''}, '''call greet string:"you" -> string
call greet string:"\\u00fcber" -> string
''')

LISTS = ["put_bytes","put_u32s","put_f32s","report"]
row("p2-lists", {
 "pw.d.ts": dts(LISTS),
 "main.ts": '''// Typed arrays to the host: copied element by element, little-endian;
// a view sends only its own elements.
import * as pw from "pw";

export function send(): void {
  const b = new Uint8Array([1, 2, 3, 250, 255]);
  pw.put_bytes(b);
  pw.put_bytes(b.subarray(1, 3));
  pw.put_bytes(new Uint8Array(0));
  pw.put_u32s(new Uint32Array([0, 1, 4294967295, 123456789]));
  pw.put_f32s(new Float32Array([0.5, -0, 1e-45, 3.4e38, 0.1]));
  const big = new Uint32Array(1000);
  for (let i = 0; i < big.length; i++) big[i] = i * 3;
  pw.put_u32s(big.subarray(995));
}
'''}, "call send\ncall send\n", profile(LISTS, {"send": {"params": []}}))

MEMS = ["read_text","get_vec3","spawn","set_f32","note_f64","log","report"]
row("p2-memory", {
 "pw.d.ts": dts(MEMS), "memory.d.ts": MEMDTS,
 "main.ts": '''// tsinter:memory: an out-buffer (get_vec3), the hostStr retry shape
// (read_text), reads and writes of every width, the heap and the copies.
import * as pw from "pw";
import { mem } from "tsinter:memory";

let e = 0n;
let heap = 0;

export function setup(): void {
  e = pw.spawn(1);
  pw.set_f32(e, 2, 0, 1.5);
  pw.set_f32(e, 2, 1, -2.25);
  pw.set_f32(e, 2, 2, 1e10);
  heap = mem.alloc(64);
  mem.setF64(heap, Math.PI);
}

export function vec(): void {
  const p = mem.scratch(12);
  pw.get_vec3(e, 2, 0, p);
  pw.note_f64(mem.f32(p));
  pw.note_f64(mem.f32(p + 4));
  pw.note_f64(mem.f32(p + 8));
}

export function text(): void {
  let cap = 4;
  let p = mem.scratch(cap);
  let n = pw.read_text(p, cap);
  if (n > cap) {
    cap = n;
    p = mem.scratch(cap);
    n = pw.read_text(p, cap);
  }
  pw.log(mem.utf8(p, n));
  const bytes = mem.copyU8(p, n);
  pw.note_f64(bytes.length);
  pw.note_f64(bytes[1]!);
}

export function widths(): void {
  const p = mem.scratch(32);
  mem.setU8(p, 200);
  mem.setI32(p + 4, -5);
  mem.setU32(p + 8, 4000000000);
  mem.setF32(p + 12, 0.1);
  mem.setF64(p + 16, -0.5);
  pw.note_f64(mem.u8(p));
  pw.note_f64(mem.i32(p + 4));
  pw.note_f64(mem.u32(p + 4));
  pw.note_f64(mem.u32(p + 8));
  pw.note_f64(mem.i32(p + 8));
  pw.note_f64(mem.f32(p + 12));
  pw.note_f64(mem.f64(p + 16));
  const f = mem.copyF32(p + 12, 1);
  pw.note_f64(f[0]!);
  const u = mem.copyU32(p + 4, 2);
  pw.note_f64(u[0]! + u[1]!);
  const i = mem.copyI32(p + 4, 1);
  pw.note_f64(i[0]!);
  pw.note_f64(mem.f64(heap));
}

export function heapChurn(): void {
  // free then alloc: the block comes back; a fresh one grows the heap
  for (let k = 0; k < 100; k++) {
    const a = mem.alloc(100 + k);
    mem.setU8(a, k);
    mem.free(a);
  }
  const big = mem.alloc(200000);
  mem.setU32(big + 199996, 77);
  pw.note_f64(mem.u32(big + 199996));
  mem.free(big);
  pw.note_f64(mem.f64(heap));
}
'''}, '''call setup
call vec
call text
call widths
call heapChurn
call vec
call widths
''', profile(MEMS, {"setup": {"params": []}, "vec": {"params": []}, "text": {"params": []}, "widths": {"params": []}, "heapChurn": {"params": []}}))

for nm, body, ex in [
  ("p2-mem-fence-read", "pw.note_f64(mem.u8(2147483647));", "read"),
  ("p2-mem-fence-u8", "mem.setU8(mem.scratch(4), 300);", "u8"),
  ("p2-mem-fence-neg", "pw.note_f64(mem.f64(-8));", "neg"),
  ("p2-mem-fence-len", "pw.log(mem.utf8(mem.scratch(4), 1.5));", "len"),
]:
    row(nm, {"pw.d.ts": dts(["note_f64","log","report"]), "memory.d.ts": MEMDTS,
             "main.ts": f'''// tsinter:memory's checks: a fence, never a silent wrap or an engine trap.
import * as pw from "pw";
import {{ mem }} from "tsinter:memory";

export function run(): void {{
  pw.note_f64(1);
  {body}
}}
'''}, "call run\ncall run\n", profile(["note_f64","log","report"], {"run": {"params": []}}))

row("p2-heap-scratch-fence", {"pw.d.ts": dts(["note_f64","report"]), "memory.d.ts": MEMDTS,
 "main.ts": '''// The heap grows below the scratch arena, so a heap block that must grow it
// while this call's scratch is live is a fence (a tsinter limit, S122):
// Node's shim has no such limit, so this row's output is recorded.
import * as pw from "pw";
import { mem } from "tsinter:memory";

export function ok(): void {
  const a = mem.alloc(16);
  const s = mem.scratch(16);
  mem.setU8(s, 1);
  mem.free(a);
  const b = mem.alloc(16);
  pw.note_f64(mem.u8(s));
  mem.free(b);
}

export function bad(): void {
  const s = mem.scratch(16);
  mem.setU8(s, 1);
  mem.alloc(100000);
}
'''}, "call ok\ncall ok\ncall bad\n", profile(["note_f64","report"], {"ok": {"params": []}, "bad": {"params": []}}),
 expect='''note_f64 1
note_f64 1
report 2 "tsinter: mem.alloc needs to grow the heap while this call's scratch is in use; allocate before using mem.scratch in the call"
bad trapped
error "tsinter: mem.alloc needs to grow the heap while this call's scratch is in use; allocate before using mem.scratch in the call"
''')

row("p2-refuse-arity", {"pw.d.ts": dts(["get_vec3","report"]),
 "main.ts": 'import * as pw from "pw";\nexport function run(): void {\n  pw.get_vec3(1n, 2, 3, 4);\n}\n'},
 "call run\n", profile(["get_vec3","report"], {"run": {"params": []}}, extra={"max_import_params": 3}),
 refuse="SC4025 pw.get_vec3 has 4 wasm parameters; this profile's limit is 3")
row("p2-refuse-mem-name", {"pw.d.ts": dts(["report"]), "memory.d.ts": MEMDTS.replace("    free(p: number): void;", "    free(p: number): void;\n    zap(p: number): void;"),
 "main.ts": 'import { mem } from "tsinter:memory";\nexport function run(): void {\n  mem.zap(1);\n}\n'},
 "call run\n", None, refuse="SC4003 is not a tsinter:memory function")
