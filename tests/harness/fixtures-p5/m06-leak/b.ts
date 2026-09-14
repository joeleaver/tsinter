// M-6's own two-program createdPaths leak pin — the B half. See a.ts for the full
// mechanism. Checks whether the SHARED path a.ts wrote still exists — it must NOT, if
// the harness's own per-run createdPaths cleanup ran correctly after A's own run.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = join(tmpdir(), "m6-leak-check-shared.txt");
console.log("b-sees", existsSync(target));
