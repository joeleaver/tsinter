/* INC-26 pass P1 (design-host-v7.txt cccf7d6e §2.2/§3G/§10-ii; DECISIONS.md
 * D2/D3/D4; cp1-plan-p1.txt 70a46350) — the FORCED-HOST unit rows: every
 * row here compares against a TABLE of KNOWN values, never the real host
 * (§10-ii's own point: a row that reads the real host and compares to the
 * real host proves nothing). This is a SEPARATE `instantiate()` from
 * wasm-host.ts's shared one, in wasm-random.test.ts's own "PRECEDENT FOR
 * A HOST-FORCED UNIT PIN" shape — the shared host's argv/env/cwd/platform
 * stay realistic defaults precisely so no OTHER test can accidentally
 * depend on a forced value the real host would never produce.
 *
 * FORCED VALUES ARE DELIBERATELY NOT THE REAL HOST'S: platform is
 * "win32" on whatever machine runs this suite, cwd is a synthetic path —
 * a row that happened to pass because the forced value MATCHED the real
 * one would not be falsifiable. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-process-"));
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

interface ForcedHost {
  argv?: readonly string[];
  env?: readonly (readonly [string, string])[];
  cwd?: string;
  platform?: string;
  /** M-11's own pin: a forced `exit` that RETURNS instead of throwing —
   * the module's defensive `unreachable` must trap. */
  exitReturns?: boolean;
  /** D4's own committed pin (test-file only, no source change): the
   * wallClock advances with virtual time (`base + clock`), NOT per-call
   * real time — M-12's own per-call-base mutant is exercised separately
   * below as this pass's twelfth mutation. */
  wallClockBase?: number;
}

const DEFAULT_ARGV = ["scriptc", "/forced/host/module.wasm"] as const;
const DEFAULT_ENV: readonly (readonly [string, string])[] = [];
const DEFAULT_CWD = "/forced/cwd/for/host/test";
const DEFAULT_PLATFORM = "win32";

function writeUtf16(memory: WebAssembly.Memory, s: string, ptr: number, cap: number): number {
  if (s.length > cap) return s.length;
  const view = new Uint16Array(memory.buffer, ptr, s.length);
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
  return s.length;
}

async function runForced(binaryPath: string, host: ForcedHost = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const argv = host.argv ?? DEFAULT_ARGV;
  const env = host.env ?? DEFAULT_ENV;
  const cwd = host.cwd ?? DEFAULT_CWD;
  const platform = host.platform ?? DEFAULT_PLATFORM;
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  const wallBase = host.wallClockBase ?? 0;
  const { readFileSync } = await import("node:fs");
  const { instance } = await WebAssembly.instantiate(readFileSync(binaryPath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => clock,
      seed: (): bigint => 0n,
      wallClock: (): number => wallBase + clock,
      hostStr(kind: number, index: number, ptr: number, cap: number): number {
        switch (kind) {
          case 0:
            return index >= 0 && index < argv.length ? writeUtf16(memory!, argv[index]!, ptr, cap) : -1;
          case 1:
            return index >= 0 && index < env.length ? writeUtf16(memory!, env[index]![0], ptr, cap) : -1;
          case 2:
            return index >= 0 && index < env.length ? writeUtf16(memory!, env[index]![1], ptr, cap) : -1;
          case 3:
            return writeUtf16(memory!, cwd, ptr, cap);
          case 4:
            return writeUtf16(memory!, platform, ptr, cap);
          default:
            throw new Error(`hostStr: unknown kind ${kind}`);
        }
      },
      hostNum(kind: number): number {
        switch (kind) {
          case 0:
            return argv.length;
          case 1:
            return env.length;
          default:
            throw new Error(`hostNum: unknown kind ${kind}`);
        }
      },
      exit(code: number): void {
        if (host.exitReturns) return; // M-11: a broken host that returns
        throw new ExitSignal(code);
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

/** Shared driver for the trapping rows (P1-R2 (a)/(b)/(d)): a module that
 * both prints and CATCHABLY traps needs its own driver — `runForced` only
 * returns cleanly for `process.exit`/normal completion. Generalizes the
 * M-2/M-3 rows' own inline pattern rather than repeating it a third and
 * fourth time. Host is the minimal shape those two rows already used —
 * none of the R2 trapping rows read argv/env/cwd/platform. */
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

describe("INC-26 P1 forced-host rows", () => {
  test("argv: length 2, both strings, non-empty (S070's own shape)", async () => {
    const bin = await buildProgram(`
      console.log(process.argv.length);
      console.log(process.argv[0]);
      console.log(process.argv[1]);
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("2\nscriptc\n/forced/host/module.wasm\n");
  });

  test("cwd: the forced value, unchanged across two calls", async () => {
    const bin = await buildProgram(`
      console.log(process.cwd());
      console.log(process.cwd() === process.cwd());
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("/forced/cwd/for/host/test\ntrue\n");
  });

  test("platform: the forced (deliberately unreal) value", async () => {
    const bin = await buildProgram(`console.log(process.platform);`);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("win32\n");
  });

  test("env: FIXED_KEY, registration order via Object.keys", async () => {
    const bin = await buildProgram(`
      console.log(process.env.FIXED_KEY);
      console.log(Object.keys({...process.env}).join(","));
    `);
    const { stdout } = await runForced(bin, {
      env: [
        ["FIXED_KEY", "fixed_value"],
        ["OTHER", "x"],
      ],
    });
    expect(stdout).toBe("fixed_value\nFIXED_KEY,OTHER\n");
  });

  // §2.2/§7a: the JS-lone-surrogate-through-env case — LENGTH 1, prints as
  // ONE U+FFFD (three UTF-8 bytes EF BF BD). Combines the odd-length
  // requirement (length 1 is odd) and the U+FFFD requirement in one row,
  // per the design's own suggestion.
  test("env: a lone surrogate arrives as length 1 and prints U+FFFD", async () => {
    const bin = await buildProgram(`
      const v = process.env.ODD_FFFD_KEY!;
      console.log(v.length);
      process.stdout.write(v);
      process.stdout.write("\\n");
    `);
    const { stdout } = await runForced(bin, { env: [["ODD_FFFD_KEY", "\ud800"]] });
    const lines = stdout.split("\n");
    expect(lines[0]).toBe("1");
    // The write-boundary transcode replaces the lone surrogate with
    // U+FFFD — UTF-8 bytes EF BF BD — exactly what Node's own stdout
    // write does to the same JS string.
    expect(Buffer.from(stdout.slice(2, stdout.length - 1), "utf8")).toEqual(Buffer.from([0xef, 0xbf, 0xbd]));
  });

  // The control that proves the channel does not simply replace
  // everything: a well-formed non-ASCII value must arrive INTACT.
  test("env: a well-formed non-ASCII value arrives intact (the control)", async () => {
    const bin = await buildProgram(`console.log(process.env.NONASCII_KEY);`);
    const { stdout } = await runForced(bin, { env: [["NONASCII_KEY", "héllo世界"]] });
    expect(stdout).toBe("héllo世界\n");
  });

  // §2.2's retry contract: a value LONGER than the first-attempt buffer
  // (64 code units) must still arrive byte-exact — this is the row that
  // actually exercises len > cap ⇒ nothing written, retry at >= len.
  test("env: a value longer than the first-attempt buffer round-trips exactly (the retry row)", async () => {
    const long = "x".repeat(100);
    const bin = await buildProgram(`
      const v = process.env.LONG_KEY!;
      console.log(v.length);
      console.log(v === "${long}");
    `);
    const { stdout } = await runForced(bin, { env: [["LONG_KEY", long]] });
    expect(stdout).toBe("100\ntrue\n");
  });

  // M-4's own pin: the 100-code-unit retry row above does NOT redden
  // under "cap passed in code units without ×2" (measured — a single
  // 64KiB memory page has enough slack that a merely-under-computed
  // capacity still fits, so a mutation that reddens nothing on that row
  // would ship undetected). ADDENDUM df54abd9: this row's own arithmetic,
  // stated — the module's memory starts at ONE page (`ensureMemory(1)`,
  // emitter.ts), the staging region's base offset is byte 0
  // (`cursorGlobal`'s own i32.const 0 initializer, emitter.ts), and a
  // page is 65,536 bytes. 40,000 code units is chosen because it
  // straddles that page on EXACTLY the axis the mutation removes:
  //   correct (×2 to bytes):    2 × 40,000 = 80,000 bytes > 65,536  (grows)
  //   mutant (code units only):     40,000 bytes        ≤ 65,536  (fits, wrongly)
  // — the correct capacity computation must grow the memory past its
  // first page for this value; the mutant's under-computed one still
  // fits inside it, so the host's own TypedArray view construction goes
  // short (RangeError) only under the mutant. The 100-code-unit row
  // above is the PAIRED CONTROL: it must pass under BOTH arms (100 × 2 =
  // 200 bytes fits the first page regardless of the mutation, so that
  // row alone cannot discriminate — this is why it does not catch M-4
  // and why both rows are kept together). A change to the staging
  // region's base offset or the initial page count would silently stop
  // this row discriminating while it stayed green — the values above are
  // this row's own contract with that fact, not just narration.
  test("env: a value crossing a memory-page boundary catches the code-unit/byte conversion (M-4's own pin)", async () => {
    const huge = "x".repeat(40_000);
    const bin = await buildProgram(`
      const v = process.env.HUGE_KEY!;
      console.log(v.length);
    `);
    const { stdout } = await runForced(bin, { env: [["HUGE_KEY", huge]] });
    expect(stdout).toBe("40000\n");
  });

  // M-11: a forced `exit` that RETURNS instead of throwing must trap at
  // the module's own defensive `unreachable` — the row that keeps this
  // mutation from reddening nothing.
  test("exit: a host that returns instead of terminating traps", async () => {
    const bin = await buildProgram(`process.exit(3);`);
    await expect(runForced(bin, { exitReturns: true })).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
  });

  // M-1's first snapshot row: a listener REGISTERED during the drain does
  // NOT run this round.
  test("exit drain: a listener registered from inside another exit listener does not run", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => {
        console.log("A ran");
        process.on("exit", () => { console.log("SHOULD NOT RUN"); });
      });
      console.log("main done");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("main done\nA ran\n");
  });

  // M-1's second snapshot row: a listener REMOVED during the drain still
  // runs (it was already in the SNAPSHOT the walk is iterating).
  test("exit drain: a listener removed from inside another exit listener during the drain still runs", async () => {
    const bin = await buildProgram(`
      const b = () => { console.log("B ran"); };
      process.on("exit", () => {
        console.log("A ran");
        process.off("exit", b);
      });
      process.on("exit", b);
      console.log("main done");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("main done\nA ran\nB ran\n");
  });

  // M-2's own row: an 'exit' listener combined with an UNHANDLED
  // REJECTION (no onUnhandledRejection listener, so the DEFAULT
  // report/trap fires via promises.ts's emitReport) — the row that
  // distinguishes "the drain lives inside reportUncaughtHelper" from
  // "the drain lives inside emitReport", since 1446 alone only exercises
  // the FORMER.
  test("exit drain: an 'exit' listener sees code 1 on the default unhandled-rejection trap path (M-2's own row)", async () => {
    const bin = await buildProgram(`
      'use strict';
      process.on("exit", (code) => { console.log("exit saw", code); });
      console.log("before reject");
      async function doomed() { throw new Error("boom"); }
      doomed();
    `);
    // A custom driver, not runForced: the assertion needs the PARTIAL
    // stdout up to the trap (proving the listener ran BEFORE the trap),
    // which a plain "it rejects" check cannot distinguish from "the
    // listener never ran at all" — both end in the same RuntimeError.
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
    expect(Buffer.concat(chunks).toString("utf8")).toBe("before reject\nexit saw 1\n");
  });

  // M-3's own row: a throw reached via a call site OTHER than `_start`'s
  // own post-entry check or `%w.tick`'s death check — a queueMicrotask
  // callback throwing routes to reportUncaughtHelper via mtResumeHelper,
  // a THIRD call site design §4.4 names as one of the "extras". Proves
  // the drain lives INSIDE reportUncaughtHelper generally, not just at
  // the two sites a naive reading of "before each unreachable" would
  // have covered.
  test("exit drain: a throw inside a queueMicrotask callback still drains (M-3's own row, an 'extra' fence site)", async () => {
    const bin = await buildProgram(`
      process.on("exit", (code) => { console.log("exit saw", code); });
      console.log("before boom");
      queueMicrotask(() => { throw new Error("boom"); });
    `);
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
    expect(Buffer.concat(chunks).toString("utf8")).toBe("before boom\nexit saw 1\n");
  });

  // M-9: a no-timer module (no `_tick` export at all) must still drain
  // at _start's own tail — 1444 has a timer, which confounds this exact
  // case, so this row isolates it.
  test("exit drain: a no-timer module drains at _start's own tail", async () => {
    const bin = await buildProgram(`
      process.on("exit", (code) => { console.log("exit", code); });
      console.log("main done");
    `);
    const { stdout, exitCode } = await runForced(bin);
    expect(stdout).toBe("main done\nexit 0\n");
    expect(exitCode).toBe(0);
  });

  // D4(a) — the ruled-in wallClock committed pin, test-file only: a 20ms
  // setTimeout program prints a Date.now() delta of EXACTLY 20 through
  // the SAME base+clock host shape production code gets.
  test("D4(a): a 20ms setTimeout program measures a Date.now() delta of exactly 20", async () => {
    const bin = await buildProgram(`
      const t0 = Date.now();
      setTimeout(() => {
        console.log(Date.now() - t0);
      }, 20);
    `);
    const { stdout } = await runForced(bin, { wallClockBase: 1_700_000_000_000 });
    expect(stdout).toBe("20\n");
  });

  // D4(b): a no-timer program measures ~0 across a busy loop — the
  // driver asserts its OWN measured real duration so the row cannot pass
  // vacuously (the busy loop must actually have taken >= 5ms of REAL time
  // for this to be a meaningful assertion about the VIRTUAL clock).
  test("D4(b): a no-timer program sees a Date.now() delta of 0 across a real busy wait", async () => {
    const bin = await buildProgram(`
      const t0 = Date.now();
      let x = 0;
      for (let i = 0; i < 50_000_000; i++) x += i;
      console.log(Date.now() - t0, x > 0);
    `);
    const realT0 = performance.now();
    const { stdout } = await runForced(bin, { wallClockBase: 1_700_000_000_000 });
    const realElapsed = performance.now() - realT0;
    expect(realElapsed).toBeGreaterThanOrEqual(5);
    expect(stdout).toBe("0 true\n");
  });

  // M-12: the per-call-Date.now() mutant — the twelfth mutation D4 adds.
  // Run for real here as its own NEGATIVE-controlled row: with a host
  // that reads a REAL clock per call instead of base+virtual-clock, D4(b)
  // must go RED (D4(a) may stay green, stated per the lead's own ruling).
  test("M-12 (negative control): a per-call real-time wallClock reddens D4(b) but not necessarily D4(a)", async () => {
    const bin = await buildProgram(`
      const t0 = Date.now();
      let x = 0;
      for (let i = 0; i < 50_000_000; i++) x += i;
      console.log(Date.now() - t0, x > 0);
    `);
    // A per-call mutant host: wallClock reads Date.now() directly instead
    // of base + virtual clock.
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
        wallClock: (): number => Date.now(), // the mutant: real time, per call
      },
    });
    memory = instance.exports.memory as WebAssembly.Memory;
    (instance.exports["_start"] as () => void)();
    const line = Buffer.concat(chunks).toString("utf8").trim();
    expect(line).not.toBe("0 true"); // reddened, as predicted
  });

  // PRE-FREEZE ADDENDUM's own wording correction: D4(a)'s own arm, RUN
  // FOR REAL rather than left as "may stay green" — MEASURED TWICE, with
  // a genuine surprise on the second measurement (reported here, not
  // silently smoothed over): in ISOLATION (a quiet run of just this
  // file, 20/20 trials) the tick-pump loop's total lack of any REAL wait
  // makes both Date.now() reads land in the same real millisecond every
  // time, printing "0". Under this whole SUITE's own parallel worker
  // contention, at least one trial measured something OTHER than "0" —
  // real scheduling jitter is real. What does NOT change under either
  // condition, and is the only claim asserted below: it never
  // coincidentally reproduces the ORIGINAL row's passing value "20" (a
  // genuine ~20ms real gap between two adjacent statements has no
  // plausible mechanism here) — that IS what "reddens" means for this
  // row, and it holds regardless of system load. This REPLACES the
  // addendum's own speculative "green-with-flake-risk (a real-
  // millisecond boundary... makes 21)" framing outright: measured under
  // load, the failure mode is jitter near 0, not a near-miss near 20.
  test("M-12 (a): a per-call real-time wallClock ALSO reddens D4(a) — measured, including under load", async () => {
    const bin = await buildProgram(`
      const t0 = Date.now();
      setTimeout(() => {
        console.log(Date.now() - t0);
      }, 20);
    `);
    const { readFileSync } = await import("node:fs");
    const results: string[] = [];
    for (let trial = 0; trial < 20; trial++) {
      const chunks: Buffer[] = [];
      let memory: WebAssembly.Memory | null = null;
      let clock = 0;
      const { instance } = await WebAssembly.instantiate(readFileSync(bin), {
        tsinter: {
          write(fd: number, ptr: number, len: number): void {
            if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
          },
          now: (): number => clock,
          seed: (): bigint => 0n,
          wallClock: (): number => Date.now(), // the mutant: real time, per call
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
      memory = instance.exports.memory as WebAssembly.Memory;
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
      results.push(Buffer.concat(chunks).toString("utf8").trim());
    }
    // The ROBUST claim, true under any system load: never the original
    // row's passing value. This is what "reddens" means for this row.
    expect(results.every((r) => r !== "20")).toBe(true);
    // The QUIET-CPU observation (not asserted as a hard invariant, since
    // this whole suite's own parallel run already falsified "always
    // exactly 0" once): most trials should still be small, near-zero
    // jitter, not anywhere near a real 20ms gap.
    const asNumbers = results.map((r) => Number(r));
    expect(asNumbers.every((n) => Number.isFinite(n) && n < 15)).toBe(true);
  });

  // D10's own instance of S-1's hazard: BUILT this pass, reached by NO
  // program at any stage. These two rows exist so this pass's gate does
  // not have P4's own unlinkSync-shaped blind spot.
  test("offUnhandledRejection: registers, removes, and the removed listener does not fire", async () => {
    const bin = await buildProgram(`
      'use strict';
      const cb = (err: unknown, promise: unknown) => { console.log("SHOULD NOT RUN", err, promise); };
      process.on("unhandledRejection", cb);
      process.off("unhandledRejection", cb);
      async function doomed() { throw new Error("boom"); }
      doomed();
      console.log("sync tail");
    `);
    // No listener remains registered, so the DEFAULT report/trap applies
    // (Node's own exit 1) — expect the TRAP, not a normal completion;
    // stdout up to the trap carries only the synchronous tail.
    await expect(runForced(bin)).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
  });

  // PRE-FREEZE ADDENDUM (rev-26): the complementary failure to
  // under-matching (which the strictEq fix cures) is OVER-matching — two
  // DIFFERENT function values comparing equal, so one off-call removes
  // the WRONG listener. Two distinct listeners, remove one, prove the
  // OTHER still fires.
  test("offExit: two distinct listeners, removing one leaves the other registered and firing", async () => {
    const bin = await buildProgram(`
      const a = () => { console.log("A ran"); };
      const b = () => { console.log("B ran"); };
      process.on("exit", a);
      process.on("exit", b);
      process.off("exit", a);
      console.log("main done");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("main done\nB ran\n");
  });

  test("offUnhandledRejection: two distinct listeners, removing one leaves the other registered and firing", async () => {
    const bin = await buildProgram(`
      'use strict';
      const a = (err: unknown, promise: unknown) => { console.log("SHOULD NOT RUN"); };
      const b = (err: unknown, promise: unknown) => { console.log("B ran"); };
      process.on("unhandledRejection", a);
      process.on("unhandledRejection", b);
      process.off("unhandledRejection", a);
      async function doomed() { throw new Error("boom"); }
      doomed();
      console.log("sync tail");
    `);
    const { stdout, exitCode } = await runForced(bin);
    expect(stdout).toBe("sync tail\nB ran\n");
    expect(exitCode).toBe(0);
  });

  // ── RULING P1-R2: the throwing exit listener, Node's measured rule ─────
  // (findings-rev26-p1-throwing-listener.txt befdf83e/75, five Node
  // v24.18.1 probes). Rows R2-a..d, the load-bearing pair named by name
  // being (a) and (b) — the two "unconditionally" distinguishes.

  // R2-a: FATAL path (an uncaught throw already has a real exception to
  // render) — the throwing listener's own error is dropped, the ORIGINAL
  // is what stderr names, and the exit code (a trap here) is unaffected.
  test("P1-R2 (a): a throwing exit listener on the FATAL path does not corrupt the original uncaught error", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => { throw new Error("listener boom"); });
      throw new Error("original boom");
    `);
    const { stderr } = await runForcedExpectTrap(bin);
    expect(stderr).toBe("Uncaught Error: original boom\n");
  });

  // R2-b: the IMPLICIT-0 path (ordinary quiescence, nothing pending) — the
  // listener's OWN error must survive (not be swallowed by "restore
  // unconditionally" over it) and gets reported as uncaught; the implicit
  // 0 becomes 1 (a trap, this tier's exit-1 channel).
  test("P1-R2 (b): a throwing exit listener on the IMPLICIT-0 path reports the listener's OWN error (0 becomes 1)", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => { throw new Error("listener boom"); });
      console.log("main done");
    `);
    const { stdout, stderr } = await runForcedExpectTrap(bin);
    expect(stdout).toBe("main done\n");
    expect(stderr).toBe("Uncaught Error: listener boom\n");
  });

  // R2-c: the ONE drain site with an EXPLICIT code — Node's measured rule
  // keeps it UNCHANGED even though the listener threw (exit 3 survives),
  // and the listener's error is still printed (rendered without a trap,
  // since a trap would have no code to hand the `exit` import).
  test("P1-R2 (c): process.exit(3) with a throwing listener still exits 3, with the listener's error printed", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => { throw new Error("listener boom"); });
      process.exit(3);
    `);
    const { stderr, exitCode } = await runForced(bin);
    expect(stderr).toBe("Uncaught Error: listener boom\n");
    expect(exitCode).toBe(3);
  });

  // R2-d: two listeners, the first throws — the second is skipped
  // entirely (unchanged from before P1-R2), on the SAME implicit-0-
  // becomes-1 path as (b).
  test("P1-R2 (d): two exit listeners, the first throws — the second is skipped, implicit 0 becomes 1", async () => {
    const bin = await buildProgram(`
      process.on("exit", () => { throw new Error("first boom"); });
      process.on("exit", () => { console.log("SHOULD NOT RUN"); });
      console.log("main done");
    `);
    const { stdout, stderr } = await runForcedExpectTrap(bin);
    expect(stdout).toBe("main done\n");
    expect(stderr).toBe("Uncaught Error: first boom\n");
  });

  // ── RULING P1-R3/P1-R5: process.on("rejectionHandled", ...) is BUILT,
  // not registration-only (a silent-diverge otherwise), and the timing is
  // IMPLEMENTED against Node's real rule rather than registered as a
  // divergence (a register entry was drafted and then retired — this is
  // no longer a difference from Node). Node's rule, measured
  // (rev-26's five-probe preread): CHECKPOINT-relative, not reaction-
  // relative — the event fires from a HANDLED pass that runs AFTER the
  // turn's own microtasks/nextTicks drain, BEFORE the unhandled pass, in
  // FIFO (attach) order. A handler attached in the SAME turn as the
  // rejection fires nothing (the existing negative row). ────────────────

  test("onRejectionHandled: fires AFTER the turn's own microtask drain, once, when a handler attaches after the checkpoint (the positive row)", async () => {
    const bin = await buildProgram(`
      'use strict';
      process.on("unhandledRejection", (reason: unknown, promise: unknown) => {
        console.log("unhandled seen");
        setTimeout(() => {
          // Attached to the ORIGINAL statically-typed reference, not the
          // freshly-boxed generic dyn value the listener above received
          // as "promise" — this backend does not preserve promise
          // identity across that boundary, the same stance
          // onUnhandledRejection's own "promise" argument already takes.
          p.catch(() => { console.log("late catch ran"); });
        }, 0);
      });
      process.on("rejectionHandled", (promise: unknown) => {
        console.log("rejectionHandled fired");
      });
      async function doomed() { throw new Error("boom"); }
      const p = doomed();
      console.log("sync tail");
    `);
    const { stdout } = await runForced(bin);
    // The precondition, stated: the checkpoint's ledger walk must ALREADY
    // have handed this rejection to the unhandledRejection listener
    // (setting PROM_REPORTED_UNHANDLED) BEFORE the later timer's .catch()
    // ever runs — "unhandled seen" precedes both the catch and the fire.
    // NODE'S OWN MEASURED ORDER (checkpoint-relative, not reaction-
    // relative): the catch reaction's own output prints BEFORE the event
    // — the reaction is a plain microtask, and every microtask this turn
    // drains before the checkpoint's own HANDLED pass runs.
    expect(stdout).toBe("sync tail\nunhandled seen\nlate catch ran\nrejectionHandled fired\n");
  });

  test("onRejectionHandled: does NOT fire when the handler was attached BEFORE the checkpoint (the negative)", async () => {
    const bin = await buildProgram(`
      'use strict';
      process.on("rejectionHandled", () => { console.log("SHOULD NOT RUN"); });
      async function doomed() { throw new Error("boom"); }
      const p = doomed();
      p.catch(() => { console.log("caught early"); });
      console.log("sync tail");
    `);
    const { stdout, exitCode } = await runForced(bin);
    // Caught before the ledger walk ever runs: PROM_REPORTED_UNHANDLED is
    // never set (the rejection was never reported unhandled at all — it
    // was always going to be handled), so there is nothing to fire on.
    expect(stdout).toBe("sync tail\ncaught early\n");
    expect(exitCode).toBe(0);
  });

  // The ORDERING row (P1-R5): a late-HANDLED promise (A, reported
  // unhandled last turn, caught this turn) and a NEWLY-rejected one (B,
  // rejected and reported unhandled for the FIRST time this SAME turn) —
  // Node's own HANDLED-before-unhandled pass order means A's
  // rejectionHandled listener fires BEFORE B's own unhandled report,
  // even though B's rejection is "younger" than A's attach.
  test("onRejectionHandled: a late-handled promise fires BEFORE a same-turn newly-unhandled one is reported (the ordering row)", async () => {
    const bin = await buildProgram(`
      'use strict';
      let n = 0;
      process.on("unhandledRejection", () => {
        n++;
        console.log("reported unhandled #" + n);
      });
      process.on("rejectionHandled", () => { console.log("rejectionHandled fired"); });
      async function doomedA() { throw new Error("A"); }
      const a = doomedA();
      setTimeout(() => {
        a.catch(() => {});
        async function doomedB() { throw new Error("B"); }
        doomedB();
      }, 0);
      console.log("sync tail");
    `);
    const { stdout } = await runForced(bin);
    // #1 is A, reported at the FIRST checkpoint (before the timer ever
    // fires). The timer then attaches A's late catch and creates B in the
    // SAME turn; that turn's own checkpoint fires A's rejectionHandled
    // BEFORE running report() (which finds B, #2) — the assertion IS the
    // order of these three lines, not just that all three appear.
    expect(stdout).toBe("sync tail\nreported unhandled #1\nrejectionHandled fired\nreported unhandled #2\n");
  });

  // RETIRED (RULING P1-R6): this was meant to be the MULTI-HANDLED
  // FIFO-ORDER row — two promises attached to in REVERSE creation order,
  // proving the fire order follows ATTACH order. Diagnosing why mutation
  // M-16 (drain the FIFO in LIFO order) reddened NOTHING found the real
  // reason: the row's own "order" queue was filled in FIXED SOURCE-CODE
  // sequence, and the rejectionHandled listener's argument cannot
  // distinguish which promise actually fired (SEMANTICS.md S076 — no
  // promise identity is preserved across the dyn boundary), so the
  // printed order was always the SAME regardless of the real internal
  // dispatch order. FIFO order is UNOBSERVABLE by construction until
  // board #140 (identity-preserving listener arguments) lands. Kept as a
  // COUNT-only row: it still proves the listener fires exactly once PER
  // handled promise, not once overall or zero times — a real assertion
  // this backend can make, unlike order.
  test("onRejectionHandled: fires once per handled promise (a count row — order is unobservable, S076)", async () => {
    const bin = await buildProgram(`
      'use strict';
      let fires = 0;
      process.on("unhandledRejection", () => {});
      process.on("rejectionHandled", () => { fires++; console.log("fires", fires); });
      async function doomedA() { throw new Error("A"); }
      async function doomedB() { throw new Error("B"); }
      const a = doomedA();
      const b = doomedB();
      setTimeout(() => {
        b.catch(() => {});
        a.catch(() => {});
      }, 0);
      console.log("sync tail");
    `);
    const { stdout } = await runForced(bin);
    expect(stdout).toBe("sync tail\nfires 1\nfires 2\n");
  });
});
