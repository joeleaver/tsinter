/* rea step 11 (B): a mutually recursive group of interfaces maps as ONE
 * group — each member once, whatever the path (types.ts
 * mapRecursiveGroup). Before, the per-path walk cut a cycle only where it
 * re-reached a type on its stack: which members became recursive shapes
 * depended on the entry point, and a large group (Babel's AST, rea's
 * `Set<Node>`) re-expanded once per path (the step budget's refusal).
 *
 * Every row compiles the same program with groups on and with
 * TSINTER_RECURSIVE_GROUPS=off where that matters, and compares with Node
 * (spawned at test time). */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const scratch = mkdtempSync(join(tmpdir(), "tsinter-rec-groups-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function write(id: string, src: string): string {
  const dir = join(scratch, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rec-groups-row", private: true, type: "module" }));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, src + "\n");
  return entry;
}

async function compileWith(entry: string, groups: "on" | "off", tag: string) {
  const dir = dirname(entry);
  const prev = process.env.TSINTER_RECURSIVE_GROUPS;
  if (groups === "off") process.env.TSINTER_RECURSIVE_GROUPS = "off";
  else delete process.env.TSINTER_RECURSIVE_GROUPS;
  try {
    return await compile(entry, { outPath: join(dir, `${tag}.wasm`), outDir: dir, backend: "wasm" });
  } finally {
    if (prev === undefined) delete process.env.TSINTER_RECURSIVE_GROUPS;
    else process.env.TSINTER_RECURSIVE_GROUPS = prev;
  }
}

async function nodeExact(id: string, src: string, maxSecs = 60): Promise<void> {
  const entry = write(id, src);
  const t0 = Date.now();
  const res = await compileWith(entry, "on", "on");
  const secs = (Date.now() - t0) / 1000;
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  expect(secs).toBeLessThan(maxSecs);
  const node = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dirname(entry) });
  expect(node.status, node.stderr).toBe(0);
  const got = await runWasm(res.binaryPath!);
  expect(String(got.stdout)).toBe(node.stdout);
}

/** 30 node interfaces, each field a distinct small union of others (the
 * MAPBUDGET-01 graph, which refuses at the budget per path). */
function astProgram(n: number): string {
  const names = Array.from({ length: n }, (_, i) => `N${i}`);
  const at = (k: number): string => names[k % n]!;
  const lines: string[] = [`type Node = ${names.join(" | ")};`];
  names.forEach((name, i) => {
    lines.push(
      `interface ${name} { kind: "n${i}"; left: ${at(i + 1)} | ${at(i + 2)} | null; right: Array<${at(i + 3)} | ${at(i + 5)}>; meta: { start: number; inner: ${at(i + 7)} | ${at(i + 11)} | null } }`,
    );
  });
  lines.push(`const nodes = new Set<Node>();
const leaf: N1 = { kind: "n1", left: null, right: [], meta: { start: 1, inner: null } };
const top: N0 = { kind: "n0", left: leaf, right: [], meta: { start: 0, inner: null } };
nodes.add(top);
nodes.add(leaf);
let kinds = "";
for (const n of nodes) kinds += n.kind + " ";
console.log(nodes.size, kinds.trim(), top.left === null ? "." : top.left.kind, top.meta.start + leaf.meta.start);`);
  return lines.join("\n");
}

/** The review's BIG250 interfaces (verbatim): edges go 1–11 interfaces
 * forward (mod n), so the shortest cycle is ~23 hops — longer than the
 * depth allowance; the group starts at a depth cut. (The review's tail
 * walked `x: Node | null` reading `x.left` on the 250-arm union — a
 * member read whose type differs per arm, a separate, existing fence; the
 * tail here reads through the typed members instead.) */
function bigGraph(n: number): string {
  const names = Array.from({ length: n }, (_, i) => `N${i}`);
  const at = (k: number): string => names[k % n]!;
  const lines = [`type Node = ${names.join(" | ")};`];
  names.forEach((name, i) => {
    lines.push(`interface ${name} { kind: "n${i}"; left: ${at(i + 1)} | ${at(i + 2)} | null; right: Array<${at(i + 3)} | ${at(i + 5)}>; meta: { start: number; inner: ${at(i + 7)} | ${at(i + 11)} | null } }`);
  });
  lines.push(`class SemanticSet { #nodes = new Set<Node>(); add(n: Node): void { this.#nodes.add(n); } get size(): number { return this.#nodes.size; } }
const s = new SemanticSet();
const n1: N1 = { kind: "n1", left: null, right: [], meta: { start: 1, inner: null } };
const n0: N0 = { kind: "n0", left: n1, right: [], meta: { start: 0, inner: null } };
s.add(n0); s.add(n1);
const kids: Node[] = [n0, n1];
let kinds = "";
for (const k of kids) kinds += k.kind + " ";
console.log(s.size, kinds.trim(), n0.left === null ? "." : n0.left.kind, n0.right.length + n1.meta.start);`);
  return lines.join("\n");
}

/** The second review's generators (verbatim): interfaces P0..P{n-1},
 * every edge 1–11 forward — cycles longer than the depth allowance. */
function cycleDecls(p: string, n: number, extra: (i: number) => string = () => ""): string[] {
  const names = Array.from({ length: n }, (_, i) => `${p}${i}`);
  const at = (k: number): string => names[k % n]!;
  const lines = [`type ${p}Node = ${names.join(" | ")};`];
  names.forEach((name, i) => {
    lines.push(`interface ${name} { kind: "${p}${i}"; left: ${at(i + 1)} | ${at(i + 2)} | null; right: Array<${at(i + 3)} | ${at(i + 5)}>; meta: { start: number; inner: ${at(i + 7)} | ${at(i + 11)} | null }${extra(i)} }`);
  });
  return lines;
}
const cycleTail = (p: string): string => `const ${p}1v: ${p}1 = { kind: "${p}1", left: null, right: [], meta: { start: 1, inner: null } };
const ${p}0v: ${p}0 = { kind: "${p}0", left: ${p}1v, right: [], meta: { start: 0, inner: null } };
const ${p}walk = (x: ${p}Node | null, d: number): number => x === null || d === 0 ? 0 : 1 + ${p}walk(x.left, d - 1) + x.right.reduce((a, r) => a + ${p}walk(r, d - 1), 0) + ${p}walk(x.meta.inner, d - 1);
console.log("${p}", ${p}walk(${p}0v, 5), ${p}0v.left?.kind, ${p}0v.meta.start);`;

/** Groups on: the program builds and prints as Node, or refuses by NAME —
 * never a thrown compiler error, never an internal error (SC9001). */
async function refusesByNameOrRuns(id: string, src: string): Promise<void> {
  const entry = write(id, src);
  const t0 = Date.now();
  const res = await compileWith(entry, "on", "on");
  expect((Date.now() - t0) / 1000).toBeLessThan(120);
  if (!res.ok) {
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(res.diagnostics.filter((d) => d.code === "SC9001").map((d) => d.message)).toEqual([]);
    for (const d of res.diagnostics) expect(d.message.length).toBeLessThan(20_000);
    return;
  }
  const node = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dirname(entry) });
  expect(String((await runWasm(res.binaryPath!)).stdout)).toBe(node.stdout);
}

/** Groups on and off reach the same outcome: both build (and print as
 * Node), or both refuse with the same diagnostics, or both throw the same
 * compiler error (a pre-existing crash is still a crash in both). */
async function sameOnOff(id: string, src: string): Promise<void> {
  const entry = write(id, src);
  const outcome = async (mode: "on" | "off") => {
    try {
      const r = await compileWith(entry, mode, mode);
      return r.ok ? { ok: true as const, bin: r.binaryPath! } : { ok: false as const, diags: r.diagnostics.map((d) => `${d.code} ${d.loc?.start ?? ""} ${d.message}`) };
    } catch (e) {
      return { ok: false as const, diags: [`threw ${String(e).split("\n")[0]}`] };
    }
  };
  const on = await outcome("on");
  const off = await outcome("off");
  expect(on.ok, JSON.stringify({ on, off })).toBe(off.ok);
  if (!on.ok || !off.ok) {
    expect(on.ok ? [] : on.diags).toEqual(off.ok ? [] : off.diags);
    return;
  }
  const node = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dirname(entry) });
  expect(String((await runWasm(on.bin)).stdout)).toBe(node.stdout);
  expect(String((await runWasm(off.bin)).stdout)).toBe(node.stdout);
}

describe("rea step 11 (B): recursive groups map as one (wasm lane vs Node)", () => {
  test("RG-01 a mutually recursive pair, entered from either member, is one pair of shapes: values flow between both entry points", async () => {
    await nodeExact(
      "RG-01",
      `interface Dept { name: string; head: Person | null; staff: Person[] }
interface Person { name: string; dept: Dept | null; mentor: Person | null }
function deptOf(p: Person): Dept | null { return p.dept; }
function headOf(d: Dept): Person | null { return d.head; }
const d: Dept = { name: "eng", head: null, staff: [] };
const a: Person = { name: "ada", dept: d, mentor: null };
const b: Person = { name: "bob", dept: d, mentor: a };
d.head = a;
d.staff.push(a, b);
const back: Dept | null = deptOf(b);
const h: Person | null = back === null ? null : headOf(back);
console.log(back?.name, h?.name, d.staff.map((p) => p.name + "<" + (p.mentor?.name ?? "-")).join(" "), h === a);`,
    );
  }, 300_000);

  test("RG-02 a 30-interface AST-shaped group (refused at the budget per path) maps once and matches Node, fast", async () => {
    await nodeExact("RG-02", astProgram(30), 60);
  }, 300_000);

  test("RG-03 a group closed through a union and an array", async () => {
    await nodeExact(
      "RG-03",
      `interface Graph { name: string; nodes: GNode[] }
interface GNode { id: string; edges: GNode[]; owner: Graph | null; tag: Leaf | GNode }
interface Leaf { leaf: true; label: string }
const g: Graph = { name: "g", nodes: [] };
const x: GNode = { id: "x", edges: [], owner: g, tag: { leaf: true, label: "L" } };
const y: GNode = { id: "y", edges: [x], owner: g, tag: x };
x.edges.push(y);
g.nodes.push(x, y);
const t = y.tag;
console.log(g.nodes.map((n) => n.id).join(","), x.edges.map((n) => n.id).join(","), "leaf" in t ? t.label : t.id, y.owner?.name);`,
    );
  }, 300_000);

  test("RG-03b a group closed through a Map and a Set builds and runs the same with groups off and on", async () => {
    const src = `interface Graph { name: string; nodes: Map<string, GNode> }
interface GNode { id: string; edges: Set<GNode>; owner: Graph | null }
const g: Graph = { name: "g", nodes: new Map() };
const x: GNode = { id: "x", edges: new Set(), owner: g };
const y: GNode = { id: "y", edges: new Set([x]), owner: g };
x.edges.add(y);
g.nodes.set("x", x);
g.nodes.set("y", y);
console.log([...g.nodes.keys()].join(","), [...x.edges].map((n) => n.id).join(","), y.owner?.name);`;
    const entry = write("RG-03b", src);
    const on = await compileWith(entry, "on", "on");
    const off = await compileWith(entry, "off", "off");
    const codes = (r: typeof on) => (r.ok ? [] : r.diagnostics.map((d) => `${d.code} ${d.message}`).sort());
    expect(codes(on)).toEqual(codes(off));
    if (on.ok && off.ok) {
      const node = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dirname(entry) });
      expect(String((await runWasm(on.binaryPath!)).stdout)).toBe(node.stdout);
    }
  }, 300_000);

  test("RG-04 an anonymous member inside a group (a type literal between two interfaces)", async () => {
    await nodeExact(
      "RG-04",
      `interface P { id: number; meta: { next: Q | null; depth: number } }
interface Q { back: P[]; label: string }
const q: Q = { back: [], label: "q" };
const p: P = { id: 1, meta: { next: q, depth: 2 } };
q.back.push(p, { id: 2, meta: { next: null, depth: 0 } });
console.log(p.meta.next?.label, q.back.map((e) => e.id + ":" + e.meta.depth).join(" "), q.back[0] === p);`,
    );
  }, 300_000);

  test("RG-05 a generic recursive interface instantiated in a generic body behaves the same with groups off and on", async () => {
    const src = `interface Chain<T> { value: T; next: Chain<T> | null }
function build<T>(xs: T[]): Chain<T> | null {
  let head: Chain<T> | null = null;
  for (let i = xs.length - 1; i >= 0; i--) head = { value: xs[i]!, next: head };
  return head;
}
function len<T>(c: Chain<T> | null): number { let n = 0; for (let k = c; k !== null; k = k.next) n++; return n; }
const c = build([3, 1, 4]);
console.log(len(c), c?.value, c?.next?.value, len(build(["a"])));`;
    const entry = write("RG-05", src);
    const on = await compileWith(entry, "on", "on");
    const off = await compileWith(entry, "off", "off");
    expect(on.ok, JSON.stringify(on.ok ? [] : on.diagnostics)).toBe(off.ok);
    if (!on.ok || !off.ok) {
      const codes = (r: typeof on) => (r.ok ? [] : r.diagnostics.map((d) => d.code).sort());
      expect(codes(on)).toEqual(codes(off));
      return;
    }
    const node = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dirname(entry) });
    expect(String((await runWasm(on.binaryPath!)).stdout)).toBe(node.stdout);
    expect(String((await runWasm(off.binaryPath!)).stdout)).toBe(node.stdout);
  }, 300_000);

  test("RG-BIG250 a 250-interface group whose cycles are longer than the depth allowance (~23 hops) maps once from a depth cut and matches Node, fast", async () => {
    await nodeExact("RG-BIG250", bigGraph(250), 90);
  }, 600_000);

  test("RG-GCLS a group reached inside a generic class instantiation (a hook frame) reaches the same outcome with groups on and off", async () => {
    await sameOnOff(
      "RG-GCLS",
      `interface Holder { box: Box<number>; next: Holder2 | null; n: number }
interface Holder2 { h: Holder; tag: string }
class Box<T> { owner: Holder | null = null; constructor(public v: T) {} get twice(): string { return String(this.v) + String(this.v); } }
const h: Holder = { box: new Box(3), next: null, n: 1 };
h.box.owner = h;
h.next = { h, tag: "t" };
const b2 = new Box<number>(4);
console.log(h.box.v, h.box.twice, h.box.owner === h, h.next.h.n, b2.twice, b2.owner === null);`,
    );
  }, 300_000);

  test("RG-GCLS2 the same types with the generic class declared and used first: Node-exact on and off", async () => {
    await sameOnOff(
      "RG-GCLS2",
      `class Box<T> { owner: Holder | null = null; constructor(public v: T) {} get twice(): string { return String(this.v) + String(this.v); } }
const b2 = new Box<number>(4);
interface Holder { box: Box<number>; next: Holder2 | null; n: number }
interface Holder2 { h: Holder; tag: string }
const h: Holder = { box: b2, next: null, n: 1 };
h.box.owner = h;
h.next = { h, tag: "t" };
console.log(h.box.v, h.box.twice, h.box.owner === h, h.next.h.n, b2.twice);`,
    );
  }, 300_000);

  test("RG-DYNCOL2 a group member beside an empty interface in a union (B | Empty) reaches the same outcome on and off (a pending placeholder is not dyn-subsumable)", async () => {
    await sameOnOff(
      "RG-DYNCOL2",
      `interface Empty {}
interface A { tag: string; b: B | Empty }
interface B { a: A; m: Map<string, number>; n: number }
const a: A = { tag: "a", b: {} };
const b: B = { a, m: new Map(), n: 1 };
a.b = b;
b.n = 2;
console.log((a.b as B).n, JSON.stringify(Object.keys(a.b)));`,
    );
  }, 300_000);

  test("RG-TWO two independent long-cycle groups in one program refuse by name or run (a fully mapped group printed once per path crashed the type printer)", async () => {
    await refusesByNameOrRuns(
      "RG-TWO",
      [...cycleDecls("A", 80), ...cycleDecls("B", 90), cycleTail("A"), cycleTail("B"), `const both: [ANode, BNode] = [A0v, B0v]; console.log(both[0].kind, both[1].kind);`].join("\n"),
    );
  }, 600_000);

  test("RG-HOOKCUT a depth cut inside a hook frame (a generic class field in a long cycle) refuses by name or runs", async () => {
    await refusesByNameOrRuns(
      "RG-HOOKCUT",
      [
        ...cycleDecls("Q", 60, (i) => (i === 20 ? "; box: Box<number> | null" : "")),
        `class Box<T> { node: Q40 | null = null; constructor(public v: T) {} }`,
        cycleTail("Q"),
        `const bx = new Box<number>(7); const q40: Q40 = { kind: "Q40", left: null, right: [], meta: { start: 40, inner: null } }; bx.node = q40;
const q20: Q20 = { kind: "Q20", left: null, right: [], meta: { start: 20, inner: null }, box: bx };
console.log(q20.box?.v, q20.box?.node?.meta.start, Qwalk(q20, 3));`,
      ].join("\n"),
    );
  }, 600_000);

  test("RG-DYNCOL4 B | Empty with a class field in the group: the same outcome on and off", async () => {
    await sameOnOff(
      "RG-DYNCOL4",
      `interface Empty {}
class Tag { constructor(public t: string) {} }
interface A { name: string; b: B | Empty }
interface B { a: A; tag: Tag }
const a: A = { name: "a", b: {} };
console.log(JSON.stringify(a), typeof a.b, Object.keys(a.b).length);`,
    );
  }, 300_000);
});
