/* Board #75 (listeners()/rawListeners() narrower-arity adapters, stage D
 * P3) — durable builder-level pins. Same discipline as wasm-stream-
 * finished.test.ts / wasm-assert.test.ts: compile REAL TypeScript through
 * the actual frontend+backend, run it through the real abi.ts host, assert
 * against a live-Node-measured shape. Every value asserted here was
 * measured directly against Node v24.18.1 before being written down (own
 * probes, re-run at this file's own time) — not transcribed from 1677's
 * own corpus output or the design note.
 *
 * These pins exist because 1677 alone under-covers the machinery: it
 * never explicitly CALLS a k=0 adapter (bare only fires through `.emit()`,
 * which bypasses adapters entirely — an emitted branch with no execution
 * pin is exactly the class of bug increment-21 stage B's N2 finding was),
 * and it never exercises identity comparisons against a DIFFERENT
 * original or across two independent snapshots of the SAME original. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-listener-adapters-"));
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

test("a k=0 adapter (bare, 0-ary) called EXPLICITLY through the snapshot ignores the extra args, like JS — the one call path 1677 itself never exercises (bare only fires via emit there)", async () => {
  const path = await build("k0-explicit-call.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "const seen: string[] = [];",
    "function full(a: string, b: number): void { seen.push(`full ${a} ${b}`); }",
    "function bare(): void { seen.push('bare'); }",
    "ee.on('evt', full);",
    "ee.on('evt', bare);",
    "(ee.listeners('evt')[1] as (a: string, b: number) => void)('x', 1);",
    "console.log(seen.join('|'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["bare", ""].join("\n"));
  expect(stderr).toBe("");
});

test("unwrap helper: adapter === its own original is true, exact-match === original is true, adapter === a DIFFERENT original is false, two independent snapshots of the SAME original are === to each other", async () => {
  // Every `.listeners()` call stays INLINE (1677's own header: binding
  // the result to a `const` adopts the checker's widened `Function[]`
  // view, which has no honest element signature) — an early draft of
  // this pin bound to `const snap1`/`snap2` and hit exactly that
  // pre-existing gap (a frontend refusal, nothing to do with board #75)
  // before being fixed to match 1677's established pattern.
  const path = await build("unwrap-four-cases.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "function full(a: string, b: number): void {}",
    "function bare(): void {}",
    "function other(): void {}",
    "ee.on('evt', full);",
    "ee.on('evt', bare);",
    "console.log(ee.listeners('evt')[1] === bare);",
    "console.log(ee.listeners('evt')[0] === full);",
    "console.log(ee.listeners('evt')[1] === other);",
    "console.log(ee.listeners('evt')[1] === ee.listeners('evt')[1]);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["true", "true", "false", "true", ""].join("\n"));
  expect(stderr).toBe("");
});

test("removeListener sibling (on(original) -> removeListener(adapter-of-it)): the incoming argument is itself a snapshot adapter, unwraps to match the stored real original", async () => {
  const path = await build("remove-via-adapter.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "function full(a: string, b: number): void {}",
    "function bare(): void {}",
    "ee.on('narrow', full);",
    "ee.on('narrow', bare);",
    "ee.removeListener('narrow', ee.listeners('narrow')[1] as (a: string, b: number) => void);",
    "console.log(ee.listeners('narrow').length);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["1", ""].join("\n"));
  expect(stderr).toBe("");
});

test("listenerCount(name, fn) sibling: an adapter-wrapped incoming argument still counts the real original", async () => {
  // Node measured directly: listenerCount("narrow", <adapter of bare>) is
  // 1 (matches bare), mirroring removeListener's own unwrap need.
  const path = await build("count-via-adapter.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "function full(a: string, b: number): void {}",
    "function bare(): void {}",
    "ee.on('narrow', full);",
    "ee.on('narrow', bare);",
    "console.log(ee.listenerCount('narrow', ee.listeners('narrow')[1] as (a: string, b: number) => void));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["1", ""].join("\n"));
  expect(stderr).toBe("");
});

test("rawListeners() rides the identical adapter machinery (S052: no separate identity from listeners())", async () => {
  const path = await build("raw-listeners-adapter.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "function full(a: string, b: number): void {}",
    "function bare(): void {}",
    "ee.on('evt', full);",
    "ee.on('evt', bare);",
    "console.log(ee.rawListeners('evt')[1] === bare);",
    "console.log(ee.rawListeners('evt').length);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["true", "2", ""].join("\n"));
  expect(stderr).toBe("");
});

/* ── the gate's second-round ruling: the UNIVERSAL unwrap ──────────────
 * (option 1 over per-call-site-type — plan.txt's own mechanism-question
 * section has the full reasoning). These pins exist specifically for
 * properties a per-type unwrap could NOT have proven: that one shared
 * function correctly distinguishes markers of genuinely different wasm
 * types in the same module, and that its deferred finalization produces
 * valid wasm even for the zero-adapters-minted edge. */

test("two DISTINCT tuple shapes' adapters both unwrap through the ONE universal function to the same original", async () => {
  // `bare` gets adapted TWICE, under two structurally different marker
  // types (wide's (string,number)=>void vs narrow's (string)=>void) —
  // both must recognize it via the SAME unwrap function and agree.
  const path = await build("two-shapes-one-unwrap.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "function bare(): void {}",
    "function full2(a: string, b: number): void {}",
    "function full1(a: string): void {}",
    "ee.on('wide', full2);",
    "ee.on('wide', bare);",
    "ee.on('narrow', full1);",
    "ee.on('narrow', bare);",
    "console.log(ee.listeners('wide')[1] === bare);",
    "console.log(ee.listeners('narrow')[1] === bare);",
    "console.log(ee.listeners('wide')[1] === ee.listeners('narrow')[1]);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["true", "true", "true", ""].join("\n"));
  expect(stderr).toBe("");
});

test("zero-bases edge, execution-pinned: a module with .off()/.listenerCount(fn) but NO listeners()/rawListeners() call site anywhere still finalizes a valid (identity) universal unwrap", async () => {
  // Never calls .listeners()/.rawListeners() at all — universalUnwrapFn
  // is referenced (by removeLast, through .off()) but universalUnwrapBases
  // stays EMPTY. Board #20's own class (declared-but-unfinalized = invalid
  // wasm) wearing the deferred-setBody costume: this must instantiate AND
  // actually remove by identity, not merely pass WebAssembly.validate
  // (validate alone would not have caught an unfinalized/wrong-arity body
  // that still happens to be well-formed bytes).
  const path = await build("zero-bases-edge.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "function full(a: string, b: number): void {}",
    "ee.on('evt', full);",
    "ee.off('evt', full);",
    "console.log(ee.listenerCount('evt'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["0", ""].join("\n"));
  expect(stderr).toBe("");
});

test("removeListener sibling, the OTHER direction (on-adapter -> removeListener(original)): the STORED entry is itself a snapshot adapter, the incoming original unwraps to match it — the gate's own motivating counterexample for the universal unwrap, now closed", async () => {
  const path = await build("remove-stored-adapter.ts", [
    "import { EventEmitter } from 'node:events';",
    "const ee = new EventEmitter();",
    "function full(a: string, b: number): void {}",
    "function bare(): void {}",
    "ee.on('evt', full);",
    "ee.on('evt', bare);",
    "ee.on('other', ee.listeners('evt')[1] as (a: string, b: number) => void);",
    "ee.removeListener('other', bare);",
    "console.log(ee.listeners('other').length);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["0", ""].join("\n"));
  expect(stderr).toBe("");
});
