// M-6's own two-program createdPaths leak pin (wasm-differential.test.ts, landed per
// POST-ACK #25 §4, moved here per delta-3gd — tests/corpus/ is a FORBID-PREFIX
// regardless of subdirectory, so this harness-owned fixture lives under
// tests/harness/fixtures-p5/ instead). NOT part of the bulk corpus census. Creates a
// file at a FIXED, deterministic path and never removes it itself — the harness's own
// createdPaths cleanup is the only thing that should ever delete it.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = join(tmpdir(), "m6-leak-check-shared.txt");
writeFileSync(target, "leak-check");
console.log("a-wrote");
