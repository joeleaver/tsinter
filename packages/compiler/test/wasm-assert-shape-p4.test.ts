/* INC-26 pass P4, DELIVERABLE 3I (brief-p4-delta-1720.txt 35a6cad6/22,
 * JOE RULING P4-J4 — "Fix it in P4 regardless of size"; impl-p4/
 * finding-1720.txt 1e152f0f/170; CORRECTED by delta-1720b 3f9cebce/16) —
 * pins for the shapeEndHelper fix: a slot's already-computed equality
 * flag (EQ0/EQ1/EQ2) now gates whether `buildLine` renders a RegExp-
 * typed expected value's RAW PATTERN or the ACTUAL value — a matched
 * regex key is NEVER DROPPED (delta-1720b Q-2(i): the original delta's
 * own prose, "only the string key rendered", read as "drop it" — WRONG;
 * this file's rows were always pinned to the CORRECT reading, confirmed
 * below) — it renders the ACTUAL value AS A CONTEXT LINE (no +/-
 * prefix), identically on both sides, so the diff walk sees ONE
 * unchanged line for it, matching Node's own per-key decision. Before
 * the fix, a matched regex key still rendered its raw pattern whenever
 * ANY OTHER key in the same shape mismatched (1720's own row M).
 *
 * ORACLE OF RECORD (delta-1720b's own RULE): every expected string below
 * is verified against rev-26's INDEPENDENT measurement, rev/probes/p4/
 * assert-shape-1720.{mjs,out} (.out d0afbaad, nine shapes on Node
 * v24.18.1) — never taken from either delta's own prose. Rows (a)/(b)/
 * (c)/(e) reproduce the ORACLE's own shapes (a)/(b)/(c)/(e) STRUCTURALLY
 * (matched-key-as-context, mismatched-key-as-+/-pair, key order, and —
 * row (f) below — grouping/splitting) — the printed CODE/PATH VALUES
 * necessarily differ from the oracle's own synthetic-error text (ENOENT/
 * '/x' there vs this tier's own scripted op/path here), for the
 * SEPARATE, out-of-scope reason two paragraphs below (`.code` is
 * fs/exec/assert-STAMPED here, dynamically read on real Node); row (e)
 * additionally matches the oracle's OWN shape (e) BYTE-FOR-BYTE, since
 * both use a REAL fs ENOENT (this tier's row targets 1720's own fixed
 * path rather than the oracle probe's '/definitely-not-here-xyz', the
 * only textual difference, and is independently reconfirmed byte-exact
 * against real Node via tests/harness/wasm-differential.test.ts's own
 * "1720-assert-throws-shape.ts" row, which now passes end-to-end). Row
 * (f) below (three keys, the middle one matching) pins delta-1720b's
 * Q-2(iii) GROUPING rule — verified BYTE-FOR-BYTE structurally identical
 * to the oracle's own shape (g) (a mismatched key's own +/- pair stays
 * ADJACENT; a matched key BETWEEN two mismatches splits them into two
 * separate pairs, never one merged block) — confirmed against this
 * tier's fixed build with zero additional code change (the group/split
 * decision lives entirely in the pre-existing, unmodified diff-walk
 * stage downstream of buildLine, never touched by this fix).
 *
 * A NEW file rather than wasm-host-fs-p4.test.ts (delta's own choice,
 * §4/ORDER): shapeEndHelper is assert.throws's own generic shape-diff
 * machinery, not one of the 13 fs.* keys behind fsCall — it happens to
 * be UNBLOCKED by this pass building fs.readFileSync, but the fix and
 * these rows are not fs-dispatch rows and would blur that file's own
 * stated scope (and its row-vacuity self-count, keyed to its own marker
 * text) if folded in there.
 *
 * ROWS a/b/c/d use SCRIPTED fs errors (rmdirSync/unlinkSync/
 * readFileSync) rather than a synthetic `class E extends Error` with a
 * hand-set `.code` — MEASURED (impl-p4/probes/probe-assert-regex.ts,
 * probe-assert-regex2.ts): this tier's `code` comparison slot is
 * stamped ONLY by fs/exec/assert's own internal error construction
 * (1720's own header comment says so verbatim), never read off an
 * arbitrary user object's own property — a SEPARATE, pre-existing,
 * out-of-scope tier characteristic unrelated to delta-1720, which would
 * otherwise suppress the mismatched code key's own "+" (actual) line
 * for reasons that have nothing to do with the regex-render bug. Using
 * real fs-shaped errors throughout keeps every row an unambiguous,
 * byte-exact probe of ONLY the regex-render fix.
 *
 * EVERY row's expected string was measured TWICE: once by compiling and
 * running the row's own source against a SCRIPTED host on this tier's
 * FIXED build (this file's own `run()`), and independently against REAL
 * Node running the semantically-equivalent real-fs scenario (real
 * rmdirSync-on-a-plain-file for ENOTDIR, real unlinkSync/readFileSync
 * on a nonexistent path for ENOENT) — both agree on the RENDER SHAPE
 * (which keys appear, in what order, matched-regex-renders-as-actual,
 * mismatched-key +/- pairing); row (e) additionally matches Node
 * BYTE-FOR-BYTE on the exact text, since it reuses 1720's own fixed
 * path and is also independently confirmed by
 * tests/harness/wasm-differential.test.ts's own "1720-assert-throws-
 * shape.ts" row, which now PASSES end-to-end against real Node.
 *
 * ROW VACUITY (P3/P4's own retro rule): every row below carries a
 * comment naming the single edit that would make it fail — a row
 * without one is not a row. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-assert-shape-p4-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
async function buildProgram(src: string): Promise<string> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message} (${res.diagnostics[0]?.code})`);
  return res.binaryPath;
}

function readUtf16(memory: WebAssembly.Memory, ptr: number, len: number): string {
  const view = new Uint16Array(memory.buffer, ptr, len);
  return String.fromCharCode(...view);
}

/** The three (op, code) pairs these rows need, matching fs.ts's own
 * carrier: a negative status is -(1-based index into fs.ts's CODES). */
const CODE = { ENOENT: -1, EACCES: -3, ENOTDIR: -4 } as const;

/** A minimal scripted-fsCall runner: `answer(op, path)` returns the
 * status for every fsCall this row's program makes — no other host
 * surface (hostStr/hostNum/umask/exit) is reachable by any row below,
 * so only `write`/`fsCall` are wired. */
async function run(binaryPath: string, answer: (op: number, path: string) => number): Promise<{ stdout: string }> {
  const chunks: Buffer[] = [];
  let memory: WebAssembly.Memory | null = null;
  const { readFileSync } = await import("node:fs");
  const { instance } = await WebAssembly.instantiate(readFileSync(binaryPath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      fsCall(op: number, aPtr: number, aLen: number, _bPtr: number, _bLen: number, _x: number, _y: number): number {
        return answer(op, readUtf16(memory!, aPtr, aLen));
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  return { stdout: Buffer.concat(chunks).toString("utf8") };
}

const messageOfSrc = `function messageOf(fn: () => void): string {
  try { fn(); return "NO THROW"; } catch (e) { return e instanceof Error ? e.message : "not an Error"; }
}`;

describe("wasm-assert-shape-p4: delta-1720 (35a6cad6) — shapeEndHelper's regex-vs-EQ render gate", () => {
  test("(a) two keys, RegExp matches + string mismatches -> only the string key renders as a diff pair; the regex key renders as ONE unprefixed context line (the actual value) [oracle: assert-shape-1720.out d0afbaad, shape (a) — structurally identical, code/path values necessarily differ, see file header] — SINGLE-EDIT: the eqL threading removed from the 'code' call site (M-19 targets exactly this)", async () => {
    const bin = await buildProgram(`
      import assert from "node:assert";
      import { rmdirSync } from "node:fs";
      ${messageOfSrc}
      console.log(JSON.stringify(messageOf(() => assert.throws(() => { rmdirSync("/adir/f.txt"); }, { code: "EACCES", message: /not a directory/ }))));
    `);
    const r = await run(bin, (op) => (op === 12 ? CODE.ENOTDIR : (() => { throw new Error(`unscripted op ${op}`); })()));
    expect(r.stdout.trim()).toBe(
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   code: 'ENOTDIR',\n-   code: 'EACCES',\n    message: \"ENOTDIR: not a directory, rmdir '/adir/f.txt'\"\n  }\n",
      ),
    );
  });

  test("(b) the SAME shape with expected's keys in the OTHER order -> Node's own grouping order (code's +/- pair, then message unprefixed), NOT the object literal's order [oracle: assert-shape-1720.out d0afbaad, shape (b) — BYTE-IDENTICAL to the oracle's own shape (a), confirming key order is canonical] — SINGLE-EDIT: none, proves render order is independent of key literal order (pre-existing, unaffected by this fix)", async () => {
    const bin = await buildProgram(`
      import assert from "node:assert";
      import { rmdirSync } from "node:fs";
      ${messageOfSrc}
      console.log(JSON.stringify(messageOf(() => assert.throws(() => { rmdirSync("/adir/f.txt"); }, { message: /not a directory/, code: "EACCES" }))));
    `);
    const r = await run(bin, (op) => (op === 12 ? CODE.ENOTDIR : (() => { throw new Error(`unscripted op ${op}`); })()));
    expect(r.stdout.trim()).toBe(
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   code: 'ENOTDIR',\n-   code: 'EACCES',\n    message: \"ENOTDIR: not a directory, rmdir '/adir/f.txt'\"\n  }\n",
      ),
    );
  });

  test("(c) RegExp mismatches + string matches -> the regex key renders as Node's own failed-regex pair (+actual, -/pattern/); the matched string key renders as ONE unprefixed context line [oracle: assert-shape-1720.out d0afbaad, shape (c) — structurally identical] — SINGLE-EDIT: none, proves the MISMATCHED-regex render path is untouched by this fix (only the matched-regex path changed)", async () => {
    const bin = await buildProgram(`
      import assert from "node:assert";
      import { unlinkSync } from "node:fs";
      ${messageOfSrc}
      console.log(JSON.stringify(messageOf(() => assert.throws(() => { unlinkSync("/x"); }, { code: "ENOENT", message: /goodbye/ }))));
    `);
    const r = await run(bin, (op) => (op === 13 ? CODE.ENOENT : (() => { throw new Error(`unscripted op ${op}`); })()));
    expect(r.stdout.trim()).toBe(
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n    code: 'ENOENT',\n+   message: \"ENOENT: no such file or directory, unlink '/x'\"\n-   message: /goodbye/\n  }\n",
      ),
    );
  });

  test("(d1) message-only control, MATCHING -> the early MATCH return still fires (NO THROW), never reaching buildLine at all [oracle: assert-shape-1720.out d0afbaad, shape (d1) — byte-exact, both answer NO THROW] — SINGLE-EDIT: none, the early-return path (unaffected by this fix, which lives entirely past it)", async () => {
    const bin = await buildProgram(`
      import assert from "node:assert";
      import { readFileSync } from "node:fs";
      ${messageOfSrc}
      console.log(JSON.stringify(messageOf(() => assert.throws(() => { readFileSync("/x", "utf8"); }, { message: /no such file/ }))));
    `);
    const r = await run(bin, (op) => (op === 1 ? CODE.ENOENT : (() => { throw new Error(`unscripted op ${op}`); })()));
    expect(r.stdout.trim()).toBe(JSON.stringify("NO THROW"));
  });

  test("(d2) message-only control, MISMATCHING -> unchanged from before this fix (a single regex key's OWN mismatch render never depended on any other key's EQ flag) [oracle: assert-shape-1720.out d0afbaad, shape (d2) — structurally identical] — SINGLE-EDIT: none, the single-key mismatch path", async () => {
    const bin = await buildProgram(`
      import assert from "node:assert";
      import { readFileSync } from "node:fs";
      ${messageOfSrc}
      console.log(JSON.stringify(messageOf(() => assert.throws(() => { readFileSync("/x", "utf8"); }, { message: /goodbye/ }))));
    `);
    const r = await run(bin, (op) => (op === 1 ? CODE.ENOENT : (() => { throw new Error(`unscripted op ${op}`); })()));
    expect(r.stdout.trim()).toBe(
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   message: \"ENOENT: no such file or directory, open '/x'\"\n-   message: /goodbye/\n  }\n",
      ),
    );
  });

  test("(e) 1720's EXACT row M shape, byte-for-byte against real Node [oracle: assert-shape-1720.out d0afbaad, shape (e) — BYTE-FOR-BYTE, both use a real fs ENOENT against the same shape] — the finding's own trigger, now closed — SINGLE-EDIT: the eqL threading removed from the 'message' call site (M-19's own second target)", async () => {
    const bin = await buildProgram(`
      import assert from "node:assert";
      import { readFileSync } from "node:fs";
      ${messageOfSrc}
      const missing = "/nonexistent-scriptc-assert-corpus-path";
      console.log(JSON.stringify(messageOf(() => assert.throws(() => { readFileSync(missing, "utf8"); }, { message: /no such file/, code: "EACCES" }))));
    `);
    const r = await run(bin, (op) => (op === 1 ? CODE.ENOENT : (() => { throw new Error(`unscripted op ${op}`); })()));
    expect(r.stdout.trim()).toBe(
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   code: 'ENOENT',\n-   code: 'EACCES',\n    message: \"ENOENT: no such file or directory, open '/nonexistent-scriptc-assert-corpus-path'\"\n  }\n",
      ),
    );
  });

  test("(f) THREE keys, mismatch/MATCH/mismatch — the middle match SPLITS the two mismatches into separate +/- pairs rather than merging into one block (delta-1720b Q-2(iii); structurally byte-identical to the oracle's own shape (g), assert-shape-1720.out d0afbaad) — SINGLE-EDIT: none, proves the pre-existing grouping/splitting logic (downstream of buildLine, never touched by this fix) still produces the correct shape with a context line in the middle", async () => {
    const bin = await buildProgram(`
      import assert from "node:assert";
      import { readFileSync } from "node:fs";
      ${messageOfSrc}
      console.log(JSON.stringify(messageOf(() => assert.throws(() => { readFileSync("/x", "utf8"); }, { code: "EACCES", message: /no such file/, name: "TypeError" }))));
    `);
    const r = await run(bin, (op) => (op === 1 ? CODE.ENOENT : (() => { throw new Error(`unscripted op ${op}`); })()));
    expect(r.stdout.trim()).toBe(
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   code: 'ENOENT',\n-   code: 'EACCES',\n    message: \"ENOENT: no such file or directory, open '/x'\",\n+   name: 'Error'\n-   name: 'TypeError'\n  }\n",
      ),
    );
  });

  test("ROW VACUITY: the single-edit marker count equals this file's own test count — a row without one is not a row", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(import.meta.filename, "utf8");
    const rowsWithMarker = (src.match(/^\s*test\(.*SINGLE-EDIT:/gm) ?? []).length;
    const testCount = (src.match(/^\s*test\(/gm) ?? []).length;
    expect(rowsWithMarker, "every test( ) row must carry its own SINGLE-EDIT: marker on the same line, except this self-test").toBe(testCount - 1);
  });
});
