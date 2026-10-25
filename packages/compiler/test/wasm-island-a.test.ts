/* Unit A — the island JS surface on the WasmGC tier: operations on
 * checked-dynamic / untyped JS values that used to refuse by name.
 *
 * A1 (emitter.ts): the island-rest ABI (`restAbi: "jsval"` — the
 * `(...args) =>` binding is a real array; the closure's last declared
 * parameter IS that array, packed per call by the dyn thunk when the
 * closure crossed in as a value), `callSpread` (the forwarding idiom
 * `(...args) => f(...args)`, with V8's spread-call TypeError texts) and
 * `objSpread` (an island literal's `{ ...src }`, the spec's
 * CopyDataProperties through `dyn.assign`).
 *
 * Every expected line below is an INLINED literal: a run row's stdout is
 * a real Node v24.18.1 run of the SAME source, byte for byte (Node's
 * stderr empty, exit 0). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-island-a-"));
  await mkdir(join(scratch, "esm"));
  await mkdir(join(scratch, "cjs"));
  await writeFile(join(scratch, "esm", "package.json"), '{"type":"module"}\n');
  await writeFile(join(scratch, "cjs", "package.json"), '{"type":"commonjs"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A `// @dynamic` head builds with --dynamic (the differential harness's
 * own rule). */
function isDynamic(src: string): boolean {
  return /^\/\/ @dynamic\s*$/m.test(src.split("\n", 2).join("\n"));
}

async function build(id: string, src: string, ext: string): Promise<string> {
  const dir = join(scratch, ext === "cjs" ? "cjs" : "esm");
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  return res.binaryPath;
}

async function runRow(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const run = await runWasm(await build(id, src, ext));
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

/** A row expecting an uncaught trap: what was printed before it. */
async function runRowTrap(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string }> {
  const run = await runWasmToTrap(await build(id, src, ext));
  return { stdout: String(run.stdout), stderr: String(run.stderr) };
}

/** A corpus program, built the way the differential harness builds it. */
async function runCorpusRow(id: string, relPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = fileURLToPath(new URL(`../../../tests/corpus/${relPath}`, import.meta.url));
  const dynamic = isDynamic(await readFile(entry, "utf8"));
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

// ============================================================
// A1 — the rest ABI, callSpread, objSpread
// ============================================================

test("A1-REST-01 rest ABI: direct calls fill the leading slot and pack the surplus", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-REST-01", "// @dynamic\n\"use strict\";\n// rest ABI: direct calls fill the leading slot and pack the surplus\nconst f = (a, ...r) => `${a}|${r.length}|${r[0]}|${r[r.length - 1]}`;\nconsole.log(f());\nconsole.log(f(1));\nconsole.log(f(1, 2));\nconsole.log(f(1, 2, 3, 4));\nconst g = (...all) => all;\nconst one = g(1);\nconsole.log(`${g().length} ${g(5, 6).length} ${Array.isArray(one)}`);", "js");
  expect(stdout).toBe("undefined|0|undefined|undefined\n1|0|undefined|undefined\n1|1|2|2\n1|3|2|4\n0 2 true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-REST-02 a rest closure crossing into the island as a value: the box's thunk", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-REST-02", "// @dynamic\n\"use strict\";\n// a rest closure crossing into the island as a value: the box's thunk\n// packs every argument past the leading list into a FRESH array\n/** @returns {*} */\nfunction make() {\n  return (x, y, ...rest) => `${x}/${y}/${rest.length}:${rest.join(\",\")}`;\n}\nconst w = make();\nconsole.log(`${w()}`);\nconsole.log(`${w(1)}`);\nconsole.log(`${w(1, 2)}`);\nconsole.log(`${w(1, 2, 3, 4, 5)}`);\nconsole.log(`${w.length} ${typeof w}`);\n/** @returns {*} */\nfunction only() {\n  return (...args) => args.length;\n}\nconst o = only();\nconsole.log(`${o()} ${o(1, 2, 3)} ${o.length}`);\nconst src = [7, 8, 9];\nconsole.log(`${o.apply(undefined, src)} ${o.call(undefined, 1, 2)}`);", "js");
  expect(stdout).toBe("undefined/undefined/0:\n1/undefined/0:\n1/2/0:\n1/2/3:3,4,5\n2 function\n0 3 0\n3 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-SPREAD-01 callSpread over every iterable kind and with leading arguments", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-SPREAD-01", "// @dynamic\n\"use strict\";\n// callSpread over every iterable kind and with leading arguments\nconst show = (...a) => a.map((x) => `${typeof x}:${x}`).join(\" \");\nconst fwd = (...a) => show(...a);\nconst lead = (p, q, ...r) => show(p, q, ...r);\nconsole.log(fwd());\nconsole.log(fwd(1, \"two\", true));\nconsole.log(lead(1));\nconsole.log(lead(1, 2, 3, 4));\n/** @returns {*} */\nfunction str() {\n  return \"ab\\u{1F600}c\";\n}\n/** @returns {*} */\nfunction holey() {\n  return [1, undefined, 3];\n}\nconst fs1 = (...s) => show(...s);\nconst s = str();\nconsole.log(`${fs1(...s)}`);\nconsole.log(`[${fs1(...[])}]`);\nconst h = holey();\nconst fa = (...a) => show(0, ...a);\nconsole.log(`${fa(...h)}`);\nconsole.log(`${fa(...[])}`);", "js");
  expect(stdout).toBe("\nnumber:1 string:two boolean:true\nnumber:1 undefined:undefined\nnumber:1 number:2 number:3 number:4\nstring:a string:b string:😀 string:c\n[]\nnumber:0 number:1 undefined:undefined number:3\nnumber:0\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-SPREAD-02 V8's spread-call TypeError texts, catchably, for every non-iterable kind", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-SPREAD-02", "// @dynamic\n\"use strict\";\n// V8's spread-call TypeError texts, catchably, for every non-iterable kind\n/** @param {*} v */\nfunction probe(v) {\n  const id = (...a) => a.length;\n  try {\n    console.log(`ok ${id(...v)}`);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\nprobe(42);\nprobe(true);\nprobe(null);\nprobe(undefined);\nprobe({ a: 1 });\nprobe(() => 1);\nprobe([1, 2]);\nprobe(\"xy\");", "js");
  expect(stdout).toBe("TypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function\nTypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function\nTypeError: v is not iterable (cannot read property null)\nTypeError: v is not iterable (cannot read property undefined)\nTypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function\nTypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function\nok 2\nok 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-OSPREAD-01 object spread (CopyDataProperties) over every source kind", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-OSPREAD-01", "// @dynamic\n\"use strict\";\n// object spread (CopyDataProperties) over every source kind\n/** @param {*} s */\nfunction spread(s) {\n  /** @type {*} */\n  const o = { ...s, last: 9 };\n  return JSON.stringify(o);\n}\nconsole.log(spread({ a: 1, b: 2 }));\nconsole.log(spread(null));\nconsole.log(spread(undefined));\nconsole.log(spread(42));\nconsole.log(spread(true));\nconsole.log(spread(\"hi\"));\nconsole.log(spread([5, 6]));\nconsole.log(spread(() => 1));\nconsole.log(spread({ first: \"over\", last: \"under\" }));\n/** @type {*} */\nconst two = { ...{ p: 1 }, ...{ q: 2, p: 3 } };\nconsole.log(JSON.stringify(two));\n/** @type {*} */\nconst base = { x: 1, y: { z: 2 } };\n/** @type {*} */\nconst copy = { ...base };\ncopy.x = 100;\ncopy.y.z = 200;\nconsole.log(`${base.x} ${base.y.z} ${copy.x} ${JSON.stringify(copy)}`);\n/** @returns {*} */\nfunction mk() {\n  return { b: 3, c: 4 };\n}\nconst more = mk();\n/** @type {*} */\nconst later = { ...more, a: 2, b: 1 };\nconsole.log(JSON.stringify(later));", "js");
  expect(stdout).toBe("{\"a\":1,\"b\":2,\"last\":9}\n{\"last\":9}\n{\"last\":9}\n{\"last\":9}\n{\"last\":9}\n{\"0\":\"h\",\"1\":\"i\",\"last\":9}\n{\"0\":5,\"1\":6,\"last\":9}\n{\"last\":9}\n{\"first\":\"over\",\"last\":9}\n{\"p\":3,\"q\":2}\n1 200 100 {\"x\":100,\"y\":{\"z\":200}}\n{\"b\":1,\"c\":4,\"a\":2}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-OSPREAD-02 a function source spreads its own ENUMERABLE members (defineProperties)", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-OSPREAD-02", "// @dynamic\n\"use strict\";\n// a function source spreads its own ENUMERABLE members (defineProperties)\n/** @returns {*} */\nfunction mk() {\n  return () => 1;\n}\nconst fn = () => 1;\nObject.defineProperties(fn, { shown: { value: 1, enumerable: true }, hidden: { value: 2 } });\n/** @type {*} */\nconst o = { ...fn, tail: true };\nconsole.log(JSON.stringify(o));\n/** @type {*} */\nconst plain = { ...mk() };\nconsole.log(JSON.stringify(plain));", "js");
  expect(stdout).toBe("{\"shown\":1,\"tail\":true}\n{}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-OSPREAD-03 spreading a caught error into an island literal refuses by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-OSPREAD-03", "// @dynamic\n\"use strict\";\n// a caught error spread into an island literal\ntry {\n  throw new TypeError(\"boom\");\n} catch (e) {\n  /** @type {*} */\n  const any = e;\n  try {\n    /** @type {*} */\n    const o = { ...any, extra: 1 };\n    console.log(JSON.stringify(o));\n  } catch (e2) {\n    console.log(`${e2.name}: ${e2.message}`);\n  }\n}", "js");
  // Node prints {"extra":1}: an Error's members are non-enumerable. The
  // dyn error encoding's would copy, marker included (S021/S025), so the
  // spread refuses by name (SEMANTICS.md S043's unit-A1 amendment).
  expect(stdout).toBe("Error: spreading an error value (an object carrying the reserved %error member) into an island object literal is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-SPREAD-03 the nullish spread text names the source as V8 renders it", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-SPREAD-03", "// @dynamic\n\"use strict\";\n// the nullish spread text names the source as V8 renders it\n/** @returns {*} */\nfunction nul() {\n  return null;\n}\n/** @type {*} */\nconst o = { x: null, f: nul };\nconst id = (...a) => a.length;\nconst tries = [\n  () => id(...o[\"x\"]),\n  () => id(...(o.x)),\n  () => id(...o.f()),\n  () => id(...nul(1, 2)),\n  () => id(...o.x),\n  () => id(...o[0]),\n];\nfor (const t of tries) {\n  try {\n    t();\n  } catch (e) {\n    console.log(`${e.message}`);\n  }\n}", "js");
  expect(stdout).toBe("o.x is not iterable (cannot read property null)\no.x is not iterable (cannot read property null)\no.f(...) is not iterable (cannot read property null)\nnul(...) is not iterable (cannot read property null)\no.x is not iterable (cannot read property null)\no[0] is not iterable (cannot read property undefined)\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-SPREAD-04 a spread call on an any-typed callee is a real spread, not apply", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-SPREAD-04", "// @dynamic\n\"use strict\";\n// a spread call on an any-typed callee is a real spread, not apply\n/** @returns {*} */\nfunction nul() {\n  return null;\n}\n/** @returns {*} */\nfunction str() {\n  return \"ab\";\n}\n/** @returns {*} */\nfunction num() {\n  return 5;\n}\n/** @returns {*} */\nfunction arr() {\n  return [3, 4];\n}\n/** @returns {*} */\nfunction notFn() {\n  return 7;\n}\n/** @param {*} g */\nfunction cs(g) {\n  try {\n    console.log(`a ${g(...nul())}`);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n  try {\n    console.log(`b ${g(...str())}`);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n  try {\n    console.log(`c ${g(...num())}`);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n  try {\n    console.log(`d ${g(0, ...arr())}`);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\ncs((a, b, c) => `${a},${b},${c}`);\nconst h = notFn();\ntry {\n  h(...arr());\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}", "js");
  expect(stdout).toBe("TypeError: nul(...) is not iterable (cannot read property null)\nb a,b,undefined\nTypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function\nd 0,3,4\nTypeError: h is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-SPREAD-05 a nullish spread source with no known V8 rendering refuses by name, on both call paths", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-SPREAD-05", "// @dynamic\n\"use strict\";\n/** @type {*} */\nconst o = { x: null };\nconst id = (...a) => a.length;\ntry {\n  id(...o?.x);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\ntry {\n  id(...o[99999999999999999999]);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\ntry {\n  id(...o[7]);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\n/** @param {*} g */\nfunction cs(g) {\n  try {\n    g(...o?.x);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\ncs((...a) => a.length);\nconsole.log(`${id(...(o?.y ?? [1, 2]))}`);", "js");
  // Node: "TypeError: (intermediate value) is not iterable (cannot read
  // property null)", "TypeError: o[100000000000000000000] is not iterable
  // (cannot read property undefined)" (V8 prints the index's VALUE), the
  // o[7] line as here, "(intermediate value)" again, then 2. The static
  // callee's three ride the checked-dynamic call path (an `any` source),
  // the any-callee one the island callSpread.
  expect(stdout).toBe(
    "Error: spreading null or undefined from this expression into a call is not supported yet\n" +
      "Error: spreading null or undefined from this expression into a call is not supported yet\n" +
      "TypeError: o[7] is not iterable (cannot read property undefined)\n" +
      "Error: spreading null or undefined from this expression into an island call is not supported yet\n" +
      "2\n",
  );
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-DEFPROPS-01 an accessor descriptor Object.defineProperties cannot hold raises its fence at the call", async () => {
  const { stdout, stderr } = await runRowTrap("A1-DEFPROPS-01", "// @dynamic\n\"use strict\";\nconst fn = () => 1;\nconsole.log(\"before\");\nObject.defineProperties(fn, { z: { value: 0, enumerable: true }, y: { get() { return 2; }, enumerable: true } });\nconsole.log(`${fn.z} ${fn.y}`);", "js");
  // Node: before, then "0 2". The descriptor arrives as the front end's
  // deferred fence, which used to define `undefined` silently.
  expect(stdout).toBe("before\n");
  expect(stderr).toContain("values in a runtime-keyed (computed-key) object literal is not supported yet [SC1101");
});

test("A1-CORPUS-2568 the rest-forwarding corpus program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("A1-CORPUS-2568", "2568-rest-spread-forward-dynamic.js");
  expect(stdout).toBe("12\n7\n11\n78\n19\ncaught: Spread syntax requires ...iterable[Symbol.iterator] to be a function\ncaught: v is not iterable (cannot read property null)\ncaught: v is not iterable (cannot read property undefined)\ndone\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A1-CORPUS-2475 the variadic-wrapper corpus program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("A1-CORPUS-2475", "2475-variadic-wrapper-island.js");
  expect(stdout).toBe('hi:{"a":1,"extra":true}\nsolo:{"extra":true}\ndone\n');
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
