/* increment 23 P3, rider 3 — timers.queueMicrotask + Dyn. Compile REAL
 * JS/TS through the actual frontend+backend, run it through the real
 * abi.ts host (wasm-host.ts). Every literal is measured directly
 * against node v24.18.1 (own probes, this pass). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-queuemicrotask-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, lines: string[]) {
  const entry = join(scratch, name);
  await writeFile(entry, `${lines.join("\n")}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

async function exportsOf(binaryPath: string): Promise<string[]> {
  const mod = await WebAssembly.compile(readFileSync(binaryPath));
  return WebAssembly.Module.exports(mod)
    .map((e) => e.name)
    .sort();
}

test("queueMicrotask — 2282's own corpus literal, byte-exact vs Node (microtask/promise-then interleaving, microtask drains before the timer)", async () => {
  const path = await build("literal.cjs", [
    "'use strict';",
    "const assert = require('assert');",
    "assert.strictEqual(typeof queueMicrotask, 'function');",
    "[undefined, null, 0, 'x = 5'].forEach((t) => {",
    "  assert.throws(() => { queueMicrotask(t); }, { code: 'ERR_INVALID_ARG_TYPE' });",
    "});",
    "{",
    "  let called = false;",
    "  queueMicrotask(() => { called = true; });",
    "  assert.strictEqual(called, false);",
    "}",
    "{",
    "  const q = [];",
    "  Promise.resolve().then(() => q.push('a'));",
    "  queueMicrotask(() => q.push('b'));",
    "  Promise.resolve().then(() => q.push('c'));",
    "  queueMicrotask(() => { console.log(JSON.stringify(q)); });",
    "}",
    "setTimeout(() => console.log('timer-after-micro'), 0);",
    "queueMicrotask(() => console.log('micro-1'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(['["a","b","c"]', "micro-1", "timer-after-micro", ""].join("\n"));
  expect(stderr).toBe("");
});

test("queueMicrotask — the axis, direction A, CORRECTED (found running this pin's first draft, not assumed from the brief's own framing): a queueMicrotask-ONLY module (no setTimeout/setInterval, no other async) does NOT export _tick — `_start`'s own one-shot `%w.async.drain()` call is sufficient (drain's own loop re-checks the queue head after every callback, so a microtask enqueuing ANOTHER microtask is caught by the SAME call, confirmed with a nested-queueMicrotask construction, byte-exact vs Node — no repeated pumping is needed for a program with no time-based work at all). `_tick`'s own export gate is tied to `this.timersField` (real timer machinery), not `this.promsField` (the microtask queue) — census-visible on the OTHER axis instead: the callback demonstrably runs (without the drain wired at all, it would silently never fire).", async () => {
  const path = await build("axis-a.ts", [
    "queueMicrotask(() => console.log('ran'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["ran", ""].join("\n"));
  expect(stderr).toBe("");
  expect(await exportsOf(path)).toEqual(["_start", "memory"]);
});

test("queueMicrotask — a NESTED microtask (one queueMicrotask enqueuing another) drains fully via the SAME one-shot call, byte-exact vs Node, confirming _tick's absence above is not a truncation bug", async () => {
  const path = await build("nested.cjs", [
    "queueMicrotask(() => {",
    "  console.log('outer');",
    "  queueMicrotask(() => { console.log('nested'); });",
    "});",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["outer", "nested", ""].join("\n"));
  expect(stderr).toBe("");
});

test("queueMicrotask — the axis, direction B (export-list ONLY — the axis's own instrument, a stdout-only pin cannot see this direction): an ordinary synchronous program with NO async/Promise/queueMicrotask at all still has NO _tick", async () => {
  const path = await build("axis-b.ts", ["console.log('plain');"]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["plain", ""].join("\n"));
  expect(await exportsOf(path)).toEqual(["_start", "memory"]);
});

test("queueMicrotaskDyn — the FULL argTypeThrow message, byte-exact vs Node for all three non-function shapes (2282 itself only asserts .code — this pin is the one that would catch a corrupted message with a preserved code)", async () => {
  // A plain, untyped .cjs iteration (2282's own shape: `[t1,t2,...].
  // forEach((t) => queueMicrotask(t))`) is what actually infers `t` as
  // `dyn`, reaching `timers.queueMicrotaskDyn` — a TS `unknown` value
  // explicitly cast (`cb as () => void`) resolves the STATIC closure
  // type at the cast site instead and routes through the scalar
  // `timers.queueMicrotask` form, reaching S009's generic dynCheck
  // message, NOT this one (found by running the first draft of this
  // pin, not assumed).
  const path = await build("argtype.cjs", [
    "[undefined, 0, 'x = 5'].forEach((t) => {",
    "  try { queueMicrotask(t); console.log('no-throw'); } catch (e) { console.log(e.message); }",
    "});",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      'The "callback" argument must be of type function. Received undefined',
      'The "callback" argument must be of type function. Received type number (0)',
      "The \"callback\" argument must be of type function. Received type string ('x = 5')",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("queueMicrotask — throw-inside-microtask: exit code + stderr vs Node, a REAL uncaught exception (drain's own invariant), NOT S058's uncatchable trap — this is its own force-emit/runWasm pin (2282 itself expects exit 0)", async () => {
  const path = await build("throws.cjs", [
    "'use strict';",
    "console.log('before');",
    "queueMicrotask(() => { throw new RangeError('boom'); });",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["before", ""].join("\n"));
  expect(stderr).toBe("Uncaught RangeError: boom\n");
});
