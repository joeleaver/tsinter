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
 * FORCED host (wasm-host-fs-p4.test.ts's own job).
 *
 * INC-28 U1: `cpCall` lands LOUD BY DESIGN for the same reason — a child's
 * result is never fabricated here; wasm-host-cp-u1.test.ts forces one.
 *
 * INC-28 U2: `evPoll` lands LOUD too, and an EVENT MODULE (one exporting
 * `_loop` instead of `_tick`, abi.ts) is driven by the loop contract on
 * the same virtual clock: a negative answer stops, +Infinity asks the
 * optional `onIdle` hook for the time of the next scripted event (none:
 * "module waits for an event no source can deliver"), anything else is a
 * time to jump to. A test scripts the host through `runWasm`'s and
 * `runWasmToTrap`'s ONE optional parameter: import overrides merged over
 * these defaults, plus `onIdle`, `onJump` and `onInstance`
 * (wasm-host-cp-u2.test.ts);
 * a caller that passes nothing gets exactly the host it always had.
 *
 * #227: a FETCH MODULE (one importing `tsinter.fetch`, abi.ts) gets the
 * REAL fetch host (wasm-fetch-host.ts, Node's own fetch) unless a test
 * overrides `fetch`: its evPoll serves that host's queue, its clock is
 * real time, and its `_loop` is driven asynchronously so Node's own event
 * loop runs the requests between turns.
 *
 * S113: `tzCall` is the REAL zone host (wasm-tz-host.ts) — Node's own Date
 * in this process answers the module's local-time questions, so a test's
 * local time is Node's under whatever TZ the test runs with. */
import { randomBytes, randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { makeFetchHost, writeFetchEvent, type FetchHostEvent } from "./wasm-fetch-host.js";
import { makeTzHost } from "./wasm-tz-host.js";

/** `tsinter.exit`'s sentinel (abi.ts §2.5) — thrown by the host, caught
 * inside `drive()` before it can propagate as an unhandled rejection. */
class WasmHostExitSignal extends Error {
  constructor(readonly code: number) {
    super(`tsinter.exit(${code})`);
  }
}

/** A test's scripting of this host (INC-28 U2): import overrides merged
 * over the defaults below, and the event drive's two hooks. */
export interface HostOverrides {
  imports?: Record<string, unknown>;
  /** The event drive got +Infinity: the virtual time of the next scripted
   * event, or undefined when there is none. */
  onIdle?: (clock: number) => number | undefined;
  /** The event drive jumped the virtual clock to `to`. */
  onJump?: (to: number) => void;
  /** Called once, right after instantiation (a scripted import that
   * reads or writes the module's memory takes it from here). */
  onInstance?: (instance: WebAssembly.Instance) => void;
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

async function instantiate(modulePath: string, overrides?: HostOverrides) {
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
  const wasmModule = await WebAssembly.compile(readFileSync(modulePath));
  // #227: the real fetch host, for a fetch module no test scripts.
  const fetchMode =
    WebAssembly.Module.imports(wasmModule).some((i) => i.module === "tsinter" && i.name === "fetch") &&
    overrides?.imports?.["fetch"] === undefined;
  const t0 = performance.now();
  const fetchQueue: FetchHostEvent[] = [];
  let fetchWaker: (() => void) | null = null;
  let fetchLive = 0;
  const fetchHost = fetchMode
    ? makeFetchHost({
        memory: () => {
          if (memory === null) throw new Error("fetch before instantiation completed");
          return memory;
        },
        push: (ev) => {
          fetchQueue.push(ev);
          fetchWaker?.();
        },
        purge: (pred) => {
          for (let i = fetchQueue.length - 1; i >= 0; i--) if (pred(fetchQueue[i]!)) fetchQueue.splice(i, 1);
        },
        live: (d) => {
          fetchLive += d;
        },
      })
    : null;
  const fetchNow = (): number => performance.now() - t0;
  const tzHost = makeTzHost(() => {
    if (memory === null) throw new Error("tzCall before instantiation completed");
    return memory;
  });
  const fetchImports = fetchHost
    ? {
        now: fetchNow,
        evPoll(ptr: number, cap: number): number {
          const ev = fetchQueue[0];
          if (ev === undefined) return 0;
          const n = writeFetchEvent(memory!, ptr, cap, ev);
          if (n > 0) fetchQueue.shift();
          return n;
        },
        fetch: fetchHost.fetchCall,
      }
    : {};
  const instance = await WebAssembly.instantiate(wasmModule, {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
      now: (): number => clock,
      seed: (): bigint => randomBytes(8).readBigUInt64BE(),
      // node:crypto randomness modules only (abi.ts `random`).
      random(ptr: number, len: number): void {
        if (memory === null) throw new Error("random before instantiation completed");
        randomFillSync(new Uint8Array(memory.buffer, ptr, len));
      },
      // Atomics.wait modules only (unit H, abi.ts `sleep`): a REAL blocking
      // sleep (Atomics.wait on a private SharedArrayBuffer — never a spin on
      // a clock), and the virtual clock moves by max(ms, the time really
      // slept): cpCall RUN's accounting. A non-finite ms (Node blocks forever)
      // ends the run loudly instead of hanging the worker.
      sleep(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`tsinter.sleep(${ms}): an unbounded wait (Node blocks forever)`);
        const t0 = performance.now();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        clock += Math.max(ms, performance.now() - t0);
      },
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
          // INC-26 P5 (brief-p5-v3.md §3A, abi.ts kinds 10/11/13/14/15/16):
          // six more os.* default stubs, same synthetic-is-safe reasoning
          // as P4's tmpdir/homedir pair above — measured this session
          // (grep over all 21 shared-host importers' own test files):
          // ZERO touch os.type/os.release/os.userInfo (name/homedir/
          // shell)/os.networkInterfaces in their compiled fixtures today.
          case 10: // os.type
            return write("ForcedOS");
          case 11: // os.release
            return write("0.0.0-forced");
          case 13: // os.userInfo().username
            return write("forced-user");
          case 14: // os.userInfo().homedir
            return write("/forced/userhome");
          case 15: // os.userInfo().shell
            return write("/forced/shell");
          case 16: // os.networkInterfaces() — a JSON document; the empty
            // object is the simplest valid "no interfaces" answer, never
            // exercised by a real corpus program through THIS shared host.
            return write("{}");
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
          // INC-26 P5 (brief-p5-v3.md §3A, abi.ts hostNum kind 15): the
          // sole new hostNum-only os.* default, same synthetic-is-safe
          // measurement as the hostStr additions above.
          case 15: // os.totalmem, bytes
            return 1e9;
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
      // INC-28 U1 (abi.ts cpCall): LOUD for every op, fsCall's stance — a
      // shared-host program that starts a child without a forced host
      // fails at the exact op, never reads a fabricated child result.
      // wasm-host-cp-u1.test.ts carries its own forced host.
      cpCall(op: number, _ptr: number, _len: number, _h: number, _which: number): number {
        throw new Error(`cpCall: op ${op} reached with no forced host (default stub is loud by design)`);
      },
      // INC-28 U2 (abi.ts evPoll): LOUD, cpCall's stance — an event module
      // that polls with no forced host fails at the call, never reads a
      // fabricated event. wasm-host-cp-u2.test.ts scripts one.
      evPoll(_ptr: number, _cap: number): number {
        throw new Error("evPoll: reached with no forced host (default stub is loud by design)");
      },
      // INC-29 U1 (abi.ts netCall): LOUD for every op, cpCall's stance — a
      // net module run without a forced host fails at its first OS-level
      // request, never reads a fabricated socket. wasm-host-net-u1.test.ts
      // scripts one.
      netCall(op: number, _ptr: number, _len: number, _h: number, _x: number): number {
        throw new Error(`netCall: op ${op} reached with no forced host (default stub is loud by design)`);
      },
      // INC-29 U4 (abi.ts tlsCall): LOUD for every op, netCall's stance.
      tlsCall(op: number, _ptr: number, _len: number, _h: number, _x: number): number {
        throw new Error(`tlsCall: op ${op} reached with no forced host (default stub is loud by design)`);
      },
      // Unit G1 (abi.ts sigCall): LOUD for every op, netCall's stance.
      sigCall(op: number, _x: number): number {
        throw new Error(`sigCall: op ${op} reached with no forced host (default stub is loud by design)`);
      },
      // Unit G3 (abi.ts watchCall): LOUD for every op, netCall's stance.
      watchCall(op: number, _ptr: number, _len: number, _h: number): number {
        throw new Error(`watchCall: op ${op} reached with no forced host (default stub is loud by design)`);
      },
      // Unit G2 (abi.ts stdinCall): LOUD for every op, netCall's stance.
      stdinCall(op: number): number {
        throw new Error(`stdinCall: op ${op} reached with no forced host (default stub is loud by design)`);
      },
      tzCall: tzHost.tzCall,
      ...fetchImports,
      ...(overrides?.imports ?? {}),
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  overrides?.onInstance?.(instance);
  let exitCode = 0;
  // #227: a fetch module's drive — real time, and Node's own loop turns
  // between module turns so the requests make progress.
  const driveFetch = async (): Promise<void> => {
    try {
      (instance.exports["_start"] as () => void)();
      const loop = instance.exports["_loop"] as (now: number) => number;
      const status = instance.exports["_status"] as (() => number) | undefined;
      let due = loop(fetchNow());
      while (due >= 0) {
        const wait = due === Infinity ? Infinity : Math.max(0, due - fetchNow());
        if (fetchQueue.length === 0 && wait > 0) {
          if (wait === Infinity && fetchLive === 0) throw new Error("module waits for an event no source can deliver");
          await new Promise<void>((resolve) => {
            const timer = Number.isFinite(wait) ? setTimeout(resolve, Math.ceil(wait)) : undefined;
            fetchWaker = () => {
              if (timer !== undefined) clearTimeout(timer);
              resolve();
            };
          });
          fetchWaker = null;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        due = loop(fetchNow());
      }
      exitCode = status?.() ?? 0;
    } catch (err) {
      if (!(err instanceof WasmHostExitSignal)) throw err;
      exitCode = err.code;
    } finally {
      fetchHost!.finish();
    }
  };
  const drive = (): void | Promise<void> => {
    if (fetchHost !== null) return driveFetch().finally(() => tzHost.finish());
    try {
      (instance.exports["_start"] as () => void)();
      const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
      const loop = instance.exports["_loop"] as ((now: number) => number) | undefined;
      const status = instance.exports["_status"] as (() => number) | undefined;
      if (tick !== undefined) {
        for (let turns = 0; ; turns++) {
          if (turns > 1_000_000) throw new Error(`_tick pump did not settle for ${modulePath}`);
          const due = tick(clock);
          if (due < 0) break;
          clock = Math.max(clock, due);
        }
      }
      // INC-28 U2: an event module's drive (abi.ts's loop contract), on the
      // virtual clock; the `now` it passes is whatever the (possibly
      // overridden) `now` import answers.
      if (loop !== undefined) {
        const nowFn = (overrides?.imports?.["now"] as (() => number) | undefined) ?? ((): number => clock);
        let due = loop(nowFn());
        for (let turns = 0; ; turns++) {
          if (turns > 1_000_000) throw new Error(`_loop drive did not settle for ${modulePath}`);
          if (due < 0) break;
          let to = due;
          if (due === Infinity) {
            const next = overrides?.onIdle?.(clock);
            if (next === undefined) throw new Error("module waits for an event no source can deliver");
            to = next;
          }
          clock = Math.max(clock, to);
          overrides?.onJump?.(clock);
          due = loop(nowFn());
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
    } finally {
      tzHost.finish();
    }
  };
  const out = (): HostRun => ({
    stdout: Buffer.concat(chunks[1]).toString("utf8"),
    stderr: Buffer.concat(chunks[2]).toString("utf8"),
    exitCode,
  });
  return { drive, out, instance };
}

export async function runWasm(modulePath: string, overrides?: HostOverrides): Promise<HostRun> {
  const { drive, out } = await instantiate(modulePath, overrides);
  await drive();
  return out();
}

/** S007/S010's bridge shape: run to an EXPECTED trap (the tier's exit-1
 * channel), returning the output that preceded it. */
export async function runWasmToTrap(modulePath: string, overrides?: HostOverrides): Promise<HostRun> {
  const { drive, out } = await instantiate(modulePath, overrides);
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
