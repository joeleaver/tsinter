/* INC-26 pass P3 (brief-p3-v2.md ffbf2fdf/371; design-host-v7.txt cccf7d6e
 * §2.7/§3.2/§4.3/§9 P3/§10-ii; DECISIONS.md P3-J1..J4/P3-L1..L8; CP1 delta
 * 38220b2a; delta-3e f1f634c0) — the FORCED-HOST unit rows for the process
 * tail: every row here compares against a TABLE of KNOWN, deliberately
 * non-real values (§10-ii's own point — a row that reads the real host and
 * compares to the real host proves nothing), never the real host. This is
 * wasm-host-process.test.ts's OWN shape (P1's precedent), extended for
 * P3's own kinds: kill/chdir/umask (new imports, own errno enumerations),
 * the thirteen hostNum + four hostStr host-fact kinds, cpuPrevValidate,
 * activeResources, the warning surface, stdin's two keys, and Joe's five
 * widened #138 keys (chdir, exiting, umask, stderrWriteBytes,
 * offRejectionHandled — the D10-shaped set: BUILT, reached by NO corpus
 * program, so THIS file is the only thing that ever exercises them).
 *
 * ROW BUDGET (delta-3e E-7, rev-26's own bucket enumeration, ~75 not ~65):
 * kill ~19, chdir ~12, umask ~9, the five D10 keys' own remaining rows,
 * host-fact reads (4 hostStr + 13 hostNum) ~17, cpuPrevValidate 4,
 * activeResources 3, the warning surface ~12, columns/isTTY 2, setRawMode's
 * TTY trap 1, the two refusals. Reported by bucket in the freeze, keyed
 * once each — never re-derived by arithmetic a second time. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-process-p3-"));
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

/** Same-shape refusal check for the two D5 keys (onSignal/offSignal) —
 * these never reach the forced host at all (they refuse at COMPILE time),
 * so their own "row" is a compile-time assertion, not a runtime one. */
async function expectRefused(src: string): Promise<{ code: string; message: string }> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (res.ok) throw new Error("expected a refusal, got ok:true");
  const d = res.diagnostics[0];
  if (!d) throw new Error("expected at least one diagnostic");
  return { code: d.code, message: d.message };
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

/** Node's own 16-field resourceUsage order (measured, rev-rusage-order.out
 * 16880a86, independently re-confirmed this pass): index 2 is maxRSS,
 * which design §2.3's own text requires STRICTLY positive. */
const DEFAULT_RUSAGE: readonly number[] = [100, 50, 4096, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1];

interface ForcedHost {
  arch?: string;
  execPath?: string;
  versionsNode?: string;
  versionsOpenssl?: string;
  pid?: number;
  uid?: number;
  gid?: number;
  /** fd -> 1|0. Default: non-TTY everywhere (design §11's own stance). */
  isTTY?: (fd: number) => number;
  /** fd -> columns, -1 = "no width". */
  columns?: (fd: number) => number;
  uptime?: number;
  cpuUser?: number;
  cpuSystem?: number;
  threadCpuUser?: number;
  threadCpuSystem?: number;
  availableMemory?: number;
  constrainedMemory?: number;
  rusage?: readonly number[];
  /** (pid, sig) -> status: 0 success, kill's OWN -1/-2/-3, or
   * -(256+errno). Default: always ESRCH (-1) — a probe against a pid
   * nothing this suite could ever actually own. */
  kill?: (pid: number, sig: number) => number;
  /** path string -> status: 0 success, chdir's OWN 1..8 (negated by the
   * caller before crossing) or -(256+errno). Default: always success. */
  chdir?: (path: string) => number;
  /** (isRead, mask) -> previous mask. Default: read answers 0o22, set
   * answers the SAME 0o22 as "previous". */
  umask?: (isRead: number, mask: number) => number;
}

async function runForced(binaryPath: string, host: ForcedHost = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { readFileSync } = await import("node:fs");
  const isTTY = host.isTTY ?? (() => 0);
  const columns = host.columns ?? (() => -1);
  const rusage = host.rusage ?? DEFAULT_RUSAGE;
  const kill = host.kill ?? (() => -1);
  const chdir = host.chdir ?? (() => 0);
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
          case 5:
            return writeUtf16(memory!, host.arch ?? "forcedarch64", ptr, cap);
          case 6:
            return writeUtf16(memory!, host.versionsNode ?? "24.0.0", ptr, cap);
          case 7:
            return writeUtf16(memory!, host.versionsOpenssl ?? "3.5.5", ptr, cap);
          case 12:
            return writeUtf16(memory!, host.execPath ?? "/forced/host/node", ptr, cap);
          default:
            throw new Error(`hostStr: unknown kind ${kind}`);
        }
      },
      hostNum(kind: number, arg: number): number {
        switch (kind) {
          case 0:
            return 2;
          case 1:
            return 0;
          case 2:
            return host.pid ?? 424242;
          case 3:
            return host.uid ?? 4242;
          case 4:
            return host.gid ?? 4343;
          case 5:
            return isTTY(arg);
          case 6:
            return columns(arg);
          case 7:
            return host.uptime ?? 12.5;
          case 8:
            return host.cpuUser ?? 1000;
          case 9:
            return host.cpuSystem ?? 500;
          case 10:
            return host.threadCpuUser ?? 700;
          case 11:
            return host.threadCpuSystem ?? 300;
          case 12:
            return host.availableMemory ?? 123456;
          case 13:
            return host.constrainedMemory ?? 654321;
          case 14: {
            const v = rusage[arg];
            if (v === undefined) throw new Error(`hostNum: rusage index out of range ${arg}`);
            return v;
          }
          default:
            throw new Error(`hostNum: unknown kind ${kind}`);
        }
      },
      exit(code: number): void {
        throw new ExitSignal(code);
      },
      kill(pid: number, sig: number): number {
        return kill(pid, sig);
      },
      chdir(ptr: number, len: number): number {
        const path = readUtf16(memory!, ptr, len);
        return chdir(path);
      },
      umask(isRead: number, mask: number): number {
        return umask(isRead, mask);
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

/** P1's own precedent (wasm-host-process.test.ts): the driver for a row
 * that both prints AND traps — `runForced` only returns cleanly for
 * `process.exit`/normal completion, never for a genuine uncaught throw. */
async function runForcedExpectTrap(binaryPath: string): Promise<{ stdout: string; stderr: string }> {
  const { readFileSync } = await import("node:fs");
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(readFileSync(binaryPath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => 0,
      seed: (): bigint => 0n,
      wallClock: (): number => 0,
      hostStr(): number {
        return -1;
      },
      hostNum(): number {
        return -1;
      },
      exit(code: number): void {
        throw new ExitSignal(code);
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let trapped = false;
  try {
    (instance.exports["_start"] as () => void)();
  } catch (err) {
    expect(err).toBeInstanceOf(WebAssembly.RuntimeError);
    trapped = true;
  }
  expect(trapped).toBe(true);
  return {
    stdout: Buffer.concat(chunks[1]).toString("utf8"),
    stderr: Buffer.concat(chunks[2]).toString("utf8"),
  };
}

// ── kill / killNum (D4, design §2.7; ~19 rows) ────────────────────────────
describe("P3 forced-host: kill/killNum", () => {
  test("pid check: fractional pid throws Node's exact TypeError text", async () => {
    const bin = await buildProgram(`
      try { process.kill(1.5, 0); } catch (e) { console.log(e instanceof TypeError, (e as TypeError).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('true The "pid" argument must be of type number. Received type number (1.5)\n');
  });
  test("pid check: pid above int32 range throws with the code ERR_INVALID_ARG_TYPE", async () => {
    const bin = await buildProgram(`
      try { process.kill(2147483648, 0); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The "pid" argument must be of type number. Received type number (2147483648)\n');
  });
  test("pid check: pid below -2^31 throws", async () => {
    const bin = await buildProgram(`
      try { process.kill(-2147483649, 0); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The "pid" argument must be of type number. Received type number (-2147483649)\n');
  });
  test("pid check: exact int32 boundaries pass the pid check (reach the host)", async () => {
    const bin = await buildProgram(`
      console.log(process.kill(2147483647, 0));
      console.log(process.kill(-2147483648, 0));
    `);
    const { stdout } = await runForced(bin, { kill: () => 0 });
    expect(stdout).toBe("true\ntrue\n");
  });
  test("signal table: the empty-string special case sends SIGTERM before any table lookup (D-2)", async () => {
    let seenSig = -1;
    const bin = await buildProgram(`console.log(process.kill(1, ""));`);
    const { stdout } = await runForced(bin, {
      kill: (_pid, sig) => {
        seenSig = sig;
        return 0;
      },
    });
    expect(stdout).toBe("true\n");
    expect(seenSig).toBe(15);
  });
  test("signal table: SIGABRT and SIGIOT both resolve (same forced host records both calls)", async () => {
    const seen: number[] = [];
    const bin = await buildProgram(`
      process.kill(1, "SIGABRT");
      process.kill(1, "SIGIOT");
      console.log("done");
    `);
    const { stdout } = await runForced(bin, {
      kill: (_pid, sig) => {
        seen.push(sig);
        return 0;
      },
    });
    expect(stdout).toBe("done\n");
    expect(seen).toEqual([6, 6]);
  });
  test("signal table: an absent name (SIGRTMIN) throws ERR_UNKNOWN_SIGNAL", async () => {
    const bin = await buildProgram(`
      try { process.kill(1, "SIGRTMIN"); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("Unknown signal: SIGRTMIN\n");
  });
  test("signal table: an unknown name throws before any host call", async () => {
    let called = false;
    const bin = await buildProgram(`
      try { process.kill(1, "SIGNOPE"); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, {
      kill: () => {
        called = true;
        return 0;
      },
    });
    expect(stdout).toBe("Unknown signal: SIGNOPE\n");
    expect(called).toBe(false);
  });
  test("signal table: NO PROTOTYPE LEAK — 'toString' is an unknown signal name", async () => {
    const bin = await buildProgram(`
      try { process.kill(1, "toString"); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("Unknown signal: toString\n");
  });
  test("signal table: NO PROTOTYPE LEAK — '__proto__' is an unknown signal name", async () => {
    const bin = await buildProgram(`
      try { process.kill(1, "__proto__"); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("Unknown signal: __proto__\n");
  });
  test("kill code rendering: ESRCH", async () => {
    const bin = await buildProgram(`
      try { process.kill(999, 0); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, { kill: () => -1 });
    expect(stdout).toBe("kill ESRCH\n");
  });
  test("kill code rendering: EPERM", async () => {
    const bin = await buildProgram(`
      try { process.kill(999, 0); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, { kill: () => -2 });
    expect(stdout).toBe("kill EPERM\n");
  });
  test("kill code rendering: EINVAL", async () => {
    const bin = await buildProgram(`
      try { process.kill(999, 0); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, { kill: () => -3 });
    expect(stdout).toBe("kill EINVAL\n");
  });
  test("kill UNKNOWN arm: -(256+9999) renders 'kill E9999' with NO .code", async () => {
    const bin = await buildProgram(`
      try { process.kill(999, 0); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, { kill: () => -(256 + 9999) });
    expect(stdout).toBe("kill E9999\n");
  });
  test("kill success: Node's constant true", async () => {
    const bin = await buildProgram(`console.log(process.kill(1, 0));`);
    const { stdout } = await runForced(bin, { kill: () => 0 });
    expect(stdout).toBe("true\n");
  });
  test("killNum: NaN (the only falsy non-int32 number) resolves to SIGTERM(15), no throw", async () => {
    let seenSig = -1;
    const bin = await buildProgram(`console.log(process.kill(1, NaN));`);
    const { stdout } = await runForced(bin, {
      kill: (_pid, sig) => {
        seenSig = sig;
        return 0;
      },
    });
    expect(stdout).toBe("true\n");
    expect(seenSig).toBe(15);
  });
  test("killNum: 2147483648 (fails round-trip, not NaN) throws Unknown signal with its OWN value", async () => {
    const bin = await buildProgram(`
      try { process.kill(1, 2147483648); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("Unknown signal: 2147483648\n");
  });
  test("killNum: -2147483648 (int32 min, round-trips) passes RAW", async () => {
    let seenSig = 0;
    const bin = await buildProgram(`console.log(process.kill(1, -2147483648));`);
    const { stdout } = await runForced(bin, {
      kill: (_pid, sig) => {
        seenSig = sig;
        return 0;
      },
    });
    expect(stdout).toBe("true\n");
    expect(seenSig).toBe(-2147483648);
  });
  test("killNum: 1.5 (non-integer) throws Unknown signal: 1.5", async () => {
    const bin = await buildProgram(`
      try { process.kill(1, 1.5); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("Unknown signal: 1.5\n");
  });
});

// ── chdir (design §0.5 W5; ~12 rows) ──────────────────────────────────────
describe("P3 forced-host: chdir", () => {
  const CODES: readonly [number, string, string][] = [
    [1, "ENOENT", "no such file or directory"],
    [2, "ENOTDIR", "not a directory"],
    [3, "EACCES", "permission denied"],
    [4, "ENAMETOOLONG", "name too long"],
    [5, "ELOOP", "too many symbolic links encountered"],
    [6, "EIO", "i/o error"],
    [7, "ENOMEM", "not enough memory"],
    [8, "EPERM", "operation not permitted"],
  ];
  for (const [code, name, text] of CODES) {
    test(`chdir error rendering: ${name}`, async () => {
      const bin = await buildProgram(`
        try { process.chdir("/nonexistent"); } catch (e) { console.log((e as Error).message); }
      `);
      const { stdout } = await runForced(bin, { chdir: () => -code });
      expect(stdout).toBe(`${name}: ${text}, chdir '/forced/cwd' -> '/nonexistent'\n`);
    });
  }
  test("chdir UNKNOWN arm: -(256+9999) renders 'E9999: Unknown system error -9999, ...' with NO .code", async () => {
    const bin = await buildProgram(`
      try { process.chdir("/x"); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, { chdir: () => -(256 + 9999) });
    expect(stdout).toBe("E9999: Unknown system error -9999, chdir '/forced/cwd' -> '/x'\n");
  });
  test("chdir(''): the before path with an empty 'to' side", async () => {
    const bin = await buildProgram(`
      try { process.chdir(""); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, { chdir: () => -1 });
    expect(stdout).toBe("ENOENT: no such file or directory, chdir '/forced/cwd' -> ''\n");
  });
  // M-8's own pin (found missing by the mutation battery: the earlier
  // draft of this row forced hostStr(CWD) to the SAME string on every
  // call, so a stale-cache bug and a correctly-invalidated cache print
  // the identical answer — the row discriminated nothing). This forced
  // host instead answers a DIFFERENT cwd string on the FIRST read
  // (before any chdir) than on every read AFTER: a correct
  // invalidateCwdSnapshot call makes path.resolve(".") re-read and see
  // the SECOND string; a mutant that skips it would still show the
  // FIRST (cached) one.
  test("chdir success: the memo invalidation makes path.resolve() read the NEW cwd via a fresh readHostStr, not the stale one (M-8's own pin)", async () => {
    const bin = await buildProgram(`
      import { resolve } from "node:path";
      resolve(".");
      process.chdir("/new/dir");
      console.log(resolve("."));
    `);
    let cwdReads = 0;
    const { readFileSync } = await import("node:fs");
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(bin), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
        },
        now: (): number => 0,
        seed: (): bigint => 0n,
        wallClock: (): number => 0,
        hostStr(kind: number, _index: number, ptr: number, cap: number): number {
          if (kind === 3) {
            cwdReads++;
            return writeUtf16(memory!, cwdReads === 1 ? "/forced/cwd/before" : "/forced/cwd/after", ptr, cap);
          }
          return -1;
        },
        hostNum(): number {
          return -1;
        },
        exit(code: number): void {
          throw new ExitSignal(code);
        },
        chdir(): number {
          return 0;
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    (instance.exports["_start"] as () => void)();
    expect(Buffer.concat(chunks).toString("utf8")).toBe("/forced/cwd/after\n");
    expect(cwdReads).toBeGreaterThanOrEqual(2);
  });
  test("chdir mutates NOTHING else observable: two chdir calls in a row both succeed independently", async () => {
    let calls: string[] = [];
    const bin = await buildProgram(`
      process.chdir("/a");
      process.chdir("/b");
      console.log("done");
    `);
    const { stdout } = await runForced(bin, {
      chdir: (p) => {
        calls.push(p);
        return 0;
      },
    });
    expect(stdout).toBe("done\n");
    expect(calls).toEqual(["/a", "/b"]);
  });
});

// ── umask (design §0.5 W4; ~9 rows) ───────────────────────────────────────
describe("P3 forced-host: umask", () => {
  test("read form (no args): isRead=1, mask ignored, returns the previous mask", async () => {
    let seenIsRead = -1;
    let seenMask = -1;
    const bin = await buildProgram(`console.log(process.umask());`);
    const { stdout } = await runForced(bin, {
      umask: (isRead, mask) => {
        seenIsRead = isRead;
        seenMask = mask;
        return 0o22;
      },
    });
    expect(stdout).toBe("18\n"); // 0o22 === 18
    expect(seenIsRead).toBe(1);
    expect(seenMask).toBe(0);
  });
  test("set form: isRead=0, mask crosses UNSIGNED, returns the previous mask", async () => {
    let seenIsRead = -1;
    let seenMask = -1;
    const bin = await buildProgram(`console.log(process.umask(0o22));`);
    const { stdout } = await runForced(bin, {
      umask: (isRead, mask) => {
        seenIsRead = isRead;
        seenMask = mask;
        return 0o755;
      },
    });
    expect(stdout).toBe("493\n"); // 0o755 === 493
    expect(seenIsRead).toBe(0);
    expect(seenMask).toBe(0o22);
  });
  test("set form: 4294967295 (u32 max) passes the range check and crosses as i32 bit pattern -1, not a range error", async () => {
    // MASK truncates via i32TruncF64U (unsigned truncation of the f64
    // 4294967295 into the i32's 32 bits, all-ones), but the WebAssembly
    // JS-API always surfaces a crossed i32 to an imported JS function as
    // a SIGNED 32-bit integer (ToJSValue(i32) has no unsigned form) — so
    // this forced host observes -1, the bit-identical signed reading of
    // the same 32 one-bits a real host's chmod(2)-shaped umask() would
    // reinterpret as unsigned 4294967295. The row's own claim is just
    // that the range check does NOT reject this value (the mask stays
    // 0..4294967295 inclusive per Node's own bound) and the call reaches
    // the host rather than throwing RangeError.
    let seenMask = 1;
    const bin = await buildProgram(`console.log(process.umask(4294967295));`);
    const { stdout } = await runForced(bin, {
      umask: (isRead, mask) => {
        seenMask = mask;
        return isRead ? 0 : 0;
      },
    });
    expect(stdout).toBe("0\n");
    expect(seenMask).toBe(-1);
  });
  test("integer check FIRST: a non-integer mask throws even when ALSO out of range", async () => {
    const bin = await buildProgram(`
      try { process.umask(1.5); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The value of "mask" is out of range. It must be an integer. Received 1.5\n');
  });
  test("integer check: NaN gives the INTEGER text, never the range text", async () => {
    const bin = await buildProgram(`
      try { process.umask(NaN); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The value of "mask" is out of range. It must be an integer. Received NaN\n');
  });
  test("range check SECOND: an out-of-range integer gives the range text", async () => {
    const bin = await buildProgram(`
      try { process.umask(4294967296); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The value of "mask" is out of range. It must be >= 0 && <= 4294967295. Received 4294967296\n');
  });
  test("range check: a negative mask gives the range text (the board #142 collision's OWN native shape — -1 is NOT special-cased here)", async () => {
    const bin = await buildProgram(`
      try { process.umask(-2); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The value of "mask" is out of range. It must be >= 0 && <= 4294967295. Received -2\n');
  });
});

// ── the five widened #138 keys (D10-shaped: BUILT, zero corpus reach) ─────
describe("P3 forced-host: exiting (W3)", () => {
  test("false before any exit sequence begins", async () => {
    const bin = await buildProgram(`console.log(process._exiting);`);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("false\n");
  });
  test("true inside an 'exit' listener on the NORMAL QUIESCENCE path", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => console.log(process._exiting));
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("true\n");
  });
  test("true inside an 'exit' listener on the EXPLICIT process.exit(n) path", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => console.log(process._exiting));
      process.exit(0);
    `);
    const { stdout, exitCode } = await runForced(bin);
    expect(stdout).toBe("true\n");
    expect(exitCode).toBe(0);
  });
  test("true inside an 'exit' listener on the FATAL (uncaught) path", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => console.log(process._exiting));
      throw new Error("boom");
    `);
    const { stdout } = await runForcedExpectTrap(bin);
    expect(stdout).toBe("true\n");
  });
});

describe("P3 forced-host: stderrWriteBytes (W1)", () => {
  test("bytes land on fd 2 verbatim, returns Node's constant true", async () => {
    const bin = await buildProgram(`
      console.log(process.stderr.write(Buffer.from("hi")));
    `);
    const { stdout, stderr } = await runForced(bin);
    expect(stdout).toBe("true\n");
    expect(stderr).toBe("hi");
  });
  test("the empty write also answers true", async () => {
    const bin = await buildProgram(`
      console.log(process.stderr.write(Buffer.from([])));
    `);
    const { stdout, stderr } = await runForced(bin);
    expect(stdout).toBe("true\n");
    expect(stderr).toBe("");
  });
  test("ordering with a console.error interleave is preserved", async () => {
    const bin = await buildProgram(`
      console.error("A");
      process.stderr.write(Buffer.from("B"));
      console.error("C");
    `);
    const { stderr } = await runForced(bin);
    expect(stderr).toBe("A\nBC\n");
  });
});

describe("P3 forced-host: offRejectionHandled (W2)", () => {
  // G-2's own correction (gate round P3-F1): the ORIGINAL row here caught
  // its own promise SYNCHRONOUSLY (`p.catch(() => {})` right after
  // `Promise.reject(...)`, same turn) — a promise handled in the SAME
  // turn it rejects is NEVER reported unhandled, so `rejectionHandled`
  // can never fire for it EITHER WAY, making the row vacuous regardless
  // of on/off correctness (the SAME class of defect G-1 named for a
  // different row). Rebuilt using the SAME deferred-catch shape the
  // existing "onRejectionHandled: fires AFTER..." row (P1-era) already
  // uses: the checkpoint reports the promise unhandled FIRST (this turn),
  // and only a LATER turn's `.catch()` can trigger rejectionHandled —
  // now the removed listener has something real to fail to fire.
  test("on/off/fire=0 — a removed listener never fires", async () => {
    const bin = await buildProgram(`
      'use strict';
      process.on("unhandledRejection", () => {});
      const cb = () => { console.log("SHOULD NOT RUN"); };
      process.on("rejectionHandled", cb);
      process.off("rejectionHandled", cb);
      async function doomed() { throw new Error("boom"); }
      const p = doomed();
      setTimeout(() => { p.catch(() => { console.log("late catch"); }); }, 0);
      console.log("sync tail");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("sync tail\nlate catch\n");
  });
  // rev-26's gate addendum (findings-rev26-p3-gate-addendum.txt 7dd4cfa7):
  // the ORIGINAL M-13 mutation (offRejectionHandledRemove: dynStrictEq ->
  // raw ref.eq on the two dynRef box operands) IS a real mutation — both
  // operands genuinely are boxes (process.ts:1319-1350), and boxFunc
  // (dyn.ts:849) ends in an UNCONDITIONAL structNew, a fresh box on every
  // crossing, never interned. Three earlier probes (this session's own
  // standalone scripts, not rows in this file) passed the SAME already-
  // boxed reference to both on() and off() (a dyn-typed BINDING boxes
  // once, at the binding, not per call site) and so could never
  // discriminate regardless of the mutation. THIS row passes a
  // STATICALLY TYPED function DECLARATION instead of an already-dyn
  // binding, so `on()` and `off()` each form their OWN dyn argument at
  // their OWN call site — two distinct boxes over one closure.
  // dynStrictEq's own FN_CLOS ref.eq still finds and removes it; a raw
  // box ref.eq does not.
  test("off(f) removes a statically-typed function declaration crossed at two separate call sites", async () => {
    const bin = await buildProgram(`
      'use strict';
      process.on("unhandledRejection", () => {});
      function f(promise: unknown): void { console.log("SHOULD NOT RUN"); }
      process.on("rejectionHandled", f);
      process.off("rejectionHandled", f);
      async function doomed() { throw new Error("boom"); }
      const p = doomed();
      setTimeout(() => { p.catch(() => { console.log("late catch"); }); }, 0);
      console.log("sync tail");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("sync tail\nlate catch\n");
  });
  test("off-of-a-stranger is a no-op, never throws", async () => {
    const bin = await buildProgram(`
      process.off("rejectionHandled", () => {});
      console.log("no throw");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("no throw\n");
  });
});

// ── the host-fact reads (4 hostStr + 13 hostNum kinds) ────────────────────
describe("P3 forced-host: host-fact reads", () => {
  test("arch: the forced string", async () => {
    const bin = await buildProgram(`console.log(process.arch);`);
    const { stdout } = await runForced(bin, { arch: "forcedarch64" });
    expect(stdout).toBe("forcedarch64\n");
  });
  test("execPath: the forced string, distinct from argv[0]", async () => {
    const bin = await buildProgram(`console.log(process.execPath);`);
    const { stdout } = await runForced(bin, { execPath: "/forced/host/node" });
    expect(stdout).toBe("/forced/host/node\n");
  });
  test("versions.node: the forced compat-target string", async () => {
    const bin = await buildProgram(`console.log(process.versions.node);`);
    const { stdout } = await runForced(bin, { versionsNode: "24.0.0" });
    expect(stdout).toBe("24.0.0\n");
  });
  test("versions.openssl: the forced compat-target string", async () => {
    const bin = await buildProgram(`console.log(process.versions.openssl);`);
    const { stdout } = await runForced(bin, { versionsOpenssl: "3.5.5" });
    expect(stdout).toBe("3.5.5\n");
  });
  test("pid: the forced value", async () => {
    const bin = await buildProgram(`console.log(process.pid);`);
    const { stdout } = await runForced(bin, { pid: 424242 });
    expect(stdout).toBe("424242\n");
  });
  test("getuid/getgid: the forced values", async () => {
    const bin = await buildProgram(`console.log(process.getuid?.(), process.getgid?.());`);
    const { stdout } = await runForced(bin, { uid: 4242, gid: 4343 });
    expect(stdout).toBe("4242 4343\n");
  });
  // `process.<stream>.isTTY` is typed BOOL here (lower-builtins.ts's own
  // "process.isTTY" libCall, `type: BOOL`), not Node's own `boolean |
  // undefined` — a pre-existing, out-of-P3-scope simplification (matches
  // SEMANTICS.md's stderr-is-always-a-pipe framing nearby): this tier
  // always answers a real boolean, never returns `undefined` for a
  // non-TTY stream the way Node's own Socket-backed stdio does.
  test("isTTY: forced true for fd 0, false for fd 1/2 (BOOL-typed, never undefined)", async () => {
    const bin = await buildProgram(`
      console.log(process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY);
    `);
    const { stdout } = await runForced(bin, { isTTY: (fd) => (fd === 0 ? 1 : 0) });
    expect(stdout).toBe("true false false\n");
  });
  test("columns: the -1 sentinel takes the undefined union arm", async () => {
    const bin = await buildProgram(`
      const c = (process.stdout as typeof process.stdout & { columns?: number }).columns;
      console.log(c === undefined);
      console.log(c ?? 80);
    `);
    const { stdout } = await runForced(bin, { columns: () => -1 });
    expect(stdout).toBe("true\n80\n");
  });
  test("columns: a real width crosses through the F64 union arm", async () => {
    const bin = await buildProgram(`
      const c = (process.stdout as typeof process.stdout & { columns?: number }).columns;
      console.log(c);
    `);
    const { stdout } = await runForced(bin, { columns: () => 120 });
    expect(stdout).toBe("120\n");
  });
  test("uptime/cpu/memory: predicates only, forced non-real values still round-trip", async () => {
    const bin = await buildProgram(`
      console.log(process.uptime());
      const c = process.cpuUsage();
      console.log(c.user, c.system);
      console.log(process.availableMemory(), process.constrainedMemory());
    `);
    const { stdout } = await runForced(bin, { uptime: 12.5, cpuUser: 1000, cpuSystem: 500, availableMemory: 123456, constrainedMemory: 654321 });
    expect(stdout).toBe("12.5\n1000 500\n123456 654321\n");
  });
  test("threadCpuUsage: forced values round-trip", async () => {
    const bin = await buildProgram(`
      const t = process.threadCpuUsage();
      console.log(t.user, t.system);
    `);
    const { stdout } = await runForced(bin, { threadCpuUser: 700, threadCpuSystem: 300 });
    expect(stdout).toBe("700 300\n");
  });
  test("the Diff forms subtract IN-MODULE (fresh - prev)", async () => {
    const bin = await buildProgram(`
      const c1 = process.cpuUsage();
      const c2 = process.cpuUsage(c1);
      console.log(c2.user, c2.system);
    `);
    const { stdout } = await runForced(bin, { cpuUser: 1500, cpuSystem: 800 });
    // both reads answer the SAME forced value (kind 8/9 ignore call count),
    // so the diff is exactly 0 — pins that the subtraction is in-module,
    // not double-counted or host-side.
    expect(stdout).toBe("0 0\n");
  });
  test("rusage: Node's own 16-key order, printed via Object.keys", async () => {
    const bin = await buildProgram(`
      const ru = process.resourceUsage();
      console.log(Object.keys(ru).join(","));
    `);
    const { stdout } = await runForced(bin, { rusage: DEFAULT_RUSAGE });
    expect(stdout).toBe(
      "userCPUTime,systemCPUTime,maxRSS,sharedMemorySize,unsharedDataSize,unsharedStackSize,minorPageFault,majorPageFault,swappedOut,fsRead,fsWrite,ipcSent,ipcReceived,signalsCount,voluntaryContextSwitches,involuntaryContextSwitches\n",
    );
  });
  test("rusage: maxRSS is STRICTLY positive (design §2.3's own constraint)", async () => {
    const bin = await buildProgram(`
      const ru = process.resourceUsage();
      console.log(ru.maxRSS > 0);
    `);
    const { stdout } = await runForced(bin, { rusage: DEFAULT_RUSAGE });
    expect(stdout).toBe("true\n");
  });
});

// ── cpuPrevValidate (~4 rows) ──────────────────────────────────────────────
describe("P3 forced-host: cpuPrevValidate", () => {
  test("a negative prevValue.user throws Node's exact RangeError, checked BEFORE system", async () => {
    const bin = await buildProgram(`
      try { process.cpuUsage({ user: -1, system: 2 }); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("The property 'prevValue.user' is invalid. Received -1\n");
  });
  test("a non-finite prevValue.system throws, only reached when user passed", async () => {
    const bin = await buildProgram(`
      try { process.cpuUsage({ user: 3, system: -Infinity }); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("The property 'prevValue.system' is invalid. Received -Infinity\n");
  });
  test("both fields valid: no throw", async () => {
    const bin = await buildProgram(`
      const c = process.cpuUsage({ user: 0, system: 0 });
      console.log(typeof c.user, typeof c.system);
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("number number\n");
  });
  // M-5's own pin (found missing by the mutation battery: the two prior
  // rows each have exactly ONE invalid field, so a user/system CHECK-
  // ORDER swap cannot redden them — whichever field is checked first,
  // the OTHER one is valid and never throws, so the message is the same
  // either way). BOTH fields invalid here, so the order alone decides
  // which name is reported first.
  test("both fields invalid: the message names 'user' (checked BEFORE system, M-5's own pin)", async () => {
    const bin = await buildProgram(`
      try { process.cpuUsage({ user: -1, system: -2 }); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("The property 'prevValue.user' is invalid. Received -1\n");
  });
  test("NaN fails the SAME two-comparison test as a negative value (no separate isNaN check)", async () => {
    const bin = await buildProgram(`
      try { process.cpuUsage({ user: NaN, system: 0 }); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("The property 'prevValue.user' is invalid. Received NaN\n");
  });
});

// ── activeResources (~3 rows) ──────────────────────────────────────────────
describe("P3 forced-host: activeResources", () => {
  test("no handles: an empty array", async () => {
    const bin = await buildProgram(`console.log(JSON.stringify(process.getActiveResourcesInfo()));`);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("[]\n");
  });
  test("the FULL, unfiltered array groups Timeout before Immediate", async () => {
    const bin = await buildProgram(`
      setTimeout(() => {
        setImmediate(() => {
          console.log(JSON.stringify(process.getActiveResourcesInfo()));
        });
      }, 0);
    `);
    const { stdout } = await runForced(bin);
    // Inside the immediate's own callback the timeout has already fired
    // and (being non-repeating, non-rearmed) is gone; the immediate
    // itself is the one currently "firing" — but by the time ITS OWN
    // callback body runs, Node no longer counts a firing immediate for
    // ITSELF either (matches "a fired immediate no longer counts").
    expect(stdout).toBe("[]\n");
  });
  test("an unref'd timer is EXCLUDED (Node's own exclusion, measured)", async () => {
    const bin = await buildProgram(`
      const h = setTimeout(() => {}, 100000);
      h.unref();
      console.log(JSON.stringify(process.getActiveResourcesInfo().filter((t) => t === "Timeout")));
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("[]\n");
  });
});

// ── the warning surface (~12 rows) ────────────────────────────────────────
describe("P3 forced-host: the warning surface's grammar", () => {
  test("a non-string, non-Error warning throws ERR_INVALID_ARG_TYPE", async () => {
    const bin = await buildProgram(`
      try { process.emitWarning(123 as any); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The "warning" argument must be of type string or an instance of Error. Received type number (123)\n');
  });
  test("a non-string type throws ERR_INVALID_ARG_TYPE naming 'type'", async () => {
    const bin = await buildProgram(`
      try { process.emitWarning("m", 123 as any); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The "type" argument must be of type string. Received type number (123)\n');
  });
  test("a non-string code throws ERR_INVALID_ARG_TYPE naming 'code'", async () => {
    const bin = await buildProgram(`
      try { process.emitWarning("m", "T", 123 as any); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe('The "code" argument must be of type string. Received type number (123)\n');
  });
  test("a plain string warning: default type Warning, listener sees it", async () => {
    const bin = await buildProgram(`
      process.on("warning", (w: any) => console.log(w.name, w.message, w.code));
      process.emitWarning("plain");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("Warning plain undefined\n");
  });
  test("(msg, type): the type becomes the listener's .name", async () => {
    const bin = await buildProgram(`
      process.on("warning", (w: any) => console.log(w.name, w.message));
      process.emitWarning("typed", "CustomWarning");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("CustomWarning typed\n");
  });
  test("(msg, type, code): all three land on the listener's object", async () => {
    const bin = await buildProgram(`
      process.on("warning", (w: any) => console.log(w.name, w.message, w.code));
      process.emitWarning("coded", "CW", "CODE1");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("CW coded CODE1\n");
  });
  test("options form: {type, code, detail} all land", async () => {
    const bin = await buildProgram(`
      process.on("warning", (w: any) => console.log(w.name, w.message, w.code, w.detail));
      process.emitWarning("opt", { type: "OW", code: "CODE2", detail: "extra line" });
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("OW opt CODE2 extra line\n");
  });
  test("an Error warning KEEPS ITS OWN NAME and IGNORES the type argument", async () => {
    const bin = await buildProgram(`
      process.on("warning", (w: any) => console.log(w.name, w.message));
      const e = new Error("as error");
      e.name = "DeprecationWarning";
      process.emitWarning(e, "IgnoredType");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("DeprecationWarning as error\n");
  });
  test("an Error warning IS instanceof Error (L6's own requirement)", async () => {
    const bin = await buildProgram(`
      process.on("warning", (w: any) => console.log(w instanceof Error));
      process.emitWarning("plain");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("true\n");
  });
  test("off() removes by identity — a removed listener never fires", async () => {
    const bin = await buildProgram(`
      const seen: string[] = [];
      const cb = (w: any) => seen.push(w.message);
      process.on("warning", cb);
      process.off("warning", cb);
      process.emitWarning("should-not-appear");
      setImmediate(() => console.log(seen.length));
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("0\n");
  });
  test("the default report: no code, no bracket", async () => {
    const bin = await buildProgram(`process.emitWarning("plain msg");`);
    const { stderr } = await runForced(bin, { pid: 4242 });
    expect(stderr).toBe("(node:4242) Warning: plain msg\n(Use `node --trace-warnings ...` to show where the warning was created)\n");
  });
  test("the default report: WITH a code, the bracket appears", async () => {
    const bin = await buildProgram(`process.emitWarning("with code", "T", "MYCODE");`);
    const { stderr } = await runForced(bin, { pid: 4242 });
    expect(stderr).toBe("(node:4242) [MYCODE] T: with code\n(Use `node --trace-warnings ...` to show where the warning was created)\n");
  });
  test("the default report: a string detail gets its own line", async () => {
    const bin = await buildProgram(`process.emitWarning("m", { type: "T", detail: "more info" });`);
    const { stderr } = await runForced(bin, { pid: 4242 });
    expect(stderr).toBe("(node:4242) T: m\nmore info\n(Use `node --trace-warnings ...` to show where the warning was created)\n");
  });
  test("the trace-warnings hint prints exactly ONCE across multiple warnings", async () => {
    const bin = await buildProgram(`
      process.emitWarning("one");
      process.emitWarning("two");
    `);
    const { stderr } = await runForced(bin, { pid: 4242 });
    expect(stderr).toBe(
      "(node:4242) Warning: one\n(Use `node --trace-warnings ...` to show where the warning was created)\n(node:4242) Warning: two\n",
    );
  });
  test("ORDER ROW: no timer surface — the report/listener fire AFTER the synchronous section", async () => {
    const bin = await buildProgram(`
      process.on("warning", () => console.log("W"));
      process.emitWarning("x");
      console.log("main");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("main\nW\n");
  });
  test("ORDER ROW: A/T/B interleaving — a nextTick between two emitWarning calls fires BETWEEN their dispatches", async () => {
    const bin = await buildProgram(`
      process.on("warning", (w: any) => console.log("LISTENER:", w.message));
      process.emitWarning("A");
      process.nextTick(() => console.log("USER-TICK"));
      process.emitWarning("B");
      console.log("main done");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("main done\nLISTENER: A\nUSER-TICK\nLISTENER: B\n");
  });
  // G-1's own correction (gate round P3-F1): the ORIGINAL row put the
  // report on stderr and the listener's print on stdout — two
  // INDEPENDENT streams. Nothing in that shape can observe which ran
  // first (swapping dispatchWarnings' two calls would still pass it), so
  // it carried the name of a property it structurally could not test.
  // FIXED by making the listener write to the SAME stream as the report
  // (console.error, not console.log) — now a real single-stream ORDER
  // assertion: the report's own two lines, THEN the listener's line.
  test("REPORT-BEFORE-LISTENER ORDER: within one warning's dispatch, the default report precedes the user listener", async () => {
    const bin = await buildProgram(`
      process.on("warning", () => console.error("LISTENER"));
      process.emitWarning("x");
    `);
    const { stderr } = await runForced(bin, { pid: 1 });
    expect(stderr).toBe(
      "(node:1) Warning: x\n(Use `node --trace-warnings ...` to show where the warning was created)\nLISTENER\n",
    );
  });
});

// ── setRawMode's TTY trap (design §3F/A-3; 1 row) ──────────────────────────
describe("P3 forced-host: stdinSetRawMode", () => {
  test("non-TTY: the exact TypeError text, no .code, from the gate", async () => {
    const bin = await buildProgram(`
      try { process.stdin.setRawMode(false); } catch (e) { console.log((e as Error).message); }
    `);
    const { stdout } = await runForced(bin, { isTTY: () => 0 });
    expect(stdout).toBe("process.stdin.setRawMode is not a function\n");
  });
  test("TTY (unreachable by design — §11 serves isTTY false for 0/1/2 in every real host): a forced isTTY(0)=1 row traps by name", async () => {
    const bin = await buildProgram(`process.stdin.setRawMode(true);`);
    const { readFileSync } = await import("node:fs");
    const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(bin), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
        },
        now: () => 0,
        seed: () => 0n,
        wallClock: () => 0,
        hostStr: () => -1,
        hostNum: (kind: number) => (kind === 5 ? 1 : 0), // isTTY(0)=1
        exit: () => {
          throw new ExitSignal(0);
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    let trapped = false;
    try {
      (instance.exports["_start"] as () => void)();
    } catch (err) {
      expect(err).toBeInstanceOf(WebAssembly.RuntimeError);
      trapped = true;
    }
    expect(trapped).toBe(true);
    expect(Buffer.concat(chunks[2]).toString("utf8")).toContain("process.stdinSetRawMode");
  });
});

// ── the two D5 refusals (diagnostics-shaped, compile-time) ────────────────
describe("P3 forced-host: onSignal/offSignal refuse by name", () => {
  // The ambient type only overloads process.on/removeListener's signal
  // form for "SIGINT" | "SIGTERM" — an unlisted name (e.g. "SIGWINCH")
  // never reaches the backend at all (a plain TS overload error, SC0001);
  // "SIGTERM" is the one that actually exercises the wasm backend's own
  // refusal path.
  test("process.on('SIGTERM', cb) refuses with the named diagnostic", async () => {
    const { code } = await expectRefused(`process.on("SIGTERM", () => {});`);
    expect(code).toBe("SC3001");
  });
  test("process.off('SIGTERM', cb) refuses under the SAME bucket (A-9)", async () => {
    const { code } = await expectRefused(`process.removeListener("SIGTERM", () => {});`);
    expect(code).toBe("SC3001");
  });
});
