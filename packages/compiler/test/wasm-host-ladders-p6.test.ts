/* INC-26 pass P6 (brief-p6-v2.md 77aed358d6ca166c/65 + delta-01
 * 58fd63fe6a4b026f/17 + delta-02 eba33a02484f182e/26; cp1-plan-p6.txt
 * 3dd2d6d407ca4eb0/578 + addendum b0feebfff5c49576/233) — the forced-host
 * rows for the fs argument-validation ladders. CHECKPOINT-1 SCOPE: the
 * two keys built so far, fs.toUnixTimestamp and fs.existsChk. CHECKPOINT-2
 * ADDS the remaining ten: mkdtempChk, mkdtempSyncChk, readFileChk,
 * opendirChk, watchFileChk, streamOptsChk, readChk, lchmodChk,
 * lchmodSyncChk, fsp.lchmodChk.
 *
 * SOURCES ARE .cjs, NEVER .ts (R-16, rev-29's own pre-read finding): the
 * ladder spoke (lower-builtins.ts's `lowerFsLadderCall`) lowers ONLY for
 * JavaScript source files (`isJsSourceFile`) — a `.ts` row never produces
 * a fs.*Chk libCall at all, it just keeps the historical fence. P5's own
 * wasm-host-fs-p5.test.ts buildProgram writes `.ts` and is NOT reused
 * here for exactly that reason (its OWN shape is fine for its own pass;
 * this pass needs a different one).
 *
 * ROW VACUITY (P3/P4's own retro rule): every row below carries a
 * SINGLE-EDIT marker naming the one change that would make it fail,
 * except the VACUITY-ROW self-check at the bottom. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync as readFileSyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-ladders-p6-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
/** R-16's own fix: `.cjs`, never `.ts` — the ladder spoke's own gate. */
async function buildProgram(src: string): Promise<string> {
  const file = join(scratch, `p${seq++}.cjs`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message} (${res.diagnostics[0]?.code})`);
  return res.binaryPath!;
}

/** A SCRIPTED fsCall, for the two rows that need a real existsSync
 * answer (op 19 only — wasm-host.ts's shared `runWasm` is LOUD-BY-
 * DEFAULT on every fsCall op, by design, so it cannot serve these). */
async function runForcedExists(binaryPath: string, answers: Map<string, boolean>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  const { instance } = await WebAssembly.instantiate(readFileSyncSync(binaryPath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => clock,
      seed: (): bigint => 0n,
      wallClock: (): number => clock,
      hostStr(): number {
        return -1;
      },
      hostNum(): number {
        return 0;
      },
      exit(code: number): void {
        throw Object.assign(new Error(`exit(${code})`), { __exit: code });
      },
      umask(): number {
        return 0o22;
      },
      fsCall(op: number, aPtr: number, aLen: number): number {
        if (op !== 19) throw new Error(`runForcedExists: unscripted op ${op}`);
        const path = String.fromCharCode(...new Uint16Array(memory!.buffer, aPtr, aLen));
        const hit = answers.get(path);
        if (hit === undefined) throw new Error(`runForcedExists: no scripted answer for path ${JSON.stringify(path)}`);
        return hit ? 0 : -2;
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let exitCode = 0;
  try {
    (instance.exports["_start"] as () => void)();
    const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
    if (tick !== undefined) {
      for (let turns = 0; ; turns++) {
        if (turns > 100_000) throw new Error("pump did not settle");
        const due = tick(clock);
        if (due < 0) break;
        clock = Math.max(clock, due);
      }
    }
  } catch (e) {
    if (e !== null && typeof e === "object" && "__exit" in e) exitCode = (e as { __exit: number }).__exit;
    else throw e;
  }
  return { stdout: Buffer.concat(chunks[1]).toString("utf8"), stderr: Buffer.concat(chunks[2]).toString("utf8"), exitCode };
}

const SHOW_PRELUDE = `'use strict';\nconst show = (fn) => { try { console.log('ret', fn()); } catch (e) { console.log(e.name + '|' + e.code + '|' + e.message); } };\n`;

describe("wasm-host-ladders-p6: fs.toUnixTimestamp", () => {
  test("numeric STRINGS short-circuit and answer their own ToNumber value — oracle 2573 L9/L10/L11 — SINGLE-EDIT: the STR arm's self-equality (n==n) check removed", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs._toUnixTimestamp('1'));\nshow(() => fs._toUnixTimestamp('-1'));\nshow(() => fs._toUnixTimestamp(''));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim().split("\n")).toEqual(["ret 1", "ret -1", "ret 0"]);
  });

  test("a non-numeric string throws Node's exact ERR_INVALID_ARG_TYPE, with its own 'an Time' typo verbatim — oracle 2573 L6 — SINGLE-EDIT: the message template's typo corrected to 'a Time'", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs._toUnixTimestamp('nope'));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "time" argument must be an instance of Date or an Time in seconds. Received type string ('nope')`);
  });

  test("finite non-negative NUMBERS pass through unchanged — oracle 2573 L7/L8 — SINGLE-EDIT: the NUM arm answering wallClock()/1000 unconditionally instead of only when negative", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs._toUnixTimestamp(1));\nshow(() => fs._toUnixTimestamp(1.5));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim().split("\n")).toEqual(["ret 1", "ret 1.5"]);
  });

  test("a negative NUMBER answers now()/1000 — TYPE pinned only (oracle 2573 L12's own rule: Number.isFinite must be true) — reached-only-this-key: no Date.now, no timers, no other fs key in this program, proving dateNowReachable's own 'fs.toUnixTimestamp' line (delta-02) mints wallClock — SINGLE-EDIT: that prescan line removed (M-9; a build-time throw, not a wrong runtime value)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => Number.isFinite(fs._toUnixTimestamp(-1)));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe("ret true");
  });

  test("Infinity/-Infinity/NaN all throw with the exact Received rendering — oracle 2573 L2/L3/L4 — SINGLE-EDIT: the isfinite gate's Infinity comparison flipped to Ne->Eq", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs._toUnixTimestamp(Infinity));\nshow(() => fs._toUnixTimestamp(-Infinity));\nshow(() => fs._toUnixTimestamp(NaN));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim().split("\n")).toEqual([
      `TypeError|ERR_INVALID_ARG_TYPE|The "time" argument must be an instance of Date or an Time in seconds. Received type number (Infinity)`,
      `TypeError|ERR_INVALID_ARG_TYPE|The "time" argument must be an instance of Date or an Time in seconds. Received type number (-Infinity)`,
      `TypeError|ERR_INVALID_ARG_TYPE|The "time" argument must be an instance of Date or an Time in seconds. Received type number (NaN)`,
    ]);
  });

  test("a plain object throws with specificType()'s own 'an instance of Object' — oracle 2573 L5 — SINGLE-EDIT: the throw's specificType() call dropped in favor of a fixed literal", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs._toUnixTimestamp({}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "time" argument must be an instance of Date or an Time in seconds. Received an instance of Object`);
  });
});

describe("wasm-host-ladders-p6: fs.existsChk", () => {
  test("cb must be a function — the ONE throwing arm, both undefined and a non-function object — oracle 2595 L1/L2/L3 — SINGLE-EDIT: the FUNC-kind check inverted (i32.Ne -> i32.Eq)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.exists(__filename));\nshow(() => fs.exists());\nshow(() => fs.exists(__filename, {}));\n`);
    const r = await runWasm(bin);
    const line = `TypeError|ERR_INVALID_ARG_TYPE|The "cb" argument must be of type function. Received `;
    expect(r.stdout.trim().split("\n")).toEqual([`${line}undefined`, `${line}undefined`, `${line}an instance of Object`]);
  });

  test("an unvalidatable path answers callback(false) SYNCHRONOUSLY, its VALUE — oracle 2595 L34 — SINGLE-EDIT: the wart's boxBool literal changed from 0 (false) to 1 (true)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nfs.exists({}, (y) => console.log('cb invalid', y));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe("cb invalid false");
  });

  test("the synchronous-false wart's ORDERING: the callback runs BEFORE the caller's next statement — oracle 2595 L34-before-L35 — SINGLE-EDIT: the wart scheduled through setTimeout(0) instead of calling back inline (rev-29's own §4 caution: never race the REAL answer against a timer — this row races nothing, it proves the wart has NO timer at all)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nfs.exists({}, (y) => console.log('cb invalid', y));\nconsole.log('sync tail');\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim().split("\n")).toEqual(["cb invalid false", "sync tail"]);
  });

  test("a STRING path schedules the REAL probe on a 0ms timer and answers existsSync's own truth — oracle 2595 L38/L39's shape (an existing file true, a missing one false), reached-only-this-key: no Date.now, no 'timers.'-prefixed construct, no other fs key in this program, proving timerSurfaceReachable's + fsCallReachable's own 'fs.existsChk' lines (delta-02) mint `now`/`fsCall` — SINGLE-EDIT: the fire function's STR branch calling existsSyncHelper with the WRONG local (cb's ref instead of path's)", async () => {
    const bin = await buildProgram(
      `${SHOW_PRELUDE}const fs = require('fs');\nfs.exists('/forced/yes', (y) => { console.log('cb file', y); fs.exists('/forced/no', (n) => console.log('cb missing', n)); });\n`,
    );
    const r = await runForcedExists(bin, new Map([["/forced/yes", true], ["/forced/no", false]]));
    expect(r.stdout.trim().split("\n")).toEqual(["cb file true", "cb missing false"]);
  });

  test("a Buffer path is REACHABLE (existsChk's own gate schedules for STR or BYTES; canConvertToDyn accepts bytes<u8>) and traps NAMED, not a bare unreachable — board #155 refusal-shaped gap (no bytes-to-string decode primitive anywhere in this backend; not Node's own behavior — Node answers a Buffer path — so this row has NO oracle line, only the message rev-29's CHECKPOINT-1 review required) — SINGLE-EDIT: deps.namedTrap swapped back for a bare c.unreachable()", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nfs.exists(Buffer.from('/x'), (y) => console.log('cb', y));\n`);
    const r = await runWasmToTrap(bin);
    expect(r.stderr).toContain("fs.exists: a Buffer path has no bytes-to-string decode primitive in this backend (board #155)");
  });
});

/** A SCRIPTED fsCall for op 3 (mkdtemp) — mkdtempSyncChk's own REAL
 * operation, D1's fence-polarity row. Delegates to Node's own
 * mkdtempSync so the row exercises a genuine directory creation, not a
 * canned string. */
async function runForcedMkdtemp(binaryPath: string): Promise<{ stdout: string; stderr: string; exitCode: number; madeDirs: string[] }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  const { mkdtempSync: nodeMkdtempSync } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const madeDirs: string[] = [];
  const { instance } = await WebAssembly.instantiate(readFileSyncSync(binaryPath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => clock,
      seed: (): bigint => 0n,
      wallClock: (): number => clock,
      hostStr(kind: number, _index: number, ptr: number, cap: number): number {
        if (kind === 8) {
          const s = osTmpdir();
          if (s.length > cap) return s.length;
          new Uint16Array(memory!.buffer, ptr, s.length).set([...s].map((c) => c.charCodeAt(0)));
          return s.length;
        }
        return -1;
      },
      hostNum(): number {
        return 0;
      },
      exit(code: number): void {
        throw Object.assign(new Error(`exit(${code})`), { __exit: code });
      },
      umask(): number {
        return 0o22;
      },
      fsCall(op: number, aPtr: number, aLen: number, bPtr: number, bLen: number): number {
        if (op !== 3) throw new Error(`runForcedMkdtemp: unscripted op ${op}`);
        const prefix = String.fromCharCode(...new Uint16Array(memory!.buffer, aPtr, aLen));
        let dir: string;
        try {
          dir = nodeMkdtempSync(prefix);
        } catch {
          return -2;
        }
        madeDirs.push(dir);
        if (dir.length > bLen) return dir.length;
        new Uint16Array(memory!.buffer, bPtr, dir.length).set([...dir].map((c) => c.charCodeAt(0)));
        return dir.length;
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let exitCode = 0;
  try {
    (instance.exports["_start"] as () => void)();
    const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
    if (tick !== undefined) {
      for (let turns = 0; ; turns++) {
        if (turns > 100_000) throw new Error("pump did not settle");
        const due = tick(clock);
        if (due < 0) break;
        clock = Math.max(clock, due);
      }
    }
  } catch (e) {
    if (e !== null && typeof e === "object" && "__exit" in e) exitCode = (e as { __exit: number }).__exit;
    else throw e;
  }
  return { stdout: Buffer.concat(chunks[1]).toString("utf8"), stderr: Buffer.concat(chunks[2]).toString("utf8"), exitCode, madeDirs };
}

describe("wasm-host-ladders-p6: fs.mkdtempChk", () => {
  test("cb not a function throws before prefix is even checked — SINGLE-EDIT: the cb-then-prefix order swapped", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.mkdtemp(true, undefined));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "cb" argument must be of type function. Received undefined`);
  });
  test("a bad prefix throws with the Buffer-or-URL message — oracle 2595 L6 shape — SINGLE-EDIT: the STR|BYTES gate narrowed to STR only", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.mkdtemp(true, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "prefix" argument must be of type string or an instance of Buffer or URL. Received type boolean (true)`);
  });
});

describe("wasm-host-ladders-p6: fs.mkdtempSyncChk", () => {
  test("*** D1 *** encoding is checked BEFORE prefix — a bad prefix AND a bad encoding together name 'encoding', proving Node's real order (the C has it inverted, board #153) — SINGLE-EDIT: mkdtempSyncChk's order mutated INTO the C's (prefix before encoding) — this IS M-7", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.mkdtempSync(0, { encoding: 'zz' }));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_VALUE|The argument 'encoding' is invalid encoding. Received 'zz'`);
  });
  test("a bad prefix alone (valid encoding) throws the prefix message — oracle 2595 L4 — SINGLE-EDIT: the STR|BYTES gate narrowed to STR only", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.mkdtempSync(0, {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "prefix" argument must be of type string or an instance of Buffer or URL. Received type number (0)`);
  });
  test("*** D1 fence polarity *** a plain string prefix with `{}` options RUNS THE REAL mkdtempSync (utf8 semantics kept) — oracle 2595 L7 'made string true true' shape; this row is NOT gate-neutral without D1 — reached-only-this-key for fsCallReachable's own 'fs.mkdtempSyncChk' line (delta-02 CHECKPOINT-2 addition; no Date.now, no timers, no other fsCall consumer) — SINGLE-EDIT: the utf8 gate's polarity inverted back to the C's (`if (utf8 || ...)`)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nconst os = require('os');\nconst made = fs.mkdtempSync(os.tmpdir() + '/p6ladder-', {});\nconsole.log('made', typeof made, made.length > os.tmpdir().length);\n`);
    const r = await runForcedMkdtemp(bin);
    expect(r.stdout.trim()).toBe("made string true");
    expect(r.madeDirs.length).toBe(1);
    const { rm: rmReal } = await import("node:fs/promises");
    await rmReal(r.madeDirs[0]!, { recursive: true, force: true });
  });
  test("a Buffer prefix fences even when every validation passes (the C's own condition, quoted: `prefix->kind != SCR_DYN_STR`) — no oracle line (2595 never supplies a Buffer prefix) — the fence is a REAL catchable Error, caught here by the program's own try/catch — SINGLE-EDIT: the fence gate dropping the prefix-is-STR half of the condition", async () => {
    const bin = await buildProgram(`const fs = require('fs');\ntry { fs.mkdtempSync(Buffer.from('/x-'), {}); } catch (e) { console.log(e.name, e.message.includes('SC2020')); }\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe("Error true");
  });
});

describe("wasm-host-ladders-p6: fs.readFileChk", () => {
  test("cb, THEN assertEncoding, THEN path — a bad encoding throws before the (also-bad) path is reached — oracle 2595 L8 — SINGLE-EDIT: the encoding-then-path order swapped", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.readFile(0, { encoding: 'foo-8' }, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_VALUE|The argument 'encoding' is invalid encoding. Received 'foo-8'`);
  });
  test("readFile('bar.txt') with NO options/cb: Node's `callback ||= options` shape makes the (absent) cb slot the one that throws — oracle 2595 L9 — SINGLE-EDIT: the lowering passing a non-undefined placeholder for a 1-arg call", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.readFile('bar.txt'));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "cb" argument must be of type function. Received undefined`);
  });
  test("EVERYTHING VALID traverses the full ladder to its tail (delta-03 D4/C2-D4: no row previously reached this key's fence — bug 3's own class, a bad cast on a fully-valid path, is invisible to every throwing row) — the fence is a REAL catchable Error, caught here by the program's own try/catch — SINGLE-EDIT: none, a breadth row proving the tail is reached, not a mutable behavior", async () => {
    const bin = await buildProgram(`const fs = require('fs');\ntry { fs.readFile('/tmp/x', () => {}); } catch (e) { console.log(e.name, e.message.includes('SC2020'), e.message.includes('argument')); }\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe("Error true false");
  });
});

describe("wasm-host-ladders-p6: fs.opendirChk", () => {
  test("path THEN assertEncoding — a valid path with a bad encoding names 'encoding' — oracle 2595 L10 — SINGLE-EDIT: the path check dropped", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.opendirSync('.', { encoding: 'no' }));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_VALUE|The argument 'encoding' is invalid encoding. Received 'no'`);
  });
  test("assertEncoding's FALSY GATE: an empty-string encoding passes (reaches the fence, never 'invalid encoding') — measured directly against Node — the fence is a REAL catchable Error, caught here by the program's own try/catch — SINGLE-EDIT: the empty-string short-circuit removed from assertEncoding — this IS M-3", async () => {
    const bin = await buildProgram(`const fs = require('fs');\ntry { fs.opendirSync('.', { encoding: '' }); } catch (e) { console.log('THREW', e.message.includes('SC2020'), e.message.includes('invalid encoding')); }\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe("THREW true false");
  });
  test("M-3's own TRUTHY-INVALID control: 'zz' still throws under the SAME gate that lets '' pass — a gate that accepts everything must not pass this row — SINGLE-EDIT: the falsy gate widened to accept every string", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.opendirSync('.', { encoding: 'zz' }));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_VALUE|The argument 'encoding' is invalid encoding. Received 'zz'`);
  });
});

describe("wasm-host-ladders-p6: fs.watchFileChk", () => {
  test("path THEN listener — a missing listener throws function-type — oracle 2595 L11 — SINGLE-EDIT: the listener FUNC check inverted", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.watchFile('./some-file'));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "listener" argument must be of type function. Received undefined`);
  });
  test("a non-function listener (a string) — oracle 2595 L12 — SINGLE-EDIT: specificType() dropped from the listener throw", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.watchFile('./another-file', {}, 'bad listener'));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "listener" argument must be of type function. Received type string ('bad listener')`);
  });
  test("a bad path (an object) throws BEFORE the listener is ever checked — oracle 2595 L13 — SINGLE-EDIT: the path-then-listener order swapped", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.watchFile(new Object(), () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "path" argument must be of type string or an instance of Buffer or URL. Received an instance of Object`);
  });
  test("EVERYTHING VALID traverses the full ladder to its tail (delta-03 D4/C2-D4) — the fence is a REAL catchable Error, caught here by the program's own try/catch — the trailing process.exit(0) is DEFENSIVE, not load-bearing: the tier's own fence throws before a real watcher is ever armed, so nothing here needs it under wasm; it matters only if this same source were run under real Node, where a still-live fs.watchFile would otherwise keep the process alive — SINGLE-EDIT: none, a breadth row proving the tail is reached, not a mutable behavior", async () => {
    const bin = await buildProgram(`const fs = require('fs');\ntry { fs.watchFile('/tmp/x', () => {}); } catch (e) { console.log(e.name, e.message.includes('SC2020'), e.message.includes('argument')); }\nprocess.exit(0);\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe("Error true false");
  });
});

describe("wasm-host-ladders-p6: fs.streamOptsChk", () => {
  test("*** D2 *** a non-object non-string options value throws Node's 'options' message, NOT the C's own 'encoding' one — additive, no oracle line (2595 never supplies this shape) — SINGLE-EDIT: D2's leading options-shape guard removed", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.createReadStream(46, 5));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "options" argument must be one of type string or object. Received type number (5)`);
  });
  test("options absent, a bad path — oracle 2595 L14 — SINGLE-EDIT: the STR|BYTES gate narrowed to STR only", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.createReadStream(46));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "path" argument must be of type string or an instance of Buffer or URL. Received type number (46)`);
  });
  test("a bad options.fd (a string) — oracle 2595 L16 — SINGLE-EDIT: the options.fd NUM-kind check inverted", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.createReadStream(null, { fd: 'k' }));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "options.fd" property must be of type number or an instance of FileHandle. Received type string ('k')`);
  });
  test("an out-of-range options.fd — additive, no oracle line — SINGLE-EDIT: the fd range's upper bound changed from 2147483647 to 2147483648", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.createReadStream(null, { fd: -1 }));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received -1`);
  });
  test("EVERYTHING VALID traverses the full ladder to its tail (delta-03 D4/C2-D4) — the fence is a REAL catchable Error, caught here by the program's own try/catch — SINGLE-EDIT: none, a breadth row proving the tail is reached, not a mutable behavior", async () => {
    const bin = await buildProgram(`const fs = require('fs');\ntry { fs.createReadStream('/tmp/x'); } catch (e) { console.log(e.name, e.message.includes('SC2020'), e.message.includes('argument')); }\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe("Error true false");
  });
});

describe("wasm-host-ladders-p6: fs.readChk", () => {
  test("*** D2/M-1 *** fd is named BEFORE buffer when BOTH are bad (Node's real order; the C has buffer first — board #153) — oracle 2595 L19 shape — SINGLE-EDIT: readChk's order mutated INTO the C's (buffer before fd) — this IS M-1", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(true, 4, 0, 4, 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "fd" argument must be of type number. Received type boolean (true)`);
  });
  test("fd valid, buffer bad — oracle 2595 L18 — SINGLE-EDIT: the buffer BYTES-kind check inverted", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, 4, 0, 'utf-8', () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "buffer" argument must be an instance of Buffer, TypedArray, or DataView. Received type number (4)`);
  });
  // delta-03 D1/C2-D1 (rev-29's CP2 review): Node's getValidatedFd is
  // validateInt32 — TYPE, then INTEGER (NumberIsInteger), then RANGE —
  // THREE shapes, not the two the brief's own R-4 (measured from -1
  // only) carried. Neither oracle file exercises this (2595 passes only
  // fd=3 and fd=true), so these two rows cite the lead's own probe by
  // hash as their oracle: rev29/probes/p6/rev29-cp2-fd.mjs
  // 419a4a93c562e1ef -> rev29-cp2-fd.out 80ba50b32d4e3b5e.
  test("fd 1.5 (non-integer, still finite), a VALID buffer and valid trailing args (fd the ONLY bad argument) — SHAPE matches the probe's own isolated fd=1.5 case exactly (rev29/probes/p6/rev29-cp2-fd.mjs 419a4a93c562e1ef line 4, `fs.read(1.5, Buffer.alloc(4), 0, 4, 0, ...)`) — 'must be an integer', NOT the range text — oracle rev29-cp2-fd.out 80ba50b32d4e3b5e LINE 2 (post-#14 rider fix: this row previously supplied a bad buffer too, which is a DIFFERENT probe line, out line 6, not this one) — SINGLE-EDIT: rangeChkNum's integer branch removed from fd (M-10)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(1.5, Buffer.allocUnsafe(4), 0, 4, 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "fd" is out of range. It must be an integer. Received 1.5`);
  });
  test("fd NaN, a VALID buffer and valid trailing args (fd the ONLY bad argument) — SHAPE matches the probe exactly (rev29/probes/p6/rev29-cp2-fd.mjs 419a4a93c562e1ef line 5, `fs.read(NaN, Buffer.alloc(4), 0, 4, 0, ...)`) — the SAME 'must be an integer' template (NaN and a fraction share the integer arm, not the range arm) — oracle rev29-cp2-fd.out 80ba50b32d4e3b5e LINE 3 — SINGLE-EDIT: rangeChkNum's integer branch removed from fd (M-10)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(NaN, Buffer.allocUnsafe(4), 0, 4, 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "fd" is out of range. It must be an integer. Received NaN`);
  });
  // post-ACK #17 (a THIRD fd row, restoring the bad-buffer shape rider #14
  // had removed): rev-29's own CP3 read calls this "the STRONGER choice
  // since it also pins fd-wins for a non-integer" — the two rows above
  // isolate fd as the ONLY bad argument; this one pins fd BEFORE buffer
  // on the INTEGER shape specifically, the arm that used to fall through
  // to buffer's own error before D1's fix.
  test("fd 1.5 (non-integer) AND a bad buffer — fd STILL wins over the (also bad) buffer, pinning BOTH the ordering AND the integer check together — SHAPE matches the probe's own combined case exactly (rev29/probes/p6/rev29-cp2-fd.mjs 419a4a93c562e1ef line 8, `fs.read(1.5, 4, 0, 4, 0, ...)`, \"fd=1.5 AND buffer bad\") — oracle rev29-cp2-fd.out 80ba50b32d4e3b5e LINE 6 — SINGLE-EDIT: rangeChkNum's integer branch removed from fd (M-10)", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(1.5, 4, 0, 4, 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "fd" is out of range. It must be an integer. Received 1.5`);
  });
  test("offset NaN — oracle 2595 L20 — SINGLE-EDIT: the isfinite-or-Infinity 'must be an integer' arm removed from rangeChkNum", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), NaN, 4, 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "offset" is out of range. It must be an integer. Received NaN`);
  });
  test("offset -1 — NO buffer-bound message (R-5; the C's own invention, board #153) — oracle 2595 L21 — SINGLE-EDIT: the offset range's lower bound changed from 0 to buflen-relative", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), -1, 4, 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "offset" is out of range. It must be >= 0 && <= 9007199254740991. Received -1`);
  });
  test("*** D2/M-8 *** length -1 WITH a valid position (0): the length bound fires, proving position is checked first but a VALID position does not mask a bad length — oracle 2595 L22 — SINGLE-EDIT: readChk's (5)/(6) swapped INTO the C's order (length bounds before position) — this IS M-8", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), 0, -1, 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "length" is out of range. It must be >= 0. Received -1`);
  });
  test("*** D2 *** length 100 (invalid vs. this 4-byte buffer) WITH a bad position (true): POSITION is named, not length — the discriminating half of M-8's own pair — additive (2595 has no such combined row) — SINGLE-EDIT: position validated after length instead of before", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), 0, 100, true, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "position" argument must be of type bigint or integer. Received type boolean (true)`);
  });
  test("position true (a valid length) — oracle 2595 L23 — SINGLE-EDIT: the position NUM-kind check inverted", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), 0, 4, true, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`TypeError|ERR_INVALID_ARG_TYPE|The "position" argument must be of type bigint or integer. Received type boolean (true)`);
  });
  test("position 0.5 (a valid length) — oracle 2595 L24 — SINGLE-EDIT: the isfinite-or-Infinity 'must be an integer' arm removed from rangeChkNum's position call", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), 0, 4, 0.5, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "position" is out of range. It must be an integer. Received 0.5`);
  });
  test("a large position renders with Node's own underscore grouping (numReceivedHelper reused verbatim, never re-derived) — additive, no oracle line — SINGLE-EDIT: numReceived() swapped for a plain f64-to-string render", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), 0, 4, 9007199254740992, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim()).toBe(`RangeError|ERR_OUT_OF_RANGE|The value of "position" is out of range. It must be >= -1 && <= 9007199254740991. Received 9_007_199_254_740_992`);
  });
  test("a length that COERCES via |=0 from a non-numeric string ('utf-8' -> NaN -> 0), never type/integer-validated — oracle 2595 L18's own gate-neutral partner: a VALID length silently accepted — every check then passes, reaching the fence (a REAL catchable Error, caught here by SHOW_PRELUDE's own try/catch) — additive check on the coercion itself — SINGLE-EDIT: jsToNumber/toInt32 swapped for a type-check throw", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.read(3, Buffer.allocUnsafe(4), 0, 'utf-8', 0, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout).toContain("SC2020");
  });
});

describe("wasm-host-ladders-p6: the lchmod family (D3: Linux arm only)", () => {
  test("fs.lchmod is not a function, regardless of the OTHER (unreached) arguments — oracle 2595 L25/L26/L27 — SINGLE-EDIT: the literal 'fs.lchmod' passed to notFn changed by one character — this IS M-4", async () => {
    const bin = await buildProgram(`${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.lchmod(__filename));\nshow(() => fs.lchmod(__filename, {}));\nshow(() => fs.lchmod(false, 0o777, () => {}));\n`);
    const r = await runWasm(bin);
    expect(r.stdout.trim().split("\n")).toEqual(Array(3).fill("TypeError|undefined|fs.lchmod is not a function"));
  });
  test("fs.lchmodSync is not a function, regardless of the OTHER (unreached) arguments — oracle 2595 L28-L33 — SINGLE-EDIT: the literal 'fs.lchmodSync' passed to notFn changed by one character", async () => {
    const bin = await buildProgram(
      `${SHOW_PRELUDE}const fs = require('fs');\nshow(() => fs.lchmodSync(1));\nshow(() => fs.lchmodSync([]));\nshow(() => fs.lchmodSync(__filename, false));\nshow(() => fs.lchmodSync(__filename, '123x'));\nshow(() => fs.lchmodSync(__filename, -1));\nshow(() => fs.lchmodSync(__filename, 2 ** 32));\n`,
    );
    const r = await runWasm(bin);
    expect(r.stdout.trim().split("\n")).toEqual(Array(6).fill("TypeError|undefined|fs.lchmodSync is not a function"));
  });
  test("fs/promises.lchmod REJECTS ERR_METHOD_NOT_IMPLEMENTED, settled synchronously (S074), before any argument is validated — oracle 2595 L36/L37 — SINGLE-EDIT: the ERR_METHOD_NOT_IMPLEMENTED code dropped from the cell — this IS M-6", async () => {
    const bin = await buildProgram(
      `const fs = require('fs');\n(async () => {\n  try { await fs.promises.lchmod(__filename, {}); } catch (e) { console.log('rejected', e.code); }\n  try { await fs.promises.lchmod(__filename, -1); } catch (e) { console.log('rejected', e.code, e.message); }\n})();\n`,
    );
    const r = await runWasm(bin);
    expect(r.stdout.trim().split("\n")).toEqual(["rejected ERR_METHOD_NOT_IMPLEMENTED", "rejected ERR_METHOD_NOT_IMPLEMENTED The lchmod() method is not implemented"]);
  });
});

describe("wasm-host-ladders-p6: the prescan additions are purely additive", () => {
  test("a program using NONE of the twelve ladder keys emits BYTE-IDENTICAL wasm before and after this checkpoint's three prescan lines + two dispatch cases — the impl-p6/logs/10 (BASE, pre-edit) and /11 (AFTER) module hashes both measured ccabf6ce3e3fafb6 / 14025 bytes — SINGLE-EDIT: none, a breadth row proving additivity, not a mutable behavior", async () => {
    const src = `'use strict';\nconsole.log('hello', 1 + 2, typeof {});\n`;
    const file = join(scratch, `p${seq++}.cjs`);
    await writeFile(file, src);
    const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
    expect(res.ok).toBe(true);
    const bytes = readFileSyncSync(res.binaryPath!);
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(bytes.length).toBe(14025);
    expect(hash).toBe("ccabf6ce3e3fafb6fbc683c2236d4c36453a5759970e658c25dba3793703d5df");
  });
});

// N-3 (rev-29's CP1 review): this instrument counts the LITERAL TOKEN
// "SINGLE-EDIT:" by regex — it cannot distinguish a real single edit from
// the word "none". A breadth row titled "SINGLE-EDIT: none, <reason>"
// satisfies the count by construction, not because the row names an
// edit. The partition below is arithmetically sound either way; this
// note exists so a later reader does not mistake the count for a claim
// that every row is independently mutation-tested (the battery, run and
// rolled up BY ID at each checkpoint, is what actually proves that).
describe("wasm-host-ladders-p6: ROW VACUITY, asserted (P3/P4's own retro rule)", () => {
  test("VACUITY-ROW — the marker count equals this file's own test count, minus this one row: every OTHER test() carries a SINGLE-EDIT marker naming the one change that would redden it, checked by regex against this file's own source, never assumed", async () => {
    const src = readFileSyncSync(new URL(import.meta.url), "utf8");
    const rowsWithMarker = (src.match(/^\s*test\(.*SINGLE-EDIT:/gm) ?? []).length;
    const vacuityRows = (src.match(/^\s*test\("VACUITY-ROW/gm) ?? []).length;
    const testCount = (src.match(/^\s*test\(/gm) ?? []).length;
    expect(vacuityRows, `expected exactly 1 row carrying the VACUITY-ROW token (this row itself), found ${vacuityRows}`).toBe(1);
    expect(rowsWithMarker, `${rowsWithMarker} rows carry SINGLE-EDIT vs ${testCount} test() calls total`).toBe(testCount - 1);
    expect(rowsWithMarker + vacuityRows, "SINGLE-EDIT rows + VACUITY-ROW rows must partition every test() in this file").toBe(testCount);
  });
});
