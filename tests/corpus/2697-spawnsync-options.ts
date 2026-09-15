// spawnSync's option slice: stdio ("ignore"/"inherit"/tuples), timeout +
// killSignal (the result carries error: ETIMEDOUT and the signal — never
// a throw, Node's spawnSync shape), result.signal for signal deaths, and
// the "utf-8" encoding alias. Timing facts are BOUNDED (a 5s sleep dies
// to a 300ms timeout), so the output is deterministic.
import { spawnSync } from "node:child_process";

// The probe shape (checkCommandAvailable): stdio ignore + timeout.
const probe = spawnSync("true", [], { stdio: "ignore", timeout: 3000, windowsHide: true });
console.log(`probe: ${probe.status} ${probe.signal}`, probe.error === undefined);

// A missing binary: error.code ENOENT, status null — data, not a throw.
const missing = spawnSync("definitely-not-a-binary-xyz", [], { stdio: "ignore", timeout: 1000 });
console.log(
  `missing: ${missing.status} ${(missing.error as NodeJS.ErrnoException | undefined)?.code} ${missing.signal}`,
);

// Timeout: killSignal lands, error is ETIMEDOUT, signal reports the kill.
const slow = spawnSync("sleep", ["5"], { timeout: 300, killSignal: "SIGKILL", encoding: "utf-8" });
console.log(
  `timeout: ${slow.status} ${slow.signal} ${(slow.error as NodeJS.ErrnoException | undefined)?.code}`,
);
const slowDefault = spawnSync("sleep", ["5"], { timeout: 300 });
console.log(`timeout default: ${slowDefault.signal}`);

// A self-inflicted signal death without any timeout in play.
const selfkill = spawnSync("sh", ["-c", "kill -TERM $$"], { encoding: "utf8", timeout: 5000 });
console.log(`selfkill: ${selfkill.status} ${selfkill.signal}`, selfkill.error === undefined);

// Captures still flow through the options path, exit codes intact.
const out = spawnSync("sh", ["-c", "echo up; echo down 1>&2; exit 4"], {
  encoding: "utf-8",
  timeout: 10_000,
  stdio: ["ignore", "pipe", "pipe"],
});
console.log(`capture: ${JSON.stringify(out.stdout)} ${JSON.stringify(out.stderr)} ${out.status} ${out.signal}`);

// An "ignore" slot reads "" here (Node types it null — the documented
// spawnSync stance; status is the honest signal).
const quiet = spawnSync("sh", ["-c", "echo noisy; exit 0"], {
  encoding: "utf8",
  stdio: ["ignore", "ignore", "pipe"],
  timeout: 10_000,
});
console.log(`quiet: ${quiet.status}`);
