/* INC-26 pass P4 (design-host-v7.txt cccf7d6e §6, brief-p4-v2.md eac927bd
 * §3H; cp1-plan-p4.txt 50f95ae4 §10) — the FORCED-HOST unit rows for the fs
 * core: every row compares against a table of KNOWN, deliberately non-real
 * values (§10-ii's own rule — a row that reads the real host and compares
 * to the real host proves nothing), never the real filesystem.
 * wasm-host-process-p3.test.ts's OWN shape (a real `compile()`d program run
 * against a scripted `fsCall`), extended for the fs family's own thirteen
 * keys + os.tmpdir/os.homedir.
 *
 * ROW VACUITY (P3's own retro rule, restated here): every row below carries
 * a comment naming the single edit that would make it fail — a row without
 * one is not a row. The per-row marker (spelled out, hyphenated, below the
 * word "vacuity" in this sentence so THIS explanatory paragraph itself
 * never matches its own grep) is asserted BY COUNT against this file's own
 * test count at the bottom: S-I-N-G-L-E hyphen E-D-I-T colon. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-fs-p4-"));
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

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

function writeUtf16(memory: WebAssembly.Memory, s: string, ptr: number, cap: number): number {
  if (s.length > cap) return s.length;
  const view = new Uint16Array(memory.buffer, ptr, s.length);
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
  return s.length;
}
function readUtf16(memory: WebAssembly.Memory, ptr: number, len: number): string {
  const view = new Uint16Array(memory.buffer, ptr, len);
  return String.fromCharCode(...view);
}

/** A single scripted `fsCall` answer: given (op, pathA, contentOrEmptyB,
 * x, y), return the status. The DEFAULT (no host given) throws loudly —
 * every row supplies exactly the op(s) it needs, nothing else. */
type ScriptedFsCall = (op: number, pathA: string, bStr: string, x: number, y: number) => number;

interface ForcedFsHost {
  fsCall?: ScriptedFsCall;
  tmpdir?: string;
  homedir?: string;
  /** R-C: umask's own forced answer, (isRead, mask) -> previous mask. */
  umask?: (isRead: number, mask: number) => number;
}

async function runForced(binaryPath: string, host: ForcedFsHost = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { readFileSync } = await import("node:fs");
  const fsCall = host.fsCall ?? (((op: number) => { throw new Error(`fsCall: unscripted op ${op}`); }) as ScriptedFsCall);
  const umask = host.umask ?? ((isRead: number) => (isRead ? 0o22 : 0o22));
  const { instance } = await WebAssembly.instantiate(readFileSync(binaryPath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => 0,
      seed: (): bigint => 0n,
      wallClock: (): number => 0,
      hostStr(kind: number, index: number, ptr: number, cap: number): number {
        switch (kind) {
          case 0:
            return index === 0 ? writeUtf16(memory!, "scriptc", ptr, cap) : index === 1 ? writeUtf16(memory!, "/forced/host/module.wasm", ptr, cap) : -1;
          case 1:
          case 2:
            return -1; // empty env
          case 3:
            return writeUtf16(memory!, "/forced/cwd", ptr, cap);
          case 4:
            return writeUtf16(memory!, "linux", ptr, cap);
          case 8:
            return writeUtf16(memory!, host.tmpdir ?? "/forced/tmp", ptr, cap);
          case 9:
            return writeUtf16(memory!, host.homedir ?? "/forced/home", ptr, cap);
          default:
            throw new Error(`hostStr: unknown kind ${kind}`);
        }
      },
      hostNum(kind: number): number {
        if (kind === 0) return 2;
        if (kind === 1) return 0;
        throw new Error(`hostNum: unknown kind ${kind}`);
      },
      exit(code: number): void {
        throw new ExitSignal(code);
      },
      umask(isRead: number, mask: number): number {
        return umask(isRead, mask);
      },
      fsCall(op: number, aPtr: number, aLen: number, bPtr: number, bLen: number, x: number, y: number): number {
        const pathA = readUtf16(memory!, aPtr, aLen);
        const bStr = op === 9 || op === 10 ? readUtf16(memory!, bPtr, bLen) : "";
        const status = fsCall(op, pathA, bStr, x, y);
        if (status >= 0 && (op === 1 || op === 2 || op === 3)) {
          // length-returning ops: the SCRIPT answers the CONTENT via a
          // side channel — see each such row's own `write` callback below,
          // called through `fsCall`'s own closure rather than duplicated
          // here (the row supplies a fsCall that WRITES into memory itself
          // before returning, using the SAME `bPtr`/`cap` this dispatch
          // received — threaded via the row's own closure over `memory`).
        }
        return status;
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let exitCode = 0;
  try {
    (instance.exports["_start"] as () => void)();
    const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
    if (tick !== undefined) {
      let clock = 0;
      for (let turns = 0; ; turns++) {
        if (turns > 100_000) throw new Error("pump did not settle");
        const due = tick(clock);
        if (due < 0) break;
        clock = Math.max(clock, due);
      }
    }
    const status = instance.exports["_status"] as (() => number) | undefined;
    exitCode = status?.() ?? 0;
  } catch (err) {
    if (err instanceof ExitSignal) exitCode = err.code;
    else throw err;
  }
  return {
    stdout: Buffer.concat(chunks[1]).toString("utf8"),
    stderr: Buffer.concat(chunks[2]).toString("utf8"),
    exitCode,
  };
}

/** Builds a `fsCall` that answers a LENGTH-RETURNING op (1 readFile, 2
 * readdir, 3 mkdtemp) by writing `resultStr` into the OUTPUT region
 * (bPtr/bLen, the capacity offered) and returning its length — needs
 * direct memory access, so it is constructed PER TEST after `memory` is
 * known; see `runForcedRead` below, which threads it through. */
async function runForcedRead(binaryPath: string, op: number, resultStr: string | ((path: string) => string), opts: { failStatus?: number; capLimit?: number } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { readFileSync } = await import("node:fs");
  const { instance } = await WebAssembly.instantiate(readFileSync(binaryPath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => 0,
      seed: (): bigint => 0n,
      wallClock: (): number => 0,
      hostStr(kind: number, index: number, ptr: number, cap: number): number {
        if (kind === 0) return index === 0 ? writeUtf16(memory!, "scriptc", ptr, cap) : index === 1 ? writeUtf16(memory!, "/forced/host/module.wasm", ptr, cap) : -1;
        if (kind === 1 || kind === 2) return -1;
        if (kind === 3) return writeUtf16(memory!, "/forced/cwd", ptr, cap);
        if (kind === 4) return writeUtf16(memory!, "linux", ptr, cap);
        throw new Error(`hostStr: unknown kind ${kind}`);
      },
      hostNum(kind: number): number {
        if (kind === 0) return 2;
        if (kind === 1) return 0;
        throw new Error(`hostNum: unknown kind ${kind}`);
      },
      exit(code: number): void {
        throw new ExitSignal(code);
      },
      fsCall(callOp: number, aPtr: number, aLen: number, bPtr: number, bLen: number): number {
        if (callOp !== op) throw new Error(`fsCall: expected op ${op}, got ${callOp}`);
        if (opts.failStatus !== undefined) return opts.failStatus;
        const path = readUtf16(memory!, aPtr, aLen);
        const result = typeof resultStr === "function" ? resultStr(path) : resultStr;
        const cap = opts.capLimit ?? bLen;
        if (result.length > cap) return result.length;
        return writeUtf16(memory!, result, bPtr, bLen);
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let exitCode = 0;
  try {
    (instance.exports["_start"] as () => void)();
    const status = instance.exports["_status"] as (() => number) | undefined;
    exitCode = status?.() ?? 0;
  } catch (err) {
    if (err instanceof ExitSignal) exitCode = err.code;
    else throw err;
  }
  return { stdout: Buffer.concat(chunks[1]).toString("utf8"), stderr: Buffer.concat(chunks[2]).toString("utf8"), exitCode };
}

/* ── the twelve codes' own carrier index (op-independent) ─────────────── */
const CODE: Record<string, number> = {
  ENOENT: -1,
  EEXIST: -2,
  EACCES: -3,
  ENOTDIR: -4,
  EISDIR: -5,
  ENOTEMPTY: -6,
  EPERM: -7,
  EBADF: -8,
  EMFILE: -9,
  ENOSPC: -10,
  EINVAL: -11,
  EROFS: -12,
  // delta-3e (e4da1096) R-1, ERRATUM E-P4-3: appended, nothing renumbered.
  ELOOP: -13,
  ENAMETOOLONG: -14,
};

describe("wasm-host-fs-p4: readFileSync (op 1)", () => {
  test("ENOENT: Node's exact one-path message — SINGLE-EDIT: wrong code in fs.ts's CODES[0]", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, open '/x'");
  });
  test("EISDIR: the NO-PATH exception (op 1's own, `read` not `open`) — SINGLE-EDIT: dropping eisdirOverride in buildReadLengthOp('readFileSync', ...)", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.EISDIR });
    expect(r.stdout.trim()).toBe("EISDIR: illegal operation on a directory, read");
  });
  test("ENOTDIR — SINGLE-EDIT: OP_TABLE[1].syscall changed from 'open'", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/a/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.ENOTDIR });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, open '/a/x'");
  });
  test("EACCES — SINGLE-EDIT: CODES[2] name/text swapped", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.EACCES });
    expect(r.stdout.trim()).toBe("EACCES: permission denied, open '/x'");
  });
  test("EMFILE (an ordinary-input-unreached code — the D10 inversion, N-2's own record) — SINGLE-EDIT: CODES[8] name/text", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.EMFILE });
    expect(r.stdout.trim()).toBe("EMFILE: too many open files, open '/x'");
  });
  test("ELOOP (code 13, delta-3e e4da1096 R-1 — reached by ORDINARY readFileSync inputs, a symlink loop; text from util.getSystemErrorMessage(-40), fs-errno-rows.json) — SINGLE-EDIT: CODES[12] name/text", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.ELOOP });
    expect(r.stdout.trim()).toBe("ELOOP: too many symbolic links encountered, open '/x'");
  });
  test("ENAMETOOLONG (code 14, delta-3e e4da1096 R-1 — reached by ORDINARY readFileSync inputs, an overlong path; text from util.getSystemErrorMessage(-36), fs-errno-rows.json) — SINGLE-EDIT: CODES[13] name/text", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.ENAMETOOLONG });
    expect(r.stdout.trim()).toBe("ENAMETOOLONG: name too long, open '/x'");
  });
  test("success: reads the content back exactly — SINGLE-EDIT: the retry loop's B_BASE offset computation", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; console.log(readFileSync("/x", "utf8"));`);
    const r = await runForcedRead(bin, 1, "hello there");
    expect(r.stdout.trim()).toBe("hello there");
  });
  test("the RETRY CONTRACT: a result exceeding the initial 64-code-unit capacity is still read whole — SINGLE-EDIT: the CAP retry not looping (brIf(0) removed)", async () => {
    const long = "y".repeat(500);
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; const s = readFileSync("/x", "utf8"); console.log(s.length, s === "${long}");`);
    const r = await runForcedRead(bin, 1, long);
    expect(r.stdout.trim()).toBe("500 true");
  });
  test("UNKNOWN arm: E<n> code and the module-constant text — SINGLE-EDIT: the sign flip in `n = -256 - status`", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: -(256 + 9999) });
    expect(r.stdout.trim()).toBe("Unknown system error -9999");
  });
});

describe("wasm-host-fs-p4: mkdtempSync (op 3) — the TEMPLATE rule (A-10, mandatory row)", () => {
  test("the TEMPLATE message on failure carries prefix+XXXXXX, never the bare prefix — SINGLE-EDIT: needsXXXXXX=false in buildReadLengthOp('mkdtempSync', ...)", async () => {
    const bin = await buildProgram(`import { mkdtempSync } from "node:fs"; try { mkdtempSync("/nope/p-"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 3, "", { failStatus: CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, mkdtemp '/nope/p-XXXXXX'");
  });
  test("success: returns the host's own created path verbatim — SINGLE-EDIT: reading from A_BASE instead of B_BASE on success", async () => {
    const bin = await buildProgram(`import { mkdtempSync } from "node:fs"; console.log(mkdtempSync("/scratch/p-"));`);
    const r = await runForcedRead(bin, 3, "/scratch/p-aB3xYz");
    expect(r.stdout.trim()).toBe("/scratch/p-aB3xYz");
  });
});

describe("wasm-host-fs-p4: readdirSync (op 2) — the JSON->string[] walk", () => {
  test("a multi-entry JSON array decodes into an ORDERED string[] — SINGLE-EDIT: the vec index off-by-one in the readdir arm's copy loop", async () => {
    const bin = await buildProgram(`import { readdirSync } from "node:fs"; console.log(JSON.stringify(readdirSync("/d")));`);
    const r = await runForcedRead(bin, 2, JSON.stringify(["a.txt", "b.txt", "z"]));
    expect(r.stdout.trim()).toBe(JSON.stringify(["a.txt", "b.txt", "z"]));
  });
  test("an EMPTY directory decodes into an empty array, not an error — SINGLE-EDIT: the vec's newLen(0) path", async () => {
    const bin = await buildProgram(`import { readdirSync } from "node:fs"; console.log(readdirSync("/empty").length);`);
    const r = await runForcedRead(bin, 2, JSON.stringify([]));
    expect(r.stdout.trim()).toBe("0");
  });
  test("ENOTDIR — syscall is `scandir`, the INTERNAL op, never `readdir` — SINGLE-EDIT: OP_TABLE[readdirSync].syscall changed to 'readdir'", async () => {
    const bin = await buildProgram(`import { readdirSync } from "node:fs"; try { readdirSync("/f"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 2, "", { failStatus: CODE.ENOTDIR });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, scandir '/f'");
  });
});

describe("wasm-host-fs-p4: writeFileSync/appendFileSync (ops 9/10) — the two-slot staging", () => {
  test("writeFileSync stages path (slot A) and content (slot B) at DIFFERENT lengths without overlap — SINGLE-EDIT: slot B based at cursor instead of cursor+roundUp(aLen)", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; writeFileSync("/a/short.txt", "this is much longer content than the path"); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (op, pathA, bStr) => {
        if (op !== 9) throw new Error(`unexpected op ${op}`);
        expect(pathA).toBe("/a/short.txt");
        expect(bStr).toBe("this is much longer content than the path");
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("writeFileSync EISDIR — `open`, WITH the path (op 9 has NO exception, unlike op 1) — SINGLE-EDIT: eisdirOverride wrongly added to buildWriteOp", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; try { writeFileSync("/d", "x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EISDIR });
    expect(r.stdout.trim()).toBe("EISDIR: illegal operation on a directory, open '/d'");
  });
  test("appendFileSync ENOENT — SINGLE-EDIT: buildWriteOp('appendFileSync', 10, ...) sending the wrong op number", async () => {
    const bin = await buildProgram(`import { appendFileSync } from "node:fs"; try { appendFileSync("/nope/x", "y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (op) => {
        expect(op).toBe(10);
        return CODE.ENOENT;
      },
    });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, open '/nope/x'");
  });
});

describe("wasm-host-fs-p4: mkdirSync/mkdirRecursiveSync (op 11)", () => {
  test("mkdirSync EEXIST (recursive=0 — the y argument) — SINGLE-EDIT: mkdirSyncHelper's y-const flipped to 1", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; try { mkdirSync("/d"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (op, path, _b, _x, y) => {
        expect(op).toBe(11);
        expect(y).toBe(0);
        return CODE.EEXIST;
      },
    });
    expect(r.stdout.trim()).toBe("EEXIST: file already exists, mkdir '/d'");
  });
  test("mkdirRecursiveSync sends y=1 — SINGLE-EDIT: mkdirRecursiveSyncHelper's y-const flipped to 0", async () => {
    // Statement position ONLY: the return value has NO LOWERING (K-3/
    // S073's own fenced divergence) — reading it is itself a compile-time
    // refusal (SC2020), the fence's own proof, not something this row
    // works around.
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; mkdirSync("/a/b/c", { recursive: true }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (op, _path, _b, _x, y) => {
        expect(op).toBe(11);
        expect(y).toBe(1);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("the fenced return value: reading mkdirSync(..., {recursive:true})'s result is a compile-time refusal, never a silent value (K-3/S073's own proof) — SINGLE-EDIT: none — this row asserts the FENCE itself, not a mutable behavior", async () => {
    const file = join(scratch, `p${seq++}.ts`);
    await writeFile(file, `import { mkdirSync } from "node:fs"; const r = mkdirSync("/a", { recursive: true }); console.log(typeof r);`);
    const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics[0]?.code).toBe("SC2020");
  });
});

describe("wasm-host-fs-p4: rmdirSync (op 12)", () => {
  test("ENOTEMPTY — SINGLE-EDIT: CODES[5] name/text", async () => {
    const bin = await buildProgram(`import { rmdirSync } from "node:fs"; try { rmdirSync("/d"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOTEMPTY });
    expect(r.stdout.trim()).toBe("ENOTEMPTY: directory not empty, rmdir '/d'");
  });
});

describe("wasm-host-fs-p4: unlinkSync (op 13) — the S-1 mandatory row (D10-shaped: built, reached by no P4 program)", () => {
  test("ENOENT — SINGLE-EDIT: unlinkSyncHelper's op-const changed from 13", async () => {
    const bin = await buildProgram(`import { unlinkSync } from "node:fs"; try { unlinkSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (op) => {
        expect(op).toBe(13);
        return CODE.ENOENT;
      },
    });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, unlink '/x'");
  });
});

describe("wasm-host-fs-p4: rmSync/rmOptsSync (op 14) — lstat syscall, force/recursive, the S073 special case", () => {
  test("rmSync ENOENT — syscall is `lstat`, the INTERNAL op — SINGLE-EDIT: OP_TABLE[rmSync].syscall changed to 'rm'", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; try { rmSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (op, _p, _b, x, y) => {
        expect(op).toBe(14);
        expect(x).toBe(0);
        expect(y).toBe(0);
        return CODE.ENOENT;
      },
    });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, lstat '/x'");
  });
  test("rmOptsSync forwards recursive/force as x/y — SINGLE-EDIT: rmOptsSyncHelper swapping x and y", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; rmSync("/x", { recursive: true, force: false }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (op, _p, _b, x, y) => {
        expect(op).toBe(14);
        expect(x).toBe(1);
        expect(y).toBe(0);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("rmOptsSync force=true (recursive=false) forwards y=1, never silently dropped — SINGLE-EDIT: rmOptsSyncHelper's y hardcoded to 0 regardless of force (M-14)", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; rmSync("/x", { recursive: false, force: true }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (op, _p, _b, x, y) => {
        expect(op).toBe(14);
        expect(x).toBe(0);
        expect(y).toBe(1);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("the rm-on-directory SPECIAL CASE: SystemError-shaped message, NO 'EISDIR:' prefix, path UNQUOTED (S073's second sentence) — SINGLE-EDIT: dropping the rmEisdirSpecial pre-check in buildSimpleOp", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; try { rmSync("/adir"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EISDIR });
    expect(r.stdout.trim()).toBe("Path is a directory: rm returned EISDIR (is a directory) /adir");
  });
  test("rmOptsSync force=true ALSO reaches the special case for a directory — SINGLE-EDIT: the special check gated on force/recursive by mistake", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; try { rmSync("/adir", { force: true }); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EISDIR });
    expect(r.stdout.trim()).toBe("Path is a directory: rm returned EISDIR (is a directory) /adir");
  });
});

describe("wasm-host-fs-p4: existsSync (op 19) — PROBE-SHAPED, NEVER throws (A-9's own trap (d))", () => {
  test("0 -> true — SINGLE-EDIT: existsSyncHelper's i32GeS flipped to i32LtS", async () => {
    const bin = await buildProgram(`import { existsSync } from "node:fs"; console.log(existsSync("/x"));`);
    const r = await runForced(bin, { fsCall: () => 0 });
    expect(r.stdout.trim()).toBe("true");
  });
  test("any negative -> false, and NO exception is ever built (M-4's own target) — SINGLE-EDIT: a stray throwCoded call added to existsSyncHelper", async () => {
    // "NO exception is ever built" cannot be checked by watching THIS call
    // alone: existsSync's own call site never runs emitPendingCheck (design
    // §6.2), so a stray pending-cell WRITE here would sit dormant — it is
    // the SAME shared global every other fs op's emitPendingCheck reads,
    // and nothing clears it between calls on the success path. The mkdirSync
    // below is the witness: it answers success (0) on its OWN account and
    // must throw NOTHING under correct code, but would pick up existsSync's
    // dangling flag and throw anyway if the mutation is present.
    const bin = await buildProgram(`
      import { existsSync, mkdirSync } from "node:fs";
      console.log(existsSync("/x"));
      try {
        mkdirSync("/y");
        console.log("no-throw");
      } catch (e) {
        console.log("unexpected-throw");
      }
    `);
    const r = await runForced(bin, { fsCall: (op) => (op === 19 ? CODE.EPERM : 0) });
    expect(r.stdout.trim()).toBe("false\nno-throw");
    expect(r.exitCode).toBe(0);
  });
});

describe("wasm-host-fs-p4: accessSync (op 20) — the mode argument forwarded, F64->i32 at the call site", () => {
  test("default F_OK (mode omitted -> 0) — SINGLE-EDIT: the frontend/emitter default changed from 0", async () => {
    const bin = await buildProgram(`import { accessSync } from "node:fs"; accessSync("/x"); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (op, _p, _b, x) => {
        expect(op).toBe(20);
        expect(x).toBe(0);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("W_OK=2 forwarded, EACCES on mismatch — SINGLE-EDIT: toInt32Helper call dropped before accessSyncHelper", async () => {
    const bin = await buildProgram(`import { accessSync, constants } from "node:fs"; try { accessSync("/x", constants.W_OK); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (op, _p, _b, x) => {
        expect(op).toBe(20);
        expect(x).toBe(2);
        return CODE.EACCES;
      },
    });
    expect(r.stdout.trim()).toBe("EACCES: permission denied, access '/x'");
  });
});

describe("wasm-host-fs-p4: the remaining ordinary-input-unreached codes (N-2's D10 inversion) — a forced host CAN answer any code regardless of whether real fs inputs reach it", () => {
  test("EPERM via unlinkSync — SINGLE-EDIT: CODES[6] name/text", async () => {
    const bin = await buildProgram(`import { unlinkSync } from "node:fs"; try { unlinkSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EPERM });
    expect(r.stdout.trim()).toBe("EPERM: operation not permitted, unlink '/x'");
  });
  test("EBADF via readFileSync — SINGLE-EDIT: CODES[7] name/text", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.EBADF });
    expect(r.stdout.trim()).toBe("EBADF: bad file descriptor, open '/x'");
  });
  test("ENOSPC via writeFileSync — SINGLE-EDIT: CODES[9] name/text", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; try { writeFileSync("/x", "y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOSPC });
    expect(r.stdout.trim()).toBe("ENOSPC: no space left on device, open '/x'");
  });
  test("EINVAL via mkdirSync — SINGLE-EDIT: CODES[10] name/text", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; try { mkdirSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EINVAL });
    expect(r.stdout.trim()).toBe("EINVAL: invalid argument, mkdir '/x'");
  });
  test("EROFS via rmdirSync — SINGLE-EDIT: CODES[11] name/text", async () => {
    const bin = await buildProgram(`import { rmdirSync } from "node:fs"; try { rmdirSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EROFS });
    expect(r.stdout.trim()).toBe("EROFS: read-only file system, rmdir '/x'");
  });
  test("EMFILE via mkdtempSync (a second op reaching an unreached code, not just readFileSync) — SINGLE-EDIT: CODES[8] applied to the wrong op's default syscall", async () => {
    const bin = await buildProgram(`import { mkdtempSync } from "node:fs"; try { mkdtempSync("/p-"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 3, "", { failStatus: CODE.EMFILE });
    expect(r.stdout.trim()).toBe("EMFILE: too many open files, mkdtemp '/p-XXXXXX'");
  });
  test("EACCES via accessSync (a second op reaching this code, not just readFileSync) — SINGLE-EDIT: OP_TABLE[accessSync].syscall changed from 'access'", async () => {
    const bin = await buildProgram(`import { accessSync } from "node:fs"; try { accessSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EACCES });
    expect(r.stdout.trim()).toBe("EACCES: permission denied, access '/x'");
  });
  test("ENOENT via appendFileSync (a second op reaching ENOENT via 'open', not just readFileSync/mkdir) — SINGLE-EDIT: none, a breadth row for the (op,code) matrix", async () => {
    const bin = await buildProgram(`import { appendFileSync } from "node:fs"; try { appendFileSync("/nope/x", "y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, open '/nope/x'");
  });
  test("ENOTDIR via unlinkSync (a third op reaching ENOTDIR, not just readFileSync/mkdir/rmdir/readdir) — SINGLE-EDIT: none, a breadth row", async () => {
    const bin = await buildProgram(`import { unlinkSync } from "node:fs"; try { unlinkSync("/a/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOTDIR });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, unlink '/a/x'");
  });
  test("EEXIST via rmOptsSync (an ordinary code on an op that does not usually raise it, still rendered correctly by the SHARED table) — SINGLE-EDIT: none, a breadth row", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; try { rmSync("/x", { recursive: true, force: false }); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EEXIST });
    expect(r.stdout.trim()).toBe("EEXIST: file already exists, lstat '/x'");
  });
});

describe("wasm-host-fs-p4: the remaining (op, code) pairs from the committed rows file (fs-errno-rows.json), each keyed once", () => {
  test("readdirSync ENOENT — SINGLE-EDIT: none, a breadth row for op 2", async () => {
    const bin = await buildProgram(`import { readdirSync } from "node:fs"; try { readdirSync("/nope"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 2, "", { failStatus: CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, scandir '/nope'");
  });
  test("writeFileSync ENOENT (a missing parent directory) — SINGLE-EDIT: none, a breadth row for op 9", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; try { writeFileSync("/nope/x", "y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, open '/nope/x'");
  });
  test("appendFileSync EISDIR — SINGLE-EDIT: none, a breadth row for op 10 (op 9's own EISDIR row does not prove op 10's arm calls the SAME renderer correctly)", async () => {
    const bin = await buildProgram(`import { appendFileSync } from "node:fs"; try { appendFileSync("/d", "x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EISDIR });
    expect(r.stdout.trim()).toBe("EISDIR: illegal operation on a directory, open '/d'");
  });
  test("mkdirSync ENOENT (a missing parent) — SINGLE-EDIT: none, a breadth row for op 11's mkdirSync key", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; try { mkdirSync("/nope/y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, mkdir '/nope/y'");
  });
  test("mkdirSync ENOTDIR (a path component is a plain file) — SINGLE-EDIT: none, a breadth row for op 11's mkdirSync key", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; try { mkdirSync("/f.txt/y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOTDIR });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, mkdir '/f.txt/y'");
  });
  test("mkdirRecursiveSync ENOTDIR (the SAME shape, through the recursive key) — SINGLE-EDIT: none, proves op 11's TWO frontend keys share one render path", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; try { mkdirSync("/f.txt/y", { recursive: true }); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (op, _p, _b, _x, y) => {
        expect(y).toBe(1);
        return CODE.ENOTDIR;
      },
    });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, mkdir '/f.txt/y'");
  });
  test("rmdirSync ENOENT — SINGLE-EDIT: none, a breadth row for op 12", async () => {
    const bin = await buildProgram(`import { rmdirSync } from "node:fs"; try { rmdirSync("/nope"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, rmdir '/nope'");
  });
  test("rmdirSync ENOTDIR (target is a plain file) — SINGLE-EDIT: none, a breadth row for op 12", async () => {
    const bin = await buildProgram(`import { rmdirSync } from "node:fs"; try { rmdirSync("/f.txt"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOTDIR });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, rmdir '/f.txt'");
  });
  test("unlinkSync EISDIR — the path IS carried here, unlike op 1's own exception (measured: unlinkSync's EISDIR is NOT no-path) — SINGLE-EDIT: unlinkSyncHelper's defaultShape changed to 'no'", async () => {
    const bin = await buildProgram(`import { unlinkSync } from "node:fs"; try { unlinkSync("/d"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EISDIR });
    expect(r.stdout.trim()).toBe("EISDIR: illegal operation on a directory, unlink '/d'");
  });
  test("accessSync ENOTDIR (a path component is a plain file) — SINGLE-EDIT: none, a breadth row for op 20", async () => {
    const bin = await buildProgram(`import { accessSync } from "node:fs"; try { accessSync("/f.txt/y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOTDIR });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, access '/f.txt/y'");
  });
  test("mkdtempSync EACCES (a second code on op 3, not just ENOENT) — SINGLE-EDIT: none, a breadth row", async () => {
    const bin = await buildProgram(`import { mkdtempSync } from "node:fs"; try { mkdtempSync("/root/p-"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 3, "", { failStatus: CODE.EACCES });
    expect(r.stdout.trim()).toBe("EACCES: permission denied, mkdtemp '/root/p-XXXXXX'");
  });
  test("readFileSync ENOTEMPTY (an ordinary code on an op that never raises it in Node, still rendered correctly by the SHARED renderer) — SINGLE-EDIT: none, a breadth row proving the renderer is NOT op-1-specialized", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync("/x", "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 1, "", { failStatus: CODE.ENOTEMPTY });
    expect(r.stdout.trim()).toBe("ENOTEMPTY: directory not empty, open '/x'");
  });
  test("writeFileSync EBADF (a second unreached code, not just ENOSPC) — SINGLE-EDIT: none, a breadth row", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; try { writeFileSync("/x", "y"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EBADF });
    expect(r.stdout.trim()).toBe("EBADF: bad file descriptor, open '/x'");
  });
  test("mkdirSync EPERM (a second unreached code on a second op, not just unlinkSync) — SINGLE-EDIT: none, a breadth row", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; try { mkdirSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EPERM });
    expect(r.stdout.trim()).toBe("EPERM: operation not permitted, mkdir '/x'");
  });
  test("rmSync EMFILE (a second unreached code on op 14) — SINGLE-EDIT: none, a breadth row", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; try { rmSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EMFILE });
    expect(r.stdout.trim()).toBe("EMFILE: too many open files, lstat '/x'");
  });
  test("readdirSync ENOSPC (a second unreached code on op 2) — SINGLE-EDIT: none, a breadth row", async () => {
    const bin = await buildProgram(`import { readdirSync } from "node:fs"; try { readdirSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForcedRead(bin, 2, "", { failStatus: CODE.ENOSPC });
    expect(r.stdout.trim()).toBe("ENOSPC: no space left on device, scandir '/x'");
  });
});

describe("wasm-host-fs-p4: os.tmpdir/os.homedir (hostStr kinds 8/9)", () => {
  test("os.tmpdir prints the forced value — SINGLE-EDIT: hostStrReachable missing the 'os.tmpdir' disjunct (LinkError)", async () => {
    const bin = await buildProgram(`import { tmpdir } from "node:os"; console.log(tmpdir());`);
    const r = await runForced(bin, { tmpdir: "/forced/tmp/xyz" });
    expect(r.stdout.trim()).toBe("/forced/tmp/xyz");
  });
  test("os.homedir prints the forced value — SINGLE-EDIT: kind 8/9 swapped in the emitter's os.tmpdir/os.homedir arms (M-18)", async () => {
    const bin = await buildProgram(`import { tmpdir, homedir } from "node:os"; console.log(tmpdir(), homedir());`);
    const r = await runForced(bin, { tmpdir: "/forced/tmp", homedir: "/forced/home" });
    expect(r.stdout.trim()).toBe("/forced/tmp /forced/home");
  });
});

describe("wasm-host-fs-p4: R-C — process.umask()/process.umaskRead's own P4 rows (the umask/umaskRead split, NOT the P3 file — N-4)", () => {
  test("the 0-ary read form crosses (1, _) — SINGLE-EDIT: M-10, umaskRead wired to (0,0) instead of (1,0)", async () => {
    const bin = await buildProgram(`console.log(process.umask());`);
    let seenIsRead = -1;
    const r = await runForced(bin, {
      umask: (isRead, mask) => {
        seenIsRead = isRead;
        expect(mask).toBe(0);
        return 18;
      },
    });
    expect(seenIsRead).toBe(1);
    expect(r.stdout.trim()).toBe("18");
  });
  test("process.umask(-1) throws RangeError on EVERY lane now (board #142's own fix) — SINGLE-EDIT: reverting the umask arm's split (restoring the -1 sentinel check)", async () => {
    const bin = await buildProgram(`try { process.umask(-1); } catch (e) { if (e instanceof RangeError) console.log(e.message); }`);
    const r = await runForced(bin, { umask: () => 18 });
    expect(r.stdout.trim()).toBe('The value of "mask" is out of range. It must be >= 0 && <= 4294967295. Received -1');
  });
  test("process.umask(0o22) SETS, forwarding (0, 18) — SINGLE-EDIT: the umask arm sending isRead=1 for a real set call", async () => {
    const bin = await buildProgram(`console.log(process.umask(18));`);
    let seenArgs: [number, number] | null = null;
    const r = await runForced(bin, {
      umask: (isRead, mask) => {
        seenArgs = [isRead, mask];
        return 2;
      },
    });
    expect(seenArgs).toEqual([0, 18]);
    expect(r.stdout.trim()).toBe("2");
  });
});

describe("wasm-host-fs-p4: ROW VACUITY, asserted (P3's own retro rule)", () => {
  test("the single-edit marker count equals this file's own test count — a row without one is not a row", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(import.meta.filename, "utf8");
    // Counts ONLY a marker appearing ON THE SAME LINE as a `test(` call
    // (i.e. inside that row's own title string) — excludes THIS test's
    // own source code and comments, which mention the marker's spelling
    // without being a row themselves.
    const rowsWithMarker = (src.match(/^\s*test\(.*SINGLE-EDIT:/gm) ?? []).length;
    const testCount = (src.match(/^\s*test\(/gm) ?? []).length;
    // testCount INCLUDES this very row (it is itself a `test(...)` call),
    // and this row's OWN title carries no marker (asserting the assertion
    // mechanism is exempt) — so the two counts differ by EXACTLY ONE.
    expect(rowsWithMarker, `${rowsWithMarker} rows carry the marker vs ${testCount} test() calls total (expect exactly one test — this one — without a marker)`).toBe(testCount - 1);
  });
});
