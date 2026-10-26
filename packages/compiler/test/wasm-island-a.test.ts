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

test("A1-SPREAD-05 a nullish spread source with no known V8 rendering refuses by name, on both call paths; a numeric key renders its value", async () => {
  const { stdout, stderr, exitCode } = await runRow("A1-SPREAD-05", "// @dynamic\n\"use strict\";\n/** @type {*} */\nconst o = { x: null };\nconst id = (...a) => a.length;\ntry {\n  id(...o?.x);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\ntry {\n  id(...o[99999999999999999999]);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\ntry {\n  id(...o[7]);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\n/** @param {*} g */\nfunction cs(g) {\n  try {\n    g(...o?.x);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\ncs((...a) => a.length);\nconsole.log(`${id(...(o?.y ?? [1, 2]))}`);", "js");
  // Node: "TypeError: (intermediate value) is not iterable (cannot read
  // property null)"; the index lines as here (V8 prints a numeric key's
  // VALUE, which the front end now renders the same way); "(intermediate value)" again, then 2. The static
  // callee's three ride the checked-dynamic call path (an `any` source),
  // the any-callee one the island callSpread.
  expect(stdout).toBe(
    "Error: spreading null or undefined from this expression into a call is not supported yet\n" +
      "TypeError: o[100000000000000000000] is not iterable (cannot read property undefined)\n" +
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

// ============================================================
// A3 — board #243: element-access and spread method calls
// ============================================================

test("A3-MCALL-01 an element-access callee on an island receiver is a method call: this binds", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-01", "// @dynamic\n\"use strict\";\n// an element-access callee on an island receiver is a method call: this binds\n/** @returns {*} */\nfunction mk() {\n  return JSON.parse('{\"v\":7}');\n}\nconst o = mk();\no.m = function (a, b) {\n  return `${this === undefined ? \"undef\" : this.v}:${a + b}`;\n};\nconsole.log(`${o[\"m\"](1, 2)} ${o.m(1, 2)} ${o['m'](2, 3)}`);\n/** @returns {*} */\nfunction arr() {\n  return [3, 1, 2];\n}\nconst a = arr();\nconsole.log(`${a[\"push\"](9)} ${a.length} ${a[\"join\"](\"-\")} ${a[0]}`);", "js");
  expect(stdout).toBe("7:3 7:3 7:5\n4 4 3-1-2-9 3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-02 a spread method call on an island receiver: this binds, the spread iterates", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-02", "// @dynamic\n\"use strict\";\n// a spread method call on an island receiver: this binds, the spread iterates\n/** @returns {*} */\nfunction mk() {\n  return JSON.parse('{\"v\":7}');\n}\nconst o = mk();\no.m = function (...a) {\n  return `${this === undefined ? \"undef\" : this.v}:${a.join(\",\")}`;\n};\nconst xs = [1, 2];\nconsole.log(`${o.m(...xs)} ${o[\"m\"](0, ...xs)} ${o.m(...\"ab\")}`);\n/** @returns {*} */\nfunction arr() {\n  return [3];\n}\nconst a = arr();\nconsole.log(`${a[\"push\"](...xs)} ${a.push(...[4, 5])} ${a.join(\",\")}`);\ntry {\n  o.nope(...xs);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\ntry {\n  o[\"nope\"](1, ...xs);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\ntry {\n  o.m(...o.missing);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}", "js");
  expect(stdout).toBe("7:1,2 7:0,1,2 7:a,b\n3 5 3,1,2,4,5\nTypeError: o.nope is not a function\nTypeError: o.nope is not a function\nTypeError: o.missing is not iterable (cannot read property undefined)\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-03 an element-access callee on a checked-dynamic receiver binds this too", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-03", "\"use strict\";\n// an element-access callee on a checked-dynamic receiver binds this too\nconst o = JSON.parse('{\"v\":7,\"list\":[1,2]}');\no.m = function (a) {\n  return `${this === undefined ? \"undef\" : this.v}:${a}`;\n};\nconsole.log(`${o[\"m\"](5)} ${o[\"list\"][\"indexOf\"](2)}`);", "cjs");
  expect(stdout).toBe("7:5 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-RENDER-01 V8's rendering of a nullish spread source: string keys print .content, numeric keys their value", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-RENDER-01", "// @dynamic\n\"use strict\";\n// V8's rendering of a nullish spread source: string keys print .content, numeric keys their value\n/** @returns {*} */\nfunction mk() {\n  return {};\n}\nconst o = mk();\nconst id = (...a) => a.length;\nconst tries = [\n  () => id(...o[\"a-b\"]),\n  () => id(...o[\"0\"]),\n  () => id(...o[0x10]),\n  () => id(...o[1.5]),\n  () => id(...(o).x),\n  () => id(...o['q']),\n];\nfor (const t of tries) {\n  try {\n    t();\n  } catch (e) {\n    console.log(`${e.message}`);\n  }\n}", "js");
  expect(stdout).toBe("o.a-b is not iterable (cannot read property undefined)\no.0 is not iterable (cannot read property undefined)\no[16] is not iterable (cannot read property undefined)\no[1.5] is not iterable (cannot read property undefined)\no.x is not iterable (cannot read property undefined)\no.q is not iterable (cannot read property undefined)\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-04 a computed-key member call on an island value keeps the plain call", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-04", "// @dynamic\n\"use strict\";\n/** @returns {*} */\nfunction mk() {\n  return { v: 1, m() { return 2; } };\n}\nconst o = mk();\nconst k = \"m\";\nconsole.log(\"before\");\nconsole.log(`${o[k]()}`);", "js");
  expect(stdout).toBe("before\n2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-05 a computed-key call out of an ordinary any[] is a plain call, as before", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-05", "// @dynamic\n\"use strict\";\n// a computed-key call out of an ordinary any[] is a plain call, as before\n/** @type {*[]} */\nconst fns = [(x) => x + 1, (x) => x * 2];\nlet total = 0;\nfor (let i = 0; i < fns.length; i++) total += fns[i](3);\nconsole.log(`${total}`);", "js");
  expect(stdout).toBe("10\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-06 computed-key calls out of a Record<string, any> and an any[]", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-06", "// @dynamic\n// computed-key calls out of a Record<string, any> and an any[]\nconst table: Record<string, any> = { inc: (x: number) => x + 1, dbl: (x: number) => x * 2 };\nconst arr: any[] = [(x: number) => x - 1, (x: number) => x * 10];\nfor (const k of [\"inc\", \"dbl\"]) console.log(`${table[k](1)}`);\nfor (let i = 0; i < arr.length; i++) console.log(`${arr[i](2)}`);", "ts");
  expect(stdout).toBe("2\n2\n1\n20\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-07 the island's not-a-function texts spell the callee as V8 does", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-07", "// @dynamic\n\"use strict\";\n// the island's not-a-function texts spell the callee as V8 does\n/** @returns {*} */\nfunction mk() {\n  return { v: 1, list: [1] };\n}\nconst o = mk();\ntry { o.zz(1); } catch (e) { console.log(e.message); }\ntry { o[\"v\"](1); } catch (e) { console.log(e.message); }\ntry { o[\"zz\"](1); } catch (e) { console.log(e.message); }\ntry { o[0x10](1); } catch (e) { console.log(e.message); }\ntry { o[\"list\"][0](1); } catch (e) { console.log(e.message); }\ntry { o.list[0](1); } catch (e) { console.log(e.message); }", "js");
  expect(stdout).toBe("o.zz is not a function\no.v is not a function\no.zz is not a function\no[16] is not a function\no.list[0] is not a function\no.list[0] is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-08 a checked-dynamic receiver's not-a-function texts spell the whole callee", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-08", "// @dynamic\n// a checked-dynamic receiver's not-a-function texts spell the whole callee\nfunction mk(): any {\n  return JSON.parse('{\"v\":1,\"list\":[1]}');\n}\nconst o = mk();\ntry { o.zz(1); } catch (e) { console.log((e as Error).message); }\ntry { o[\"v\"](1); } catch (e) { console.log((e as Error).message); }\ntry { o[0x10](1); } catch (e) { console.log((e as Error).message); }\ntry { o[\"list\"][0](1); } catch (e) { console.log((e as Error).message); }\ntry { o.slice(); } catch (e) { console.log((e as Error).message); }", "ts");
  expect(stdout).toBe("o.zz is not a function\no.v is not a function\no[16] is not a function\no.list[0] is not a function\no.slice is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-MCALL-09 a computed-key call on an island object calls the member with this undefined (registered)", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-MCALL-09", "// @dynamic\n\"use strict\";\n// a computed-key call on an island object calls the member with this undefined (registered)\n/** @returns {*} */\nfunction mk() {\n  return { v: 7, m: function () { return typeof this === \"object\" ? this.v : String(this); } };\n}\nconst o = mk();\nconst k = \"m\";\nconsole.log(`${o[k]()} ${o[\"m\"]()} ${o.m()}`);", "js");
  // Node: 7 7 7. A computed key keeps the plain call, so `this` is
  // undefined in the member (SEMANTICS.md S043, unit-A3 amendment).
  expect(stdout).toBe("undefined 7 7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
test("A3-TOSTR-01 Object.prototype.toString called as a method on island objects", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-TOSTR-01", "// @dynamic\n\"use strict\";\n// Object.prototype.toString called as a method on island objects\n/** @returns {*} */\nfunction mk() {\n  return { a: 1 };\n}\nconst o = mk();\nconst c = Object.create(o);\n/** @returns {*} */\nfunction withOwn() {\n  return { toString() { return \"own\"; } };\n}\nconst w = withOwn();\nconst d = Object.create(w);\nconsole.log(`${o.toString()} ${c.toString()} ${String(c)} ${w.toString()} ${d.toString()} ${o.toLocaleString()}`);", "js");
  expect(stdout).toBe("[object Object] [object Object] [object Object] own own [object Object]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A3-RENDER-02 numeric-literal keys print their VALUE (unsafe integers, hex/octal/binary, exponents, separators)", async () => {
  const { stdout, stderr, exitCode } = await runRow("A3-RENDER-02", "// @dynamic\n\"use strict\";\n// numeric-literal keys print their VALUE (unsafe integers, hex/octal/binary, exponents, separators)\n/** @returns {*} */\nfunction mk() {\n  return {};\n}\nconst o = mk();\nconst id = (...a) => a.length;\nconst tries = [\n  () => id(...o[9007199254740993]),\n  () => id(...o[99999999999999999999]),\n  () => id(...o[0xff]),\n  () => id(...o[0o17]),\n  () => id(...o[0b101]),\n  () => id(...o[1e3]),\n  () => id(...o[1e21]),\n  () => id(...o[2.50]),\n  () => id(...o[.5]),\n  () => id(...o[1_000]),\n  () => id(...o[\"it's\"]),\n];\nfor (const t of tries) {\n  try {\n    t();\n  } catch (e) {\n    console.log(`${e.message}`);\n  }\n}", "js");
  expect(stdout).toBe("o[9007199254740992] is not iterable (cannot read property undefined)\no[100000000000000000000] is not iterable (cannot read property undefined)\no[255] is not iterable (cannot read property undefined)\no[15] is not iterable (cannot read property undefined)\no[5] is not iterable (cannot read property undefined)\no[1000] is not iterable (cannot read property undefined)\no[1e+21] is not iterable (cannot read property undefined)\no[2.5] is not iterable (cannot read property undefined)\no[0.5] is not iterable (cannot read property undefined)\no[1000] is not iterable (cannot read property undefined)\no.it's is not iterable (cannot read property undefined)\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});


// ============================================================
// F1 — an island RegExp value
// ============================================================

test("F1-RE-01 a RegExp held in an any: accessors, test, String(), inspect, keys, JSON, spread", async () => {
  const { stdout, stderr, exitCode } = await runRow("F1-RE-01", "// @dynamic\n// a RegExp held in an any: accessors, test, String(), inspect, keys, JSON, spread\nimport { inspect } from \"node:util\";\nconst r: any = /a(b)+c/im;\nconsole.log(`${typeof r} ${r.source} ${r.flags} ${r.global} ${r.ignoreCase} ${r.multiline} ${r.sticky} ${r.unicode} ${r.lastIndex}`);\nconsole.log(`${r.test(\"xABBC\")} ${r.test(\"ac\")} ${r.test(42)} ${String(r)} ${r.toString()}`);\nconst sp: any = { ...r };\nconsole.log(inspect(r), JSON.stringify(r), JSON.stringify(sp));\nconst u: unknown = r;\nif (typeof u === \"object\" && u !== null) console.log(`${Object.hasOwn(u, \"lastIndex\")} ${Object.hasOwn(u, \"source\")} ${JSON.stringify(Object.keys(u))}`);\nconst r2: any = /a(b)+c/im;\nconsole.log(`${r === r2}`);", "ts");
  expect(stdout).toBe("object a(b)+c im false true true false false 0\ntrue false false /a(b)+c/im /a(b)+c/im\n/a(b)+c/im {} {}\ntrue false []\nfalse\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F1-RE-02 the unmodeled RegExp surface refuses by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("F1-RE-02", "// @dynamic\n// the unmodeled RegExp surface refuses by name\nconst g: any = /x/g;\nconst r: any = /x/;\nfor (const f of [() => g.test(\"x\"), () => r.exec(\"x\"), () => typeof r.exec, () => { r.lastIndex = 3; }]) {\n  try {\n    console.log(`ok ${f()}`);\n  } catch (e) {\n    console.log(`${(e as Error).name}: ${(e as Error).message}`);\n  }\n}", "ts");
  // Node: ok true / ok x / ok function / ok undefined.
  expect(stdout).toBe("Error: 'RegExp.prototype.test' on a global or sticky island RegExp is not supported yet\nError: 'RegExp.prototype.exec' on an island value is not supported yet\nError: 'RegExp.prototype.exec' read as a value on an island value is not supported yet\nError: assigning a member of an island RegExp is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F1-RE-04 an island RegExp holds no own members: member writes and Object.create over one refuse by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("F1-RE-04", "// @dynamic\n// an island RegExp holds no own members: every member write, and Object.create over one, refuses by name\nconst r: any = /a/;\nconst tries: (() => any)[] = [\n  () => { r.test = () => true; return r.test(\"b\"); },\n  () => { r.toString = () => \"X\"; return r.toString(); },\n  () => { r.foo = 1; return r.foo; },\n  () => { r.source = \"zz\"; return r.source; },\n  () => Object.create(r).source,\n];\nfor (const t of tries) {\n  try {\n    console.log(`ok ${t()}`);\n  } catch (e) {\n    console.log(`${(e as Error).message}`);\n  }\n}\nconsole.log(`${r.test(\"a\")} ${r.test(\"b\")} ${r.toString()} ${r.source}`);", "ts");
  // Node: ok true / ok X / ok 1 / "Cannot set property source of [object
  // Object] which has only a getter" / "RegExp.prototype.source getter
  // called on non-RegExp object" / true true X a. Each refusal keeps the
  // regex's own readers exact (the last line's built-ins answer).
  expect(stdout).toBe("assigning a member of an island RegExp is not supported yet\nassigning a member of an island RegExp is not supported yet\nassigning a member of an island RegExp is not supported yet\nassigning a member of an island RegExp is not supported yet\nObject.create over a null-prototype or built-in object on the island is not supported yet\ntrue false /a/ a\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F1-RE-05 lastIndex is an own member of an island RegExp, for in and Object.hasOwn alike", async () => {
  const { stdout, stderr, exitCode } = await runRow("F1-RE-05", "// @dynamic\n// lastIndex is an own member of an island RegExp, for in and Object.hasOwn alike\nconst r: any = /a/;\nconst u: unknown = r;\nif (typeof u === \"object\" && u !== null) {\n  console.log(`${\"lastIndex\" in u} ${Object.hasOwn(u, \"lastIndex\")} ${\"foo\" in u} ${Object.hasOwn(u, \"source\")}`);\n}", "ts");
  expect(stdout).toBe("true true false false\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F1-RE-03 a RegExp whose pattern is known only at run time still refuses by name", async () => {
  const diags = await refuseRow("F1-RE-03", "// @dynamic\n// a RegExp whose pattern is known only at run time refuses by name\nfunction take(r: RegExp, s: string): boolean;\nfunction take(r: any, s: any): any {\n  return r.test(s);\n}\nconst src = process.argv.length > 99 ? \"a\" : \"b\";\nconsole.log(take(new RegExp(src), \"b\"));", "ts");
  // Node: true.
  expect(diags.some((d) => d.startsWith("SC1090:") && d.includes("passing a value of type 'RegExp'"))).toBe(true);
});

test("F1-CORPUS-2172 the island RegExp boundary program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("F1-CORPUS-2172", "2172-island-regexp-boundary.ts");
  expect(stdout).toBe("y\nn\ny\ny\nn\nobject\nd{2} u\nn\ny\nc\\d+ <none>\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// I — unions, URLs and typed arrays held in dynamic values
// ============================================================

test("I-UNION-01 unions cross by their runtime tag: unit arms are the island's own undefined/null", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-UNION-01", "// @dynamic\n// unions cross by their runtime tag: unit arms are the island's own undefined/null\nfunction pick(flag: boolean): string | undefined {\n  return flag ? \"chosen\" : undefined;\n}\nfunction nickel(flag: boolean): string | null {\n  return flag ? \"coin\" : null;\n}\nfunction num(flag: boolean): number | boolean {\n  return flag ? 4 : false;\n}\nconst box: any = { tag: pick(true), empty: pick(false), coin: nickel(true), slot: nickel(false), n: num(true), b: num(false) };\nconsole.log(`${box.tag} ${typeof box.empty} ${box.coin} ${box.slot === null} ${box.n + 1} ${box.b}`);\nconst direct: any = nickel(false);\nconsole.log(`${direct === null} ${JSON.stringify(box)}`);", "ts");
  expect(stdout).toBe("chosen undefined coin true 5 false\ntrue {\"tag\":\"chosen\",\"coin\":\"coin\",\"slot\":null,\"n\":4,\"b\":false}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-URL-01 a URL held in an any: its getters, String(), toString(), JSON, typeof, keys, spread", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-URL-01", "// @dynamic\n// a URL held in an any: its getters, String(), toString(), JSON, typeof, keys, spread\nconst url = new URL(\"https://user@example.dev:8080/p/a.mp3?q=1&r=2#frag\");\nconst hu: any = url;\nconsole.log(`${hu.href} | ${hu.protocol} | ${hu.host} | ${hu.hostname} | ${hu.pathname} | ${hu.search}`);\nconsole.log(`${hu} ${hu.toString() === hu.href} ${hu.toJSON()} ${JSON.stringify(hu)} ${typeof hu}`);\nconst sp: any = { ...hu };\nconsole.log(`${JSON.stringify(sp)} ${hu === hu}`);\nconst u2: unknown = hu;\nif (typeof u2 === \"object\" && u2 !== null) console.log(JSON.stringify(Object.keys(u2)));", "ts");
  expect(stdout).toBe("https://user@example.dev:8080/p/a.mp3?q=1&r=2#frag | https: | example.dev:8080 | example.dev | /p/a.mp3 | ?q=1&r=2\nhttps://user@example.dev:8080/p/a.mp3?q=1&r=2#frag true https://user@example.dev:8080/p/a.mp3?q=1&r=2#frag \"https://user@example.dev:8080/p/a.mp3?q=1&r=2#frag\" object\n{} true\n[]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-URL-02 the URL members this tier does not expose refuse by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-URL-02", "// @dynamic\n// the URL members this tier does not expose refuse by name\nconst hu: any = new URL(\"https://example.dev:8080/p#frag\");\nfor (const name of [\"hash\", \"port\", \"origin\", \"searchParams\"]) {\n  try {\n    console.log(`ok ${hu[name]}`);\n  } catch (e) {\n    console.log(`${(e as Error).message}`);\n  }\n}", "ts");
  // Node: ok #frag / ok 8080 / ok https://example.dev:8080 / ok (the
  // URLSearchParams' empty string).
  expect(stdout).toBe("reading 'hash' of a URL held in a dynamic value is not supported yet\nreading 'port' of a URL held in a dynamic value is not supported yet\nreading 'origin' of a URL held in a dynamic value is not supported yet\nreading 'searchParams' of a URL held in a dynamic value is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-URL-03 a URL held in a dynamic value holds no own members: writes and Object.create over one refuse by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-URL-03", "// @dynamic\n// a URL held in a dynamic value holds no own members: writes and Object.create over one refuse by name\nconst hu: any = new URL(\"https://example.dev/p\");\nconst tries: (() => any)[] = [\n  () => { hu.href = \"https://other.dev/\"; return hu.href; },\n  () => { hu.foo = 1; return hu.foo; },\n  () => Object.create(hu).href,\n];\nfor (const t of tries) {\n  try {\n    console.log(`ok ${t()}`);\n  } catch (e) {\n    console.log(`${(e as Error).message}`);\n  }\n}\nconsole.log(`${hu.href} ${JSON.stringify(hu)}`);", "ts");
  // Node: ok https://other.dev/ / ok 1 / "Receiver must be an instance of
  // class URL" / https://other.dev/ "https://other.dev/" (the href setter
  // reparses). The refusals keep the getters exact.
  expect(stdout).toBe("assigning a member of a URL held in a dynamic value is not supported yet\nassigning a member of a URL held in a dynamic value is not supported yet\nObject.create over a null-prototype or built-in object on the island is not supported yet\nhttps://example.dev/p \"https://example.dev/p\"\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-URL-04 a URL held in a dynamic value refuses by name at a string slot and as constructor", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-URL-04", "// @dynamic\n// a URL held in a dynamic value passed back where a string is expected\nconst u: any = new URL(\"https://a.com/p?q=1\");\ntry {\n  const v = new URL(u);\n  console.log(`ok ${v.href}`);\n} catch (e) {\n  console.log(`${(e as Error).message}`);\n}\ntry {\n  const s: string = u;\n  console.log(`ok ${s.length}`);\n} catch (e) {\n  console.log(`${(e as Error).message}`);\n}\ntry {\n  console.log(`ok ${typeof u.constructor}`);\n} catch (e) {\n  console.log(`${(e as Error).message}`);\n}\nconsole.log(\"end\");", "ts");
  // Node: ok https://a.com/p?q=1 (new URL reads the href) / ok undefined
  // (a string-typed slot holds the object) / ok function / end.
  expect(stdout).toBe("passing a URL held in a dynamic value where a string is expected is not supported yet\npassing a URL held in a dynamic value where a string is expected is not supported yet\nreading 'constructor' of a URL held in a dynamic value is not supported yet\nend\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-TYPED-01 a non-u8 typed array held in an any: length, index reads, constructor, BYTES_PER_ELEMENT", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-TYPED-01", "// @dynamic\n// a non-u8 typed array held in an any: length, index reads, constructor, BYTES_PER_ELEMENT\nconst words = new Uint32Array([7, 900000001]);\nconst hw: any = words;\nconsole.log(`${hw.length} ${hw[0]} ${hw[1]} ${hw[2]} ${hw.constructor.name} ${hw.BYTES_PER_ELEMENT} ${hw.byteLength} ${typeof hw}`);\nconst floats = new Float32Array([1.5, -0.25]);\nconst hf: any = floats;\nconsole.log(`${hf.length} ${hf[1]} ${hf.constructor.name} ${hf.constructor.length} ${typeof hf.constructor}`);\nconst ints = new Int32Array([-3]);\nconst hi: any = ints;\nconst again: any = ints;\nconsole.log(`${hi[0]} ${hi.constructor.name} ${hi === again} ${hi === hw} ${hi.constructor === again.constructor} ${!!hi}`);\nconst bytes = new Uint8Array([1]);\nconst hb: any = bytes;\nconsole.log(`${hb.constructor.name} ${hb.constructor === hb.constructor}`);", "ts");
  expect(stdout).toBe("2 7 900000001 undefined Uint32Array 4 8 object\n2 -0.25 Float32Array 3 function\n-3 Int32Array true false true true\nUint8Array true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-TYPED-02 every reader that would walk or convert a dynamic typed array refuses by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-TYPED-02", "// @dynamic\n// every reader that would walk or convert a dynamic typed array refuses by name\nconst hw: any = new Uint32Array([7, 8]);\nconst tries: (() => any)[] = [\n  () => JSON.stringify(hw),\n  () => hw.map((x: any) => x),\n  () => { hw[0] = 1; },\n  () => { const s: any = { ...hw }; return s; },\n  () => hw.at(0),\n  () => hw.constructor(2),\n];\nfor (const t of tries) {\n  try {\n    console.log(`ok ${t()}`);\n  } catch (e) {\n    console.log(`${(e as Error).message}`);\n  }\n}\nconst u: unknown = hw;\nif (typeof u === \"object\" && u !== null) {\n  const more: (() => any)[] = [() => Object.keys(u), () => \"0\" in u, () => Object.hasOwn(u, \"0\")];\n  for (const t of more) {\n    try {\n      console.log(`ok ${t()}`);\n    } catch (e) {\n      console.log(`${(e as Error).message}`);\n    }\n  }\n}", "ts");
  // Node: ok {"0":7,"1":8} / ok 7,8 / ok undefined / ok [object Object] /
  // ok 1 / Constructor Uint32Array requires 'new' / ok 0,1 / ok true /
  // ok true. `"0" in u` is the one reader answered (Node's true).
  expect(stdout).toBe("JSON.stringify of a typed array held in a dynamic value is not supported yet\ncalling 'map' on a typed array held in a dynamic value is not supported yet\nassigning a member of a typed array held in a dynamic value is not supported yet\nspreading a typed array held in a dynamic value is not supported yet\ncalling 'at' on a typed array held in a dynamic value is not supported yet\ncalling 'constructor' on a typed array held in a dynamic value is not supported yet\nwalking the keys of a typed array held in a dynamic value is not supported yet\nok true\n'in' or Object.hasOwn on a typed array held in a dynamic value is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-TYPED-03 an unaudited reader of a dynamic typed array traps (never a silent {} / [] / undefined)", async () => {
  // structuredClone's walk was not taught the typed kind: it reaches its
  // JSVAL arm, which is unreachable. Node: before, then after.
  const { stdout } = await runRowTrap("I-TYPED-03", "// @dynamic\nconst hw: any = new Uint32Array([7, 8]);\nconsole.log(\"before\");\nconst c: any = structuredClone(hw);\nconsole.log(`${c.length}`);\nconsole.log(\"after\");", "ts");
  expect(stdout).toBe("before\n");
});

test("I-TYPED-04 converting a dynamic typed array to a string refuses by name, uncaught", async () => {
  // Node: before, 7,8, after. The conversion sites are not catchable.
  const { stdout, stderr } = await runRowTrap("I-TYPED-04", "// @dynamic\nconst hw: any = new Uint32Array([7, 8]);\nconsole.log(\"before\");\nconsole.log(`${hw}`);\nconsole.log(\"after\");", "ts");
  expect(stdout).toBe("before\n");
  expect(stderr).toContain("converting a typed array held in a dynamic value to a string is not supported yet");
});

test("I-CTOR-01 the constructor boxes answer name, length and BYTES_PER_ELEMENT; other statics and calls refuse by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("I-CTOR-01", "// @dynamic\n// the constructor boxes: name, length and BYTES_PER_ELEMENT answer; other statics and calls refuse by name\nconst a: any = new Uint8Array([1, 2]);\nconst b: any = Buffer.from(\"hi\");\nconst w: any = new Uint32Array(2);\nconsole.log(`${a.constructor.BYTES_PER_ELEMENT} ${b.constructor.BYTES_PER_ELEMENT} ${w.constructor.BYTES_PER_ELEMENT} ${a.constructor.name} ${w.constructor.length}`);\nconst tries: (() => any)[] = [\n  () => a.constructor.from,\n  () => w.constructor.of,\n  () => a.constructor.prototype,\n  () => b.constructor.isBuffer,\n  () => a.constructor(1),\n  () => w.constructor(1),\n];\nfor (const t of tries) {\n  try {\n    console.log(`ok ${typeof t()}`);\n  } catch (e) {\n    console.log(`${(e as Error).message}`);\n  }\n}", "ts");
  // Node: the first line, then ok function / ok function / ok object /
  // ok function / Constructor Uint8Array requires 'new' / Constructor
  // Uint32Array requires 'new'.
  expect(stdout).toBe("1 1 4 Uint8Array 3\nreading 'from' of a typed-array constructor read from a dynamic value is not supported yet\nreading 'of' of a typed-array constructor read from a dynamic value is not supported yet\nreading 'prototype' of a typed-array constructor read from a dynamic value is not supported yet\nreading 'isBuffer' of a typed-array constructor read from a dynamic value is not supported yet\ncalling 'constructor' on a typed array held in a dynamic value is not supported yet\ncalling 'constructor' on a typed array held in a dynamic value is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("I-CORPUS-766 the union boundary program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("I-CORPUS-766", "766-any-union-boundary.ts");
  expect(stdout).toBe("chosen undefined coin true\nundefined\nundefined true true\n3 104 33 Uint8Array\n2 900000001 Uint32Array\n2 -0.25 Float32Array\n3 105\n7 text\nhttps://example.dev/media/a.mp3?q=1#frag https: /media/a.mp3\nhttps://example.dev/media/a.mp3?q=1#frag\nhttps://example.dev/media/a.mp3?q=1#frag\n3\nchosen undefined 3\n3 chosen undefined last\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// P — static promises inside `any`, island Promise.all, flat
// ============================================================
//
// jsMarshal's promise arm (a static promise crossing BY REFERENCE as a
// DK.PROMISE box), the `Promise<any[]>` jsBridgePromise arm (Array-gated,
// the vector by reference, settled the moment its source settles — at the
// bridge or from settle's epilogue), async returns into `Promise<any[]>`
// adopting a held promise, `any[]` values crossing both ways by reference,
// island `Promise.all` (spreadPush + PromiseResolve + the static
// combinator; a non-iterable rejects) and the dyn Array.prototype.flat arm.
// Run rows: stdout is a real Node v24.18.1 run of the same source (the
// review's repros among them). Hand rows state Node's answer beside the pin.

test("P-CROSS-01 a static promise crossing into an island slot: typeof, identity across two crossings, await, then", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-CROSS-01", "// @dynamic\n// a static promise crossing into an island slot: typeof, identity across two crossings, await, then\n'use strict';\n/** @param {number} n @returns {Promise<number>} */\nasync function load(n) {\n  return n * 2;\n}\n/** @returns {Promise<any[]>} */\nasync function list() {\n  return [\"a\", \"b\"];\n}\n/** @returns {any} */\nfunction mk() {\n  return { p: null, q: null };\n}\nasync function main() {\n  const p = load(4);\n  const h = mk();\n  h.p = p;\n  h.q = p;\n  console.log(`${typeof h.p} ${h.p === h.q}`);\n  console.log(`${await h.p}`);\n  h.l = list();\n  const got = await h.l;\n  console.log(`${got.length} ${got[1]}`);\n  h.p.then((v) => console.log(`then ${v}`));\n  await null;\n  await null;\n}\nvoid main();", "js");
  expect(stdout).toBe("object true\n8\n2 b\nthen 8\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-ALL-01 island Promise.all: every non-iterable is a REJECTED promise with V8's text, strings iterate", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-ALL-01", "// @dynamic\n// island Promise.all: non-iterables reject (never throw), strings, empty, mixed entries\nconst vals: any[] = [5, undefined, null, {}, true, \"ab\", () => 1, [1, [2]], \"\", 1.5];\nasync function main() {\n  for (const v of vals) {\n    const x: any = v;\n    let p: any;\n    try {\n      p = Promise.all(x);\n    } catch (e) {\n      console.log(\"SYNC \" + (e as Error).message);\n      continue;\n    }\n    console.log(typeof p);\n    try {\n      const r: any = await p;\n      console.log(\"ok \" + JSON.stringify(r));\n    } catch (e) {\n      console.log((e as Error).name + \": \" + (e as Error).message);\n    }\n  }\n}\nvoid main();", "ts");
  expect(stdout).toBe("object\nTypeError: number 5 is not iterable (cannot read property Symbol(Symbol.iterator))\nobject\nTypeError: undefined is not iterable (cannot read property Symbol(Symbol.iterator))\nobject\nTypeError: object null is not iterable (cannot read property Symbol(Symbol.iterator))\nobject\nTypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))\nobject\nTypeError: boolean true is not iterable (cannot read property Symbol(Symbol.iterator))\nobject\nok [\"a\",\"b\"]\nobject\nTypeError: function is not iterable (cannot read property Symbol(Symbol.iterator))\nobject\nok [1,[2]]\nobject\nok []\nobject\nTypeError: number 1.5 is not iterable (cannot read property Symbol(Symbol.iterator))\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-ALL-02 island Promise.all over mixed entries: input order, first rejection, turn interleaving, empty", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-ALL-02", "// @dynamic\n// island Promise.all over mixed static and island entries, rejection ordering, turn interleaving\n'use strict';\n/** @param {number} v @returns {Promise<number>} */\nasync function slow(v) {\n  await null;\n  await null;\n  return v;\n}\n/** @param {string} msg @returns {Promise<number>} */\nasync function boom(msg) {\n  await null;\n  throw new Error(msg);\n}\n/** @param {string} msg @returns {Promise<number>} */\nasync function boomLate(msg) {\n  await null;\n  await null;\n  await null;\n  throw new Error(msg);\n}\n/** @returns {any} */\nfunction mk() {\n  return { v: 7, list: [] };\n}\nasync function main() {\n  const box = mk();\n  box.entries = [slow(1), box.v, \"s\", slow(3)];\n  const r = await Promise.all(box.entries);\n  console.log(JSON.stringify(r));\n  box.bad = [boomLate(\"late\"), boom(\"first\"), slow(2)];\n  try {\n    await Promise.all(box.bad);\n  } catch (e) {\n    console.log(`caught ${e.message}`);\n  }\n  const log = [];\n  box.two = [slow(1), 2];\n  const all = Promise.all(box.two);\n  queueMicrotask(() => log.push(\"m1\"));\n  all.then(() => log.push(\"all\"));\n  Promise.resolve()\n    .then(() => log.push(\"t1\"))\n    .then(() => log.push(\"t2\"))\n    .then(() => log.push(\"t3\"))\n    .then(() => log.push(\"t4\"))\n    .then(() => log.push(\"t5\"));\n  await slow(0);\n  await slow(0);\n  await slow(0);\n  console.log(log.join(\",\"));\n  const z = await Promise.all(box.list);\n  console.log(`${JSON.stringify(z)} ${z.length}`);\n}\nvoid main();", "js");
  expect(stdout).toBe("[1,7,\"s\",3]\ncaught first\nm1,t1,t2,t3,all,t4,t5\n[] 0\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-ALL-03 island Promise.all: the first rejection wins, the losers are not reported, the result is one value", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-ALL-03", "// @dynamic\n// island Promise.all: the first rejection wins, the losers are not reported; the result is one value\n'use strict';\n/** @param {string} m @returns {Promise<number>} */\nasync function rej(m) {\n  throw new Error(m);\n}\n/** @param {number} v @returns {Promise<number>} */\nasync function ok(v) {\n  return v;\n}\n/** @returns {any} */\nfunction mk() {\n  return { xs: null };\n}\nasync function main() {\n  const box = mk();\n  box.xs = [ok(1), rej(\"one\"), rej(\"two\")];\n  try {\n    await Promise.all(box.xs);\n  } catch (e) {\n    console.log(`caught ${e.message}`);\n  }\n  box.p = Promise.all(box.xs.slice(0, 1));\n  console.log(`${typeof box.p} ${box.p === box.p}`);\n  const v = await box.p;\n  console.log(`${JSON.stringify(v)} ${v === (await box.p)}`);\n}\nvoid main();", "js");
  expect(stdout).toBe("caught one\nobject true\n[1] true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-ALL-04 island Promise.all over a promise: a rejection, never a synchronous throw", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-ALL-04", "// @dynamic\n// island Promise.all over a promise (not iterable): a rejection, after the synchronous code\n'use strict';\n/** @returns {Promise<number>} */\nasync function one() {\n  return 1;\n}\n/** @returns {any} */\nfunction mk() {\n  return { p: null };\n}\nasync function main() {\n  const box = mk();\n  box.p = one();\n  const r = Promise.all(box.p);\n  console.log(\"sync\");\n  try {\n    await r;\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\nvoid main();", "js");
  expect(stdout).toBe("sync\nTypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-02 a Promise<any[]> bridge settles at Node's turn and aliases the spine", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-02", "// @dynamic\n// a Promise<any[]> bridge's settle against a competing microtask chain, and the spine aliasing\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return { list: [1, 2, 3] };\n}\nconst src = mk();\n/** @returns {Promise<any[]>} */\nfunction viaAll() {\n  return Promise.all(src.list);\n}\nasync function main() {\n  const log = [];\n  const p = viaAll();\n  p.then(() => log.push(\"bridge\"));\n  Promise.resolve()\n    .then(() => log.push(\"t1\"))\n    .then(() => log.push(\"t2\"))\n    .then(() => log.push(\"t3\"))\n    .then(() => log.push(\"t4\"))\n    .then(() => log.push(\"t5\"));\n  await null;\n  await null;\n  await null;\n  await null;\n  await null;\n  await null;\n  console.log(log.join(\",\"));\n  const got = await viaAll();\n  got.push(4);\n  console.log(`${got.length} ${got[3]}`);\n}\nvoid main();", "js");
  expect(stdout).toBe("t1,bridge,t2,t3,t4,t5\n4 4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-03 a Promise<any[]> bridge's waiters run at Node's queue position: await, rejection, two waiters, a late waiter", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-03", "// @dynamic\n// Promise<any[]> bridge timing: awaiting, a rejection, an already-settled source, two waiters\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return {\n    list: [1, 2],\n    /** @returns {Promise<any>} */\n    bad: async () => {\n      throw new Error(\"nope\");\n    },\n  };\n}\nconst src = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaAll() {\n  return Promise.all(src.list);\n}\n/** @returns {Promise<any[]>} */\nfunction viaBad() {\n  return src.bad();\n}\nfunction chain() {\n  Promise.resolve()\n    .then(() => log.push(\"t1\"))\n    .then(() => log.push(\"t2\"))\n    .then(() => log.push(\"t3\"))\n    .then(() => log.push(\"t4\"));\n}\nasync function waitAll() {\n  const r = await viaAll();\n  log.push(`aw${r.length}`);\n}\nasync function waitBad() {\n  try {\n    await viaBad();\n  } catch (e) {\n    log.push(`rej:${e.message}`);\n  }\n}\nasync function main() {\n  void waitAll();\n  void waitBad();\n  chain();\n  const p = viaAll();\n  p.then(() => log.push(\"w1\"));\n  p.then(() => log.push(\"w2\"));\n  for (let i = 0; i < 8; i++) await null;\n  console.log(log.join(\",\"));\n  log.splice(0, log.length);\n  const q = viaAll();\n  for (let i = 0; i < 4; i++) await null;\n  q.then(() => log.push(\"late\"));\n  chain();\n  for (let i = 0; i < 8; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("rej:nope,t1,aw2,t2,w1,w2,t3,t4\nlate,t1,t2,t3,t4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-04 a pending source held on both sides, the island reaction attached first: Node's order", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-04", "// @dynamic\n// one source promise held on both sides of a Promise<any[]> bridge\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return {\n    /** @returns {Promise<any>} */\n    arr: async () => {\n      await null;\n      return [1, 2];\n    },\n    ip: null,\n  };\n}\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() {\n  return box.ip;\n}\nasync function main() {\n  box.ip = box.arr();\n  const p = viaBox();\n  box.ip.then(() => log.push(\"island\"));\n  p.then(() => log.push(\"static\"));\n  for (let i = 0; i < 4; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("island,static\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-09 a pending source held on both sides, the static waiter attached first: Node's order", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-09", "// @dynamic\n// one source promise held on both sides, the static waiter attached FIRST\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return {\n    /** @returns {Promise<any>} */\n    arr: async () => {\n      await null;\n      return [1, 2];\n    },\n    ip: null,\n  };\n}\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() {\n  return box.ip;\n}\nasync function main() {\n  box.ip = box.arr();\n  const p = viaBox();\n  p.then(() => log.push(\"static\"));\n  box.ip.then(() => log.push(\"island\"));\n  for (let i = 0; i < 4; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("static,island\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-10 a pending source held on both sides, the static waiter attached before an island await: Node's order", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-10", "// @dynamic\n// one source promise held on both sides, the static waiter attached before an island await\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return {\n    /** @returns {Promise<any>} */\n    arr: async () => {\n      await null;\n      return [1, 2];\n    },\n    ip: null,\n  };\n}\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() {\n  return box.ip;\n}\nasync function islandWait() {\n  await box.ip;\n  log.push(\"island\");\n}\nasync function main() {\n  box.ip = box.arr();\n  const p = viaBox();\n  p.then(() => log.push(\"static\"));\n  void islandWait();\n  for (let i = 0; i < 4; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("static,island\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-05 a bridge over an ALREADY-SETTLED source: a later waiter runs after a microtask queued before it", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-05", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => [1, 2], ip: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\nfunction qm() { log.push(\"qm\"); }\nasync function main() {\n  box.ip = box.arr();\n  await null; await null; await null;\n  const p = viaBox();\n  Promise.resolve().then(qm);\n  p.then(() => { log.push(\"static\"); });\n  for (let i = 0; i < 6; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("qm,static\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-06 a bridge over an already-settled source, awaited against a competing chain", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-06", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => [1, 2], ip: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\nasync function main() {\n  box.ip = box.arr();\n  await null; await null; await null;\n  const p = viaBox();\n  Promise.resolve().then(() => { log.push(\"t1\"); }).then(() => { log.push(\"t2\"); });\n  const r = await p;\n  log.push(\"aw\" + r.length);\n  await null; await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("t1,aw2,t2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-07 a non-promise island array through a Promise<any[]> slot, and a late waiter on a settled bridge", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-07", "// @dynamic\n// a non-promise island array through a Promise<any[]> slot: settled at once, awaited after a queued microtask\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return { list: [1, 2] };\n}\nconst src = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nasync function viaList() {\n  return src.list;\n}\n/** @returns {Promise<any[]>} */\nfunction viaAll() {\n  return Promise.all(src.list);\n}\nasync function main() {\n  const p = viaList();\n  queueMicrotask(() => log.push(\"qm\"));\n  const r = await p;\n  log.push(`aw${r.length}`);\n  await null;\n  const q = viaAll();\n  for (let i = 0; i < 3; i++) await null;\n  queueMicrotask(() => log.push(\"qm2\"));\n  q.then(() => log.push(\"late\"));\n  for (let i = 0; i < 3; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("qm,aw2,qm2,late\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-08 a source pending at the bridge that settles before the static side attaches", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-08", "// @dynamic\n// a source pending at the bridge that settles before the static side attaches, with a microtask queued between\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return { res: null, ip: null };\n}\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() {\n  return box.ip;\n}\nasync function main() {\n  box.ip = new Promise((r) => {\n    box.res = r;\n  });\n  const p = viaBox();\n  box.res([1]);\n  queueMicrotask(() => log.push(\"qm\"));\n  p.then(() => log.push(\"static\"));\n  for (let i = 0; i < 4; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("qm,static\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-ASYNC-01 an async function returning an island promise into Promise<any[]> adopts it", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-ASYNC-01", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => [1, 2] }; }\nconst src = mk();\n/** @returns {Promise<any[]>} */\nasync function via() { return src.arr(); }\nasync function main() {\n  const r = await via();\n  console.log(r.length);\n}\nvoid main();", "js");
  expect(stdout).toBe("2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-ASYNC-02 an async function returning island Promise.all (inferred Promise<any[]>) adopts it", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-ASYNC-02", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return { list: [1, 2] }; }\nconst src = mk();\nasync function via() { return Promise.all(src.list); }\nasync function main() {\n  const r = await via();\n  console.log(r.length);\n}\nvoid main();", "js");
  expect(stdout).toBe("2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-CYCLE-01 a source resolved with its own bridge is Node's chaining-cycle TypeError, on both sides", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-CYCLE-01", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => { await null; return [1, 2]; },\n  /** @returns {Promise<any>} */\n  bad: async () => { await null; throw new Error(\"nope\"); },\n  ip: null, q: null, res: null, rej: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\n/** @returns {Promise<any[]>} */\nfunction viaQ() { return box.q; }\nasync function main() {\n  box.ip = new Promise((r) => { box.res = r; });\n  const p = viaBox();\n  box.res(p);\n  box.ip.catch((e) => log.push(\"i \" + e.message));\n  p.catch(() => log.push(\"s\"));\n  for (let i = 0; i < 6; i++) await null;\n  console.log(log.join(\",\") + \"|\");\n}\nvoid main();", "js");
  expect(stdout).toBe("i Chaining cycle detected for promise #<Promise>,s|\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-UNH-01 a rejected source the island handles, bridged but never awaited: no unhandled report", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-UNH-01", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => { await null; return [1, 2]; },\n  /** @returns {Promise<any>} */\n  bad: async () => { await null; throw new Error(\"nope\"); },\n  ip: null, q: null, res: null, rej: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\n/** @returns {Promise<any[]>} */\nfunction viaQ() { return box.q; }\nasync function main() {\n  box.ip = box.bad();\n  const p = viaBox();\n  box.ip.catch((e) => log.push(\"caught \" + e.message));\n  for (let i = 0; i < 4; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("caught nope\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-11 two bridges of one source: Node's order", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-11", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => { await null; return [1, 2]; },\n  /** @returns {Promise<any>} */\n  bad: async () => { await null; throw new Error(\"nope\"); },\n  ip: null, q: null, res: null, rej: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\n/** @returns {Promise<any[]>} */\nfunction viaQ() { return box.q; }\nasync function main() {\n  box.ip = box.arr();\n  const p1 = viaBox();\n  p1.then(() => log.push(\"A\"));\n  box.ip.then(() => log.push(\"B\"));\n  const p2 = viaBox();\n  p2.then(() => log.push(\"C\"));\n  p1.then(() => log.push(\"D\"));\n  Promise.resolve().then(() => log.push(\"t1\")).then(() => log.push(\"t2\")).then(() => log.push(\"t3\")).then(() => log.push(\"t4\"));\n  for (let i = 0; i < 8; i++) await null;\n  const a = await p1, b = await p2;\n  console.log(log.join(\",\"), a === b);\n}\nvoid main();", "js");
  expect(stdout).toBe("t1,A,B,C,D,t2,t3,t4 true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-12 a bridge of a bridge: Node's order", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-12", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => { await null; return [1, 2]; },\n  /** @returns {Promise<any>} */\n  bad: async () => { await null; throw new Error(\"nope\"); },\n  ip: null, q: null, res: null, rej: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\n/** @returns {Promise<any[]>} */\nfunction viaQ() { return box.q; }\nasync function main() {\n  box.ip = box.arr();\n  const p1 = viaBox();\n  box.q = p1;\n  const p2 = viaQ();\n  p2.then(() => log.push(\"p2a\"));\n  box.ip.then(() => log.push(\"src\"));\n  p1.then(() => log.push(\"p1\"));\n  box.q.then(() => log.push(\"q\"));\n  p2.then(() => log.push(\"p2b\"));\n  queueMicrotask(() => log.push(\"qm\"));\n  for (let i = 0; i < 8; i++) await null;\n  const a = await p1, b = await p2;\n  console.log(log.join(\",\"), a === b, box.q === p1);\n}\nvoid main();", "js");
  expect(stdout).toBe("qm,p2a,src,p1,q,p2b true true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-HELD-01 an any[] held by a static promise crosses back into the island as the same array", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-HELD-01", "// @dynamic\n// an any[] held by a static promise crosses back into the island as the same array\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return { list: [1, 2], p: null };\n}\nconst box = mk();\n/** @param {any[]} xs @returns {Promise<any[]>} */\nasync function hold(xs) {\n  return xs;\n}\nasync function main() {\n  box.p = hold(box.list);\n  const v = await box.p;\n  v.push(3);\n  console.log(`${v === box.list} ${box.list.length} ${(await box.p) === v}`);\n}\nvoid main();", "js");
  expect(stdout).toBe("true 3 true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-FLAT-01 Array.prototype.flat on an island array: depths, Infinity, coercion, non-array elements, a string receiver", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-FLAT-01", "// @dynamic\n// Array.prototype.flat on an island array: depths, Infinity, coercion, non-array elements\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return [[1, [2, [3, [4]]]], \"ab\", { length: 1, k: \"x\" }, 5];\n}\nconst a = mk();\nconsole.log(JSON.stringify(a.flat()));\nconsole.log(JSON.stringify(a.flat(0)));\nconsole.log(JSON.stringify(a.flat(2)));\nconsole.log(JSON.stringify(a.flat(Infinity)));\nconsole.log(JSON.stringify(a.flat(\"2\")));\nconsole.log(JSON.stringify(a.flat(-1)), JSON.stringify(a.flat(NaN)), JSON.stringify(a.flat(1.9)));\nconsole.log(JSON.stringify(a.flat(null)), JSON.stringify(a.flat(undefined)), JSON.stringify(a.flat(true)));\n/** @returns {any} */\nfunction none() {\n  return [];\n}\nconst empty = none();\nconsole.log(JSON.stringify(empty.flat()), a.flat() !== a, a.flat(0) !== a);\nconst inner = mk();\n/** @param {any} x @returns {any} */\nfunction wrap(x) {\n  return [x, x];\n}\nconst f = wrap(inner).flat(0);\nconsole.log(`${f[0] === inner} ${f.length}`);\n/** @returns {any} */\nfunction str() {\n  return \"abc\";\n}\nconst s = str();\ntry {\n  console.log(`${s.flat()}`);\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}", "js");
  expect(stdout).toBe("[1,[2,[3,[4]]],\"ab\",{\"length\":1,\"k\":\"x\"},5]\n[[1,[2,[3,[4]]]],\"ab\",{\"length\":1,\"k\":\"x\"},5]\n[1,2,[3,[4]],\"ab\",{\"length\":1,\"k\":\"x\"},5]\n[1,2,3,4,\"ab\",{\"length\":1,\"k\":\"x\"},5]\n[1,2,[3,[4]],\"ab\",{\"length\":1,\"k\":\"x\"},5]\n[[1,[2,[3,[4]]]],\"ab\",{\"length\":1,\"k\":\"x\"},5] [[1,[2,[3,[4]]]],\"ab\",{\"length\":1,\"k\":\"x\"},5] [1,[2,[3,[4]]],\"ab\",{\"length\":1,\"k\":\"x\"},5]\n[[1,[2,[3,[4]]]],\"ab\",{\"length\":1,\"k\":\"x\"},5] [1,[2,[3,[4]]],\"ab\",{\"length\":1,\"k\":\"x\"},5] [1,[2,[3,[4]]],\"ab\",{\"length\":1,\"k\":\"x\"},5]\n[] true true\ntrue 2\nTypeError: s.flat is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-FLAT-02 flat over a cyclic array: Infinity throws V8's RangeError catchably, a finite depth terminates", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-FLAT-02", "// @dynamic\n// flat over a cyclic array: Infinity overflows (RangeError, catchable), a finite depth terminates\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return [1];\n}\nconst c = mk();\nc.push(c);\ntry {\n  c.flat(Infinity);\n  console.log(\"no throw\");\n} catch (e) {\n  console.log(`${e.name}: ${e.message}`);\n}\nconsole.log(`${c.flat(3).length}`);\nlet deep = mk();\nfor (let i = 0; i < 1000; i++) deep = [deep];\nconsole.log(`${deep.flat(Infinity).length} ${JSON.stringify(deep.flat(Infinity))}`);", "js");
  expect(stdout).toBe("RangeError: Maximum call stack size exceeded\n5\n1 [1]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-01 a Promise<any[]> bridge: an array fulfilment crosses by reference, any other value rejects by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-BRIDGE-01", "// @dynamic\n// a Promise<any[]> bridge: an array fulfillment by reference, a non-array fulfillment rejects\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return {\n    /** @returns {Promise<any>} */\n    arr: async () => [1, 2],\n    /** @returns {Promise<any>} */\n    obj: async () => ({ a: 1 }),\n    /** @returns {Promise<any>} */\n    num: async () => 5,\n    /** @returns {Promise<any>} */\n    bad: async () => {\n      throw new Error(\"nope\");\n    },\n  };\n}\nconst src = mk();\n/** @returns {Promise<any[]>} */\nfunction viaArr() {\n  return src.arr();\n}\n/** @returns {Promise<any[]>} */\nfunction viaObj() {\n  return src.obj();\n}\n/** @returns {Promise<any[]>} */\nfunction viaNum() {\n  return src.num();\n}\n/** @returns {Promise<any[]>} */\nfunction viaBad() {\n  return src.bad();\n}\nasync function main() {\n  const a = await viaArr();\n  console.log(`${a.length} ${a[0]}`);\n  for (const f of [viaObj, viaNum, viaBad]) {\n    try {\n      const r = await f();\n      console.log(`ok ${typeof r}`);\n    } catch (e) {\n      console.log(`${e.name}: ${e.message}`);\n    }\n  }\n}\nvoid main();", "js");
  // Node: 2 1 / ok object / ok number / Error: nope — there is no boundary
  // in Node, so the value arrives as it is. The bridge's TypeError is the
  // jsExit array arm's own (SEMANTICS.md S044's unit-P amendment).
  expect(stdout).toBe("2 1\nTypeError: expected an array, got object\nTypeError: expected an array, got number\nError: nope\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-ASYNC-03 async returns into Promise<any[]> adopt with Node's turns; a non-array adopted value rejects by name", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-ASYNC-03", "// @dynamic\n// an async function returning an island promise into Promise<any[]>: adopted, Node's turns\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return {\n    list: [1, 2],\n    /** @returns {Promise<any>} */\n    arr: async () => [3, 4, 5],\n    /** @returns {Promise<any>} */\n    obj: async () => ({ a: 1 }),\n  };\n}\nconst src = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nasync function viaArr() {\n  return src.arr();\n}\nasync function viaAll() {\n  return Promise.all(src.list);\n}\n/** @returns {Promise<any[]>} */\nasync function viaObj() {\n  return src.obj();\n}\nasync function main() {\n  const a = viaArr();\n  const b = viaAll();\n  Promise.resolve()\n    .then(() => log.push(\"t1\"))\n    .then(() => log.push(\"t2\"))\n    .then(() => log.push(\"t3\"))\n    .then(() => log.push(\"t4\"));\n  a.then((r) => log.push(`a${r.length}`));\n  b.then((r) => log.push(`b${r.length}`));\n  for (let i = 0; i < 6; i++) await null;\n  console.log(log.join(\",\"));\n  try {\n    const o = await viaObj();\n    console.log(`ok ${typeof o}`);\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}\nvoid main();", "js");
  // Node: t1,t2,a3,b2,t3,t4 / ok object (S044's unit-P amendment).
  expect(stdout).toBe("t1,t2,a3,b2,t3,t4\nTypeError: expected an array, got object\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-PARAM-01 an island array reaching an any[] | undefined parameter is the caller's array", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-PARAM-01", "// @dynamic\n// an island array reaching an `any[] | undefined` parameter is the caller's array (pushes are shared)\nfunction take(xs: any[] | undefined): number {\n  if (xs === undefined) return -1;\n  xs.push(1);\n  return xs.length;\n}\nfunction back(xs: any[] = []): any[] {\n  xs.push(\"added\");\n  return xs;\n}\nconst o: any = { a: [1, \"x\"], b: undefined, c: 5, p: [{ n: 1 }] };\nconst arr = o.a;\nconsole.log(`${take(o.a)} ${arr.length} ${take(o.b)}`);\ntry {\n  console.log(`${take(o.c)}`);\n} catch (e) {\n  console.log(`${(e as Error).name}: ${(e as Error).message}`);\n}\nconst r = back(o.p);\nconsole.log(`${o.p.length} ${r.length} ${r[0] === o.p[0]} ${r === o.p}`);", "ts");
  // Node: 3 3 -1 / TypeError: xs.push is not a function / 2 2 true true.
  // The non-array argument fails at the boundary with the checked exit's
  // text (S044's unit-P amendment). `r === o.p` is false here: the front
  // end's own any[]-to-any conversion (%jsin.arr) builds a fresh island
  // array on every lane — a front-end matter, not this unit's.
  expect(stdout).toBe("3 3 -1\nTypeError: expected array | undefined at $, got number\n2 2 true false\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-IDENT-01 bridged promises: a crossed static promise and a bridge of a bridge answer themselves; two bridges of one island source are two promises", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-IDENT-01", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => { await null; return [1, 2]; },\n  /** @returns {Promise<any>} */\n  bad: async () => { await null; throw new Error(\"nope\"); },\n  ip: null, q: null, res: null, rej: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\n/** @returns {Promise<any[]>} */\nfunction viaQ() { return box.q; }\n/** @param {any[]} xs @returns {Promise<any[]>} */\nasync function hold(xs) { await null; return xs; }\nasync function main() {\n  box.ip = box.arr();\n  const p1 = viaBox(), p2 = viaBox();\n  box.q = p1;\n  const p3 = viaQ();\n  const h = hold([1]);\n  box.ip = h;\n  const p4 = viaBox();\n  console.log(`${p1 === p2} ${p3 === p1} ${p4 === h}`);\n  p4.then(() => log.push(\"p4\"));\n  h.then(() => log.push(\"h\"));\n  box.ip.then(() => log.push(\"isl\"));\n  for (let i = 0; i < 6; i++) await null;\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  // Node: true true true / p4,h,isl (S044's unit-P amendment).
  expect(stdout).toBe("false true true\np4,h,isl\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-BRIDGE-13 a non-array fulfilment rejects the bridge: its derived promise's rejection is reported, exit 1", async () => {
  // Node: s1,i1,ok, exit 0 (S044's unit-P amendment).
  const { stdout, stderr } = await runRowTrap("P-BRIDGE-13", "// @dynamic\n'use strict';\n/** @returns {any} */\nfunction mk() { return {\n  /** @returns {Promise<any>} */\n  arr: async () => { await null; return [1, 2]; },\n  /** @returns {Promise<any>} */\n  bad: async () => { await null; throw new Error(\"nope\"); },\n  ip: null, q: null, res: null, rej: null }; }\nconst box = mk();\n/** @type {string[]} */\nconst log = [];\n/** @returns {Promise<any[]>} */\nfunction viaBox() { return box.ip; }\n/** @returns {Promise<any[]>} */\nfunction viaQ() { return box.q; }\nasync function main() {\n  box.ip = new Promise((r) => { box.res = r; });\n  const p = viaBox();\n  p.then(() => log.push(\"s1\"));\n  box.res(5);\n  box.ip.then(() => log.push(\"i1\"));\n  try { await p; log.push(\"ok\"); } catch (e) { log.push(\"rej\"); }\n  console.log(log.join(\",\"));\n}\nvoid main();", "js");
  expect(stdout).toBe("i1,rej\n");
  expect(stderr).toContain("Unhandled promise rejection: TypeError: expected an array, got number");
});

test("P-LIFT-01 the front end's any[] lift copies through a typed local and an any assignment (board #259)", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-LIFT-01", "// @dynamic\nfunction back(xs: any[] = []): any[] {\n  xs.push(\"added\");\n  return xs;\n}\nconst o: any = { p: [{ n: 1 }] };\nconst r = back(o.p);\nconst anyR: any = r;\nanyR.push(9);\nconsole.log(`${o.p.length} ${r.length} ${anyR.length} ${anyR === o.p}`);\no.p.push(7);\nconsole.log(`${r.length} ${anyR.length}`);", "ts");
  // Node: 3 3 3 true / 4 4 (S014's unit-P amendment).
  expect(stdout).toBe("2 2 3 false\n3 3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-LIFT-02 a static any[] written into an island object is copied per write (board #259)", async () => {
  const { stdout, stderr, exitCode } = await runRow("P-LIFT-02", "// @dynamic\nconst a: any[] = [1, 2];\nconst b: any[] = a;\nconst c: any[] = a.concat();\nconst h: any = {};\nh.a = a; h.b = b; h.c = c;\nconsole.log(`${h.a === h.b} ${h.a === h.c}`);\nh.a.push(3);\nconsole.log(`${a.length} ${b.length} ${c.length}`);\na.push(4);\nconsole.log(`${h.a.length} ${h.b.length}`);", "ts");
  // Node: true false / 3 3 2 / 4 4 (S014's unit-P amendment).
  expect(stdout).toBe("false false\n2 2 2\n3 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-THEN-01 island Promise.all over a thenable object element meets settle's named refusal", async () => {
  // Node: before / after 2 (it calls the object's then).
  const { stdout, stderr } = await runRowTrap("P-THEN-01", "// @dynamic\n// island Promise.all over a thenable object element: settle's named refusal\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return { then: (/** @type {any} */ r) => r(1) };\n}\nasync function main() {\n  console.log(\"before\");\n  /** @type {any} */\n  const xs = [mk(), 2];\n  const r = await Promise.all(xs);\n  console.log(`after ${r.length}`);\n}\nvoid main();", "js");
  expect(stdout).toBe("before\n");
  expect(stderr).toContain("resolving a promise with a non-promise thenable is not supported yet");
});

test("P-FLAT-03 flat over a growth write's padding sees undefined where Node has holes (S016)", async () => {
  // Node: 2 [0,9] — the padded slots are holes there, skipped by flat.
  const { stdout, stderr, exitCode } = await runRow("P-FLAT-03", "// @dynamic\n// flat over a growth write's padding (S016: undefined where Node has holes)\n'use strict';\n/** @returns {any} */\nfunction grow() {\n  return [[0]];\n}\nconst g = grow();\ng[3] = [9];\nconsole.log(`${g.flat().length} ${JSON.stringify(g.flat())}`);", "js");
  expect(stdout).toBe("4 [0,null,null,9]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-FLAT-04 flat stops at 1000 nested levels with V8's RangeError, catchably, even deep in a call chain (S043 unit-P amendment)", async () => {
  // Node: 999 1 / 1001 1 / 999 1 / 4999 1 — V8 overflows past ~8900 levels.
  const { stdout, stderr, exitCode } = await runRow("P-FLAT-04", "// @dynamic\n// flat at the nesting cap: 999 levels flatten, 1001 throw (Node flattens both), also from deep in a call chain\n'use strict';\n/** @returns {any} */\nfunction mk() {\n  return [1];\n}\n/** @param {number} n @returns {any} */\nfunction nest(n) {\n  let d = mk();\n  for (let i = 0; i < n; i++) d = [d];\n  return d;\n}\n/** @param {number} n */\nfunction probe(n) {\n  try {\n    console.log(`${n} ${nest(n).flat(Infinity).length}`);\n  } catch (e) {\n    console.log(`${n} ${e.name}: ${e.message}`);\n  }\n}\n/** @param {number} k @param {number} n */\nfunction recurse(k, n) {\n  if (k === 0) probe(n);\n  else recurse(k - 1, n);\n}\nprobe(999);\nprobe(1001);\nrecurse(3000, 999);\nrecurse(3000, 4999);", "js");
  expect(stdout).toBe("999 1\n1001 RangeError: Maximum call stack size exceeded\n999 1\n4999 RangeError: Maximum call stack size exceeded\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-FLAT-05 flat with an object depth refuses by name, catchably (ToPrimitive is not run)", async () => {
  // Node: [1,2,[3]] / [1,2,[3]] / [[1,[2,[3]]]] / [1,[2,[3]]].
  const { stdout, stderr, exitCode } = await runRow("P-FLAT-05", "// @dynamic\n// flat with an object depth (ToPrimitive runs valueOf/toString in Node) refuses by name\n'use strict';\n/** @returns {any} */\nfunction v() {\n  return { valueOf() { return 2; } };\n}\n/** @returns {any} */\nfunction s() {\n  return { toString() { return \"2\"; } };\n}\n/** @returns {any} */\nfunction mk() {\n  return [[1, [2, [3]]]];\n}\nfor (const d of [v(), s(), {}, [1]]) {\n  try {\n    console.log(JSON.stringify(mk().flat(d)));\n  } catch (e) {\n    console.log(`${e.name}: ${e.message}`);\n  }\n}", "js");
  const fence = "TypeError: mk(...).flat: non-primitive depth arguments on a dynamic receiver are not supported yet\n";
  expect(stdout).toBe(fence.repeat(4));
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P-CORPUS-2633 the island promise crossing program", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("P-CORPUS-2633", "2633-island-promise-crossing.js");
  expect(stdout).toBe("typeof object\nheld 1 x\nlen 2 first builtin second p1\nall 2 a b\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
