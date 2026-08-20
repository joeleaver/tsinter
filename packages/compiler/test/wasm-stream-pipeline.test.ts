/* stream.pipeline()/stream.promises.pipeline() — durable builder-level
 * pins for stage-D P2 mechanisms that no corpus program currently
 * exercises (wasm-stream-finished.test.ts's own pattern: compile real
 * TypeScript through the actual frontend+backend, run it through the
 * real abi.ts host, compare against a live-Node-measured shape). Every
 * claim here was re-measured against a live Node oracle (node v24.18.1)
 * before being written down, not transcribed from prose.
 *
 * P2's own three corpus claims (1814, 2563, 2565) never register more
 * than one middle stage, and never destroy a stage manually mid-flight
 * with no error — so the real placeholder-vs-real-error supersession
 * rule `pipelineFinishImpl` implements (Node's own `finishImpl`:
 * overwrite the captured error only when nothing is captured yet, OR
 * when the captured error's code is exactly ERR_STREAM_PREMATURE_CLOSE
 * — this tier tracks the identical condition via PCTX_ERROR_IS_
 * PLACEHOLDER rather than a code-string compare, since the ONLY way to
 * capture that code in this tier is through this file's own placeholder
 * synthesis) is a fix-round-caliber finding the corpus is structurally
 * blind to. This is the net. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-stream-pipeline-"));
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
  return res.binaryPath;
}

test("pipeline() supersedes a placeholder premature-close with a REAL error from another stage (M2, live-measured)", async () => {
  // Shape: a 3-stage pipeline (source x, middle y, dest z). `x.destroy()`
  // (no error, called first) fires x's own destroyer watcher with NO
  // real RS_ERROR — x's role is R-only and it never reached
  // RS_END_EMITTED, so a PLACEHOLDER ERR_STREAM_PREMATURE_CLOSE is
  // synthesized and captured (nothing was captured yet); the cascade
  // destroys y and z with that placeholder. `y.destroy(new Error
  // ('real'))` (called immediately after, same script tick) reaches y's
  // OWN destroy call, which routes through y's raw 'error' listener with
  // a REAL error — since the currently-captured error IS the
  // placeholder, this OVERWRITES it, and the (idempotent — every stage
  // is either already destroyed or gets destroyed for the first time
  // here) cascade re-runs with y's real error. The FINAL callback must
  // therefore report y's real error, not x's placeholder, and x itself
  // must show NO 'error' event of its own (x.destroy() with no argument
  // never stamps one — Node's own eos() computes premature-close
  // internally without necessarily emitting 'error' on the stream that
  // triggered it, and this tier's own placeholder synthesis mirrors
  // that: firePipelineStageWatcher feeds pipelineFinishImpl directly,
  // it never calls errDispatch on the CURRENT stage).
  //
  // Live-Node re-measurement (node v24.18.1) of this EXACT shape:
  //   final: real
  //   order: x-close,y-err:real,y-close,z-err:Premature close,z-close
  // — x never gets its own 'error' entry; y's real error wins the final
  // callback; z (never touched directly) is torn down with whatever
  // ctx.ERROR held by the time the cascade reaches it a second time
  // (y's real error, since z's own destroy call — from the FIRST,
  // placeholder-carrying cascade pass — already ran before y's real
  // error superseded it: z's OWN 'error' entry still reads "Premature
  // close", proving the cascade's per-stage destroy calls are NOT
  // re-run with the superseding error once a stage is already
  // destroyed — only the FINAL callback reads the latest ctx.ERROR).
  const path = await build("m2-supersede.ts", [
    "import { Readable, PassThrough, Writable, pipeline } from 'node:stream';",
    "const x = new Readable({ read() {} });",
    "const y = new PassThrough();",
    "const z = new Writable({ write(c, e, cb) { cb(); } });",
    "const order: string[] = [];",
    "x.on('close', () => order.push('x-close'));",
    "y.on('close', () => order.push('y-close'));",
    "z.on('close', () => order.push('z-close'));",
    "x.on('error', (e) => order.push('x-err:' + e.message));",
    "y.on('error', (e) => order.push('y-err:' + e.message));",
    "z.on('error', (e) => order.push('z-err:' + e.message));",
    "pipeline(x, y, z, (err: Error | null) => {",
    "  console.log('final:', err ? err.message : 'none');",
    "  console.log('order:', order.join(','));",
    "});",
    "x.destroy();",
    "y.destroy(new Error('real'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["final: real", "order: x-close,y-err:real,y-close,z-err:Premature close,z-close", ""].join("\n"));
  expect(stderr).toBe("");
});

test("pipeline() FAILS a cleanly-destroyed stage with ERR_STREAM_PREMATURE_CLOSE, never a silent hang (M1, live-measured)", async () => {
  // The shape M1 exists to prevent: a stage destroyed with NO error
  // (dst.destroy(), no argument) never reaches 'finish'/'close' the
  // NORMAL way, so a naive "only route a stage's own REAL RS_ERROR
  // through the cascade" implementation would leave PCTX_CLOSED_COUNT
  // stuck below PCTX_N forever — the final callback (or the awaited
  // promise, for sp.pipeline) would simply never settle. M1 routes ANY
  // non-clean watcher status (real error OR the role-based premature-
  // close synthesis) through the SAME pipelineFinishImpl, so a clean
  // manual destroy still counts as a FAILURE and still increments
  // CLOSED_COUNT — no separate code path, no silent hang.
  //
  // Live-Node re-measurement (node v24.18.1): a 2-stage pipeline
  // (source -> dest), `dst.destroy()` with no error, produces
  //   final: Premature close code=ERR_STREAM_PREMATURE_CLOSE
  // promptly (not a hang — the process exits normally afterward).
  const path = await build("m1-clean-destroy.ts", [
    "import { Readable, Writable, pipeline } from 'node:stream';",
    "const src = new Readable({ read() {} });",
    "const dst = new Writable({ write(c, e, cb) { cb(); } });",
    "pipeline(src, dst, (err: NodeJS.ErrnoException | null) => {",
    "  console.log('final:', err ? err.message + ' code=' + err.code : 'none');",
    "});",
    "dst.destroy();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["final: Premature close code=ERR_STREAM_PREMATURE_CLOSE", ""].join("\n"));
  expect(stderr).toBe("");
});

test("pipeline() teardown order: dest errors, source finishes clean, ONE chunk (q9, layer 2/3/6 discriminator)", async () => {
  // The pair-bar discriminator this whole P2-1 fix round converged on:
  // a single-chunk source that finishes CLEAN (push then push(null), one
  // synchronous call) before the destination's write ever errors. This
  // is what exposed the original teardown-order finding (a clean-
  // finished stage's own 'close' landing too LATE relative to the
  // erroring stage's teardown) and, later, the layer-6 residual (the
  // erroring stage's own pipeline cascade never reaching its siblings
  // at all, because pipelineErrThunk was registered through the wrong
  // door — general entryAppend instead of the err-bucket's own
  // errEntryAppend, invisible to errDispatch). Every layer of this
  // round's fix touches this shape's order somewhere.
  //
  // Live-Node re-measurement (node v24.18.1), order-tracking variant:
  //   s-close,w-error:dst-boom,w-close,t-error:dst-boom,t-close,cb:dst-boom
  const path = await build("q9-dest-err-full.ts", [
    "import { Readable, Transform, Writable, pipeline } from 'node:stream';",
    "const order: string[] = [];",
    "const s = new Readable({ read() { this.push('a'); this.push(null); } });",
    "const t = new Transform({ transform(c: Buffer, _e: string, cb: (e: Error | null, o?: Buffer) => void) { cb(null, c); } });",
    "const w = new Writable({ write(_c: Buffer, _e: string, cb: (e?: Error | null) => void) { cb(new Error('dst-boom')); } });",
    "s.on('error', (e: Error) => order.push('s-error:' + e.message));",
    "t.on('error', (e: Error) => order.push('t-error:' + e.message));",
    "w.on('error', (e: Error) => order.push('w-error:' + e.message));",
    "s.on('close', () => order.push('s-close'));",
    "t.on('close', () => order.push('t-close'));",
    "w.on('close', () => order.push('w-close'));",
    "pipeline(s, t, w, (err?: Error | null) => {",
    "  order.push('cb:' + (err !== undefined && err !== null ? err.message : 'clean'));",
    "  console.log(order.join(','));",
    "});",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["s-close,w-error:dst-boom,w-close,t-error:dst-boom,t-close,cb:dst-boom", ""].join("\n"));
  expect(stderr).toBe("");
});

test("pipeline() teardown order: MIDDLE stage errors, source finishes clean, ONE chunk (q10, bounds q9's finding)", async () => {
  // Same "source finishes clean before the error" property as q9, but
  // the MIDDLE stage errors instead of the destination — bounds the
  // finding to the general clean-finish-vs-error race, not something
  // specific to which stage errors.
  //
  // Live-Node re-measurement (node v24.18.1), order-tracking variant:
  //   s-close,t-error:mid-boom,t-close,w-error:mid-boom,w-close,cb:mid-boom
  const path = await build("q10-mid-err-cleansource.ts", [
    "import { Readable, Transform, Writable, pipeline } from 'node:stream';",
    "const order: string[] = [];",
    "const s = new Readable({ read() { this.push('a'); this.push(null); } });",
    "const t = new Transform({ transform(_c: Buffer, _e: string, cb: (e: Error | null, o?: Buffer) => void) { cb(new Error('mid-boom')); } });",
    "const w = new Writable({ write(_c: Buffer, _e: string, cb: () => void) { cb(); } });",
    "s.on('error', (e: Error) => order.push('s-error:' + e.message));",
    "t.on('error', (e: Error) => order.push('t-error:' + e.message));",
    "w.on('error', (e: Error) => order.push('w-error:' + e.message));",
    "s.on('close', () => order.push('s-close'));",
    "t.on('close', () => order.push('t-close'));",
    "w.on('close', () => order.push('w-close'));",
    "pipeline(s, t, w, (err?: Error | null) => {",
    "  order.push('cb:' + (err !== undefined && err !== null ? err.message : 'clean'));",
    "  console.log(order.join(','));",
    "});",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["s-close,t-error:mid-boom,t-close,w-error:mid-boom,w-close,cb:mid-boom", ""].join("\n"));
  expect(stderr).toBe("");
});

test("pipeline() teardown order: dest errors, source finishes clean, TWO chunks (probe08, the gate's own finding shape)", async () => {
  // The reviewer's OWN gate-finding shape (FINDINGS-p2.txt, P2-1): a
  // TWO-chunk source, so the source's OWN read-ahead pacing (does it
  // race through both _read() calls before the destination's error
  // cascade reaches it, or does Node's real per-call pacing hold it
  // back) is exercised on top of q9's single-chunk "clean finish before
  // error" property. This is the shape every corpus claim (1814,
  // probe08/08b as originally built) failed to vary — a 2-chunk source
  // never finishes SOON ENOUGH to race the error, masking the whole
  // class of bug this fix round found. Destroy hooks included (matches
  // the gate's own probe exactly) so the destroy-vs-error ordering is
  // pinned too, not just the event names.
  //
  // Live-Node re-measurement (node v24.18.1), the gate's own oracle:
  //   w-_destroy:dst-boom,s-_destroy,w-error:dst-boom,t-_destroy:dst-boom,
  //   w-close,s-close,t-error:dst-boom,t-close,CALLBACK:dst-boom
  const path = await build("probe08.ts", [
    "import { Readable, Writable, Transform, pipeline } from 'node:stream';",
    "const order: string[] = [];",
    "let n = 0;",
    "const s = new Readable({",
    "  read() { n++; this.push(n <= 2 ? 'p' + n : null); },",
    "  destroy(err: Error | null, cb: (e?: Error | null) => void) { order.push('s-_destroy' + (err ? ':' + err.message : '')); cb(err); },",
    "});",
    "const t = new Transform({",
    "  transform(chunk: Buffer, _enc: string, cb: (e: Error | null, o?: Buffer) => void) { order.push('t._transform:' + chunk.toString()); cb(null, chunk); },",
    "  destroy(err: Error | null, cb: (e?: Error | null) => void) { order.push('t-_destroy' + (err ? ':' + err.message : '')); cb(err); },",
    "});",
    "let wn = 0;",
    "const w = new Writable({",
    "  write(c: Buffer, _e: string, cb: (e?: Error | null) => void) { wn++; order.push('w._write#' + wn + ':' + c.toString()); cb(new Error('dst-boom')); },",
    "  destroy(err: Error | null, cb: (e?: Error | null) => void) { order.push('w-_destroy' + (err ? ':' + err.message : '')); cb(err); },",
    "});",
    "s.on('close', () => order.push('s-close'));",
    "t.on('close', () => order.push('t-close'));",
    "w.on('close', () => order.push('w-close'));",
    "s.on('error', (e: Error) => order.push('s-error:' + e.message));",
    "t.on('error', (e: Error) => order.push('t-error:' + e.message));",
    "w.on('error', (e: Error) => order.push('w-error:' + e.message));",
    "pipeline(s, t, w, (err?: Error | null) => {",
    "  order.push('CALLBACK:' + (err ? err.message : 'null/undefined'));",
    "  console.log(order.filter((s) => !s.startsWith('t._transform') && !s.startsWith('w._write')).join(','));",
    "});",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe([
    "w-_destroy:dst-boom,s-_destroy,w-error:dst-boom,t-_destroy:dst-boom,w-close,s-close,t-error:dst-boom,t-close,CALLBACK:dst-boom",
    "",
  ].join("\n"));
  expect(stderr).toBe("");
});

test("pipeline() transform: a filtering _transform's data-less cb(null) drops the chunk, never push(null)-as-EOF (layer 3's own guard)", async () => {
  // NAMED SIBLING closed out: layer 3's push/completion split guards the
  // immediate push on `data != null` specifically because a filtering
  // transform — legal, common Node code — calls `cb(null)` with NO data
  // to drop a chunk. An unguarded push would call pushCore(null), which
  // means EOF, silently ending the pipeline mid-stream. No corpus claim
  // or prior pin exercised this shape; this is that pin.
  //
  // Live-Node re-measurement (node v24.18.1): "b" is dropped, only "a"
  // and "c" reach the destination, the pipeline finishes clean.
  const path = await build("filtering-transform.ts", [
    "import { Readable, Transform, Writable, pipeline } from 'node:stream';",
    "const chunks = ['a', 'b', 'c'];",
    "let i = 0;",
    "const s = new Readable({ read() { this.push(i < chunks.length ? chunks[i++] : null); } });",
    "const t = new Transform({",
    "  transform(c: Buffer, _e: string, cb: (e: Error | null, o?: Buffer) => void) {",
    "    if (c.toString() === 'b') { cb(null); return; }",
    "    cb(null, c);",
    "  },",
    "});",
    "const w = new Writable({ write(c: Buffer, _e: string, cb: () => void) { console.log('w:', c.toString()); cb(); } });",
    "pipeline(s, t, w, (err?: Error | null) => console.log('cb:', err !== undefined && err !== null ? err.message : 'clean'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["w: a", "w: c", "cb: clean", ""].join("\n"));
  expect(stderr).toBe("");
});
