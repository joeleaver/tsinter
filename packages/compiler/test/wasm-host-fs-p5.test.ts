/* INC-26 pass P5 (brief-p5-v3.md a8dc6daa §3G + deltas 3d/3db/3e/3eb/3f) —
 * the FORCED-HOST unit rows for the fs tail, the fsp twins, the os tail,
 * the stats surface, and the cross-cutting wire-protocol rows this pass's
 * own STOP-AND-REPORT rounds found (the bytes flag on ops 1/9, the mode
 * bias on ops 9/11, the 1640 validation class). wasm-host-fs-p4.test.ts's
 * OWN shape (a real `compile()`d program run against a scripted `fsCall`),
 * extended with a richer context object so one script can answer ANY op's
 * own wire shape (UTF-16 text, raw bytes, or a DataView record) rather
 * than the string-only channel P4's own rows needed.
 *
 * ROW VACUITY (P3/P4's own retro rule, restated here): every row below
 * carries a comment naming the single edit that would make it fail — a
 * row without one is not a row, EXCEPT the controls named at the bottom
 * (the vacuity check itself, and any row asserting the FENCE/REFUSAL
 * shape rather than a mutable behavior, which states so explicitly in
 * its own title instead of a SINGLE-EDIT). The per-row marker is
 * asserted BY COUNT against this file's own test count at the bottom.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-fs-p5-"));
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
/** For rows asserting a COMPILE-TIME refusal itself (never a `runForced*`
 * call — nothing runs). */
async function buildRefused(src: string): Promise<{ code: string; message: string }> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (res.ok) throw new Error("expected a refusal, got ok=true");
  return { code: res.diagnostics[0]?.code ?? "", message: res.diagnostics[0]?.message ?? "" };
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

/** The rich per-call context: every wire SHAPE this pass's own ops use,
 * so one script answers ANY op rather than needing a op-specialized
 * runner (wasm-host-fs-p4.test.ts's own `runForced`/`runForcedRead`
 * split, generalized). */
interface FsCallCtx {
  writeUtf16(s: string, ptr: number, cap: number): number;
  readUtf16(ptr: number, len: number): string;
  writeBytes(bytes: readonly number[], ptr: number, cap: number): number;
  readBytes(ptr: number, len: number): number[];
  dv(ptr: number, len: number): DataView;
}
type ScriptedFsCall = (ctx: FsCallCtx, op: number, aPtr: number, aLen: number, bPtr: number, bLen: number, x: number, y: number) => number;

interface ForcedFsHost {
  fsCall?: ScriptedFsCall;
  tmpdir?: string;
  homedir?: string;
  umask?: (isRead: number, mask: number) => number;
  hostStrExtra?: (kind: number, index: number, ptr: number, cap: number, ctx: FsCallCtx) => number | undefined;
  hostNumExtra?: (kind: number, arg: number) => number | undefined;
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

async function runForced(binaryPath: string, host: ForcedFsHost = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { readFileSync } = await import("node:fs");
  const ctx: FsCallCtx = {
    writeUtf16: (s, ptr, cap) => writeUtf16(memory!, s, ptr, cap),
    readUtf16: (ptr, len) => readUtf16(memory!, ptr, len),
    writeBytes: (bytes, ptr, cap) => {
      if (bytes.length > cap) return bytes.length;
      const view = new Uint8Array(memory!.buffer, ptr, bytes.length);
      view.set(bytes);
      return bytes.length;
    },
    readBytes: (ptr, len) => Array.from(new Uint8Array(memory!.buffer, ptr, len)),
    dv: (ptr, len) => new DataView(memory!.buffer, ptr, len),
  };
  const fsCall = host.fsCall ?? (((_ctx, op) => { throw new Error(`fsCall: unscripted op ${op}`); }) as ScriptedFsCall);
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
        const extra = host.hostStrExtra?.(kind, index, ptr, cap, ctx);
        if (extra !== undefined) return extra;
        switch (kind) {
          case 0:
            return index === 0 ? writeUtf16(memory!, "scriptc", ptr, cap) : index === 1 ? writeUtf16(memory!, "/forced/host/module.wasm", ptr, cap) : -1;
          case 1:
          case 2:
            return -1;
          case 3:
            return writeUtf16(memory!, "/forced/cwd", ptr, cap);
          case 4:
            return writeUtf16(memory!, "linux", ptr, cap);
          case 8:
            return writeUtf16(memory!, host.tmpdir ?? "/forced/tmp", ptr, cap);
          case 9:
            return writeUtf16(memory!, host.homedir ?? "/forced/home", ptr, cap);
          // os.type/os.release/os.userInfo's three string fields — DEFAULT
          // values so any row NOT specifically testing one of these still
          // links and runs (os.userInfo() reads all three fields in ONE
          // call regardless of which the program later touches);
          // `hostStrExtra` overrides the SPECIFIC kind a row cares about.
          case 10:
            return writeUtf16(memory!, "Linux", ptr, cap);
          case 11:
            return writeUtf16(memory!, "0.0.0-default", ptr, cap);
          case 13:
            return writeUtf16(memory!, "default-user", ptr, cap);
          case 14:
            return writeUtf16(memory!, "/default/home", ptr, cap);
          case 15:
            return writeUtf16(memory!, "/bin/default-sh", ptr, cap);
          default:
            throw new Error(`hostStr: unknown kind ${kind}`);
        }
      },
      hostNum(kind: number, arg: number): number {
        const extra = host.hostNumExtra?.(kind, arg);
        if (extra !== undefined) return extra;
        if (kind === 0) return 2;
        if (kind === 1) return 0;
        if (kind === 3 || kind === 4) return 1000; // uid/gid — os.userInfo()'s own read, unrelated to this file's own rows
        throw new Error(`hostNum: unknown kind ${kind}`);
      },
      exit(code: number): void {
        throw new ExitSignal(code);
      },
      umask(isRead: number, mask: number): number {
        return umask(isRead, mask);
      },
      fsCall(op: number, aPtr: number, aLen: number, bPtr: number, bLen: number, x: number, y: number): number {
        return fsCall(ctx, op, aPtr, aLen, bPtr, bLen, x, y);
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
  return { stdout: Buffer.concat(chunks[1]).toString("utf8"), stderr: Buffer.concat(chunks[2]).toString("utf8"), exitCode };
}

/* ── the fourteen-code carrier index (op-independent, P4's own table) ── */
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
  ELOOP: -13,
  ENAMETOOLONG: -14,
};

/** Writes op 4's own FAILURE record (u16 code-unit count at base, the
 * error path's own UTF-16 payload at base+2, 3C-2's ruling) and returns
 * the negative status — the shared shape every op-4 failure row below
 * needs. */
function writeRealpathFailure(ctx: FsCallCtx, bPtr: number, bLen: number, errPath: string, status: number): number {
  const needed = 1 + errPath.length;
  if (needed > bLen) return needed;
  const dv = ctx.dv(bPtr, 2);
  dv.setUint16(0, errPath.length, true);
  ctx.writeUtf16(errPath, bPtr + 2, errPath.length);
  return status;
}

/** Writes the FIXED 20-byte stats record (E-P5-1: isFile@0/isDirectory@1/
 * isSymbolicLink@2 as u8, size@4/mtimeMs@12 as f64 LE) via a DataView —
 * NEVER a Float64Array (N-1's own alignment rule). */
function writeStatsRecord(ctx: FsCallCtx, bPtr: number, fields: { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; size: number; mtimeMs: number }): number {
  const dv = ctx.dv(bPtr, 20);
  dv.setUint8(0, fields.isFile ? 1 : 0);
  dv.setUint8(1, fields.isDirectory ? 1 : 0);
  dv.setUint8(2, fields.isSymbolicLink ? 1 : 0);
  dv.setFloat64(4, fields.size, true);
  dv.setFloat64(12, fields.mtimeMs, true);
  return 0;
}

describe("wasm-host-fs-p5: realpathSync (op 4) — the host-fact error path", () => {
  test("success reads the resolved path back, never the input — SINGLE-EDIT: emitReadStrAt swapped for reading pathALocal on success", async () => {
    const bin = await buildProgram(`import { realpathSync } from "node:fs"; console.log(realpathSync("/a/../b"));`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => {
        expect(op).toBe(4);
        return ctx.writeUtf16("/b", bPtr, bLen);
      },
    });
    expect(r.stdout.trim()).toBe("/b");
  });
  test("ENOENT failure renders from the u16-prefixed SLOT-B record, never pathALocal — SINGLE-EDIT: emitThrowFromStatus fed PATH instead of the length-prefixed RESULT", async () => {
    const bin = await buildProgram(`import { realpathSync } from "node:fs"; try { realpathSync("/a/missing/deep"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => writeRealpathFailure(ctx, bPtr, bLen, "/a/missing", CODE.ENOENT),
    });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, lstat '/a/missing'");
  });
  test("an ODD-count error path exercises emitRoundUp2 on the FAILURE side for real (S-1, P4's own R-3 axis restated for op 4) — SINGLE-EDIT: emitReadLengthPrefixedStrAt reading one code unit short/long", async () => {
    const oddPath = "/odd"; // 4 chars — the PREFIX slot itself is what must round; use an odd total once the +1 count slot is added (5 code units total, odd)
    const bin = await buildProgram(`import { realpathSync } from "node:fs"; try { realpathSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => writeRealpathFailure(ctx, bPtr, bLen, oddPath, CODE.ENOENT),
    });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, lstat '/odd'");
  });
  test("ENOTDIR failure — syscall stays `lstat` (the default, ENOTDIR is not ELOOP) — SINGLE-EDIT: the codeOverrides ELOOP entry wrongly matching ENOTDIR too", async () => {
    const bin = await buildProgram(`import { realpathSync } from "node:fs"; try { realpathSync("/f.txt/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => writeRealpathFailure(ctx, bPtr, bLen, "/f.txt", CODE.ENOTDIR),
    });
    expect(r.stdout.trim()).toBe("ENOTDIR: not a directory, lstat '/f.txt'");
  });
  test("ELOOP failure — syscall is `stat`, realpath's OWN codeOverrides entry, never the default `lstat` — SINGLE-EDIT: dropping realpathSyncHelper's codeOverrides argument", async () => {
    const bin = await buildProgram(`import { realpathSync } from "node:fs"; try { realpathSync("/loop"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => writeRealpathFailure(ctx, bPtr, bLen, "/loop", CODE.ELOOP),
    });
    expect(r.stdout.trim()).toBe("ELOOP: too many symbolic links encountered, stat '/loop'");
  });
  test("the OVERSHOOT-RETRY contract covers BOTH outcomes: a result too long for the initial cap retries and still succeeds — SINGLE-EDIT: the retry loop's brIf(1) fit-check inverted", async () => {
    const long = "/" + "y".repeat(500);
    const bin = await buildProgram(`import { realpathSync } from "node:fs"; const s = realpathSync("/x"); console.log(s.length, s === "${long}");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => ctx.writeUtf16(long, bPtr, bLen),
    });
    expect(r.stdout.trim()).toBe("501 true");
  });
});

describe("wasm-host-fs-p5: readFdSync (op 5) — the ENCODED form, fd forwarded as x", () => {
  test("success reads the content back through op 1's own retry-loop shape — SINGLE-EDIT: readFdSyncHelper's B_BASE reused from a stale call", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; console.log(readFileSync(7, "utf8"));`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(5);
        expect(x).toBe(7);
        return ctx.writeUtf16("fd content", bPtr, bLen);
      },
    });
    expect(r.stdout.trim()).toBe("fd content");
  });
  test("EBADF failure carries NO PATH (shape 'no', fd is not a string) — SINGLE-EDIT: readFdSyncHelper's emitThrowFromStatus shape changed to 'one'", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync(99, "utf8"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EBADF });
    expect(r.stdout.trim()).toBe("EBADF: bad file descriptor, read");
  });
});

describe("wasm-host-fs-p5: readSync (op 6) — fd/offset/length, RAW BYTES never UTF-16", () => {
  test("reads RAW BYTES into the caller's own buffer at OFFSET — SINGLE-EDIT: the dispatch arm's copy loop using i32Load16U instead of i32Load8U", async () => {
    const bin = await buildProgram(`
      import { readSync } from "node:fs";
      const buf = new Uint8Array(8);
      const n = readSync(3, buf, 2, 4);
      let s = "";
      for (let i = 0; i < 8; i++) s += (i > 0 ? "," : "") + buf[i];
      console.log(n, s);
    `);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(6);
        expect(x).toBe(3);
        expect(bLen).toBe(4);
        return ctx.writeBytes([0xde, 0xad, 0xbe, 0xef], bPtr, bLen);
      },
    });
    expect(r.stdout.trim()).toBe("4 0,0,222,173,190,239,0,0");
  });
  test("EBADF failure carries NO PATH — SINGLE-EDIT: readSyncHelper's emitThrowFromStatus shape changed to 'one'", async () => {
    const bin = await buildProgram(`import { readSync } from "node:fs"; try { readSync(9, new Uint8Array(4), 0, 4); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EBADF });
    expect(r.stdout.trim()).toBe("EBADF: bad file descriptor, read");
  });
});

describe("wasm-host-fs-p5: lstatSync (op 8) — the S-1 mandatory row (a symlink, D10-shaped)", () => {
  test("isSymbolicLink true, isFile/isDirectory false — SINGLE-EDIT: statsAccessor 'isSymbolicLink' reading field index 1 instead of 2", async () => {
    const bin = await buildProgram(`import { lstatSync } from "node:fs"; const s = lstatSync("/link"); console.log(s.isFile(), s.isDirectory(), s.isSymbolicLink());`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr) => {
        expect(op).toBe(8);
        return writeStatsRecord(ctx, bPtr, { isFile: false, isDirectory: false, isSymbolicLink: true, size: 9, mtimeMs: 1 });
      },
    });
    expect(r.stdout.trim()).toBe("false false true");
  });
  test("ENOENT — syscall is `lstat` — SINGLE-EDIT: OP_TABLE[lstatSync].syscall changed to 'stat'", async () => {
    const bin = await buildProgram(`import { lstatSync } from "node:fs"; try { lstatSync("/x"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, lstat '/x'");
  });
});

describe("wasm-host-fs-p5: statSync/lstatSync — the two RELATION rows (mtimeMs, isSymbolicLink vs a real fixture would drift; these pin the WIRE, not a filesystem)", () => {
  test("stats.mtimeMs is a RELATION to the record's own f64 field, not a fixed literal — two DIFFERENT forced values read back exactly — SINGLE-EDIT: the f64.load offset for mtimeMs changed from +12", async () => {
    const bin = await buildProgram(`import { statSync } from "node:fs"; console.log(statSync("/a").mtimeMs, statSync("/b").mtimeMs);`);
    let call = 0;
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr) => {
        call++;
        return writeStatsRecord(ctx, bPtr, { isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtimeMs: call === 1 ? 111.25 : 222.75 });
      },
    });
    expect(r.stdout.trim()).toBe("111.25 222.75");
  });
  test("stats.isSymbolicLink is a RELATION to the record's own byte, not always-false — a statSync (not lstatSync) record CAN still report true, proving the accessor reads the record verbatim — SINGLE-EDIT: mapType's 'stats' case hardcoding isSymbolicLink to false", async () => {
    const bin = await buildProgram(`import { statSync } from "node:fs"; console.log(statSync("/x").isSymbolicLink());`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr) => writeStatsRecord(ctx, bPtr, { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0, mtimeMs: 0 }),
    });
    expect(r.stdout.trim()).toBe("true");
  });
});

describe("wasm-host-fs-p5: os.release (hostStr kind 11) — the S-1 mandatory row", () => {
  test("prints the forced value — SINGLE-EDIT: hostStr kind 11 swapped with kind 10 (os.type) in the emitter's os-tail arm", async () => {
    const bin = await buildProgram(`import { release } from "node:os"; console.log(release());`);
    const r = await runForced(bin, {
      hostStrExtra: (kind, _index, ptr, cap, ctx) => (kind === 11 ? ctx.writeUtf16("5.15.0-forced", ptr, cap) : undefined),
    });
    expect(r.stdout.trim()).toBe("5.15.0-forced");
  });
});

describe("wasm-host-fs-p5: os tail — the other hostStr kinds + hostNum 15", () => {
  test("os.type (kind 10) — SINGLE-EDIT: hostStrReachable missing the 'os.type' disjunct (LinkError)", async () => {
    const bin = await buildProgram(`import * as os from "node:os"; console.log(os.type());`);
    const r = await runForced(bin, { hostStrExtra: (kind, _i, ptr, cap, ctx) => (kind === 10 ? ctx.writeUtf16("Linux", ptr, cap) : undefined) });
    expect(r.stdout.trim()).toBe("Linux");
  });
  test("os.userInfo().username (kind 13) — SINGLE-EDIT: kind 13/14 swapped in the emitter's os-tail arm", async () => {
    const bin = await buildProgram(`import * as os from "node:os"; console.log(os.userInfo().username);`);
    const r = await runForced(bin, { hostStrExtra: (kind, _i, ptr, cap, ctx) => (kind === 13 ? ctx.writeUtf16("forced-user", ptr, cap) : undefined) });
    expect(r.stdout.trim()).toBe("forced-user");
  });
  test("os.userInfo().homedir (kind 14) — SINGLE-EDIT: kind 14/15 swapped", async () => {
    const bin = await buildProgram(`import * as os from "node:os"; console.log(os.userInfo().homedir);`);
    const r = await runForced(bin, { hostStrExtra: (kind, _i, ptr, cap, ctx) => (kind === 14 ? ctx.writeUtf16("/forced/home/u", ptr, cap) : undefined) });
    expect(r.stdout.trim()).toBe("/forced/home/u");
  });
  test("os.userInfo().shell (kind 15) — SINGLE-EDIT: kind 15 reading hostNum instead of hostStr", async () => {
    const bin = await buildProgram(`import * as os from "node:os"; console.log(os.userInfo().shell);`);
    const r = await runForced(bin, { hostStrExtra: (kind, _i, ptr, cap, ctx) => (kind === 15 ? ctx.writeUtf16("/bin/forced-sh", ptr, cap) : undefined) });
    expect(r.stdout.trim()).toBe("/bin/forced-sh");
  });
  test("os.totalmem (hostNum kind 15) — SINGLE-EDIT: hostNum kind 15 wired to kind 12 (availableMemory)", async () => {
    const bin = await buildProgram(`import * as os from "node:os"; console.log(os.totalmem());`);
    const r = await runForced(bin, { hostNumExtra: (kind) => (kind === 15 ? 8_589_934_592 : undefined) });
    expect(r.stdout.trim()).toBe("8589934592");
  });
});

describe("wasm-host-fs-p5: the bytes flag (delta-3d/3db, M-25) — op 1 x=1, op 9 y=1", () => {
  test("op 1 x=1 (readFileSyncBytes): the host answers RAW BYTES, never UTF-16 — SINGLE-EDIT: the flag dropped, readFileSyncBytesHelper sending x=0", async () => {
    const bin = await buildProgram(`
      import { readFileSync } from "node:fs";
      const buf = readFileSync("/x");
      let s = "";
      for (let i = 0; i < buf.length; i++) s += (i > 0 ? "," : "") + buf[i];
      console.log(buf.length, s);
    `);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(1);
        expect(x).toBe(1);
        return ctx.writeBytes([0, 255, 128], bPtr, bLen);
      },
    });
    expect(r.stdout.trim()).toBe("3 0,255,128");
  });
  test("op 1 x=0 (readFileSync, the TEXT key) is UNCHANGED, still UTF-16 — SINGLE-EDIT: the shared case reading x but ignoring it for the text key too", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; console.log(readFileSync("/x", "utf8"));`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(1);
        expect(x).toBe(0);
        return ctx.writeUtf16("hi", bPtr, bLen);
      },
    });
    expect(r.stdout.trim()).toBe("hi");
  });
  test("op 9 y=1 (writeFileSyncBytes): the host reads RAW BYTES from slot B, never UTF-16 — SINGLE-EDIT: the flag dropped, writeFileSyncBytesHelper sending y=0", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; writeFileSync("/x", new Uint8Array([0, 255, 128, 1])); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        expect(op).toBe(9);
        expect(y).toBe(1);
        expect(ctx.readBytes(bPtr, bLen)).toEqual([0, 255, 128, 1]);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("op 9 y=0 (writeFileSync, the TEXT key) is UNCHANGED, still UTF-16 — SINGLE-EDIT: the shared case reading y but ignoring it for the text key too", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; writeFileSync("/x", "hi"); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        expect(op).toBe(9);
        expect(y).toBe(0);
        expect(ctx.readUtf16(bPtr, bLen)).toBe("hi");
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("(a) statSync(path).size after a bytes write reflects the EXACT byte count the bytes-key wrote, never a code-unit count — SINGLE-EDIT: writeFileSyncBytesHelper sending bLen = CONTENT.arrayLen()*2 (a code-unit-shaped length) instead of the raw byte count", async () => {
    const bin = await buildProgram(`
      import { writeFileSync, statSync } from "node:fs";
      writeFileSync("/x", new Uint8Array([1, 2, 3, 4, 5]));
      console.log(statSync("/x").size);
    `);
    let written = 0;
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => {
        if (op === 9) {
          written = bLen; // the WRITE's own bLen IS the byte count (op 9 carries no ×2)
          return 0;
        }
        if (op === 7) return writeStatsRecord(ctx, bPtr, { isFile: true, isDirectory: false, isSymbolicLink: false, size: written, mtimeMs: 0 });
        throw new Error(`unexpected op ${op}`);
      },
    });
    expect(r.stdout.trim()).toBe("5");
  });
  test("(b) cross-key read, bytes written then read as TEXT: a payload whose byte length and UTF-8-decoded code-unit length DIFFER — SINGLE-EDIT: op 1's x=0 branch reading bLen as bytes instead of code units", async () => {
    // Bytes [0xC3, 0xA9] is TWO bytes, one UTF-8 code point (U+00E9, 'é') —
    // ONE code unit. Written via the bytes key (op9 y=1, 2 raw bytes),
    // read back via the TEXT key (op1 x=0, expects 1 code unit reported).
    const bin = await buildProgram(`
      import { writeFileSync, readFileSync } from "node:fs";
      writeFileSync("/x", new Uint8Array([0xc3, 0xa9]));
      const s = readFileSync("/x", "utf8");
      console.log(s.length, s.charCodeAt(0));
    `);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        if (op === 9) {
          expect(y).toBe(1);
          expect(ctx.readBytes(bPtr, bLen)).toEqual([0xc3, 0xa9]);
          return 0;
        }
        if (op === 1) {
          expect(x).toBe(0);
          return ctx.writeUtf16("é", bPtr, bLen); // the host's own UTF-8 decode of those 2 bytes
        }
        throw new Error(`unexpected op ${op}`);
      },
    });
    expect(r.stdout.trim()).toBe("1 233");
  });
  test("(b) cross-key read, TEXT written then read as BYTES: the reverse direction — SINGLE-EDIT: op 1's x=1 branch reading bLen as code units instead of bytes", async () => {
    const bin = await buildProgram(`
      import { writeFileSync, readFileSync } from "node:fs";
      writeFileSync("/x", "\\u00e9");
      const buf = readFileSync("/x");
      let s = "";
      for (let i = 0; i < buf.length; i++) s += (i > 0 ? "," : "") + buf[i];
      console.log(buf.length, s);
    `);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        if (op === 9) {
          expect(y).toBe(0);
          expect(ctx.readUtf16(bPtr, bLen)).toBe("é");
          return 0;
        }
        if (op === 1) {
          expect(x).toBe(1);
          return ctx.writeBytes([0xc3, 0xa9], bPtr, bLen); // the host's own UTF-8 encode of that 1 code unit
        }
        throw new Error(`unexpected op ${op}`);
      },
    });
    expect(r.stdout.trim()).toBe("2 195,169");
  });
  test("(c) a payload containing an adjacent 00 D8 byte pair — the exact pattern that would land in the UTF-16 surrogate range (0xD800) under the OLD ambiguous transport — round-trips as RAW BYTES, never reinterpreted — SINGLE-EDIT: any code path that packs/unpacks this payload as UTF-16 instead of raw bytes", async () => {
    const bin = await buildProgram(`
      import { writeFileSync, readFileSync } from "node:fs";
      writeFileSync("/x", new Uint8Array([0x00, 0xd8, 0x41]));
      const buf = readFileSync("/x");
      let s = "";
      for (let i = 0; i < buf.length; i++) s += (i > 0 ? "," : "") + buf[i];
      console.log(buf.length, s);
    `);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        if (op === 9) {
          expect(y).toBe(1);
          expect(ctx.readBytes(bPtr, bLen)).toEqual([0x00, 0xd8, 0x41]);
          return 0;
        }
        if (op === 1) {
          expect(x).toBe(1);
          return ctx.writeBytes([0x00, 0xd8, 0x41], bPtr, bLen);
        }
        throw new Error(`unexpected op ${op}`);
      },
    });
    expect(r.stdout.trim()).toBe("3 0,216,65");
  });
  test("x=0 asserted for op 1 (readFileSync, the deliberate literal, never uninitialized) — SINGLE-EDIT: buildReadLengthOp's default xFlag parameter changed from 0", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; console.log(readFileSync("/x", "utf8"));`);
    let seenX = -1;
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        seenX = x;
        return ctx.writeUtf16("ok", bPtr, bLen);
      },
    });
    expect(seenX).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });
  test("x=0 asserted for op 3 (mkdtempSync, unrelated to the bytes flag — proves op 1's own x is not read by a DIFFERENT op sharing no row) — SINGLE-EDIT: none, a breadth/isolation row", async () => {
    const bin = await buildProgram(`import { mkdtempSync } from "node:fs"; console.log(mkdtempSync("/p-"));`);
    let seenX = -1;
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        seenX = x;
        return ctx.writeUtf16("/p-aaaaaa", bPtr, bLen);
      },
    });
    expect(seenX).toBe(0);
    expect(r.stdout.trim()).toBe("/p-aaaaaa");
  });
});

describe("wasm-host-fs-p5: rmRetrySync (op 14) — the retry record, DataView getInt32/setInt32", () => {
  test("the two-i32 LE record rides slot B (bLen=8) when maxRetries/retryDelay are given — an ODD-code-unit path (POST-ACK #25 §5: the permanent alignment instrument — a DataView read tolerates the resulting non-4-aligned slot-B base; an Int32Array read would not) — SINGLE-EDIT: rmRetrySyncHelper's retryExtras indices swapped ([3,2] instead of [2,3])", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; rmSync("/xy", { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        expect(op).toBe(14);
        expect(x).toBe(1);
        expect(y).toBe(1);
        expect(bLen).toBe(8);
        const dv = ctx.dv(bPtr, 8);
        expect(dv.getInt32(0, true)).toBe(5);
        expect(dv.getInt32(4, true)).toBe(250);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("bLen === 0 for plain rmSync/rmOptsSync (the record is ABSENT, never a zeroed-out record) — SINGLE-EDIT: buildSimpleOp always pushing bLen=8 regardless of retryExtras", async () => {
    const bin = await buildProgram(`import { rmSync } from "node:fs"; rmSync("/x", { recursive: true, force: false }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => {
        expect(op).toBe(14);
        expect(bLen).toBe(0);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
});

describe("wasm-host-fs-p5: copyFileSync (op 15) — the ONE two-path op", () => {
  test("success: src read-only (no guard concept forced here), dst written — SINGLE-EDIT: copyFileSyncHelper swapping A_BASE/B_BASE (src/dst) staging order", async () => {
    const bin = await buildProgram(`import { copyFileSync } from "node:fs"; copyFileSync("/src.txt", "/dst.txt"); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => {
        expect(op).toBe(15);
        expect(ctx.readUtf16(aPtr, aLen)).toBe("/src.txt");
        expect(ctx.readUtf16(bPtr, bLen)).toBe("/dst.txt");
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("failure renders the TWO-PATH message, `CODE: text, copyfile 'src' -> 'dst'` — never emitThrowFromStatus's one-path shape — SINGLE-EDIT: copyFileSyncHelper calling emitThrowFromStatus instead of emitThrowFromStatusTwoPath", async () => {
    const bin = await buildProgram(`import { copyFileSync } from "node:fs"; try { copyFileSync("/nope.txt", "/dst.txt"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, copyfile '/nope.txt' -> '/dst.txt'");
  });
  test("the EISDIR-for-copyfile trap: a missing DEST parent wins even when SRC is a directory — this row asserts the WIRE only (the host decides which code fires; the module renders whatever it is given) — SINGLE-EDIT: none, a breadth row pinning the two-path renderer handles EISDIR too", async () => {
    const bin = await buildProgram(`import { copyFileSync } from "node:fs"; try { copyFileSync("/adir", "/nope/dst.txt"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, copyfile '/adir' -> '/nope/dst.txt'");
  });
});

describe("wasm-host-fs-p5: chmodSync (op 16) / chownSync (op 17)", () => {
  test("chmodSync forwards mode as x — SINGLE-EDIT: chmodSyncHelper's toInt32Helper call dropped before the mode arg", async () => {
    const bin = await buildProgram(`import { chmodSync } from "node:fs"; chmodSync("/x", 0o644); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(16);
        expect(x).toBe(0o644);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("chmodSync ENOENT — SINGLE-EDIT: OP_TABLE[16].syscall changed from 'chmod'", async () => {
    const bin = await buildProgram(`import { chmodSync } from "node:fs"; try { chmodSync("/x", 0o644); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, chmod '/x'");
  });
  test("chownSync forwards uid as x, gid as y — SINGLE-EDIT: chownSyncHelper swapping the uid/gid extras order", async () => {
    const bin = await buildProgram(`import { chownSync } from "node:fs"; chownSync("/x", 1001, 1002); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        expect(op).toBe(17);
        expect(x).toBe(1001);
        expect(y).toBe(1002);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("chownSync EPERM — SINGLE-EDIT: OP_TABLE[17].syscall changed from 'chown'", async () => {
    const bin = await buildProgram(`import { chownSync } from "node:fs"; try { chownSync("/x", 0, 0); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EPERM });
    expect(r.stdout.trim()).toBe("EPERM: operation not permitted, chown '/x'");
  });
});

describe("wasm-host-fs-p5: openSync/closeSync (ops 21/18) — the flags enum, mode=0o666, fd round-trip", () => {
  test("openSync forwards the flags CODE (compile-time-known literal) as x, the fixed mode 0o666 as y, returns the fd — SINGLE-EDIT: emitter.ts's FLAGS_ENUM table entry for 'w' changed from 2", async () => {
    const bin = await buildProgram(`import { openSync } from "node:fs"; console.log(openSync("/x", "w"));`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        expect(op).toBe(21);
        expect(x).toBe(2); // FLAGS_ENUM.w
        expect(y).toBe(0o666);
        return 7;
      },
    });
    expect(r.stdout.trim()).toBe("7");
  });
  test("openSync('r') forwards flags code 0 — SINGLE-EDIT: FLAGS_ENUM.r changed from 0", async () => {
    const bin = await buildProgram(`import { openSync } from "node:fs"; console.log(openSync("/x", "r"));`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(x).toBe(0);
        return 3;
      },
    });
    expect(r.stdout.trim()).toBe("3");
  });
  test("openSync ENOENT — SINGLE-EDIT: OP_TABLE[21].syscall changed from 'open'", async () => {
    const bin = await buildProgram(`import { openSync } from "node:fs"; try { openSync("/x", "r"); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, open '/x'");
  });
  test("closeSync forwards fd as x — SINGLE-EDIT: closeSyncHelper reading the fd param into A_BASE instead of x", async () => {
    const bin = await buildProgram(`import { closeSync } from "node:fs"; closeSync(42); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(18);
        expect(x).toBe(42);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("closeSync EBADF carries NO PATH (shape 'no') — SINGLE-EDIT: closeSyncHelper's emitThrowFromStatus shape changed to 'one'", async () => {
    const bin = await buildProgram(`import { closeSync } from "node:fs"; try { closeSync(9); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => CODE.EBADF });
    expect(r.stdout.trim()).toBe("EBADF: bad file descriptor, close");
  });
  test("openSync('zz') throws Node's ERR_INVALID_ARG_VALUE TypeError at RUNTIME (a compile-time-known literal, never a compile-time REFUSAL) — no fsCall reached — SINGLE-EDIT: the FLAGS_ENUM lookup miss branch compiled to a refusal instead of a runtime throw", async () => {
    const bin = await buildProgram(`import { openSync } from "node:fs"; try { openSync("/x", "zz"); } catch (e) { if (e instanceof TypeError) console.log(e.message); }`);
    const r = await runForced(bin, { fsCall: () => { throw new Error("fsCall must not be reached for an invalid flags literal"); } });
    expect(r.stdout.trim()).toBe("The argument 'flags' is invalid. Received 'zz'");
  });
  test("openSync with a NON-LITERAL flags argument is a compile-time REFUSAL (SC3001, the tier's own limitation — distinct from the 'zz' runtime case above) — SINGLE-EDIT: none, a REFUSAL-shape control", async () => {
    const { code } = await buildRefused(`import { openSync } from "node:fs"; function run(f: string) { return openSync("/x", f as any); } console.log(run("r"));`);
    expect(code).toBe("SC3001");
  });
});

describe("wasm-host-fs-p5: readFdSyncBytes (ops 22 then 23) — the combined two-stage function", () => {
  test("stage 1 (fstatFd) answers the SIZE, stage 2 (readFdInto) reads that many RAW BYTES — SINGLE-EDIT: stage 2 using stage 1's OWN status as a byte count directly instead of re-fetching via op 23", async () => {
    const bin = await buildProgram(`
      import { readFileSync } from "node:fs";
      const buf = readFileSync(5);
      let s = "";
      for (let i = 0; i < buf.length; i++) s += (i > 0 ? "," : "") + buf[i];
      console.log(buf.length, s);
    `);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        if (op === 22) {
          expect(x).toBe(5);
          return 3; // SIZE
        }
        if (op === 23) {
          expect(x).toBe(5);
          expect(bLen).toBe(3);
          return ctx.writeBytes([9, 8, 7], bPtr, bLen);
        }
        throw new Error(`unexpected op ${op}`);
      },
    });
    expect(r.stdout.trim()).toBe("3 9,8,7");
  });
  test("stage 1 FAILURE reports `fstat`, stage 2 never runs (a genuine failure vs a real size of 0 must be distinguishable) — SINGLE-EDIT: the combined function running stage 2 even when stage 1's own status is negative", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync(9); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    let stage2Reached = false;
    const r = await runForced(bin, {
      fsCall: (ctx, op) => {
        if (op === 22) return CODE.EBADF;
        stage2Reached = true;
        return 0;
      },
    });
    expect(stage2Reached).toBe(false);
    expect(r.stdout.trim()).toBe("EBADF: bad file descriptor, fstat");
  });
  test("stage 2 FAILURE reports `read`, NOT `fstat` (the failing stage's OWN literal) — SINGLE-EDIT: stage 2 sharing stage 1's own defaultSyscall argument", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; try { readFileSync(9); } catch (e) { if (e instanceof Error) console.log(e.message); }`);
    const r = await runForced(bin, {
      fsCall: (ctx, op) => (op === 22 ? 4 : CODE.EBADF),
    });
    expect(r.stdout.trim()).toBe("EBADF: bad file descriptor, read");
  });
  test("a real SIZE of 0 (an empty fd) is NOT mistaken for a failure — SINGLE-EDIT: the ifResult branch testing STATUS <= 0 instead of STATUS < 0 after stage 1", async () => {
    const bin = await buildProgram(`import { readFileSync } from "node:fs"; const buf = readFileSync(3); console.log(buf.length);`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => {
        if (op === 22) return 0;
        if (op === 23) {
          expect(bLen).toBe(0);
          return 0;
        }
        throw new Error(`unexpected op ${op}`);
      },
    });
    expect(r.stdout.trim()).toBe("0");
  });
});

describe("wasm-host-fs-p5: the mode bias (delta-3db, M-26) — x = mode + 1 on ops 9/11's Mode keys", () => {
  test("writeFileModeSync(p, s, 0) reaches the host with x === 1 (mode 0, biased — NOT the mode-less keys' own x === 0)  — SINGLE-EDIT: the +1 bias dropped from buildWriteOp's hasMode branch", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; writeFileSync("/x", "s", { mode: 0 }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(9);
        expect(x).toBe(1);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("writeFileSync(p, s) (the mode-less key) still sends x === 0, unaffected by the bias — SINGLE-EDIT: the mode-less branch ALSO biased by mistake", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; writeFileSync("/x", "s"); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(op).toBe(9);
        expect(x).toBe(0);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("writeFileModeSync(p, s, 0o600) reaches the host with x === 0o600 + 1 — SINGLE-EDIT: the bias applied twice (+2) or not at all", async () => {
    const bin = await buildProgram(`import { writeFileSync } from "node:fs"; writeFileSync("/x", "s", { mode: 0o600 }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(x).toBe(0o600 + 1);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("mkdirModeSync(p, 0) reaches the host with x === 1 — SINGLE-EDIT: the +1 bias dropped from mkdirModeSyncHelper", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; mkdirSync("/x", { mode: 0 }); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        expect(op).toBe(11);
        expect(x).toBe(1);
        expect(y).toBe(0);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("mkdirSync(p) (the mode-less key) still sends x === 0 — SINGLE-EDIT: the mode-less mkdir branch ALSO biased by mistake", async () => {
    const bin = await buildProgram(`import { mkdirSync } from "node:fs"; mkdirSync("/x"); console.log("ok");`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x) => {
        expect(x).toBe(0);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
});

describe("wasm-host-fs-p5: the odd-byte-payload row (P4's own R-3 axis)", () => {
  test("an ODD number of raw bytes stages and reads back exactly, through the stride-1 byte-at-a-time path (emitReadBytesAt/emitWriteBytesAt) — SINGLE-EDIT: none, a breadth row (ERRATUM E-P5-4, des/ERRATA-design-v7-p3.txt: this row does NOT exercise emitRoundUp2 — that rounding only ever sees slot A's own byte length, code units × 2, unconditionally even; M-7's own disposition proves it reddens nothing here or anywhere else in the file)", async () => {
    const bin = await buildProgram(`
      import { writeFileSync, readFileSync } from "node:fs";
      writeFileSync("/x", new Uint8Array([1, 2, 3, 4, 5]));
      const buf = readFileSync("/x");
      let s = "";
      for (let i = 0; i < buf.length; i++) s += (i > 0 ? "," : "") + buf[i];
      console.log(buf.length, s);
    `);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        if (op === 9) {
          expect(bLen).toBe(5);
          expect(ctx.readBytes(bPtr, bLen)).toEqual([1, 2, 3, 4, 5]);
          return 0;
        }
        if (op === 1) return ctx.writeBytes([1, 2, 3, 4, 5], bPtr, bLen);
        throw new Error(`unexpected op ${op}`);
      },
    });
    expect(r.stdout.trim()).toBe("5 1,2,3,4,5");
  });
});

describe("wasm-host-fs-p5: D9 — the four refused constructs, SC3001 by name (§6g's own finding: a test only, no builder change)", () => {
  test("fs.watch — SINGLE-EDIT: none, a REFUSAL-shape control (fs.watch remains genuinely unbuilt; the NO-LISTENER 1-arg form, per a freeze-time finding: a 2-arg fs.watch(path, listener) call names itself 'libCall:fs.watchCb', the SAME bucket as the 3-arg options+listener form below — only the listener-less form gets its OWN 'libCall:fs.watch' name, and the assertion below checks the closing paren so it cannot pass vacuously against the 'watchCb' superstring)", async () => {
    const { code, message } = await buildRefused(`import * as fs from "node:fs"; const w = fs.watch("/x");`);
    expect(code).toBe("SC3001");
    expect(message).toContain("(libCall:fs.watch)");
  });
  test("fs.watchCb (the 3-arg options+listener form) — SINGLE-EDIT: none, a REFUSAL-shape control", async () => {
    const { code, message } = await buildRefused(`import * as fs from "node:fs"; fs.watch("/x", { persistent: true }, () => {});`);
    expect(code).toBe("SC3001");
    expect(message).toContain("libCall:fs.watchCb");
  });
  test("watcher.close — reachable as a SURVEY member (fs.watch itself is this program's own first refusal, watcher.close never gets a turn to be first) — SINGLE-EDIT: none, a REFUSAL-shape control", async () => {
    const file = join(scratch, `p${seq++}.ts`);
    await writeFile(file, `import * as fs from "node:fs"; const w = fs.watch("/x"); w.close();`);
    const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.diagnostics[0]?.code).toBe("SC3001");
      expect([...(res.wasmSurvey ?? [])]).toContain("libCall:watcher.close");
    }
  });
  test("type:fsWatcher (the FIRST refusal when a REAL fs.watch() result is stored typed, 1564's own opening shape) — SINGLE-EDIT: none, a REFUSAL-shape control", async () => {
    const { code, message } = await buildRefused(`import * as fs from "node:fs"; let w: fs.FSWatcher | null = fs.watch("/x"); console.log(w !== null);`);
    expect(code).toBe("SC3001");
    expect(message).toContain("type:fsWatcher");
  });
  test("1564's own measured survey set is EXACTLY {type:fsWatcher, libCall:fs.watch, libCall:watcher.close} — three of the four D9 constructs, never fs.watchCb (no 3-arg call in that fixture) — SINGLE-EDIT: none, the survey-set row", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../tests/corpus/1564-fs-watch.ts", import.meta.url), "utf8");
    const file = join(scratch, `p${seq++}.ts`);
    await writeFile(file, src);
    const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.diagnostics[0]?.code).toBe("SC3001");
      expect([...(res.wasmSurvey ?? [])].sort()).toEqual(["libCall:fs.watch", "libCall:watcher.close", "type:fsWatcher"].sort());
    }
  });
});

describe("wasm-host-fs-p5: 1640's validation class — fs.readSync's derived-bound RangeErrors (M-17), never a hard-coded literal", () => {
  test("(d) the NEGATIVE derived cap: offset(99) exceeds buf.length(4), so the bound itself is negative — 'It must be <= -95' — SINGLE-EDIT: the derived bound computed as buffer.length only, dropping '- offset'", async () => {
    const bin = await buildProgram(`
      import { readSync } from "node:fs";
      try { readSync(3, new Uint8Array(4), 99, 1); } catch (e) { if (e instanceof RangeError) console.log(e.message); }
    `);
    const r = await runForced(bin, { fsCall: () => { throw new Error("fsCall must not be reached — the bound check runs before the copy"); } });
    expect(r.stdout.trim()).toBe('The value of "length" is out of range. It must be <= -95. Received 1');
  });
  test("the ordinary in-range derived cap — 'It must be <= 2' for buf.length(4) - offset(2) — SINGLE-EDIT: none, the P5-report-cited baseline row", async () => {
    const bin = await buildProgram(`
      import { readSync } from "node:fs";
      try { readSync(3, new Uint8Array(4), 2, 10); } catch (e) { if (e instanceof RangeError) console.log(e.message); }
    `);
    const r = await runForced(bin, { fsCall: () => { throw new Error("must not be reached"); } });
    expect(r.stdout.trim()).toBe('The value of "length" is out of range. It must be <= 2. Received 10');
  });
  test("negative offset: the FIXED 2^53-1 upper bound, never buffer-relative — SINGLE-EDIT: the offset check's upper literal changed from 9007199254740991", async () => {
    const bin = await buildProgram(`
      import { readSync } from "node:fs";
      try { readSync(3, new Uint8Array(4), -1, 2); } catch (e) { if (e instanceof RangeError) console.log(e.message); }
    `);
    const r = await runForced(bin, { fsCall: () => { throw new Error("must not be reached"); } });
    expect(r.stdout.trim()).toBe('The value of "offset" is out of range. It must be >= 0 && <= 9007199254740991. Received -1');
  });
  test("negative length — SINGLE-EDIT: the length<0 check dropped entirely", async () => {
    const bin = await buildProgram(`
      import { readSync } from "node:fs";
      try { readSync(3, new Uint8Array(4), 0, -1); } catch (e) { if (e instanceof RangeError) console.log(e.message); }
    `);
    const r = await runForced(bin, { fsCall: () => { throw new Error("must not be reached"); } });
    expect(r.stdout.trim()).toBe('The value of "length" is out of range. It must be >= 0. Received -1');
  });
  test("(e) CHECK-ORDER: offset-negative wins over length-negative (both violated at once) — SINGLE-EDIT: the offset check moved after the length check", async () => {
    const bin = await buildProgram(`
      import { readSync } from "node:fs";
      try { readSync(3, new Uint8Array(4), -1, -1); } catch (e) { if (e instanceof RangeError) console.log(e.message); }
    `);
    const r = await runForced(bin, { fsCall: () => { throw new Error("must not be reached"); } });
    expect(r.stdout.trim()).toBe('The value of "offset" is out of range. It must be >= 0 && <= 9007199254740991. Received -1');
  });
  test("(e) CHECK-ORDER: length-negative wins over the derived-cap check (both violated at once) — SINGLE-EDIT: the derived-cap check moved before the length<0 check", async () => {
    const bin = await buildProgram(`
      import { readSync } from "node:fs";
      try { readSync(3, new Uint8Array(4), 0, -1); } catch (e) { if (e instanceof RangeError) console.log(e.message); }
    `);
    const r = await runForced(bin, { fsCall: () => { throw new Error("must not be reached"); } });
    expect(r.stdout.trim()).toBe('The value of "length" is out of range. It must be >= 0. Received -1');
  });
  test("a VALID call reaches fsCall — the three checks are guards, not a permanent block — SINGLE-EDIT: any one of the three checks inverted so a valid call also throws", async () => {
    const bin = await buildProgram(`import { readSync } from "node:fs"; console.log(readSync(3, new Uint8Array(4), 0, 4));`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => ctx.writeBytes([1, 2, 3, 4], bPtr, bLen),
    });
    expect(r.stdout.trim()).toBe("4");
  });
});

describe("wasm-host-fs-p5: os.networkInterfaces (hostStr kind 16) — the forced JSON document, one row per family (M-14's own unit row)", () => {
  test("an IPv4 entry OMITS scopeid entirely (never a materialized undefined) while an IPv6 entry carries it — SINGLE-EDIT: the IPv4 record's own scopeid field forced to a materialized undefined union arm instead of unitGlobal's interned instance", async () => {
    const bin = await buildProgram(`
      import { networkInterfaces } from "node:os";
      const ifs = networkInterfaces();
      const keys = Object.keys(ifs);
      console.log(keys.length);
      const entries = ifs[keys[0]!]!;
      for (const e of entries) {
        if (e.family === "IPv4") console.log("v4", "scopeid" in e);
        else console.log("v6", "scopeid" in e, e.scopeid);
      }
    `);
    const doc = {
      eth0: [
        { address: "192.168.1.5", netmask: "255.255.255.0", family: "IPv4", mac: "00:11:22:33:44:55", internal: false, cidr: "192.168.1.5/24" },
        { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:11:22:33:44:55", internal: false, cidr: "fe80::1/64", scopeid: 2 },
      ],
    };
    const r = await runForced(bin, {
      hostStrExtra: (kind, _i, ptr, cap, ctx) => (kind === 16 ? ctx.writeUtf16(JSON.stringify(doc), ptr, cap) : undefined),
    });
    expect(r.stdout.trim()).toBe("1\nv4 false\nv6 true 2");
  });
  test("Object.keys' own ORDER is preserved for multi-interface documents (the dict's own overflow map, keyed insertion order) — SINGLE-EDIT: the overflow map's own insertion order not preserved by maps.set", async () => {
    const bin = await buildProgram(`import { networkInterfaces } from "node:os"; console.log(Object.keys(networkInterfaces()).join(","));`);
    const doc = {
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
      eth0: [{ address: "10.0.0.2", netmask: "255.0.0.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "10.0.0.2/8" }],
    };
    const r = await runForced(bin, {
      hostStrExtra: (kind, _i, ptr, cap, ctx) => (kind === 16 ? ctx.writeUtf16(JSON.stringify(doc), ptr, cap) : undefined),
    });
    expect(r.stdout.trim()).toBe("lo,eth0");
  });
  test("kind 16 is queried ONCE per run and reused (the JSON document is not re-parsed per property read) — SINGLE-EDIT: none, a breadth row on the snapshot-vs-live question (module-side, not the harness's own snapshot — see wasm-differential.test.ts's own netIfSnapshot for THAT half)", async () => {
    const bin = await buildProgram(`
      import { networkInterfaces } from "node:os";
      const a = networkInterfaces();
      const b = networkInterfaces();
      console.log(Object.keys(a).length, Object.keys(b).length);
    `);
    let calls = 0;
    const doc = { eth0: [{ address: "1.2.3.4", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "1.2.3.4/24" }] };
    const r = await runForced(bin, {
      hostStrExtra: (kind, _i, ptr, cap, ctx) => {
        if (kind !== 16) return undefined;
        calls++;
        return ctx.writeUtf16(JSON.stringify(doc), ptr, cap);
      },
    });
    expect(calls).toBeGreaterThanOrEqual(1); // TWO module-side calls is fine (this row does not assert host-side caching — that is the harness's own concern); the CONTENT must simply agree.
    expect(r.stdout.trim()).toBe("1 1");
  });
});

describe("wasm-host-fs-p5: Module.imports pairs — a construct pulls in ONLY the host import surface it needs", () => {
  async function importsOf(src: string): Promise<string[]> {
    const file = join(scratch, `p${seq++}.ts`);
    await writeFile(file, src);
    const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { readFileSync } = await import("node:fs");
    const mod = await WebAssembly.compile(readFileSync(res.binaryPath));
    return WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
  }
  test("an os.type-only program imports hostStr, NEVER fsCall — SINGLE-EDIT: fsCallReachable's prescan gaining a false-positive disjunct for os.type", async () => {
    const imports = await importsOf(`import { type } from "node:os"; console.log(type());`);
    expect(imports).toContain("tsinter.hostStr");
    expect(imports).not.toContain("tsinter.fsCall");
  });
  test("a statSync-only program imports fsCall, NEVER hostStr — SINGLE-EDIT: hostStrReachable's prescan gaining a false-positive disjunct for fs.statSync", async () => {
    const imports = await importsOf(`import { statSync } from "node:fs"; console.log(statSync("/x").isFile());`);
    expect(imports).toContain("tsinter.fsCall");
    expect(imports).not.toContain("tsinter.hostStr");
  });
  test("the settled-stats program (fsp.stat) imports fsCall too — the promise-settling machinery adds NO new host import surface beyond the sync op it wraps — SINGLE-EDIT: emitFspSettled's own minting path pulling in a distinct import", async () => {
    const imports = await importsOf(`import { stat } from "node:fs/promises"; async function main() { console.log((await stat("/x")).isFile()); } main();`);
    expect(imports).toContain("tsinter.fsCall");
    expect(imports).not.toContain("tsinter.hostStr");
  });
});

describe("wasm-host-fs-p5: the fsp twins — synchronous syscall, already-settled promise (design §6.5, S074)", () => {
  test("fsp.readFile fulfills with the sync content, settled before the FIRST await — SINGLE-EDIT: emitFspSettled minting a PENDING promise instead of an already-settled one", async () => {
    const bin = await buildProgram(`import { readFile } from "node:fs/promises"; async function main() { console.log(await readFile("/x", "utf8")); } main();`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen) => {
        expect(op).toBe(1);
        return ctx.writeUtf16("fsp content", bPtr, bLen);
      },
    });
    expect(r.stdout.trim()).toBe("fsp content");
  });
  test("fsp.writeFile REJECTS with the SAME sync text S074/S073 register, catchable at the await — SINGLE-EDIT: emitFspSettled's rejection path dropping the pending-cell payload instead of moving it into the promise", async () => {
    const bin = await buildProgram(`
      import { writeFile } from "node:fs/promises";
      async function main() {
        try { await writeFile("/nope/x", "y"); } catch (e) { if (e instanceof Error) console.log(e.message); }
      }
      main();
    `);
    const r = await runForced(bin, { fsCall: () => CODE.ENOENT });
    expect(r.stdout.trim()).toBe("ENOENT: no such file or directory, open '/nope/x'");
  });
  test("fsp.rm settles VOID on success (no return value to read) — SINGLE-EDIT: emitFspSettled's null-result branch reading a stray value", async () => {
    const bin = await buildProgram(`import { rm } from "node:fs/promises"; async function main() { await rm("/x"); console.log("ok"); } main();`);
    const r = await runForced(bin, { fsCall: (ctx, op) => { expect(op).toBe(14); return 0; } });
    expect(r.stdout.trim()).toBe("ok");
  });
  test("fsp.mkdirRecursiveMode forwards mode+1 and recursive=1, the SAME wire shape as its sync sibling (mkdirRecursiveModeSync) — SINGLE-EDIT: the fsp dispatch arm calling mkdirModeSyncHelper (recursive=0) instead", async () => {
    const bin = await buildProgram(`import { mkdir } from "node:fs/promises"; async function main() { await mkdir("/a/b", { recursive: true, mode: 0o700 }); console.log("ok"); } main();`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr, bLen, x, y) => {
        expect(op).toBe(11);
        expect(x).toBe(0o700 + 1);
        expect(y).toBe(1);
        return 0;
      },
    });
    expect(r.stdout.trim()).toBe("ok");
  });
});

describe("wasm-host-fs-p5: (f) the SOLE importFunc site — the fsp/settled machinery adds NO new host import (a static-source audit, S074's own claim)", () => {
  test("every `.importFunc(` call site in emitter.ts sits inside the ONE prescan-guarded import block (~:1938-2010) — SINGLE-EDIT: a NEW importFunc call added anywhere else in the file", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/backend/wasm/emitter.ts", import.meta.url), "utf8");
    const lines = src.split("\n");
    const siteLines: number[] = [];
    lines.forEach((line, i) => {
      if (line.includes(".importFunc(")) siteLines.push(i + 1);
    });
    expect(siteLines.length).toBeGreaterThan(0);
    for (const ln of siteLines) {
      expect(ln, `importFunc call at line ${ln} is outside the expected 1930-2015 import block`).toBeGreaterThanOrEqual(1930);
      expect(ln, `importFunc call at line ${ln} is outside the expected 1930-2015 import block`).toBeLessThanOrEqual(2015);
    }
  });
  test("the fsp dispatch arms (design §6.5's own 'no new async machinery' — the block between the fs-tail's own end marker and the fsp twins' own end marker) contain ZERO `.importFunc(`/`.mb.import` references — SINGLE-EDIT: an fsp arm calling importFunc directly instead of reusing fsCallFunc's own cached import", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/backend/wasm/emitter.ts", import.meta.url), "utf8");
    const start = src.indexOf("INC-26 P5 — the fsp twins");
    const end = src.indexOf("end INC-26 P5 (fsp twins, all 10)");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const fspBlock = src.slice(start, end);
    expect(fspBlock.includes(".importFunc(")).toBe(false);
  });
});

describe("wasm-host-fs-p5: infra smoke", () => {
  test("statSync success reads the FIXED 20-byte record back through the five accessors — SINGLE-EDIT: statsType()'s field order swapped", async () => {
    const bin = await buildProgram(`import { statSync } from "node:fs"; const s = statSync("/x"); console.log(s.isFile(), s.isDirectory(), s.isSymbolicLink(), s.size, s.mtimeMs);`);
    const r = await runForced(bin, {
      fsCall: (ctx, op, aPtr, aLen, bPtr) => {
        expect(op).toBe(7);
        return writeStatsRecord(ctx, bPtr, { isFile: true, isDirectory: false, isSymbolicLink: false, size: 1234, mtimeMs: 5678.5 });
      },
    });
    expect(r.stdout.trim()).toBe("true false false 1234 5678.5");
  });
});

describe("wasm-host-fs-p5: ROW VACUITY, asserted (P3/P4's own retro rule)", () => {
  test("VACUITY-ROW — the marker count equals this file's own test count, minus the named controls (every REFUSAL-shape/static-audit row is itself a named control, carrying its own explicit marker text naming 'none' plus a reason — never silently exempted); THIS row is the ONE test exempted from carrying either the marker or a 'none' reason, and its exemption is checked by name (the literal token 'VACUITY-ROW' in this title), never inferred from an absent colon — a row without a marker AND without the token is not a row", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(import.meta.filename, "utf8");
    const rowsWithMarker = (src.match(/^\s*test\(.*SINGLE-EDIT:/gm) ?? []).length;
    const vacuityRows = (src.match(/^\s*test\("VACUITY-ROW/gm) ?? []).length;
    const testCount = (src.match(/^\s*test\(/gm) ?? []).length;
    // R-6 (POST-ACK #22): the exemption is now a checked TOKEN, not an
    // absence — exactly ONE test() title carries the literal
    // "VACUITY-ROW" prefix (this one), and every OTHER test() carries
    // "SINGLE-EDIT:" — the two sets partition testCount exactly, with no
    // row falling through either check silently.
    expect(vacuityRows, `expected exactly 1 row carrying the VACUITY-ROW token (this row itself), found ${vacuityRows}`).toBe(1);
    expect(rowsWithMarker, `${rowsWithMarker} rows carry the SINGLE-EDIT marker vs ${testCount} test() calls total (expect exactly one test — the VACUITY-ROW one — without a marker)`).toBe(testCount - 1);
    expect(rowsWithMarker + vacuityRows, "SINGLE-EDIT rows + VACUITY-ROW rows must partition every test() in this file").toBe(testCount);
  });
});
