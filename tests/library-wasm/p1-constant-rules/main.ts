// Constant exports (no module evaluation) are a literal or a module const
// with a literal initializer, nothing type-based: `n as 5` and a call to a
// literal-returning function are ordinary exports. -0 stays -0.
import * as pw from "pw";
pw.note_f64(1);
function boot(): 7 { pw.note_f64(42); return 7; }
let n = 3;
export function sidefx(): number { return boot(); }
export function negz(): number { return -0; }
export function asserted(): number { return n as 5; }
export function bump(): void { n++; throw new Error("boom"); }
export function ver(): number { return 47; }
