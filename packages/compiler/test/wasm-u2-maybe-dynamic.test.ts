/* Unit U2 (SEMANTICS.md S128; docs/design/dynamic-values.md §4.3):
 * maybe-dynamic typed slots on the WasmGC lanes.
 *
 * U2a — the dynamic arm: a dynamic value entering a contained typed slot
 * (a const/let binding, a cast used in place, a function literal's typed
 * parameter dynamic code calls, a direct call's parameter) is the dynamic
 * value itself, shared as in Node; only a value that must enter typed
 * storage is checked, and a wrong kind there ends the program by name.
 * U2b — the speculative typed arm: a fresh value (JSON.parse, ...) bound
 * by a const is a typed copy when it has exactly its type's shape, else
 * the dynamic arm; a mismatch is no longer fatal at the cast.
 *
 * An exact row equals Node (spawned at test time). A `fence` row compiles,
 * prints Node's stdout up to the check, and ends at the named fence (S122).
 * A `refused` row fails to compile with the named code. Rows run on the
 * wasm lane; the wasm-native describe repeats them. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-u2-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  /** The entry's file name (main.ts unless set). */
  entry?: string;
  refused?: { code: string; text?: RegExp };
  fence?: { text: RegExp; stdout: string };
}

/** A shared dynamic value nothing typed holds, handed out as `unknown`. */
const SHARED = (json: string): string => `const shared: any = JSON.parse(${JSON.stringify(json)});\nfunction get(): unknown { return shared; }\n`;

const ROWS: Row[] = [
  // ── U2a: the dynamic arm ─────────────────────────────────────────────
  { id: "U2A-120-01 #120: a push through a cast of an unknown array reaches it", src: `const u: unknown = [1];\n(u as number[]).push(2);\nconsole.log(u);` },
  { id: "U2A-120-02 #120: a write through a cast of an unknown record reaches it", src: `const w: unknown = { k: 1 };\n(w as { k: number }).k = 3;\nconsole.log(w);` },
  { id: "U2A-BIND-01 a cast binding is the shared object: writes, identity", src: `${SHARED('{"n":1}')}type P = { n: number };\nconst p = get() as P;\np.n = 5;\nconsole.log(shared.n, p.n, p === shared);` },
  { id: "U2A-BIND-02 an annotated binding over 'any' shares; array methods run on the object", src: `type C = { items: number[]; name: string };\nconst raw: any = { items: [1, 2], name: "a" };\nconst c: C = raw;\nc.items.push(3);\nc.name = c.name + "!";\nlet total = 0;\nfor (const x of c.items) total += x;\nconsole.log(total, c.items.length, c.items.map((x) => x * 2), raw, c === raw);` },
  { id: "U2A-BIND-03 keys the type does not declare stay (printing, JSON, keys)", src: `${SHARED('{"n":1,"extra":"x"}')}type P = { n: number };\nconst p = get() as P;\np.n = 2;\nconsole.log(p, JSON.stringify(p), Object.keys(p));` },
  { id: "U2A-BIND-04 a missing required key reads as Node reads it (in, ??, typeof)", src: `${SHARED('{"m":1}')}type P = { n: number; m: number };\nconst p = get() as P;\np.m = 2;\nconsole.log("n" in p, "m" in p, p.n ?? 5, p.n === undefined, typeof p.n, shared);` },
  { id: "U2A-BIND-05 Array.isArray and ?. ask the value, not the declared type", src: `${SHARED('{"items":"no","x":null}')}type P = { items: number[]; x: { y: number } };\nconst p = get() as P;\nshared.extra = 1;\nconsole.log(Array.isArray(p.items), p.items.length, p.x?.y, p.x == null, p);` },
  { id: "U2A-BIND-06 typeof and + on a mistyped field run as in Node", src: `${SHARED('{"n":"7"}')}type P = { n: number };\nconst p = get() as P;\nshared.w = 1;\nconsole.log(typeof p.n, typeof p.n === "number", p.n + 1, \`\${p.n}\`, String(p.n), p.n * 2, -p.n, p.n > 4);` },
  { id: "U2A-BIND-07 destructuring, nested reads and their identity", src: `${SHARED('{"a":1,"b":[5,6],"inner":{"v":[1]}}')}type P = { a: number; b: number[]; inner: { v: number[] } };\nconst p = get() as P;\np.b.push(7);\nconst { a, b } = p;\nconst [x, ...rest] = p.b;\nconst inner = p.inner;\ninner.v.push(2);\nconsole.log(a, b, x, rest, b === p.b, inner === p.inner, shared);` },
  { id: "U2A-BIND-08 compound writes, index writes and length", src: `${SHARED('{"n":1,"items":[1,2,3]}')}type P = { n: number; items: number[] };\nconst p = get() as P;\np.n += 1;\np.n++;\n++p.n;\np.items[0] = 9;\np.items[p.items.length] = 10;\np.items.length = 2;\nconsole.log(p, shared === p);` },
  { id: "U2A-BIND-09 closures share the binding", src: `${SHARED('{"n":1}')}type P = { n: number };\nconst p = get() as P;\nconst f = (): number => p.n;\nconst g = () => { p.n = p.n * 10; };\ng();\nshared.n += 1;\nconsole.log(f(), p.n);` },
  { id: "U2A-BIND-10 a let binding takes a new value later", src: `${SHARED('{"n":1}')}type P = { n: number };\nlet p = get() as P;\np.n = 2;\nconsole.log(shared.n);\np = { n: 3 };\np.n = 4;\nconsole.log(p, shared);` },
  { id: "U2A-BIND-11 an unknown local cast into a typed binding inside an async function", src: `${SHARED('{"n":1}')}type P = { n: number };\nasync function run(): Promise<void> {\n  const p = get() as P;\n  await null;\n  p.n = 5;\n  console.log(shared.n);\n}\nrun();` },
  { id: "U2A-BIND-12 an index-signature binding and a tuple binding", src: `${SHARED('{"m":{"a":1},"pt":[1,2]}')}type P = { m: Record<string, number>; pt: [number, number] };\nconst p = get() as P;\np.m["b"] = 2;\np.pt[0] = 5;\nconst [x, y] = p.pt;\nconsole.log(p.m["a"], p.m.b, Object.entries(p.m), x + y, shared);` },
  { id: "U2A-BIND-13 truthiness, || and conditional on the arm", src: `${SHARED('{"n":0,"s":""}')}type P = { n: number; s: string; o?: { z: number } };\nconst p = get() as P;\nshared.t = 1;\nif (p.n) console.log("t"); else console.log("f");\nconsole.log(p.s || "dflt", p.n && "and", !p.s, p.o ? 1 : 2, p.o?.z ?? "none");` },
  { id: "U2A-BIND-14 a union field narrowed by typeof", src: `${SHARED('{"v":"s"}')}type P = { v: number | string };\nconst p = get() as P;\np.v = typeof p.v === "string" ? p.v.toUpperCase() : p.v + 1;\nconsole.log(shared.v);` },
  { id: "U2A-BIND-15 numeric methods on a field", src: `${SHARED('{"n":3}')}type P = { n: number };\nconst p = get() as P;\np.n = 4;\nconsole.log(p.n.toFixed(2), p.n.toString(), Number.isInteger(p.n), Math.max(p.n, 10));` },
  { id: "U2A-CALL-01 a direct call's parameter is the argument itself (S125 (a)'s instance)", src: `${SHARED('{"items":[1],"name":"n"}')}type P = { items: number[]; name: string };\nfunction grow(q: P): number { q.items.push(q.items.length + 1); return q.items.length; }\nfunction sum(xs: number[]): number { let s = 0; for (const v of xs) s += v; return s; }\nfunction label(q: P): string { return q.name.toUpperCase(); }\nconst p = get() as P;\nconsole.log(grow(p), grow(p), sum(p.items), label(p), shared);` },
  { id: "U2A-CALL-02 a dynamic argument into a direct call's typed parameter, through a chain", src: `type P = { n: number; tags: string[] };\nfunction tag(p: P, t: string): void { p.tags.push(t); }\nfunction both(p: P): void { tag(p, "a"); p.n += 1; }\nconst raw: any = JSON.parse('{"n":1,"tags":[],"x":true}');\nboth(raw);\nboth(raw);\nconsole.log(raw);` },
  { id: "U2A-CB-01 a typed callback parameter holds the dynamic element (S115 (d)'s refusal lifted)", src: `const data: any = JSON.parse('[{"a":1,"t":["x"]},{"a":2,"t":[]}]');\ndata.forEach((o: { a: number; t: string[] }, i: number) => { o.a += i * 10; o.t.push("y"); });\nconst doubled = data.map((o: { a: number }) => o.a * 2);\nconsole.log(data, doubled);` },
  { id: "U2A-CB-02 a typed callback stored into a dynamic object shares what it is called with", src: `const api: any = { each(f: any): any { const o: any = { name: "a", tags: ["x"] }; f(o); return o; } };\nconsole.log(api.each((o: { name: string; tags: string[] }) => { o.name = "b"; o.tags.push("y"); }));\nconst cb: any = (xs: number[]) => { xs.push(9); return xs.length; };\nconst a2: any = [5];\nconsole.log(cb(a2), a2);` },
  { id: "U2A-CB-03 an unannotated callback on the arm gets what the array holds", src: `function main(): void {\n  const xs = JSON.parse('[1,2,"3"]') as number[];\n  console.log(xs.length, xs.map((x) => typeof x), xs);\n}\nmain();` },
  { id: "U2A-OK-01 a judged copy nothing could tell apart takes the arm too: Node's keys", src: `${SHARED('{"n":1,"extra":"x"}')}type P = { n: number };\nconst p = get() as P;\nconsole.log(p, JSON.stringify(p), Object.keys(p), p.n);` },
  { id: "U2A-OK-02 a construct the arm cannot run keeps the judged copy (switch on a dynamic value)", src: `${SHARED('{"k":"b","b":"s"}')}type S = { k: "a"; a: number } | { k: "b"; b: string };\nconst s = get() as S;\nswitch (s.k) { case "a": console.log(1); break; case "b": console.log(2, s.b); break; }` },
  { id: "U2A-JS-01 a JavaScript JSDoc-typed binding over a dynamic value shares it", entry: "main.js", src: `/** @typedef {{ n: number, list: number[] }} P */\nconst raw = JSON.parse('{"n":1,"list":[1]}');\n/** @type {P} */\nconst p = raw;\np.list.push(2);\np.n = 3;\nconsole.log(raw, p.list.length);` },
  {
    id: "U2A-FENCE-01 a mistyped field entering a typed local ends the program by name",
    src: `${SHARED('{"n":"5"}')}type P = { n: number };\nconst p = get() as P;\nshared.k = 0;\nconsole.log("before");\nconst k: number = p.n;\nconsole.log("after", k);`,
    fence: { text: /expected number, got string/, stdout: "before\n" },
  },
  {
    id: "U2A-J4-01 a typed field never takes the arm: the observable copy refuses (decision J4)",
    src: `${SHARED('{"n":1}')}type P = { n: number };\nconst p = get() as P;\nconst box: { p: P } = { p };\nbox.p.n = 9;\nconsole.log(shared.n);`,
    refused: { code: "SC1090", text: /it would be a COPY where JavaScript shares the object/ },
  },
  // ── the U2 review's repros (F1, F2, F4) ─────────────────────────────
  { id: "U2R-F2-01 the review's f1: a parsed config that does not fit runs the program's own validation", src: "type Cfg = { name: string; port: number };\nfunction load(text: string): void {\n  const cfg = JSON.parse(text) as Cfg;\n  console.log(Object.keys(cfg).join(\",\"), JSON.stringify(cfg));\n  if (typeof cfg.port !== \"number\") console.log(\"bad port\");\n}\nload('{\"port\":80,\"name\":\"a\",\"debug\":true}');\nload('{\"name\":\"b\",\"port\":\"x\"}');" },
  { id: "U2R-F2-02 the review's f2: a dead `throw new Error(\"bad \" + cfg.port)` in the scope no longer drops the binding to a width copy", src: "type Cfg = { name: string; port: number };\nfunction load(text: string): void {\n  const cfg = JSON.parse(text) as Cfg;\n  console.log(Object.keys(cfg).join(\",\"), JSON.stringify(cfg));\n  if (typeof cfg.port !== \"number\") console.log(\"bad port\");\n  if (cfg.name === \"zz\") throw new Error(\"bad \" + cfg.port);\n}\nload('{\"port\":80,\"name\":\"a\",\"debug\":true}');\nload('{\"name\":\"b\",\"port\":\"x\"}');" },
  { id: "U2R-F2-03 a switch on a dynamic-arm field in the scope (g1)", src: "type Cfg = { name: string; port: number; tags: string[] };\nfunction load(text: string): void {\n  const cfg = JSON.parse(text) as Cfg;\n  console.log(Object.keys(cfg).join(\",\"));\n  if (cfg.name === \"zz\") { switch (cfg.port) { case 1: console.log(1); break; default: console.log(2); } }\n}\nload('{\"port\":80,\"name\":\"a\",\"tags\":[\"q\"],\"debug\":true}');" },
  { id: "U2R-F2-04 for-in over the binding (no dynamic form yet): the exact-fit copy stops by name, never a width copy (g2)", src: "type Cfg = { name: string; port: number; tags: string[] };\nfunction load(text: string): void {\n  const cfg = JSON.parse(text) as Cfg;\n  console.log(Object.keys(cfg).join(\",\"));\n  if (cfg.name === \"zz\") { for (const k in cfg) console.log(k); }\n}\nload('{\"port\":80,\"name\":\"a\",\"tags\":[\"q\"],\"debug\":true}');", fence: { text: /does not have exactly its cast's shape/, stdout: "" } },
  { id: "U2R-F2-05 new Map(Object.entries(...)) over the binding (no dynamic form yet): stops by name (g9)", src: "type Cfg = { name: string; port: number; tags: string[] };\nfunction load(text: string): void {\n  const cfg = JSON.parse(text) as Cfg;\n  console.log(Object.keys(cfg).join(\",\"));\n  if (cfg.name === \"zz\") { console.log(new Map(Object.entries(cfg)).size); }\n}\nload('{\"port\":80,\"name\":\"a\",\"tags\":[\"q\"],\"debug\":true}');", fence: { text: /does not have exactly its cast's shape/, stdout: "" } },
  { id: "U2R-F2-06 a number's toString(radix) on the binding (no dynamic form yet): stops by name (g19)", src: "type Cfg = { name: string; port: number; tags: string[] };\nfunction load(text: string): void {\n  const cfg = JSON.parse(text) as Cfg;\n  console.log(Object.keys(cfg).join(\",\"));\n  if (cfg.name === \"zz\") { console.log(cfg.port.toString(16)); }\n}\nload('{\"port\":80,\"name\":\"a\",\"tags\":[\"q\"],\"debug\":true}');", fence: { text: /does not have exactly its cast's shape/, stdout: "" } },
  { id: "U2R-F2-07 the review's r4: U2a binding, string concatenation inside a throw (the '+' result is a string)", src: "const shared: any = JSON.parse('{\"a\":2,\"tags\":[\"x\",\"y\"],\"more\":true}');\nfunction get(): unknown { return shared; }\ntype P = { a: number; tags: string[] };\nconst v = get() as P;\ntry {\n  if (v.tags.length > 1) throw new Error(\"many \" + v.tags.length);\n} catch (e) { console.log((e as Error).message); }\nconsole.log(v);\nconst s: string = \"n=\" + v.a;\nconsole.log(s, s.length);" },
  { id: "U2R-F2-08 the review's r5", src: "const shared: any = JSON.parse('{\"a\":2,\"tags\":[\"x\",\"y\"],\"more\":true}');\nfunction get(): unknown { return shared; }\ntype P = { a: number; tags: string[] };\nconst v = get() as P;\nconsole.log(v);\nconst s: string = \"n=\" + v.a;\nconsole.log(s, s.length);" },
  { id: "U2R-F2-09 a switch on dynamic-arm string and number fields", src: "const shared: any = JSON.parse('{\"name\":\"a\",\"port\":80,\"tags\":[\"q\"],\"debug\":true}');\nfunction get(): unknown { return shared; }\ntype Cfg = { name: string; port: number; tags: string[] };\nconst cfg = get() as Cfg;\ncfg.port = 81;\nswitch (cfg.port) { case 81: console.log(1); break; default: console.log(2); }\nswitch (cfg.name) { case 'a': console.log('A'); break; }" },
  { id: "U2R-F2-10 an Error message on the dynamic arm", src: "const shared: any = JSON.parse('{\"name\":\"a\",\"port\":80,\"tags\":[\"q\"],\"debug\":true}');\nfunction get(): unknown { return shared; }\ntype Cfg = { name: string; port: number; tags: string[] };\nconst cfg = get() as Cfg;\ncfg.port = 81;\ntry { throw new Error(cfg.name); } catch (e) { console.log((e as Error).message); }" },
  { id: "U2R-F4-01 reduce over mistyped elements: the callback's result is the dynamic value", src: "const shared: any = JSON.parse('{\"xs\":[1,\"2\",3]}');\nfunction get(): unknown { return shared; }\ntype P = { xs: number[] };\nconst p = get() as P;\np.xs.push(4);\nconsole.log(p.xs.reduce((a, b) => a + b, 0));" },
  { id: "U2R-F1-01 a copy of a dynamic-arm value into an element stops by name when it does not fit", src: "type P = { n: number };\nconst raw: any = JSON.parse('{\"n\":1,\"s\":\"x\"}');\nconst p: P = raw;\np.n = 3;\nconst arr: P[] = [p];\nconsole.log(arr[0]);", fence: { text: /copied into typed storage it does not fit exactly/, stdout: "" } },
  { id: "U2R-F1-02 ... into a field (an object literal handed to JSON.stringify)", src: "type P = { n: number };\nconst raw: any = JSON.parse('{\"n\":1,\"s\":\"x\"}');\nconst p: P = raw;\np.n = 3;\nconsole.log(JSON.stringify({ p }));", fence: { text: /copied into typed storage it does not fit exactly/, stdout: "" } },
  { id: "U2R-F1-03 ... by a let reassignment", src: "type P = { n: number };\nconst raw: any = JSON.parse('{\"n\":1,\"s\":\"x\"}');\nconst p: P = raw;\np.n = 3;\nlet q: P = { n: 0 };\nq = p;\nconsole.log(q, Object.keys(q));", fence: { text: /copied into typed storage it does not fit exactly/, stdout: "" } },
  { id: "U2R-F1-04 ... by a module-scope alias", src: "type P = { n: number };\nconst raw: any = JSON.parse('{\"n\":1,\"s\":\"x\"}');\nconst p: P = raw;\np.n = 3;\nconst q = p;\nfunction show(): P { return q; }\nconsole.log(q, show());", fence: { text: /copied into typed storage it does not fit exactly/, stdout: "" } },
  { id: "U2R2-K1 a copy from an arm value with an absent optional key keeps the absence (GH #132), as Node prints it", src: "type P = { n: number; o?: number; inner?: { a: number; b?: string } };\nconst raw: any = JSON.parse('{\"n\":1,\"inner\":{\"a\":1}}');\nconst p: P = raw;\np.n = 3;\nconsole.log(raw.n);\nconst arr: P[] = [p];\nconsole.log(arr[0], Object.keys(arr[0]), JSON.stringify(arr[0]), \"o\" in arr[0]);\nconst box: { p: P } = { p };\nconsole.log(box);" },
  { id: "U2R2-DZ2 a dead for-in in a parsed binding's scope, an absent optional key: the exact-fit copy keeps the absence (GH #132), never `port: undefined`", src: "type Cfg = { name: string; port?: number };\nfunction load(t: string) {\n  const cfg = JSON.parse(t) as Cfg;\n  console.log(cfg);\n  if (cfg.name === \"zz\") for (const k in cfg) console.log(k);\n}\nload('{\"name\":\"a\"}');" },
  { id: "U2R2-DZ4 the non-fresh form with a dead construct the arm cannot build: an absent optional key fits the exact-fit copy (GH #132)", src: "const shared: any = JSON.parse('{\"name\":\"a\"}');\nfunction get(): unknown { return shared; }\ntype Cfg = { name: string; port?: number };\nconst c = get() as Cfg;\nconsole.log(c);\nif (c.name === \"zz\") console.log(Object.is(c.port, 1));" },
  { id: "U2R2-JS-01 JavaScript: methods called through a cast to any, an alias, an element and .call all bind this (S042's JS residue retired)", entry: "main.js", src: "/** @typedef {{ n: number }} P */\nconst raw = JSON.parse('{\"n\":1}');\nraw.inc = function () { this.n++; return this.n; };\n/** @type {P} */\nconst p = raw;\np.n = 3;\ntry { console.log(/** @type {any} */ (p).inc()); } catch (e) { console.log(\"caught\", e.message); }\nconst a = /** @type {any} */ (p);\ntry { console.log(a.inc()); } catch (e) { console.log(\"caught\", e.message); }\nconsole.log(p[\"inc\"](), p.inc.call(p));" },
  { id: "U2R2-JS-02 JavaScript: a method called through a plain alias of a parsed object binds this (GH #145)", entry: "main.js", src: "const o = JSON.parse('{\"count\":1}');\no.inc = function () { this.count++; };\nconst x = o;\nx.inc();\nx.count = 5;\nconsole.log(o.count);" },
  { id: "U2R2-JS-03 JavaScript: a method called through a JSDoc-typed binding binds this", entry: "main.js", src: "const o = { count: 1 };\no.inc = function () { this.count++; };\nconst x = o;\nx.inc();\nx.count = 5;\nconsole.log(o.count);" },
  { id: "U2R3-THIS-01 JavaScript (strict): a plain call, a function callback and an IIFE inside a method run with this undefined, never the method's receiver", entry: "main.js", src: "\"use strict\";\nfunction helper() { return this === undefined ? \"undef\" : \"leak:\" + this.n; }\nconst o = JSON.parse('{\"n\":1}');\no.h2 = function () { const f = helper; return f(); };\no.h3 = function () { return [1].map(function () { return this === undefined ? \"undef\" : \"leak\"; })[0]; };\no.h4 = function () { return (function () { return this === undefined ? \"undef\" : \"leak\"; })(); };\no.h5 = function () { const inner = function () { return this === undefined ? \"undef\" : this.n; }; return inner(); };\nconsole.log(o.h2(), o.h3(), o.h4(), o.h5());" },
  { id: "U2R3-THIS-02 JavaScript (strict): a function value handed to a method and called there runs with this undefined", entry: "main.js", src: "\"use strict\";\nconst o = JSON.parse('{\"n\":1}');\no.h = function () { const inner = function () { return this === undefined ? \"undef\" : this.n; }; return inner(); };\nconsole.log(o.h());\no.cb = function (g) { return g(); };\no.m = function () { return this === undefined ? \"undef\" : this.n; };\nconsole.log(o.cb(o.m));\nconst q = JSON.parse('{\"n\":2,\"run\":null}'); q.run = function (f) { return f(); };\nconsole.log(q.run(o.m));" },
  { id: "U2R3-UM-01 a copy from an arm value whose absent required key is union-typed stops by name (it would print `m: undefined`)", src: "type P = { n: number; m: number | null };\nconst raw: any = JSON.parse('{\"n\":1}');\nconst p: P = raw;\np.n = 3;\nconsole.log(raw.n);\nconst arr: P[] = [p];\nconsole.log(arr[0], Object.keys(arr[0]));", fence: { text: /copied into typed storage it does not fit exactly/, stdout: "3\n" } },
  { id: "U2R3-UM-02 a parsed binding with absent union-typed keys and a dead for-in: stops by name, never `m: undefined`", src: "type P = { n: number; m: string | number; o: { a: number } | null; t: [number] | string[] };\nfunction f(t: string) { const v = JSON.parse(t) as P; console.log(v, Object.keys(v)); if (v.n === -1) for (const k in v) console.log(k); }\nf('{\"n\":1}');", fence: { text: /does not have exactly its cast's shape/, stdout: "" } },
  { id: "U2R3-UM-03 the review's um3", src: "type P = { n: number; m: string | number; o: { a: number } | null; t: [number] | string[] };\nfunction f(t: string) { const v = JSON.parse(t) as P; console.log(v, Object.keys(v)); }\nf('{\"n\":1}');" },
  { id: "U2R4-ASYNC-01 JavaScript (strict): an async function declaration called plainly inside a method starts with this undefined (its arrows read undefined)", entry: "main.js", src: "\"use strict\";\nconst T = (x) => (x === undefined ? \"undef\" : \"leak:\" + x.n);\nfunction plain() { return T(this); }\nconst o = JSON.parse('{\"n\":1}');\nasync function ha() { const g = () => T(this); return g(); } o.x = function () { return ha(); };\no.x().then((v) => console.log(v));" },
  { id: "U2R4-ASYNC-02 ... called from an async method, the callee awaiting", entry: "main.js", src: "\"use strict\";\nconst T = (x) => (x === undefined ? \"undef\" : \"leak:\" + x.n);\nfunction plain() { return T(this); }\nconst o = JSON.parse('{\"n\":1}');\nasync function ha() { const g = () => T(this); await 0; return g(); } o.x = async function () { return ha(); };\no.x().then((v) => console.log(v));" },
  { id: "U2R4-ASYNC-03 ... inside a method itself called as a member of another object", entry: "main.js", src: "\"use strict\";\nconst T = (x) => (x === undefined ? \"undef\" : \"leak:\" + x.n);\nfunction plain() { return T(this); }\nconst o = JSON.parse('{\"n\":1}');\nasync function ha() { const g = () => T(this); return g(); } o.x = function () { return ha(); }; const p = JSON.parse('{\"n\":3}'); p.y = o.x; o.x = function () { return p.y(); };\nPromise.resolve(o.x()).then((v) => console.log(v));" },
  { id: "U2R4-ASYNC-04 ... called from an arrow stored as a method", entry: "main.js", src: "\"use strict\";\nconst T = (x) => (x === undefined ? \"undef\" : \"leak:\" + x.n);\nfunction plain() { return T(this); }\nconst o = JSON.parse('{\"n\":1}');\nasync function ha() { const g = () => T(this); return g(); } o.x = () => ha();\nPromise.resolve(o.x()).then((v) => console.log(v));" },
  { id: "U2R4-ASYNC-05 ... and called as a member it starts with that receiver; through a value, undefined", entry: "main.js", src: "\"use strict\";\nconst T = (x) => (x === undefined ? \"undef\" : \"leak:\" + x.n);\nconst p = JSON.parse('{\"n\":5}');\nasync function ha() { const g = () => T(this); return g(); }\np.ha = ha;\np.ha().then((v) => console.log(v));\nconst f = ha;\nf().then((v) => console.log(v));" },
  { id: "U2R5-ORD-01 GH #132: a parse with an absent optional key fits; a later write of the key puts it last, as in Node", src: "type T = { a?: number; b: number };\nconst c = JSON.parse('{\"b\":2}') as T;\nconsole.log(Object.keys(c), JSON.stringify(c), c);\nc.a = 1;\nconsole.log(Object.keys(c), JSON.stringify(c), c, c.a + c.b);" },
  { id: "U2R5-ORD-02 ... an optional key a dynamic value holds as undefined does not fit (Node keeps the key); a write of undefined keeps it", src: "type T = { a?: number; b: number };\nconst src: any = { a: undefined, b: 2 };\nconst c = src as T;\nconsole.log(c, Object.keys(c), \"a\" in c);\nconst d = JSON.parse('{\"a\":1,\"b\":2}') as T;\nd.a = undefined;\nconsole.log(d, Object.keys(d));\nconst e = JSON.parse('{\"b\":2}') as T;\nconst s2: any = e;\ns2.a = undefined;\nconsole.log(e, Object.keys(e));" },
  { id: "U2R5-ORD-03 ... spread, delete and re-add on a fitting parse keep Node's key order", src: "type T = { a?: number; b: number; c?: string };\nconst x = JSON.parse('{\"a\":1,\"b\":2}') as T;\nconst y = { ...x, z: 1 };\nconsole.log(y, Object.keys(y));\ndelete x.a;\nconsole.log(x, Object.keys(x));\nx.c = \"s\"; x.a = 5;\nconsole.log(x, Object.keys(x), JSON.stringify(x));\nfor (const k in x) console.log(k);" },
  { id: "U2R5-ORD-04 ... parsed elements written through a typed parameter keep each one's own order", src: "type T = { a?: number; b: number };\nfunction f(t: T): void { t.a = 3; console.log(t, Object.keys(t), Object.entries(t)); }\nconst arr = JSON.parse('[{\"b\":1},{\"a\":1,\"b\":2},{\"b\":3,\"a\":4}]') as T[];\nfor (const t of arr) f(t);\nconst one = JSON.parse('{\"b\":9}') as T;\nf(one);" },
  { id: "U2R5-ORD-05 ... an integer key ahead of the others, then a late optional key", src: "type T = { \"1\"?: number; b: number; a?: number };\nconst c = JSON.parse('{\"b\":2,\"1\":3}') as T;\nconsole.log(c, Object.keys(c));\nc.a = 4;\nconsole.log(c, Object.keys(c), JSON.stringify(c));" },
  { id: "U2R5-ORD-06 ... absent optional keys of several kinds, `in`, and a late write", src: "type N = { p?: number; q: number; r?: string };\nconst c = JSON.parse('{\"q\":1,\"r\":\"x\"}') as N;\nconsole.log(c, Object.keys(c), JSON.stringify(c), \"p\" in c);\nc.p = 7;\nconsole.log(c, Object.keys(c), JSON.stringify(c));\nconst d = JSON.parse('{\"q\":1}') as N;\nconst total: number = d.q + (d.p ?? 0);\nconsole.log(total, d);" },
  { id: "U2R5-ORD-07 a module-scope spread of a dynamic-arm value into an unannotated binding keeps the value's own order", src: "type N = { p?: number; q: number };\nconst c = JSON.parse('{\"q\":1}') as N;\nc.p = 2;\nconsole.log(Object.keys(c));\nconst s = { ...c };\nconsole.log(Object.keys(s), JSON.stringify(s), s);" },
  { id: "U2R5-ORD-08 ... printed directly", src: "type N = { p?: number; q: number };\nconst c = JSON.parse('{\"q\":1}') as N;\nc.p = 2;\nconst s = { ...c };\nconsole.log(s);" },
  { id: "U2R5-ORD-09 ... beside Object.keys of the binding", src: "type N = { p?: number; q: number };\nconst c = JSON.parse('{\"q\":1}') as N;\nc.p = 2;\nconsole.log(c, Object.keys(c));\nconst s = { ...c };\nconsole.log(s);" },
  { id: "U2R5-ORD-10 a module-scope rest of a dynamic-arm value out of its type's order stops by name, never a reordered copy", src: "type N = { p?: number; q: number };\nconst c = JSON.parse('{\"q\":1}') as N;\nc.p = 2;\nconst r: N = c;\nconst { ...s } = c;\nconsole.log(c, s);", fence: { text: /does not fit exactly/, stdout: "" } },
  { id: "U2R5-ORD-11 ... the rest of a nested write, beside its sibling binding", src: "type T = { a?: string; b: string; n?: { p?: number; q: number } };\nconst c = JSON.parse('{\"b\":\"x\",\"n\":{\"q\":1}}') as T;\nif (c.n) { c.n.p = 2; }\nconst { b, ...rest } = c;\nconsole.log(b, rest);", fence: { text: /does not fit exactly/, stdout: "" } },
  { id: "U2R6-148-01 GH #148: a module-scope spread of a dynamic-arm value, through an unannotated binding into a narrower one, keeps every key", src: "type Wide = { a: number; b: number };\ntype Narrow = { a: number };\nconst w = JSON.parse('{\"b\":2,\"a\":1}') as Wide;\nconst n: Narrow = { ...w };\nconsole.log(n);\nconst k = { ...w };\nconst j: Narrow = k;\nconsole.log(j, k);" },
  { id: "U2R6-148-02 ... a spread of an arm value returned or bound as a narrower type stops by name, never dropping keys", src: "type Wide = { a: number; b: number };\ntype Narrow = { a: number };\nconst shared: any = JSON.parse('{\"a\":1,\"b\":2,\"z\":9}');\nfunction get(): unknown { return shared; }\nfunction f(): Narrow {\n  const w = get() as Wide;\n  return { ...w };\n}\nconst r = f();\nconsole.log(r, Object.keys(r));\nfunction g(): void {\n  const w = get() as Wide;\n  const n: Narrow | undefined = w.a > 0 ? { ...w } : undefined;\n  console.log(n);\n}\ng();", fence: { text: /does not fit exactly/, stdout: "" } },
  { id: "U2R6-148-03 ... and a fitting parse spread into a narrower printed binding refuses by name (#148's judgement)", src: "type Wide = { a: number; b: number };\ntype Narrow = { a: number };\nfunction main(): void {\n  const w = JSON.parse('{\"a\":1,\"b\":2}') as Wide;\n  const n: Narrow = { ...w };\n  console.log(n, Object.keys(n));\n  const m: Narrow = { ...w, a: 3 };\n  console.log(m);\n}\nmain();", refused: { code: "SC1090" } },
  { id: "U2R7-148-01 a fitting module-scope parse that crosses into `any`, then takes a spread of a dynamic value into its typed array, refuses by name (the crossing sees the copy), never dropping keys", src: "type N = { a: number };\ntype C = { list: N[] };\nconst cfg = JSON.parse('{\"list\":[{\"a\":1}]}') as C;\nconst wide: any = JSON.parse(`{\"a\":2,\"b\":3}`);\ncfg.list.push({ ...wide });\nconst view: any = cfg;\nconsole.log(JSON.stringify(view), Object.keys(view.list[1]));", refused: { code: "SC1090", text: /an object spread of a dynamic value into/ } },
  { id: "U2R7-148-02 ... the parse pushed into an `any[]` first", src: "type N = { a: number };\ntype C = { list: N[] };\nconst sink: any[] = [];\nconst cfg = JSON.parse('{\"list\":[{\"a\":1}]}') as C;\nsink.push(cfg);\nconst wide: any = JSON.parse(`{\"a\":2,\"b\":3}`);\ncfg.list.push({ ...wide });\nconsole.log(JSON.stringify(sink[0]));", refused: { code: "SC1090", text: /an object spread of a dynamic value into/ } },
  { id: "U2R7-148-03 ... the same program in a function scope refuses too", src: "type N = { a: number };\ntype C = { list: N[] };\nfunction main() {\n  const cfg = JSON.parse('{\"list\":[{\"a\":1}]}') as C;\n  const wide: any = JSON.parse('{\"a\":2,\"b\":3}');\n  cfg.list.push({ ...wide });\n  const view: any = cfg;\n  console.log(JSON.stringify(view));\n}\nmain();", refused: { code: "SC1090", text: /an object spread of a dynamic value into/ } },
  { id: "U2R7-148-04 a module-scope speculative binding's own view does not make an unrelated narrowing spread refuse", src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nconst n: Narrow = { ...x, a: 3 };\nconsole.log(n.b, n.a);\nfunction mk(y: any): Narrow { return { ...y }; }\nconsole.log(mk(x).b);" },
  // ── U2b: the speculative typed arm ───────────────────────────────────
  { id: "U2B-01 a parsed value that does not fit its cast runs the program's own validation", src: `type U = { id: string; name: string };\nfunction main(): void {\n  const v = JSON.parse('{"id":5,"name":"x"}') as U;\n  if (typeof v.id !== "string") console.log("bad id", v.id);\n  else console.log("ok", v.id.length);\n  console.log(v);\n}\nmain();` },
  { id: "U2B-02 the same at module scope", src: `type U = { id: string; name: string };\nconst v = JSON.parse('{"id":5,"name":"x"}') as U;\nif (typeof v.id !== "string") console.log("bad id", v.id);\nelse console.log("ok", v.id.length);\nconsole.log(v);` },
  { id: "U2B-03 a fitting value is the typed copy", src: `type U = { id: string; name: string };\nfunction main(): void {\n  const v = JSON.parse('{"id":"a","name":"x"}') as U;\n  console.log(v, v.id.length, Object.keys(v));\n}\nmain();` },
  { id: "U2B-04 extra keys and other key orders keep Node's keys", src: `type U = { name: string; id: string };\nfunction main(): void {\n  const a = JSON.parse('{"name":"x","id":"q","extra":1}') as U;\n  const b = JSON.parse('{"id":"q","name":"x"}') as U;\n  const c = JSON.parse('{"name":"x","id":"q"}') as U;\n  console.log(a, Object.keys(a), JSON.stringify(a), b, Object.keys(b), c, a.name.toUpperCase());\n}\nmain();` },
  { id: "U2B-05 two speculative bindings, one fitting, one not", src: `type A = { a: number };\ntype B = { b: string[] };\nfunction main(): void {\n  const x = JSON.parse('{"a":1}') as A;\n  const y = JSON.parse('{"b":["q"],"z":0}') as B;\n  y.b.push("r");\n  x.a += 1;\n  console.log(x, y, x.a + y.b.length);\n}\nmain();` },
  { id: "U2B-06 a closure over a speculative binding", src: `type A = { n: number };\nfunction main(): () => number {\n  const x = JSON.parse('{"n":1,"k":2}') as A;\n  const get = (): number => x.n;\n  x.n = 5;\n  return get;\n}\nconsole.log(main()());` },
  { id: "U2B-07 across awaits", src: `type A = { n: number; tags: string[] };\nasync function load(s: string): Promise<void> {\n  await null;\n  const v = JSON.parse(s) as A;\n  await null;\n  v.tags.push("t");\n  console.log(v, v.n);\n}\nload('{"n":1,"tags":[]}').then(() => load('{"n":"one","tags":[]}'));` },
  { id: "U2B-08 in a loop, each value on its own arm", src: `type A = { n: number };\nfunction main(): void {\n  const srcs = ['{"n":1}', '{"n":"2"}', '{"n":3,"m":1}'];\n  let total = 0;\n  for (const s of srcs) {\n    const a = JSON.parse(s) as A;\n    console.log(typeof a.n, a);\n    if (typeof a.n === "number") total += a.n;\n  }\n  console.log(total);\n}\nmain();` },
  { id: "U2B-09 an annotated binding, a union and arrays", src: `type A = { n: number; s: string };\ntype S = { k: "a"; a: number } | { k: "b"; b: string };\nfunction main(): void {\n  const a: A = JSON.parse('{"s":"x","n":2}');\n  const s = JSON.parse('{"k":"b","b":"x"}') as S;\n  if (s.k === "b") console.log(s.b.toUpperCase());\n  const ys = JSON.parse('[1,2,3]') as number[];\n  ys.push(4);\n  console.log(a, a.n * 2, s, ys, ys.reduce((p, q) => p + q, 0));\n}\nmain();` },
  { id: "U2B-10 a speculative binding passed to typed functions on either arm", src: `type A = { n: number; xs: number[] };\nfunction total(a: A): number { let t = a.n; for (const x of a.xs) t += x; return t; }\nfunction main(): void {\n  const a = JSON.parse('{"n":1,"xs":[1,2],"extra":true}') as A;\n  const b = JSON.parse('{"n":1,"xs":[1,2]}') as A;\n  console.log(total(a), total(b), a, b);\n}\nmain();` },
  { id: "U2B-11 module scope: functions read either arm", src: `type C = { port: number; hosts: string[] };\nconst cfg = JSON.parse('{"port":"80","hosts":["a"],"x":1}') as C;\nconst ok = JSON.parse('{"port":81,"hosts":["b"]}') as C;\nfunction addHost(h: string): void { cfg.hosts.push(h); ok.hosts.push(h); }\nfunction show(): string { return \`\${cfg.port}:\${cfg.hosts.join(",")} \${ok.port}:\${ok.hosts.join(",")}\`; }\naddHost("z");\nconsole.log(show(), cfg, ok);` },
  { id: "U2B-12 module scope: a closure made before the value is known shares the typed copy", src: `type C = { n: number };\nfunction mk(): () => number { return () => cfg.n; }\nlet early: () => number = () => 0;\nfunction setup(): void { early = mk(); }\nfunction read(): number { return cfg.n; }\ntry { console.log(read()); } catch (e) { console.log((e as Error).name, (e as Error).message); }\nconst cfg = JSON.parse('{"n":1}') as C;\nsetup();\ncfg.n = 5;\nconsole.log(early(), cfg.n, read());` },
  { id: "U2B-13 module scope: a class field initializer reading the binding keeps the eager copy", src: `type C = { n: number };\nconst data = JSON.parse('{"n":4}') as C;\nclass K { v = data.n * 2; }\nconsole.log(new K().v);` },
  {
    id: "U2B-FENCE-01 a mistyped value entering a typed local ends the program by name",
    src: `type A = { n: number };\nfunction main(): void {\n  const a = JSON.parse('{"n":"7"}') as A;\n  console.log("got", a.n);\n  const k: number = a.n;\n  console.log("never", k);\n}\nmain();`,
    fence: { text: /expected number, got string/, stdout: "got 7\n" },
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
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
  if (row.refused !== undefined) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const named = res.diagnostics.filter((d) => d.code === row.refused!.code);
    expect(named.length, JSON.stringify(res.diagnostics)).toBeGreaterThan(0);
    if (row.refused.text) expect(named.some((d) => row.refused!.text!.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  if (row.fence !== undefined) {
    const got: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(got.stdout)).toBe(true);
    expect(got.stderr.split("\n")[0]).toMatch(/^tsinter: unsupported: /);
    expect(got.stderr.split("\n")[0]).toMatch(row.fence.text);
    return;
  }
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got).toEqual(node);
}

describe("U2: maybe-dynamic typed slots (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("U2: maybe-dynamic typed slots (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
