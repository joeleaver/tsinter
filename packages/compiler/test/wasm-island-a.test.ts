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
 * A2 (dyn.ts's unit-A2 section): island GETTERS (an accessor cell in the
 * OBJ entry table, read through the getter, `[Getter]` to inspect, named
 * refusals where a reader cannot run it), `Object.create` on the island
 * (null prototypes and LINKED objects with live delegation), and an
 * island tag call's strings array with its `raw` member, interned per
 * site. The REF rows pin this tier's named refusals with Node's answer
 * stated beside each (SEMANTICS.md S043's unit-A2 amendment).
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

/** A row expected to refuse at compile time: its diagnostics. */
async function refuseRow(id: string, src: string, ext: string): Promise<string[]> {
  const dir = join(scratch, ext === "cjs" ? "cjs" : "esm");
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  if (res.ok) throw new Error(`${id} compiled but was expected to refuse`);
  return res.diagnostics.map((d) => `${d.code}:${d.message}`);
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

// ============================================================
// A2 — island getters, Object.create, tag strings
// ============================================================

test("A2-GET-01 island getters: every read runs the getter; JSON and spread read it too", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-GET-01", "// @dynamic\n\"use strict\";\n// island getters: every read runs the getter; JSON and spread read it too\nlet calls = 0;\n/** @type {*} */\nconst box = {\n  value: 10,\n  get double() {\n    calls++;\n    return box.value * 2;\n  },\n};\nconsole.log(`${box.double} ${box.double} calls=${calls}`);\nbox.value = 21;\nconsole.log(`${box[\"double\"]} calls=${calls}`);\nconsole.log(JSON.stringify(box), `calls=${calls}`);\n/** @type {*} */\nconst copy = { ...box };\nbox.value = 1;\nconsole.log(JSON.stringify(copy), `${copy.double} ${box.double} calls=${calls}`);", "js");
  expect(stdout).toBe("20 20 calls=2\n42 calls=3\n{\"value\":21,\"double\":42} calls=4\n{\"value\":21,\"double\":42} 42 2 calls=6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-GET-02 a getter answering a function, a throwing getter, and Object.assign from one", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-GET-02", "// @dynamic\n\"use strict\";\n// a getter answering a function, a throwing getter, and Object.assign from one\n/** @type {*} */\nconst o = {\n  tag: \"t\",\n  get fn() {\n    return (x) => `fn(${x})`;\n  },\n  get bad() {\n    throw new RangeError(\"getter threw\");\n  },\n};\nconsole.log(`${o.fn(1)}`);\ntry {\n  console.log(`${o.bad}`);\n} catch (e) {\n  console.log(`read: ${e.name}: ${e.message}`);\n}\ntry {\n  console.log(JSON.stringify(o));\n} catch (e) {\n  console.log(`json: ${e.name}: ${e.message}`);\n}\n/** @type {*} */\nconst g = {\n  a: 1,\n  get b() {\n    return 2;\n  },\n};\nconsole.log(JSON.stringify(Object.assign({ z: 0 }, g)));", "js");
  expect(stdout).toBe("fn(1)\nread: RangeError: getter threw\njson: RangeError: getter threw\n{\"z\":0,\"a\":1,\"b\":2}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-GET-03 util.inspect shows an island getter as [Getter] without running it", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-GET-03", "// @dynamic\n\"use strict\";\n// util.inspect shows an island getter as [Getter] without running it\nimport { inspect } from \"node:util\";\nlet calls = 0;\n/** @type {*} */\nconst o = {\n  n: 1,\n  get g() {\n    calls++;\n    return 2;\n  },\n};\nconsole.log(inspect(o), calls);", "js");
  expect(stdout).toBe("{ n: 1, g: [Getter] } 0\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-GET-04 a getter that stringifies from inside JSON.stringify's own walk", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-GET-04", "// @dynamic\n\"use strict\";\n// a getter that stringifies from inside JSON.stringify's own walk\n/** @type {*} */\nconst inner = { a: [1, 2] };\n/** @type {*} */\nconst outer = {\n  head: \"h\",\n  tail: 0,\n  get nested() {\n    return JSON.stringify(inner);\n  },\n};\nconsole.log(JSON.stringify(outer));\n/** @type {*} */\nconst list = [outer, { x: 1 }];\nconsole.log(JSON.stringify(list));", "js");
  expect(stdout).toBe("{\"head\":\"h\",\"tail\":0,\"nested\":\"{\\\"a\\\":[1,2]}\"}\n[{\"head\":\"h\",\"tail\":0,\"nested\":\"{\\\"a\\\":[1,2]}\"},{\"x\":1}]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-PROTO-01 Object.create: null prototypes and live delegation through a linked object", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-PROTO-01", "// @dynamic\n\"use strict\";\n// Object.create: null prototypes and live delegation through a linked object\nconst dict = Object.create(null);\ndict.k = \"v\";\nconsole.log(`${typeof dict} ${dict.k} ${JSON.stringify(dict)}`);\n/** @returns {*} */\nfunction mk() {\n  return { tag: 7, greet() { return \"hi\"; } };\n}\nconst proto = mk();\nconst child = Object.create(proto);\nconst grand = Object.create(child);\nconsole.log(`${child.tag} ${grand.tag} ${child.greet()} ${grand.greet()}`);\ngrand.tag = 9;\nconsole.log(`${grand.tag} ${child.tag} ${proto.tag} ${JSON.stringify(grand)} ${JSON.stringify(child)}`);\nproto.late = \"L\";\nconsole.log(`${child.late} ${grand.late} ${child.missing}`);\nconsole.log(`${child.hasOwnProperty(\"tag\")} ${grand.hasOwnProperty(\"tag\")} ${typeof child} ${child === grand}`);", "js");
  expect(stdout).toBe("object v {\"k\":\"v\"}\n7 7 hi hi\n9 7 7 {\"tag\":9} {}\nL L undefined\nfalse true object false\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-PROTO-02 Object.create over a primitive: V8's TypeError text", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-PROTO-02", "// @dynamic\n\"use strict\";\n// Object.create over a primitive: V8's TypeError text\n/** @param {*} p */\nfunction tryCreate(p) {\n  try {\n    Object.create(p);\n    console.log(\"created\");\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\ntryCreate(undefined);\ntryCreate(42);\ntryCreate(\"abc\");\ntryCreate(true);\ntryCreate(-0);\ntryCreate(\"\");\ntryCreate(null);", "js");
  expect(stdout).toBe("TypeError: Object prototype may only be an Object or null: undefined\nTypeError: Object prototype may only be an Object or null: 42\nTypeError: Object prototype may only be an Object or null: abc\nTypeError: Object prototype may only be an Object or null: true\nTypeError: Object prototype may only be an Object or null: 0\nTypeError: Object prototype may only be an Object or null: \ncreated\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-PROTO-03 a getter on the prototype runs when the child reads it", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-PROTO-03", "// @dynamic\n\"use strict\";\n// a getter on the prototype runs when the child reads it\nlet reads = 0;\n/** @returns {*} */\nfunction base() {\n  return {\n    n: 2,\n    get twice() {\n      reads++;\n      return 4;\n    },\n  };\n}\nconst p = base();\nconst c = Object.create(p);\nc.n = 5;\nconsole.log(`${c.twice} ${c.n} ${p.n} reads=${reads} ${JSON.stringify(c)}`);", "js");
  expect(stdout).toBe("4 5 2 reads=1 {\"n\":5}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-TPL-01 an island tag sees the strings array with its raw member, the same per site", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-TPL-01", "// @dynamic\n\"use strict\";\n// an island tag sees the strings array with its raw member, the same per site\n/** @returns {*} */\nfunction mkTag() {\n  return (strings, ...vals) => strings;\n}\nconst tag = mkTag();\nconst seen = [];\nfor (let i = 0; i < 2; i++) seen.push(tag`a${i}b\\n`);\nconst s = seen[0];\nconsole.log(`${seen[0] === seen[1]} ${s.length} ${JSON.stringify(s)} ${JSON.stringify(s.raw)} ${s.raw.length}`);\nconst other = tag`a${0}b\\n`;\nconsole.log(`${other === s} ${other.raw[1]}`);\n/** @returns {*} */\nfunction mkJoin() {\n  return (strings, ...vals) => strings.raw.join(\"|\") + \"#\" + vals.join(\",\");\n}\nconst join = mkJoin();\nconsole.log(`${join`x${1}y${2}\\tz`}`);", "js");
  expect(stdout).toBe("true 2 [\"a\",\"b\\n\"] [\"a\",\"b\\\\n\"] 2\nfalse b\\n\nx|y|\\tz#1,2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-KEYS-01 the checked-dynamic key surfaces over island getters, linked objects and strings arrays", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-KEYS-01", "// @dynamic\n// the checked-dynamic key surfaces over island getters, linked objects and strings arrays\nlet calls = 0;\nconst box: any = {\n  value: 3,\n  get g() {\n    calls++;\n    return 4;\n  },\n};\nconst u: unknown = box;\nif (typeof u === \"object\" && u !== null) {\n  console.log(`${\"g\" in u} ${\"value\" in u} ${\"nope\" in u} ${Object.hasOwn(u, \"g\")} calls=${calls}`);\n  console.log(JSON.stringify(Object.keys(u)), JSON.stringify(Object.values(u)), JSON.stringify(Object.entries(u)), `calls=${calls}`);\n}\nfunction mk(): any {\n  return { tag: 7 };\n}\nconst child: any = Object.create(mk());\nconst cu: unknown = child;\nif (typeof cu === \"object\" && cu !== null) {\n  console.log(`${\"tag\" in cu} ${\"other\" in cu} ${Object.hasOwn(cu, \"tag\")} ${Object.keys(cu).length}`);\n}\nfunction mkTag(): any {\n  return (strings: any) => strings;\n}\nconst t = mkTag();\nconst s: unknown = t`q${1}r`;\nif (typeof s === \"object\" && s !== null) {\n  console.log(`${\"raw\" in s} ${\"0\" in s} ${\"zz\" in s} ${Object.hasOwn(s, \"raw\")} ${JSON.stringify(Object.keys(s))}`);\n}", "ts");
  expect(stdout).toBe("true true false true calls=0\n[\"value\",\"g\"] [3,4] [[\"value\",3],[\"g\",4]] calls=2\ntrue false false 0\ntrue true false true [\"0\",\"1\"]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});


// ── A2 refusals: this tier's named answers, Node's beside each ──────────

test("A2-REF-01 a write over an island getter, own or inherited, refuses by name", async () => {
  const src =
    '// @dynamic\n"use strict";\n/** @type {*} */\nconst o = {\n  n: 1,\n  get g() {\n    return 2;\n  },\n};\ntry {\n  o.g = 5;\n  console.log("assigned");\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\nconst c = Object.create(o);\ntry {\n  c.g = 6;\n  console.log("assigned");\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\nc.n = 7;\nconsole.log(`${c.n} ${o.n} ${c.g}`);';
  const { stdout, stderr, exitCode } = await runRow("A2-REF-01", src, "js");
  // Node (strict code): "TypeError: Cannot set property g of #<Object>
  // which has only a getter" for both writes; sloppy code ignores them.
  expect(stdout).toBe(
    "Error: assigning to the getter-only property 'g' of an island object is not supported yet\n" +
      "Error: assigning to the getter-only property 'g' of an island object is not supported yet\n" +
      "7 1 2\n",
  );
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-REF-02 Object.create over an array, a function or a null-prototype object refuses by name", async () => {
  const src =
    '// @dynamic\n"use strict";\n/** @param {*} p */\nfunction tryCreate(p) {\n  try {\n    Object.create(p);\n    console.log("created");\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\n/** @returns {*} */\nfunction arr() {\n  return [1];\n}\n/** @returns {*} */\nfunction fn() {\n  return () => 1;\n}\ntryCreate(arr());\ntryCreate(fn());\ntryCreate(Object.create(null));';
  const { stdout, exitCode } = await runRow("A2-REF-02", src, "js");
  // Node: "created" three times.
  expect(stdout).toBe(
    "Error: Object.create over an array, function, bytes, promise or handle prototype on the island is not supported yet\n" +
      "Error: Object.create over an array, function, bytes, promise or handle prototype on the island is not supported yet\n" +
      "Error: Object.create over a null-prototype or built-in object on the island is not supported yet\n",
  );
  expect(exitCode).toBe(0);
});

test("A2-REF-03 a getter written before a data member refuses at compile time (it would enumerate out of order)", async () => {
  const diags = await refuseRow(
    "A2-REF-03",
    '// @dynamic\n"use strict";\n/** @type {*} */\nconst o = {\n  get g() {\n    return 1;\n  },\n  n: 2,\n};\nconsole.log(JSON.stringify(o));',
    "js",
  );
  // Node: {"g":1,"n":2}.
  expect(diags.some((d) => d.startsWith("SC3001:") && d.includes("(jsOp:defineGetter-order)"))).toBe(true);
});

test("A2-REF-04 a typed conversion of an object carrying an island getter refuses by name, uncaught", async () => {
  const src =
    '// @dynamic\nconst o: any = {\n  n: 1,\n  get g() {\n    return 2;\n  },\n};\nfunction sum(r: { n: number; g: number }): number {\n  return r.n + r.g;\n}\nconsole.log("before");\nconsole.log(sum(o));';
  const { stdout, stderr } = await runRowTrap("A2-REF-04", src, "ts");
  // Node: before, then 3.
  expect(stdout).toBe("before\n");
  expect(stderr).toContain(
    "Uncaught Error: reading a getter-defined property of an island object here (a typed conversion, an option record, deep equality) is not supported yet",
  );
});

test("A2-REF-05 Object.assign onto an island getter refuses by name; deep equality over a linked object refuses uncaught", async () => {
  const src =
    '// @dynamic\nimport assert from "node:assert";\nconst t: any = {\n  n: 1,\n  get g() {\n    return 1;\n  },\n};\nconst tu: unknown = t;\nif (typeof tu === "object" && tu !== null) {\n  try {\n    Object.assign(tu, { g: 2 });\n    console.log("assigned");\n  } catch (e) {\n    console.log(`${(e as Error).name}: ${(e as Error).message}`);\n  }\n}\nfunction mk(): any {\n  return { a: 1 };\n}\nconst a: unknown = Object.create(mk());\nconst b: unknown = JSON.parse("{}");\nconsole.log("before");\nassert.deepStrictEqual(a, b);\nconsole.log("after");';
  const { stdout, stderr } = await runRowTrap("A2-REF-05", src, "ts");
  // Node: "TypeError: Cannot set property g of #<Object> which has only a
  // getter", before, after.
  expect(stdout).toBe("Error: copying onto the getter-only property 'g' of an island object is not supported yet\nbefore\n");
  expect(stderr).toContain("Uncaught Error: deep equality over an island object built by Object.create(proto) is not supported yet");
});

test("A2-CORPUS-2474 the island-literal-forms corpus program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("A2-CORPUS-2474", "2474-island-literal-forms.ts");
  expect(stdout).toBe("1 3 4\n10 20\n42\nfell-back 8\ntrue false true\ndone\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-CORPUS-2590 the Object.create corpus program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("A2-CORPUS-2590", "2590-object-create-dynamic.js");
  expect(stdout).toBe('object\n{"x":1} 1\nobject 7\n{}\n99 7\nlate\n{"tag":99}\ndone\n');
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-CORPUS-2251 the dynamic tagged-template corpus program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("A2-CORPUS-2251", "2251-tagged-templates-dyn.ts");
  expect(stdout).toBe("3:a,b,c:1\n1:plain\nHello , world!|1\ncaught: true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
test("A2-CLONE-01 structuredClone reads an island getter once, like a property read", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-CLONE-01", "// @dynamic\n\"use strict\";\n// structuredClone reads an island getter once, like a property read\nlet n = 0;\n/** @type {*} */\nconst o = {\n  a: 1,\n  get g() {\n    n++;\n    return 2;\n  },\n};\nconst c = structuredClone(o);\nconsole.log(`${JSON.stringify(c)} ${n}`);\nconsole.log(\"after\");", "js");
  expect(stdout).toBe("{\"a\":1,\"g\":2} 1\nafter\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-TAG-02 a non-callable island tag names itself", async () => {
  const { stdout, stderr, exitCode } = await runRow("A2-TAG-02", "// @dynamic\n\"use strict\";\n// a non-callable island tag names itself\n/** @returns {*} */\nfunction mk() {\n  return 5;\n}\nconst tag = mk();\ntry {\n  tag`x${1}`;\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}", "js");
  expect(stdout).toBe("TypeError: tag is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A2-REF-06 an index-signature typed conversion of an object carrying an island getter refuses by name, uncaught", async () => {
  const src =
    '// @dynamic\nconst o: any = {\n  n: 1,\n  get g() {\n    return 2;\n  },\n};\nfunction sum(r: { [k: string]: number }): number {\n  let t = 0;\n  for (const k in r) t += r[k]!;\n  return t;\n}\nconsole.log("before");\nconsole.log(sum(o));';
  const { stdout, stderr } = await runRowTrap("A2-REF-06", src, "ts");
  // Node: before, then 3. (The record walkers' raw entry reads take the
  // same refusal as dyn.objGet.)
  expect(stdout).toBe("before\n");
  expect(stderr).toContain("Uncaught Error: reading a getter-defined property of an island object here");
});
