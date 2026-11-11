/* GH #120, unit U0 (SEMANTICS.md S125 (c), S014): the checked-dynamic
 * world (`unknown`, `object`, and `any` outside `--dynamic`) copies at both
 * of its edges — a typed composite entering a dynamic slot, a dynamic value
 * cast or checked back out into a typed composite, and a typed function
 * boxed into a dynamic value (its composite parameters and result cross as
 * copies). JavaScript shares the object at each. Until unit U1 merges the
 * dynamic worlds, every such copy the program could observe refuses by name
 * at compile time, and the copies nothing can observe still run.
 *
 * An exact row equals Node (spawned at test time) on the wasm and
 * wasm-native lanes; a `refused` row compiles to SC1090 naming S125 on both,
 * with the crossing kind named. The helpers are wasm-width-identity's. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-dyn-copies-"));
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

const KIND = {
  in: /^a '.*' value converted to a dynamic \('unknown', 'any' or 'object'\) value: /,
  out: /^a dynamic \('unknown', 'any' or 'object'\) value checked into '.*': /,
  fn: /^a (function crossing into a dynamic value, its (parameter '.*'|result) typed '.*'|'.*' function crossing (into|out of) a dynamic value \(its composite arguments and result cross as copies\)): /,
} as const;
const TAIL = /it would be a COPY where JavaScript shares the object, and .* \(SEMANTICS\.md S125\) (is|are) not supported yet$/;

type Built = { ok: true; path: string } | { ok: false; diags: { code: string; message: string }[] };

async function build(id: string, file: string, backend: "wasm" | "wasm-native"): Promise<Built> {
  const dir = join(scratch, `${id}-${backend}`);
  const res = await compile(file, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) return { ok: false, diags: res.diagnostics.map((d) => ({ code: d.code, message: d.message })) };
  return { ok: true, path: res.binaryPath! };
}

async function wasmRun(path: string): Promise<Out> {
  const r = await runWasm(path);
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
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

interface Row {
  id: string;
  src: string;
  /** The copy the program could observe refuses by name: which crossing
   * kind the (first) diagnostic names. Absent: the row compiles and
   * equals Node. */
  refused?: keyof typeof KIND;
}

const ROWS: Row[] = [
  // ── observable: refused ────────────────────────────────────────────
  // #120, both forms: a write through a cast of an `unknown` value.
  { id: "issue-120-array", src: `const u: unknown = [1]; (u as number[]).push(2); console.log(u);` } /* U2a: the dynamic arm, matches Node */,
  { id: "issue-120-record", src: `const w: unknown = { k: 1 }; (w as { k: number }).k = 3; console.log(w);` } /* U2a: the dynamic arm, matches Node */,
  {
    id: "out-binding-write",
    src: `const u: unknown = JSON.parse('{"k":1}');
const t = u as { k: number };
t.k = 2;
console.log(u);`,
    // U2a: the dynamic arm, matches Node
  },
  {
    id: "out-nested-write",
    src: `const d: unknown = JSON.parse('{"xs":[1]}');
const keep = d;
(d as { xs: number[] }).xs.push(2);
console.log(keep);`,
    // U2a: the dynamic arm, matches Node
  },
  {
    id: "out-dyn-write-after",
    src: `const d: any = JSON.parse('{"k":1}');
const t = d as { k: number };
d.k = 7;
console.log(t.k, d.k);`,
    // U2a: the dynamic arm, matches Node
  },
  {
    id: "out-identity",
    src: `const r = { n: 1 };
const u: unknown = r;
console.log((u as { n: number }) === r);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // A round trip through an `unknown` binding, then the original is written.
  {
    id: "roundtrip-orig-write",
    src: `const r = { n: 1 };
const u: unknown = r;
const t = u as { n: number };
r.n = 2;
console.log(t.n);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // A fresh dynamic object written through an alias of it, after a copy
  // was checked out of it.
  {
    id: "out-fresh-aliased-write",
    src: `const d: any = JSON.parse('{"k":1}');
const alias = d;
const t = alias as { k: number };
d.k = 7;
console.log(t.k);`,
    // U2a: the dynamic arm, matches Node
  },
  // A typed value into `any`, written through the dynamic side.
  { id: "in-any-write", src: `const r = { a: 1 }; const a: any = r; a.a = 2; console.log(r.a);` } /* U1a: shared now, matches Node */,
  // A typed array into `unknown`, pushed to afterwards.
  { id: "in-later-push", src: `const xs = [1, 2]; const u: unknown = xs; xs.push(3); console.log(u);` } /* U1a: shared now, matches Node */,
  { id: "in-later-write", src: `const r = { n: 1 };\nconst u: unknown = r;\nr.n = 2;\nconsole.log(u);` } /* U1a: shared now, matches Node */,
  { id: "in-object-slot", src: `const xs = [1, 2];\nconst o: object = xs;\nxs.push(3);\nconsole.log(o);` } /* U1a: shared now, matches Node */,
  {
    id: "in-nested-shared",
    src: `const shared = { n: 1 };
const u: unknown = { inner: shared };
shared.n = 2;
console.log(u);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  { id: "in-param-write", src: `function bump(x: any) { x.n = 5; }\nconst r = { n: 1 };\nbump(r);\nconsole.log(r.n);` } /* U1a: shared now, matches Node */,
  {
    id: "in-dynamic-call-write",
    src: `const bump: any = (x: any) => { x.n = 5; };
const r = { n: 1 };
bump(r);
console.log(r.n);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  {
    id: "in-listener-write",
    src: `import { EventEmitter } from "node:events";
const ee = new EventEmitter();
ee.on("e", (x: any) => { x.n = 5; });
const r = { n: 1 };
ee.emit("e", r);
console.log(r.n);`,
    refused: "fn",
  },
  {
    id: "in-identity",
    src: `const r = { n: 1 };
const a: unknown = r;
const b: unknown = r;
console.log(a === b);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  {
    id: "in-pushed-into-dynamic",
    src: `const r = { n: 1 };
const list: any = JSON.parse("[]");
list.push(r);
r.n = 2;
console.log(list);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // A typed callback parameter on a dynamic call receives a copy.
  {
    id: "fn-param-write",
    src: `const data: any = JSON.parse('[{"a":1}]'); data.forEach((o: { a: number }) => { o.a = 2; }); console.log(data);`,
    // U2a: the parameter holds the dynamic argument, matches Node
  },
  {
    id: "fn-param-identity",
    src: `const seen: { a: number }[] = [];
const data: any = JSON.parse('[{"a":1}]');
data.forEach((o: { a: number }) => { seen.push(o); });
console.log(seen.includes(seen[0]), seen.length);`,
    // U2a: the parameter holds the dynamic argument; storing it into a typed
    // element is the judged copy (fields and elements never take the arm).
    refused: "out",
  },
  {
    id: "fn-param-dyn-write-during",
    src: `const data: any = JSON.parse('[{"a":1}]');
data.forEach((o: { a: number }) => { data.at(0).a = 9; console.log(o.a); });`,
    // U2a: the parameter holds the dynamic argument, matches Node
  },
  {
    id: "fn-result-shared",
    src: `const shared = { n: 1 };
const data: any = JSON.parse('[1]');
const out: any = data.map(() => shared);
shared.n = 2;
console.log(out);`,
    refused: "fn",
  },

  // A constructor's dynamic parameter (reached through `new`, not a direct call).
  {
    id: "in-constructor-param-write",
    src: `class A { constructor(x: any) { x.n = 2; } }
const o = { n: 1 };
new A(o);
console.log(o);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // The plugin pattern: a method reached through a virtual call.
  {
    id: "in-virtual-method-write",
    src: `abstract class Plugin { abstract apply(ctx: any): void; }
class Tag extends Plugin { apply(ctx: any) { ctx.tags.push("t"); } }
class Log extends Plugin { apply(ctx: any) { ctx.log = 1; } }
const ctx = { tags: [] as string[], log: 0 };
const ps: Plugin[] = [new Tag(), new Log()];
for (const p of ps) p.apply(ctx);
console.log(ctx);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // An async function's result reaches its caller through the promise.
  {
    id: "in-async-result-then",
    src: `const o = { n: 1 };
async function f(): Promise<any> { return o; }
f().then((v) => { v.n = 2; console.log(o.n); });`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  {
    id: "in-async-result-await",
    src: `const a = [1];
async function f(): Promise<any> { const d: any = a; return d; }
async function main() {
  const v = await f();
  v.push(2);
  console.log(a);
}
main();`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // A generator's yield reaches its caller through the iterator.
  {
    id: "in-generator-yield-for-of",
    src: `const a = [1];
const d: any = a;
function* g(): Generator<any> { yield d; }
for (const v of g()) v.push(2);
console.log(a);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  {
    id: "in-generator-yield-next",
    src: `const a = [1];
function* g(): Generator<any> { const d: any = a; yield d; }
const it = g();
const r = it.next();
r.value.push(2);
console.log(a);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // A function value called through a binding: the call reaches it.
  {
    id: "in-call-through-value-write",
    src: `const f = (x: any) => { x.n = 2; };
const g = f;
const r = { n: 1 };
g(r);
console.log(r.n);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  {
    id: "in-callback-param-write",
    src: `function each(xs: { n: number }[], cb: (x: any) => void) { for (const x of xs) cb(x); }
const xs = [{ n: 1 }];
each(xs, (x: any) => { x.n = 5; });
console.log(xs[0].n);`,
    // Unit U1a: the dynamic world is shared now (S014's U1a amendment) —
    // no copy, so the program runs and matches Node.
  },
  // ── unobservable: exact ────────────────────────────────────────────
  {
    // The gate's SECURITY 5 shape: a cast out of a caught value, read in
    // the next statement beside a host object's property read (`r.status`),
    // which runs no program code.
    id: "ok-caught-cast-beside-host-read",
    src: `async function go(): Promise<void> {
  try {
    const r = await fetch("http://127.0.0.1:1/");
    let t = "";
    try {
      t = await r.text();
    } catch (e) {
      const x: unknown = e;
      const c = x as { message: string; cause: { name: string } };
      console.log("BODY", r.status, c.message, c.cause.name);
      return;
    }
    console.log("OK", t.length);
  } catch (e) {
    const x: unknown = e;
    const c = x as { message: string; cause: { code: string } };
    console.log("ERR", c.message, c.cause.code);
  }
}
go();`,
  },
  {
    // A part read straight off a caught value's cast, then only read.
    id: "ok-caught-cause-read",
    src: `try {
  throw JSON.parse('{"cause":{"code":"E1","message":"inner"}}');
} catch (e) {
  const x: unknown = e;
  const c = (x as { cause: { code: string; message: string } }).cause;
  console.log(c.code, c.message);
}`,
  },
  {
    // A typed value returned through a () => unknown callback and printed at once.
    id: "ok-returned-and-printed",
    src: `const shared = [1, 2];
const show = (f: () => unknown): void => { console.log(f()); };
show(() => shared);
shared.push(3);
show(() => shared);`,
  },
  {
    // Object.assign takes a typed source's own (scalar) property values.
    id: "ok-assign-scalar-source",
    src: `const w = { a: 1, note: "x" };
const q: any = {};
Object.assign(q, w);
q.a = 2;
w.note = "y";
console.log(q, w);`,
  },
  // A function's own local value, built and returned into `any`: it dies at the return.
  {
    id: "ok-return-own-record",
    src: `function parseArgs(argv: string[]): any {
  const flags: string[] = [];
  for (const a of argv) if (a.startsWith("--")) flags.push(a.slice(2));
  return { flags };
}
const opts = parseArgs(["--x", "y", "--z"]);
const env: any = JSON.parse("{}");
env.mode = "dev";
console.log(opts.flags.length, env.mode);`,
  },
  {
    id: "ok-return-own-captured-by-loop",
    src: `function summary(xs: number[]): any {
  const ret = { total: 0, big: 0 };
  xs.forEach((x) => { ret.total += 1; if (x > 5) ret.big += 1; });
  return ret;
}
const s = summary([1, 7, 9]);
const out: any = JSON.parse("{}");
out.s = s;
console.log(JSON.stringify(out));`,
  },
  // The copy is last read before the original is written.
  {
    id: "ok-logged-then-mutated",
    src: `function main() {
  const names = ["x", "y"];
  const payload: unknown = { names };
  console.log(JSON.stringify(payload));
  names.push("z");
  console.log(names.length);
}
main();`,
  },
  {
    // Totals counted by a callback a dynamic array loop runs, then returned.
    id: "ok-return-own-captured-by-dynamic-loop",
    src: `function totals(map: any): any {
  const ret = { total: 0, covered: 0 };
  Object.keys(map).forEach((k: string) => { ret.total += 1; if (map[k]) ret.covered += 1; });
  return ret;
}
const t = totals(JSON.parse('{"a":1,"b":0}'));
const sink: any = JSON.parse("{}");
sink.t = t;
sink.t.total = 9;
console.log(JSON.stringify(sink));`,
  },
  {
    // A call of a function that returns an array it built: fresh.
    id: "ok-call-returns-own",
    src: `function make(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}
const sink: any = JSON.parse("[]");
sink.push(make(3));
sink.at(0).push(9);
console.log(JSON.stringify(sink));`,
  },
  {
    // A new array a dynamic map builds, checked into string[].
    id: "ok-dynamic-map-result",
    src: `function toOptions(config: any): string[] {
  return Object.keys(config).map((k: string) => "--" + k);
}
const cfg: any = JSON.parse('{"a":1}');
const opts = toOptions(cfg);
opts.push("--z");
cfg.b = 2;
console.log(opts, cfg);`,
  },
  {
    // A library result nothing else holds.
    id: "ok-library-result",
    src: `const keys: unknown = Object.keys({ a: 1, b: 2 }).map((k) => k + "!");
const words: unknown = "x y".split(" ");
const other: any = JSON.parse("[]");
other.push(1);
console.log(keys, words, other);`,
  },
  {
    // An identity test between dynamic values the copy can never be.
    id: "ok-unrelated-identity",
    src: `const r = { n: 1 };
const list: any = JSON.parse("[]");
list.push(r);
const x: any = JSON.parse("{}");
const y: any = x;
console.log(x === y, list, r.n);`,
  },
  {
    id: "ok-fresh-into-any",
    src: `const a: any = { n: 1 };
a.n = 2;
console.log(a);
const u: unknown = [1, 2, 3];
console.log(u, JSON.stringify(u));`,
  },
  {
    id: "ok-readonly-cross",
    src: `const r = { n: 1, tags: ["a", "b"] };
const u: unknown = r;
console.log(u, JSON.stringify(u), typeof u, r.n);
const t = u as { n: number; tags: string[] };
console.log(t.n, t.tags.join(","), t.tags.length);`,
  },
  {
    id: "ok-parse-cast-write",
    src: `interface Cfg { name: string; items: number[] }
const cfg = JSON.parse('{"name":"x","items":[1]}') as Cfg;
cfg.items.push(2);
cfg.name = "y";
console.log(cfg);
const raw: unknown = JSON.parse('[1,2]');
const xs = raw as number[];
xs.push(3);
console.log(xs);`,
  },
  {
    // `(r as unknown) as T` erases: no copy is made at all.
    id: "ok-roundtrip-erased",
    src: `const r = { n: 1 };
const t = (r as unknown) as { n: number };
r.n = 2;
console.log(t.n);`,
  },
  {
    id: "ok-roundtrip-read",
    src: `const r = { n: 1, xs: [1, 2] };
const t = (r as unknown) as { n: number; xs: number[] };
console.log(t.n, t.xs.length, r.n);`,
  },
  {
    // The evolving-array idiom: a function builds a dynamic array it alone
    // holds and returns it into a typed slot.
    id: "ok-owned-return",
    src: `function collect(): string[] {
  const acc: any = JSON.parse("[]");
  for (const v of ["a", "b"]) acc.push(v);
  return acc;
}
const out = collect();
out.push("c");
console.log(out);`,
  },
  {
    // A write to a dynamic value the copy can never be.
    id: "ok-unrelated-dyn-write",
    src: `const r = { n: 1 };
const u: unknown = r;
const other: any = JSON.parse('{"m":1}');
const alias = other;
alias.m = 2;
console.log(u, other, r.n);`,
  },
  {
    id: "ok-parse-member-cast",
    src: `const doc: any = JSON.parse('{"items":[1,2],"name":"n"}');
const items = doc.items as number[];
items.push(3);
console.log(items, items.length);`,
  },
  {
    id: "ok-cb-readonly",
    src: `const data: any = JSON.parse('[{"a":1},{"a":2}]');
data.forEach((o: { a: number }) => { console.log(o.a); });
const sums = data.map((o: { a: number }) => o.a * 2);
console.log(sums);`,
  },
  {
    id: "ok-cb-transient",
    src: `const data: any = JSON.parse('[{"a":1}]');
data.forEach((o: { a: number }) => { console.log(o.a); });
data.push({ a: 2 });
console.log(data);`,
  },
  {
    // The callback's write grows the array; the element it was handed a
    // copy of is untouched, so the copy cannot be told from it.
    id: "ok-cb-param-dyn-push-during",
    src: `const data: any = JSON.parse('[{"a":1}]');
data.forEach((o: { a: number }) => { data.push(1); console.log(o.a); });
console.log(data.length);`,
  },
  {
    id: "ok-print-cross",
    src: `const r = { n: 1 };
console.log(r as unknown);
r.n = 2;
const x: unknown = { nested: [r.n] };
console.log(x);`,
  },
  {
    id: "ok-write-before-crossing",
    src: `const xs = [1];
xs.push(2);
const u: unknown = xs;
console.log(u);`,
  },
  {
    id: "ok-fresh-literal-into-dynamic-written",
    src: `const list: any = JSON.parse("[]");
list.push({ n: 1 });
list.push([1, 2]);
console.log(list);`,
  },
];

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const file = join(scratch, `${row.id}-${backend}.ts`);
  writeFileSync(file, row.src + "\n");
  const built = await build(row.id, file, backend);
  if (row.refused !== undefined) {
    expect(built.ok).toBe(false);
    if (built.ok) return;
    const dyn = built.diags.filter((d) => d.code === "SC1090" && TAIL.test(d.message));
    expect(dyn.length, JSON.stringify(built.diags)).toBeGreaterThan(0);
    expect(dyn.some((d) => KIND[row.refused!].test(d.message)), JSON.stringify(built.diags)).toBe(true);
    return;
  }
  if (!built.ok) throw new Error(`${row.id} refused on ${backend}: ${built.diags.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(file);
  expect(node.exitCode).toBe(0);
  const got = backend === "wasm" ? await wasmRun(built.path) : await nativeRun(built.path);
  expect(got).toEqual(node);
}

describe("U0: observable dynamic-crossing copies refuse (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
