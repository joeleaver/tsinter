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

async function instantiate(modulePath: string) {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  return { instance, chunks };
}

async function runWasm(modulePath: string): Promise<{ stdout: string; stderr: string }> {
  const { instance, chunks } = await instantiate(modulePath);
  (instance.exports["_start"] as () => void)();
  return { stdout: Buffer.concat(chunks[1]).toString("utf8"), stderr: Buffer.concat(chunks[2]).toString("utf8") };
}

/** S007/S010's bridge shape: run to an EXPECTED trap (the tier's exit-1
 * channel), returning the output that preceded it. */
async function runWasmToTrap(modulePath: string): Promise<{ stdout: string; stderr: string }> {
  const { instance, chunks } = await instantiate(modulePath);
  const trap = await Promise.resolve()
    .then(() => (instance.exports["_start"] as () => void)())
    .then(
      () => null,
      (err: unknown) => err,
    );
  expect(trap).toBeInstanceOf(WebAssembly.RuntimeError);
  return { stdout: Buffer.concat(chunks[1]).toString("utf8"), stderr: Buffer.concat(chunks[2]).toString("utf8") };
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
  // about to re-throw, so the ledger walk must skip it. (The catch is in
  // a SYNC function: await-in-try is its own increment.)
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

test("a module with no promise surface emits no promise runtime", async () => {
  // The laziness contract: everything above is interned on first use, so
  // a program that never mentions a promise must be byte-identical to
  // what the tier produced before this increment.
  const path = await build("nopromise.ts", ["console.log('plain', 1 + 1);"]);
  const bytes = readFileSync(path);
  expect(bytes.includes(Buffer.from("%w.async"))).toBe(false);
  expect(bytes.includes(Buffer.from("%frameBase"))).toBe(false);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe("plain 2\n");
});
