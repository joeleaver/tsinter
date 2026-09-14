// M-4's own two-program fd-table leak pin — the B half. See a.ts for the full mechanism.
// Opens a DIFFERENT file itself and prints the real OS fd number Node handed back — if
// A's own fd leaked (never closed by the harness), the lowest-available-fd allocator
// gives B a HIGHER number than it would have gotten with A's fd properly recycled.
import { openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = join(tmpdir(), "m4-fdleak-check-shared-b.txt");
writeFileSync(target, "fd-leak-check-b");
const fd = openSync(target, "r");
console.log("b-fd", fd);
