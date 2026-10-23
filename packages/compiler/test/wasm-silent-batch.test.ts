/* The silent-wrong-answer batch (boards #228, #229, #191, #205, #192,
 * #195, #204, #203, #164, #178 and #230): one row per mechanism, each
 * asserting Node v24.18.1's own output, except the rows that pin a
 * registered divergence (SEMANTICS.md S091, Node's answer beside them)
 * and the trap rows (a named refusal where Node throws or the tier has no
 * lowering). A .cjs row builds the way the differential harness builds a
 * JavaScript file (checked-dynamic); a .ts row with a `// @dynamic` head
 * builds with --dynamic. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-silent-batch-"));
  await mkdir(join(scratch, "esm"));
  await mkdir(join(scratch, "cjs"));
  await writeFile(join(scratch, "esm", "package.json"), '{"type":"module"}\n');
  await writeFile(join(scratch, "cjs", "package.json"), '{"type":"commonjs"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function isDynamic(src: string, ext: string): boolean {
  return ext === "cjs" || ext === "js" || /^\/\/ @dynamic\s*$/m.test(src.split("\n", 2).join("\n"));
}

async function build(id: string, src: string, ext: string): Promise<string> {
  const dir = join(scratch, ext === "cjs" ? "cjs" : "esm");
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src, ext) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  return res.binaryPath;
}

async function runRow(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const run = await runWasm(await build(id, src, ext));
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

async function runRowTrap(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string }> {
  const run = await runWasmToTrap(await build(id, src, ext));
  return { stdout: String(run.stdout), stderr: String(run.stderr) };
}

// ============================================================
// CAUGHTSTR
// ============================================================

test("T228A CAUGHTSTR: a thrown dyn array, object, typed array and scalars, in a module with no other dyn machinery", async () => {
  const { stdout, stderr, exitCode } = await runRow("T228A", "try { throw JSON.parse(\"[1,2]\"); } catch (e) { console.log(String(e)); }\ntry { throw JSON.parse('{\"a\":1}'); } catch (e) { console.log(String(e), `${e}`); }\ntry { throw \"s\"; } catch (e) { console.log(String(e)); }\ntry { throw 5; } catch (e) { console.log(String(e)); }", "cjs");
  expect(stdout).toBe("1,2\n[object Object] [object Object]\ns\n5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T195A CAUGHTSTR: thrown dyn values of every kind, an island undefined, and a dyn rejection reason", async () => {
  const { stdout, stderr, exitCode } = await runRow("T195A", "const vals = JSON.parse('[\"s\", 5, true, null, [1,2], {\"a\":1}]');\nfor (let i = 0; i < 6; i++) {\n  const x = vals[i];\n  try { throw x; } catch (e) { console.log(String(e), `${e}`); }\n}\nlet u;\ntry { throw u; } catch (e) { console.log(String(e)); }\nPromise.reject(JSON.parse(\"[3,4]\")).catch((e) => console.log(\"p\", String(e)));", "cjs");
  expect(stdout).toBe("s s\n5 5\ntrue true\nnull null\n1,2 1,2\n[object Object] [object Object]\nundefined\np 3,4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// NULLPROTO
// ============================================================

test("T229A NULLPROTO: an http agent's sockets table is a null-prototype object: String() refuses by name where Node throws", async () => {
  // Node v24 prints "before\n" and then throws; this tier refuses by name.
  const { stdout, stderr } = await runRowTrap("T229A", "const http = require(\"http\");\nconst a = new http.Agent();\nconsole.log(\"before\");\nconsole.log(String(a.sockets));", "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toContain("converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet");
});

// ============================================================
// OBJPROTO
// ============================================================

test("T191A OBJPROTO: Object.prototype method calls on dyn objects, arrays, strings and scalars; an own member shadows", async () => {
  const { stdout, stderr, exitCode } = await runRow("T191A", "const o = JSON.parse('{\"a\":1,\"u\":null}');\nconsole.log(o.hasOwnProperty(\"a\"), o.hasOwnProperty(\"b\"), o.hasOwnProperty(\"u\"));\nconsole.log(o.propertyIsEnumerable(\"a\"), o.propertyIsEnumerable(\"z\"));\nconsole.log(JSON.stringify(o.valueOf()), o.isPrototypeOf(o), o.toLocaleString());\nconst a = JSON.parse('[1,2,3]');\nconsole.log(a.hasOwnProperty(0), a.hasOwnProperty(\"3\"), a.hasOwnProperty(\"length\"), a.propertyIsEnumerable(\"length\"), a.propertyIsEnumerable(1));\nconst s = JSON.parse('\"abc\"');\nconsole.log(s.hasOwnProperty(1), s.hasOwnProperty(\"length\"), s.propertyIsEnumerable(\"length\"), s.propertyIsEnumerable(0), s.valueOf());\nconst n = JSON.parse('5');\nconsole.log(n.hasOwnProperty(\"x\"), n.valueOf(), JSON.parse('true').valueOf());\nconst sh = JSON.parse('{\"hasOwnProperty\":3}');\ntry { sh.hasOwnProperty(\"a\"); } catch (e) { console.log(\"caught\", e.message); }", "cjs");
  expect(stdout).toBe("true false true\ntrue false\n{\"a\":1,\"u\":null} false [object Object]\ntrue false true false true\ntrue true false true abc\nfalse 5 true\ncaught sh.hasOwnProperty is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// ASSIGN
// ============================================================

test("T205A ASSIGN: Object.assign onto a dyn target returns the target itself", async () => {
  const { stdout, stderr, exitCode } = await runRow("T205A", "const t = JSON.parse('{\"a\":1}');\nconst r = Object.assign(t, { z: 2 }, { y: 3 });\nr.q = 9;\nconsole.log(JSON.stringify(t), JSON.stringify(r), r.a, r.z);\nfunction f() { const u = Object.assign(JSON.parse('{}'), { k: 1 }); u.k = 2; return u; }\nconsole.log(JSON.stringify(f()));", "cjs");
  expect(stdout).toBe("{\"a\":1,\"z\":2,\"y\":3,\"q\":9} {\"a\":1,\"z\":2,\"y\":3,\"q\":9} 1 2\n{\"k\":2}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T203A ASSIGN: Object.assign with a spread tuple source: the result is a plain copy, not the source's class", async () => {
  const { stdout, stderr, exitCode } = await runRow("T203A", "const r = Object.assign({}, ...[new Uint8Array([4, 5])]);\nconsole.log(JSON.stringify(r));\nconst r2 = Object.assign({}, ...[{ x: 1 }, { y: 2 }]);\nconsole.log(JSON.stringify(r2));", "cjs");
  expect(stdout).toBe("{\"0\":4,\"1\":5}\n{\"x\":1,\"y\":2}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T203B ASSIGN: the TypeScript twin; a record-literal spread keeps its record type", async () => {
  const { stdout, stderr, exitCode } = await runRow("T203B", "const r = Object.assign({}, ...[new Uint8Array([4, 5])]);\nconsole.log(JSON.stringify(r));\nconst r4 = Object.assign({}, ...[{ x: 3 }]);\nconsole.log(r4.x + 1);", "ts");
  expect(stdout).toBe("{\"0\":4,\"1\":5}\n4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// FORMATO
// ============================================================

test("T192A FORMATO: util.format %o over dyn values: the hidden [length] entry, nesting and the empty forms", async () => {
  const { stdout, stderr, exitCode } = await runRow("T192A", "const util = require(\"util\");\nconst J = (s) => JSON.parse(s);\nconsole.log(util.format(\"%o\", J(\"[]\")));\nconsole.log(util.format(\"%o\", J(\"{\\\"a\\\":[],\\\"b\\\":{}}\")));\nconsole.log(util.format(\"%o\", J(\"[1,2,3,4,5,6,7,8,9,10]\")));\nconsole.log(util.format(\"%o\", J(\"[0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57,60,63,66,69,72,75]\")));\nconsole.log(util.format(\"%o\", J(\"[\\\"s0\\\",\\\"s1\\\",\\\"s2\\\",\\\"s3\\\",\\\"s4\\\",\\\"s5\\\",\\\"s6\\\",\\\"s7\\\",\\\"s8\\\",\\\"s9\\\",\\\"s10\\\",\\\"s11\\\",\\\"s12\\\",\\\"s13\\\",\\\"s14\\\",\\\"s15\\\",\\\"s16\\\",\\\"s17\\\",\\\"s18\\\",\\\"s19\\\",\\\"s20\\\",\\\"s21\\\",\\\"s22\\\",\\\"s23\\\",\\\"s24\\\",\\\"s25\\\"]\")));\nconsole.log(util.format(\"%o\", J(\"[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98]\")));\nconsole.log(util.format(\"%o\", J(\"[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99]\")));\nconsole.log(util.format(\"%o\", J(\"[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100]\")));\nconsole.log(util.format(\"%o\", J(\"[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101]\")));\nconsole.log(util.format(\"%o\", J(\"[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,\\\"x\\\"]\")));\nconsole.log(util.format(\"%o\", J(\"[\\\"y\\\",1,\\\"y\\\",3,\\\"y\\\",5,\\\"y\\\",7,\\\"y\\\",9,\\\"y\\\",11,\\\"y\\\",13,\\\"y\\\",15,\\\"y\\\",17,\\\"y\\\",19,\\\"y\\\",21,\\\"y\\\",23,\\\"y\\\",25,\\\"y\\\",27,\\\"y\\\",29,\\\"y\\\",31,\\\"y\\\",33,\\\"y\\\",35,\\\"y\\\",37,\\\"y\\\",39,\\\"y\\\",41,\\\"y\\\",43,\\\"y\\\",45,\\\"y\\\",47,\\\"y\\\",49,\\\"y\\\",51,\\\"y\\\",53,\\\"y\\\",55,\\\"y\\\",57,\\\"y\\\",59,\\\"y\\\",61,\\\"y\\\",63,\\\"y\\\",65,\\\"y\\\",67,\\\"y\\\",69,\\\"y\\\",71,\\\"y\\\",73,\\\"y\\\",75,\\\"y\\\",77,\\\"y\\\",79,\\\"y\\\",81,\\\"y\\\",83,\\\"y\\\",85,\\\"y\\\",87,\\\"y\\\",89,\\\"y\\\",91,\\\"y\\\",93,\\\"y\\\",95,\\\"y\\\",97,\\\"y\\\",99,\\\"y\\\",101,\\\"y\\\",103,\\\"y\\\",105,\\\"y\\\",107,\\\"y\\\",109,\\\"y\\\",111,\\\"y\\\",113,\\\"y\\\",115,\\\"y\\\",117,\\\"y\\\",119,\\\"y\\\",121,\\\"y\\\",123,\\\"y\\\",125,\\\"y\\\",127,\\\"y\\\",129,\\\"y\\\",131,\\\"y\\\",133,\\\"y\\\",135,\\\"y\\\",137,\\\"y\\\",139,\\\"y\\\",141,\\\"y\\\",143,\\\"y\\\",145,\\\"y\\\",147,\\\"y\\\",149]\")));\nconsole.log(util.format(\"%o\", J(\"[[[[[[1]]]]]]\")));\nconsole.log(util.format(\"%o\", J(\"{\\\"x\\\":{\\\"y\\\":{\\\"z\\\":{\\\"w\\\":{\\\"v\\\":[1]}}}}}\")));\nconsole.log(util.format(\"%o\", J(\"{\\\"x\\\":{\\\"y\\\":{\\\"z\\\":{\\\"w\\\":[]}}}}\")));\nconsole.log(util.format(\"%o\", J(\"[[],[[]],{\\\"e\\\":[]}]\")));\nconsole.log(util.format(\"%o %o\", J(\"[1]\"), J(\"\\\"s\\\"\")));", "cjs");
  expect(stdout).toBe("[ [length]: 0 ]\n{ a: [ [length]: 0 ], b: {} }\n[ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, [length]: 10 ]\n[\n  0,  3,  6,\n  9,  12, 15,\n  18, 21, 24,\n  27, 30, 33,\n  36, 39, 42,\n  45, 48, 51,\n  54, 57, 60,\n  63, 66, 69,\n  72, 75, [length]: 26\n]\n[\n  's0',  's1',  's2',\n  's3',  's4',  's5',\n  's6',  's7',  's8',\n  's9',  's10', 's11',\n  's12', 's13', 's14',\n  's15', 's16', 's17',\n  's18', 's19', 's20',\n  's21', 's22', 's23',\n  's24', 's25', [length]: 26\n]\n[\n  0,  1,  2,  3,  4,\n  5,  6,  7,  8,  9,\n  10, 11, 12, 13, 14,\n  15, 16, 17, 18, 19,\n  20, 21, 22, 23, 24,\n  25, 26, 27, 28, 29,\n  30, 31, 32, 33, 34,\n  35, 36, 37, 38, 39,\n  40, 41, 42, 43, 44,\n  45, 46, 47, 48, 49,\n  50, 51, 52, 53, 54,\n  55, 56, 57, 58, 59,\n  60, 61, 62, 63, 64,\n  65, 66, 67, 68, 69,\n  70, 71, 72, 73, 74,\n  75, 76, 77, 78, 79,\n  80, 81, 82, 83, 84,\n  85, 86, 87, 88, 89,\n  90, 91, 92, 93, 94,\n  95, 96, 97, 98, [length]: 99\n]\n[\n  0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11,\n  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,\n  24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,\n  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,\n  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,\n  60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71,\n  72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,\n  84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,\n  96, 97, 98, 99,\n  [length]: 100\n]\n[\n  0,               1,  2,  3,\n  4,               5,  6,  7,\n  8,               9,  10, 11,\n  12,              13, 14, 15,\n  16,              17, 18, 19,\n  20,              21, 22, 23,\n  24,              25, 26, 27,\n  28,              29, 30, 31,\n  32,              33, 34, 35,\n  36,              37, 38, 39,\n  40,              41, 42, 43,\n  44,              45, 46, 47,\n  48,              49, 50, 51,\n  52,              53, 54, 55,\n  56,              57, 58, 59,\n  60,              61, 62, 63,\n  64,              65, 66, 67,\n  68,              69, 70, 71,\n  72,              73, 74, 75,\n  76,              77, 78, 79,\n  80,              81, 82, 83,\n  84,              85, 86, 87,\n  88,              89, 90, 91,\n  92,              93, 94, 95,\n  96,              97, 98, 99,\n  ... 1 more item,\n  [length]: 101\n]\n[\n                 0,  1,  2,  3,\n                 4,  5,  6,  7,\n                 8,  9, 10, 11,\n                12, 13, 14, 15,\n                16, 17, 18, 19,\n                20, 21, 22, 23,\n                24, 25, 26, 27,\n                28, 29, 30, 31,\n                32, 33, 34, 35,\n                36, 37, 38, 39,\n                40, 41, 42, 43,\n                44, 45, 46, 47,\n                48, 49, 50, 51,\n                52, 53, 54, 55,\n                56, 57, 58, 59,\n                60, 61, 62, 63,\n                64, 65, 66, 67,\n                68, 69, 70, 71,\n                72, 73, 74, 75,\n                76, 77, 78, 79,\n                80, 81, 82, 83,\n                84, 85, 86, 87,\n                88, 89, 90, 91,\n                92, 93, 94, 95,\n                96, 97, 98, 99,\n  ... 2 more items,\n  [length]: 102\n]\n[\n  0,                1,  2,  3,\n  4,                5,  6,  7,\n  8,                9,  10, 11,\n  12,               13, 14, 15,\n  16,               17, 18, 19,\n  20,               21, 22, 23,\n  24,               25, 26, 27,\n  28,               29, 30, 31,\n  32,               33, 34, 35,\n  36,               37, 38, 39,\n  40,               41, 42, 43,\n  44,               45, 46, 47,\n  48,               49, 50, 51,\n  52,               53, 54, 55,\n  56,               57, 58, 59,\n  60,               61, 62, 63,\n  64,               65, 66, 67,\n  68,               69, 70, 71,\n  72,               73, 74, 75,\n  76,               77, 78, 79,\n  80,               81, 82, 83,\n  84,               85, 86, 87,\n  88,               89, 90, 91,\n  92,               93, 94, 95,\n  96,               97, 98, 99,\n  ... 2 more items,\n  [length]: 102\n]\n[\n  'y',               1,  'y', 3,\n  'y',               5,  'y', 7,\n  'y',               9,  'y', 11,\n  'y',               13, 'y', 15,\n  'y',               17, 'y', 19,\n  'y',               21, 'y', 23,\n  'y',               25, 'y', 27,\n  'y',               29, 'y', 31,\n  'y',               33, 'y', 35,\n  'y',               37, 'y', 39,\n  'y',               41, 'y', 43,\n  'y',               45, 'y', 47,\n  'y',               49, 'y', 51,\n  'y',               53, 'y', 55,\n  'y',               57, 'y', 59,\n  'y',               61, 'y', 63,\n  'y',               65, 'y', 67,\n  'y',               69, 'y', 71,\n  'y',               73, 'y', 75,\n  'y',               77, 'y', 79,\n  'y',               81, 'y', 83,\n  'y',               85, 'y', 87,\n  'y',               89, 'y', 91,\n  'y',               93, 'y', 95,\n  'y',               97, 'y', 99,\n  ... 50 more items,\n  [length]: 150\n]\n[\n  [\n    [ [ [ [Array], [length]: 1 ], [length]: 1 ], [length]: 1 ],\n    [length]: 1\n  ],\n  [length]: 1\n]\n{\n  x: {\n    y: { z: { w: { v: [Array] } } }\n  }\n}\n{\n  x: {\n    y: { z: { w: [ [length]: 0 ] } }\n  }\n}\n[\n  [ [length]: 0 ],\n  [ [ [length]: 0 ], [length]: 1 ],\n  { e: [ [length]: 0 ] },\n  [length]: 3\n]\n[ 1, [length]: 1 ] 's'\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T192B FORMATO: %o over untyped Map / WeakMap / WeakSet stand-ins", async () => {
  const { stdout, stderr, exitCode } = await runRow("T192B", "const util = require(\"util\");\nconst m = new Map(); m.x = 1;\nconst wm = new WeakMap(); wm.x = 1;\nconst ws = new WeakSet();\nconsole.log(util.format('%o', m));\nconsole.log(util.format('%o', wm));\nconsole.log(util.format('%o', ws));\nconsole.log(util.format('%o', JSON.parse('{\"w\":[1,{\"q\":[]}]}')));", "cjs");
  expect(stdout).toBe("Map(0) { x: 1 }\nWeakMap { x: 1 }\nWeakSet {  }\n{\n  w: [ 1, { q: [ [length]: 0 ] }, [length]: 2 ]\n}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// UNITFOLD
// ============================================================

test("T204A UNITFOLD: a checker-decided comparison with undefined/null still runs its operand", async () => {
  const { stdout, stderr, exitCode } = await runRow("T204A", "let n = 0;\nfunction f() { n++; return \"a\"; }\nconsole.log(f() === undefined, n);\nconsole.log(String(JSON.parse(\"[1]\")) === undefined);\ntry { throw JSON.parse(\"[1]\"); } catch (e) { console.log('S', String(e) === undefined); }\nconst o = { k: 1 };\nfunction g() { n += 10; return o; }\nconsole.log(g() == null, g() != null, n);", "cjs");
  expect(stdout).toBe("false 1\nfalse\nS false\nfalse true 21\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// ARGSLEN
// ============================================================

test("T164A ARGSLEN: a fixed-arity TypeScript method folds arguments.length to its declared count", async () => {
  const { stdout, stderr, exitCode } = await runRow("T164A", "class A { m(a: number, b: number) { return arguments.length + a + b; } }\nconsole.log(new A().m(1, 2));", "ts");
  expect(stdout).toBe("5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T164B ARGSLEN: a JavaScript method's arguments.length refuses by name (a caller may pass any count)", async () => {
  // Node v24 prints "before\n2\n" and then throws; this tier refuses by name.
  const { stdout, stderr } = await runRowTrap("T164B", "class A { m() { return arguments.length; } }\nconsole.log(\"before\");\nconsole.log(new A().m(1, 2));", "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toContain("the reference to 'arguments'");
});

// ============================================================
// PRESENCE
// ============================================================

test("T178A PRESENCE: a required void or undefined-able field is an own key whatever it holds", async () => {
  const { stdout, stderr, exitCode } = await runRow("T178A", "function v(): void {}\nconst r: { a: number; w: void } = { a: 1, w: v() };\nconsole.log(Object.keys(r).length, \"w\" in r, r);\nconst e: { a: number; w: number | undefined } = { a: 1, w: undefined };\nconsole.log(Object.keys(e).join(\",\"), \"w\" in e, Object.hasOwn(e, \"w\"), e, Object.values(e), Object.entries(e));\nfor (const k in e) console.log(\"k\", k);\nconst f = (x: { a: number; w: number | undefined }) => Object.keys(x).length;\nconsole.log(f({ a: 2, w: 3 }), f({ a: 2, w: undefined }));", "ts");
  expect(stdout).toBe("2 true { a: 1, w: undefined }\na,w true true { a: 1, w: undefined } [ 1, undefined ] [ [ 'a', 1 ], [ 'w', undefined ] ]\nk a\nk w\n2 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T178B PRESENCE: an optional field left out is no own key; written, it is", async () => {
  const { stdout, stderr, exitCode } = await runRow("T178B", "const o: { a: number; w?: number } = { a: 1 };\nconsole.log(Object.keys(o).join(\",\"), \"w\" in o, Object.values(o));\no.w = 5;\nconsole.log(Object.keys(o).join(\",\"), \"w\" in o, o);\nconst z: { w?: string } = {};\nconsole.log(Object.keys(z).length);", "ts");
  expect(stdout).toBe("a false [ 1 ]\na,w true { a: 1, w: 5 }\n0\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T091D PRESENCE: S091 (d): a left-out optional field, and one a checked conversion found missing, print as holding undefined", async () => {
  // Node v24 prints "{ a: 1 }\n{ b: 1 }\n" — the registered divergence (SEMANTICS.md S091).
  const { stdout, stderr, exitCode } = await runRow("T091D", "const o: { a: number; w?: number } = { a: 1 };\nconsole.log(o);\ntype A = { a: number | undefined; b: number };\nconst x: A = JSON.parse('{\"b\":1}') as A;\nconsole.log(x);", "ts");
  expect(stdout).toBe("{ a: 1, w: undefined }\n{ a: undefined, b: 1 }\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T230A PRESENCE: a widened literal's phantom optional members: inspect, and the crossing into dyn", async () => {
  const { stdout, stderr, exitCode } = await runRow("T230A", "const srcs = [{ a: 1 }, { b: 2 }];\nconsole.log(srcs);\nconsole.log(JSON.stringify(Object.assign({}, ...srcs)));", "ts");
  expect(stdout).toBe("[ { a: 1 }, { b: 2 } ]\n{\"a\":1,\"b\":2}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T091A PRESENCE: S091 (a): an optional field explicitly set to undefined", async () => {
  // Node v24 prints "{ a: 1, w: undefined } [ 'a', 'w' ] true\n" — the registered divergence (SEMANTICS.md S091).
  const { stdout, stderr, exitCode } = await runRow("T091A", "const p: { a: number; w?: number } = { a: 1, w: undefined };\nconsole.log(p, Object.keys(p), \"w\" in p);", "ts");
  expect(stdout).toBe("{ a: 1, w: undefined } [ 'a' ] false\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T091B PRESENCE: S091 (b): a required field shares its shape with an identical optional one", async () => {
  // Node v24 prints "a,w a\n" — the registered divergence (SEMANTICS.md S091).
  const { stdout, stderr, exitCode } = await runRow("T091B", "const e: { a: number; w: number | undefined } = { a: 1, w: undefined };\nconst o: { a: number; w?: number } = { a: 2 };\nconsole.log(Object.keys(e).join(\",\"), Object.keys(o).join(\",\"));", "ts");
  expect(stdout).toBe("a a\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T178C PRESENCE: a record checked out of a dyn value that lacked a required undefined-able key", async () => {
  const { stdout, stderr, exitCode } = await runRow("T178C", "type A = { a: number | undefined; b: number };\nconst x: A = JSON.parse('{\"b\":1}') as A;\nconsole.log(Object.keys(x), \"a\" in x, Object.hasOwn(x, \"a\"));\nconst y: A = JSON.parse('{\"a\":3,\"b\":1}') as A;\nconsole.log(Object.keys(y), y);", "ts");
  expect(stdout).toBe("[ 'b' ] false false\n[ 'a', 'b' ] { a: 3, b: 1 }\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T091C PRESENCE: S091 (c): an explicit undefined in a required field of a shape a checked conversion builds", async () => {
  // Node v24 prints "b a,b\n" — the registered divergence (SEMANTICS.md S091).
  const { stdout, stderr, exitCode } = await runRow("T091C", "type A = { a: number | undefined; b: number };\nconst x: A = JSON.parse('{\"b\":1}') as A;\nconst y: A = { a: undefined, b: 2 };\nconsole.log(Object.keys(x).join(\",\"), Object.keys(y).join(\",\"));", "ts");
  expect(stdout).toBe("b b\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T178D PRESENCE: index-signature records: a required undefined-able declared field is an own key", async () => {
  const { stdout, stderr, exitCode } = await runRow("T178D", "const ix: { a: number | undefined; [k: string]: number | undefined } = { a: undefined };\nconsole.log(Object.keys(ix), Object.values(ix), Object.entries(ix));\nfor (const k in ix) console.log(\"k\", k);", "ts");
  expect(stdout).toBe("[ 'a' ] [ undefined ] [ [ 'a', undefined ] ]\nk a\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T178E PRESENCE: index-signature records: an optional declared field is an own key only while set", async () => {
  const { stdout, stderr, exitCode } = await runRow("T178E", "const iy: { a?: number; [k: string]: number | undefined } = {};\nconsole.log(Object.keys(iy), Object.values(iy));\niy.a = 4;\nconsole.log(Object.keys(iy), Object.entries(iy));", "ts");
  expect(stdout).toBe("[] []\n[ 'a' ] [ [ 'a', 4 ] ]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// OBJPROTO
// ============================================================

test("T191B OBJPROTO: propertyIsEnumerable on a dyn function: own data keys yes, name/length no", async () => {
  const { stdout, stderr, exitCode } = await runRow("T191B", "const arr = JSON.parse('[]');\narr.push(function foo() {});\nconst f = arr[0];\nf.x = 1;\nconsole.log(`${f.propertyIsEnumerable('x')}`, `${f.propertyIsEnumerable('name')}`, `${f.propertyIsEnumerable('length')}`, `${f.hasOwnProperty('name')}`);", "cjs");
  expect(stdout).toBe("true false false true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// UNITFOLD
// ============================================================

test("T204B UNITFOLD: a decided compare over a generator or Map operand still runs it", async () => {
  const { stdout, stderr, exitCode } = await runRow("T204B", "let n = 0;\nfunction* gen(): Generator<number> { yield 1; }\nfunction g1(): Generator<number> { n++; return gen(); }\nfunction m1(): Map<string, number> { n += 10; return new Map(); }\nconsole.log(g1() != null, m1() === undefined, n);", "ts");
  expect(stdout).toBe("true false 11\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
