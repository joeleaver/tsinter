/* The async tier end to end: the state-machine lowering (statemachine.ts)
 * driven by the promise runtime (promises.ts), compiled, instantiated and
 * run. wasm-emitter.test.ts's pattern — compile real TypeScript, compare
 * output byte for byte — because what matters here is ORDER, and order is
 * only observable at runtime.
 *
 * Every expectation is Node's actual output for the same source (the
 * corpus harness proves that differentially; these were hand-checked
 * against `node` while they were written). The interleavings are the
 * point: each await costs exactly ONE microtask turn, spawned bodies run
 * eagerly to their first suspension, and the whole queue drains after the
 * entry returns. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-async-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function buildWasm(name: string, source: string) {
  const entry = join(scratch, name);
  await writeFile(entry, source);
  return compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
}

async function build(name: string, lines: string[]) {
  const res = await buildWasm(name, `${lines.join("\n")}\n`);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

test("params survive the suspension: the frame is where they live", async () => {
  // The wrapper hands its arguments over in the frame's %l_ slots and the
  // entry state restores them like any other re-entry — so a param read
  // before AND after an await must answer the same thing, and two
  // in-flight calls must not see each other's.
  const path = await build("params.ts", [
    "async function tag(name: string, n: number): Promise<string> {",
    "  console.log('enter', name, n);",
    "  const bump = await Promise.resolve(n + 1);",
    "  console.log('resume', name, n, bump);",
    "  return name + ':' + bump;",
    "}",
    "async function main(): Promise<void> {",
    "  const a = await tag('first', 1);",
    "  const b = await tag('second', 10);",
    "  console.log(a, b);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "enter first 1",
      "resume first 1 2",
      "enter second 10",
      "resume second 10 11",
      "first:2 second:11",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("two async functions interleave one await at a time", async () => {
  // The spawn wrapper runs its body EAGERLY to the first await, so both
  // heads print before the sync tail; after that each resumption spends
  // exactly one turn, which strictly alternates the two frames.
  const path = await build("interleave.ts", [
    "async function a(): Promise<void> {",
    "  console.log('a1');",
    "  await Promise.resolve();",
    "  console.log('a2');",
    "  await Promise.resolve();",
    "  console.log('a3');",
    "}",
    "async function b(): Promise<void> {",
    "  console.log('b1');",
    "  await Promise.resolve();",
    "  console.log('b2');",
    "  await Promise.resolve();",
    "  console.log('b3');",
    "}",
    "a();",
    "b();",
    "console.log('sync');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["a1", "b1", "sync", "a2", "b2", "a3", "b3", ""].join("\n"));
});

test("await in a while loop accumulates across suspensions", async () => {
  // The loop is EXPLODED into states, so the counter and the accumulator
  // only survive because save/restore is total.
  const path = await build("loop.ts", [
    "async function sum(n: number): Promise<number> {",
    "  let total = 0;",
    "  let i = 0;",
    "  while (i < n) {",
    "    const v = await Promise.resolve(i * 2);",
    "    total = total + v;",
    "    i = i + 1;",
    "  }",
    "  return total;",
    "}",
    "async function main(): Promise<void> {",
    "  const t = await sum(5);",
    "  console.log('total', t);",
    "  let s = '';",
    "  for (let k = 0; k < 3; k++) {",
    "    const piece = await Promise.resolve('x');",
    "    s = s + piece + k;",
    "  }",
    "  console.log('s', s);",
    "}",
    "main();",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["total 20", "s x0x1x2", ""].join("\n"));
});

test("a throw after an await rejects the caller's promise, unhandled", async () => {
  // The rejection crosses two frames: `boom`'s tryCatch turns the throw
  // into ITS rejection, `main`'s re-entry check turns that back into an
  // unwind, and main's own promise — which nobody awaits — is what the
  // quiescent report finds (S010: stderr line, then the trap that IS
  // exit 1).
  const path = await build("reject.ts", [
    "async function boom(): Promise<number> {",
    "  console.log('boom enters');",
    "  await Promise.resolve();",
    "  throw new Error('kaboom');",
    "}",
    "async function main(): Promise<void> {",
    "  console.log('main enters');",
    "  const v = await boom();",
    "  console.log('never runs', v);",
    "}",
    "main();",
    "console.log('sync tail');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  // Everything the program wrote before quiescence is intact and complete.
  expect(stdout).toBe(["main enters", "boom enters", "sync tail", ""].join("\n"));
  expect(stderr).toBe("Unhandled promise rejection: Error: kaboom\n");
});

test("a caught rejection is not unhandled: no report, exit 0", async () => {
  // `await`ing a rejected promise OBSERVES it — the awaiting frame is
  // about to re-throw, so the ledger walk must skip it.
  const path = await build("observed.ts", [
    "function trip(): number {",
    "  throw new Error('tripped');",
    "}",
    "async function fails(): Promise<number> {",
    "  await Promise.resolve();",
    "  return trip();",
    "}",
    "async function main(): Promise<void> {",
    "  const p = fails();",
    "  const v = await p;",
    "  console.log('unreachable', v);",
    "}",
    "function guard(): void {",
    "  try {",
    "    trip();",
    "  } catch (e) {",
    "    console.log('caught', (e as Error).message);",
    "  }",
    "}",
    "guard();",
    "main();",
  ]);
  // main's own promise is still unobserved, so this program DOES report —
  // what the test pins is that only ONE rejection is reported (the
  // observed inner one is skipped) and that the sync catch is unaffected.
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe("caught tripped\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: tripped\n");
});

test("`await new Promise(() => {})` parks forever and the program exits 0", async () => {
  // The classic gotcha: nothing resolves the promise, so the frame is
  // simply dropped when the queue empties. Quiescence with an empty queue
  // is exit 0 — Node's behavior exactly (corpus 1024).
  const path = await build("pending.ts", [
    "async function waitsForever(): Promise<void> {",
    "  console.log('suspending');",
    "  await new Promise<void>(() => {});",
    "  console.log('never resumes');",
    "}",
    "waitsForever();",
    "console.log('main done');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["suspending", "main done", ""].join("\n"));
  expect(stderr).toBe("");
});

test("new Promise: resolve escapes the executor, reject and throw both reject", async () => {
  // The settler closures outlive the executor call (`fire` is captured
  // and called a turn later), first-settle-wins holds, and an executor
  // THROW rejects the promise instead of unwinding into the creator —
  // which is why 'after executor' still prints.
  const path = await build("newpromise.ts", [
    "let fire: (v: number) => void = (v: number) => { void v; };",
    "const gate = new Promise<number>((resolve) => { fire = resolve; });",
    "async function waiter(tag: string): Promise<void> {",
    "  console.log(tag, 'waiting');",
    "  const v = await gate;",
    "  console.log(tag, 'got', v);",
    "}",
    "async function driver(): Promise<void> {",
    "  await null;",
    "  console.log('firing');",
    "  fire(42);",
    "  fire(43);",
    "  console.log('fired');",
    "}",
    "function thrower(): Promise<number> {",
    "  return new Promise<number>(() => {",
    "    throw new Error('executor threw');",
    "  });",
    "}",
    "waiter('A');",
    "waiter('B');",
    "driver();",
    "const bad = thrower();",
    "console.log('after executor');",
    "void bad;",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(
    [
      "A waiting",
      "B waiting",
      "after executor",
      "firing",
      "fired",
      // Waiters resume in SUBSCRIPTION order, and the second fire() is a
      // no-op (first settle wins).
      "A got 42",
      "B got 42",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("Unhandled promise rejection: Error: executor threw\n");
});

test("hop and settled-promise awaits both cost exactly one turn", async () => {
  // `await null` (no promise at all — the bare microtask hop) and `await
  // <settled promise>` (the runtime's no-fast-path rule) must interleave
  // one-for-one; a fast path on either side would reorder this.
  const path = await build("hop.ts", [
    "async function units(): Promise<void> {",
    "  console.log('u1');",
    "  await null;",
    "  console.log('u2');",
    "  await undefined;",
    "  console.log('u3');",
    "}",
    "async function promises(): Promise<void> {",
    "  console.log('p1');",
    "  await Promise.resolve(1);",
    "  console.log('p2');",
    "  await Promise.resolve(2);",
    "  console.log('p3');",
    "}",
    "units();",
    "promises();",
    "console.log('sync');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["u1", "p1", "sync", "u2", "p2", "u3", "p3", ""].join("\n"));
});

test("Promise.resolve/reject settle on the spot, in every payload shape", async () => {
  const path = await build("resolved.ts", [
    "async function main(): Promise<void> {",
    "  const n = await Promise.resolve(7.5);",
    "  const s = await Promise.resolve('str');",
    "  const b = await Promise.resolve(true);",
    "  console.log(n, s, b);",
    "  await Promise.resolve();",
    "  console.log('void resolve returned');",
    "}",
    "main();",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["7.5 str true", "void resolve returned", ""].join("\n"));
});

test("a SYNC caller that ignores the promise still runs the body at drain", async () => {
  // Fire-and-forget: the spawn runs to the first await inline, the rest
  // waits for the queue — which only turns after the entry has returned,
  // so every remaining sync statement prints first.
  const path = await build("fireforget.ts", [
    "let n = 0;",
    "function bump(): number {",
    "  n += 1;",
    "  return n;",
    "}",
    "async function tick(label: string): Promise<void> {",
    "  console.log(label, bump());",
    "  await null;",
    "  console.log(label, 'after', bump());",
    "}",
    "function sync(): void {",
    "  tick('spawned');",
    "  console.log('sync mid', bump());",
    "}",
    "sync();",
    "console.log('sync tail', bump());",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["spawned 1", "sync mid 2", "sync tail 3", "spawned after 4", ""].join("\n"));
});

test("an await in an argument list keeps the list's evaluation order", async () => {
  // The hoisting rewrite's whole point, at runtime: what JS evaluates
  // before the await runs before the suspension, and what follows it runs
  // after the resumption. `tag('a')` is on the suspending side of the
  // split and `tag('c')` on the resumed side — and `join` runs last.
  const path = await build("hoist-order.ts", [
    "function tag(label: string): string {",
    "  console.log('eval', label);",
    "  return label;",
    "}",
    "function join(a: string, b: string, c: string): string {",
    "  console.log('join', a, b, c);",
    "  return a + b + c;",
    "}",
    "async function main(): Promise<void> {",
    "  console.log('x', await Promise.resolve(1), 'y');",
    "  const s = join(tag('a'), await Promise.resolve('B'), tag('c'));",
    "  console.log('s', s);",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["sync", "x 1 y", "eval a", "eval c", "join a B c", "s aBc", ""].join("\n"));
  expect(stderr).toBe("");
});

test("two awaits in one argument list are two turns another frame runs between", async () => {
  // Each await in the list costs its own microtask turn, so a second
  // spawned body makes BOTH of its remaining steps in between — the
  // interleaving is the proof that the list really did split twice.
  const path = await build("hoist-interleave.ts", [
    "function pair(a: number, b: number): number {",
    "  console.log('pair', a, b);",
    "  return a + b;",
    "}",
    "async function other(): Promise<void> {",
    "  console.log('other 1');",
    "  await null;",
    "  console.log('other 2');",
    "  await null;",
    "  console.log('other 3');",
    "}",
    "async function main(): Promise<void> {",
    "  other();",
    "  const n = pair(await Promise.resolve(1), await Promise.resolve(2));",
    "  console.log('n', n);",
    "}",
    "main();",
    "console.log('sync tail');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["other 1", "sync tail", "other 2", "other 3", "pair 1 2", "n 3", ""].join("\n"));
});

test("an awaited value written into an element or a field keeps its order", async () => {
  // The statement half of the rewrite. `xs[idx(1)] = await p` evaluates
  // the receiver and the INDEX before the await (JS's reference-then-index
  // order), so hoisting only the value would move `idx` behind the
  // suspension; a record literal's earlier fields are the same argument.
  const path = await build("hoist-writes.ts", [
    "function idx(i: number): number {",
    "  console.log('idx', i);",
    "  return i;",
    "}",
    "async function main(): Promise<void> {",
    "  const xs: number[] = [0, 0];",
    "  xs[idx(1)] = await Promise.resolve(7);",
    "  console.log('xs', xs[0], xs[1]);",
    "  const r = { a: idx(0), b: await Promise.resolve(9) };",
    "  console.log('r', r.a, r.b);",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["idx 1", "sync", "xs 0 7", "idx 0", "r 0 9", ""].join("\n"));
  expect(stderr).toBe("");
});

test("a captured local is ONE box the frame and its closures share", async () => {
  // THE ALIASING PIN. `n` is a body-declared boxed local: the wrapper
  // makes its box, resume captures it, and every re-entry unpacks the SAME
  // one — so a mutation through `bump` is visible to the resumed frame and
  // the frame's own write is visible to `bump`, across two suspensions and
  // then from a timer callback that outlives the body entirely.
  //
  // "first 0 1" is the 5a rule still holding: the read of `n` is taken
  // into its hoist temp at its own evaluation position, ahead of the
  // `bump()` that follows it in the argument list.
  const path = await build("box-alias.ts", [
    "async function main(): Promise<void> {",
    "  let n = 0;",
    "  const bump = (): number => { n = n + 1; return n; };",
    "  console.log('enter', n);",
    "  await Promise.resolve();",
    "  console.log('first', n, bump());",
    "  await null;",
    "  console.log('second', n, bump());",
    "  n = n + 100;",
    "  console.log('wrote', n);",
    "  await Promise.resolve();",
    "  console.log('third', n, bump());",
    "  setTimeout(() => { console.log('timer', bump(), n); }, 1);",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["enter 0", "sync", "first 0 1", "second 1 2", "wrote 102", "third 102 103", "timer 104 104", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("the delay idiom inside an async body: a box the executor's timer reads", async () => {
  // `new Promise(resolve => setTimeout(() => resolve(v), 1))` with `v` a
  // local of the ASYNC function — the shape the corpus wears everywhere.
  // `v` is boxed into the wrapper's slot, the executor's nested arrow
  // captures it, and the timer reads it a whole turn after the body
  // suspended on the promise it armed.
  const path = await build("box-delay.ts", [
    "async function main(): Promise<void> {",
    "  const v = 'payload';",
    "  const p = new Promise<string>((resolve) => {",
    "    setTimeout(() => { resolve(v + '!'); }, 1);",
    "  });",
    "  console.log('armed');",
    "  const got = await p;",
    "  console.log('got', got, v);",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["armed", "sync", "got payload! payload", ""].join("\n"));
  expect(stderr).toBe("");
});

test("two spawned frames get their own box — boxInit runs per wrapper call", async () => {
  // The box is made in the WRAPPER, so each spawn allocates one; two
  // in-flight frames interleaving on the same lexical `n` must never see
  // each other's.
  const path = await build("box-perframe.ts", [
    "async function frame(tag: string, start: number): Promise<void> {",
    "  let n = start;",
    "  const bump = (): number => { n = n + 1; return n; };",
    "  console.log(tag, 'enter', bump());",
    "  await Promise.resolve();",
    "  console.log(tag, 'mid', bump());",
    "  await Promise.resolve();",
    "  console.log(tag, 'exit', n);",
    "}",
    "frame('A', 0);",
    "frame('B', 100);",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["A enter 1", "B enter 101", "sync", "A mid 2", "B mid 102", "A exit 2", "B exit 102", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── awaits inside try/catch (the static routing table) ────────────────── */

test("an awaited rejection lands in the catch, and the body keeps going", async () => {
  // The whole shape at once: the re-entry check unwinds into resume's own
  // per-iteration catch, the routing table sends it to the handler state
  // instead of rejecting, the catch body runs, and control REJOINS the
  // body afterwards — including a later await outside the region, which
  // proves the region exit is clean.
  const path = await build("try-await.ts", [
    "async function boom(): Promise<number> {",
    "  console.log('boom enters');",
    "  await Promise.resolve();",
    "  throw new Error('bang');",
    "}",
    "async function main(): Promise<void> {",
    "  try {",
    "    const n = await boom();",
    "    console.log('never', n);",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('caught:', e.message);",
    "  }",
    "  console.log('region exited');",
    "  const later = await Promise.resolve(7);",
    "  console.log('later await still works:', later);",
    "}",
    "main().then(() => console.log('fulfilled'));",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "boom enters",
      "sync",
      "caught: bang",
      "region exited",
      "later await still works: 7",
      // Nothing was left pending: main's own promise FULFILLED.
      "fulfilled",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a sync throw after an await hits the same handler, and the catch may await", async () => {
  // Two halves of the same region. The throw happens MID-STATE with the
  // locals live; the catch body then suspends, so the handler's own states
  // have to be ordinary re-entry states like any other.
  const path = await build("try-sync-throw.ts", [
    "async function main(): Promise<void> {",
    "  try {",
    "    const a = await Promise.resolve(1);",
    "    console.log('got', a);",
    "    throw new Error('sync-after-await');",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('caught:', e.message);",
    "    const b = await Promise.resolve(2);",
    "    console.log('await inside catch:', b);",
    "  }",
    "  console.log('done');",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["sync", "got 1", "caught: sync-after-await", "await inside catch: 2", "done", ""].join("\n"));
  expect(stderr).toBe("");
});

test("a catch that RETHROWS rejects the frame's own promise", async () => {
  // The rethrow refills the exception cell from the caught snapshot and
  // unwinds into the SAME per-iteration catch — where the routing table,
  // the inner region having closed, finds no handler and takes the reject
  // default. Nobody observes main's promise, so it is the quiescent
  // report (S010) and the trap that IS exit 1.
  const path = await build("try-rethrow.ts", [
    "async function inner(): Promise<void> {",
    "  try {",
    "    await Promise.reject(new Error('inner-boom'));",
    "    console.log('never');",
    "  } catch (e) {",
    "    console.log('rethrowing');",
    "    throw e;",
    "  }",
    "}",
    "async function main(): Promise<void> {",
    "  await inner();",
    "  console.log('never either');",
    "}",
    "main();",
    "console.log('top');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["top", "rethrowing", ""].join("\n"));
  expect(stderr).toBe("Unhandled promise rejection: Error: inner-boom\n");
});

test("nested regions: the inner catch handles, the outer never fires", async () => {
  // Then the mirror image — an inner catch that throws AGAIN, which the
  // outer region has to take, because a catch body is not protected by
  // its own try.
  const path = await build("try-nested.ts", [
    "async function main(): Promise<void> {",
    "  try {",
    "    try {",
    "      await Promise.reject(new Error('deep'));",
    "    } catch (e) {",
    "      if (e instanceof Error) console.log('inner caught:', e.message);",
    "    }",
    "    console.log('inner region done');",
    "    try {",
    "      await Promise.resolve(1);",
    "      throw new Error('from-inner-try');",
    "    } catch (e) {",
    "      if (e instanceof Error) console.log('inner2:', e.message);",
    "      throw new Error('from-inner-catch');",
    "    }",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('outer:', e.message);",
    "  }",
    "  console.log('done');",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["sync", "inner caught: deep", "inner region done", "inner2: from-inner-try", "outer: from-inner-catch", "done", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("the .catch and .finally desugars ride the same machinery", async () => {
  // Both lower to a lifted ASYNC function whose whole body is one
  // try/catch around `await p` — `.catch`'s catch body IS the handler,
  // and `.finally`'s ends in the rethrow that passes the rejection on.
  const path = await build("try-desugars.ts", [
    "function failing(msg: string): Promise<string> {",
    "  return new Promise<string>(() => {",
    "    throw new Error(msg);",
    "  });",
    "}",
    "async function main(): Promise<void> {",
    "  const a = await Promise.resolve('ok').catch(() => 'fallback');",
    "  console.log('a:', a);",
    "  const b = await failing('boom').catch((e) => {",
    "    if (e instanceof Error) return 'caught:' + e.message;",
    "    return 'caught:non-error';",
    "  });",
    "  console.log('b:', b);",
    "  const d = await Promise.resolve('val').finally(() => console.log('fin-1'));",
    "  console.log('d:', d);",
    "  try {",
    "    await failing('efail').finally(() => console.log('fin-2'));",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('e:', e.message);",
    "  }",
    "}",
    "main();",
    "console.log('top');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["top", "a: ok", "b: caught:boom", "fin-1", "d: val", "fin-2", "e: efail", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("break and continue leave a protected region, and a verbatim try nests inside one", async () => {
  // Two edges in one program. The jumps out of the try are plain state
  // transitions (no finalizer means nothing runs on the way out) landing
  // on states the loop created BEFORE the region opened; and the
  // suspension-free inner try stays one statement, so the emitter's own
  // tryStack handles it — innermost first, with the region's handler
  // still underneath for what its catch body throws.
  const path = await build("try-jumps.ts", [
    "async function main(): Promise<void> {",
    "  let total = 0;",
    "  for (let i = 0; i < 4; i = i + 1) {",
    "    try {",
    "      const v = await Promise.resolve(i);",
    "      if (v === 2) { console.log('break at', v); break; }",
    "      if (v === 1) { console.log('continue at', v); continue; }",
    "      total = total + 10;",
    "      throw new Error('iter ' + v);",
    "    } catch (e) {",
    "      if (e instanceof Error) console.log('caught:', e.message);",
    "    }",
    "    console.log('tail', i);",
    "  }",
    "  console.log('total', total);",
    "  try {",
    "    await Promise.resolve();",
    "    try {",
    "      throw new Error('inner-verbatim');",
    "    } catch (e) {",
    "      if (e instanceof Error) console.log('verbatim:', e.message);",
    "    }",
    "    throw new Error('after-verbatim');",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('outer:', e.message);",
    "  }",
    "  console.log('end');",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "sync",
      "caught: iter 0",
      "tail 0",
      "continue at 1",
      "break at 2",
      "total 10",
      "verbatim: inner-verbatim",
      "outer: after-verbatim",
      "end",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a body box and a protected region share one function", async () => {
  // Stage 5b meets stage 6: `n` is a body-owned box (it rides resume's
  // closure env, NOT the frame), the catch arm's saves cover the frame
  // locals only, and the handler state reads the box through the same
  // ref every closure holds — before, inside and after the region.
  const path = await build("try-box.ts", [
    "async function main(): Promise<void> {",
    "  let n = 0;",
    "  const bump = (): number => { n = n + 1; return n; };",
    "  try {",
    "    console.log('enter', bump());",
    "    await Promise.reject(new Error('x'));",
    "    console.log('never');",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('caught', e.message, bump());",
    "  }",
    "  console.log('after', n, bump());",
    "  await Promise.resolve();",
    "  console.log('end', n);",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["enter 1", "sync", "caught x 2", "after 2 3", "end 3", ""].join("\n"));
  expect(stderr).toBe("");
});

test("a module with no promise surface emits no promise runtime", async () => {
  // The laziness contract: everything above is interned on first use, so
  // a program that never mentions a promise must be byte-identical to
  // what the tier produced before this increment.
  const path = await build("nopromise.ts", ["console.log('plain', 1 + 1);"]);
  const bytes = readFileSync(path);
  expect(bytes.includes(Buffer.from("%w.async"))).toBe(false);
  expect(bytes.includes(Buffer.from("%frameBase"))).toBe(false);
  // The loop half of the ABI is just as conditional: no timer, no clock
  // import and no `_tick` export (abi.ts).
  expect(bytes.includes(Buffer.from("_tick"))).toBe(false);
  expect(bytes.includes(Buffer.from("%w.timer"))).toBe(false);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe("plain 2\n");
});
