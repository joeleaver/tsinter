/* GH #91 — `k in obj` with a RUNTIME key on a checked-dynamic (untyped
 * JavaScript) receiver: the `dyn.hasKey` libCall on the WasmGC tier
 * (emitter.ts, dyn.ts hasKey). Rows for what the corpus program
 * (tests/corpus/2845-in-dynamic-runtime-key.mjs, which every lane runs)
 * cannot pin because the c and llvm lanes answer differently there:
 *   - a primitive receiver throws Node's TypeError (scr_dyn_has_key
 *     answers false and never throws);
 *   - the KEY is evaluated before the receiver, JS's order (the native
 *     lanes evaluate the receiver first);
 *   - a function owns `name` and `length`;
 *   - a Uint8Array answers its canonical indices, and any other key —
 *     a prototype name the tree does not model — is a named refusal.
 * Every expected line is an inlined literal of a Node v24.18.1 run of the
 * same source, except the refusal row, which states Node's answer beside
 * it. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-in-dynkey-"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(id: string, src: string, toTrap = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = join(scratch, `${id}.mjs`);
  await writeFile(entry, src);
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await (toTrap ? runWasmToTrap : runWasm)(res.binaryPath);
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
}

const HAS = "function has(k, o) { return k in o; }\n";

test("I01 a primitive receiver throws Node's TypeError, the receiver rendered as String() does", async () => {
  const src =
    HAS +
    "function tryHas(k, o) {\n  try { return String(has(k, o)); } catch (e) { return e.name + \": \" + e.message; }\n}\n" +
    'console.log(tryHas("a", "abc"));\nconsole.log(tryHas("length", "abc"));\nconsole.log(tryHas("x", 42));\n' +
    'console.log(tryHas("x", 1.5));\nconsole.log(tryHas("x", true));\nconsole.log(tryHas("x", undefined));\nconsole.log(tryHas("x", null));\n' +
    'console.log(tryHas(7, { 7: 0 }));\n';
  const r = await run("I01", src);
  expect(r.stdout).toBe(
    "TypeError: Cannot use 'in' operator to search for 'a' in abc\n" +
      "TypeError: Cannot use 'in' operator to search for 'length' in abc\n" +
      "TypeError: Cannot use 'in' operator to search for 'x' in 42\n" +
      "TypeError: Cannot use 'in' operator to search for 'x' in 1.5\n" +
      "TypeError: Cannot use 'in' operator to search for 'x' in true\n" +
      "TypeError: Cannot use 'in' operator to search for 'x' in undefined\n" +
      "TypeError: Cannot use 'in' operator to search for 'x' in null\n" +
      "true\n",
  );
  expect(r.exitCode).toBe(0);
});

test("I02 an uncaught primitive-receiver TypeError ends the run (S007's report, then the trap)", async () => {
  const r = await run("I02", HAS + 'console.log("before");\nconsole.log(has("k", "str"));\nconsole.log("after");\n', true);
  expect(r.stdout).toBe("before\n");
  expect(r.stderr).toBe("Uncaught TypeError: Cannot use 'in' operator to search for 'k' in str\n");
});

test("I03 the key is evaluated before the receiver", async () => {
  const src =
    'const log = [];\nfunction k() { log.push("key"); return "a"; }\nfunction obj() { log.push("obj"); return { a: 1 }; }\n' +
    'function both(f, g) { return f() in g(); }\nconsole.log(both(k, obj), log.join(">"));\n';
  const r = await run("I03", src);
  expect(r.stdout).toBe("true key>obj\n");
});

test("I04 a function owns name and length", async () => {
  const src = HAS + "function named(a, b) { return a + b; }\nconsole.log(has(\"name\", named), has(\"length\", named), has(\"zzz\", named));\n";
  const r = await run("I04", src);
  expect(r.stdout).toBe("true true false\n");
});

test("I05 a Uint8Array answers its indices; another key is a named refusal", async () => {
  const src =
    HAS +
    'const u8 = new Uint8Array([1, 2, 3]);\nconsole.log(has("1", u8), has(5, u8), has(0, u8));\n' +
    'try { console.log(has("length", u8)); } catch (e) { console.log("caught", e.message); }\n';
  const r = await run("I05", src, true);
  // Node prints "true false true\ntrue\n": `length` is the inherited accessor,
  // which the tree does not model, so the tier refuses by name — a fence
  // that ends the program, the program's catch never sees it (GH #86,
  // SEMANTICS.md S122).
  expect(r.stdout).toBe("true false true\n");
  expect(r.stderr).toBe(
    "tsinter: unsupported: 'in' with a non-index key on a Uint8Array or Buffer held in a dynamic value is not supported yet [SC1090]\n",
  );
});

test("I06 the corpus program", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/2845-in-dynamic-runtime-key.mjs", import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, "I06.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`I06 refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  expect(String(r.stdout)).toBe(
    "true false true true\ntrue true true false true\ntrue true true false true false false false\nfalse false false\n" +
      "true,false,false\nfalse\ntrue\nalpha true\nbeta true\ngamma false\ntrue true false\nfound 3\n",
  );
});

// GH #86 review: the answers the tree cannot give are fences, never false.
const HOLE_FENCE =
  "tsinter: unsupported: 'in' or Object.hasOwn over an array index that may be a hole (a write past an array's end leaves undefined where Node keeps a hole — SEMANTICS.md S119) [SC1090]\n";

test("I07 an elided element crossing into a dynamic value may be a hole: `in` over it fences (Node: false)", async () => {
  const src = HAS + 'const arr = [1, , 3];\nconsole.log(has(0, arr), has("length", arr));\ntry { console.log(has(1, arr)); } catch (e) { console.log("caught"); }\n';
  const r = await run("I07", src, true);
  expect(r.stdout).toBe("true true\n");
  expect(r.stderr).toBe(HOLE_FENCE);
});

test("I08 a dynamic array padded past its end (S016) answers the written index, and fences over a padded one (Node: false)", async () => {
  const src = HAS + 'const a = JSON.parse("[1]");\nconsole.log(has(0, a), has(1, a));\na[3] = 9;\nconsole.log(a.length, has(3, a));\nconsole.log(has(1, a));\n';
  const r = await run("I08", src, true);
  expect(r.stdout).toBe("true false\n4 true\n");
  expect(r.stderr).toBe(HOLE_FENCE);
});

test("I09 an unpadded dynamic array answers every index as Node does", async () => {
  const src = HAS + 'const a = JSON.parse("[1,2,3]");\nconsole.log(has(0, a), has(2, a), has(3, a), has("length", a));\n';
  const r = await run("I09", src);
  expect(r.stdout).toBe("true true false true\n");
});

const PROTO_FENCE =
  "tsinter: unsupported: 'prototype' in or Object.hasOwn on a function held in a dynamic value (whether it is a constructor is not recorded) is not supported yet [SC1090]\n";

test("I10 `prototype` on a function: a box built from a known function answers; one read out of a record fences (Node: false for the method)", async () => {
  const src = HAS + 'function fn(a, b) {}\nconst arrow = (a) => a;\nconsole.log(has("name", fn), has("length", fn), has("x", fn));\nconsole.log(has("prototype", fn), has("prototype", arrow));\nconst m = { meth() {} };\nconsole.log(has("prototype", m.meth));\n';
  const r = await run("I10", src, true);
  expect(r.stdout).toBe("true true false\ntrue false\n");
  expect(r.stderr).toBe(PROTO_FENCE);
});

test("I11 the compile-time-key fold answers the same: a padded index fences, a function's name/length answer, `prototype` answers for a known function", async () => {
  const pad = 'const a = JSON.parse("[1]");\na[3] = 9;\nconsole.log("3" in a, "0" in a);\nconsole.log("1" in a);\n';
  const r = await run("I11a", pad, true);
  expect(r.stdout).toBe("true true\n");
  expect(r.stderr).toBe(HOLE_FENCE);
  const fn = 'function probe(o) {\n  console.log("name" in o, "length" in o, "y" in o);\n  console.log("prototype" in o);\n}\nprobe(function fn(a) {});\nprobe((a) => a);\n';
  const r2 = await run("I11b", fn);
  expect(r2.stdout).toBe("true true false\ntrue\ntrue true false\nfalse\n");
});
