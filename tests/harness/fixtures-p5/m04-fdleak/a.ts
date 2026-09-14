// M-4's own two-program fd-table leak pin (wasm-differential.test.ts, landed per
// POST-ACK #25 §4, moved here per delta-3gd — tests/corpus/ is a FORBID-PREFIX
// regardless of subdirectory, so this harness-owned fixture lives under
// tests/harness/fixtures-p5/ instead). NOT part of the bulk corpus census — reachable
// only through the dedicated hand-sequenced test that imports it directly. Opens a file
// and never closes it itself — the harness's own openFds cleanup is the only thing that
// should ever close it. Prints the real OS fd number Node handed back.
import { openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = join(tmpdir(), "m4-fdleak-check-shared.txt");
writeFileSync(target, "fd-leak-check");
const fd = openSync(target, "r");
console.log("a-fd", fd);
