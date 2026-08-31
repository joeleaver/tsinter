/* increment 23 P3, rider 1 — `expr:fieldIncDec:dyn` (SEMANTICS.md S009's
 * third amendment): `++`/`--` over a CHECKED-DYNAMIC class field (an
 * implicit-any JS constructor assignment). Compile REAL JS through the
 * actual frontend+backend, run it through the real abi.ts host
 * (wasm-host.ts), assert against a live-Node-measured shape.
 *
 * The symbol-keyed spelling (`--this[kSym]`, countdown.js's own shape) is
 * NOT independently unit-pinned here: `Symbol()` itself
 * (`libCall:sym.new`) is not built on this tier yet, so a program using a
 * real symbol-keyed field cannot fully RUN (only compile past the
 * increment/decrement itself before hitting the next refusal). The
 * wasm-differential corpus census is the instrument for that shape —
 * 1710/1730 are BOTH property-and-symbol-keyed instances of this exact
 * IR node (fieldIncDec's `className`/`field` are literal strings either
 * way; `fieldDyn` distinguishes only the storage representation, never
 * the access spelling) — confirmed empirically: 1730 (whose ONLY
 * remaining blocker after this rider is `libCall:sym.new`, unrelated to
 * this construct) moved from refusing on `expr:fieldIncDec:dyn` to
 * `libCall:sym.new` the moment this file's own emitter change landed,
 * which is only possible if the identical codegen this file pins for the
 * property form ALSO fired correctly for `dec()`'s own symbol-keyed
 * `--this[kLimit]`. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-fieldincdec-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, lines: string[]) {
  const entry = join(scratch, name);
  await writeFile(entry, `${lines.join("\n")}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

test("fieldIncDec:dyn — prefix/postfix ++/-- battery over a checked-dynamic field, byte-exact vs Node (node v24.18.1, own measurement)", async () => {
  const path = await build("battery.js", [
    "'use strict';",
    "class C {",
    "  constructor(n) { this.n = n; }",
    "  incPost() { return this.n++; }",
    "  incPre() { return ++this.n; }",
    "  decPost() { return this.n--; }",
    "  decPre() { return --this.n; }",
    "}",
    "const c = new C(5);",
    "console.log('incPost', c.incPost(), c.n);",
    "console.log('incPre', c.incPre(), c.n);",
    "console.log('decPost', c.decPost(), c.n);",
    "console.log('decPre', c.decPre(), c.n);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  // Measured directly (node v24.18.1) against the identical source: an
  // implicit-any constructor field takes the same `n++`/`++n`/`n--`/`--n`
  // arithmetic real Node performs, since `n` genuinely holds a number
  // throughout this battery (the TypeError arm below is the divergent
  // case, not this one).
  expect(stdout).toBe(
    ["incPost 5 6", "incPre 7 7", "decPost 7 6", "decPre 5 5", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("fieldIncDec:dyn — the non-number arm: a catchable TypeError, instanceof-true, message byte-identical to S009's own established format (NOT Node's silent NaN — SEMANTICS.md S009's third amendment)", async () => {
  const path = await build("nonnumber.js", [
    "'use strict';",
    "class C {",
    "  constructor(n) { this.n = n; }",
    "  inc() { return this.n++; }",
    "}",
    "const c = new C('abc');",
    "try {",
    "  c.inc();",
    "  console.log('no-throw');",
    "} catch (e) {",
    "  console.log('caught', typeof e, e instanceof TypeError, e.message);",
    "}",
  ]);
  const { stdout, stderr } = await runWasm(path);
  // "expected number at $, got string" is S009's OWN established message
  // format (increment 17/21's amendments already produce it byte-for-
  // byte via the SAME dynCheckHelper/checkFail machinery) — NOT a Node
  // string (real Node: c.inc() returns NaN silently, never throws).
  expect(stdout).toBe(["caught object true expected number at $, got string", ""].join("\n"));
  expect(stderr).toBe("");
});

test("fieldIncDec:dyn — prefix on the non-number arm reaches the SAME dynCheck before any arithmetic runs (mechanism-reachability: prefix and postfix share one check site)", async () => {
  const path = await build("nonnumber-prefix.js", [
    "'use strict';",
    "class C {",
    "  constructor(n) { this.n = n; }",
    "  incPre() { return ++this.n; }",
    "}",
    "const c = new C(null);",
    "try {",
    "  c.incPre();",
    "  console.log('no-throw');",
    "} catch (e) {",
    "  console.log('caught', e instanceof TypeError, e.message);",
    "}",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["caught true expected number at $, got null", ""].join("\n"));
  expect(stderr).toBe("");
});
