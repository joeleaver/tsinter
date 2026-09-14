// Generates packages/runtime/test/process-tail-cases.txt from Node itself
// (P5 R-A/R-B/R-C, board #143's own NATIVE VERIFICATION deliverable,
// path.test.ts's own gen-*-cases.mjs shape): every EXPECTED column here is
// Node's own measured answer, never hand-typed.
//
// process.kill's own gate (R-B) is tested against a FIXED, chosen pid,
// 2147483600 — inside int32 range but far past any pid a real process ever
// reaches, so kill(2)'s OWN existence check reliably answers ESRCH for
// every VALID signal value (0/-0/NaN-as-SIGTERM/an in-range integer): the
// observable split this file pins is "did validation reject the signal
// BEFORE ever reaching kill(2)" (a TypeError) vs "did it accept and forward
// the signal" (an ESRCH Error) — P3's own NOPID probes could see only the
// PID half of this; this rider's own probe (rev/probes/p5/
// p5-kill-sig0-nan.out f6b5a212) is what first measured the SIGNAL half
// against a live child, and this generator's job is only to freeze that
// same measurement as committed cases.
//
// process.chdir's two-path error (R-A) needs a KNOWN "before" cwd, so the
// driver chdir()s to "/" first, exactly mirroring path.test.ts's own
// "generated under the same cwd" rule for its cwd-consulting functions.
//
// process.umask's validation (R-C) runs stateless (every INVALID mask is
// rejected before the syscall, so order never matters and no case
// disturbs process state); the small VALID-mask sequence at the end is
// PRIMED first (umask(0), its own prev discarded) so the chain is
// deterministic regardless of the shell's own starting umask — matching
// this same file's own C driver, which must run the SAME priming call
// before asserting anything.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lines = [];

function tryKill(pid, sig) {
  try {
    process.kill(pid, sig);
    return { threw: false };
  } catch (e) {
    return { threw: true, name: e.name, code: e.code, message: e.message };
  }
}

// R-B: the numeric signal gate, pid=2147483600 (see header comment).
const KILL_PID = 2147483600;
const killSignals = [
  0, -0, NaN, 15, 6, 2147483647, -2147483648, // VALID -> ESRCH
  2147483648, -2147483649, 1.5, -1.5, // INVALID -> ERR_UNKNOWN_SIGNAL
];
for (const sig of killSignals) {
  const r = tryKill(KILL_PID, sig);
  if (!r.threw) throw new Error(`gen-process-tail-cases: kill(${KILL_PID}, ${sig}) did not throw (ESRCH expected)`);
  lines.push(["kill", KILL_PID, Object.is(sig, -0) ? "-0" : String(sig), r.name, r.code, r.message].join("\t"));
}

// R-A: chdir's two-path error, generated from a KNOWN cwd.
process.chdir("/");
const CHDIR_TARGET = "/nonexistent-dir-p143-probe";
try {
  process.chdir(CHDIR_TARGET);
  throw new Error("gen-process-tail-cases: chdir into a nonexistent dir did not throw");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  lines.push(["chdir", CHDIR_TARGET, e.name, e.code, e.message].join("\t"));
}

// R-C: umask validation — INVALID masks first (stateless, order-free).
function tryUmask(mask) {
  try {
    const prev = process.umask(mask);
    return { threw: false, prev };
  } catch (e) {
    return { threw: true, name: e.name, code: e.code, message: e.message };
  }
}
const invalidMasks = [1.5, -1, 4294967296, NaN, -1.5, 4294967296.5];
for (const mask of invalidMasks) {
  const r = tryUmask(mask);
  if (!r.threw) throw new Error(`gen-process-tail-cases: umask(${mask}) did not throw`);
  lines.push(["umask-invalid", Number.isNaN(mask) ? "NaN" : String(mask), r.name, r.code, r.message].join("\t"));
}

// R-C: the VALID-mask sequence, PRIMED first (discarded), then chained.
process.umask(0); // prime — NOT asserted, matching the C driver's own priming call
const validMasks = [0o22, 0, 0o777, 0xffffffff];
for (const mask of validMasks) {
  const prev = process.umask(mask);
  lines.push(["umask-valid", mask, prev].join("\t"));
}

// The READ form (never throws) — one more read after the chain above.
lines.push(["umaskread", process.umask()].join("\t"));

// Restore a sane umask before writing — the LAST valid-mask case above
// (0xffffffff, masked to 0o777) would otherwise leave THIS process's own
// umask at "no permission bits survive," and the file this script itself
// is about to create would inherit that mask (board #142's own mode-0
// collision, self-inflicted here first — caught by writeFileSync itself
// throwing EACCES on immediate re-read during authoring).
process.umask(0o22);

const out = lines.join("\n") + "\n";
writeFileSync(join(here, "process-tail-cases.txt"), out);
console.log(`gen-process-tail-cases: wrote ${lines.length} cases (node ${process.version})`);
