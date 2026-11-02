/* Unit U review round (SEMANTICS.md S119 (a), (h)): what a typed slot
 * holding `undefined` does as a RECEIVER, inside a Map or Set, and under
 * `+`, on the WasmGC lanes.
 *
 *  - a member read or method call on a string or array slot holding it
 *    throws Node's catchable TypeError, text and all (it used to trap
 *    bare: "illegal cast" / "dereferencing a null pointer");
 *  - a Map or Set holds it as a key, value or element of its own (a get
 *    used to trap "illegal cast");
 *  - `+` concatenates "undefined" exactly when a real string is on either
 *    side; where Node's answer is the NUMBER NaN the string-typed result
 *    cannot hold it, so the program ends at a named fence (S122);
 *  - a record or class-instance receiver holding it ends the program at a
 *    named fence (S119 (a)).
 *
 * The exact rows run under Node (spawned at test time) and on the wasm and
 * wasm-native lanes. The fence rows pin the fence line (Node prints NaN or
 * catches the TypeError there). The c and llvm lanes keep S003/S006/S032,
 * so none of this is a corpus program. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-undef-members-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function nodeRun(file: string): Promise<Out> {
  const p = run(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8" });
  p.child.stdin?.end();
  const r = await p;
  return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
}

async function wasmRun(id: string, file: string, trap = false): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  if (trap) {
    const r = await runWasmToTrap(res.binaryPath);
    return { stdout: String(r.stdout), stderr: String(r.stderr).split(file).join("<ROW>"), exitCode: 1 };
  }
  const r = await runWasm(res.binaryPath);
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
}

async function nativeRun(id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  try {
    const p = run(res.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr.split(file).join("<ROW>"), exitCode: err.code };
  }
}

const T = `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }\n`;

const EXACT: { id: string; src: string }[] = [
  { id: "m07-record-field", src: `${T}const ps: { x: number }[] = [];\nt(() => ps[3].x);` },
  { id: "m08-class-field", src: `${T}class C { v = 1; get2() { return this.v * 2; } }\nconst cs: C[] = [];\nt(() => cs[2].v);` },
  { id: "m09-class-method", src: `${T}class C { v = 1; get2() { return this.v * 2; } }\nconst cs: C[] = [];\nt(() => cs[2].get2());` },
  {
    // the review's x3-len / x4-method repros
    id: "m01-capture-members",
    src: `const m = /(a)|(b)/.exec("a")!;
console.log("before");
let r: string;
try { r = "len " + m[2].length; } catch (e) { r = "caught " + (e as Error).message; }
console.log(r);
function parse(v: string) {
  const m = /^(\\d+)\\.(\\d+)(?:-(\\w+))?$/.exec(v);
  if (!m) return "bad";
  try { return m[3].toUpperCase(); } catch (e) { return "no pre: " + (e as Error).message; }
}
console.log(parse("1.2-beta"));
console.log(parse("1.2"));`,
  },
  {
    id: "m02-string-array-receivers",
    src: `${T}const ss: string[] = [];
const aa: number[][] = [];
t(() => aa[5].length);
t(() => aa[5].indexOf(1));
t(() => ss[1].length);
t(() => ss[1].slice(1));
t(() => ss[1].split(","));
t(() => ss[1].includes("x"));
t(() => ss[1].toString());
t(() => aa[2].map((x) => x + 1));
t(() => aa[2].join("-"));
const m = "x".match(/(a)?x/)!;
console.log(m[1]?.length, m[1]?.toUpperCase(), m.slice(1), m.filter((x) => x !== undefined));`,
  },
  {
    // the review's y5 / y7 / y8, and the rest of the Map/Set surface
    id: "m03-map-set",
    src: `const ss: string[] = [];
const ns: number[] = [];
const bs: boolean[] = [];
const cap = "x".match(/(a)?x/)!;
const m = new Map<string, string>([["k", ss[3]], ["j", "v"], ["c", cap[1]]]);
console.log(m.get("k"), m.has("k"), m.size, m.get("j"), m.get("zz"), m.get("c"));
const g = m.get("k");
console.log(g, g === undefined, g ?? "dflt");
console.log([...m.values()], [...m.keys()], [...m.entries()]);
console.log(m);
m.forEach((v, k) => console.log(k, v, typeof v));
const mk = new Map<string, number>();
mk.set(ss[1], 5);
console.log(mk.get(ss[2]), mk.has(ss[0]), mk.has("undefined"), [...mk.keys()]);
const mn = new Map<string, number>([["a", ns[4]]]);
console.log(mn.get("a"), mn.has("a"), mn.get("a") ?? -1);
const mb = new Map<number, boolean>([[1, bs[3]]]);
console.log(mb.get(1), mb.has(1), mb.get(1) === undefined);
const st = new Set<string>(["a", ss[9], ss[8]]);
console.log(st.size, st.has(ss[0]), [...st], st);
const sn = new Set<number>([ns[1], 1, ns[2]]);
console.log(sn.size, sn.has(ns[0]), sn.has(NaN), [...sn]);
console.log(JSON.stringify([...st]), JSON.stringify([...m.values()]));
const us: (number | string)[] = [1];
const mu = new Map<string, number | string>([["k", us[3]]]);
console.log(mu.get("k"), mu.has("k"), mu.get("k") === undefined);
const recs: { a: number }[] = [];
const mr = new Map<string, { a: number }>([["r", recs[2]]]);
console.log(mr.get("r"), mr.get("r")?.a, mr.has("r"));`,
  },
  {
    // `+` with a real string on a side concatenates "undefined"
    id: "m04-plus-concat",
    src: `const xs: string[] = ["a"];
const n: number[] = [];
const b: boolean[] = [];
console.log(xs[3] + "s", "s" + xs[3], xs[0] + 1, xs[0] + xs[3], xs[3] + xs[0], \`\${xs[3]}!\`);
console.log(n[2] + "s", "p" + n[4], b[1] + "q", xs[0] + true);
let s = "";
for (let i = 0; i < 3; i++) s += i;
console.log(s);
let u = xs[5];
u += "z";
console.log(u);
class K { f = "k"; }
const k = new K();
k.f += 2;
console.log(k.f);`,
  },
  {
    // a BINDING (a variable, a field of one) holding undefined as the
    // receiver: the backend tests the binding's value slot — no trap
    id: "m05-binding-receivers",
    src: `${T}const m = /(a)|(b)/.exec("a")!;
const p = m[2];
try { console.log(p.length); } catch (e) { console.log("caught", (e as Error).message); }
const ss: string[] = [];
const aa: number[][] = [];
const s = ss[3];
const a = aa[2];
t(() => s.slice(1));
t(() => s.toUpperCase());
t(() => s.charCodeAt(0));
t(() => s[0]);
t(() => a.length);
t(() => a.indexOf(1));
t(() => a.map((x) => x));
t(() => a[0]);
class H { s: string = ss[1]; a: number[] = aa[1]; }
const h = new H();
t(() => h.s.length);
t(() => h.a.length);
function f(q: string) { try { return q.length; } catch (e) { return "caught " + (e as Error).message; } }
console.log(f(ss[2]));`,
  },
  {
    // iterating, spreading, destructuring and calling an undefined slot:
    // V8's own TypeError texts
    id: "m06-not-iterable-not-a-function",
    src: `function t(f: () => void) { try { f(); console.log("ok"); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const ss: string[] = [];
const aa: number[][] = [];
const fs: (() => number)[] = [];
const s = ss[3];
const a = aa[2];
t(() => { for (const ch of s) console.log(ch); });
t(() => { for (const c of ss[3]) console.log(c); });
t(() => { for (const x of aa[1]) console.log(x); });
const o = { s: ss[2] };
t(() => { for (const c of o.s) console.log(c); });
function get(): string { return ss[9]; }
t(() => { for (const c of get()) console.log(c); });
t(() => { console.log([...a]); });
t(() => { console.log([...s]); });
t(() => { const [x, y] = ss[1]; console.log(x, y); });
t(() => { console.log(Array.from(ss[2])); });
t(() => { const [x, y] = aa[1]; console.log(x, y); });
t(() => { const b = aa[3]; const [x] = b; console.log(x); });
const f = fs[0];
t(() => { console.log(f()); });`,
  },
];

const PLUS_FENCE = (line: number): string =>
  "tsinter: unsupported: '+' of a string-typed value holding undefined and a non-string (Node answers the number NaN, " +
  `which this string-typed result cannot hold — SEMANTICS.md S119) [SC1090 at <ROW>:${line}]\n`;

const FENCED: { id: string; src: string; stdout: string; stderr: string }[] = [
  // Node prints "NaN NaN NaN\nundefineds\n" (the review's y6)
  { id: "f01-plus-number", src: `const xs: string[] = [];\nconsole.log("before");\nconsole.log(xs[3] + 1);`, stdout: "before\n", stderr: PLUS_FENCE(3) },
  { id: "f02-plus-boolean", src: `const xs: string[] = [];\nconsole.log(xs[3] + true);`, stdout: "", stderr: PLUS_FENCE(2) },
  { id: "f03-plus-both-undefined", src: `const xs: string[] = [];\nconsole.log(xs[3] + xs[4]);`, stdout: "", stderr: PLUS_FENCE(2) },
  { id: "f04-plus-capture", src: `const m = "x".match(/(a)?x/)!;\nconsole.log(m[1] + 1);`, stdout: "", stderr: PLUS_FENCE(2) },
  { id: "f05-plus-compound", src: `const xs: string[] = [];\nlet s = xs[2];\ns += 1;\nconsole.log(s);`, stdout: "", stderr: PLUS_FENCE(3) },
];

describe("S119 (a)/(h): undefined receivers, Map/Set, `+` (wasm lane vs Node)", () => {
  test.for(EXACT.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, row.src + "\n");
    const [node, wasm] = await Promise.all([nodeRun(file), wasmRun(id, file)]);
    expect(wasm).toEqual(node);
  });
  test.for(FENCED.map((r) => [r.id, r] as const))("%s (fence)", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, row.src + "\n");
    expect(await wasmRun(id, file, true)).toEqual({ stdout: row.stdout, stderr: row.stderr, exitCode: 1 });
  });
});

describe("S119 (a)/(h): the same rows on the wasm-native lane", () => {
  test.for(EXACT.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    const [node, wn] = await Promise.all([nodeRun(file), nativeRun(id, file)]);
    expect(wn).toEqual(node);
  }, 600_000);
  test.for(FENCED.map((r) => [r.id, r] as const))("%s (fence)", async ([id, row]) => {
    const file = join(scratch, `${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    expect(await nativeRun(id, file)).toEqual({ stdout: row.stdout, stderr: row.stderr + "RuntimeError: unreachable\n", exitCode: 1 });
  }, 600_000);
});
