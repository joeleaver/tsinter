/* INC-25 rider R0 — `libCall:global.undefRead`: a read of an ambient
 * `declare`d binding (const/let/var/function/namespace/enum member, no
 * initializer, the Ambient modifier) that Node's runtime never sees,
 * because Node erases the declaration entirely (design-number-v4.txt
 * f7327c29, §7.2/§6.5). The access throws Node's own catchable
 * ReferenceError "<name> is not defined". The wasm backend's TDZ site
 * (emitter.ts:9121) already carries the mechanism — emitSetCellErrorLit
 * + emitUnwind — this rider is that same shape at a different message,
 * reached through four pre-existing frontend sites (lower-exprs.ts,
 * lower-namespaces.ts, lower-enums.ts) that already lower to
 * `libCall:global.undefRead` (ir/nodes.ts:3199-3204's "typed dummy the
 * unwind abandons — the value never exists").
 *
 * Compile REAL JS/TS through the actual frontend+backend and run it
 * through the real abi.ts host (wasm-host.ts) — the wasm-fieldincdec.
 * test.ts discipline. All eight axes of §6.5 (six original plus the two
 * rev-25 found: a default-parameter initializer, and a class-field
 * initializer), each with a witness that discriminates a plausible wrong
 * lowering. Every expected value below was MEASURED directly against
 * real Node (node v24.18.1, `--experimental-strip-types`), not derived —
 * the corpus differential (tests/harness/wasm-differential.test.ts) is
 * the byte-exact instrument for the 15 claimed programs; these are
 * independent unit witnesses, including two shapes (axes 7/8) no corpus
 * program exercises at all.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-undefread-"));
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

test("axes 1+2 — instanceof Error, and .name/.message byte-exact (1581's own shape; node v24.18.1: `true ReferenceError missingVersion is not defined`)", async () => {
  const path = await build("axes12.ts", [
    "declare const missingVersion: string;",
    "try {",
    "  console.log(`v${missingVersion}`);",
    "} catch (e) {",
    "  console.log(e instanceof Error, (e as Error).name, (e as Error).message);",
    "}",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["true ReferenceError missingVersion is not defined", ""].join("\n"));
  expect(stderr).toBe("");
});

test("axis 3 — the name is the ROOT BINDING, not the member path (1965's own shape: `Missing.x`, `Missing.f()`, `Missing.Deep.y` all say \"Missing is not defined\", never \"Missing.x is not defined\" or \"x is not defined\")", async () => {
  const path = await build("axis3.ts", [
    "declare namespace Missing {",
    "  const x: number;",
    "  function f(): string;",
    "  namespace Deep {",
    "    const y: string;",
    "  }",
    "}",
    "try { console.log(Missing.x); } catch (e) { console.log((e as Error).message); }",
    "try { console.log(Missing.f()); } catch (e) { console.log((e as Error).message); }",
    "try { console.log(Missing.Deep.y); } catch (e) { console.log((e as Error).message); }",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["Missing is not defined", "Missing is not defined", "Missing is not defined", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("axis 4 — the callee throws BEFORE its call's arguments evaluate (1854's own shape: `mystery(arg())` prints \"args ran: false\", never \"true\")", async () => {
  const path = await build("axis4.ts", [
    "declare function mystery(x: number): string;",
    "let evaluated = false;",
    "function arg(): number {",
    "  evaluated = true;",
    "  return 1;",
    "}",
    "try {",
    "  mystery(arg());",
    "} catch (e) {",
    "  if (e instanceof Error) console.log('args ran:', evaluated, '-', e.name, e.message);",
    "}",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["args ran: false - ReferenceError mystery is not defined", ""].join("\n"));
  expect(stderr).toBe("");
});

test("axis 5 — `?.` does not guard the root read (2591's own shape: an optional chain off an ambient root still throws)", async () => {
  const path = await build("axis5.ts", [
    "interface Y { foo(): void; }",
    "declare const value: Y | undefined;",
    "try {",
    "  value?.foo();",
    "  console.log('no throw (WRONG)');",
    "} catch (e) {",
    "  if (e instanceof Error) console.log(e.name, e.message);",
    "}",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["ReferenceError value is not defined", ""].join("\n"));
  expect(stderr).toBe("");
});

test("axis 6 — 2614's own shape: the DECLARATION compiles at all — a TRAP BINDING (t1, whose initializer is the ambient read, not the ambient name itself) keeps ordinary storage, so its later write statements lower rather than fencing; module init unwinds at the initializer's read and the writes never run (@exit: 1, stdout truncates at \"before\")", async () => {
  // NOT the same shape as rev-25's separate design-gate probe (a bare
  // ambient `declare let` ASSIGNED TO DIRECTLY, which refuses at SC1090
  // — there is no storage for the ambient name itself to write into).
  // Here the write targets are `t1`, an ordinary `let` local whose own
  // storage is completely normal; its only special property is that its
  // initializer (`numLiteral`, the ambient read) always throws, so
  // nothing after it ever runs. Both are correct for their own shape.
  const path = await build("axis6.ts", [
    "declare const numLiteral: 0;",
    "console.log('before');",
    "let t1 = numLiteral;",
    "t1 = t1 + 42;",
    "t1 += 1;",
    "console.log('after', t1);",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["before", ""].join("\n"));
  expect(stderr).toBe("Uncaught ReferenceError: numLiteral is not defined\n");
});

test("axis 7 — a DEFAULT PARAMETER whose initializer is an ambient read: called WITH an argument must not throw and the side effect must not run; called WITHOUT must throw (rev-25's v3-D finding — no corpus program covers this; node v24.18.1 measured directly)", async () => {
  const path = await build("axis7.ts", [
    "declare const missingConst: number;",
    "let defaultRan = false;",
    "function pickDefault(): number {",
    "  defaultRan = true;",
    "  return missingConst;",
    "}",
    "function withDefault(x: number = pickDefault()): number {",
    "  return x;",
    "}",
    "console.log('with-arg:', withDefault(5), 'ran:', defaultRan);",
    "try {",
    "  withDefault();",
    "  console.log('no-arg: no throw (WRONG)');",
    "} catch (e) {",
    "  if (e instanceof Error) console.log('no-arg threw:', e.name + ':', e.message, 'ran:', defaultRan);",
    "}",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "with-arg: 5 ran: false",
      "no-arg threw: ReferenceError: missingConst is not defined ran: true",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("axis 8 — a CLASS FIELD INITIALIZER that is an ambient read throws at construction, with sibling-field ordering preserved (fields before it run, fields after it never do) — rev-25's v3-D finding, no corpus program covers this; node v24.18.1 measured directly", async () => {
  const path = await build("axis8.ts", [
    "declare const missingField: number;",
    "const order: string[] = [];",
    "class C {",
    "  a = (order.push('a'), 1);",
    "  b = (order.push('b'), missingField);",
    "  c = (order.push('c'), 3);",
    "}",
    "try {",
    "  new C();",
    "  console.log('no throw (WRONG)');",
    "} catch (e) {",
    "  if (e instanceof Error) console.log(e.name + ':', e.message, 'order:', order.join(','));",
    "}",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["ReferenceError: missingField is not defined order: a,b", ""].join("\n"));
  expect(stderr).toBe("");
});
