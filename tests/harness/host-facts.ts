/* INC-26 pass P4, rider R-B (board #144; cp1-plan-p4.txt §5) — the
 * per-instantiation host-fact builder, EXTRACTED from
 * wasm-differential.test.ts's own inline `hostNum` kinds 8-11/14 body so
 * it is independently unit-testable with a SCRIPTED clock
 * (wasm-host-facts.test.ts).
 *
 * THE BUG THIS EXISTS TO FIX (found reading the harness, not reported):
 * kinds 8/9 (process.cpuUsage), 10/11 (process.threadCpuUsage), and
 * FOURTEEN of rusage's own sixteen fields are CUMULATIVE over the vitest
 * WORKER's entire lifetime — every program run in that worker so far, not
 * "since this module instantiated". The module IS its own process on the
 * wasm lane (the same "uptime" doctrine `uptimeBase` already applies to
 * kind 7 — abi.ts's own text), so `process.cpuUsage().user` served
 * directly answers a number that keeps growing across unrelated
 * instantiations, exactly the class of bug that made 2314's own
 * `uptime < 120` row flake under a slow census before P3 fixed uptime the
 * same way this file fixes cpu/threadCpu/rusage.
 *
 * THE FIX: sample a per-run BASELINE (`makeHostFacts`'s own `sample()`
 * call, once, at construction — mirroring `uptimeBase`'s exact shape,
 * sampled BEFORE `WebAssembly.instantiate`) and answer every CUMULATIVE
 * field as `<fresh sample> - <baseline>`. THREE EXCEPTIONS, per rev-26's
 * own A-4 classification: maxRSS (rusage index 2) is a MAXIMUM, not a
 * counter — it passes through RAW, unsubtracted (a delta of two maxima
 * would answer nonsense); the three memory-size fields (indices 3/4/5:
 * sharedMemorySize, unsharedDataSize, unsharedStackSize) are, MEASURED,
 * ALWAYS ZERO on Linux (`getrusage` never fills them) — "stays real" and
 * "stays zero" are INDISTINGUISHABLE there, so they too pass through raw
 * (subtracting zero from zero is a no-op, but the RULE is "raw", stated
 * once here rather than left implicit).
 *
 * Node's own 16-field resourceUsage order (measured, matching
 * wasm-host-process-p3.test.ts's own DEFAULT_RUSAGE comment verbatim):
 *   0 userCPUTime            1 systemCPUTime         2 maxRSS
 *   3 sharedMemorySize        4 unsharedDataSize      5 unsharedStackSize
 *   6 minorPageFault          7 majorPageFault        8 swappedOut
 *   9 fsRead                 10 fsWrite               11 ipcSent
 *  12 ipcReceived            13 signalsCount          14 voluntaryContextSwitches
 *  15 involuntaryContextSwitches
 */

export interface HostFactSnapshot {
  cpuUser: number;
  cpuSystem: number;
  threadCpuUser: number;
  threadCpuSystem: number;
  /** Node's own 16-field `process.resourceUsage()` order, as a plain
   * array (index == the field's own position above). */
  rusage: readonly number[];
}

/** rusage indices that are ALWAYS ZERO on Linux (A-4) — raw pass-through,
 * indistinguishable from "real" there. */
const RUSAGE_ALWAYS_ZERO_INDICES: ReadonlySet<number> = new Set([3, 4, 5]);
/** rusage's own maximum field — raw pass-through, never a delta. */
const RUSAGE_MAX_INDEX = 2;

export interface HostFacts {
  /** abi.ts's `hostNum` kinds 8-11 (cpuUsage.user/system,
   * threadCpuUsage.user/system) and 14 (rusage field `arg`) — every OTHER
   * kind is this builder's caller's own concern, not this file's. */
  hostNumFor(kind: number, arg: number): number;
}

/** `sample` is called ONCE here (the baseline, at construction — the
 * caller samples BEFORE `WebAssembly.instantiate`, `uptimeBase`'s own
 * ordering) and once per later `hostNumFor` call that needs a CUMULATIVE
 * field (kinds 8-11, and 14's twelve cumulative indices) — kind 14's
 * maxRSS and always-zero indices read the fresh sample directly, never
 * the baseline. */
export function makeHostFacts(sample: () => HostFactSnapshot): HostFacts {
  const base = sample();
  return {
    hostNumFor(kind: number, arg: number): number {
      switch (kind) {
        case 8:
          return sample().cpuUser - base.cpuUser;
        case 9:
          return sample().cpuSystem - base.cpuSystem;
        case 10:
          return sample().threadCpuUser - base.threadCpuUser;
        case 11:
          return sample().threadCpuSystem - base.threadCpuSystem;
        case 14: {
          const cur = sample().rusage;
          const v = cur[arg];
          if (v === undefined) throw new Error(`host-facts: rusage index out of range ${arg}`);
          if (arg === RUSAGE_MAX_INDEX || RUSAGE_ALWAYS_ZERO_INDICES.has(arg)) return v;
          const baseV = base.rusage[arg];
          if (baseV === undefined) throw new Error(`host-facts: rusage baseline index out of range ${arg}`);
          return v - baseV;
        }
        default:
          throw new Error(`host-facts: unsupported kind ${kind}`);
      }
    },
  };
}
