/* process.nextTick's own FIFO (nexttick.ts) driven end to end through the
 * real frontend and abi.ts host contract (wasm-timers.test.ts's / wasm-
 * async.test.ts's pattern — compile real TypeScript, compare output byte
 * for byte, because what matters here is ORDER and order is only
 * observable at runtime).
 *
 * Every expectation was measured against a live Node oracle first
 * (node v24.18.1, `--experimental-transform-types`) — nexttick.ts's header
 * has the full truth table and the mechanism that explains it. These are
 * the same shapes, permanently pinned. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-nexttick-"));
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

test("FIFO order, trailing arguments, and self-re-enqueue (2311's shapes)", async () => {
  // process.nextTick(cb, ...args) delivers the trailing arguments at fire
  // time; a callback that re-enqueues itself keeps running until it stops.
  const path = await build("fifo.ts", [
    "function logBoth(a: number, b: string): void {",
    "  console.log('logBoth', a, b);",
    "}",
    "process.nextTick(logBoth, 1, 'two');",
    "process.nextTick(() => console.log('plain tick'));",
    "let n = 0;",
    "const counted = () => {",
    "  n++;",
    "  if (n < 3) process.nextTick(counted);",
    "  else console.log('counted to', n);",
    "};",
    "process.nextTick(counted);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["logBoth 1 two", "plain tick", "counted to 3", ""].join("\n"));
  expect(stderr).toBe("");
});

test("the FIRST checkpoint: an already-pending microtask beats an already-queued nextTick", async () => {
  // Measured against Node (this module is ESM, like every module tsinter
  // compiles): the loader's own await of the module-evaluation promise
  // means our top-level body runs INSIDE an already-active microtask
  // drain, so a `.then()` registered before a `process.nextTick()` in the
  // same synchronous stretch resolves first — ONLY at this first
  // checkpoint (nexttick.ts's probes b/e).
  const path = await build("first-checkpoint.ts", [
    "process.nextTick(() => console.log('tick'));",
    "Promise.resolve().then(() => console.log('micro'));",
    "console.log('sync tail');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["sync tail", "micro", "tick", ""].join("\n"));
  expect(stderr).toBe("");
});

test("the first checkpoint's swap also covers an async resumption, not just plain top-level code", async () => {
  // main()'s FIRST `await null` resumes AT the program's first checkpoint
  // (nothing else is pending before it) — so registrations made inside
  // that resumption are STILL subject to the first-checkpoint swap: the
  // `.then()` job joins the SAME pre-drain the resumption itself is
  // running inside (V8 never yields back to the tick queue mid-drain),
  // while the nextTick waits for that drain to fully finish. A SECOND
  // (or third, ...) `await null` measures the SAME — chained microtask
  // resumptions never exit the pre-drain on their own (only a genuine new
  // macrotask, e.g. a timer, does — the next test's shape). Measured
  // against Node first (this is "probe (a)" in nexttick.ts's header).
  const path = await build("first-via-resume.ts", [
    "async function main(): Promise<void> {",
    "  await null;",
    "  await null; // a SECOND resumption: still the same first-checkpoint drain",
    "  process.nextTick(() => console.log('tick-after-await'));",
    "  Promise.resolve().then(() => console.log('micro-after-await'));",
    "  console.log('sync-after-await');",
    "}",
    "main();",
    "console.log('main-returned-sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["main-returned-sync", "sync-after-await", "micro-after-await", "tick-after-await", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("cross-enqueue fixpoint: a tick's microtask and a microtask's tick each wait a full extra pass", async () => {
  // The two-phase loop's fixpoint (scr_loop_run's `continue`, Node's
  // `processTicksAndRejections`): draining ticks to exhaustion doesn't
  // re-check newly-added microtasks until the WHOLE microtask phase runs,
  // and vice versa — cross-enqueued work always lands one full pass later,
  // never inline. (microX/microY printing FIRST, ahead of tickA/tickB, is
  // this same program's first checkpoint doing its own pre-drain — the
  // fixpoint property this test is really pinning holds identically
  // either way.)
  const path = await build("crossenqueue.ts", [
    "const order: string[] = [];",
    "async function main(): Promise<void> {",
    "  await null;",
    "  process.nextTick(() => {",
    "    order.push('tickA');",
    "    Promise.resolve().then(() => order.push('micro-from-tickA'));",
    "  });",
    "  process.nextTick(() => order.push('tickB'));",
    "  Promise.resolve().then(() => {",
    "    order.push('microX');",
    "    process.nextTick(() => order.push('tick-from-microX'));",
    "  });",
    "  Promise.resolve().then(() => order.push('microY'));",
    "}",
    "main();",
    "setImmediate(() => console.log(order.join(',')));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["microX,microY,tickA,tickB,tick-from-microX,micro-from-tickA", ""].join("\n"));
  expect(stderr).toBe("");
});

test("nextTick vs setTimeout(0) vs setImmediate vs a microtask", async () => {
  const path = await build("vstimers.ts", [
    "console.log('start');",
    "setTimeout(() => console.log('timeout'), 0);",
    "setImmediate(() => console.log('immediate'));",
    "process.nextTick(() => console.log('tick'));",
    "Promise.resolve().then(() => console.log('micro'));",
    "console.log('end');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  // "start"/"end" are the synchronous tail; "micro"/"tick" is the FIRST
  // checkpoint's measured swap; "timeout"/"immediate" are the later
  // macrotask phase in whichever relative order timers.ts's existing
  // (untouched by this stage) scheduling already gives them — not this
  // stage's concern, so only the checkpoint-relevant prefix is pinned.
  expect(lines.slice(0, 4)).toEqual(["start", "end", "micro", "tick"]);
  expect(new Set(lines.slice(4))).toEqual(new Set(["timeout", "immediate"]));
  expect(stderr).toBe("");
});

test("a tick queued from a LATER checkpoint (inside a timer callback) still beats that turn's own microtask", async () => {
  // Every checkpoint after the first is steady-state (ticks first), so a
  // timer callback's own nextTick/then registrations resolve in the same
  // tick-before-microtask order as any other later checkpoint.
  const path = await build("timer-checkpoint.ts", [
    "const order: string[] = [];",
    "setTimeout(() => {",
    "  order.push('timer');",
    "  process.nextTick(() => order.push('tick-in-timer'));",
    "  Promise.resolve().then(() => order.push('micro-in-timer'));",
    "}, 0);",
    "setTimeout(() => console.log(order.join(',')), 1);",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["timer,tick-in-timer,micro-in-timer", ""].join("\n"));
});

test("an uncaught throw inside a nextTick callback traps (SEMANTICS.md S007)", async () => {
  const path = await build("throws.ts", [
    "console.log('before');",
    "process.nextTick(() => {",
    "  throw new Error('boom');",
    "});",
    "process.nextTick(() => console.log('SHOULD NOT RUN'));",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["before", ""].join("\n"));
  expect(stderr).toBe("");
});

test("a parameterized callback fired with no trailing arguments reads undefined (the dyn-boundary shape)", async () => {
  const path = await build("dynparam.js", [
    "process.nextTick((x) => {",
    "  console.log('param is', x === undefined ? 'undefined' : String(x));",
    "});",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["param is undefined", ""].join("\n"));
});
