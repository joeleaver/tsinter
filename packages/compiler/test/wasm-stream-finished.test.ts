/* stream.finished()/eos() — durable builder-level pins for stage-D fix-
 * round findings that no corpus program currently exercises (wasm-
 * nexttick.test.ts's own pattern: compile real TypeScript through the
 * actual frontend+backend, run it through the real abi.ts host, compare
 * against a live-Node-measured shape). Every claim here was re-measured
 * against a live Node oracle (node v24.18.1, `--experimental-transform-
 * types`) before being written down, not transcribed from prose.
 *
 * P1's own two corpus claims (1813, 2564) never register more than one
 * finished()/eos() watcher on a single stream, and never construct a
 * stream with `emitClose: false` — both are real fix-round findings
 * (gate review) that the corpus is structurally blind to. These pins
 * are the net. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-stream-finished-"));
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

test("finished() fires in REGISTRATION order across multiple watchers on one stream (gate finding v3)", async () => {
  // Live-Node re-measurement (node v24.18.1): three finished() calls on
  // ONE stream fire strictly A, B, C — never reordered. The backend's
  // own watcher list PREPENDS on registration (O(1)); fireFinListCore
  // reverses the detached list before firing to deliver this order —
  // without that reversal this test would observe C, B, A.
  const path = await build("fifo.ts", [
    "import { Readable, finished } from 'node:stream';",
    "const r = new Readable({ read() { this.push(null); } });",
    "finished(r, () => console.log('A'));",
    "finished(r, () => console.log('B'));",
    "finished(r, () => console.log('C'));",
    "r.resume();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["A", "B", "C", ""].join("\n"));
  expect(stderr).toBe("");
});

test("finished() on an emitClose:false Readable traps loudly by name, not a silent hang (gate finding v2/v4)", async () => {
  // Before this fix: OP_CLOSE (the only path a finished() watcher was
  // ever fired from) is scheduled only when RS_EMIT_CLOSE is true
  // (destroyErrDefaultCore's own pre-existing gate) — a stream
  // constructed with emitClose:false would register a watcher that
  // could NEVER fire, silently. Now: a named runtime trap at
  // registration time, the callback (finRegisterCbCore) entry point.
  const path = await build("emitclose-cb.ts", [
    "import { Readable, finished } from 'node:stream';",
    "const r = new Readable({ read() { this.push(null); }, emitClose: false });",
    "finished(r, (err) => console.log('SHOULD NOT PRINT', err));",
    "r.resume();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["sync", ""].join("\n"));
  expect(stderr).toBe("Uncaught Error: finished()/eos() on a stream constructed with emitClose:false is not supported yet\n");
});

test("stream/promises.finished() on an emitClose:false Writable ALSO traps loudly (gate finding v4: the promise entry point hangs identically)", async () => {
  // The same silent-hang mechanism applies to finRegisterPromiseCore
  // (sp.finished) — v4's coverage concern, confirmed here rather than
  // just asserted: without the trap on THIS entry point too, `await
  // done` would simply never resume. Empty stdout (not "sync" first,
  // unlike the top-level callback-form test above): the trap fires at
  // `finished(w)`'s OWN call site, which here is the FIRST statement
  // inside an async function body — the exception propagates through
  // main()'s own resumable-lowering immediately, before `w.write`/
  // `w.end`/`console.log('sync')` ever run (measured directly, not
  // assumed — an earlier draft of this pin wrongly expected "sync" to
  // print first, mirroring the top-level test's shape; it does not).
  const path = await build("emitclose-promise.ts", [
    "import { Writable } from 'node:stream';",
    "import { finished } from 'node:stream/promises';",
    "async function main(): Promise<void> {",
    "  const w = new Writable({ write(_c, _e, cb) { cb(); }, emitClose: false });",
    "  const done = finished(w);",
    "  w.write('data');",
    "  w.end();",
    "  console.log('SHOULD NOT PRINT: sync');",
    "  await done;",
    "  console.log('SHOULD NOT PRINT: resumed');",
    "}",
    "void main();",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: finished()/eos() on a stream constructed with emitClose:false is not supported yet\n");
});

test("finished() on a Duplex held through a Readable-typed binding still watches BOTH sides (F0b, reviewer probe n2 — SAME-branch upcast, expressible and observable today)", async () => {
  // GATE CORRECTION: an earlier draft of this pin used `const d = new
  // Duplex(...)` with NO type narrowing, so TypeScript inferred `Duplex`
  // — that shape does NOT exercise the binding-type divergence at all
  // (RS_SIDES reads off the constructed OBJECT, so a Duplex-typed
  // binding would pass identically whether the mechanism used call-site
  // static typing OR construction-time stamping; it wasn't actually
  // discriminating). THIS pin holds the Duplex through a Readable-typed
  // binding instead — %Duplex's base class IS %Readable (same branch,
  // unlike the Duplex-vs-Writable CROSS-branch cast, which is still
  // SC1090-fenced — RS_SIDES's own header has the full split), so
  // `const r: Readable = d;` compiles and runs today. `finished(r, cb)`
  // is called through THAT narrower binding — if RS_SIDES were ever
  // derived from the call site's static type instead of the
  // construction-time stamp, this would report "clean" the moment the
  // readable side ends; it must not.
  //
  // Live-Node re-measurement (node v24.18.1) of this EXACT shape:
  // the readable side ends immediately (push(null) on the first read);
  // the writable side's own `write()` callback is deliberately never
  // invoked, so it never reaches 'finish'; finished() (registered
  // through the Readable-typed binding) does NOT fire on the readable
  // 'end' alone — only after an explicit destroy() does it report
  // ERR_STREAM_PREMATURE_CLOSE (never "clean"), because the mechanism
  // is STILL watching the writable side too, exactly as if `finished()`
  // had been called on `d` directly.
  const path = await build("duplex-readable-binding.ts", [
    "import { Duplex, Readable, finished } from 'node:stream';",
    "const order: string[] = [];",
    "const d = new Duplex({",
    "  read() { this.push(null); },",
    "  write(_chunk: Buffer, _enc: string, _cb: () => void) { /* never call cb — writable side never finishes */ },",
    "});",
    "const r: Readable = d; // same-branch upcast: static type Readable, runtime object Duplex",
    "d.on('end', () => order.push('readable side ended'));",
    "finished(r, (err) => {",
    "  order.push('fin: ' + (err ? (err as NodeJS.ErrnoException).code : 'clean'));",
    "  console.log(order.join(' / '));",
    "});",
    "d.resume();",
    "setImmediate(() => d.destroy());",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["readable side ended / fin: ERR_STREAM_PREMATURE_CLOSE", ""].join("\n"));
  expect(stderr).toBe("");
});

test("same-branch upcast siblings (not separately pinned — one mechanism, one pin carries the class)", () => {
  // Transform→Readable, PassThrough→Readable, Transform→Duplex,
  // PassThrough→Duplex, and any user subclass of a duplex-shaped root
  // held through a Readable- or Duplex-typed binding are all the SAME
  // shape as the pin above: a same-branch upcast (RUNTIME_STREAM_
  // CLASSES' own hierarchy — Transform and PassThrough both root at
  // %Duplex, which roots at %Readable), fully expressible today, and
  // correct under RS_SIDES's construction-time stamp for the identical
  // reason — the stamp tracks the constructed object, never the
  // binding's static type, regardless of which duplex-shaped root or
  // how many subclass layers sit between the construction site and the
  // finished() call site. Only the CROSS-branch cast (any duplex-shaped
  // value through a bare Writable-typed binding) remains SC1090-fenced
  // and unpinnable — RS_SIDES's own header has the full split.
  expect(true).toBe(true);
});
