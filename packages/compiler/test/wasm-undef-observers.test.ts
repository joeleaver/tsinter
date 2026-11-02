/* GH #101-#105: the observers of a typed slot holding undefined that the
 * GH #86 unit left answering as if a value were there, trapping bare, or
 * out of Node's order — and the neighbouring paths the same bug class
 * reached (other conversions, other builtins, callbacks; through `!`,
 * `as`, returns, bindings, closures, generators and async). An exact row
 * equals Node (spawned at test time) on the wasm and wasm-native lanes; a
 * `fence` row is one where Node answers and this tier stops by name
 * (SEMANTICS.md S015, S119, S122). The helpers are
 * wasm-review-repros.test.ts's. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-undef-observers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function wasmRun(id: string, file: string, trap: boolean): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await (trap ? runWasmToTrap : runWasm)(res.binaryPath);
  return { stdout: String(r.stdout), stderr: String(r.stderr).split(file).join("<ROW>"), exitCode: trap ? 1 : r.exitCode };
}

async function nativeRun(id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  try {
    const p = run(res.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr.split(file).join("<ROW>"), exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr.split(file).join("<ROW>"), exitCode: err.code };
  }
}

const PROTO_FENCE = /^tsinter: unsupported: 'in' with a key naming an Object\.prototype member the object does not own \(Node answers true through the prototype chain, which this tier does not model — SEMANTICS\.md S015\) \[SC1090( at <ROW>:\d+)?\]\n$/;

interface Row {
  id: string;
  src: string;
  /** absent: the row equals Node */
  fence?: { stdout: string; stderr: RegExp };
}

const ROWS: Row[] = [
  {
    id: "101-record-conversions",
    src: `// GH #101: a record slot holding undefined converts as undefined
const rs: { x: number }[] = []; const r = rs[0];
console.log(\`\${r}\`, String(r), JSON.stringify(r));
console.log(\`\${rs[1]}\`, String(rs[1]), JSON.stringify(rs[1]));
console.log("" + rs[0], rs[0] + "", "a" + rs[0] + "b");
let s = "q"; s += rs[0]; console.log(s);
function get(i: number) { return rs[i]; }
console.log(\`\${get(0)}\`, String(get(0)), JSON.stringify(get(0)));
const m = new Map<string, { x: number }>();
console.log(\`\${m.get("q")!}\`, String(m.get("q") as { x: number }), JSON.stringify(m.get("q")!));
const ok = { x: 1 };
console.log(\`\${ok}\`, String(ok), JSON.stringify(ok));`,
  },
  {
    id: "101-array-conversions",
    src: `const aa: number[][] = []; const a = aa[0];
console.log(\`\${a}\`, String(a), JSON.stringify(a));
console.log("" + aa[0], aa[0] + "", "a" + aa[0] + "b");
let s = "q"; s += aa[0]; console.log(s);
const ss: string[][] = [];
console.log(JSON.stringify(ss[0]), JSON.stringify(ss[1]), JSON.stringify(ss[0], null, 1), \`\${[1, 2]}\`);`,
  },
  {
    id: "101-class-conversions",
    src: `class C { v = 1; }
const cs: C[] = []; const c = cs[0];
console.log(typeof c, !c, c ? 1 : 2, c === undefined);
console.log(c, [c]);`,
  },
  {
    id: "101-for-in",
    src: `const rs: { x: number }[] = []; const r = rs[0];
for (const k in r) console.log("key", k);
for (const k in rs[1]) console.log("key", k);
const aa: number[][] = [];
for (const k in aa[2]) console.log("key", k);
const ms: Record<string, number>[] = [];
for (const k in ms[0]) console.log("key", k);
function keys(o: Record<string, number>) { const out: string[] = []; for (const k in o) out.push(k); return out; }
console.log(keys(ms[1]), keys({ a: 1 }));
function idx(x: number[]) { const out: string[] = []; for (const k in x) out.push(k); return out; }
console.log(idx(aa[3]), idx([5, 6]));
for (const k in { y: 2 }) console.log("key", k);
console.log("end");`,
  },
  {
    id: "101-isarray",
    src: `const aa: number[][] = []; const a = aa[0];
const one = [1];
console.log(Array.isArray(a), Array.isArray(aa[1]), Array.isArray(one));
const b = aa[1]!;
console.log(Array.isArray(b));
const [first] = [aa[0]];
const { p } = { p: aa[1] };
console.log(Array.isArray(first), Array.isArray(p));
function f(x: number[]) { return Array.isArray(x); }
console.log(f(aa[2]), f([3]));`,
  },
  {
    id: "101-instanceof",
    src: `class C { v = 1; }
class D extends C {}
class S { w = 2; }
const cs: C[] = []; const c = cs[0];
const nd = new D();
console.log(c instanceof C, cs[1] instanceof C, nd instanceof C);
const ds: D[] = []; const d = ds[0];
console.log(d instanceof C, d instanceof D);
const es: Error[] = []; const e = es[0];
const ne = new Error("x");
console.log(e instanceof Error, ne instanceof Error);
const ss: S[] = [];
const ns = new S();
console.log(ss[0] instanceof S, ns instanceof S);
function isC(x: C) { return x instanceof C; }
console.log(isC(cs[2]), isC(new C()), cs[3]! instanceof C, (cs[4] as C) instanceof C);
const res: RegExp[] = []; const re = res[0];
console.log(re instanceof RegExp);`,
  },
  {
    id: "101-through-forms",
    src: `const rs: { a: number }[] = [];
const v = rs[0]!;
const w = rs[1] as { a: number };
console.log(\`\${v}|\${w}\`, JSON.stringify(v), String(w));
const cl = () => \`\${rs[2]}\`;
console.log(cl());
async function af() { const r = await Promise.resolve(rs[3]); return JSON.stringify(r) + String(r); }
af().then((x) => console.log(x));
function* g() { const r: { a: number } = rs[4]; yield \`\${r}\`; yield JSON.stringify(r) ?? "U"; }
for (const s of g()) console.log(s);`,
  },
  {
    id: "101-format",
    src: `import * as util from "node:util";
const rs: { x: number }[] = []; const aa: number[][] = []; const xs: string[] = [];
console.log(util.format("%s|%j|%O|%d", rs[0], rs[1], aa[1], xs[0]));
console.log(util.format("%s %s", xs[0], aa[2]), util.inspect(rs[2]), util.inspect(xs[1]));
console.log("%s|%j|%O", rs[3], aa[3], rs[4]);`,
  },
  {
    id: "101-delete-assign",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const rs: { x?: number }[] = [];
t(() => { delete rs[0].x; return "deleted"; });
const ms: Record<string, number>[] = [];
let k = "a"; k += "";
t(() => { delete ms[0][k]; return "deleted"; });
t(() => { delete ms[0]["b"]; return "deleted"; });
const qs: { x: number }[] = [];
t(() => Object.assign({ x: 1 }, qs[1]));
t(() => Object.assign({ x: 1 }, qs[1], { x: 2 }));`,
  },
  {
    id: "102-json-top",
    src: `const xs: string[] = []; const ns: number[] = []; const bs: boolean[] = [];
console.log(JSON.stringify(xs[3]), JSON.stringify(ns[3]), JSON.stringify(bs[3]));
console.log(typeof JSON.stringify(xs[3]), JSON.stringify(ns[0], null, 2) === undefined, \`\${JSON.stringify(ns[1])}\`);
const rs: { x: number }[] = [];
const f = () => rs[0];
const v = f();
console.log(JSON.stringify(v, null, 2), JSON.stringify([v]), JSON.stringify({ v }), JSON.stringify("s"), JSON.stringify(1));`,
  },
  {
    id: "102-json-dyn-root",
    src: `const o: any = JSON.parse("{}");
const j = JSON.stringify(o.x);
console.log(typeof j, j === undefined, j, JSON.stringify(o), JSON.stringify(o.x, null, 2));
const fnBox: any = JSON.parse("[1]");
console.log(JSON.stringify(fnBox), JSON.stringify(JSON.parse("null")));`,
  },
  {
    id: "102-format-j",
    src: `const xs: string[] = []; const ns: number[] = []; const bs: boolean[] = [];
console.log("%j|%j|%j", xs[3], ns[3], bs[3]);
console.log("%s %d %i %f %j %o %O", xs[1], xs[1], xs[1], xs[1], xs[1], xs[1], xs[1]);
console.log("%s %d %i %f %j %o %O", ns[1], ns[1], ns[1], ns[1], ns[1], ns[1], ns[1]);
console.log("%s %d %j %o", bs[1], bs[1], bs[1], bs[1]);
console.log("%s %d %j", "a", 2, [1]);`,
  },
  {
    id: "102-error-message",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const xs: string[] = [];
console.log(JSON.stringify(new Error(xs[3]).message), new Error(xs[3]).message.length);
class E extends Error { constructor(m: string) { super(m); } }
console.log(JSON.stringify(new E(xs[3]).message), String(new TypeError(xs[2])), String(new E(xs[1])));
t(() => new RangeError(xs[1]).message); t(() => String(new SyntaxError(xs[1])));`,
  },
  {
    id: "103-in-dyn-null",
    src: `const d: any = JSON.parse("null");
try { console.log("a" in d); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const counts: any = JSON.parse("{}");
console.log("a" in counts, "a" in JSON.parse('{"a":0}'));
function has(o: any): boolean { return "length" in o; }
try { console.log(has([1]), has("str")); } catch (e) { console.log((e as Error).message); }
try { console.log(has(d)); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "103-in-dyn-kinds",
    src: `const vals: unknown = JSON.parse('[null, 1, "s", true, {"a": 1}, {}, [1]]');
const list = vals as unknown[];
list.push(undefined);
for (const v of list) {
  const d: any = v;
  try { console.log("a" in d, "0" in d); } catch (e) { console.log((e as Error).name, (e as Error).message); }
}
let k = "a"; k += "";
for (const v of list) {
  const d: any = v;
  try { console.log(k in d); } catch (e) { console.log((e as Error).message); }
}`,
  },
  {
    id: "104-global-functions",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const xs: string[] = []; const u = xs[3];
t(() => parseInt(u)); t(() => parseFloat(u)); t(() => parseInt(u, 16));
t(() => encodeURIComponent(u)); t(() => decodeURIComponent(u)); t(() => encodeURI(u));
t(() => JSON.parse(u));
t(() => Symbol.for(u).toString());`,
  },
  {
    id: "104-regexp",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const xs: string[] = []; const u = xs[3];
t(() => new RegExp(u).source); t(() => new RegExp("a", u).flags); t(() => new RegExp(u).test("x"));
t(() => /undefined/.test(u)); t(() => /x/.exec(u)); t(() => /fin/.exec(u)?.[0]);
const re = /e(d)/g;
t(() => re.test(u)); t(() => re.lastIndex);`,
  },
  {
    id: "104-replace",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const xs: string[] = []; const u = xs[3];
const s = "xundefinedy";
t(() => s.replace(u, "Q")); t(() => s.replace("x", u)); t(() => s.replaceAll(u, "R")); t(() => s.replaceAll("y", u));
t(() => s.replace(/x/, u)); t(() => s.replace(/y/g, u));
const map: Record<string, string> = { a: "A" };
console.log("a-b".replace(/a|b/g, (m) => map[m]), "a-b".replace("b", (m) => map[m]), "a-b".replaceAll("a", () => map.q));`,
  },
  {
    id: "104-error-and-keys",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const xs: string[] = []; const u = xs[3];
t(() => new Error(u).message); t(() => ({ [u]: 1 }));
const r: Record<string, number> = { a: 1, [u]: 2 };
console.log(r, Object.keys(r));
type R = { a: number; [k: string]: number };
const rs: R[] = [{ a: 1, undefined: 2 }];
let k = "zz"; k += "";
t(() => k in rs[1]);
t(() => [u in rs[0], k in rs[0]]);
t(() => u in rs[1]);`,
  },
  {
    id: "104-concat-spread",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const aa: number[][] = []; const a = aa[0];
t(() => [1].concat(a)); t(() => [1].concat(a, [2], aa[1])); t(() => String(a)); t(() => \`\${a}\`);
t(() => new Set(a).size); t(() => Math.max(...a)); t(() => Math.min(...aa[1]));
function f(...x: number[]) { return x.length; }
t(() => f(...a)); t(() => f(1, ...aa[2]));
const xs = [1];
t(() => xs.push(...a)); t(() => xs.length);
t(() => String.fromCharCode(...a));
const mm: [string, number][][] = [];
console.log(new Map(mm[0]).size);
const bb: string[][] = [];
console.log(new Set(bb[0]).size);`,
  },
  {
    id: "104-console-format",
    src: `const xs: string[] = []; const u = xs[3];
console.log("%s %d %i %f %j %o %O", u, u, u, u, u, u, u);
const ns: number[] = []; const n = ns[3];
console.log("%s %d %i %f %j %o %O", n, n, n, n, n, n, n);`,
  },
  {
    id: "104-throw",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log(typeof e, e); } }
const xs: string[] = []; const ns: number[] = [];
t(() => { throw xs[3]; });
t(() => { throw ns[3]; });
t(() => { throw "x"; });
const es: Error[] = [];
t(() => { throw es[0]; });
async function af() { throw xs[1]; }
af().catch((e: unknown) => console.log("async", typeof e, e));`,
  },
  {
    id: "104-buffer-text-url",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const xs: string[] = [];
t(() => Buffer.from(xs[0]).length);
t(() => Buffer.byteLength(xs[0]));
t(() => new TextEncoder().encode(xs[0]).length);
t(() => btoa(xs[0]));
t(() => new URL(xs[0]).href);
t(() => new URL("a", xs[0]).href);
t(() => new URL(xs[0], "http://x/").href);
t(() => new URL("http://h/p", xs[1]).href);
t(() => process.stdout.write(xs[0]));
t(() => process.stderr.write(xs[0]));`,
  },
  {
    id: "105-arg-order",
    src: `import * as path from "node:path";
function log(s: string): string { console.log("arg", s); return s; }
const d: any = JSON.parse("1");
const e: any = JSON.parse("true");
function t(f: () => unknown) { try { console.log(f()); } catch (x) { console.log((x as Error).name, (x as Error).message); } }
t(() => path.join(d, log("b")));
t(() => path.join("a", d, log("c"), e));
t(() => path.resolve(log("r"), d, log("s")));
t(() => path.relative(d, log("t")));
t(() => path.relative(log("u"), e));
const xs: string[] = [];
t(() => path.join(xs[0], log("v")));
t(() => path.basename(d, log("w")));
t(() => path.join(log("x"), "y"));`,
  },
  {
    id: "104-hof-callbacks",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const fs: ((x: number) => number)[] = [];
const ps: ((x: number) => boolean)[] = [];
const rs: ((a: number, b: number) => number)[] = [];
let n = 0; const z = () => { n++; return 0; };
t(() => [1, 2].map(fs[0]));
t(() => [1, 2].filter(ps[0]));
t(() => [1, 2].forEach(fs[0]));
t(() => [1, 2].find(ps[0]));
t(() => [1, 2].findIndex(ps[0]));
t(() => [1, 2].some(ps[0]));
t(() => [1, 2].every(ps[0]));
t(() => [1, 2].flatMap(fs[0]));
t(() => [1, 2].reduce(rs[0]));
t(() => [1, 2].reduce(rs[0], z()));
console.log(n);
t(() => [3, 1, 2].sort(rs[1]));
const ok = (x: number) => x * 2;
t(() => [1, 2].map(ok));`,
  },
  {
    id: "104-timer-callbacks",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const fs: (() => void)[] = [];
function log(n: number): number { console.log("ms", n); return n; }
t(() => setTimeout(fs[0], 0));
t(() => setTimeout(fs[0], log(5)));
t(() => setInterval(fs[0], log(6)));
t(() => setImmediate(fs[0]));
t(() => queueMicrotask(fs[0]));
t(() => process.nextTick(fs[0]));
const ok = () => console.log("fired");
setTimeout(ok, 0);`,
  },
  {
    id: "104-emitter-listeners",
    src: `import { EventEmitter } from "node:events";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const fs: (() => void)[] = [];
const em = new EventEmitter();
t(() => em.on("x", fs[0]).listenerCount("x"));
t(() => em.once("x", fs[0]).listenerCount("x"));
t(() => em.off("x", fs[0]).listenerCount("x"));
const ok = () => console.log("got x");
em.on("x", ok);
em.emit("x");`,
  },
  {
    id: "104-map-set-foreach",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const fs: ((v: number, k: string) => void)[] = [];
const gs: ((v: string) => void)[] = [];
t(() => new Map<string, number>([["a", 1]]).forEach(fs[0]));
t(() => new Set<string>(["a"]).forEach(gs[0]));`,
  },
  {
    id: "104-replace-callback",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const fs: ((m: string) => string)[] = [];
t(() => "ab".replace("a", fs[0]));
t(() => "ab".replace(/b/, fs[0]));`,
  },
  {
    id: "103-in-word-count",
    src: `const text = "the cat and the hat and the bat";
const counts: Record<string, number> = {};
for (const k of text.split(" ")) { if (k in counts) counts[k] = counts[k] + 1; else counts[k] = 1; }
console.log(counts);
const d: any = JSON.parse('{"a":1,"toString":2}');
let w = "a"; w += "";
let z = "zz"; z += "";
let t = "toString"; t += "";
console.log(w in d, z in d, t in d, "a" in d, "toString" in d, "b" in d);
const r = { constructor: 1, x: 2 };
console.log("constructor" in r, "x" in r, "y" in r);
type H = { n: number; [k: string]: number };
const hs: H = { n: 1, valueOf: 3 };
let v = "valueOf"; v += "";
let q = "q"; q += "";
console.log(v in hs, q in hs);`,
  },
  {
    id: "104-timer-arg-order",
    src: `function log(s: string): number { console.log("eval", s); return 0; }
function cb(a: unknown) { console.log("fired", a); }
setTimeout(cb, log("ms"), log("arg"));
const h = setInterval(cb, log("ms2"), log("arg2"));
clearInterval(h);
setImmediate(cb, log("arg3"));`,
  },
  {
    id: "rv-o1-receiver-then-subject",
    src: `const lines: string[] = ["abc"];
let idx = 0;
let cur = lines[5];
const re = /b/;
function adv(): RegExp { cur = lines[idx++]; return re; }
console.log(adv().test(cur));
cur = lines[5]; idx = 0;
const m = adv().exec(cur);
console.log(m === null ? "null" : m[0]);`,
  },
  {
    id: "rv-o2-error-regex-slots",
    src: `const errs: Error[] = [new Error("boom"), new TypeError("bad")];
console.log(\`\${errs[0]}\`, String(errs[1]), "" + errs[2], \`\${errs[3]}\`);
let log = "";
for (let i = 0; i < 3; i++) log += errs[i] + ";";
console.log(log);
const res: RegExp[] = [/a+/g];
const r0 = res[0], r1 = res[1];
console.log(r1 instanceof RegExp, r0 instanceof RegExp);`,
  },
  {
    id: "rv-o3-subject-undefined-by-receiver",
    src: `const lines: string[] = ["undefined line"];
let idx = 0;
let cur = lines[0];
const re = /undef/;
function adv(): RegExp { cur = lines[++idx]; return re; }
console.log(adv().test(cur));`,
  },
  {
    id: "rv-q1-format-and-text",
    src: `const ys: string[] = ["a"];
const rs: { a: number }[] = [{ a: 1 }];
const bs: boolean[] = [];
console.log("%o|%O|%o|%O|%i|%f|%j", ys[3], ys[4], rs[3], rs[4], bs[0], bs[1], rs[6]);
console.log("%s|%s|%d", rs[7], bs[2], ys[0]);
console.log(Symbol.for(ys[3]).toString(), String.raw\`a\${ys[3]}b\`, new TextEncoder().encode(ys[3]).length);
console.log(new URL("http://x/y", ys[4]).href);`,
  },
  {
    id: "rv-q2-record-observers",
    src: `const rs: { a: number; b: string }[] = [];
const as: number[][] = [];
const r = rs[0];
function t(label: string, f: () => unknown) { try { console.log(label, f()); } catch (e) { console.log(label, "E", (e as Error).message); } }
t("keys", () => Object.keys(r));
t("values", () => Object.values(r));
t("entries", () => Object.entries(r));
t("spread", () => ({ ...r }));
t("spread2", () => ({ ...r, c: 1 }));
t("assign", () => Object.assign({ a: 0, b: "" }, r));
t("arrspread", () => [...as[0]]);
t("forof", () => { let n = 0; for (const x of as[0]) n += x; return n; });
t("hasOwn", () => Object.hasOwn(r, "a"));
t("eq", () => r === undefined);
t("nullish", () => (r ?? { a: 9, b: "z" }).a);
t("optchain", () => r?.a);
t("concat", () => "r=" + r);
t("ab", () => [1, 2].concat(as[0], as[0]));
t("stringify-arr", () => JSON.stringify([r, as[0]]));
t("stringify-rec", () => JSON.stringify({ r, x: as[0] }));`,
  },
  {
    id: "rv-s9-plain-literal-order",
    src: `const a = { port: 1, z: 2 };
const b = { host: "x", port: 3 };
const m = { ...a, ...b };
const plain = { z: 5, host: "y", port: 4 };
console.log(JSON.stringify(plain));
console.log(Object.keys(plain).join(","));`,
  },
  {
    id: "rv-reduce-order",
    src: `function log<T>(s: string, v: T): T { console.log("eval", s); return v; }
const fs: ((a: number, b: number) => number)[] = [];
try { log("recv", [1, 2]).reduce(log("fn", fs[0]), log("init", 0)); } catch (e) { console.log((e as Error).message); }
console.log(log("recv2", [1, 2]).reduce(log("fn2", (a: number, b: number) => a + b), log("init2", 10)));`,
  },
  {
    // Node treats a then/finally handler holding undefined as absent; the
    // handler is decided statically here, so it stops by name (S119).
    id: "104-promise-handler-fence",
    src: `const fs: ((v: number) => number)[] = [];
Promise.resolve(1).then(fs[0]).then((v) => console.log("then passes", v));`,
    fence: { stdout: "", stderr: /^tsinter: unsupported: a promise handler holding undefined \(Node treats it as absent and passes the settlement through — SEMANTICS\.md S119\) \[SC1090 at <ROW>:2\]\n$/ },
  },
  // S015 (lead ruling): `in` with a key naming an Object.prototype member
  // the object does not own stops by name — Node answers true.
  {
    id: "103-proto-word-count-fence",
    src: `const text = "a constructor b";
const counts: Record<string, number> = {};
console.log("start");
for (const k of text.split(" ")) { if (k in counts) counts[k] = counts[k] + 1; else counts[k] = 1; }
console.log(counts);`,
    fence: { stdout: "start\n", stderr: PROTO_FENCE },
  },
  {
    id: "103-proto-dyn-literal-fence",
    src: `const d: any = JSON.parse("{}");
console.log("before");
console.log("constructor" in d);`,
    fence: { stdout: "before\n", stderr: PROTO_FENCE },
  },
  {
    id: "103-proto-record-literal-fence",
    src: `const r = { x: 1 };
console.log("before");
console.log("toString" in r);`,
    fence: { stdout: "before\n", stderr: PROTO_FENCE },
  },
  {
    id: "103-proto-dyn-runtime-fence",
    src: `const d: any = JSON.parse('{"a":1}');
let k = "valueOf"; k += "";
console.log("a" in d);
console.log(k in d);`,
    fence: { stdout: "true\n", stderr: PROTO_FENCE },
  },
  {
    id: "103-proto-optional-field-fence",
    src: `type O = { toString?: () => string; a: number };
const o: O = { a: 1 };
console.log("before");
console.log("toString" in o);`,
    fence: { stdout: "before\n", stderr: PROTO_FENCE },
  },
  {
    id: "103-proto-env-fence",
    src: `console.log("before");
console.log("toString" in process.env);`,
    fence: { stdout: "before\n", stderr: PROTO_FENCE },
  },
];

function expectRow(row: Row, got: Out, node: Out, trapText: string): void {
  if (row.fence === undefined) {
    expect(node.exitCode).toBe(0);
    expect(got).toEqual(node);
    return;
  }
  expect(node.exitCode).toBe(0);
  expect(got.stdout).toBe(row.fence.stdout);
  expect(got.exitCode).toBe(1);
  const stderr = trapText !== "" && got.stderr.endsWith(trapText) ? got.stderr.slice(0, -trapText.length) : got.stderr;
  expect(stderr).toMatch(row.fence.stderr);
}

describe("GH #101-#105: undefined-slot observers (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, row.src + "\n");
    expectRow(row, await wasmRun(id, file, row.fence !== undefined), nodeRun(file), "");
  });
});

describe("GH #101-#105: undefined-slot observers (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    expectRow(row, await nativeRun(id, file), nodeRun(file), "RuntimeError: unreachable\n");
  }, 600_000);
});
