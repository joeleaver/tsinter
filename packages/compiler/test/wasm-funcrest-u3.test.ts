/* INC-27 unit U3 — G, rest-typed function values: one previously-refused
 * wasm backend key, type:func-rest, lifted for the VALUE path (a rest-typed
 * closure crossing a dyn boundary — setTimeout callbacks, EventEmitter
 * listeners, apply-forwarding, etc.) alongside the pre-existing DIRECT-call
 * path. closSigFor gained an opt-in parameter (mapType, dynFnBox, dynFnThunk
 * pass it; every other caller keeps the unconditional default-refuse);
 * mapTypeSoft's func arm builds its own padded closPairFor pair directly
 * (never calls closSigFor); a distinct key, type:func-rest-jsval, covers
 * restAbi "jsval" (still refused, never lifted); the process.onExit arm
 * gained an explicit guard converting a live illegal-cast trap into a named
 * compile-time refusal.
 *
 * Every expected line below is an INLINED literal: for most rows, a real
 * `node --experimental-transform-types` / plain `node` run of the SAME
 * snippet; for the S081/LOUD rows and EV-1's own `fresh` line, this tier's
 * REGISTERED divergent answer (SEMANTICS.md's S081 entry) or NAMED trap
 * text, not Node's — a committed test reads nothing outside this
 * repository at test time. Rows are grouped by class: FORWARD, ALIAS, S081
 * (twins), AGREEING (twins), TYPEKEY, LOUD, B-i, B-ii, NOT-LIFTED, LIFT-EE,
 * ABI (lockstep), SURPLUS, FRESH, ARITY, FORWARD-apply, MUSTSUCCEED,
 * DEFPROPS, THEN-void, RETURN-flow, A03 (EVERYTHING-VALID / FEWER),
 * REGRESSION. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-funcrest-u3-"));
  // A .cjs/.js row needs a dir whose package.json says {"type":"commonjs"}
  // — without it a bare .js row's module mode is ambiguous.
  await writeFile(join(scratch, "package.json"), '{"type":"commonjs"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runRow(name: string, src: string, ext: "ts" | "cjs" | "js" | "mjs" = "cjs"): Promise<string> {
  const entry = join(scratch, `${name}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  return stdout;
}

async function runRowExit(name: string, src: string, ext: "ts" | "cjs" | "js" | "mjs" = "cjs"): Promise<{ stdout: string; exitCode: number }> {
  const entry = join(scratch, `${name}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  const { stdout, exitCode } = await runWasm(res.binaryPath);
  return { stdout, exitCode };
}

async function runRowRefuse(name: string, src: string, dynamic: boolean, ext: "ts" | "cjs" | "js" | "mjs" = "cjs"): Promise<string[]> {
  const entry = join(scratch, `${name}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (res.ok) throw new Error(`${name} [${dynamic ? "dyn" : "plain"}] compiled but was expected to refuse`);
  return [...new Set(res.diagnostics.map((d) => `${d.code}:${d.message}`))].sort();
}

/** A row expecting an UNCAUGHT trap (runWasmToTrap reports exitCode 0 on
 * every trap — a trap row NEVER asserts exitCode; it asserts the exact
 * stdout before the throw and the stderr line). */
async function runRowTrap(name: string, src: string, ext: "ts" | "cjs" | "js" | "mjs" = "cjs"): Promise<{ stdout: string; stderr: string }> {
  const entry = join(scratch, `${name}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  return runWasmToTrap(res.binaryPath);
}

async function runCorpusRow(name: string, relPath: string): Promise<{ stdout: string; exitCode: number }> {
  const entry = fileURLToPath(new URL(`../../../tests/corpus/${relPath}`, import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  return runWasm(res.binaryPath);
}

async function refuseCorpusRow(name: string, relPath: string): Promise<string[]> {
  const entry = fileURLToPath(new URL(`../../../tests/corpus/${relPath}`, import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (res.ok) throw new Error(`${name} compiled but was expected to refuse`);
  return [...new Set(res.diagnostics.map((d) => `${d.code}:${d.message}`))].sort();
}

// ============================================================
// FORWARD — the six corpus programs the wasm tier now claims (944 -> 950).
// Each asserts its FULL stdout, inlined, and its exit code.
// ============================================================

test("FORWARD-1 1700-mustcall-common: full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("fwd1", "1700-mustcall-common/main.cjs");
  expect(stdout).toBe(
    "onTwice 1 2\nfirst 1\nonTwice 5 undefined\nshort 5\nname onTwice length 2\ncounted ran\ncounted ran\n" +
      "counted ran\nok value 42\nsucceeded value\ncaught: boom\ncalled with arguments: 'x', 7\nmain done\n",
  );
  expect(exitCode).toBe(0);
});

test("FORWARD-2 1701-mustcall-exit-report: full stdout and exit code 1", async () => {
  const { stdout, exitCode } = await runCorpusRow("fwd2", "1701-mustcall-exit-report/main.cjs");
  expect(stdout).toBe(
    "end of main\nMismatched onNever function calls. Expected exactly 1, actual 0.\n" +
      "Mismatched often function calls. Expected at least 3, actual 1.\n" +
      "Mismatched noop function calls. Expected exactly 2, actual 1.\n",
  );
  expect(exitCode).toBe(1);
});

test("FORWARD-3 1703-arguments-rest-props: full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("fwd3", "1703-arguments-rest-props.cjs");
  expect(stdout).toBe(
    "n=0 first=undefined\nn=1 first=a\nn=3 first=1\nx then 0: \nx then 1: 1\nx then 3: 1,2,3\n" +
      "true false 3 6 5\ntrue true\nname renamed extra 41\nstill callable 2\ndone\n",
  );
  expect(exitCode).toBe(0);
});

test("FORWARD-4 1826-settimeout-arguments-callback: full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("fwd4", "1826-settimeout-arguments-callback.js");
  expect(stdout).toBe("scheduled\nticked 0\n");
  expect(exitCode).toBe(0);
});

test("FORWARD-5 2163-js-selfref-const: full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("fwd5", "2163-js-selfref-const.cjs");
  expect(stdout).toBe("tick 3\ntick 2\ntick 1\nseen a\n");
  expect(exitCode).toBe(0);
});

test("FORWARD-6 2164-js-then-dyn-handler: full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("fwd6", "2164-js-then-dyn-handler.cjs");
  expect(stdout).toBe("sync tail\nvalue 7\nvoid-settle undefined undefined\ncaught Error: nope\n");
  expect(exitCode).toBe(0);
});

test("FORWARD-7 an EventEmitter listener with no declared params, forwarding a surplus argument", async () => {
  // Strict mode, three emitted arguments, the listener declares none —
  // Node prints the listener's own count and its second argument.
  const out = await runRow(
    "fwd7",
    "'use strict';\n" +
      "const EventEmitter = require('events');\n" +
      "const e = new EventEmitter();\n" +
      "e.on('x', function () { console.log('n', arguments.length, arguments[1]); });\n" +
      "e.emit('x', 1, 2, 3);",
  );
  expect(out.trimEnd()).toBe("n 3 2");
});

// ============================================================
// ALIAS — the rest array is a FRESH copy, never the incoming args vector
// aliased.
// ============================================================

test("ALIAS-al01 apply/arguments write does not alias the wrapper's own vector", async () => {
  const out = await runRow(
    "al01",
    "'use strict';\n" +
      "function wrap(fn) {\n" +
      "  return function () {\n" +
      "    const n = fn.apply(this, arguments);\n" +
      "    return n + ':' + arguments[0] + ':' + arguments.length;\n" +
      "  };\n" +
      "}\n" +
      "const w = wrap(function () { arguments[0] = 'changed'; return arguments.length; });\n" +
      "console.log(w('orig', 2));",
  );
  expect(out.trimEnd()).toBe("2:orig:2");
});

test("ALIAS-al02 apply-forwarded rest push does not leak into the wrapper's own vector", async () => {
  const out = await runRow(
    "al02",
    "'use strict';\n" +
      "function wrap(fn) {\n" +
      "  return function (...args) {\n" +
      "    const n = fn.apply(this, args);\n" +
      "    return n + ':' + args.length + ':' + args.join(',');\n" +
      "  };\n" +
      "}\n" +
      "const w = wrap(function (...xs) { xs.push('extra'); xs[0] = 'z'; return xs.length; });\n" +
      "console.log(w('a', 'b'));",
  );
  expect(out.trimEnd()).toBe("3:2:a,b");
});

// ============================================================
// S081 — the twelve `arguments`-inside-a-variadic-function observables
// (S081, SEMANTICS.md), each a direct-call twin (pre-existing) and a
// VALUE twin (setTimeout-boxed, lifted by this unit). Every twin runs a
// STRICT .cjs except S081-9, which runs a SLOPPY .js (`.callee`'s own
// divergence is per-mode).
// ============================================================

test("S081-1-inspect direct: util.inspect(arguments) prints the plain array form", async () => {
  const out = await runRow(
    "s081_1d",
    "'use strict';\nfunction f() {\n  console.log(require('util').inspect(arguments));\n}\nf(1, 'two');",
  );
  expect(out.trimEnd()).toBe("[ 1, 'two' ]");
});
test("S081-1-inspect value: same, through setTimeout", async () => {
  const out = await runRow(
    "s081_1v",
    "'use strict';\nsetTimeout(function () {\n  console.log(require('util').inspect(arguments));\n}, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("[ 1, 'two' ]");
});

test("S081-2-json direct: JSON.stringify(arguments) — array form", async () => {
  const out = await runRow("s081_2d", "'use strict';\nfunction f() {\n  console.log(JSON.stringify(arguments));\n}\nf(1, 'two');");
  expect(out.trimEnd()).toBe('[1,"two"]');
});
test("S081-2-json value: same, through setTimeout", async () => {
  const out = await runRow(
    "s081_2v",
    "'use strict';\nsetTimeout(function () {\n  console.log(JSON.stringify(arguments));\n}, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe('[1,"two"]');
});

test("S081-3-isarray direct: Array.isArray(arguments) — true, incl. zero-arg", async () => {
  const out = await runRow(
    "s081_3d",
    "'use strict';\nfunction f() {\n  console.log(Array.isArray(arguments));\n}\nf();",
  );
  expect(out.trimEnd()).toBe("true");
});
test("S081-3-isarray direct one-arg twin", async () => {
  const out = await runRow(
    "s081_3d2",
    "'use strict';\nfunction f() {\n  console.log(Array.isArray(arguments));\n}\nf(1);",
  );
  expect(out.trimEnd()).toBe("true");
});
test("S081-3-isarray value: same, through setTimeout, incl. zero-arg", async () => {
  const out = await runRow(
    "s081_3v",
    "'use strict';\nsetTimeout(function () {\n  console.log(Array.isArray(arguments));\n}, 0);",
  );
  expect(out.trimEnd()).toBe("true");
});
test("S081-3-isarray value one-arg twin", async () => {
  const out = await runRow(
    "s081_3v2",
    "'use strict';\nsetTimeout(function () {\n  console.log(Array.isArray(arguments));\n}, 0, 1);",
  );
  expect(out.trimEnd()).toBe("true");
});

test("S081-5-string direct: String(arguments) — join form", async () => {
  const out = await runRow("s081_5d", "'use strict';\nfunction f() {\n  console.log(String(arguments));\n}\nf(1, 'two');");
  expect(out.trimEnd()).toBe("1,two");
});
test("S081-5-string value: same, through setTimeout", async () => {
  const out = await runRow("s081_5v", "'use strict';\nsetTimeout(function () {\n  console.log(String(arguments));\n}, 0, 1, 'two');");
  expect(out.trimEnd()).toBe("1,two");
});

test("S081-6-template direct: `${arguments}` — join form", async () => {
  const out = await runRow("s081_6d", "'use strict';\nfunction f() {\n  console.log(`[${arguments}]`);\n}\nf(1, 'two');");
  expect(out.trimEnd()).toBe("[1,two]");
});
test("S081-6-template value: same, through setTimeout", async () => {
  const out = await runRow("s081_6v", "'use strict';\nsetTimeout(function () {\n  console.log(`[${arguments}]`);\n}, 0, 1, 'two');");
  expect(out.trimEnd()).toBe("[1,two]");
});

test("S081-7-strcat direct: 'x' + arguments — join form", async () => {
  const out = await runRow("s081_7d", "'use strict';\nfunction f() {\n  console.log('x' + arguments);\n}\nf(1, 'two');");
  expect(out.trimEnd()).toBe("x1,two");
});
test("S081-7-strcat value: same, through setTimeout", async () => {
  const out = await runRow("s081_7v", "'use strict';\nsetTimeout(function () {\n  console.log('x' + arguments);\n}, 0, 1, 'two');");
  expect(out.trimEnd()).toBe("x1,two");
});

test("S081-8-callee-strict direct: strict mode answers undefined (Node throws)", async () => {
  const out = await runRow(
    "s081_8d",
    "'use strict';\nfunction f() { try { console.log(typeof arguments.callee); } catch (e) { console.log('threw', e.constructor.name); } } f(1, 'two');",
  );
  expect(out.trimEnd()).toBe("undefined");
});
test("S081-8-callee-strict value: same, through setTimeout", async () => {
  const out = await runRow(
    "s081_8v",
    "'use strict';\nsetTimeout(function () { try { console.log(typeof arguments.callee); } catch (e) { console.log('threw', e.constructor.name); } }, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("undefined");
});

test("S081-9-callee-sloppy direct: this tier answers undefined uniformly (Node answers 'function')", async () => {
  const out = await runRow("s081_9d", "function f() { console.log(typeof arguments.callee); } f(1, 'two');", "js");
  expect(out.trimEnd()).toBe("undefined");
});
test("S081-9-callee-sloppy value: same, through setTimeout", async () => {
  const out = await runRow("s081_9v", "setTimeout(function () { console.log(typeof arguments.callee); }, 0, 1, 'two');", "js");
  expect(out.trimEnd()).toBe("undefined");
});

test("S081-10-indexwrite direct: an index write past the end GROWS .length", async () => {
  const out = await runRow(
    "s081_10d",
    "'use strict';\nfunction f() { arguments[0] = 9; arguments[5] = 7; console.log(arguments.length, arguments[0], arguments[5]); } f(1, 'two');",
  );
  expect(out.trimEnd()).toBe("6 9 7");
});
test("S081-10-indexwrite value: same, through setTimeout", async () => {
  const out = await runRow(
    "s081_10v",
    "'use strict';\nsetTimeout(function () { arguments[0] = 9; arguments[5] = 7; console.log(arguments.length, arguments[0], arguments[5]); }, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("6 9 7");
});

test("S081-11-concat direct: [].concat(arguments).length spreads the array's own elements", async () => {
  const out = await runRow("s081_11d", "'use strict';\nfunction f() { console.log([].concat(arguments).length); } f(1, 'two');");
  expect(out.trimEnd()).toBe("2");
});
test("S081-11-concat value: same, through setTimeout", async () => {
  const out = await runRow("s081_11v", "'use strict';\nsetTimeout(function () { console.log([].concat(arguments).length); }, 0, 1, 'two');");
  expect(out.trimEnd()).toBe("2");
});

// S081-12: writing arguments.length throws a CATCHABLE TypeError on this
// tier ("Cannot create property 'length' on array"); Node's Arguments
// object accepts the write with no throw.
test("S081-12-lengthwrite direct: arguments.length = 5 throws a CATCHABLE TypeError (Node accepts it silently)", async () => {
  const out = await runRow(
    "s081_12d",
    "'use strict';\nfunction f() {\n  try { arguments.length = 5; console.log('no throw'); }\n  catch (e) { console.log('caught', e instanceof TypeError, e.message); }\n}\nf(1, 'two');",
  );
  expect(out.trimEnd()).toBe("caught true Cannot create property 'length' on array");
});
test("S081-12-lengthwrite value: same, through setTimeout", async () => {
  const out = await runRow(
    "s081_12v",
    "'use strict';\nsetTimeout(function () {\n  try { arguments.length = 5; console.log('no throw'); }\n  catch (e) { console.log('caught', e instanceof TypeError, e.message); }\n}, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("caught true Cannot create property 'length' on array");
});

// ============================================================
// AGREEING — content-independent / order-independent observables that
// agree between Node's Arguments object and this tier's plain array,
// each a direct AND a value twin, plus an Object.keys/JSON-entries pair
// (o10).
// ============================================================

test("AGR-1-forof direct: for-of visits in order", async () => {
  const out = await runRow(
    "agr1d",
    "'use strict';\nfunction f() {\n  const out = []; for (const x of arguments) out.push(x); console.log(out.join(\"|\"));\n}\nf(1, 'two');",
  );
  expect(out.trimEnd()).toBe("1|two");
});
test("AGR-1-forof value: for-of visits in order", async () => {
  const out = await runRow(
    "agr1v",
    "'use strict';\nsetTimeout(function () { const out = []; for (const x of arguments) out.push(x); console.log(out.join('|')); }, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("1|two");
});

test("AGR-2-methods direct: typeof push/join/forEach — undefined (not own array-method properties)", async () => {
  const out = await runRow(
    "agr2d",
    "'use strict';\nfunction f() {\n  console.log(typeof arguments.push, typeof arguments.join, typeof arguments.forEach);\n}\nf(1, 'two');",
  );
  expect(out.trimEnd()).toBe("undefined undefined undefined");
});
test("AGR-2-methods value: typeof push/join/forEach", async () => {
  const out = await runRow(
    "agr2v",
    "'use strict';\nsetTimeout(function () { console.log(typeof arguments.push, typeof arguments.join, typeof arguments.forEach); }, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("undefined undefined undefined");
});

test("AGR-3-membership direct: 0 in / 'length' in / hasOwn", async () => {
  const out = await runRow(
    "agr3d",
    "'use strict';\nfunction f() {\n  console.log(0 in arguments, 'length' in arguments, Object.hasOwn(arguments, 'length'));\n}\nf(1, 'two');",
  );
  expect(out.trimEnd()).toBe("true true true");
});
test("AGR-3-membership value: 0 in / 'length' in / hasOwn", async () => {
  const out = await runRow(
    "agr3v",
    "'use strict';\nsetTimeout(function () { console.log(0 in arguments, 'length' in arguments, Object.hasOwn(arguments, 'length')); }, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("true true true");
});

test("AGR-4-typeof direct: typeof / ==null / !!", async () => {
  const out = await runRow(
    "agr4d",
    "'use strict';\nfunction f() {\n  console.log(typeof arguments, arguments == null, !!arguments);\n}\nf(1, 'two');",
  );
  expect(out.trimEnd()).toBe("object false true");
});
test("AGR-4-typeof value: typeof / ==null / !!", async () => {
  const out = await runRow(
    "agr4v",
    "'use strict';\nsetTimeout(function () { console.log(typeof arguments, arguments == null, !!arguments); }, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe("object false true");
});

test("AGR-o10 direct: Object.keys(arguments) and JSON.stringify(Object.entries(arguments))", async () => {
  const out = await runRow(
    "agro10d",
    "'use strict';\nfunction f() {\n  console.log(Object.keys(arguments).join(','), JSON.stringify(Object.entries(arguments)));\n}\nf(1, 'two');",
  );
  expect(out.trimEnd()).toBe('0,1 [["0",1],["1","two"]]');
});
test("AGR-o10 value: same, through setTimeout", async () => {
  const out = await runRow(
    "agro10v",
    "'use strict';\nsetTimeout(function () {\n  console.log(Object.keys(arguments).join(','), JSON.stringify(Object.entries(arguments)));\n}, 0, 1, 'two');",
  );
  expect(out.trimEnd()).toBe('0,1 [["0",1],["1","two"]]');
});

// ============================================================
// TYPEKEY — a rest func and a non-rest func with the same leading params,
// boxed and called in ONE program: distinct signatures, both right.
// ============================================================

test("TYPEKEY a rest func and a non-rest func sharing a leading param type build distinct signatures", async () => {
  const out = await runRow(
    "typekey",
    "'use strict';\n" +
      "function withRest(x, ...r) { console.log(x + ':' + r.length); }\n" +
      "function withoutRest(x) { console.log(x + ':fixed'); }\n" +
      "setTimeout(withRest, 0, 1, 2, 3);\n" +
      "setTimeout(withoutRest, 0, 1);",
  );
  expect(out.trimEnd()).toBe("1:2\n1:fixed");
});

// ============================================================
// LOUD — constructs this tier refuses by name, NOT related to
// type:func-rest itself: reached only once the rest closure's own value
// crossing compiles (both twins per construct). Each is a deferred
// RUNTIME diagnostic (an uncaught, named error before a trap), not a
// compile-time refusal — measured through the module's own stderr.
// ============================================================

test("LOUD-1-tostringcall direct: Object.prototype.toString.call(arguments) traps with a named diagnostic", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud1d",
    "'use strict';\nfunction f() {\n  console.log(Object.prototype.toString.call(arguments));\n}\nf(1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("Function.prototype.call on a compiled function value");
});
test("LOUD-1-tostringcall value: same, through setTimeout", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud1v",
    "'use strict';\nsetTimeout(function () {\n  console.log(Object.prototype.toString.call(arguments));\n}, 0, 1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("Function.prototype.call on a compiled function value");
});

test("LOUD-2-instanceof direct: arguments instanceof Array traps with a named diagnostic", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud2d",
    "'use strict';\nfunction f() {\n  console.log(arguments instanceof Array);\n}\nf(1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("'instanceof' right-hand sides other than classes declared in the program");
});
test("LOUD-2-instanceof value: same, through setTimeout", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud2v",
    "'use strict';\nsetTimeout(function () {\n  console.log(arguments instanceof Array);\n}, 0, 1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("'instanceof' right-hand sides other than classes declared in the program");
});

test("LOUD-3-spread direct: spreading arguments into an unknown[] literal traps with a named diagnostic", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud3d",
    "'use strict';\nfunction f() {\n  const a = [...arguments];\n  console.log(a.length);\n}\nf(1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("spread elements in a dynamic (unknown[]) array literal");
});
test("LOUD-3-spread value: same, through setTimeout", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud3v",
    "'use strict';\nsetTimeout(function () {\n  const a = [...arguments];\n  console.log(a.length);\n}, 0, 1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("spread elements in a dynamic (unknown[]) array literal");
});

test("LOUD-4-symiter direct: arguments[Symbol.iterator] traps with a named diagnostic", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud4d",
    "'use strict';\nfunction f() {\n  console.log(typeof arguments[Symbol.iterator]);\n}\nf(1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("symbol-keyed property access outside class fields");
});
test("LOUD-4-symiter value: same, through setTimeout", async () => {
  const { stdout, stderr } = await runRowTrap(
    "loud4v",
    "'use strict';\nsetTimeout(function () {\n  console.log(typeof arguments[Symbol.iterator]);\n}, 0, 1, 'two');",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("symbol-keyed property access outside class fields");
});

// ============================================================
// B-i — front-end refusals (SC1090, both build modes): `arguments` in a
// function that ALSO declares a parameter is refused before the wasm
// backend is ever reached. Asserts the FULL diagnostic set, both modes,
// with a compiling control twin.
// ============================================================

const B_I_1_SRC =
  "'use strict';\n" +
  "function f(a) { return `len=${arguments.length} a=${a} a0=${arguments[0]} a2=${arguments[2]}`; }\n" +
  "const g = f;\n" +
  "console.log(g(1, 2, 3));\n" +
  "console.log(g());\n" +
  "function h(x, ...r) { return `x=${x} r=${r.length} ${r.join('|')}`; }\n" +
  "const k = h;\n" +
  "console.log(k('p', 'q', 's'));\n" +
  "console.log('len', f.length, h.length, (function () { return arguments.length; }).length);\n" +
  "function idem() { return arguments; }\n" +
  "const idf = idem;\n" +
  "console.log('fresh', idf(1) === idf(1), typeof idf(1), Array.isArray(idf(1)));";
const B_I_2_SRC =
  "function f(a) { arguments[0] = 9; return a; }\n" +
  "const g = f;\n" +
  "console.log('alias', g(1));\n" +
  "function h(a) { a = 5; return arguments[0]; }\n" +
  "const k = h;\n" +
  "console.log('alias2', k(1));";

test("B-i-1 declared param + arguments, plain build: the full diagnostic set", async () => {
  const diags = await runRowRefuse("bi1", B_I_1_SRC, false);
  expect(diags).toEqual([
    "SC1090:'arguments' in functions with declared parameters (use a rest parameter: (...args)) are not supported yet",
  ]);
});
test("B-i-1 declared param + arguments, --dynamic build: the same diagnostic set", async () => {
  const diags = await runRowRefuse("bi1d", B_I_1_SRC, true);
  expect(diags).toEqual([
    "SC1090:'arguments' in functions with declared parameters (use a rest parameter: (...args)) are not supported yet",
  ]);
});
test("B-i-1's own control: a rest-only rewrite (no declared-param + arguments mix) compiles", async () => {
  const out = await runRow(
    "bi1ctrl",
    "'use strict';\nfunction f(a, ...rest) { return `len=${rest.length + 1} a=${a}`; }\nconsole.log(f(1, 2, 3));",
  );
  expect(out.trimEnd()).toBe("len=3 a=1");
});

test("B-i-2 sloppy alias, plain build: the deduped diagnostic set (the SAME message fires at both offending functions)", async () => {
  const diags = await runRowRefuse("bi2", B_I_2_SRC, false, "js");
  expect(diags).toEqual([
    "SC1090:'arguments' in functions with declared parameters (use a rest parameter: (...args)) are not supported yet",
  ]);
});
test("B-i-2 sloppy alias, --dynamic build: the same diagnostic set", async () => {
  const diags = await runRowRefuse("bi2d", B_I_2_SRC, true, "js");
  expect(diags).toEqual([
    "SC1090:'arguments' in functions with declared parameters (use a rest parameter: (...args)) are not supported yet",
  ]);
});

// ============================================================
// NOT-LIFTED — default-refuse callers stay refused: emitNewPromise,
// callValue (a typed .then), the process.onExit guard (now a NAMED
// refusal, not a runtime trap), the restAbi-jsval key, and a spread-
// forwarding program unrelated to type:func-rest entirely.
// ============================================================

test("NL-1 a Promise executor's rest-typed arguments-executor and arrow both stay refused (emitNewPromise, default-refuse)", async () => {
  const diags = await runRowRefuse(
    "nl1",
    "'use strict';\n" +
      "new Promise(function () { arguments[0]('v'); }).then((v) => console.log('p1', v));\n" +
      "new Promise((...a) => a[0]('w')).then((v) => console.log('p2', v));",
    false,
  );
  expect(diags.some((d) => d.includes("type:func-rest") && !d.includes("jsval"))).toBe(true);
});

test("NL-2 a typed .then/.catch/.finally rest callback stays refused (callValue, default-refuse)", async () => {
  const diags = await runRowRefuse(
    "nl2",
    "'use strict';\n" +
      "Promise.resolve(1).then(function () { console.log('then', arguments.length, arguments[0]); });\n" +
      "Promise.reject(new Error('e')).catch(function () { console.log('catch', arguments.length); });\n" +
      "Promise.resolve(2).finally(function () { console.log('fin', arguments.length); });",
    false,
  );
  expect(diags.some((d) => d.includes("type:func-rest") && !d.includes("jsval"))).toBe(true);
});

test("NL-3 process.on('exit') with a rest callback now REFUSES BY NAME at compile time, not a runtime trap", async () => {
  const diags = await runRowRefuse(
    "nl3",
    "'use strict';\nprocess.on('exit', function () { console.log('exit', arguments.length, arguments[0]); });\nconsole.log('main');",
    false,
  );
  expect(diags.some((d) => d.includes("type:func-rest") && !d.includes("jsval"))).toBe(true);
});

test("NL-4 a --dynamic rest forward refuses with the DISTINCT type:func-rest-jsval key, never plain type:func-rest", async () => {
  const diags = await runRowRefuse(
    "nl4",
    "// @dynamic\n'use strict';\nfunction decl(a, b) { return a + b; }\nconst fDecl = (...args) => decl(...args);\nconsole.log(`${fDecl(1, 2)}`);",
    true,
    "js",
  );
  expect(diags.some((d) => d.includes("type:func-rest-jsval"))).toBe(true);
  expect(diags.some((d) => d.includes("type:func-rest") && !d.includes("jsval"))).toBe(false);
});

test("NL-6 2567-rest-spread-forward stays refused by dynCall:spread, unrelated to type:func-rest", async () => {
  const diags = await refuseCorpusRow("nl6", "2567-rest-spread-forward.js");
  expect(diags.some((d) => d.includes("dynCall:spread"))).toBe(true);
});

// B-ii-1: a self-referencing named function expression, declaring ONE
// param plus bare `arguments` — reaches the SAME front-end SC1090 gate
// B-i's rows do (a declared param mixed with bare `arguments`), not a
// type:func-rest site at all. This is a REGRESSION-shaped control: it
// compiles and then traps at run time with a named diagnostic, never a
// silent wrong answer.
test("B-ii-1 a self-referencing named function expression mixing a declared param with arguments traps with the B-i diagnostic", async () => {
  const { stdout, stderr } = await runRowTrap(
    "bii1",
    "'use strict';\nconst f = function g(n) { return n > 0 ? g(n - 1, 'x', 'y') + arguments.length : arguments.length; };\nconsole.log(f(2, 'extra'));",
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("'arguments' in functions with declared parameters");
});

// ============================================================
// LIFT-EE — a rest-typed closure (a `wrap()`-returned function using
// bare `arguments`, no declared params) crossing into dyn via dynFnBox
// and registered as a real EventEmitter listener.
// ============================================================

test("LIFT-EE wrap()-into-EventEmitter.on() matches Node", async () => {
  const out = await runRow(
    "liftee",
    "'use strict';" +
      "const EventEmitter = require('events');" +
      "function wrap(fn) { return function () { return fn.apply(this, arguments); }; }" +
      "const ee = new EventEmitter();" +
      "ee.on('data', wrap(function (chunk) { console.log('got', chunk); }));" +
      "ee.emit('data', 42);",
  );
  expect(out.trimEnd()).toBe("got 42");
});

// ============================================================
// ABI — the lockstep rows: a soft-mapped local capture and a soft-mapped
// closure capture, each exercising mapTypeSoft's own padded closPairFor
// build, contrasted with mapType's hard-mapped build reached by the six/
// LIFT-EE rows above via the SAME shared trailing-slot helper.
// ============================================================

test("ABI-1 arrow rest local, aliased and called twice", async () => {
  const out = await runRow("abi1", "'use strict';\nconst f = (...a) => a.join('-');\nconst g = f;\nconsole.log(g(1, 2, 3), f());");
  expect(out.trimEnd()).toBe("1-2-3");
});

test("ABI-2 captured sloppy-arguments closure, called via a returned arrow", async () => {
  const out = await runRow(
    "abi2",
    "'use strict';\nfunction mk() {\n  const g = function () { return arguments.length; };\n  return () => g(1, 2, 3);\n}\nconsole.log(mk()());",
  );
  expect(out.trimEnd()).toBe("3");
});

// ============================================================
// SURPLUS / INDEX-PAST-END / FRESH / ARITY / FORWARD-apply / MUSTSUCCEED
// / DEFPROPS / THEN-void / RETURN-flow.
// ============================================================

test("SURPLUS-0 zero surplus beyond one leading param", async () => {
  const out = await runRow("surplus0", "'use strict';\nfunction f(x, ...r) { console.log(x, r.length); }\nsetTimeout(f, 0, 1);");
  expect(out.trimEnd()).toBe("1 0");
});
test("SURPLUS-1 one surplus", async () => {
  const out = await runRow("surplus1", "'use strict';\nfunction f(x, ...r) { console.log(x, JSON.stringify(r)); }\nsetTimeout(f, 0, 1, 'a');");
  expect(out.trimEnd()).toBe('1 ["a"]');
});
test("SURPLUS-3 three surplus", async () => {
  const out = await runRow(
    "surplus3",
    "'use strict';\nfunction f(x, ...r) { console.log(x, JSON.stringify(r)); }\nsetTimeout(f, 0, 1, 'a', 'b', 'c');",
  );
  expect(out.trimEnd()).toBe('1 ["a","b","c"]');
});

test("INDEX-PAST-END an index past the rest array's end reads undefined", async () => {
  const out = await runRow("indexpastend", "'use strict';\nfunction f(...r) { console.log(r.length, r[10]); }\nsetTimeout(f, 0, 1, 2);");
  expect(out.trimEnd()).toBe("2 undefined");
});

test("FRESH-1 the SAME boxed closure's rest array is a FRESH object each call", async () => {
  const out = await runRow(
    "fresh1",
    "'use strict';\n" +
      "let stash;\n" +
      "function f(...r) {\n" +
      "  if (stash === undefined) { stash = r; }\n" +
      "  else { console.log(stash === r, JSON.stringify(stash), JSON.stringify(r)); }\n" +
      "}\n" +
      "setTimeout(f, 0, 1); setTimeout(f, 0, 2);",
  );
  expect(out.trimEnd()).toBe("false [1] [2]");
});

test("FRESH-2 a mutation in one call is invisible in the next", async () => {
  const out = await runRow(
    "fresh2",
    "'use strict';\nfunction f(...r) { r.push('mutated'); console.log(r.length); }\nsetTimeout(f, 0, 1); setTimeout(f, 0, 2);",
  );
  expect(out.trimEnd()).toBe("2\n2");
});

test("ARITY-decl fn.length excludes the rest parameter (declaration form)", async () => {
  const out = await runRow("aritydecl", "'use strict';\nfunction f(a, ...r) { return r; }\nsetTimeout(() => console.log(f.length), 0);");
  expect(out.trimEnd()).toBe("1");
});
test("ARITY-arrow fn.length excludes the rest parameter (arrow form)", async () => {
  const out = await runRow("arityarrow", "'use strict';\nconst f = (a, ...r) => r;\nsetTimeout(() => console.log(f.length), 0);");
  expect(out.trimEnd()).toBe("1");
});
test("ARITY-name a boxed rest func's .name (a module-level declaration) is preserved through the box", async () => {
  const out = await runRow(
    "arityname",
    "'use strict';\nfunction f(...r) { return r; }\nsetTimeout(f, 0, 1, 2); setTimeout(() => console.log(f.name), 0);",
  );
  expect(out.trimEnd()).toBe("f");
});

test("FORWARD-apply-0/1/3 a boxed rest func forwards via .apply with 0, 1 and 3 surplus", async () => {
  const out = await runRow(
    "fwdapply",
    "'use strict';\n" +
      "function wrap(fn) {\n" +
      "  return function (...args) { console.log(fn.apply(null, args)); };\n" +
      "}\n" +
      "const fwd0 = wrap(function (...args) { return args.length; });\n" +
      "const fwd1 = wrap(function (...args) { return args.length; });\n" +
      "const fwd3 = wrap(function (...args) { return args.length; });\n" +
      "setTimeout(fwd0, 0);\n" +
      "setTimeout(fwd1, 0, 'a');\n" +
      "setTimeout(fwd3, 0, 'a', 'b', 'c');",
  );
  expect(out.trimEnd()).toBe("0\n1\n3");
});

test("MUSTSUCCEED-err a rest-typed mustSucceed wrapper: success path forwards, error path throws ifError's message", async () => {
  const out = await runRow(
    "mustsucceed",
    "'use strict';\n" +
      "const assert = require('assert');\n" +
      "function mustSucceed(fn) { return function (err, ...rest) { assert.ifError(err); return fn.apply(null, rest); }; }\n" +
      "const cb = mustSucceed(function (...rest) { console.log('ok', JSON.stringify(rest)); });\n" +
      "setTimeout(cb, 0, null, 1, 2);\n" +
      "setTimeout(function () {\n  try { cb(new TypeError('boom')); } catch (e) { console.log(e.message); }\n}, 5);",
  );
  expect(out.trimEnd()).toBe("ok [1,2]\nifError got unwanted exception: boom");
});

test("DEFPROPS-readback Object.defineProperties over a boxed rest func writes name and length, read back", async () => {
  const out = await runRow(
    "defprops",
    "'use strict';\n" +
      "function f(...r) { return r; }\n" +
      "Object.defineProperties(f, { name: { value: 'boxed' }, length: { value: 9 } });\n" +
      "setTimeout(f, 0, 1); setTimeout(() => console.log(f.name, f.length), 0);",
  );
  expect(out.trimEnd()).toBe("boxed 9");
});

// THEN-void: a rest-typed `.then()` HANDLER itself stays refused — the
// same default-refuse callValue site NL-2's `.then` line reaches. Board
// #168 (an unrelated internal-compiler-error on a bare `.then((v) =>
// ...)`, reproduced independent of any rest type) is why a chained
// `.then().then()` shape is avoided here — it is out of this unit's
// scope regardless of this row's own disposition.
test("THEN-void a rest-typed .then handler stays refused (promise callback registration, default-refuse, same site as NL-2)", async () => {
  const diags = await runRowRefuse(
    "thenvoid",
    "'use strict';\nfunction f(...r) { console.log('called', JSON.stringify(r)); }\nPromise.resolve(1).then(function (...r) { f.apply(null, r); });",
    false,
  );
  expect(diags.some((d) => d.includes("type:func-rest") && !d.includes("jsval"))).toBe(true);
});
test("THEN-void's own control: a DYN promise's .then handler (not a typed callValue site) compiles and its void settle prints undefined", async () => {
  // 2164 exercises exactly this shape on its own success path.
  const { stdout } = await runCorpusRow("thenvoidctrl", "2164-js-then-dyn-handler.cjs");
  expect(stdout).toContain("void-settle undefined undefined");
});

test("RETURN-flow a boxed rest callback's return value flows back through the caller", async () => {
  const out = await runRow(
    "returnflow",
    "'use strict';\nfunction f(...r) { return r.length; }\nsetTimeout(() => {\n  const cb = f;\n  const n = cb(1, 2, 3);\n  console.log('returned', n);\n}, 0);",
  );
  expect(out.trimEnd()).toBe("returned 3");
});

// ============================================================
// A03 — FEWER-a03 (a missing leading argument reads undefined) and EV-1
// (EVERYTHING-VALID: every forwarded value on the apply-forwarding path
// is valid, printed in full) both compile and run the SAME source; each
// asserts a DIFFERENT part of its full, hashed output.
// ============================================================

const A03_SRC =
  "'use strict';\n" +
  "function h(x, ...r) { return `x=${x} r=${r.length} ${r.join('|')}`; }\n" +
  "const k = h;\n" +
  "console.log(k('p', 'q', 's'));\n" +
  "console.log(k());\n" +
  "function z() { return `n=${arguments.length} ${arguments[1]}`; }\n" +
  "const zz = z;\n" +
  "console.log(zz(4, 5, 6));\n" +
  "console.log('len', h.length, z.length);\n" +
  "function idem() { return arguments; }\n" +
  "const idf = idem;\n" +
  "console.log('fresh', idf(1) === idf(1), typeof idf(1), Array.isArray(idf(1)));\n" +
  "function wrap(fn) { return function () { return fn.apply(this, arguments); }; }\n" +
  "const w = wrap(function (a, b) { return `${a}+${b}`; });\n" +
  "console.log('fwd', w(), w(1), w(1, 2, 3));";

test("FEWER-a03 a missing leading argument (fewer than declared) reads undefined", async () => {
  const out = await runRow("a03fewer", A03_SRC);
  const lines = out.split("\n");
  expect(lines[1]).toBe("x=undefined r=0 ");
});

test("EV-1 EVERYTHING-VALID: the apply-forwarding path prints every forwarded value, full output", async () => {
  // The `fresh` line's THIRD field is Array.isArray(idf(1)) over a
  // direct-call `arguments` value — Node answers `false` (S081-3's own
  // divergence); this tier answers `true` here too, matching S081-3's
  // registered tier answer, not Node's.
  const out = await runRow("a03ev1", A03_SRC);
  expect(out).toBe(
    "x=p r=2 q|s\nx=undefined r=0 \nn=3 5\nlen 1 0\nfresh false object true\nfwd undefined+undefined 1+undefined 1+2\n",
  );
});

// ============================================================
// REGRESSION — REG-1 (1664): a non-rest dyn function box, unaffected by
// this unit, stays claimed and produces the SAME full output as base.
// ============================================================

test("REG-1 (1664-dyn-fn-boundary) stays claimed, full stdout unaffected by this unit", async () => {
  const { stdout, exitCode } = await runCorpusRow("reg1", "1664-dyn-fn-boundary.cjs");
  expect(stdout).toBe(
    "5\n30\nguarded function\ncaught: not a function\n1,2\n1,undefined\ntruthy\nfunction number string object\n" +
      "[Function: add]\n[Function: named]\n[Function (anonymous)]\n",
  );
  expect(exitCode).toBe(0);
});

// ============================================================
// S082 — process.nextTick vs microtask (queueMicrotask / Promise.then)
// drain ORDER. PRE-EXISTING (not reachable through any U3 arm — no rest
// parameter, no dyn-boundary function value anywhere in these bodies);
// registered here because U3's own post-build sweep found it (board
// #169). BATTERY-EXEMPT BY DESIGN — stated in the reach table, not run
// against the mutation battery: none of the sixteen mutants touches
// nexttick.ts/promises.ts's queue-draining order, only the rest-thunk
// machinery in emitter.ts.
// ============================================================

test("S082-cjs-nt-first: next-tick before microtask, .cjs, DIVERGES from Node (SEMANTICS.md S082)", async () => {
  const src = 'process.nextTick(() => console.log("tick"));\nqueueMicrotask(() => console.log("micro"));\nconsole.log("sync");';
  const out = await runRow("s082cjs", src, "cjs");
  // Node .cjs prints "sync\ntick\nmicro\n" (S082); this tier's registered
  // answer is the ES-module order on every lane, every module mode.
  expect(out).toBe("sync\nmicro\ntick\n");
});

test("S082-cjs-nt-first (reverse registration): queueMicrotask first, .cjs, same tier answer", async () => {
  const src = 'queueMicrotask(() => console.log("micro"));\nprocess.nextTick(() => console.log("tick"));\nconsole.log("sync");';
  const out = await runRow("s082cjsrev", src, "cjs");
  expect(out).toBe("sync\nmicro\ntick\n");
});

test("S082-mjs-agree: next-tick before microtask, .mjs, AGREES with Node (SEMANTICS.md S082)", async () => {
  const src = 'process.nextTick(() => console.log("tick"));\nqueueMicrotask(() => console.log("micro"));\nconsole.log("sync");';
  const out = await runRow("s082mjs", src, "mjs");
  // Node .mjs prints the SAME "sync\nmicro\ntick\n" this tier always
  // prints -- the one module mode where the tier's single ordering rule
  // happens to match Node's.
  expect(out).toBe("sync\nmicro\ntick\n");
});

test("S082-mjs-agree (reverse registration): queueMicrotask first, .mjs, same agreeing answer", async () => {
  const src = 'queueMicrotask(() => console.log("micro"));\nprocess.nextTick(() => console.log("tick"));\nconsole.log("sync");';
  const out = await runRow("s082mjsrev", src, "mjs");
  expect(out).toBe("sync\nmicro\ntick\n");
});

test("S082-nest-agree: a microtask scheduling a next-tick callback agrees with Node on every module mode", async () => {
  const src =
    'queueMicrotask(() => {\n  console.log("micro");\n  process.nextTick(() => console.log("tick-from-micro"));\n});\nconsole.log("sync");';
  const outCjs = await runRow("s082nestacjs", src, "cjs");
  const outMjs = await runRow("s082nestamjs", src, "mjs");
  expect(outCjs).toBe("sync\nmicro\ntick-from-micro\n");
  expect(outMjs).toBe("sync\nmicro\ntick-from-micro\n");
});

test("S082-nest-agree: a next-tick callback scheduling a microtask agrees with Node on every module mode", async () => {
  const src =
    'process.nextTick(() => {\n  console.log("tick");\n  queueMicrotask(() => console.log("micro-from-tick"));\n});\nconsole.log("sync");';
  const outCjs = await runRow("s082nestbcjs", src, "cjs");
  const outMjs = await runRow("s082nestbmjs", src, "mjs");
  expect(outCjs).toBe("sync\ntick\nmicro-from-tick\n");
  expect(outMjs).toBe("sync\ntick\nmicro-from-tick\n");
});

test("S082-three-way: next-tick vs queueMicrotask vs Promise.then, .cjs DIVERGES from Node", async () => {
  const src =
    'Promise.resolve().then(() => console.log("then"));\nqueueMicrotask(() => console.log("micro"));\n' +
    'process.nextTick(() => console.log("tick"));\nconsole.log("sync");';
  const out = await runRow("s082threecjs", src, "cjs");
  // Node .cjs prints "sync\ntick\nthen\nmicro\n"; this tier's registered
  // answer keeps .then/queueMicrotask in their own registration order
  // against each other, both ahead of process.nextTick.
  expect(out).toBe("sync\nthen\nmicro\ntick\n");
});

test("S082-three-way: next-tick vs queueMicrotask vs Promise.then, .mjs AGREES with Node", async () => {
  const src =
    'Promise.resolve().then(() => console.log("then"));\nqueueMicrotask(() => console.log("micro"));\n' +
    'process.nextTick(() => console.log("tick"));\nconsole.log("sync");';
  const out = await runRow("s082threemjs", src, "mjs");
  expect(out).toBe("sync\nthen\nmicro\ntick\n");
});
