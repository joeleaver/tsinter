// K5/K6/K7 fixture: a deliberately trapping export (array index OOB — the
// runtime's own range trap), a throwing export (the escaped-exception
// channel: "Uncaught ..." rendered into the sink), and a benign export the
// poisoned-library probe calls after a trap (which must abort, never run).
export function boom(i: number): number {
  const xs = [1, 2, 3];
  return xs[i]!;
}

export function fail(msg: string): number {
  throw new Error(msg);
}

export function ok(x: number): number {
  return x + 1;
}

// #147 T-6 — a SECOND trap shape (this file's own PERMIT line): stores its
// argument into a module global (a survivor the trap-path sweep must NOT
// hard-free a second time), then traps on an unrelated OOB access in the
// SAME entry. By the time the trap fires, `msg`'s own local reference has
// already been consumed by the `stashed = msg` assignment — one
// outstanding reference (the global's) at trap time, not two: the
// assignment to a global does NOT retain in this codegen (MEASURED,
// delta-11/N-6, not merely assumed — a mutation check that replaced the
// sweep's repeated-release loop with a single unconditional release()
// per slot left T-6 GREEN on both emissions, both lanes; had the
// assignment retained, rc would have been 2 at the trap and a
// single release would under-release, which ASan's K10 lane would have
// caught as a leak). Because rc is 1 here, T-6 does NOT exercise the
// repeated-release loop's multi-call branch — design-147-v3.txt's own
// text already states this as a residual T-6 alone does not close, and
// this measurement CONFIRMS the residual stays open, it does not close
// it: a fixture forcing rc > 1 at sweep time (two live references to the
// same object, neither released before the trap) is a separate row for
// a later pass, not this one.
let stashed: string = "";
export function stashThenTrap(msg: string, i: number): number {
  stashed = msg;
  const xs = [1, 2, 3];
  return xs[i]!;
}

console.log("traps ready");
