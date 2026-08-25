/* for-await over a Readable — durable builder-level pins for STAGE D P4
 * (rider #72, S048's deferred build): destroy-on-early-exit and the
 * re-iteration-after-break crash. Corpus-unpinnable in the byte-exact
 * contract for the DIVERGENT cells only (Node's own crash text on stderr
 * is not captured on nonzero exit, and no claimed corpus program exits a
 * for-await loop early — 1746 always drains to completion); every claim
 * here was re-measured against a live Node oracle (node v24.18.1,
 * `--experimental-transform-types`) at build time, restated in
 * SEMANTICS.md's S048 amendment, not transcribed from prose. Follows
 * wasm-stream-finished.test.ts's own pattern (compile real TypeScript
 * through the actual frontend+backend, run it through the real abi.ts
 * host, compare against the live-measured shape). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-stream-forawait-"));
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

test("break destroys the stream synchronously (S048 shape A: more data would have been pending)", async () => {
  // Live-Node re-measurement (v24.18.1): destroyed flips true with ZERO
  // turns elapsed (no await needed after the break), push() after the
  // break answers false, 'close' fires, and readableEnded stays false
  // (the source never reached its own natural end).
  const path = await build("shape-a.ts", [
    "import { Readable } from 'node:stream';",
    "let n = 0;",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() { n++; setTimeout(() => r.push(`c${n}`), 1); } });",
    "  for await (const chunk of r) { console.log('chunk:', chunk.toString()); break; }",
    "  console.log('immediately:', r.destroyed, r.readableEnded);",
    "  console.log('push-after-break:', r.push('more'));",
    "  r.on('close', () => console.log('close fired'));",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  console.log('after-turn:', r.destroyed, r.readableEnded);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "chunk: c1",
      "immediately: true false",
      "push-after-break: false",
      "close fired",
      "after-turn: true false",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("break destroys synchronously even right as push(null) lands in the same batch (S048 shape B)", async () => {
  // Live-Node re-measurement: destroyed=true immediately, readableEnded
  // stays FALSE forever (destruction via the iterator's own return()
  // preempts the natural end machinery before it ever completes) — not
  // "converges one turn later", which was only ever true for the
  // fully-synchronous-merge sub-shape this async-delivery variant does
  // not exercise.
  const path = await build("shape-b.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  let n = 0;",
    "  const r = new Readable({",
    "    read() {",
    "      n++;",
    "      if (n === 1) setTimeout(() => r.push('one'), 1);",
    "      else if (n === 2) setTimeout(() => { r.push('two'); r.push(null); }, 1);",
    "    },",
    "  });",
    "  let i = 0;",
    "  for await (const chunk of r) {",
    "    console.log('chunk:', chunk.toString());",
    "    i++;",
    "    if (i === 2) break;",
    "  }",
    "  console.log('immediately:', r.destroyed, r.readableEnded);",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  console.log('after-turn:', r.destroyed, r.readableEnded);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["chunk: one", "chunk: two", "immediately: true false", "after-turn: true false", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("continue does NOT destroy mid-stream; only the loop's own natural end does (the IR \"for\" node's continue-runs-update-first integration check)", async () => {
  // Live-Node re-measurement: destroyed reads false on EVERY iteration
  // (checked before deciding to continue), flipping true only after
  // natural exhaustion. This is the direct proof that using IR kind
  // "for" (not "while") for the synthetic loop was necessary: a
  // "while"-based normalCompletion flag would have left the flag false
  // across a continue (the trailing mark-normal statement would never
  // run), wrongly destroying on the NEXT natural exit.
  const path = await build("continue-safe.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const chunks = ['skip', 'one', 'skip', 'two'];",
    "  let idx = 0;",
    "  const r = new Readable({",
    "    read() {",
    "      if (idx < chunks.length) { const c = chunks[idx++]; setTimeout(() => r.push(c), 1); }",
    "      else setTimeout(() => r.push(null), 1);",
    "    },",
    "  });",
    "  for await (const chunk of r) {",
    "    console.log('chunk:', chunk.toString(), 'destroyed=', r.destroyed);",
    "    if (chunk.toString() === 'skip') continue;",
    "  }",
    "  console.log('after:', r.destroyed, r.readableEnded);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "chunk: skip destroyed= false",
      "chunk: one destroyed= false",
      "chunk: skip destroyed= false",
      "chunk: two destroyed= false",
      "after: true true",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a `return` from the enclosing async function crossing the loop also destroys (the completion-records pending-return path)", async () => {
  // Live-Node re-measurement: identical shape to break — destroyed=true
  // immediately, readableEnded stays false. This is the increment-19
  // stage B finalizers-across-suspension machinery's own integration
  // check: `return` crossing a try-with-finally is the ONE jump kind the
  // frontend does not reject (rejectJumpCrossingFinally's own `kw !==
  // \"return\"` exemption), so this program must actually COMPILE and
  // the destroy must actually run, not just fail to refuse.
  const path = await build("return-crosses.ts", [
    "import { Readable } from 'node:stream';",
    "async function consume(r: Readable): Promise<string> {",
    "  for await (const chunk of r) { return chunk.toString(); }",
    "  return '<never>';",
    "}",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.push('one');",
    "  r.push('two');",
    "  const first = await consume(r);",
    "  console.log('first:', first);",
    "  console.log('immediately:', r.destroyed, r.readableEnded);",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  console.log('after-turn:', r.destroyed, r.readableEnded);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["first: onetwo", "immediately: true false", "after-turn: true false", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a `throw` from the loop body also destroys (uncaught-by-the-loop, caught by an outer try)", async () => {
  const path = await build("throw-crosses.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.push('one');",
    "  r.push('two');",
    "  try {",
    "    for await (const chunk of r) { throw new Error('body threw: ' + chunk.toString()); }",
    "  } catch (err) {",
    "    console.log('caught:', (err as Error).message);",
    "  }",
    "  console.log('immediately:', r.destroyed, r.readableEnded);",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  console.log('after-turn:', r.destroyed, r.readableEnded);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "caught: body threw: onetwo",
      "immediately: true false",
      "after-turn: true false",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a LABELED break out of the loop to an outer statement refuses SC1090, a pre-existing tier fence extended by the new synthetic try/finally (zero corpus impact, verified)", async () => {
  // Not a runtime pin: the same 'break crossing a finally' refusal every
  // OTHER try/finally construct in this tier already has (verified
  // directly against a plain user-written try/finally, unrelated to
  // this rider) — this program used to COMPILE (with the pre-fix
  // silent-continue divergence) and now refuses instead, a narrow,
  // named, zero-corpus-impact tier-shape change from building rider #72.
  const entry = join(scratch, "labeled-break-outer.ts");
  await writeFile(
    entry,
    [
      "import { Readable } from 'node:stream';",
      "async function main(): Promise<void> {",
      "  const r = new Readable({ read() {} });",
      "  r.push('one');",
      "  outer: for (let i = 0; i < 3; i++) {",
      "    for await (const chunk of r) { break outer; }",
      "  }",
      "}",
      "main();",
      "",
    ].join("\n"),
  );
  const res = await compile(entry, {
    outPath: join(scratch, "labeled-break-outer.wasm"),
    outDir: scratch,
    backend: "wasm",
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.diagnostics.map((d) => d.code)).toEqual(["SC1090"]);
    expect(res.diagnostics[0]?.message).toBe("'break' crossing a 'finally' block is not supported yet");
  }
});

test("re-iterating a stream a prior loop's own break destroyed CRASHES uncaught (S048's sharpest observable, corrected)", async () => {
  // CORRECTION to S048's originally-registered text: the crash is an
  // AbortError [ABORT_ERR] ("The operation was aborted"), NOT
  // ERR_STREAM_PREMATURE_CLOSE — re-measured directly against Node
  // v24.18.1, six independent shape variants all unanimous (see the
  // amendment). ERR_STREAM_PREMATURE_CLOSE is real Node behavior too,
  // just for a DIFFERENT trigger (an external destroy() while a loop is
  // parked or not yet started) that this pin does not exercise.
  const path = await build("reiterate-crash.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.push('one');",
    "  r.push('two');",
    "  for await (const chunk of r) { console.log('first-loop chunk:', chunk.toString()); break; }",
    "  console.log('re-iterating...');",
    "  for await (const chunk of r) { console.log('never:', chunk); }",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["first-loop chunk: onetwo", "re-iterating...", ""].join("\n"));
  expect(stderr).toBe("Unhandled promise rejection: AbortError: The operation was aborted\n");
});

test("the SAME re-iteration crash, caught in-program: e.name/e.code/e.message (the lead's own pinnable surface)", async () => {
  const path = await build("reiterate-caught.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.push('one');",
    "  r.push('two');",
    "  for await (const chunk of r) { console.log('first-loop chunk:', chunk.toString()); break; }",
    "  console.log('re-iterating...');",
    "  try {",
    "    for await (const chunk of r) { console.log('never:', chunk); }",
    "  } catch (err) {",
    "    const e = err as NodeJS.ErrnoException;",
    "    console.log('threw: name=', e.name, 'code=', e.code, 'message=', e.message);",
    "  }",
    "  console.log('done');",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "first-loop chunk: onetwo",
      "re-iterating...",
      "threw: name= AbortError code= ABORT_ERR message= The operation was aborted",
      "done",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a THIRD attempt after the second already threw gets the identical AbortError (idempotent, no attempt-counting)", async () => {
  const path = await build("reiterate-triple.ts", [
    "import { Readable } from 'node:stream';",
    "async function attempt(label: string, r: Readable): Promise<void> {",
    "  try {",
    "    for await (const chunk of r) { console.log('never:', chunk); }",
    "    console.log(label, 'completed normally');",
    "  } catch (err) {",
    "    const e = err as NodeJS.ErrnoException;",
    "    console.log(label, 'threw', e.name, e.code);",
    "  }",
    "}",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.push('one');",
    "  for await (const chunk of r) break;",
    "  await attempt('second', r);",
    "  await attempt('third', r);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["second threw AbortError ABORT_ERR", "third threw AbortError ABORT_ERR", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("S049 regression guard: two SEQUENTIAL loops (first drains fully, second reuses the ended stream) still do not trap", async () => {
  const path = await build("sequential-ok.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.push('a');",
    "  r.push('b');",
    "  r.push(null);",
    "  for await (const chunk of r) { console.log('first-loop chunk:', chunk.toString()); }",
    "  console.log('first loop done;', r.readableEnded, r.destroyed);",
    "  for await (const chunk of r) { console.log('never:', chunk); }",
    "  console.log('second loop done');",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["first-loop chunk: ab", "first loop done; true true", "second loop done", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("S049 regression guard: two CONCURRENT loops on the SAME stream still trap loudly (unaffected by rider #72's own destroy path)", async () => {
  const path = await build("concurrent-still-traps.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.push('a'); r.push('b'); r.push('c'); r.push(null);",
    "  async function loopA(): Promise<void> { for await (const chunk of r) console.log('A:', chunk.toString()); }",
    "  async function loopB(): Promise<void> { for await (const chunk of r) console.log('B:', chunk.toString()); }",
    "  await Promise.all([loopA(), loopB()]);",
    "  console.log('both done');",
    "}",
    "main();",
  ]);
  const { stdout } = await runWasmToTrap(path);
  expect(stdout).toBe(["A: abc", ""].join("\n"));
});

test("destroy-idempotence: the body's own explicit destroy() before throwing leaves the synthetic finally's destroy a no-op (matching Node: 'close' fires exactly once)", async () => {
  const path = await build("idempotent-destroy.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  let closeCount = 0;",
    "  r.on('close', () => closeCount++);",
    "  r.push('one');",
    "  try {",
    "    for await (const chunk of r) {",
    "      console.log('chunk:', chunk.toString());",
    "      r.destroy();",
    "      throw new Error('body threw after self-destroy');",
    "    }",
    "  } catch (err) {",
    "    console.log('caught:', (err as Error).message);",
    "  }",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  console.log('closeCount:', closeCount, 'destroyed:', r.destroyed);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "chunk: one",
      "caught: body threw after self-destroy",
      "closeCount: 1 destroyed: true",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("cell a: fresh for-await AFTER an external, plain destroy() (no break, no error) rejects ERR_STREAM_PREMATURE_CLOSE, NOT AbortError", async () => {
  // The STOP-class correction this pin locks in: rider #72's FIRST
  // (voided) build rejected EVERY destroyed-without-error stream with
  // AbortError uniformly, which is wrong here — a stream destroyed by a
  // plain external `.destroy()` call (nothing to do with for-await's
  // own break/abort machinery at all) is a genuinely different Node
  // shape. checkWaiterCore's own settle happens SYNCHRONOUSLY inside
  // THIS for-await's own nextChunkDynCore call (nothing was parked
  // beforehand — the destroy already finished before this loop starts).
  const path = await build("cell-a.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.destroy();",
    "  try {",
    "    for await (const chunk of r) { console.log('never:', chunk); }",
    "  } catch (err) {",
    "    const e = err as NodeJS.ErrnoException;",
    "    console.log('threw: name=', e.name, 'code=', e.code, 'message=', e.message);",
    "  }",
    "  console.log('done');",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "threw: name= Error code= ERR_STREAM_PREMATURE_CLOSE message= Premature close",
      "done",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("cell a2: destroy() while a for-await loop is ALREADY PARKED also rejects ERR_STREAM_PREMATURE_CLOSE — settled via opClose's own tail call to checkWaiterCore, not opError (destroy(null) never schedules OP_ERROR)", async () => {
  // Different settling PATH from cell a on purpose, named explicitly per
  // the lead's own question: a bare destroy() (no error) never schedules
  // OP_ERROR at all (destroyErrDefaultCore only schedules it when the
  // error argument is non-null) — OP_CLOSE is the ONLY tick that ever
  // gets a chance to settle a waiter parked before a clean destroy, via
  // its own trailing checkWaiterCore call (buildOpClose's own comment:
  // "a bare destroy() with no error never schedules OP_ERROR at all, so
  // opClose is the only tick that ever gets a chance to settle it").
  const path = await build("cell-a2.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  setTimeout(() => r.destroy(), 5);",
    "  try {",
    "    for await (const chunk of r) { console.log('never:', chunk); }",
    "  } catch (err) {",
    "    const e = err as NodeJS.ErrnoException;",
    "    console.log('threw: name=', e.name, 'code=', e.code, 'message=', e.message);",
    "  }",
    "  console.log('done');",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "threw: name= Error code= ERR_STREAM_PREMATURE_CLOSE message= Premature close",
      "done",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("an attached 'error' listener DOES fire with the synthesized AbortError after break — Node does not suppress emission, only the unhandled-crash fallback", async () => {
  // The other half of RS_ERROR_ABORT_SILENT's own justification: Node's
  // real behavior is "emit normally to a REAL listener; only skip the
  // no-listener crash", not "never emit at all". Confirms the built
  // destroyAbortedCore->destroyErrCore->opError path still dispatches to
  // hasErrorListeners() correctly (unchanged, existing machinery) even
  // though the crash-fallback for THIS error is suppressed when no
  // listener exists (the companion pin, shape A, covers that half).
  const path = await build("error-listener-fires.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  r.on('error', (e: NodeJS.ErrnoException) => {",
    "    console.log('error event: name=', e.name, 'code=', e.code, 'message=', e.message);",
    "  });",
    "  r.push('one');",
    "  for await (const chunk of r) break;",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  console.log('done');",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "error event: name= AbortError code= ABORT_ERR message= The operation was aborted",
      "done",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("destroy-idempotence under the STORED-ERROR model: a SECOND explicit destroy(err) after break's own AbortError does not overwrite it (Node: first error wins, 'close' fires exactly once)", async () => {
  // The reverse order from the earlier idempotence pin (there: body
  // destroys first, the synthetic finally's call is the redundant
  // second one; here: the synthetic abort fires FIRST via break, an
  // explicit second destroy(err) call is the redundant one) — both
  // directions matter since destroyErrCore's idempotent gate returns
  // before EVER touching RS_ERROR on any call past the first, regardless
  // of which side happened first.
  const path = await build("idempotent-reversed.ts", [
    "import { Readable } from 'node:stream';",
    "async function main(): Promise<void> {",
    "  const r = new Readable({ read() {} });",
    "  let closeCount = 0;",
    "  r.on('close', () => closeCount++);",
    "  r.push('one');",
    "  for await (const chunk of r) break;",
    "  const e1 = r.errored;",
    "  console.log('after break: errored=', e1 === null ? 'null' : e1.message);",
    "  r.destroy(new Error('second, should be ignored'));",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  await new Promise((res) => setTimeout(res, 5));",
    "  const e2 = r.errored;",
    "  console.log(",
    "    'after second destroy(err): errored=',",
    "    e2 === null ? 'null' : e2.message,",
    "    'closeCount=',",
    "    closeCount,",
    "  );",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "after break: errored= The operation was aborted",
      "after second destroy(err): errored= The operation was aborted closeCount= 1",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
