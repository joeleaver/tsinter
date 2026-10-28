/* The clock the wasm scaling probes (wasm-*-scaling.test.ts) time with:
 * the CPU time of the test PROCESS, in milliseconds.
 *
 * Those probes compare an operation's time at N and at k·N inside one
 * program. Against a wall clock, a loaded shared box makes them flaky in
 * the failing direction: a run the scheduler parks for 10 ms inflates the
 * big side's ratio (the 2026-10-28 full run under load measured linear ops
 * at ×10–×21 for ×4 input against a bound of 10, all ≈ ×4 alone). CPU time
 * counts only the work done — being descheduled costs nothing — so the
 * ratio is the algorithm's again, while a quadratic path still spends
 * quadratic CPU (best-of-N still absorbs the residue: cache/SMT
 * contention, a GC pause or a background tier-up landing in one run).
 *
 * Why the PROCESS's CPU time and not the thread's: on Linux the per-thread
 * figure (process.threadCpuUsage, /proc/thread-self/schedstat) advances in
 * scheduler ticks — 1 ms steps here — which is the same size as the small
 * runs being timed; process.cpuUsage() is microsecond-exact. The modules
 * run in-process (runWasm) in a vitest fork of its own, so the process's
 * other threads are V8's helpers (parallel GC, background compiles) doing
 * this module's work. NODE_CPU_CLOCK is the `node` argument prefix that
 * makes a Node run's `performance.now()` the same clock, for probes that
 * time Node on the same program. */

/** CPU time (user + system) of this process, in ms. */
export function cpuClockMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/** `node` arguments that turn the program's `performance.now()` into its
 * process CPU time in ms (cpuClockMs's clock, for Node's side). */
export const NODE_CPU_CLOCK: readonly string[] = [
  "--import",
  "data:text/javascript,performance.now=()=>{const u=process.cpuUsage();return (u.user+u.system)/1000}",
];
