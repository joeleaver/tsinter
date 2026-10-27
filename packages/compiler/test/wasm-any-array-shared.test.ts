/* Unit H (boards #259/#268, Joe's ruling D2 as approved 2026-10-26):
 * `any[]` IS the island array on every lane, so crossings between `any[]`
 * and `any` share one array (SEMANTICS.md S014's unit-H amendment); a
 * TYPED composite entering an `any` slot is a live VIEW of the static
 * value (S115 (a)/(b)), and an island value enters typed storage only when
 * it is fresh — every other exit refuses at compile time, the same
 * diagnostic on every lane (S115 (d)). Rows expecting output pin Node's
 * answer (each measured against Node v24.18.1 when written). */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch = "";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-unit-h-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runRow(id: string, src: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = join(scratch, `${id}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic: true });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

/** A row expected to refuse: the diagnostics, from the wasm AND the C
 * backend (the check is the front end's, so the lanes must agree). */
async function refuseRow(id: string, src: string): Promise<string> {
  const entry = join(scratch, `${id}.ts`);
  await writeFile(entry, `${src}\n`);
  const lanes: string[] = [];
  for (const backend of ["wasm", "c"] as const) {
    const res = await compile(entry, {
      outPath: join(scratch, `${id}.${backend}.out`),
      outDir: scratch,
      backend,
      dynamic: true,
    });
    if (res.ok) throw new Error(`${id} compiled on ${backend} but was expected to refuse`);
    lanes.push(res.diagnostics.map((d) => `${d.code}:${d.message}`).join("\n"));
  }
  expect(lanes[1]).toBe(lanes[0]);
  return lanes[0]!;
}

// ── sharing: the reviewer's repros (rev-p2/pa, pb) ──────────────────────

test("H-SHARE-01 a typed any[] parameter, an any local and the island source are one array (rev a01)", async () => {
  const r = await runRow("H-SHARE-01", "// @dynamic\nfunction back(xs: any[] = []): any[] {\n  xs.push(\"added\");\n  return xs;\n}\nconst o: any = { p: [{ n: 1 }] };\nconst r = back(o.p);\nconst anyR: any = r;\nanyR.push(9);\nconsole.log(`${o.p.length} ${r.length} ${anyR.length} ${anyR === o.p}`);\no.p.push(7);\nconsole.log(`${r.length} ${anyR.length}`);");
  expect(r.stdout).toBe("3 3 3 true\n4 4\n");
  expect(r.exitCode).toBe(0);
});

test("H-SHARE-02 empty island arrays keep their identity through an any[] | undefined parameter (rev a02, board #268)", async () => {
  const r = await runRow("H-SHARE-02", "// @dynamic\nfunction id(xs: any[] | undefined): any[] {\n  return xs === undefined ? [] : xs;\n}\nconst o: any = { a: [], b: [] };\nconst x = id(o.a);\nconst y = id(o.b);\nconst h: any = { x, y };\nconsole.log(`${h.x === h.y} ${h.x === o.a} ${h.y === o.b} ${o.a === o.b}`);\nconst u1 = id(undefined);\nconst u2 = id(undefined);\nconst g: any = { u1, u2 };\nconsole.log(`${g.u1 === g.u2}`);");
  expect(r.stdout).toBe("false true true false\nfalse\n");
});

test("H-SHARE-03 a static any[] written into island members is one array per source (rev a04)", async () => {
  const r = await runRow("H-SHARE-03", "// @dynamic\nconst a: any[] = [1, 2];\nconst b: any[] = a;\nconst c: any[] = a.concat();\nconst h: any = {};\nh.a = a; h.b = b; h.c = c;\nconsole.log(`${h.a === h.b} ${h.a === h.c}`);\nh.a.push(3);\nconsole.log(`${a.length} ${b.length} ${c.length}`);\na.push(4);\nconsole.log(`${h.a.length} ${h.b.length}`);");
  expect(r.stdout).toBe("true false\n3 3 2\n4 4\n");
});

test("H-SHARE-04 two passes of one island array through a typed parameter are the same array (rev b04)", async () => {
  const r = await runRow("H-SHARE-04", "// @dynamic\nfunction take(xs: any[] | undefined): any[] {\n  return xs ?? [];\n}\nconst o: any = { a: [1] };\nconst t1 = take(o.a);\nconst t2 = take(o.a);\nt1.push(2);\nconsole.log(`${t1 === t2} ${o.a.length} ${t2.length}`);");
  expect(r.stdout).toBe("true 2 2\n");
});

test("H-CORPUS-2787 the any[] sharing corpus program", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/2787-any-array-shared.ts", import.meta.url));
  const src = await readFile(entry, "utf8");
  const r = await runRow("H-CORPUS-2787", src.trimEnd());
  expect(r.stdout).toBe(
    "param: 3 3 3 true true\nparam after: 4 4\ndefault: 1 false\nempty: false true true false\nfresh: false true\n" +
      "members: true false true true\nmembers push: 3 3 2 3\nmembers push back: 4 4 4\nlog: 3 one|two|three true\n" +
      "grid: [[1,5,6],[2,3,4]] [[1,5,6],[2,3,4]] true\nrecord: 2 2 true true\nrecord param: p,q,r\nreturn: 2 true true\n" +
      "live: 3 3 4 true false\n[ 1, 2, 3 ] [ 1, 2, 3, 4 ]\nevolving: 3 1 1,2,3\ntyped: 3 1,2,3 x,y,z 3,1,2\npromise: 2 true 2\n",
  );
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
});

test("H-METHODS-01 reduce/reduceRight/findLast/toSorted/toReversed/with/splice/fill/toString on the island array", async () => {
  const r = await runRow("H-METHODS-01", "// @dynamic\nconst xs: any[] = [3, 1, 2, undefined, 5];\nconsole.log(xs.reduce((a: any, b: any) => a + (b ?? 0), 0), xs.reduceRight((a: any, b: any) => `${a},${b}`));\ntry { ([] as any[]).reduce((a: any) => a); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconsole.log(xs.findLast((x: any) => typeof x === \"number\" && x < 3), xs.findLastIndex((x: any) => x === 3));\nconsole.log(`${xs.toReversed().join(\"|\")} ${xs.toSorted().join(\"|\")} ${xs.join(\"|\")}`);\ntry { xs.toSorted(1 as any); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconsole.log(`${xs.with(-1, \"z\").join(\"|\")}`);\ntry { xs.with(9, 1); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst ys: any[] = [1, 2, 3, 4, 5, 6];\nconst removed = ys.splice(-2, 1, \"a\", \"b\");\nconsole.log(`${removed.join(\"|\")} ${ys.join(\"|\")} ${ys.fill(0, 1, 3).join(\"|\")} ${ys.toString()}`);");
  expect(r.stdout).toBe(
    "11 5,undefined,2,1,3\nTypeError Reduce of empty array with no initial value\n2 0\n5||2|1|3 1|2|3|5| 3|1|2||5\n" +
      "TypeError The comparison function must be either a function or undefined: 1\n3|1|2||z\nRangeError Invalid index : 9\n" +
      "5 1|2|3|4|a|b|6 1|0|0|4|a|b|6 1,0,0,4,a,b,6\n",
  );
});

test("H-INSPECT-01 console.log and format specifiers over an island array print Node's rendering", async () => {
  const r = await runRow("H-INSPECT-01", "// @dynamic\nconst xs: any[] = [1, \"a\", { b: [2, { c: { d: 1 } }] }, [], {}];\nconsole.log(xs);\nconsole.log(\"%o|%d\", [1] as any[], [7] as any[]);");
  expect(r.stdout).toBe("[ 1, 'a', { b: [ 2, [Object] ] }, [], {} ]\n[ 1, [length]: 1 ]|7\n");
});

/** Build on the C backend and run: the native lanes' island answers. */
async function runC(id: string, src: string): Promise<{ stdout: string; exitCode: number }> {
  const entry = join(scratch, `${id}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${id}.c.out`), outDir: scratch, backend: "c", dynamic: true });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) => {
    execFile(res.binaryPath, [], { encoding: "utf8" }, (err, stdout) => {
      const code = err ? (err as { code?: unknown }).code : 0;
      resolve({ stdout, exitCode: typeof code === "number" ? code : 1 });
    });
  });
}

/** A row both lanes must answer identically (wasm, and c for the native
 * island's Proxy views): the wasm stdout, after checking c agrees. */
async function bothRow(id: string, src: string): Promise<string> {
  const w = await runRow(`${id}-w`, src);
  const c = await runC(`${id}-c`, src);
  expect(c.stdout).toBe(w.stdout);
  expect(w.exitCode).toBe(0);
  expect(c.exitCode).toBe(0);
  return w.stdout;
}

// ── LIFTS share: a typed composite in an `any` slot is a live VIEW (S115 (a)) ─
// Each row's expected output is Node's (measured, v24.18.1) — the shapes the
// copy analysis refused or registered before now answer as Node does.

test("H-VIEW-01 an array view: identity, length, index reads and writes both ways, Array methods, JSON and printing", async () => {
  const out = await bothRow("H-VIEW-01", "// @dynamic\nconst nums: number[] = [1, 2, 3];\nconst a: any = nums;\nconst b: any = nums;\nconsole.log(a === b, Array.isArray(a), a.length, a[1]);\na[0] = 10;\na.push(4);\nconsole.log(nums, nums.length);\nnums.push(5);\nconsole.log(a.length, a[4], JSON.stringify(a));\nconsole.log(a);\na.length = 2;\nconsole.log(nums);\nconsole.log(a.map((x: number) => x * 2), a.indexOf(2), a.includes(10), a.join(\"-\"));");
  expect(out).toBe("true true 3 2\n[ 10, 2, 3, 4 ] 4\n5 5 [10,2,3,4,5]\n[ 10, 2, 3, 4, 5 ]\n[ 10, 2 ]\n[ 20, 4 ] 1 true 10-2\n");
});

test("H-VIEW-02 mutating Array methods through a view land in the typed array (push/unshift/splice/sort/reverse/pop/shift)", async () => {
  const out = await bothRow("H-VIEW-02", "// @dynamic\nfunction touch(x: any): void {\n  x.push(100);\n  x.unshift(-1, -2);\n  x.splice(1, 1, 7, 8, 9);\n  x.sort((p: number, q: number) => p - q);\n  x.reverse();\n}\nconst xs: number[] = [3, 1, 2];\ntouch(xs);\nconsole.log(xs.join(\",\"), xs.length);\nconst v: any[] = xs;\nlet sum = 0;\nfor (const e of v) { const n: number = e; sum = sum + n; }\nconsole.log(sum, [...v].length, v.filter((e: number) => e > 5).join(\",\"), v.slice(1, 3).join(\",\"), v.at(-1));\nconsole.log(v.pop(), v.shift(), xs.join(\",\"));\nconst words: string[] = [\"b\", \"a\"];\nconst w: any = words;\nconsole.log(w.sort() === w, words.join(\",\"), w.concat([\"c\"]).join(\",\"), typeof w);");
  expect(out).toBe("100,9,8,7,3,2,1,-1 8\n129 8 100,9,8,7 9,8 -1\n-1 100 9,8,7,3,2,1\ntrue a,b a,b,c object\n");
});

test("H-VIEW-03 records, nested records and arrays of records: writes from either side are one object", async () => {
  const out = await bothRow("H-VIEW-03", "// @dynamic\ntype Cfg = { name: string; opts: { depth: number; tags: string[] }; extra?: number };\nconst cfg: Cfg = { name: \"c\", opts: { depth: 1, tags: [\"a\"] } };\nfunction tweak(x: any): void {\n  x.opts.depth = x.opts.depth + 1;\n  x.opts.tags.push(\"b\");\n  x.extra = 42;\n  x.name = x.name.toUpperCase();\n}\ntweak(cfg);\nconsole.log(cfg.name, cfg.opts.depth, cfg.opts.tags.join(\",\"), cfg.extra);\nconst items: { id: number; tags: string[] }[] = [{ id: 1, tags: [\"x\"] }, { id: 2, tags: [] }];\nconst it: any = items;\nit[0].tags.push(\"y\");\nit[0].id = it[0].id + 10;\nconsole.log(JSON.stringify(it));\nconsole.log(it);\nconst keep: any = items[0];\nitems[0].id = 99;\nconsole.log(keep.id, it[0] === keep, it[0] === it[1]);");
  expect(out).toBe("C 2 a,b 42\n[{\"id\":11,\"tags\":[\"x\",\"y\"]},{\"id\":2,\"tags\":[]}]\n[ { id: 11, tags: [ 'x', 'y' ] }, { id: 2, tags: [] } ]\n99 true false\n");
});

test("H-VIEW-04 index-signature records, tuples and a union-typed array share too", async () => {
  const out = await bothRow("H-VIEW-04", "// @dynamic\nconst counts: Record<string, number> = { a: 1 };\nconst cv: any = counts;\ncv.b = 2;\ncv[\"a\"] = cv[\"a\"] + 10;\nconsole.log(counts[\"a\"], counts[\"b\"], JSON.stringify(cv));\nconst pair: [string, number[]] = [\"p\", [1]];\nconst pv: any = pair;\npv[1].push(2);\npv[0] = \"q\";\nconsole.log(pair[0], pair[1].length, JSON.stringify(pv), Array.isArray(pv), pv.length);\nconst maybe: string[] | null = [\"m\"];\nconst mv: any = maybe;\nmv.push(\"n\");\nconsole.log(maybe === null ? 0 : maybe.length);");
  expect(out).toBe("11 2 {\"a\":11,\"b\":2}\nq 2 [\"q\",[1,2]] true 2\n2\n");
});

test("H-VIEW-05 the review's lift shapes now answer Node's output (field lift, any parameter, any return, any[] field, island literal)", async () => {
  const out = await bothRow("H-VIEW-05", "// @dynamic\nclass C { xs: number[] = [1]; }\nconst c = new C();\nconst h: any = { xs: c.xs };\nc.xs.push(2);\nconsole.log(h.xs.length, c.xs.length);\nfunction f(x: any) { x.n = 5; }\nconst r = { n: 1 };\nf(r);\nconsole.log(r.n);\nconst t: number[] = [1];\nfunction wrap(): any { return t; }\nconst w2 = wrap(); w2.push(2);\nconsole.log(t.length);\nconst strs: string[] = [\"a\"];\nclass H { xs: any[] = []; }\nconst hh = new H(); hh.xs = strs; hh.xs.push(\"b\");\nconsole.log(strs.length);\nconst s: string[] = [\"a\"];\nconst box: any[] = [s];\nbox[0].push(\"b\");\nconsole.log(s.length, box[0] === s, (h.xs === c.xs));\nfunction srt(list: any) { list.sort(); }\nconst n3: number[] = [3, 1, 2];\nsrt(n3);\nconsole.log(n3.join(\",\"));");
  expect(out).toBe("2 2\n5\n2\n2\n2 true true\n1,2,3\n");
});

test("H-VIEW-06 Object.assign copies a typed source's members as JS does (nested composites by reference)", async () => {
  const out = await bothRow("H-VIEW-06", "// @dynamic\nconst typed = { xs: [1] };\nconst h: any = Object.assign({}, typed);\ntyped.xs.push(2);\nh.xs.push(3);\nconsole.log(h.xs.length, typed.xs.length, h.xs === typed.xs);");
  expect(out).toBe("3 3 true\n");
});

test("H-VIEW-07 a callback writing the array a method walks sees Node's live answers", async () => {
  const out = await bothRow("H-VIEW-07", "// @dynamic\nconst ys: number[] = [1, 2, 3];\nconst w: any = ys;\nw.forEach((x: number, i: number) => { if (i === 0) w[2] = 30; });\nconsole.log(\"walk\", ys.join(\",\"));\nw.forEach((x: number, i: number) => { w[i] = x * 2; });\nconsole.log(\"double\", ys.join(\",\"));\nconst seen = w.map((x: number, i: number) => { if (i === 0) w[1] = -1; return x; });\nconsole.log(\"map\", seen.join(\",\"), ys.join(\",\"));\nconst total = w.reduce((a: number, x: number, i: number) => { if (i === 0) w.push(100); return a + x; }, 0);\nconsole.log(\"reduce\", total, ys.join(\",\"));");
  expect(out).toBe("walk 1,2,30\ndouble 2,4,60\nmap 2,-1,60 2,-1,60\nreduce 61 2,-1,60,100\n");
});

test("H-VIEW-08 a view inside a fresh island array, and an island array holding views, keep identity", async () => {
  const out = await bothRow("H-VIEW-08", "// @dynamic\nconst arr2: number[] = [5, 6, 7];\nconst holder: any = { arr2 };\nholder.arr2.splice(0, 1);\nconsole.log(arr2.join(\",\"), holder.arr2.length);\nconst st: any[] = [arr2, arr2];\nconsole.log(st[0] === st[1], st.indexOf(arr2 as any), st.includes(arr2 as any));\nconst list: { id: number }[] = [{ id: 1 }];\nconst lv: any = list;\nlv.push(lv[0]);\nlist[1].id = 4;\nconsole.log(list.length, list[0].id, lv[0] === lv[1]);");
  expect(out).toBe("6,7 2\ntrue 0 true\n2 4 true\n");
});

test("H-VIEW-09 a compiled function's typed result reaches dynamic code as its view (one value per static value)", async () => {
  const out = await bothRow("H-VIEW-09", "// @dynamic\nconst state = { items: [1, 2] as number[], label: \"s\" };\nfunction getItems(): number[] { return state.items; }\nconst api: any = { getItems, fresh: (): number[] => [9], obj: () => state };\nconst got = api.getItems();\ngot.push(3);\nconsole.log(state.items.join(\",\"), got === api.getItems(), api.fresh().length);\napi.obj().label = \"t\";\nconsole.log(state.label, api.obj() === api.obj());");
  expect(out).toBe("1,2,3 true 1\nt true\n");
});

test("H-UNVIEW-01 a view returning to its own static type unwraps to the same value (no copy)", async () => {
  const out = await bothRow("H-UNVIEW-01", "// @dynamic\ninterface P { x: number; y: number }\nconst point: P = { x: 1.5, y: -2 };\nconst d: any = point;\nd.x = d.x * 2;\nconst back = d as P;\nback.y = 7;\nconsole.log(back === point, point.x, d.y);");
  expect(out).toBe("true 3 7\n");
});

// ── writes through a view must fit the static type and shape (S115 (b)) ───

const VERR_SRC =
  "// @dynamic\nconst xs: number[] = [1, 2, 3];\nconst v: any = xs;\nconst tup: [string, number] = [\"a\", 1];\nconst t: any = tup;\ntype R = { x: number; y?: string };\nconst rec: R = { x: 1 };\nconst r: any = rec;\n" +
  "const tries: [string, () => void][] = [\n  [\"wrong kind\", () => { v[0] = \"s\"; }],\n  [\"hole\", () => { v[7] = 1; }],\n  [\"grow length\", () => { v.length = 9; }],\n  [\"named member\", () => { v.foo = 1; }],\n  [\"tuple push\", () => { t.push(2); }],\n  [\"tuple slot\", () => { t[1] = \"x\"; }],\n  [\"record add\", () => { r.z = 1; }],\n  [\"nested fresh\", () => { const g: number[][] = [[1]]; const gv: any = g; gv[0] = [2]; }],\n];\n" +
  "for (const [name, f] of tries) {\n  try { f(); console.log(name, \"ok\"); } catch (e) { console.log(name, (e as Error).name, (e as Error).message); }\n}\nv.length = 1;\nr.y = \"set\";\nconsole.log(xs.join(\",\"), JSON.stringify(r));";

test("H-VERR-01..08 each refused view write throws its named error, identically on wasm and c; the value is untouched", async () => {
  const out = await bothRow("H-VERR", VERR_SRC);
  const lines = out.split("\n");
  // H-VERR-01 a value of the wrong primitive kind
  expect(lines[0]).toBe("wrong kind TypeError Cannot store string into a 'number[]' element shared from typed code (it holds numbers only — SEMANTICS.md S115)");
  // H-VERR-02 a write past the end (a hole)
  expect(lines[1]).toBe("hole Error Writing past the end of a 'number[]' shared from typed code would leave holes, which typed storage cannot hold (SEMANTICS.md S115)");
  // H-VERR-03 growing length
  expect(lines[2]).toBe("grow length Error Growing the length of a 'number[]' shared from typed code would leave holes, which typed storage cannot hold (SEMANTICS.md S115)");
  // H-VERR-04 a non-index member on an array view
  expect(lines[3]).toBe("named member TypeError Cannot add property 'foo': a 'number[]' shared from typed code has a fixed shape (SEMANTICS.md S115)");
  // H-VERR-05 a tuple's length is fixed
  expect(lines[4]).toBe("tuple push Error a '[string, number]' shared from typed code is a tuple: its length is fixed (SEMANTICS.md S115)");
  // H-VERR-06 a tuple position's declared type
  expect(lines[5]).toBe("tuple slot TypeError Cannot store string into a '[string, number]' position 1 shared from typed code (it holds numbers only — SEMANTICS.md S115)");
  // H-VERR-07 a record's shape is fixed
  expect(lines[6]).toMatch(/^record add TypeError Cannot add property 'z': a '\{ .* \}' shared from typed code has a fixed shape \(SEMANTICS\.md S115\)$/);
  // H-VERR-08 an island value into a nested typed slot that is not a view of it
  expect(lines[7]).toBe("nested fresh TypeError Cannot store object into a 'number[][]' element (a 'number[]' slot takes only a value shared from a typed 'number[]') (SEMANTICS.md S115)");
  // Shrinking works, and nothing a refused write touched changed.
  expect(lines[8]).toBe("1 {\"x\":1,\"y\":\"set\"}");
});

test("H-VWASM-01 callback walkers walk a view LIVE on every lane: writes through the third argument, straight to the typed array, and shrinking it answer Node's (S115 (c))", async () => {
  const src = "// @dynamic\nconst ys: number[] = [1, 2, 3];\nconst w: any = ys;\nw.forEach((x: number, i: number, arr: any) => { if (i === 0) arr[1] = 5; });\nconsole.log(\"third arg\", ys.join(\",\"));\nw.forEach((x: number, i: number) => { if (i === 0) w.pop(); });\nconsole.log(\"pop\", ys.join(\",\"));\nconst seen = w.map((x: number, i: number) => { if (i === 0) ys[1] = 20; return x; });\nconsole.log(\"direct\", seen.join(\",\"));\nconsole.log(w.filter((x: number, i: number, a: any) => a === w).length, w.find((x: number) => x > 10), w.findLastIndex((x: number) => x < 10), w.some((x: number) => x === 20), w.every((x: number) => x > 0));";
  expect(await bothRow("H-VWASM-01", src)).toBe("third arg 1,5,3\npop 1,5\ndirect 1,20\n2 20 0 true true\n");
});

test("H-VIEW-INSPECT console.log of nested views prints the static values as Node does", async () => {
  const out = await bothRow("H-VIEW-INSPECT", "// @dynamic\nconst m: { k: string; rows: number[][] } = { k: \"m\", rows: [[1, 2], [3]] };\nconst a: any = m;\nconsole.log(a);\nconsole.log([a.rows, a] as any[]);");
  expect(out).toBe("{ k: 'm', rows: [ [ 1, 2 ], [ 3 ] ] }\n[ [ [ 1, 2 ], [ 3 ] ], { k: 'm', rows: [ [Array], [Array] ] } ]\n");
});

// ── EXITS: only fresh island values enter typed storage (S115 (d)) ───────
// Every other exit refuses at compile time with the same SC1090 text on
// every lane (refuseRow compares the wasm and c diagnostics).

const EXIT_ROWS: [string, string][] = [
  ["H-EXIT-01 a01-field-exit", "// @dynamic\nclass Box { items: string[] = []; }\nconst o: any = { list: [\"a\"] };\nconst b = new Box();\nb.items = o.list;\nb.items.push(\"b\");\nconsole.log(o.list.length, b.items.length);"],
  ["H-EXIT-02 a02-return-exit", "// @dynamic\nconst o: any = { list: [\"a\"] };\nfunction get(): string[] { return o.list; }\nconst r = get(); r.push(\"b\");\nconsole.log(o.list.length, r.length);"],
  ["H-EXIT-03 a05-map-value", "// @dynamic\nconst o: any = { list: [\"a\"] };\nconst m = new Map<string, string[]>();\nm.set(\"k\", o.list);\nm.get(\"k\")!.push(\"z\");\nconsole.log(o.list.length);"],
  ["H-EXIT-04 a09-generator", "// @dynamic\nconst o: any = { list: [\"a\"] };\nfunction* g(): Generator<string[]> { yield o.list; }\nfor (const x of g()) x.push(\"z\");\nconsole.log(o.list.length);"],
  ["H-EXIT-05 a13-param-chain", "// @dynamic\nconst o: any = { list: [\"a\"] };\nfunction b(y: string[]) { y.push(\"z\"); }\nfunction a(x: string[]) { b(x); }\na(o.list);\nconsole.log(o.list.length);"],
  ["H-EXIT-06 a15-ctor-param", "// @dynamic\nconst o: any = { list: [\"a\"] };\nclass R { constructor(xs: string[]) { xs.push(\"z\"); } }\nnew R(o.list);\nconsole.log(o.list.length);"],
  ["H-EXIT-07 a16-method", "// @dynamic\nconst o: any = { list: [\"a\"] };\nclass S { add(xs: string[]) { xs.push(\"z\"); } }\nnew S().add(o.list);\nconsole.log(o.list.length);"],
  ["H-EXIT-08 a17-callback", "// @dynamic\nconst o: any = { list: [\"a\"] };\nfunction apply(f: (x: string[]) => void, v: any) { f(v); }\napply((x: string[]) => { x.push(\"z\"); }, o.list);\nconsole.log(o.list.length);"],
  ["H-EXIT-09 a25-element-exit", "// @dynamic\nconst o: any = { rows: [[1]] };\nconst rows: number[][] = o.rows;\nrows[0].push(2);\nconsole.log(o.rows[0].length);"],
  ["H-EXIT-10 a26-for-of-exit", "// @dynamic\nconst o: any = { rows: [[1], [2]] };\nfor (const r of o.rows as number[][]) r.push(9);\nconsole.log(o.rows[0].length);"],
  ["H-EXIT-11 a27-record-exit-field-write", "// @dynamic\ninterface P { x: number }\nconst o: any = { p: { x: 1 } };\nconst p: P = o.p;\np.x = 2;\nconsole.log(o.p.x);"],
  ["H-EXIT-12 a29-length-write", "// @dynamic\nconst o: any = { list: [1,2,3] };\nconst t: number[] = o.list;\nt.length = 0;\nconsole.log(o.list.length);"],
  ["H-EXIT-13 a31-param-reassign-alias", "// @dynamic\nconst o: any = { list: [\"a\"] };\nfunction f(xs: string[]) { let y: string[] = []; y = xs; y.push(\"q\"); }\nf(o.list);\nconsole.log(o.list.length);"],
  ["H-EXIT-14 fn07c-elem-alias", "// @dynamic\nconst o: any = { items: [{ n: 1 }] };\nconst items: { n: number }[] = o.items;\nconst first = items[0];\nfirst.n = 5;\nconsole.log(`${o.items[0].n}`);"],
  ["H-EXIT-15 fn07e-record-index", "// @dynamic\nconst o: any = { m: { a: [1] } };\nconst m: Record<string, number[]> = o.m;\nm[\"a\"].push(2);\nconsole.log(`${o.m.a.length}`);"],
  ["H-EXIT-16 board #259's own shape", "// @dynamic\nconst log: any = { lines: [] };\nfunction note(out: string[], s: string): void { out.push(s); }\nnote(log.lines, \"a\");\nconsole.log(log.lines.length);"],
  ["H-EXIT-17 an unmutated read-only exit refuses too", "// @dynamic\nconst o: any = { list: [\"x\", \"y\"] };\nconst names: string[] = o.list;\nconsole.log(names.join(\",\"));"],
  ["H-EXIT-18 a JSON.parse result held in a binding first", "// @dynamic\nconst parsed: any = JSON.parse(\"[3,1,2]\");\nconst arr: number[] = parsed;\nconsole.log(arr.join(\",\"));"],
  ["H-EXIT-19 an 'as' cast is an exit too", "// @dynamic\nconst o: any = { rows: [1] };\nconst r = o.rows as number[];\nconsole.log(r.length);"],
];

for (const [name, src] of EXIT_ROWS) {
  test(`${name} refuses by name, identically on wasm and c`, async () => {
    const d = await refuseRow(name.split(" ")[0]!, src);
    expect(d).toMatch(/^SC1090:an 'any' value flowing into a typed '.*' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value \(SEMANTICS\.md S115\) — keep the slot 'any'\/'any\[\]' so both sides share one value, or copy explicitly where the copy is meant: \[\.\.\.x\] or \{ \.\.\.x \}/m);
  });
}

test("H-EXIT-20 a typed-composite callback parameter dynamic code passes data into refuses by name (Joe's ruling, STRICT)", async () => {
  const d1 = await refuseRow("H-EXIT-20", "// @dynamic\nconst cb: any = (xs: number[]) => xs.length;\nconsole.log(cb([1, 2]));");
  expect(d1).toBe("SC1090:a function called from dynamic code with a typed 'number[]' parameter 'xs': each call would COPY the dynamic argument into typed storage, where the caller's object could change under it or carry more than the type declares (SEMANTICS.md S115) — type the parameter 'any' so it shares the caller's value, or copy explicitly inside the function with [...x] / { ...x }");
  const d2 = await refuseRow("H-EXIT-20b", "// @dynamic\nconst api: any = { each(f: any) { return f({ name: \"a\" }); } };\nconsole.log(api.each((o: { name: string }) => o.name));");
  expect(d2).toContain("parameter 'o': each call would COPY the dynamic argument into typed storage");
});

test("H-EXIT-20c the explicit copy inside an `any` callback is the working spelling", async () => {
  const out = await bothRow("H-EXIT-20c", "// @dynamic\nconst api: any = { each(f: any) { const o = { name: \"a\", tags: [\"x\"] }; const r = f(o); o.tags.push(\"y\"); return r; } };\nconsole.log(api.each((o: any) => { const tags: string[] = [...o.tags]; const c: { name: string } = { ...o }; return `${c.name}:${tags.join(\",\")}`; }));");
  expect(out).toBe("a:x\n");
});

test("H-FRESH-01 fresh island values enter typed storage (JSON.parse, literals, map results, fresh-returning functions)", async () => {
  const out = await bothRow("H-FRESH-01", "// @dynamic\ntype P = { x: number; y: number };\nconst src: any = JSON.parse('[{\"x\":1,\"y\":2}]');\nconst a: P[] = JSON.parse('[{\"x\":1,\"y\":2}]');\nconst b: number[] = [1, 2].map((n) => n * 2);\nconst c: P = { x: src[0].x, y: 3 };\nconst d: number[] = [...src.map((p: any) => p.x)];\nfunction mk(): any { return [1, 2, 3]; }\nconst e: number[] = mk();\na[0].x = 5;\nconsole.log(a, b, c, d, e, src[0].x);");
  expect(out).toBe("[ { x: 5, y: 2 } ] [ 2, 4 ] { x: 1, y: 3 } [ 1 ] [ 1, 2, 3 ] 1\n");
});

// ── review round 3: provenance, unknown, host results, copy idioms ──────

test("H-HOST-01a a typed result handed to dynamic code shares its parts (s11d-hostcb-objlit.ts)", async () => {
  expect(await bothRow("H-HOST-01a", "// @dynamic\ninterface P { n: number }\nconst p: P = { n: 1 };\nconst lib: any = { run(f: any) { const r = f(); r.inner.n = 9; return r; } };\nlib.run(() => ({ inner: p }));\nconsole.log(p.n);")).toBe("9\n");
});

test("H-HOST-01b a typed result handed to dynamic code shares its parts (s11e-hostcb-arrlit.ts)", async () => {
  expect(await bothRow("H-HOST-01b", "// @dynamic\ninterface P { n: number }\nconst p: P = { n: 1 };\nconst lib: any = { run(f: any) { const r = f(); r[0].n = 9; return r; } };\nlib.run(() => [p]);\nconsole.log(p.n);")).toBe("9\n");
});

test("H-HOST-01c a typed result handed to dynamic code shares its parts (s11h-typed-fn-returning-slice.ts)", async () => {
  expect(await bothRow("H-HOST-01c", "// @dynamic\ninterface P { n: number }\nconst ps: P[] = [{ n: 1 }];\nfunction get(): P[] { return ps.slice(); }\nconst lib: any = { run(f: any) { const r = f(); r[0].n = 9; return r; } };\nlib.run(get);\nconsole.log(ps[0].n);")).toBe("9\n");
});

test("H-HOST-01d a typed result handed to dynamic code shares its parts (s11-hostcb-typed-slice.ts)", async () => {
  expect(await bothRow("H-HOST-01d", "// @dynamic\ninterface P { n: number }\nconst ps: P[] = [{ n: 1 }];\nconst lib: any = { run(f: any) { const r = f(); r[0].n = 9; r.push({ n: 3 }); return r; } };\nconst out = lib.run(() => ps.slice());\nconsole.log(ps[0].n, ps.length, out.length);")).toBe("9 1 2\n");
});

test("H-HOST-01e a typed result handed to dynamic code shares its parts (s11b-hostcb-typed-map.ts)", async () => {
  expect(await bothRow("H-HOST-01e", "// @dynamic\ninterface P { n: number }\nconst ps: P[] = [{ n: 1 }];\nconst lib: any = { run(f: any) { const r = f(); r[0].n = 9; return r; } };\nlib.run(() => ps.map((p) => p));\nconsole.log(ps[0].n);")).toBe("9\n");
});

test("H-FRESH-02a freshness is proven by provenance, not spelling: s02-custom-map.ts refuses by name", async () => {
  const d = await refuseRow("H-FRESH-02a", "// @dynamic\nconst shared = [1, 2];\nconst coll: any = { map(_f: any) { return shared; } };\nconst t: number[] = coll.map((x: any) => x);\nt[0] = 99;\nconsole.log(shared[0], t[0]);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-FRESH-02b freshness is proven by provenance, not spelling: s04-fnvar-reassigned.ts refuses by name", async () => {
  const d = await refuseRow("H-FRESH-02b", "// @dynamic\nconst shared: any = [1];\nlet mk = (): any => JSON.parse(\"[1]\");\nmk = () => shared;\nconst t: number[] = mk();\nt.push(2);\nconsole.log(shared.length, t.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-FRESH-02c freshness is proven by provenance, not spelling: s05-virtual.ts refuses by name", async () => {
  const d = await refuseRow("H-FRESH-02c", "// @dynamic\nconst shared: any = [1];\nclass A { get(): any { return JSON.parse(\"[1]\"); } }\nclass B extends A { get(): any { return shared; } }\nconst a: A = new B();\nconst t: number[] = a.get();\nt.push(2);\nconsole.log(shared.length, t.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-FRESH-02d freshness is proven by provenance, not spelling: s16-objmethod-reassigned.ts refuses by name", async () => {
  const d = await refuseRow("H-FRESH-02d", "// @dynamic\nconst shared: any = [1];\nconst o = { make: (): any => JSON.parse(\"[1]\") };\no.make = () => shared;\nconst t: number[] = o.make();\nt.push(2);\nconsole.log(shared.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-FRESH-02e freshness is proven by provenance, not spelling: s21b-user-response.ts refuses by name", async () => {
  const d = await refuseRow("H-FRESH-02e", "// @dynamic\nexport {};\nconst shared: any = { list: [1] };\nclass Response { async json(): Promise<any> { return shared; } }\nasync function main() {\n  const r = new Response();\n  const v: { list: number[] } = await r.json();\n  v.list.push(2);\n  console.log(shared.list.length);\n}\nmain();");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-FRESH-02f freshness is proven by provenance, not spelling: s27b-json-shadow.ts refuses by name", async () => {
  const d = await refuseRow("H-FRESH-02f", "// @dynamic\nexport {};\nconst shared: any = [1];\nconst JSON = { parse(_s: string): any { return shared; } };\nconst t: number[] = JSON.parse(\"[1]\");\nt.push(2);\nconsole.log(shared.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-FRESH-02g freshness is proven by provenance, not spelling: s12-custom-sort.ts refuses by name", async () => {
  const d = await refuseRow("H-FRESH-02g", "// @dynamic\nconst shared = [3, 1];\nconst fresh: any = { sort() { return shared; } };\nconst t: number[] = fresh.sort();\nt[0] = 0;\nconsole.log(shared[0]);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-FRESH-03a the copy-out idioms compile as checked fresh copies (f01-config-spread.ts)", async () => {
  expect(await bothRow("H-FRESH-03a", "// @dynamic\ninterface Config { name: string; tags: string[]; retries: number }\nconst raw: any = JSON.parse('{\"name\":\"svc\",\"tags\":[\"a\",\"b\"],\"retries\":3}');\nfunction load(o: any): Config { return { name: o.name, tags: [...o.tags], retries: o.retries }; }\nconst cfg = load(raw);\ncfg.tags.push(\"c\");\nconsole.log(cfg.name, cfg.tags.join(\",\"), cfg.retries);")).toBe("svc a,b,c 3\n");
});

test("H-FRESH-03b the copy-out idioms compile as checked fresh copies (f03-normalize.ts)", async () => {
  expect(await bothRow("H-FRESH-03b", "// @dynamic\nfunction normalize(input: any): string[] {\n  const xs: string[] = Array.isArray(input) ? [...input] : [String(input)];\n  return xs.map((s) => s.trim()).filter((s) => s.length > 0);\n}\nconsole.log(normalize([\" a \", \"\", \"b\"]).join(\"|\"), normalize(5).join(\"|\"));")).toBe("a|b 5\n");
});

test("H-FRESH-03c the copy-out idioms compile as checked fresh copies (f05-record-spread.ts)", async () => {
  expect(await bothRow("H-FRESH-03c", "// @dynamic\nconst o: any = JSON.parse('{\"a\":1,\"b\":\"x\"}');\nconst r: { a: number; b: string } = { ...o };\nr.a = 5;\nconsole.log(r.a, o.a);")).toBe("5 1\n");
});

test("H-FRESH-03d the copy-out idioms compile as checked fresh copies (f13-for-of-typed.ts)", async () => {
  expect(await bothRow("H-FRESH-03d", "// @dynamic\nconst payload: any = JSON.parse('{\"items\":[1,2,3]}');\nlet s = 0;\nfor (const x of payload.items as number[]) s += x;\nconsole.log(s);")).toBe("6\n");
});

test("H-FRESH-03e the copy-out idioms compile as checked fresh copies (g03-objassign-fresh.ts)", async () => {
  expect(await bothRow("H-FRESH-03e", "// @dynamic\nconst o: any = JSON.parse('{\"a\":1,\"b\":\"x\"}');\nconst r: { a: number; b: string } = Object.assign({}, o);\nr.a = 5;\nconsole.log(r.a, o.a);")).toBe("5 1\n");
});

test("H-FRESH-03f a typed-composite-element spread still refuses (its parts would be shared)", async () => {
  const d = await refuseRow("H-FRESH-03f", "// @dynamic\nconst o: any = JSON.parse('{\"a\":[1]}');\nconst r: { a: number[] } = { ...o };\nconsole.log(r.a.length);");
  expect(d).toMatch(/SC1090:an 'any' value flowing into a typed/);
});

test("H-UNK-01a an 'unknown' value leaving into typed storage follows S115 (d): u01-unknown-cast.ts refuses by name", async () => {
  const d = await refuseRow("H-UNK-01a", "// @dynamic\nconst src: any = [1];\nconst u: unknown = src;\nconst t = u as number[];\nt.push(2);\nconsole.log(src.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-UNK-01b an 'unknown' value leaving into typed storage follows S115 (d): u04-unknown-param.ts refuses by name", async () => {
  const d = await refuseRow("H-UNK-01b", "// @dynamic\nconst src: any = { xs: [1] };\nfunction f(u: unknown): number[] { return (u as { xs: number[] }).xs; }\nconst t = f(src);\nt.push(2);\nconsole.log(src.xs.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-UNK-01c an 'unknown' value leaving into typed storage follows S115 (d): u05-unknown-guard.ts refuses by name", async () => {
  const d = await refuseRow("H-UNK-01c", "// @dynamic\nconst src: any = [1];\nconst u: unknown = src;\nif (Array.isArray(u)) {\n  const t: number[] = u as number[];\n  t.push(2);\n}\nconsole.log(src.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-UNK-01d an 'unknown' value leaving into typed storage follows S115 (d): s10-objassign.ts refuses by name", async () => {
  const d = await refuseRow("H-UNK-01d", "// @dynamic\nconst src: any = { a: [1] };\nconst t: { a: number[] } = Object.assign({}, src);\nt.a.push(2);\nconsole.log(src.a.length);");
  expect(d).toMatch(/SC1090:an '(any|unknown)' value flowing into a typed/);
});

test("H-UNK-01e a typed value crossing into 'unknown' is its view (l03-unknown-lift)", async () => {
  expect(await bothRow("H-UNK-01e", "// @dynamic\nconst xs: number[] = [1];\nconst u: unknown = xs;\nconst a: any = u;\na.push(2);\nconsole.log(xs.length);")).toBe("2\n");
});

// ── the island array's own edge cases (S110) ───────────────────────────

test("H-OK sp01 builds and answers Node's output", async () => {
  const r = await runRow("HOK-sp01", "// @dynamic\nconst n: any = 5;\ntry { const a: any[] = [1, ...n]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst u: any = undefined;\ntry { const a: any[] = [1, ...u]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst o: any = { a: 1 };\ntry { const a: any[] = [...o.a]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { const a: any[] = [...o]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst s: any = \"héllo\";\nconst b: any[] = [...s];\nconsole.log(`${b.length} ${b.join(\"\")}`);");
  expect(r.stdout).toBe("TypeError n is not iterable\nTypeError u is not iterable\nTypeError o.a is not iterable\nTypeError o is not iterable\n5 héllo\n");
  expect(r.exitCode).toBe(0);
});

test("H-OK sp2 builds and answers Node's output", async () => {
  const r = await runRow("HOK-sp2", "// @dynamic\nconst n: any = 5, u: any = undefined, o: any = { x: 5 };\nfunction f(): any { return 5; }\nconst z: any = null;\nfor (const g of [() => [1, ...n], () => [...u], () => [...o.x], () => [...f()], () => [...z], () => [...(n as any)]]) { try { const r: any[] = g(); console.log(r.length); } catch (e) { console.log((e as Error).message); } }\nconst s: any = \"ab\";\nconst m: any[] = [0, ...s, ...[1, 2]];\nconsole.log(m);");
  expect(r.stdout).toBe("n is not iterable\nu is not iterable\no.x is not iterable\nf is not a function or its return value is not iterable\nz is not iterable\nn is not iterable\n[ 0, 'a', 'b', 1, 2 ]\n");
  expect(r.exitCode).toBe(0);
});

test("H-OK s05-spread builds and answers Node's output", async () => {
  const r = await runRow("HOK-s05-spread", "// @dynamic\nconst xs: any[] = [1, 2];\nconst ys: any[] = [...xs, 3, ...[4, 5], ...\"ab\"];\nconsole.log(ys.join(), ys.length, ys === xs);\nconst zs: any[] = [0, ...xs];\nxs.push(9);\nconsole.log(zs.length);\nconst nums: number[] = [7, 8];\nconst w: any[] = [...nums, ...xs];\nconsole.log(w.join());\ntry { const bad: any[] = [...(5 as any)]; console.log(bad); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst obj: any = { a: [1] }; const copy: any = { ...obj }; copy.a.push(2); console.log(obj.a.length);");
  expect(r.stdout).toBe("1,2,3,4,5,a,b 7 false\n3\n7,8,1,2,9\nTypeError 5 is not iterable\n2\n");
  expect(r.exitCode).toBe(0);
});

test("H-OK m05n builds and answers Node's output", async () => {
  const r = await runRow("HOK-m05n", "// @dynamic\nconst mk = (): any[] => [1, 2, 3, 4, 5];\nlet a = mk(); console.log((a as any).splice(), a.join());\na = mk(); console.log(a.splice(2), a.join());\na = mk(); console.log(a.splice(-2), a.join());\na = mk(); console.log(a.splice(1, -1), a.join());\na = mk(); console.log(a.splice(-10, 2), a.join());\na = mk(); console.log(a.splice(undefined as any), a.join());\na = mk(); console.log(a.splice(1.9, 1.9), a.join());\na = mk(); console.log(a.splice(0, 0, 9, 8, 7), a.join());\na = mk(); console.log(a.splice(NaN, Infinity), a.join());");
  expect(r.stdout).toBe("[] 1,2,3,4,5\n[ 3, 4, 5 ] 1,2\n[ 4, 5 ] 1,2,3\n[] 1,2,3,4,5\n[ 1, 2 ] 3,4,5\n[ 1, 2, 3, 4, 5 ] \n[ 2 ] 1,3,4,5\n[] 9,8,7,1,2,3,4,5\n[ 1, 2, 3, 4, 5 ] \n");
  expect(r.exitCode).toBe(0);
});

test("H-OK m06n builds and answers Node's output", async () => {
  const r = await runRow("HOK-m06n", "// @dynamic\nconst mk = (): any[] => [1, 2, 3, 4, 5];\nconsole.log(mk().fill(0).join(), mk().fill(0, 2).join(), mk().fill(0, -2).join(), mk().fill(0, 1, -1).join(), mk().fill(0, 3, 1).join(), (mk() as any).fill().join(), mk().fill(0, NaN, NaN).join(), mk().fill(0, -10, 10).join());\nconst o: any = { v: 1 }; const f = mk().fill(o); f[0].v = 2; console.log(f[4].v);");
  expect(r.stdout).toBe("0,0,0,0,0 1,2,0,0,0 1,2,3,0,0 1,0,0,0,5 1,2,3,4,5 ,,,, 1,2,3,4,5 0,0,0,0,0\n2\n");
  expect(r.exitCode).toBe(0);
});

test("H-B2 an array-literal spread of a non-iterable throws V8's array-literal wording", async () => {
  const r = await runRow("H-B2", "// @dynamic\nconst n: any = 5;\ntry { const a: any[] = [1, ...n]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst u: any = undefined;\ntry { const a: any[] = [1, ...u]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst o: any = { a: 1 };\ntry { const a: any[] = [...o.a]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { const a: any[] = [...o]; console.log(`${a.length}`); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst s: any = \"h\u00e9llo\";\nconst b: any[] = [...s];\nconsole.log(`${b.length} ${b.join(\"\")}`);");
  expect(r.stdout).toContain("TypeError n is not iterable");
});

test("H-S3 string, boolean and null index arguments run ToNumber on the island array methods", async () => {
  const r = await runRow("H-S3", "// @dynamic\nconst mk = (): any[] => [1, 2, 3, 4, 5];\nconst a = mk();\nconsole.log(a.splice(\"2\" as any, \"1\" as any), a.join());\nconsole.log(mk().fill(0, \"1\" as any, \"3\" as any).join());\nconsole.log(mk().with(\"1\" as any, 9).join());\nconsole.log(mk().slice(\"1\" as any, \"3\" as any).join(), mk().at(\"1\" as any), mk().indexOf(3, \"1\" as any));\nconsole.log(mk().slice(true as any).join(), mk().slice(null as any).join());");
  expect(r.stdout).toBe("[ 3 ] 1,2,4,5\n1,0,0,4,5\n1,9,3,4,5\n2,3 2 2\n2,3,4,5 1,2,3,4,5\n");
});

test("H-S2 a write past an island array's length (Node leaves holes) refuses by name on wasm; the native engine has holes", async () => {
  const entry = join(scratch, "H-S2.ts");
  await writeFile(entry, "// @dynamic\nconst xs: any[] = [1, 2];\nxs[4] = 5;\nconsole.log(xs.length);\n");
  const res = await compile(entry, { outPath: join(scratch, "H-S2.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
  if (!res.ok) throw new Error("H-S2 refused");
  const { runWasmToTrap } = await import("./wasm-host.js");
  const t = await runWasmToTrap(res.binaryPath);
  expect(String(t.stderr)).toContain("writing an island array at index 4 past its length (the holes Node leaves) is not supported yet on the wasm lane");
  const c = await runC("H-S2c", "// @dynamic\nconst xs: any[] = [1, 2];\nxs[4] = 5;\nconsole.log(xs.length);");
  expect(c.stdout).toBe("5\n");
});

test("H-S110c Array.prototype errors on an island array spell V8's texts on the native lanes too", async () => {
  const want = "TypeError Reduce of empty array with no initial value\nTypeError Reduce of empty array with no initial value\nRangeError Invalid index : 7\nTypeError The comparison function must be either a function or undefined: 1\nTypeError The comparison function must be either a function or undefined: #<Object>\n4 3,9 1,3\n";
  expect((await runRow("H-S110c-w", "// @dynamic\nconst xs: any[] = [3, 1];\ntry { ([] as any[]).reduce((a: any) => a); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { ([] as any[]).reduceRight((a: any) => a); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { xs.with(\"7\" as any, 1); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { xs.toSorted(1 as any); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { xs.sort({} as any); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconsole.log(xs.reduce((a: any, b: any) => a + b), xs.with(-1, 9).join(\",\"), xs.toSorted().join(\",\"));")).stdout).toBe(want);
  expect((await runC("H-S110c-c", "// @dynamic\nconst xs: any[] = [3, 1];\ntry { ([] as any[]).reduce((a: any) => a); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { ([] as any[]).reduceRight((a: any) => a); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { xs.with(\"7\" as any, 1); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { xs.toSorted(1 as any); } catch (e) { console.log((e as Error).name, (e as Error).message); }\ntry { xs.sort({} as any); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconsole.log(xs.reduce((a: any, b: any) => a + b), xs.with(-1, 9).join(\",\"), xs.toSorted().join(\",\"));")).stdout).toBe(want);
});

test("H-S2b shrinking an island array's length truncates on wasm; growing it refuses by name (S110 (f))", async () => {
  const r = await runRow("H-S2b", "// @dynamic\nconst a: any[] = [1, 2, 3];\na.length = 1;\nconsole.log(a.length, JSON.stringify(a));\ntry { a.length = 3; } catch (e) { console.log((e as Error).message); }");
  expect(r.stdout).toBe("1 [1]\ngrowing a dynamic array's length past its elements (the holes Node leaves) is not supported yet on the wasm lane\n");
});

test("H-CORPUS-2788 the typed-views corpus program", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/2788-typed-views.ts", import.meta.url));
  const src = await readFile(entry, "utf8");
  const expected = await readFile(entry.replace(/\.ts$/, ".expected"), "utf8").catch(() => null);
  const r = await runRow("H-CORPUS-2788", src.trimEnd());
  if (expected !== null) expect(r.stdout).toBe(expected);
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
});
