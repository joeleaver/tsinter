/* Vue's cheap blockers: `++` / `--` over an 'any' variable in a TypeScript
 * source (Node's ToNumeric update), a member or element assignment in
 * value position (the value written is the expression's value), an
 * array's `length = n` (Node's ArraySetLength), and `process.exitCode =
 * n` (Node's validating setter, honoured at a natural exit, by a bare
 * process.exit() and by the 'exit' listeners' code).
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane, or stops by name where
 * noted. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-vuecheap-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source (written as main.ts unless `entry` names another). */
  src: string;
  entry?: string;
  /** Node's exit status for the row (default 0); the tier's must match. */
  exit?: number;
  /** Ends with an uncaught error: Node and this tier exit with `exit`,
   * stdout is equal, and this tier's stderr (S007's report) names the
   * error (`contains`). */
  uncaught?: { exit: number; contains: string };
  /** Still stops by name on this tier: stdout up to the stop is a prefix
   * of Node's, and stderr names the diagnostic. */
  fence?: string;
  /** The build refuses, and some diagnostic's message contains this. */
  refusedMsg?: string;
  /** Other files written beside the entry (name -> source). */
  extra?: Record<string, string>;
}

const LOOSE = JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: false, target: "es2022", module: "esnext", moduleResolution: "bundler" } });

const ROWS: Row[] = [
  {
    id: "VC-01 ++/-- over 'any' loop counters: prefix and postfix in for-loops, the counter's values",
    src: `const out: number[] = [];
let i: any;
for (i = 0; i < 3; i++) out.push(i);
let j: any;
for (j = 5; j > 2; --j) out.push(j);
console.log(out.join(","), i, j, typeof i);`,
  },
  {
    id: "VC-02 ++/-- over 'any': strings convert by ToNumber (never concatenate), undefined NaN, null 0, booleans 1/0; postfix yields the old number",
    src: `let s: any = "5";
s++;
console.log(s, typeof s);
let t: any = "5";
console.log(t++, t, typeof t);
let u: any;
u++;
console.log(u);
let n: any = null;
console.log(++n, n);
let b: any = true;
b--;
console.log(b);
let w: any = " 0x10 ";
w++;
console.log(w);
let x: any = "abc";
x--;
console.log(x);`,
  },
  {
    id: "VC-03 prefix and postfix 'any' updates inside expressions",
    src: `let a: any = 1;
const r = ++a + a--;
console.log(r, a);
let c: any = "2";
const arr = [c--, c, --c, c];
console.log(arr.join(" "));`,
  },
  {
    id: "VC-04 noImplicitAny off: a `let i, l` counter (Vue's render-list shape) over a string and over a number",
    src: `function renderList(val: any): string[] {
  let ret: string[] = [], i, l;
  if (typeof val === "string") {
    for (i = 0, l = val.length; i < l; i++) ret.push(val.charAt(i) + i);
  } else if (typeof val === "number") {
    for (i = 0; i < val; i++) ret.push(String(i + 1));
  }
  return ret;
}
console.log(renderList("abc").join(","), renderList(3).join(","));`,
    extra: { "tsconfig.json": LOOSE },
  },
  {
    id: "VC-05 in a program that holds bigints: a bigint 'any' steps as a bigint, a string as a number",
    src: `let a: any = 5n;
a++;
console.log(a, typeof a);
let s: any = "7";
s--;
console.log(s, typeof s);
let z: any = 0n;
console.log(z--, z);`,
  },
  {
    id: "VC-06 member and element assignment as a value: the memo cache, chained element writes, a guarded record write, a class field",
    src: `const cache: Record<string, string> = {};
function cached(fn: (s: string) => string): (s: string) => string {
  return (str: string) => {
    const hit = cache[str];
    return hit || (cache[str] = fn(str));
  };
}
let calls = 0;
const up = cached((s) => { calls++; return s.toUpperCase(); });
console.log(up("a"), up("a"), up("b"), calls, Object.keys(cache).join(","));
const arr: number[] = [1, 2, 3];
let t: number;
t = arr[1] = 9;
console.log(t, arr.join(","));
const res: Record<string, string> = {};
const kv = " a : b ".split(":");
kv.length > 1 && (res[kv[0]!.trim()] = kv[1]!.trim());
console.log(JSON.stringify(res));
class Box { v = 0; }
const bx = new Box();
const w = (bx.v = 5) + 1;
console.log(w, bx.v);`,
  },
  {
    id: "VC-07 assignment as a value evaluates the receiver and key before the right-hand side",
    src: `let i = 0;
const a = [0, 0, 0];
const r = (a[i] = (i = 2, 7));
console.log(r, a.join(","), i);
const objs = [{ v: 0 }, { v: 0 }];
let k = 0;
const q = (objs[k]!.v = (k = 1, 4));
console.log(q, JSON.stringify(objs), k);`,
  },
  {
    id: "VC-08 array length writes: truncation, clearing, growth (holes read as undefined)",
    src: `const xs = [1, 2, 3, 4];
xs.length = 2;
console.log(xs.join(","), xs.length);
xs.length = 0;
console.log(xs.length, JSON.stringify(xs));
xs.push(7);
console.log(xs.join(","));
const ys: number[] = [1];
ys.length = 3;
console.log(ys.length, ys[2], ys[0]);
const pending: string[] = ["a", "b"];
for (let n = 0; n < pending.length; n++) console.log(pending[n]);
pending.length = 0;
console.log(pending.length);`,
  },
  {
    id: "VC-09 an invalid array length throws Node's RangeError and leaves the array as it was",
    src: `const xs = [1, 2, 3];
for (const n of [-1, 1.5, 4294967296, NaN]) {
  try {
    xs.length = n;
    console.log("set", n);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message, xs.length);
  }
}`,
  },
  {
    id: "VC-10 process.exitCode = 2: the program runs on and exits with 2",
    src: `console.log("a");
process.exitCode = 2;
console.log("b");`,
    exit: 2,
  },
  {
    id: "VC-11 process.exitCode set then cleared with undefined, and with null: exit 0",
    src: `process.exitCode = 3;
process.exitCode = undefined;
console.log("cleared");
process.exitCode = 4;
process.exitCode = null;
console.log("again");`,
  },
  {
    id: "VC-12 a bare process.exit() exits with the held process.exitCode",
    src: `process.exitCode = 4;
console.log("before");
process.exit();
console.log("never");`,
    exit: 4,
  },
  {
    id: "VC-13 process.exitCode = <non-integer> throws Node's ERR_OUT_OF_RANGE and keeps the earlier code",
    src: `process.exitCode = 6;
for (const v of [1.5, NaN, Infinity, 2 ** 60]) {
  try {
    process.exitCode = v;
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}`,
    exit: 6,
  },
  {
    id: "VC-14 the 'exit' listeners receive the held code at a natural exit",
    src: `process.on("exit", (c) => console.log("exit", c));
process.exitCode = 5;
console.log("end");`,
    exit: 5,
  },
  {
    id: "VC-15 process.exitCode in a top-level-await program: the held code wins over the settled root",
    src: `export {};
await Promise.resolve();
process.exitCode = 7;
console.log("done");`,
    exit: 7,
  },
  {
    id: "VC-16 process.exitCode = <a string> stops by name at build time",
    src: `process.exitCode = "3";
console.log("x");`,
    refusedMsg: "process.exitCode = <a 'string' value>",
  },
  {
    id: "VC-17 an 'exit' listener's exitCode overrides process.exit(4)'s code",
    src: `process.on("exit", () => { process.exitCode = 9; });
console.log("go");
process.exit(4);`,
    exit: 9,
  },
  {
    id: "VC-18 an 'exit' listener's exitCode overrides a bare process.exit()'s held code",
    src: `process.on("exit", () => { process.exitCode = 9; });
process.exitCode = 2;
console.log("go");
process.exit();`,
    exit: 9,
  },
  {
    id: "VC-19 an 'exit' listener clearing exitCode makes process.exit(4) exit 0",
    src: `process.on("exit", () => { process.exitCode = undefined; });
console.log("go");
process.exit(4);`,
  },
  {
    id: "VC-20 at a natural end, an 'exit' listener clearing exitCode keeps the code captured before the listeners (2)",
    src: `process.on("exit", (c) => { console.log("exit", c); process.exitCode = undefined; });
process.exitCode = 2;
console.log("end");`,
    exit: 2,
  },
  {
    id: "VC-21 an 'exit' listener sets exitCode then throws at a natural end: the exit status is the held 5",
    src: `process.on("exit", () => { process.exitCode = 5; throw new Error("in listener"); });
console.log("end");`,
    uncaught: { exit: 5, contains: "in listener" },
  },
  {
    id: "VC-22 the first 'exit' listener throws (the second never runs), exitCode 2: the exit status is 2",
    src: `process.on("exit", () => { throw new Error("A"); });
process.on("exit", () => { process.exitCode = 5; });
process.exitCode = 2;
console.log("end");`,
    uncaught: { exit: 2, contains: "Error: A" },
  },
  {
    id: "VC-23 an uncaught error in main with exitCode 2: exitCode becomes 1, the 'exit' listener sets 5, the exit status is 5",
    src: `process.on("exit", () => { process.exitCode = 5; });
process.exitCode = 2;
console.log("before");
throw new Error("main");`,
    uncaught: { exit: 5, contains: "Error: main" },
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.extra ?? {})) writeFileSync(join(dir, name), text + "\n");
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(row, backend);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (row.refusedMsg !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.some((d) => d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.fence !== undefined) {
    expect(node.exitCode).toBe(0);
    expect(got.exitCode, row.id).not.toBe(0);
    expect(node.stdout.startsWith(got.stdout), row.id).toBe(true);
    expect(got.stderr, row.id).toContain(row.fence);
    return;
  }
  if (row.uncaught !== undefined) {
    expect(node.exitCode, JSON.stringify(node)).toBe(row.uncaught.exit);
    expect(got.exitCode, row.id).toBe(row.uncaught.exit);
    expect(got.stdout, row.id).toBe(node.stdout);
    expect(got.stderr, row.id).toContain(row.uncaught.contains);
    return;
  }
  expect(node.exitCode, JSON.stringify(node)).toBe(row.exit ?? 0);
  expect(got, row.id).toEqual(node);
}

describe("Vue's cheap blockers (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("Vue's cheap blockers (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
