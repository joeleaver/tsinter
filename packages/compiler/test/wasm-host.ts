/* The abi.ts host contract, for the unit tests: instantiate a compiled
 * module, service `tsinter.write` into per-fd buffers, run `_start`, pump
 * `_tick` to quiescence, and read `_status` for the exit code. The
 * differential harness
 * (tests/harness/wasm-differential.test.ts) runs the same driver against
 * the corpus — this is the same loop, kept here so a test can assert on
 * output without a corpus program.
 *
 * THE CLOCK IS VIRTUAL: `tsinter.now` answers the deadline the pump last
 * jumped to, so nothing ever sleeps and a five-second timer costs
 * nothing. Timer programs are order-only by construction, so that is not
 * an approximation of anything observable.
 *
 * `tsinter.seed` (INC-25 P1, abi.ts §8.1) is serviced from a CSPRNG, same
 * as the differential harness's own host — so no test using this shared
 * instantiate() can depend on a fixed Math.random sequence. The seed pin
 * (wasm-random.test.ts) forces a specific seed with its OWN host instead,
 * a copy of this file's instantiate with `seed: () => BigInt(N)` — this
 * shared host must stay random precisely so nothing here can accidentally
 * pin a value Node would never produce.
 *
 * INC-26 R0 (board #135): this file also stubs `tsinter.wallClock`, and
 * documents — right beside it, in `instantiate()`'s `tsinter: {...}`
 * object — the ONE place P1..P5 add their own conditionally-minted
 * import stubs as abi.ts mints the constants for them.
 *
 * INC-26 P1: `hostStr`/`hostNum`/`exit` land here too, with DEFAULT
 * values (argv=["scriptc","program.wasm"], an empty env, cwd="/",
 * platform=the REAL `process.platform` — a default must not break an
 * unrelated test that happens to print it, unlike the other three which
 * are already synthetic). `exit` throws a local sentinel `drive()`
 * recognises and reports as `exitCode`, mirroring the differential
 * harness's own `runWasm`. These are DEFAULTS for the 21 existing
 * importers that never chose to exercise process host facts, not the
 * FORCED host the P1 unit rows compare against a table — that host is
 * wasm-host-process.test.ts's own, separate `instantiate()` copy
 * (wasm-random.test.ts's own "PRECEDENT FOR A HOST-FORCED UNIT PIN"
 * shape), exactly because a forced row needs KNOWN, deliberately
 * non-real values (§10-ii: a row that reads the real host and compares
 * to the real host proves nothing).
 *
 * INC-26 P3: `hostNum` gains its SECOND parameter (`arg` — P1's kinds 0/1
 * never needed it, isTTY(fd)/columns(fd)/rusage(idx) do), `hostStr` gains
 * SYNTHETIC defaults for arch/versions.node/versions.openssl/execPath (no
 * existing importer reads any of these, so synthetic is safe the way
 * cwd/platform's own synthetic values would NOT be), and `kill`/`chdir`/
 * `umask` land as no-op-shaped defaults (kill answers success without
 * recording anything; chdir/umask answer success and mutate nothing) —
 * again, DEFAULTS for importers that reach these keys incidentally, never
 * the FORCED host wasm-host-process-p3.test.ts's own copy compares
 * against a table.
 *
 * INC-26 P4 (design-host-v7.txt §2.6, brief-p4-v2.md §0(vii)/§3A, CP1
 * delta (c); rev-26's 3B read P-1): `hostStr` gains SYNTHETIC defaults for
 * os.tmpdir/os.homedir (kinds 8/9 — measured this pass: ZERO of the 21
 * importers of this shared host touch either key in their own compiled
 * programs, so synthetic is safe here exactly as it is for arch/versions/
 * execPath above). `fsCall` lands LOUD BY DESIGN, never a plausible-
 * answering default (R0's board #135 stance, applied to the fs family):
 * EVERY op throws a host error naming the op, the first time any shared-
 * host importer reaches an fs key it has not been given a forced host
 * for — NO EXCEPTION for op 19 (exists), even though -1 ("does not
 * exist") is a VALID encoding under §0(vi): it is a CORRECT, PLAUSIBLE
 * answer, which is exactly what makes a silent default dangerous there
 * (P-1's own point) — board #135's hazard reintroduced for one op with
 * no caller to justify it, since nothing reaches op 19 through this
 * shared host today. A future test needing `existsSync` supplies a
 * FORCED host (wasm-host-fs-p4.test.ts's own job). */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect } from "vitest";

/** `tsinter.exit`'s sentinel (abi.ts §2.5) — thrown by the host, caught
 * inside `drive()` before it can propagate as an unhandled rejection. */
class WasmHostExitSignal extends Error {
  constructor(readonly code: number) {
    super(`tsinter.exit(${code})`);
  }
}

export interface HostRun {
  stdout: string;
  stderr: string;
  /** The process status the abi.ts contract answers with at quiescence:
   * `_status()` when the module exports one (13 = a top-level await that
   * never settled), 0 otherwise. A trap is exit 1 and never gets here —
   * runWasmToTrap is that path. */
  exitCode: number;
}

async function instantiate(modulePath: string) {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  // wallBase, sampled ONCE per run, BEFORE instantiation — mirrors the
  // differential harness's own runWasm exactly (INC-25 P6 D6-iv; INC-26
  // R0, board #135). NEVER Date.now() per call: a real-time read here
  // would let a virtual sleep observe real elapsed time (the P6 F-2
  // lesson), which this shared host must not do any more than the
  // differential harness's own host does.
  const wallBase = Date.now();
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
      now: (): number => clock,
      seed: (): bigint => randomBytes(8).readBigUInt64BE(),
      // date.now / no-arg `new Date()` modules only (abi.ts).
      wallClock: (): number => wallBase + clock,

      // EXTENSION POINT (R0, board #135): as P1..P5 land, each pass's own
      // conditionally-minted import gets its default stub added here as
      // an additional key of this SAME `tsinter: {...}` object — keyed
      // by whatever name that pass's OWN abi.ts constant mints, added
      // here only once that constant exists. This file spells none of
      // those future names by hand (abi.ts's own header reserves them to
      // itself): a LinkError naming a key not yet present here means a
      // shared-unit-test program has started reaching an import this
      // file has not caught up to yet — the exact gap R0 exists to
      // close.
      //
      // INC-26 P1's own defaults, added here: hostStr/hostNum serve a
      // fixed, minimal argv+env, the REAL cwd/platform (see the file
      // header on why cwd/platform are the one pair not synthetic here).
      hostStr(kind: number, index: number, ptr: number, cap: number): number {
        const argv = ["scriptc", "program.wasm"];
        const write = (s: string): number => {
          if (s.length > cap) return s.length;
          if (memory === null) throw new Error("hostStr before instantiation completed");
          const view = new Uint16Array(memory.buffer, ptr, s.length);
          for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
          return s.length;
        };
        switch (kind) {
          case 0: // argv
            return index >= 0 && index < argv.length ? write(argv[index]!) : -1;
          case 1: // env key
          case 2: // env value
            return -1; // the default env is empty
          case 3: // cwd
            return write(process.cwd());
          case 4: // platform
            return write(process.platform);
          // INC-26 P3: arch/versions/execPath default stubs. Synthetic
          // (unlike cwd/platform above) — no EXISTING importer of this
          // shared host reads any of these today, so a synthetic value
          // cannot break an unrelated test the way a synthetic cwd could.
          case 5: // arch
            return write("x64");
          case 6: // versions.node
            return write("24.0.0");
          case 7: // versions.openssl
            return write("3.5.5");
          case 12: // execPath
            return write("/forced/host/node");
          // INC-26 P4: os.tmpdir/os.homedir default stubs. Synthetic —
          // measured this session (impl-p4/probes/
          // sharedhost-importers-implp4.out): zero of the 21 shared-host
          // importers' own compiled programs touch either key today.
          case 8: // os.tmpdir
            return write("/forced/tmp");
          case 9: // os.homedir
            return write("/forced/home");
          default:
            throw new Error(`hostStr: unknown kind ${kind}`);
        }
      },
      // INC-26 P3: `arg` is a NEW second parameter (P1's kinds 0/1 never
      // needed it; P3's isTTY(fd)/columns(fd)/rusage(idx) all do).
      hostNum(kind: number, arg: number): number {
        switch (kind) {
          case 0: // argc
            return 2;
          case 1: // env pair count
            return 0;
          case 2: // pid
            return 1;
          case 3: // uid
            return 0;
          case 4: // gid
            return 0;
          case 5: // isTTY(fd = arg)
            return 0;
          case 6: // columns(fd = arg)
            return -1;
          case 7: // uptime, seconds
            return 1;
          case 8: // cpuUsage.user, microseconds
            return 100;
          case 9: // cpuUsage.system
            return 100;
          case 10: // threadCpuUsage.user
            return 50;
          case 11: // threadCpuUsage.system
            return 50;
          case 12: // availableMemory, bytes
            return 1e9;
          case 13: // constrainedMemory, bytes
            return 2e9;
          case 14: // rusage field `arg`, 0..15 — index 2 is maxRSS, which
            // §2.3's own text requires STRICTLY positive.
            return arg === 2 ? 4096 : arg;
          default:
            throw new Error(`hostNum: unknown kind ${kind}`);
        }
      },
      exit(code: number): void {
        throw new WasmHostExitSignal(code);
      },
      // INC-26 P3 defaults (design §2.7/§0.5): `kill` records its call and
      // answers success; `chdir`/`umask` answer success and mutate
      // nothing (this shared host's own `process.cwd()`/`process.platform`
      // reads stay real regardless — see the file header).
      kill(_pid: number, _sig: number): number {
        return 0;
      },
      chdir(_ptr: number, _len: number): number {
        return 0;
      },
      umask(_isRead: number, _mask: number): number {
        return 0o22;
      },
      // INC-26 P4 (design §6.1, brief §0(vii)/§3A, CP1 delta (c); rev-26's
      // 3B read P-1): the default `fsCall` stub is LOUD FOR EVERY OP, no
      // exception — a shared-host program that touches fs without a
      // forced host must fail LOUDLY at the exact op, never read a
      // silently-fabricated result. An EARLIER draft carved out op 19
      // (exists), answering -1 ("does not exist") on the reasoning that
      // §6.2's PROBE-SHAPED rule means it can never build an error — but
      // -1 IS A CORRECT, PLAUSIBLE ANSWER under §0(vi), which is exactly
      // what makes a silent default dangerous there (board #135's own
      // hazard, reintroduced for one op with no caller to justify it:
      // measured, ZERO of the 21 shared-host importers' programs touch
      // fs at all). Deleted; a future test that genuinely needs
      // `existsSync` supplies a FORCED host, which is what
      // wasm-host-fs-p4.test.ts exists for.
      fsCall(op: number, _aPtr: number, _aLen: number, _bPtr: number, _bLen: number, _x: number, _y: number): number {
        throw new Error(`fsCall: op ${op} reached with no forced host (default stub is loud by design)`);
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let exitCode = 0;
  const drive = (): void => {
    try {
      (instance.exports["_start"] as () => void)();
      const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
      const status = instance.exports["_status"] as (() => number) | undefined;
      if (tick !== undefined) {
        for (let turns = 0; ; turns++) {
          if (turns > 1_000_000) throw new Error(`_tick pump did not settle for ${modulePath}`);
          const due = tick(clock);
          if (due < 0) break;
          clock = Math.max(clock, due);
        }
      }
      // Quiescence: the only point `_status` means anything (abi.ts).
      exitCode = status?.() ?? 0;
    } catch (err) {
      // INC-26 P1: an explicit process.exit(n) reports its OWN code here
      // — NOT a trap (runWasmToTrap's own path is unaffected: it expects
      // a WebAssembly.RuntimeError specifically, and this never throws
      // that), and NOT re-thrown, so `runWasm` returns normally with the
      // exit code instead of failing the test that called it.
      if (!(err instanceof WasmHostExitSignal)) throw err;
      exitCode = err.code;
    }
  };
  const out = (): HostRun => ({
    stdout: Buffer.concat(chunks[1]).toString("utf8"),
    stderr: Buffer.concat(chunks[2]).toString("utf8"),
    exitCode,
  });
  return { drive, out, instance };
}

export async function runWasm(modulePath: string): Promise<HostRun> {
  const { drive, out } = await instantiate(modulePath);
  drive();
  return out();
}

/** S007/S010's bridge shape: run to an EXPECTED trap (the tier's exit-1
 * channel), returning the output that preceded it. */
export async function runWasmToTrap(modulePath: string): Promise<HostRun> {
  const { drive, out } = await instantiate(modulePath);
  const trap = await Promise.resolve()
    .then(drive)
    .then(
      () => null,
      (err: unknown) => err,
    );
  expect(trap).toBeInstanceOf(WebAssembly.RuntimeError);
  return out();
}

/** Whether the module declares the timer half of the ABI at all — the
 * conditional-surface contract (abi.ts). */
export function hasTimerSurface(modulePath: string): boolean {
  const bytes = readFileSync(modulePath);
  return bytes.includes(Buffer.from("_tick"));
}
