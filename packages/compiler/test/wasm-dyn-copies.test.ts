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
  { id: "issue-120-array", src: `const u: unknown = [1]; (u as number[]).push(2); console.log(u);`, refused: "out" },
  { id: "issue-120-record", src: `const w: unknown = { k: 1 }; (w as { k: number }).k = 3; console.log(w);`, refused: "out" },
  {
    id: "out-binding-write",
    src: `const u: unknown = JSON.parse('{"k":1}');
const t = u as { k: number };
t.k = 2;
console.log(u);`,
    refused: "out",
  },
  {
    id: "out-nested-write",
    src: `const d: unknown = JSON.parse('{"xs":[1]}');
const keep = d;
(d as { xs: number[] }).xs.push(2);
console.log(keep);`,
    refused: "out",
  },
  {
    id: "out-dyn-write-after",
    src: `const d: any = JSON.parse('{"k":1}');
const t = d as { k: number };
d.k = 7;
console.log(t.k, d.k);`,
    refused: "out",
  },
  {
    id: "out-identity",
    src: `const r = { n: 1 };
const u: unknown = r;
console.log((u as { n: number }) === r);`,
    refused: "out",
  },
  // A round trip through an `unknown` binding, then the original is written.
  {
    id: "roundtrip-orig-write",
    src: `const r = { n: 1 };
const u: unknown = r;
const t = u as { n: number };
r.n = 2;
console.log(t.n);`,
    refused: "in",
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
    refused: "out",
  },
  // A typed value into `any`, written through the dynamic side.
  { id: "in-any-write", src: `const r = { a: 1 }; const a: any = r; a.a = 2; console.log(r.a);`, refused: "in" },
  // A typed array into `unknown`, pushed to afterwards.
  { id: "in-later-push", src: `const xs = [1, 2]; const u: unknown = xs; xs.push(3); console.log(u);`, refused: "in" },
  { id: "in-later-write", src: `const r = { n: 1 };\nconst u: unknown = r;\nr.n = 2;\nconsole.log(u);`, refused: "in" },
  { id: "in-object-slot", src: `const xs = [1, 2];\nconst o: object = xs;\nxs.push(3);\nconsole.log(o);`, refused: "in" },
  {
    id: "in-nested-shared",
    src: `const shared = { n: 1 };
const u: unknown = { inner: shared };
shared.n = 2;
console.log(u);`,
    refused: "in",
  },
  { id: "in-param-write", src: `function bump(x: any) { x.n = 5; }\nconst r = { n: 1 };\nbump(r);\nconsole.log(r.n);`, refused: "in" },
  {
    id: "in-dynamic-call-write",
    src: `const bump: any = (x: any) => { x.n = 5; };
const r = { n: 1 };
bump(r);
console.log(r.n);`,
    refused: "in",
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
    refused: "in",
  },
  {
    id: "in-pushed-into-dynamic",
    src: `const r = { n: 1 };
const list: any = JSON.parse("[]");
list.push(r);
r.n = 2;
console.log(list);`,
    refused: "in",
  },
  // A typed callback parameter on a dynamic call receives a copy.
  {
    id: "fn-param-write",
    src: `const data: any = JSON.parse('[{"a":1}]'); data.forEach((o: { a: number }) => { o.a = 2; }); console.log(data);`,
    refused: "fn",
  },
  {
    id: "fn-param-identity",
    src: `const seen: { a: number }[] = [];
const data: any = JSON.parse('[{"a":1}]');
data.forEach((o: { a: number }) => { seen.push(o); });
console.log(seen.includes(seen[0]), seen.length);`,
    refused: "fn",
  },
  {
    id: "fn-param-dyn-write-during",
    src: `const data: any = JSON.parse('[{"a":1}]');
data.forEach((o: { a: number }) => { data.at(0).a = 9; console.log(o.a); });`,
    refused: "fn",
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

  // ── unobservable: exact ────────────────────────────────────────────
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
