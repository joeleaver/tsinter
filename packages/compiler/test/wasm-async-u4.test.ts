/* INC-27 unit U4 — the async shapes. Rows for the resumable-function
 * lowering (statemachine.ts) and the dyn promise path (emitter.ts).
 *
 * The statemachine half lifts three refusals that served async functions
 * AND generators alike:
 *   - a `return` that must run a finally first (the verbatim-kept finally,
 *     and board #173's linearized finally that a return inside a non-
 *     suspending container used to skip) — the statement is exploded and
 *     the return parks through completeOrPark;
 *   - a void await/yield in an operand position — it runs as its own
 *     statement and its slot takes the undefined unit or is dropped;
 *   - a captured local declared inside a loop of an ASYNC body — a fresh
 *     box per iteration, and a captured `for` head variable copied per
 *     iteration. A loop box in a GENERATOR body still refuses (board
 *     #179): a yield builds no new resume closure, so nothing would carry
 *     the iteration's box across it; the GEN rows pin those refusals, each
 *     beside an async twin that compiles.
 * Board #174 rides along: a mapper-less `Array.from<T | undefined>({
 * length })` fills its union slots with undefined instead of null.
 *
 * The dyn promise half: a statically typed promise boxed into dyn is the
 * promise itself (identity across crossings), its settled value converted
 * to dyn once, when a dyn reader first asks; `then`/`catch`/`finally` on a
 * dyn promise receiver run as microtask reactions with Node's adoption of
 * a returned promise; a non-promise receiver takes the ordinary method
 * dispatch; the island readers of an `any`-held promise read a typed
 * promise through the same conversion; and where a typed promise is boxed,
 * fulfilling a promise WITH an `any`-held promise is a named run-time
 * refusal (board #176's wrong answer). Board #183 rides along: a
 * `process.once` listener for 'unhandledRejection' or 'rejectionHandled'
 * removes itself before its call.
 *
 * Every expected line below is an INLINED literal: a run row's stdout is
 * a real Node v24 run (`node --experimental-transform-types` for .ts, plain
 * `node` otherwise) of the SAME source, byte for byte; a refusal row's
 * diagnostics are this tier's own named refusal. Nothing outside this
 * repository is read at test time; corpus rows read tests/corpus through a
 * relative path. Row classes, in file order: FINALLY, FINALLY-LINEAR, GEN,
 * HOISTVOID, LOOPBOX, HOLES, EVERYTHING-VALID, S083, S084, DYNPROMISE,
 * REACTION, NONPROMISE, ADOPT, VOIDWIDEN, ISLAND, ONCE, RESOLVE, CORPUS (with the
 * REGRESSION rows over the claimed finally-chain programs).
 *
 * Three kinds of row assert THIS TIER's answer instead of a Node run, each
 * with Node's own output stated beside it: the registered divergences
 * (SEMANTICS.md S083 — typed promise adoption settles early, a dynamic
 * import's module evaluates early, and an `any`-held promise's island
 * `.then` adoption and `await` land one job off; S084 — a record field
 * typed void is dropped from the object); the trap rows (a named fence or
 * run-time refusal, or an unhandled rejection reported as SEMANTICS.md
 * S010 registers it); and
 * the one pinned named run-time refusal (adopting a non-promise thenable). */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-async-u4-"));
  // A row compiles in a directory whose package.json matches its source:
  // .ts and .mjs rows in an ES-module directory, .cjs rows in a CommonJS
  // one — the module kind decides microtask-vs-nextTick order (S082).
  await mkdir(join(scratch, "esm"));
  await mkdir(join(scratch, "cjs"));
  await writeFile(join(scratch, "esm", "package.json"), '{"type":"module"}\n');
  await writeFile(join(scratch, "cjs", "package.json"), '{"type":"commonjs"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A `// @dynamic` head builds with --dynamic (the differential harness's
 * own rule, the same test runRowDir applies). */
function isDynamic(src: string): boolean {
  return /^\/\/ @dynamic\s*$/m.test(src.split("\n", 2).join("\n"));
}

function dirFor(ext: string): string {
  return join(scratch, ext === "cjs" ? "cjs" : "esm");
}

async function runRow(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = dirFor(ext);
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

/** A row expecting an uncaught trap (a fence, or the unhandled-rejection
 * report): runWasmToTrap asserts the trap and reports what was printed
 * before it. The row's own path in a message reads `<ROW>`. */
async function runRowTrap(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string }> {
  const dir = dirFor(ext);
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasmToTrap(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr).split(entry).join("<ROW>") };
}

async function refuseRow(id: string, src: string, ext: string): Promise<{ diagnostics: string[]; survey: string[] }> {
  const dir = dirFor(ext);
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  if (res.ok) throw new Error(`${id} compiled but was expected to refuse`);
  return {
    diagnostics: [...new Set(res.diagnostics.map((d) => `${d.code}:${d.message}`))].sort(),
    survey: [...(res.wasmSurvey ?? [])].sort(),
  };
}

/** A multi-file row: every file written into its own directory, the
 * entry is main.ts; a `// @dynamic` head builds with --dynamic (the
 * differential harness's own rule). */
async function runRowDir(id: string, files: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = join(scratch, "esm", id);
  await mkdir(dir);
  for (const [name, src] of Object.entries(files)) await writeFile(join(dir, name), `${src}\n`);
  const dynamic = /^\/\/ @dynamic\s*$/m.test(files["main.ts"]!.split("\n", 2).join("\n"));
  const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "main.wasm"), outDir: dir, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

async function runCorpusRow(id: string, relPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = fileURLToPath(new URL(`../../../tests/corpus/${relPath}`, import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

// ============================================================
// FINALLY
// ============================================================

test("F01 FINALLY: return in try, a finally that falls through", async () => {
  const { stdout, stderr, exitCode } = await runRow("F01", "async function f(): Promise<number> {\n  try { console.log(\"try\"); return 1; } finally { console.log(\"finally\"); }\n}\nPromise.resolve().then(() => console.log(\"obs1\"));\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs2\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("try\nfinally\nsync\nobs1\nsettled 1\nobs2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F02 FINALLY: return in catch", async () => {
  const { stdout, stderr, exitCode } = await runRow("F02", "async function f(): Promise<string> {\n  try { throw new Error(\"x\"); } catch (e) { console.log(\"catch\"); return \"from-catch\"; } finally { console.log(\"finally\"); }\n}\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("catch\nfinally\nsync\nsettled from-catch\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F03 FINALLY: try-return / catch-return / catch-rethrow", async () => {
  const { stdout, stderr, exitCode } = await runRow("F03", "async function f(k: number): Promise<string> {\n  try { if (k > 0) throw new Error(\"t\"); return \"try\"; } catch (e) { if (k > 1) throw e; return \"catch\"; } finally { console.log(\"finally\", k); }\n}\nfor (const k of [0, 1, 2]) f(k).then((v) => console.log(\"settled\", k, v)).catch((e: unknown) => console.log(\"rejected\", k, String(e)));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("finally 0\nfinally 1\nfinally 2\nsync\nsettled 0 try\nsettled 1 catch\nobs\nrejected 2 Error: t\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F04 FINALLY: nested finallys run inner to outer", async () => {
  const { stdout, stderr, exitCode } = await runRow("F04", "async function f(): Promise<number> {\n  try {\n    try { return 1; } finally { console.log(\"inner finally\"); }\n  } finally { console.log(\"outer finally\"); }\n}\nf().then((v) => console.log(\"settled\", v));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("inner finally\nouter finally\nsync\nsettled 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F05 FINALLY: the finally mutates the returned local", async () => {
  const { stdout, stderr, exitCode } = await runRow("F05", "async function f(): Promise<number> {\n  let x = 1;\n  try { x = 2; return x; } finally { x = 3; console.log(\"finally x\", x); }\n}\nf().then((v) => console.log(\"settled\", v));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("finally x 3\nsync\nsettled 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F06 FINALLY: the return value is computed before the finally", async () => {
  const { stdout, stderr, exitCode } = await runRow("F06", "let x = 1;\nfunction bump(): number { x = x + 10; return x; }\nasync function f(): Promise<number> {\n  try { return bump(); } finally { x = 100; console.log(\"finally sees\", x); }\n}\nf().then((v) => console.log(\"settled\", v, \"x\", x));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("finally sees 100\nsync\nsettled 11 x 100\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F07 FINALLY: a finally's throw overrides a return", async () => {
  const { stdout, stderr, exitCode } = await runRow("F07", "async function f(): Promise<number> {\n  try { return 1; } finally { console.log(\"finally\"); throw new Error(\"fin\"); }\n}\nf().then((v) => console.log(\"settled\", v)).catch((e: unknown) => console.log(\"rejected\", String(e)));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("finally\nsync\nobs\nrejected Error: fin\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F08 FINALLY: an async arrow", async () => {
  const { stdout, stderr, exitCode } = await runRow("F08", "const f = async (): Promise<number> => {\n  try { return 7; } finally { console.log(\"finally\"); }\n};\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("finally\nsync\nsettled 7\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F09 FINALLY: a void return", async () => {
  const { stdout, stderr, exitCode } = await runRow("F09", "async function f(): Promise<void> {\n  try { console.log(\"try\"); return; } finally { console.log(\"finally\"); }\n}\nf().then(() => console.log(\"settled\"));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("try\nfinally\nsync\nsettled\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F10 FINALLY: a class method", async () => {
  const { stdout, stderr, exitCode } = await runRow("F10", "class K {\n  n = 4;\n  async m(): Promise<number> { try { return this.n; } finally { console.log(\"finally\"); } }\n}\nnew K().m().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("finally\nsync\nsettled 4\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F11 FINALLY: an await before the try", async () => {
  const { stdout, stderr, exitCode } = await runRow("F11", "async function g(): Promise<number> { return 5; }\nasync function f(): Promise<number> {\n  const x = await g();\n  try { console.log(\"try\", x); return x + 1; } finally { console.log(\"finally\"); }\n}\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\ntry 5\nfinally\nobs\nsettled 6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F12 FINALLY: the finally schedules a microtask before the settle", async () => {
  const { stdout, stderr, exitCode } = await runRow("F12", "// a verbatim try/finally: the finally schedules a microtask BEFORE the promise settles\nasync function f(): Promise<number> {\n  try {\n    return 1;\n  } finally {\n    queueMicrotask(() => console.log(\"fin micro\"));\n    console.log(\"fin\");\n  }\n}\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs1\")).then(() => console.log(\"obs2\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("fin\nsync\nfin micro\nsettled 1\nobs1\nobs2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F13 FINALLY: control: an await in the finally", async () => {
  const { stdout, stderr, exitCode } = await runRow("F13", "async function g(): Promise<number> { return 5; }\nasync function f(): Promise<number> {\n  try { return 1; } finally { await g(); console.log(\"finally after await\"); }\n}\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nfinally after await\nobs\nsettled 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F14 FINALLY: control: return await in the try", async () => {
  const { stdout, stderr, exitCode } = await runRow("F14", "async function g(): Promise<number> { return 5; }\nasync function f(): Promise<number> {\n  try { return await g(); } finally { console.log(\"finally\"); }\n}\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nfinally\nobs\nsettled 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F15 FINALLY: control: a throw through a finally", async () => {
  const { stdout, stderr, exitCode } = await runRow("F15", "async function f(): Promise<number> {\n  try { throw new Error(\"boom\"); } finally { console.log(\"finally\"); }\n}\nf().then((v) => console.log(\"settled\", v)).catch((e: unknown) => console.log(\"rejected\", String(e)));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("finally\nsync\nobs\nrejected Error: boom\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("F16 FINALLY: B-i: return inside a finally", async () => {
  const { diagnostics, survey } = await refuseRow("F16", "async function f(): Promise<number> {\n  try { return 1; } finally { console.log(\"finally\"); return 2; }\n}\nf().then((v) => console.log(\"settled\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC1090:'return' out of a 'finally' block (it would replace the pending completion — restructure so the finally only cleans up) is not supported yet"]);
});

test("F17 FINALLY: B-i: continue crossing a finally", async () => {
  const { diagnostics, survey } = await refuseRow("F17", "async function f(): Promise<number> {\n  let n = 0;\n  for (let i = 0; i < 3; i++) {\n    try { if (i === 1) continue; if (i === 2) return n; n += 10; } finally { console.log(\"finally\", i); }\n  }\n  return -1;\n}\nf().then((v) => console.log(\"settled\", v));\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC1090:'continue' crossing a 'finally' block is not supported yet"]);
});

test("F18 FINALLY: B-i: typed two-argument then", async () => {
  const { diagnostics, survey } = await refuseRow("F18", "async function f(): Promise<number> {\n  try { throw new Error(\"boom\"); } finally { console.log(\"finally\"); return 3; }\n}\nf().then((v) => console.log(\"settled\", v), (e) => console.log(\"rejected\", String(e)));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC2020:'then with 2 arguments' is part of the standard library types but has no scriptc lowering yet"]);
});

// ============================================================
// FINALLY-LINEAR
// ============================================================

test("FL01 FINALLY-LINEAR: async: a return inside a non-suspending if within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL01", "// FINALLY-LINEAR: a return inside a non-suspending `if` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    if (k === 1) return k * 10;\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 10\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL02 FINALLY-LINEAR: async: a return inside a non-suspending else within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL02", "// FINALLY-LINEAR: a return inside a non-suspending `else` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    if (k !== 1) {\n      console.log(\"then\", k);\n    } else {\n      return k * 10;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 10\nthen 2\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL03 FINALLY-LINEAR: async: a return inside a non-suspending switch within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL03", "// FINALLY-LINEAR: a return inside a non-suspending `switch` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    switch (k) {\n      case 1:\n        return k * 10;\n      default:\n        console.log(\"dflt\", k);\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 10\ndflt 2\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL04 FINALLY-LINEAR: async: a return inside a non-suspending label within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL04", "// FINALLY-LINEAR: a return inside a non-suspending `label` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    blk: {\n      if (k === 1) return k * 10;\n      break blk;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 10\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL05 FINALLY-LINEAR: async: a return inside a non-suspending trycatch within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL05", "// FINALLY-LINEAR: a return inside a non-suspending `trycatch` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    try {\n      if (k === 1) return k * 10;\n    } catch {\n      console.log(\"c\");\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 10\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL06 FINALLY-LINEAR: async: a return inside a non-suspending for within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL06", "// FINALLY-LINEAR: a return inside a non-suspending `for` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    for (let i = 0; i < 3; i++) {\n      if (k === 1 && i === 1) return k * 10 + i;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 11\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL07 FINALLY-LINEAR: async: a return inside a non-suspending while within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL07", "// FINALLY-LINEAR: a return inside a non-suspending `while` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    let i = 0;\n    while (i < 3) {\n      if (k === 1 && i === 2) return k * 10 + i;\n      i++;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 12\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL08 FINALLY-LINEAR: async: a return inside a non-suspending dowhile within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL08", "// FINALLY-LINEAR: a return inside a non-suspending `dowhile` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    let j = 0;\n    do {\n      if (k === 1) return k * 10;\n      j++;\n    } while (j < 2);\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 10\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL09 FINALLY-LINEAR: async: a return inside a non-suspending forof within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL09", "// FINALLY-LINEAR: a return inside a non-suspending `forof` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    for (const x of [5, 6]) {\n      if (k === 1 && x === 6) return x;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("fin 1\nobs\nr 6\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL10 FINALLY-LINEAR: async: a return inside a non-suspending innerfin within a suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL10", "// FINALLY-LINEAR: a return inside a non-suspending `innerfin` container within a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(k: number): Promise<number> {\n  try {\n    await t();\n    try {\n      if (k === 1) return k * 10;\n    } finally {\n      console.log(\"inner fin\", k);\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f(1));\n  console.log(\"r\", await f(2));\n}\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));", "ts");
  expect(stdout).toBe("inner fin 1\nfin 1\nobs\nr 10\ninner fin 2\nfell 2\nfin 2\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL11 FINALLY-LINEAR: generator: a return inside a non-suspending if within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL11", "// FINALLY-LINEAR: a return inside a non-suspending `if` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    if (k === 1) return k * 10;\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":10,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL12 FINALLY-LINEAR: generator: a return inside a non-suspending else within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL12", "// FINALLY-LINEAR: a return inside a non-suspending `else` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    if (k !== 1) {\n      console.log(\"then\", k);\n    } else {\n      return k * 10;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":10,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nthen 2\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL13 FINALLY-LINEAR: generator: a return inside a non-suspending switch within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL13", "// FINALLY-LINEAR: a return inside a non-suspending `switch` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    switch (k) {\n      case 1:\n        return k * 10;\n      default:\n        console.log(\"dflt\", k);\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":10,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\ndflt 2\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL14 FINALLY-LINEAR: generator: a return inside a non-suspending label within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL14", "// FINALLY-LINEAR: a return inside a non-suspending `label` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    blk: {\n      if (k === 1) return k * 10;\n      break blk;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":10,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL15 FINALLY-LINEAR: generator: a return inside a non-suspending trycatch within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL15", "// FINALLY-LINEAR: a return inside a non-suspending `trycatch` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    try {\n      if (k === 1) return k * 10;\n    } catch {\n      console.log(\"c\");\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":10,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL16 FINALLY-LINEAR: generator: a return inside a non-suspending for within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL16", "// FINALLY-LINEAR: a return inside a non-suspending `for` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    for (let i = 0; i < 3; i++) {\n      if (k === 1 && i === 1) return k * 10 + i;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":11,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL17 FINALLY-LINEAR: generator: a return inside a non-suspending while within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL17", "// FINALLY-LINEAR: a return inside a non-suspending `while` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    let i = 0;\n    while (i < 3) {\n      if (k === 1 && i === 2) return k * 10 + i;\n      i++;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":12,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL18 FINALLY-LINEAR: generator: a return inside a non-suspending dowhile within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL18", "// FINALLY-LINEAR: a return inside a non-suspending `dowhile` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    let j = 0;\n    do {\n      if (k === 1) return k * 10;\n      j++;\n    } while (j < 2);\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":10,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL19 FINALLY-LINEAR: generator: a return inside a non-suspending forof within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL19", "// FINALLY-LINEAR: a return inside a non-suspending `forof` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    for (const x of [5, 6]) {\n      if (k === 1 && x === 6) return x;\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfin 1\n{\"value\":6,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL20 FINALLY-LINEAR: generator: a return inside a non-suspending innerfin within a yielding try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL20", "// FINALLY-LINEAR: a return inside a non-suspending `innerfin` container within a try whose body yields (generator)\nfunction* g(k: number): Generator<number, number, void> {\n  try {\n    yield 1;\n    try {\n      if (k === 1) return k * 10;\n    } finally {\n      console.log(\"inner fin\", k);\n    }\n    console.log(\"fell\", k);\n  } finally {\n    console.log(\"fin\", k);\n  }\n  return -1;\n}\nfor (const k of [1, 2]) {\n  const it = g(k);\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n  console.log(JSON.stringify(it.next()));\n}", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\ninner fin 1\nfin 1\n{\"value\":10,\"done\":true}\n{\"done\":true}\n{\"value\":1,\"done\":false}\ninner fin 2\nfell 2\nfin 2\n{\"value\":-1,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL21 FINALLY-LINEAR: async: a return in a verbatim if under a suspending loop's try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL21", "// a try whose body suspends (linearized) with a return inside a verbatim `if`\nasync function step(n: number): Promise<number> {\n  return n * 2;\n}\nasync function f(xs: number[]): Promise<number> {\n  try {\n    for (const x of xs) {\n      const d = await step(x);\n      if (d > 10) return d;\n    }\n  } finally {\n    console.log(\"cleanup\");\n  }\n  return -1;\n}\nasync function main(): Promise<void> {\n  console.log(\"r\", await f([2, 9, 4]));\n  console.log(\"r\", await f([1, 2]));\n}\nmain();", "ts");
  expect(stdout).toBe("cleanup\nr 18\ncleanup\nr -1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL22 FINALLY-LINEAR: generator: a return in a verbatim if after a yield", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL22", "// a generator: a try whose body yields (linearized) with a return inside a verbatim `if`\nfunction* g(stop: number): Generator<number, number, void> {\n  try {\n    for (let i = 0; i < 3; i++) {\n      yield i;\n      if (i === stop) return 100 + i;\n    }\n  } finally {\n    console.log(\"gen cleanup\");\n  }\n  return -1;\n}\nconst it = g(1);\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("{\"value\":0,\"done\":false}\n{\"value\":1,\"done\":false}\ngen cleanup\n{\"value\":101,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL23 FINALLY-LINEAR: control: a return directly in the suspending try", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL23", "// a try whose body suspends, with a return DIRECTLY in the try body (no verbatim container)\nasync function f(): Promise<number> {\n  try {\n    await Promise.resolve(1);\n    return 5;\n  } finally {\n    console.log(\"cleanup\");\n  }\n}\nf().then((v) => console.log(\"r\", v));", "ts");
  expect(stdout).toBe("cleanup\nr 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL24 FINALLY-LINEAR: an array for-of with a sync body returning through a finally", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL24", "// an async function: a verbatim for-of (no suspension in it) returning from inside a finally-bearing try\nasync function f(xs: number[]): Promise<number> {\n  try {\n    for (const x of xs) {\n      if (x > 1) return x;\n    }\n  } finally {\n    console.log(\"cleanup\");\n  }\n  return -1;\n}\nf([1, 2, 3]).then((v) => console.log(\"r\", v));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("cleanup\nsync\nr 2\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL25 FINALLY-LINEAR: a string for-of returning through a suspending try's finally", async () => {
  const { stdout, stderr, exitCode } = await runRow("FL25", "// a return crossing a finally from inside a for-of over a STRING, in an async function whose try suspends\nasync function t(): Promise<void> {}\nasync function f(s: string): Promise<string> {\n  try {\n    await t();\n    for (const ch of s) {\n      if (ch === \"b\") return ch;\n    }\n  } finally {\n    console.log(\"fin\");\n  }\n  return \"none\";\n}\nf(\"abc\").then((v) => console.log(\"r\", v));", "ts");
  expect(stdout).toBe("fin\nr b\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("FL26 FINALLY-LINEAR: B-i: async break crossing a finally", async () => {
  const { diagnostics, survey } = await refuseRow("FL26", "// FINALLY-LINEAR: a `break` crossing the finally of a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(): Promise<void> {\n  for (let i = 0; i < 3; i++) {\n    try {\n      await t();\n      if (i === 1) break;\n      console.log(\"body\", i);\n    } finally {\n      console.log(\"fin\", i);\n    }\n  }\n  console.log(\"done\");\n}\nf();", "ts");
  expect(diagnostics).toEqual(["SC1090:'break' crossing a 'finally' block is not supported yet"]);
});

test("FL27 FINALLY-LINEAR: B-i: async continue crossing a finally", async () => {
  const { diagnostics, survey } = await refuseRow("FL27", "// FINALLY-LINEAR: a `continue` crossing the finally of a try whose body suspends (async)\nasync function t(): Promise<void> {}\nasync function f(): Promise<void> {\n  for (let i = 0; i < 3; i++) {\n    try {\n      await t();\n      if (i === 1) continue;\n      console.log(\"body\", i);\n    } finally {\n      console.log(\"fin\", i);\n    }\n  }\n  console.log(\"done\");\n}\nf();", "ts");
  expect(diagnostics).toEqual(["SC1090:'continue' crossing a 'finally' block is not supported yet"]);
});

test("FL28 FINALLY-LINEAR: B-i: generator break crossing a finally", async () => {
  const { diagnostics, survey } = await refuseRow("FL28", "// FINALLY-LINEAR: a `break` crossing the finally of a try whose body yields (generator)\nfunction* g(): Generator<number, void, void> {\n  for (let i = 0; i < 3; i++) {\n    try {\n      yield i;\n      if (i === 1) break;\n      console.log(\"body\", i);\n    } finally {\n      console.log(\"fin\", i);\n    }\n  }\n  console.log(\"done\");\n}\nfor (const v of g()) console.log(\"v\", v);", "ts");
  expect(diagnostics).toEqual(["SC1090:'break' crossing a 'finally' block is not supported yet"]);
});

test("FL29 FINALLY-LINEAR: B-i: generator continue crossing a finally", async () => {
  const { diagnostics, survey } = await refuseRow("FL29", "// FINALLY-LINEAR: a `continue` crossing the finally of a try whose body yields (generator)\nfunction* g(): Generator<number, void, void> {\n  for (let i = 0; i < 3; i++) {\n    try {\n      yield i;\n      if (i === 1) continue;\n      console.log(\"body\", i);\n    } finally {\n      console.log(\"fin\", i);\n    }\n  }\n  console.log(\"done\");\n}\nfor (const v of g()) console.log(\"v\", v);", "ts");
  expect(diagnostics).toEqual(["SC1090:'continue' crossing a 'finally' block is not supported yet"]);
});

// ============================================================
// GEN
// ============================================================

test("G01 GEN: a verbatim finally after a yield: next, next", async () => {
  const { stdout, stderr, exitCode } = await runRow("G01", "function* g(): Generator<number, number, unknown> {\n  yield 0;\n  try { return 1; } finally { console.log(\"finally\"); }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("{\"value\":0,\"done\":false}\nfinally\n{\"value\":1,\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G02 GEN: return() before the try: the finally does not run", async () => {
  const { stdout, stderr, exitCode } = await runRow("G02", "function* g(): Generator<number, number, unknown> {\n  yield 0;\n  try { return 1; } finally { console.log(\"finally\"); }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.return(7)));\nconsole.log(JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("{\"value\":0,\"done\":false}\n{\"value\":7,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G03 GEN: throw() before the try", async () => {
  const { stdout, stderr, exitCode } = await runRow("G03", "function* g(): Generator<number, number, unknown> {\n  yield 0;\n  try { return 1; } finally { console.log(\"finally\"); }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()));\ntry { it.throw(new Error(\"t\")); } catch (e) { console.log(\"threw out\", (e as Error).message); }\nconsole.log(JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("{\"value\":0,\"done\":false}\nthrew out t\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G04 GEN: a verbatim finally's throw overrides", async () => {
  const { stdout, stderr, exitCode } = await runRow("G04", "function* g(): Generator<number, number, unknown> {\n  yield 0;\n  try { return 1; } finally { console.log(\"finally\"); throw new Error(\"fin\"); }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()));\ntry { it.next(); } catch (e) { console.log(\"caught\", (e as Error).message); }\nconsole.log(JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("{\"value\":0,\"done\":false}\nfinally\ncaught fin\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G05 GEN: the return value is read before the finally", async () => {
  const { stdout, stderr, exitCode } = await runRow("G05", "let x = 1;\nfunction* g(): Generator<number, number, unknown> {\n  yield 0;\n  try { x = 2; return x; } finally { x = 3; console.log(\"finally x\", x); }\n}\nconst it = g();\nit.next();\nconsole.log(JSON.stringify(it.next()), \"x\", x);", "ts");
  expect(stdout).toBe("finally x 3\n{\"value\":2,\"done\":true} x 3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G06 GEN: a for-of consumer", async () => {
  const { stdout, stderr, exitCode } = await runRow("G06", "function* g(): Generator<number, number, unknown> {\n  yield 1; yield 2;\n  try { return 3; } finally { console.log(\"finally\"); }\n}\nfor (const v of g()) { console.log(\"v\", v); }\nconsole.log(\"done\");", "ts");
  expect(stdout).toBe("v 1\nv 2\nfinally\ndone\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G07 GEN: NOT-LIFTED: a generator loop box with an early break still refuses (board #179)", async () => {
  const { diagnostics, survey } = await refuseRow("G07", "function* g(): Generator<number, void, unknown> {\n  const fs: (() => number)[] = [];\n  try {\n    for (let i = 0; i < 5; i++) { const k = i; fs.push(() => k); yield i; }\n  } finally { console.log(fs.map((f) => f()).join(\",\")); }\n}\nfor (const x of g()) { if (x === 2) break; }\nconsole.log(\"after\");", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:boxed-in-loop); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:yieldExpr", "fn:async:boxed-in-loop", "fn:generator"]);
});

test("G08 GEN: a void yield between side effects", async () => {
  const { stdout, stderr, exitCode } = await runRow("G08", "const log: string[] = [];\nfunction tick(t: string): number { log.push(t); return 1; }\nfunction* g(): Generator<number, void, void> {\n  const a = [tick(\"a\"), yield 2, tick(\"c\")];\n  console.log(a.length, a[1], log.join(\",\"));\n}\nconst it = g(); it.next(); log.push(\"between\"); it.next();", "ts");
  expect(stdout).toBe("3 undefined a,between,c\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G09 GEN: NOT-LIFTED: generator loop boxes held across yields still refuse (board #179)", async () => {
  const { diagnostics, survey } = await refuseRow("G09", "function* g(): Generator<number, void, unknown> {\n  const fs: (() => number)[] = [];\n  for (let i = 0; i < 3; i++) { const k = i * 2; fs.push(() => k); yield i; }\n  console.log(fs.map((f) => f()).join(\",\"));\n}\nfor (const x of g()) console.log(\"y\", x);", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:boxed-in-loop); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:yieldExpr", "fn:async:boxed-in-loop", "fn:generator"]);
});

test("G10 GEN: NOT-LIFTED: a generator while-loop box still refuses (board #179)", async () => {
  const { diagnostics, survey } = await refuseRow("G10", "function* g(): Generator<number, void, unknown> {\n  const fs: (() => number)[] = [];\n  let i = 0;\n  while (i < 3) { const k = i; fs.push(() => k); yield i; i++; }\n  console.log(fs.map((f) => f()).join(\",\"));\n}\nfor (const x of g()) console.log(\"y\", x);", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:boxed-in-loop); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:yieldExpr", "fn:async:boxed-in-loop", "fn:generator"]);
});

test("G11 GEN: a void yield in an array literal", async () => {
  const { stdout, stderr, exitCode } = await runRow("G11", "function* g(): Generator<number, void, void> {\n  const a = [1, yield 2, 3];\n  console.log(a.length, a[1]);\n}\nconst it = g(); it.next(); it.next();", "ts");
  expect(stdout).toBe("3 undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G12 GEN: control: a yielding try returns", async () => {
  const { stdout, stderr, exitCode } = await runRow("G12", "function* g(): Generator<number, number, unknown> {\n  try { yield 1; return 2; } finally { console.log(\"finally\"); }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\nfinally\n{\"value\":2,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G13 GEN: control: a yielding try returns a call", async () => {
  const { stdout, stderr, exitCode } = await runRow("G13", "function* g(): Generator<number, number, unknown> {\n  try { yield 1; yield 2; return 9; } finally { console.log(\"cleanup\"); }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()));\nconsole.log(JSON.stringify(it.return(5)));\nconsole.log(JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("{\"value\":1,\"done\":false}\ncleanup\n{\"value\":5,\"done\":true}\n{\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G14 GEN: control: generator return through a finally", async () => {
  const { stdout, stderr, exitCode } = await runRow("G14", "function* g() {\n  try { yield 1; return 2; } finally { console.log(\"finally\"); }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()));", "ts");
  expect(stdout).toBe("finally\n{\"value\":1,\"done\":false} {\"value\":2,\"done\":true} {\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G15 GEN: B-i: return inside a generator's finally", async () => {
  const { diagnostics, survey } = await refuseRow("G15", "function* g(): Generator<number, number, unknown> {\n  try { yield 1; return 2; } finally { return 3; }\n}\nconst it = g();\nconsole.log(JSON.stringify(it.next()), JSON.stringify(it.next()));", "ts");
  expect(diagnostics).toEqual(["SC1090:'return' out of a 'finally' block (it would replace the pending completion — restructure so the finally only cleans up) is not supported yet"]);
});

test("G16 GEN: B-i: spreading a generator of closures", async () => {
  const { diagnostics, survey } = await refuseRow("G16", "function* g(): Generator<() => number, void, unknown> {\n  for (let i = 0; i < 3; i++) { const k = i; yield () => k; }\n}\nconst fs = [...g()];\nconsole.log(fs.map((f) => f()).join(\",\"));", "ts");
  expect(diagnostics).toEqual(["SC1090:spreading 'Generator<() => number, void, unknown>' into a '(() => number)[]' literal (only a same-element-type array spreads) is not supported yet"]);
});

test("G17 GEN: B-i: a void yield as a call operand", async () => {
  const { diagnostics, survey } = await refuseRow("G17", "function show(x: unknown): void { console.log(\"show\", x); }\nfunction* g(): Generator<number, void, void> { show(yield 1); console.log(\"end\"); }\nconst it = g();\nit.next(); it.next();", "ts");
  expect(diagnostics).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
});

test("G18 GEN: async twin of G07: a loop box in a try with a finally and an early break, read after the await", async () => {
  const { stdout, stderr, exitCode } = await runRow("G18", "async function main(): Promise<void> {\n  const fs: (() => number)[] = [];\n  try {\n    for (let i = 0; i < 5; i++) { const k = i; fs.push(() => k); await 0; console.log(\"k after await\", k); if (i === 2) break; }\n  } finally { console.log(fs.map((f) => f()).join(\",\")); }\n  console.log(\"after\");\n}\nmain();\nPromise.resolve().then(() => console.log(\"observer\"));", "ts");
  expect(stdout).toBe("k after await 0\nobserver\nk after await 1\nk after await 2\n0,1,2\nafter\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G19 GEN: async twin of G09: for-let loop boxes held across awaits", async () => {
  const { stdout, stderr, exitCode } = await runRow("G19", "async function main(): Promise<void> {\n  const fs: (() => number)[] = [];\n  for (let i = 0; i < 3; i++) { const k = i * 2; fs.push(() => k); await 0; console.log(\"y\", i, k); }\n  console.log(fs.map((f) => f()).join(\",\"));\n}\nmain();\nqueueMicrotask(() => console.log(\"observer\"));", "ts");
  expect(stdout).toBe("y 0 0\nobserver\ny 1 2\ny 2 4\n0,2,4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G20 GEN: async twin of G10: a while-loop box written after the await", async () => {
  const { stdout, stderr, exitCode } = await runRow("G20", "async function main(): Promise<void> {\n  const fs: (() => number)[] = [];\n  let i = 0;\n  while (i < 3) { let k = i; fs.push(() => k); await 0; k += 100; console.log(\"y\", i); i++; }\n  console.log(fs.map((f) => f()).join(\",\"));\n}\nmain();\nPromise.resolve().then(() => console.log(\"observer\"));", "ts");
  expect(stdout).toBe("y 0\nobserver\ny 1\ny 2\n100,101,102\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("G21 GEN: NOT-LIFTED: a generator for-let head variable captured, with a guard (board #179)", async () => {
  const { diagnostics, survey } = await refuseRow("G21", "function* gen(): Generator<number, void, unknown> {\n  const fns: (() => number)[] = [];\n  let guard = 0;\n  for (let i = 0; i < 3; i++) { fns.push(() => i); yield i; if (++guard > 6) { console.log(\"RUNAWAY i\", i); return; } }\n  console.log(fns.map((f) => f()).join(\",\"));\n}\nfor (const v of gen()) console.log(\"y\", v);", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:boxed-in-loop); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:yieldExpr", "fn:async:boxed-in-loop", "fn:generator"]);
});

test("G22 GEN: NOT-LIFTED: a generator body box written after the yield (board #179)", async () => {
  const { diagnostics, survey } = await refuseRow("G22", "function* gen(): Generator<number, void, unknown> {\n  const fns: (() => number)[] = [];\n  let k = 0;\n  while (k < 3) { let c = k; fns.push(() => c); yield c; c += 100; k++; }\n  console.log(fns.map((f) => f()).join(\",\"));\n}\nfor (const v of gen()) console.log(\"y\", v);", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:boxed-in-loop); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:yieldExpr", "fn:async:boxed-in-loop", "fn:generator"]);
});

test("G23 GEN: NOT-LIFTED: a generator for-of binding read after the yield (board #179)", async () => {
  const { diagnostics, survey } = await refuseRow("G23", "function* gen(): Generator<string, void, unknown> {\n  const fns: (() => string)[] = [];\n  for (const s of [\"a\", \"b\"]) { fns.push(() => s); yield s; console.log(\"after yield sees\", s); }\n  console.log(fns.map((f) => f()).join(\",\"));\n}\nfor (const v of gen()) console.log(\"y\", v);", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:boxed-in-loop); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:yieldExpr", "fn:async:boxed-in-loop", "fn:generator"]);
});

test("G24 GEN: NOT-LIFTED: a generator body box read after the yield (board #179)", async () => {
  const { diagnostics, survey } = await refuseRow("G24", "function* gen(): Generator<number, void, unknown> {\n  let k = 0;\n  const fns: (() => number)[] = [];\n  while (k < 3) { const c = k * 10; fns.push(() => c); yield 0; console.log(\"c after yield\", c); k++; }\n  console.log(fns.map((f) => f()).join(\",\"));\n}\nfor (const v of gen()) console.log(\"y\", v);", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:boxed-in-loop); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:yieldExpr", "fn:async:boxed-in-loop", "fn:generator"]);
});

test("G25 GEN: async twin of G21: a for-let head variable captured, with a guard", async () => {
  const { stdout, stderr, exitCode } = await runRow("G25", "async function main(): Promise<void> {\n  const fns: (() => number)[] = [];\n  let guard = 0;\n  for (let i = 0; i < 3; i++) { fns.push(() => i); await 0; console.log(\"it\", i); if (++guard > 6) { console.log(\"RUNAWAY i\", i); return; } }\n  console.log(fns.map((f) => f()).join(\",\"));\n}\nmain();", "ts");
  expect(stdout).toBe("it 0\nit 1\nit 2\n0,1,2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// HOISTVOID
// ============================================================

test("H01 HOISTVOID: a void await in an array literal", async () => {
  const { stdout, stderr, exitCode } = await runRow("H01", "async function v(): Promise<void> {}\nasync function f(): Promise<void> { const a = [1, await v(), 3]; console.log(a.length, a[1]); }\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n3 undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("H02 HOISTVOID: a void await in a record literal", async () => {
  const { stdout, stderr, exitCode } = await runRow("H02", "async function v(): Promise<void> {}\nasync function f(): Promise<void> { const o = { a: await v(), b: 2 }; console.log(JSON.stringify(o), o.a); }\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n{\"b\":2} undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("H03 HOISTVOID: a void await between side-effecting elements", async () => {
  const { stdout, stderr, exitCode } = await runRow("H03", "// a void await in an array literal between two side-effecting elements, with an observer\nconst log: string[] = [];\nfunction tick(t: string): number {\n  log.push(t);\n  return 1;\n}\nasync function v(): Promise<void> {\n  log.push(\"v\");\n}\nasync function f(): Promise<void> {\n  const a = [tick(\"a\"), await v(), tick(\"c\")];\n  console.log(a.length, a[1] === undefined, log.join(\",\"));\n}\nf();\nPromise.resolve().then(() => log.push(\"obs\"));\nlog.push(\"sync\");", "ts");
  expect(stdout).toBe("3 true a,v,sync,c\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("H04 HOISTVOID: a dropped record field holding a void await, in a try", async () => {
  const { stdout, stderr, exitCode } = await runRow("H04", "// a dropped record field holding a void await (the pMap shape), inside a try, with an observer\nconst log: string[] = [];\nasync function work(n: number): Promise<void> {\n  log.push(\"work \" + n);\n  if (n === 2) throw new Error(\"bad \" + n);\n}\nasync function f(n: number): Promise<string> {\n  let r: PromiseSettledResult<void>;\n  try {\n    r = { status: \"fulfilled\", value: await work(n) };\n  } catch (e) {\n    r = { status: \"rejected\", reason: e };\n  }\n  return r.status;\n}\nasync function main(): Promise<void> {\n  log.push(await f(1));\n  log.push(await f(2));\n  console.log(log.join(\",\"));\n}\nmain();\nPromise.resolve().then(() => log.push(\"obs\"));", "ts");
  expect(stdout).toBe("work 1,obs,fulfilled,work 2,rejected\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("H05 HOISTVOID: NOT-LIFTED: a void await in a ternary arm", async () => {
  const { diagnostics, survey } = await refuseRow("H05", "async function v(): Promise<void> {}\nasync function f(c: boolean): Promise<void> { const x = c ? await v() : 1; console.log(\"x\", x); }\nf(true); f(false);\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:await-conditional); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["expr:awaitExpr", "fn:async", "fn:async:await-conditional"]);
});

test("H06 HOISTVOID: control: a void await statement", async () => {
  const { stdout, stderr, exitCode } = await runRow("H06", "async function v(): Promise<void> { console.log(\"v ran\"); }\nasync function f(): Promise<void> { await v(); console.log(\"after\"); }\nf();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("v ran\nsync\nafter\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("H07 HOISTVOID: control: a void await returned", async () => {
  const { stdout, stderr, exitCode } = await runRow("H07", "async function v(): Promise<void> {}\nasync function f(): Promise<void> { return await v(); }\nf().then(() => console.log(\"settled\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nsettled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("H08 HOISTVOID: B-i: a void await as a call argument", async () => {
  const { diagnostics, survey } = await refuseRow("H08", "async function v(): Promise<void> { console.log(\"v ran\"); }\nfunction show(x: unknown): void { console.log(\"show\", x); }\nasync function f(): Promise<void> { show(await v()); console.log(\"after\"); }\nf();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
});

test("H09 HOISTVOID: B-i: two void call arguments", async () => {
  const { diagnostics, survey } = await refuseRow("H09", "async function v(tag: string): Promise<void> { console.log(\"v\", tag); }\nfunction two(a: unknown, b: unknown): void { console.log(\"two\", a, b); }\nasync function f(): Promise<void> { two(await v(\"a\"), await v(\"b\")); }\nf();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
});

test("H10 HOISTVOID: B-i: void awaits as call arguments with side effects", async () => {
  const { diagnostics, survey } = await refuseRow("H10", "let log: string[] = [];\nasync function v(): Promise<void> { log.push(\"v\"); }\nfunction tick(tag: string): number { log.push(tag); return 1; }\nfunction three(a: number, b: unknown, c: number): void { log.push(\"three\"); }\nasync function f(): Promise<void> { three(tick(\"a\"), await v(), tick(\"c\")); console.log(log.join(\",\")); }\nf();\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
});

test("H11 HOISTVOID: B-i: console.log of a void await", async () => {
  const { diagnostics, survey } = await refuseRow("H11", "async function v(): Promise<void> { console.log(\"v ran\"); }\nasync function f(): Promise<void> { console.log(\"got\", await v()); }\nf();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC1090:console.log of a void call result (call it as its own statement, then console.log(undefined)) is not supported yet"]);
});

test("H12 HOISTVOID: B-i: a void await in a template", async () => {
  const { diagnostics, survey } = await refuseRow("H12", "async function v(): Promise<void> {}\nasync function f(): Promise<void> { console.log(`t:${await v()}`); }\nf();\nconsole.log(\"sync\");", "ts");
  expect(diagnostics).toEqual(["SC2011:values of type 'void' have no static representation but run in the embedded dynamic engine, which this build does not include"]);
});

// ============================================================
// LOOPBOX
// ============================================================

test("L01 LOOPBOX: for-let closures across awaits", async () => {
  const { stdout, stderr, exitCode } = await runRow("L01", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  const fs: (() => number)[] = [];\n  for (let i = 0; i < 3; i++) { const k = i * 10; fs.push(() => k); await g(); }\n  console.log(fs.map((h) => h()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n0,10,20\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L02 LOOPBOX: for-of closures", async () => {
  const { stdout, stderr, exitCode } = await runRow("L02", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  const fs: (() => string)[] = [];\n  for (const s of [\"a\", \"b\", \"c\"]) { const t = s + \"!\"; fs.push(() => t); await g(); }\n  console.log(fs.map((h) => h()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\na!,b!,c!\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L03 LOOPBOX: while closures", async () => {
  const { stdout, stderr, exitCode } = await runRow("L03", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  const fs: (() => number)[] = [];\n  let i = 0;\n  while (i < 3) { const k = i; fs.push(() => k); i++; await g(); }\n  console.log(fs.map((h) => h()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n0,1,2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L04 LOOPBOX: do-while closures", async () => {
  const { stdout, stderr, exitCode } = await runRow("L04", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  const fs: (() => number)[] = [];\n  let i = 0;\n  do { let k = i; fs.push(() => k); k += 100; i++; await g(); } while (i < 3);\n  console.log(fs.map((h) => h()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n100,101,102\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L05 LOOPBOX: the for-head variable captured", async () => {
  const { stdout, stderr, exitCode } = await runRow("L05", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  const fs: (() => number)[] = [];\n  for (let i = 0; i < 3; i++) { fs.push(() => i); await g(); }\n  console.log(fs.map((h) => h()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n0,1,2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L06 LOOPBOX: continue past a closure", async () => {
  const { stdout, stderr, exitCode } = await runRow("L06", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  const fs: (() => number)[] = [];\n  for (let i = 0; i < 4; i++) { const k = i; if (i % 2 === 1) { await g(); continue; } fs.push(() => k); }\n  console.log(fs.map((h) => h()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n0,2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L07 LOOPBOX: mutation after capture", async () => {
  const { stdout, stderr, exitCode } = await runRow("L07", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  const fs: (() => number)[] = [];\n  for (let i = 0; i < 3; i++) { let k = i; fs.push(() => k); await g(); k = k * 100; }\n  console.log(fs.map((h) => h()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n0,100,200\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L08 LOOPBOX: a closure called in a later iteration", async () => {
  const { stdout, stderr, exitCode } = await runRow("L08", "async function g(): Promise<number> { return 0; }\nasync function f(): Promise<void> {\n  let prev: (() => number) | null = null;\n  for (let i = 0; i < 3; i++) { const k = i; if (prev !== null) console.log(\"prev\", prev()); prev = () => k; await g(); }\n  console.log(\"last\", prev !== null ? prev() : -1);\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nprev 0\nprev 1\nlast 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L09 LOOPBOX: the for-head variable across continue", async () => {
  const { stdout, stderr, exitCode } = await runRow("L09", "// the captured for-head variable across `continue` and an await in the body\nasync function tick(): Promise<void> {}\nasync function f(): Promise<void> {\n  const fns: (() => number)[] = [];\n  for (let i = 0; i < 4; i++) {\n    fns.push(() => i);\n    await tick();\n    if (i === 1) continue;\n    i += 0;\n  }\n  console.log(fns.map((g) => g()).join(\",\"));\n}\nf();", "ts");
  expect(stdout).toBe("0,1,2,3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L10 LOOPBOX: a tdz const read by a closure built before its initializer", async () => {
  const { stdout, stderr, exitCode } = await runRow("L10", "// a const declared in a loop body, captured by a closure created BEFORE the declaration in the same iteration\nasync function tick(): Promise<void> {}\nasync function f(): Promise<void> {\n  const fns: (() => number)[] = [];\n  for (let i = 0; i < 2; i++) {\n    const read = (): number => k;\n    const k = i * 10;\n    fns.push(read);\n    await tick();\n  }\n  console.log(fns.map((g) => g()).join(\",\"));\n}\nf();", "ts");
  expect(stdout).toBe("0,10\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L11 LOOPBOX: B-i: a let captured before its declaration", async () => {
  const { diagnostics, survey } = await refuseRow("L11", "// a `let` declared in a loop body, captured by a closure created BEFORE the declaration in the same iteration\nasync function tick(): Promise<void> {}\nasync function f(): Promise<void> {\n  const fns: (() => number)[] = [];\n  let i = 0;\n  while (i < 2) {\n    fns.push(() => k);\n    let k = i * 10;\n    k += 1;\n    await tick();\n    i++;\n  }\n  console.log(fns.map((g) => g()).join(\",\"));\n}\nf();", "ts");
  expect(diagnostics).toEqual(["SC1090:the reference to 'k' (a binding form with no lowering) is not supported yet"]);
});

test("L12 LOOPBOX: a captured for-of binding in a loop kept whole, in an async function that awaits elsewhere", async () => {
  const { stdout, stderr, exitCode } = await runRow("L12", "// a captured for-of binding in a for-of with NO await inside it, in an async function that awaits elsewhere\nasync function tick(): Promise<void> {}\nasync function f(): Promise<void> {\n  const fns: (() => number)[] = [];\n  await tick();\n  for (const x of [1, 2, 3]) {\n    fns.push(() => x * 10);\n  }\n  await tick();\n  console.log(fns.map((g) => g()).join(\",\"));\n}\nf();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\n10,20,30\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// HOLES
// ============================================================

test("HO01 HOLES: Array.from union holes read as undefined", async () => {
  const { stdout, stderr, exitCode } = await runRow("HO01", "// sync only (1453's tail): mapper-less Array.from({ length }) with union elements — absent slots read as undefined\nconst slots = Array.from<string | undefined>({ length: 3 });\nconsole.log(slots.length);\nconsole.log(slots[0] === undefined, slots[2] !== undefined);\nslots[1] = \"filled\";\nconst s1 = slots[1];\nconsole.log(s1 === undefined ? \"undef\" : s1);\nconsole.log(Array.from<number | undefined>({ length: 2.7 }).length);", "ts");
  expect(stdout).toBe("3\ntrue false\nfilled\n2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("HO02 HOLES: Array.from number-or-undefined holes", async () => {
  const { stdout, stderr, exitCode } = await runRow("HO02", "const a = Array.from<number | undefined>({ length: 2 });\nconsole.log(a.length, a[0] === undefined, a[1]);", "ts");
  expect(stdout).toBe("2 true undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("HO03 HOLES: B-i: new Array(n) of numbers", async () => {
  const { diagnostics, survey } = await refuseRow("HO03", "const a: number[] = new Array<number>(3);\nconsole.log(a.length, a[0], String(a[1]));", "ts");
  expect(diagnostics).toEqual(["SC2020:'new Array(count)' is part of the standard library types but has no scriptc lowering yet"]);
});

test("HO04 HOLES: B-i: Array.from of numbers", async () => {
  const { diagnostics, survey } = await refuseRow("HO04", "const a = Array.from<number>({ length: 2 } as ArrayLike<number>);\nconsole.log(a.length, a[0]);", "ts");
  expect(diagnostics).toEqual(["SC2020:'Array.from with this argument shape' is part of the standard library types but has no scriptc lowering yet"]);
});

test("HO05 HOLES: B-i: Array.from of strings", async () => {
  const { diagnostics, survey } = await refuseRow("HO05", "const a = Array.from<string>({ length: 2 } as ArrayLike<string>);\nconsole.log(a.length, a[0]);", "ts");
  expect(diagnostics).toEqual(["SC2020:'Array.from with this argument shape' is part of the standard library types but has no scriptc lowering yet"]);
});

test("HO06 HOLES: B-i: Array.from of a union without undefined", async () => {
  const { diagnostics, survey } = await refuseRow("HO06", "const a = Array.from<string | number>({ length: 2 } as ArrayLike<string | number>);\nconsole.log(a.length, typeof a[0]);", "ts");
  expect(diagnostics).toEqual(["SC1090:typeof expressions on statically-typed values are not supported yet", "SC2020:'Array.from with this argument shape' is part of the standard library types but has no scriptc lowering yet"]);
});

test("HO07 HOLES: B-i: new Array(n) of a union with undefined", async () => {
  const { diagnostics, survey } = await refuseRow("HO07", "const a = new Array<string | undefined>(2);\nconsole.log(a.length, a[0] === undefined);", "ts");
  expect(diagnostics).toEqual(["SC2020:'new Array(count)' is part of the standard library types but has no scriptc lowering yet"]);
});

// ============================================================
// EVERYTHING-VALID
// ============================================================

test("E02 EVERYTHING-VALID: every value of a typed async path, in order, with an observer", async () => {
  const { stdout, stderr, exitCode } = await runRow("E02", "// every value on a typed async path printed in order, beside an observer chain\nconst log: string[] = [];\nasync function num(n: number): Promise<number> {\n  log.push(\"num \" + n);\n  return n;\n}\nasync function main(): Promise<void> {\n  let total = 0;\n  const fns: (() => number)[] = [];\n  for (let i = 0; i < 3; i++) {\n    const v = await num(i);\n    fns.push(() => v * 10 + i);\n    total += v;\n  }\n  try {\n    const a = [await num(7), total];\n    log.push(\"a \" + a.join(\"+\"));\n    if (a[0] > 5) return;\n  } finally {\n    log.push(\"fin \" + fns.map((g) => g()).join(\",\"));\n  }\n}\nmain().then(() => console.log(log.join(\" | \")));\nPromise.resolve().then(() => log.push(\"o1\")).then(() => log.push(\"o2\")).then(() => log.push(\"o3\"));", "ts");
  expect(stdout).toBe("num 0 | num 1 | o1 | num 2 | o2 | num 7 | o3 | a 7+3 | fin 0,11,22\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// S083
// ============================================================

test("S01 S083: S083 a then handler returns a promise: adoption lands one job early", async () => {
  // Node v24 prints "o1\no2\no3\nadopted 9\no4\no5\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S01", "async function other(): Promise<number> { return 9; }\nPromise.resolve(1).then(() => other()).then((v) => console.log(\"adopted\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\no2\nadopted 9\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S02 S083: S083 an async function's return of a promise: one job early", async () => {
  // Node v24 prints "o1\no2\nasync-return-p 9\no3\no4\no5\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S02", "async function other(): Promise<number> { return 9; }\nasync function f(): Promise<number> { return other(); }\nf().then((v) => console.log(\"async-return-p\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\nasync-return-p 9\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S03 S083: S083 nested adoption: one job early", async () => {
  // Node v24 prints "o1\no2\no3\no4\no5\nnested 9\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S03", "async function other(): Promise<number> { return 9; }\nPromise.resolve(1).then(() => Promise.resolve(1).then(() => other())).then((v) => console.log(\"nested\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\no2\no3\no4\nnested 9\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S04 S083: S083 a rejected promise adopted: one job early", async () => {
  // Node v24 prints "o1\no2\no3\no4\nrejected-adopt\no5\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S04", "async function bad(): Promise<number> { throw new Error(\"r\"); }\nPromise.resolve(1).then(() => bad()).then((v) => console.log(\"never\", v)).catch((e: unknown) => console.log(\"rejected-adopt\"));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\no2\no3\nrejected-adopt\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S05 S083: S083 a handler returns Promise.resolve: one job early", async () => {
  // Node v24 prints "o1\no2\no3\nresolved-p 9\no4\no5\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S05", "Promise.resolve(1).then(() => Promise.resolve(9)).then((v) => console.log(\"resolved-p\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\no2\nresolved-p 9\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S06 S083: S083 a catch handler returns a promise: one job early", async () => {
  // Node v24 prints "o1\no2\no3\ncatch-adopt 9\no4\no5\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S06", "async function bad(): Promise<number> { throw new Error(\"x\"); }\nasync function other(): Promise<number> { return 9; }\nbad().catch(() => other()).then((v) => console.log(\"catch-adopt\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\no2\ncatch-adopt 9\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S07 S083: S083 a finally handler's returned promise is not waited for", async () => {
  // Node v24 prints "o1\no2\no3\nfinally-adopt 3\no4\no5\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S07", "async function other(): Promise<number> { return 9; }\nPromise.resolve(3).finally(() => other()).then((v) => console.log(\"finally-adopt\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\nfinally-adopt 3\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S08 S083: S083 then-chain adoption against a four-step observer", async () => {
  // Node v24 prints "sync\no1\no2\no3\nadopted 9\no4\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("S08", "async function good(): Promise<number> { return 5; }\nasync function other(): Promise<number> { return 9; }\ngood().then(() => other()).then((v) => console.log(\"adopted\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\nadopted 9\no3\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S09 S083: agreeing control: a plain await of a promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("S09", "async function other(): Promise<number> { return 9; }\nasync function f(): Promise<void> { const v = await other(); console.log(\"await\", v); }\nf();\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("await 9\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S10 S083: agreeing control: Promise.resolve of a promise is that promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("S10", "async function other(): Promise<number> { return 9; }\nconst p = other();\nconsole.log(\"identity\", Promise.resolve(p) === p);\nPromise.resolve(p).then((v) => console.log(\"presolve\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("identity true\npresolve 9\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S11 S083: agreeing control: return await of a promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("S11", "async function other(): Promise<number> { return 9; }\nasync function f(): Promise<number> { return await other(); }\nf().then((v) => console.log(\"return-await\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(stdout).toBe("o1\nreturn-await 9\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S12 S083: agreeing control: an awaited value returned", async () => {
  const { stdout, stderr, exitCode } = await runRow("S12", "async function other(): Promise<number> { return 9; }\nasync function f(): Promise<number> { const x = await other(); return x; }\nf().then((v) => console.log(\"f\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\nf 9\no2\no3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S13 S083: control where wasm agrees with Node: a late catch fires rejectionHandled after its own reaction (the llvm and c order differs, board #180)", async () => {
  const { stdout, stderr, exitCode } = await runRow("S13", "async function bad(): Promise<number> { throw new Error(\"late\"); }\nprocess.on(\"rejectionHandled\", () => console.log(\"rejectionHandled\"));\nprocess.on(\"unhandledRejection\", (e: unknown) => console.log(\"unhandled\"));\nconst b = bad();\nsetTimeout(() => { b.catch((e: unknown) => console.log(\"late catch\")); }, 0);", "ts");
  expect(stdout).toBe("unhandled\nlate catch\nrejectionHandled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S14 S083: B-i: resolving an executor's promise with a promise", async () => {
  const { diagnostics, survey } = await refuseRow("S14", "async function other(): Promise<number> { return 9; }\nnew Promise<number>((res) => res(other())).then((v) => console.log(\"resolved-with-p\", v));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));", "ts");
  expect(diagnostics).toEqual(["SC1090:'Promise<number>' values where 'number' is expected is not supported yet"]);
});

test("S15 S083: S083 a dynamic import's module evaluates before the observer chain it races", async () => {
  // Node v24 prints "sync\no1\no2\no3\no4\nm-init\no5\nimported 7\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRowDir("S15", { "m.ts": "console.log(\"m-init\");\nexport const v = 7;", "main.ts": "// @dynamic\n// the island bridge's adoption: a dynamic import's promise settles through the bridge; an observer chain times it\nconst p = import(\"./m.ts\");\np.then((ns: any) => { console.log(`imported ${ns.v}`); });\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");" });
  expect(stdout).toBe("sync\nm-init\no1\no2\nimported 7\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S16 S083: S083 an awaited dynamic import of a module that itself awaits", async () => {
  // Node v24 prints "sync\no1\no2\no3\no4\nm-start\no5\nm-after-await\no6\nimported 8\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRowDir("S16", { "m.ts": "console.log(\"m-start\");\nawait Promise.resolve();\nconsole.log(\"m-after-await\");\nexport const v = 8;", "main.ts": "// @dynamic\n// an ASYNC imported module (it awaits during its own evaluation): the bridge adopts its evaluation promise\nasync function main(): Promise<void> {\n  const ns = await import(\"./m.ts\");\n  console.log(`imported ${ns.v}`);\n}\nmain();\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\")).then(() => console.log(\"o6\"));\nconsole.log(\"sync\");" });
  expect(stdout).toBe("sync\nm-start\no1\nm-after-await\no2\no3\no4\no5\nimported 8\no6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// S084
// ============================================================

test("VF01 S084: S084 a record field typed void is dropped: the synchronous record (pre-existing path)", async () => {
  // Node v24 prints "v ran\n1 undefined {\"a\":1} 2\n" — the registered divergence (S084).
  const { stdout, stderr, exitCode } = await runRow("VF01", "function v(): void { console.log(\"v ran\"); }\nfunction main(): void {\n  const r: { a: number; w: void } = { a: 1, w: v() };\n  console.log(r.a, r.w, JSON.stringify(r), Object.keys(r).length);\n}\nmain();", "ts");
  expect(stdout).toBe("v ran\n1 undefined {\"a\":1} 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("VF02 S084: S084 a void await filling a record field: the field is dropped", async () => {
  // Node v24 prints "v ran\n1 undefined {\"a\":1} 2\n" — the registered divergence (S084).
  const { stdout, stderr, exitCode } = await runRow("VF02", "async function v(): Promise<void> { console.log(\"v ran\"); }\nasync function main(): Promise<void> {\n  const r: { a: number; w: void } = { a: 1, w: await v() };\n  console.log(r.a, r.w, JSON.stringify(r), Object.keys(r).length);\n}\nmain();", "ts");
  expect(stdout).toBe("v ran\n1 undefined {\"a\":1} 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("VF03 S084: S084 a void await filling a record field: printed whole, then probed with in", async () => {
  // Node v24 prints "v ran\n{ a: 1, w: undefined }\ntrue\n" — the registered divergence (S084).
  const { stdout, stderr, exitCode } = await runRow("VF03", "async function v(): Promise<void> { console.log(\"v ran\"); }\nasync function main(): Promise<void> {\n  const r: { a: number; w: void } = { a: 1, w: await v() };\n  console.log(r);\n  console.log(\"w\" in r);\n}\nmain();", "ts");
  expect(stdout).toBe("v ran\n{ a: 1, w: undefined }\nfalse\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// DYNPROMISE
// ============================================================

test("D01 DYNPROMISE: a number fulfilment arrives as a dyn number", async () => {
  const { stdout, stderr, exitCode } = await runRow("D01", "'use strict';\nfunction id(v) { return v; }\nasync function n() { return 7; }\nid(n()).then((v) => console.log('f64', v, typeof v));\nPromise.resolve().then(() => console.log('obs'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nf64 7 number\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D02 DYNPROMISE: a string fulfilment", async () => {
  const { stdout, stderr, exitCode } = await runRow("D02", "'use strict';\nfunction id(v) { return v; }\nasync function s() { return 'hi'; }\nid(s()).then((v) => console.log('string', v, typeof v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nstring hi string\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D03 DYNPROMISE: a boolean fulfilment", async () => {
  const { stdout, stderr, exitCode } = await runRow("D03", "'use strict';\nfunction id(v) { return v; }\nasync function b() { return true; }\nid(b()).then((v) => console.log('bool', v, typeof v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nbool true boolean\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D04 DYNPROMISE: a void fulfilment arrives as undefined", async () => {
  const { stdout, stderr, exitCode } = await runRow("D04", "'use strict';\nfunction id(v) { return v; }\nasync function u() { console.log('u body'); }\nid(u()).then((v) => console.log('void', v, typeof v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("u body\nsync\nvoid undefined undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D05 DYNPROMISE: an array fulfilment is converted", async () => {
  const { stdout, stderr, exitCode } = await runRow("D05", "'use strict';\nfunction id(v) { return v; }\nasync function a() { return [1, 2, 3]; }\nid(a()).then((v) => console.log('array', JSON.stringify(v), Array.isArray(v)));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\narray [1,2,3] true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D06 DYNPROMISE: a record fulfilment is converted", async () => {
  const { stdout, stderr, exitCode } = await runRow("D06", "'use strict';\nfunction id(v) { return v; }\nasync function r() { return { x: 1, y: 'two' }; }\nid(r()).then((v) => console.log('record', JSON.stringify(v), v.y));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nrecord {\"x\":1,\"y\":\"two\"} two\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D07 DYNPROMISE: a union fulfilment is converted", async () => {
  const { stdout, stderr, exitCode } = await runRow("D07", "'use strict';\nfunction id(v) { return v; }\nasync function un(k) { return k > 0 ? 1 : 'neg'; }\nid(un(1)).then((v) => console.log('union', v, typeof v));\nid(un(-1)).then((v) => console.log('union', v, typeof v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nunion 1 number\nunion neg string\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D08 DYNPROMISE: boxed while pending, converted when it settles later", async () => {
  const { stdout, stderr, exitCode } = await runRow("D08", "'use strict';\nfunction id(v) { return v; }\nasync function g() { return 1; }\nasync function later() { await g(); await g(); return 42; }\nconst boxed = id(later());\nboxed.then((v) => console.log('later', v));\nPromise.resolve().then(() => console.log('obs1')).then(() => console.log('obs2')).then(() => console.log('obs3'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nobs1\nobs2\nlater 42\nobs3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D09 DYNPROMISE: a rejected typed promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("D09", "'use strict';\nfunction id(v) { return v; }\nasync function bad() { throw new Error('nope'); }\nid(bad()).then((v) => console.log('unreachable', v), (e) => console.log('rejected', e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nrejected nope\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D10 DYNPROMISE: two crossings of one promise are one value", async () => {
  const { stdout, stderr, exitCode } = await runRow("D10", "'use strict';\nfunction id(v) { return v; }\nasync function n() { return 1; }\nconst p = n();\nconst a = id(p); const b = id(p);\nconsole.log('same crossing', id(a) === id(a), 'two crossings', a === b);", "cjs");
  expect(stdout).toBe("same crossing true two crossings true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D11 DYNPROMISE: identity through a linked crossing", async () => {
  const { stdout, stderr, exitCode } = await runRow("D11", "'use strict';\nfunction id(v) { return v; }\nasync function n() { return 1; }\nconst p = n();\nconst a = id(p); const b = id(p);\nconsole.log('same crossing', id(a) === id(a), 'two crossings', a === b);\na.then((v) => console.log('a', v));", "cjs");
  expect(stdout).toBe("same crossing true two crossings true\na 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D12 DYNPROMISE: identity across many promises", async () => {
  const { stdout, stderr, exitCode } = await runRow("D12", "'use strict';\nfunction id(v) { return v; }\nasync function n(k) { return k; }\nconst boxes = [];\nfor (let i = 0; i < 1000; i++) { const p = n(i); boxes.push(id(p) === id(p)); }\nconsole.log('all same', boxes.every((x) => x));", "cjs");
  expect(stdout).toBe("all same true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D13 DYNPROMISE: identity with a typed await interleaved", async () => {
  const { stdout, stderr, exitCode } = await runRow("D13", "'use strict';\n// identity across crossings, and a typed await of the same promise interleaved with a dyn then\nfunction id(v) { return v; }\nasync function n() { return 11; }\nconst p = n();\nconst a = id(p); const b = id(p);\nconsole.log('a===b', a === b, 'id(a)===a', id(a) === a);\nasync function waiter() { const v = await p; console.log('typed await', v); }\na.then((v) => console.log('dyn then', v));\nwaiter();\nb.then((v) => console.log('dyn then 2', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("a===b true id(a)===a true\nsync\ndyn then 11\ntyped await 11\ndyn then 2 11\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D14 DYNPROMISE: a dyn promise already dyn", async () => {
  const { stdout, stderr, exitCode } = await runRow("D14", "'use strict';\nfunction id(v) { return v; }\nasync function dynret(x) { return x; }\nid(dynret(3)).then((v) => console.log('dyn inner', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ndyn inner 3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D15 DYNPROMISE: one array object across two reactions", async () => {
  const { stdout, stderr, exitCode } = await runRow("D15", "'use strict';\nfunction id(v) { return v; }\nasync function a() { return [1, 2]; }\nconst b = id(a());\nlet first = null;\nb.then((v) => { first = v; });\nb.then((v) => { console.log('same object', v === first); v.push(3); });\nb.then((v) => { console.log('sees push', v.length); });", "cjs");
  expect(stdout).toBe("same object true\nsees push 3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D16 DYNPROMISE: one record object across two reactions", async () => {
  const { stdout, stderr, exitCode } = await runRow("D16", "'use strict';\nfunction id(v) { return v; }\nasync function r() { return { n: 1 }; }\nconst b = id(r());\nb.then((v) => { v.n = 2; });\nb.then((v) => { console.log('n', v.n); });", "cjs");
  expect(stdout).toBe("n 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D17 DYNPROMISE: one Error across two catches", async () => {
  const { stdout, stderr, exitCode } = await runRow("D17", "'use strict';\nfunction id(v) { return v; }\nasync function bad() { throw new Error('same'); }\nconst b = id(bad());\nlet first = null;\nb.catch((e) => { first = e; });\nb.catch((e) => { console.log('same error', e === first, e.message); });", "cjs");
  expect(stdout).toBe("same error true same\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D18 DYNPROMISE: typed and dyn reactions on one promise keep one order", async () => {
  const { stdout, stderr, exitCode } = await runRow("D18", "'use strict';\nfunction id(v) { return v; }\nasync function n() { return 7; }\nconst p = n();\nconst b = id(p);\nb.then((v) => console.log('dyn', v));\np.then((v) => console.log('typed', v));\nb.then((v) => console.log('dyn2', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ndyn 7\ntyped 7\ndyn2 7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D19 DYNPROMISE: NOT-LIFTED: an Error-class fulfilment keeps refusing", async () => {
  const { diagnostics, survey } = await refuseRow("D19", "'use strict';\n// a promise whose fulfilment is an Error object, crossing into dyn, plus a string and a bool inner\nfunction id(v) { return v; }\nasync function e() { return new Error('as value'); }\nasync function s() { return 'str'; }\nasync function b() { return false; }\nid(e()).then((v) => console.log('err', v instanceof Error, v.message));\nid(s()).then((v) => console.log('str', v, typeof v));\nid(b()).then((v) => console.log('bool', v, typeof v));\nconsole.log('sync');", "cjs");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (dynFrom:promise:adapt); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["dynFrom:promise:adapt"]);
});

test("D20 DYNPROMISE: NOT-LIFTED: a byte-array fulfilment keeps refusing", async () => {
  const { diagnostics, survey } = await refuseRow("D20", "'use strict';\nfunction id(v) { return v; }\nasync function f() { return new Uint8Array([1, 2]); }\nid(f()).then((v) => console.log('bytes', v.length));\nconsole.log('sync');", "cjs");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (dynFrom:promise:adapt); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["dynFrom:promise:adapt"]);
});

test("D21 DYNPROMISE: NOT-LIFTED: a function fulfilment keeps refusing", async () => {
  const { diagnostics, survey } = await refuseRow("D21", "'use strict';\nfunction id(v) { return v; }\nasync function f() { return () => 3; }\nid(f()).then((v) => console.log('fn', v()));\nconsole.log('sync');", "cjs");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (dynFrom:promise:adapt); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["dynFrom:promise:adapt"]);
});

test("D22 DYNPROMISE: NOT-LIFTED: a dyn promise awaited into a typed slot", async () => {
  const { diagnostics, survey } = await refuseRow("D22", "'use strict';\nfunction id(v) { return v; }\nasync function n() { return 1; }\nasync function waitIt(q) { return await q; }\nconst p = n();\nconst d = id(p);\nwaitIt(d).then((v) => console.log('awaited dyn', v, id(p) === d));", "cjs");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (fn:async:await-dyn); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["fn:async", "fn:async:await-dyn", "libCall:async.awaitDyn"]);
});

test("D23 DYNPROMISE: NOT-LIFTED: a class-instance fulfilment is the deferred conversion fence", async () => {
  // Node v24 prints "sync\nclass 3 true\n" and exits 0; this tier traps.
  const { stdout, stderr } = await runRowTrap("D23", "'use strict';\nclass P { constructor() { this.x = 3; } get() { return this.x; } }\nfunction id(v) { return v; }\nasync function mk() { return new P(); }\nid(mk()).then((v) => console.log('class', v.x, v instanceof P));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting typed values to 'unknown' is not supported yet [SC1101 at <ROW>:5]\n");
});

test("D24 DYNPROMISE: console.log of a boxed promise is the named inspect fence", async () => {
  // Node v24 prints "before\nPromise { 1 }\nafter\n" and exits 0; this tier traps.
  const { stdout, stderr } = await runRowTrap("D24", "'use strict';\nfunction id(v) { return v; }\nasync function g() { return 1; }\nconsole.log('before');\nconsole.log(id(g()));\nconsole.log('after');", "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: util.inspect of a promise value is not supported yet\n");
});

test("D25 DYNPROMISE: NOT-LIFTED: a module mixing a typed same-type Promise.race with a converting dyn bridge", async () => {
  const { diagnostics, survey } = await refuseRow("D25", "// @dynamic\nasync function n(): Promise<number> { return 7; }\nasync function k(): Promise<number> { return 8; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> {\n  const v = await x;\n  const w = await Promise.race([n(), k()]);\n  console.log(`${v} ${w}`);\n}\nmain();", "ts");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (dynFrom:promise:race-copy); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["dynFrom:promise:race-copy"]);
});

// ============================================================
// REACTION
// ============================================================

test("R01 REACTION: then with both handlers", async () => {
  const { stdout, stderr, exitCode } = await runRow("R01", "'use strict';\nfunction id(v) { return v; }\nasync function bad() { throw new Error('r'); }\nasync function good() { return 1; }\nid(good()).then((v) => console.log('ok', v), (e) => console.log('never', e));\nid(bad()).then((v) => console.log('never', v), (e) => console.log('onR', e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nok 1\nonR r\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R02 REACTION: then with no arguments passes the value through", async () => {
  const { stdout, stderr, exitCode } = await runRow("R02", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nid(good()).then().then((v) => console.log('passthrough', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\npassthrough 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R03 REACTION: a non-function handler is ignored", async () => {
  const { stdout, stderr, exitCode } = await runRow("R03", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nid(good()).then(1, 'x').then((v) => console.log('ignored non-fn', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nignored non-fn 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R04 REACTION: a handler that throws rejects the derived promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("R04", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nid(good()).then(() => { throw new Error('in handler'); }).catch((e) => console.log('caught', e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ncaught in handler\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R05 REACTION: a finally handler that throws", async () => {
  const { stdout, stderr, exitCode } = await runRow("R05", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nid(good()).finally(() => { throw new Error('fin'); }).then((v) => console.log('never', v), (e) => console.log('fin overrides', e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nfin overrides fin\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R06 REACTION: a finally handler's return value is ignored", async () => {
  const { stdout, stderr, exitCode } = await runRow("R06", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nid(good()).finally(() => 99).then((v) => console.log('finally keeps', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nfinally keeps 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R07 REACTION: catch on a fulfilled promise passes the value through", async () => {
  const { stdout, stderr, exitCode } = await runRow("R07", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nid(good()).catch(() => console.log('never')).then((v) => console.log('passes', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\npasses 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R08 REACTION: dyn and typed reactions against a microtask observer", async () => {
  const { stdout, stderr, exitCode } = await runRow("R08", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 1; }\nconst p = good();\nid(p).then(() => console.log('dyn then'));\np.then(() => console.log('typed then'));\nPromise.resolve().then(() => console.log('obs'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ndyn then\ntyped then\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R09 REACTION: an unhandledRejection listener sees a rejection through a dyn chain", async () => {
  const { stdout, stderr, exitCode } = await runRow("R09", "'use strict';\nfunction id(v) { return v; }\nasync function bad() { throw new Error('u'); }\nprocess.on('unhandledRejection', (e) => console.log('unhandled', e.message));\nid(bad()).then((v) => console.log('never', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nunhandled u\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R10 REACTION: then with two handlers on a rejection", async () => {
  const { stdout, stderr, exitCode } = await runRow("R10", "'use strict';\n// then(onF, onR) on a rejected dyn promise, handler values, a non-function onR, catch with no handler\nfunction id(v) { return v; }\nasync function bad() { throw new Error('r1'); }\nasync function good() { return 'ok'; }\nid(bad()).then((v) => console.log('no', v), (e) => { console.log('onR', e.message); return 'rv'; }).then((v) => console.log('next', v));\nid(bad()).then(undefined, 7).catch((e) => console.log('passed', e.message));\nid(good()).catch().then((v) => console.log('catch-none', v));\nid(good()).finally().then((v) => console.log('finally-none', v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nonR r1\nnext rv\npassed r1\ncatch-none ok\nfinally-none ok\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R11 REACTION: finally's microtask count", async () => {
  const { stdout, stderr, exitCode } = await runRow("R11", "'use strict';\n// .finally on a dyn promise: the derived promise settles after the finally reaction's own extra jobs\nfunction id(v) { return v; }\nasync function n() { return 3; }\nid(n()).finally(() => console.log('fin')).then((v) => console.log('after', v));\nid(n()).then((v) => console.log('then', v));\nPromise.resolve().then(() => console.log('o1')).then(() => console.log('o2')).then(() => console.log('o3')).then(() => console.log('o4')).then(() => console.log('o5'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nfin\nthen 3\no1\no2\no3\nafter 3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R12 REACTION: catch only", async () => {
  const { stdout, stderr, exitCode } = await runRow("R12", "'use strict';\nfunction id(v) { return v; }\nasync function bad() { throw new Error('c'); }\nid(bad()).catch((e) => console.log('catch', e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ncatch c\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R13 REACTION: finally only", async () => {
  const { stdout, stderr, exitCode } = await runRow("R13", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 1; }\nid(good()).finally(() => console.log('finally'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nfinally\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R14 REACTION: order in an ES module", async () => {
  const { stdout, stderr, exitCode } = await runRow("R14", "function id(v) { return v; }\nasync function good() { return 1; }\nid(good()).then(() => console.log('dyn then'));\nprocess.nextTick(() => console.log('tick'));\nqueueMicrotask(() => console.log('micro'));\nconsole.log('sync');", "mjs");
  expect(stdout).toBe("sync\ndyn then\nmicro\ntick\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R15 REACTION: a finally chain in an ES module", async () => {
  const { stdout, stderr, exitCode } = await runRow("R15", "function id(v) { return v; }\nasync function bad() { throw new Error('boom'); }\nid(bad()).then(() => console.log('x')).catch((e) => { console.log('caught', e.message); return 'rec'; }).finally(() => console.log('fin')).then((v) => console.log('after', v));\nqueueMicrotask(() => console.log('m1'));\nconsole.log('sync');", "mjs");
  expect(stdout).toBe("sync\nm1\ncaught boom\nfin\nafter rec\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R16 REACTION: nextTick against queueMicrotask in an ES module", async () => {
  const { stdout, stderr, exitCode } = await runRow("R16", "// an ESM source: a dyn .then chain against queueMicrotask and process.nextTick observers\nfunction id(v) { return v; }\nasync function n() { return 1; }\nid(n()).then((v) => { console.log('then', v); return v + 1; }).then((v) => console.log('then2', v));\nqueueMicrotask(() => console.log('qm'));\nprocess.nextTick(() => console.log('tick'));\nPromise.resolve().then(() => console.log('o1')).then(() => console.log('o2'));\nconsole.log('sync');", "mjs");
  expect(stdout).toBe("sync\nthen 1\nqm\no1\nthen2 2\no2\ntick\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R17 REACTION: typed and dyn reactions alternating on a pending promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("R17", "'use strict';\n// typed and dyn reactions subscribed ALTERNATELY to one PENDING typed promise: Node runs them in subscription order\nfunction id(v) { return v; }\nasync function g() { return 1; }\nasync function later() { await g(); return 5; }\nconst p = later();\nconst d = id(p);\nd.then((v) => console.log('dyn A', v));\np.then(() => console.log('typed B'));\nd.then((v) => console.log('dyn C', v));\np.then(() => console.log('typed D'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ndyn A 5\ntyped B\ndyn C 5\ntyped D\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R18 REACTION: a promise resolved with itself rejects with the chaining-cycle TypeError", async () => {
  const { stdout, stderr, exitCode } = await runRow("R18", "'use strict';\n// a dyn handler returns its own derived promise (a chaining cycle): the derived promise rejects with a TypeError\nfunction id(v) { return v; }\nasync function g() { return 1; }\nconst d = id(g()).then(() => d);\nd.catch((e) => console.log('cycle', e.name, e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ncycle TypeError Chaining cycle detected for promise #<Promise>\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R19 REACTION: a dyn handler's throw nobody handles", async () => {
  // Node v24 prints "sync\n" and exits 1; this tier traps.
  const { stdout, stderr } = await runRowTrap("R19", "'use strict';\n// a dyn chain whose last derived promise rejects with no handler: the unhandled-rejection report\nfunction id(v) { return v; }\nasync function g() { return 1; }\nid(g()).then(() => { throw new Error('dyn chain'); });\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: dyn chain\n");
});

test("R20 REACTION: a late catch against rejectionHandled", async () => {
  const { stdout, stderr, exitCode } = await runRow("R20", "'use strict';\nfunction id(v) { return v; }\nasync function bad() { throw new Error('late'); }\nprocess.on('rejectionHandled', () => console.log('rejectionHandled'));\nprocess.on('unhandledRejection', (e) => console.log('unhandled', e.message));\nconst b = id(bad());\nsetTimeout(() => { b.catch((e) => console.log('late catch', e.message)); }, 0);", "cjs");
  expect(stdout).toBe("unhandled late\nlate catch late\nrejectionHandled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R21 REACTION: a handler returning a non-promise thenable is a named run-time refusal", async () => {
  // Node v24 prints "sync\nthenable.then called\ngot 42\n" — this tier rejects with a named run-time refusal (adopting a non-promise thenable is not built).
  const { stdout, stderr, exitCode } = await runRow("R21", "'use strict';\nfunction id(v) { return v; }\nasync function g() { return 1; }\nconst thenFn = function (res) { console.log('thenable.then called'); res(42); };\nconst thenable = { then: thenFn };\nid(g()).then(() => thenable).then((v) => console.log('got', v), (e) => console.log('rejected', String(e)));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nrejected Error: adopting a non-promise thenable returned from a promise reaction is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R22 REACTION: a finally handler receives no argument", async () => {
  const { stdout, stderr, exitCode } = await runRow("R22", "'use strict';\nfunction id(v) { return v; }\nasync function g() { return 5; }\nid(g()).finally((x) => console.log('finally arg', typeof x)).then((v) => console.log('then', v));\nPromise.resolve().then(() => console.log('obs1')).then(() => console.log('obs2')).then(() => console.log('obs3'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nfinally arg undefined\nobs1\nobs2\nobs3\nthen 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// NONPROMISE
// ============================================================

test("N01 NONPROMISE: an object's own then member is called", async () => {
  const { stdout, stderr, exitCode } = await runRow("N01", "'use strict';\nfunction id(v) { return v; }\nconst thenFn = function (a) { console.log('own then called'); return 'r'; };\nconst obj = id({ then: thenFn });\nconsole.log('ret', obj.then(() => {}));", "cjs");
  expect(stdout).toBe("own then called\nret r\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("N02 NONPROMISE: a number receiver", async () => {
  const { stdout, stderr, exitCode } = await runRow("N02", "'use strict';\nfunction id(v) { return v; }\nconst x = id(5);\ntry { x.then(() => {}); } catch (e) { console.log('caught', e instanceof TypeError, e.message); }", "cjs");
  expect(stdout).toBe("caught true x.then is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("N03 NONPROMISE: a plain object without catch", async () => {
  const { stdout, stderr, exitCode } = await runRow("N03", "'use strict';\nfunction id(v) { return v; }\nconst o = id({ a: 1 });\ntry { o.catch(() => {}); } catch (e) { console.log('caught', e instanceof TypeError, e.message); }", "cjs");
  expect(stdout).toBe("caught true o.catch is not a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("N04 NONPROMISE: a null receiver", async () => {
  const { stdout, stderr, exitCode } = await runRow("N04", "'use strict';\nfunction id(v) { return v; }\nconst z = id(null);\ntry { z.finally(() => {}); } catch (e) { console.log('caught', e instanceof TypeError, e.message); }", "cjs");
  expect(stdout).toBe("caught true Cannot read properties of null (reading 'finally')\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// ADOPT
// ============================================================

test("A01 ADOPT: a handler returns a promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("A01", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nasync function other() { return 9; }\nid(good()).then(() => other()).then((v) => console.log('adopted', v));\nPromise.resolve().then(() => console.log('o1')).then(() => console.log('o2')).then(() => console.log('o3')).then(() => console.log('o4'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\no1\no2\no3\nadopted 9\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A02 ADOPT: adoption order against a second observer chain", async () => {
  const { stdout, stderr, exitCode } = await runRow("A02", "'use strict';\nfunction id(v) { return v; }\nasync function good() { return 5; }\nasync function other() { return 9; }\nid(good()).then(() => other()).then((v) => console.log('adopted', v));\nPromise.resolve().then(() => console.log('o1')).then(() => console.log('o2')).then(() => console.log('o3')).then(() => console.log('o4'));", "cjs");
  expect(stdout).toBe("o1\no2\no3\nadopted 9\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A03 ADOPT: a handler returns a pending promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("A03", "'use strict';\n// a dyn handler returns a PENDING promise: the derived promise waits for it, then two more jobs\nfunction id(v) { return v; }\nasync function g() { return 1; }\nasync function slow() { await g(); await g(); return 9; }\nid(g()).then(() => slow()).then((v) => console.log('adopted', v));\nPromise.resolve().then(() => console.log('o1')).then(() => console.log('o2')).then(() => console.log('o3')).then(() => console.log('o4')).then(() => console.log('o5')).then(() => console.log('o6'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\no1\no2\no3\no4\nadopted 9\no5\no6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A04 ADOPT: a handler returns a rejected promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("A04", "'use strict';\n// a dyn handler returns a REJECTED promise (rejected thenable adoption) and a nested adoption\nfunction id(v) { return v; }\nasync function g() { return 1; }\nasync function bad() { throw new Error('inner'); }\nasync function nested() { return 4; }\nid(g()).then(() => bad()).catch((e) => console.log('caught', e.message));\nid(g()).then(() => id(g()).then(() => nested())).then((v) => console.log('nested', v));\nPromise.resolve().then(() => console.log('o1')).then(() => console.log('o2')).then(() => console.log('o3')).then(() => console.log('o4')).then(() => console.log('o5')).then(() => console.log('o6'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\no1\no2\no3\ncaught inner\no4\no5\nnested 4\no6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A05 ADOPT: a finally handler returns a promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("A05", "'use strict';\n// a dyn .finally handler returning a promise (Node waits for it; a rejected one overrides)\nfunction id(v) { return v; }\nasync function g() { return 1; }\nasync function slow() { await g(); await g(); console.log('slow done'); }\nasync function bad() { throw new Error('fin-bad'); }\nid(g()).finally(() => slow()).then((v) => console.log('kept', v));\nid(g()).finally(() => bad()).catch((e) => console.log('overridden', e.message));\nPromise.resolve().then(() => console.log('o1')).then(() => console.log('o2')).then(() => console.log('o3')).then(() => console.log('o4')).then(() => console.log('o5')).then(() => console.log('o6'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\no1\no2\nslow done\no3\noverridden fin-bad\no4\no5\nkept 1\no6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// VOIDWIDEN
// ============================================================

test("W01 VOIDWIDEN: the widened promise now reaches its next refusal", async () => {
  const { diagnostics, survey } = await refuseRow("W01", "'use strict';\nfunction wait() { return new Promise(setImmediate); }\nasync function main() { await wait(); console.log('waited'); }\nmain();\nconsole.log('sync');", "cjs");
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (libCall:timers.immediatePromise); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["libCall:timers.immediatePromise"]);
});

// ============================================================
// ISLAND
// ============================================================

test("Z01 ISLAND: a typed number promise through an island then", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z01", "// @dynamic\nasync function n(): Promise<number> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nx.then((v: any) => console.log(`island then ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nisland then 7 number\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z02 ISLAND: a typed string promise through an island then", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z02", "// @dynamic\nasync function n(): Promise<string> { return \"seven\"; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nx.then((v: any) => console.log(`island then ${v} ${typeof v} ${v.length}`));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nisland then seven string 5\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z03 ISLAND: a typed record promise through an island then", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z03", "// @dynamic\nasync function n(): Promise<{ a: number; b: string }> { return { a: 1, b: \"two\" }; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nx.then((v: any) => console.log(`island then ${v.a} ${v.b} ${JSON.stringify(v)}`));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nisland then 1 two {\"a\":1,\"b\":\"two\"}\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z04 ISLAND: a rejected typed promise through an island then reaches the unhandled-rejection report", async () => {
  // Node v24 prints "sync\nobs\n" and exits 1; this tier traps.
  const { stdout, stderr } = await runRowTrap("Z04", "// @dynamic\nasync function n(): Promise<number> { throw new Error(\"boom\"); }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nx.then((v: any) => console.log(`island then ${v}`));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: boom\n");
});

test("Z05 ISLAND: S083 await of an any-held typed number promise resumes one job late (board #184)", async () => {
  // Node v24 prints "sync\nawait any 7 number\nobs\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("Z05", "// @dynamic\nasync function n(): Promise<number> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> { const v = await x; console.log(`await any ${v} ${typeof v}`); }\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs\nawait any 7 number\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z06 ISLAND: S083 await of an any-held typed string promise (board #184)", async () => {
  // Node v24 prints "sync\nawait any seven string 5\nobs\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("Z06", "// @dynamic\nasync function n(): Promise<string> { return \"seven\"; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> { const v = await x; console.log(`await any ${v} ${typeof v} ${v.length}`); }\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs\nawait any seven string 5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z07 ISLAND: S083 await of an any-held typed record promise (board #184)", async () => {
  // Node v24 prints "sync\nawait any 1 two {\"a\":1,\"b\":\"two\"}\nobs\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("Z07", "// @dynamic\nasync function n(): Promise<{ a: number; b: string }> { return { a: 1, b: \"two\" }; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> { const v = await x; console.log(`await any ${v.a} ${v.b} ${JSON.stringify(v)}`); }\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs\nawait any 1 two {\"a\":1,\"b\":\"two\"}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z08 ISLAND: S083 await of an any-held rejected typed promise (board #184)", async () => {
  // Node v24 prints "sync\ncaught Error: boom\nobs\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("Z08", "// @dynamic\nasync function n(): Promise<number> { throw new Error(\"boom\"); }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> { try { await x; console.log(\"not reached\"); } catch (e) { console.log(`caught ${String(e)}`); } }\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs\ncaught Error: boom\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z09 ISLAND: S083 an island then handler returns a typed number promise (board #182)", async () => {
  // Node v24 prints "sync\nobs1\nobs2\nobs3\nadopted 7 number\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("Z09", "// @dynamic\nasync function n(): Promise<unknown> { return 1; }\nasync function m(): Promise<number> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nconst y: any = id(m());\nx.then(() => y).then((v: any) => console.log(`adopted ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"obs1\")).then(() => console.log(\"obs2\")).then(() => console.log(\"obs3\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs1\nobs2\nadopted 7 number\nobs3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z09b ISLAND: S083 an island then handler returns a typed record promise (board #182)", async () => {
  // Node v24 prints "sync\nobs1\nobs2\nobs3\nadopted 1 two {\"a\":1,\"b\":\"two\"}\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("Z09b", "// @dynamic\nasync function n(): Promise<unknown> { return 1; }\nasync function m(): Promise<{ a: number; b: string }> { return { a: 1, b: \"two\" }; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nconst y: any = id(m());\nx.then(() => y).then((v: any) => console.log(`adopted ${v.a} ${v.b} ${JSON.stringify(v)}`));\nPromise.resolve().then(() => console.log(\"obs1\")).then(() => console.log(\"obs2\")).then(() => console.log(\"obs3\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs1\nobs2\nadopted 1 two {\"a\":1,\"b\":\"two\"}\nobs3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z11 ISLAND: a boxed function value returning a typed promise, then on its call", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z11", "// @dynamic\nasync function f(): Promise<number> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst g = (): Promise<number> => f();\nconst x: any = id(g);\nx().then((v: any) => console.log(`fn then ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nfn then 7 number\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z12 ISLAND: control: the typed rejected then on the typed path reaches the same report", async () => {
  // Node v24 prints "sync\nobs\n" and exits 1; this tier traps.
  const { stdout, stderr } = await runRowTrap("Z12", "async function n(): Promise<number> { throw new Error(\"boom\"); }\nn().then((v) => console.log(`typed then ${v}`));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: boom\n");
});

test("Z13 ISLAND: control: a dyn promise through an island then", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z13", "// @dynamic\nasync function n(): Promise<unknown> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst b = id(n());\nconst x: any = b;\nx.then((v: any) => console.log(`island then ${v}`));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nisland then 7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z14 ISLAND: control: a dyn promise awaited as any", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z14", "// @dynamic\nasync function n(): Promise<unknown> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> { const v = await x; console.log(`await any ${v}`); }\nmain();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nawait any 7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z15 ISLAND: control: a rejected dyn promise awaited as any", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z15", "// @dynamic\nasync function n(): Promise<unknown> { throw new Error(\"boom\"); }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> { try { await x; } catch (e) { console.log(`caught ${String(e)}`); } }\nmain();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\ncaught Error: boom\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z16 ISLAND: control: a boxed function value returning a dyn promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("Z16", "// @dynamic\nasync function f(): Promise<unknown> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst g = (): Promise<unknown> => f();\nconst x: any = id(g);\nx().then((v: any) => console.log(`fn then ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nfn then 7 number\nobs\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Z17 ISLAND: catch directly on an any-held rejected typed promise is not a function (board #177)", async () => {
  // Node v24 prints "sync\ncaught Error: boom\n" and exits 0; this tier traps.
  const { stdout, stderr } = await runRowTrap("Z17", "// @dynamic\nasync function f(): Promise<number> { throw new Error(\"boom\"); }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(f());\nx.catch((e: any) => console.log(`caught ${e}`));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught TypeError: catch is not a function\n");
});

test("ISL01 ISLAND: S083 an island then handler returns a dyn promise: adopted one job early (board #182)", async () => {
  // Node v24 prints "sync\nobs1\nobs2\nobs3\nadopted 7 number\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("ISL01", "// @dynamic\nasync function n(): Promise<unknown> { return 1; }\nasync function m(): Promise<unknown> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nconst y: any = id(m());\nx.then(() => y).then((v: any) => console.log(`adopted ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"obs1\")).then(() => console.log(\"obs2\")).then(() => console.log(\"obs3\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs1\nobs2\nadopted 7 number\nobs3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("ISL02 ISLAND: S083 await of an any-held dyn promise resumes one job late (board #184)", async () => {
  // Node v24 prints "sync\nawait any 7 number\nobs\n" — the registered divergence (S083).
  const { stdout, stderr, exitCode } = await runRow("ISL02", "// @dynamic\nasync function n(): Promise<unknown> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nasync function main(): Promise<void> { const v = await x; console.log(`await any ${v} ${typeof v}`); }\nmain();\nPromise.resolve().then(() => console.log(\"obs\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nobs\nawait any 7 number\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// ONCE
// ============================================================

test("O01 ONCE: a once and an on listener across two rejections, with a rejectionHandled listener", async () => {
  const { stdout, stderr, exitCode } = await runRow("O01", "'use strict';\n\nprocess.once('unhandledRejection', (err) => {\n  console.log('once:', err.message);\n});\n\nprocess.on('unhandledRejection', (err, promise) => {\n  console.log('on:', err.message);\n});\n\nprocess.on('rejectionHandled', (promise) => {\n  console.log('rejectionHandled:', typeof promise === 'object');\n});\n\nPromise.reject(new Error('first'));\nPromise.reject(new Error('last'));\nconsole.log('sync tail');", "cjs");
  expect(stdout).toBe("sync tail\nonce: first\non: first\non: last\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O02 ONCE: a once and an on listener across two rejections", async () => {
  const { stdout, stderr, exitCode } = await runRow("O02", "'use strict';\nprocess.once('unhandledRejection', (err) => { console.log('once:', err.message); });\nprocess.on('unhandledRejection', (err) => { console.log('on:', err.message); });\nPromise.reject(new Error('a'));\nPromise.reject(new Error('b'));\nPromise.resolve().then(() => console.log('obs'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nobs\nonce: a\non: a\non: b\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O03 ONCE: a once registered by a listener waits for the next rejection", async () => {
  const { stdout, stderr, exitCode } = await runRow("O03", "'use strict';\nlet armed = false;\nprocess.on('unhandledRejection', (err) => {\n  console.log('on:', err.message);\n  if (!armed) {\n    armed = true;\n    process.once('unhandledRejection', (e) => { console.log('late once:', e.message); });\n  }\n});\nPromise.reject(new Error('first'));\nsetTimeout(() => { Promise.reject(new Error('second')); }, 0);\nsetTimeout(() => { Promise.reject(new Error('third')); }, 5);\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\non: first\non: second\nlate once: second\non: third\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O04 ONCE: a once listener re-registering itself", async () => {
  const { stdout, stderr, exitCode } = await runRow("O04", "'use strict';\nlet n = 0;\nfunction h(err) {\n  n++;\n  console.log('once', n, err.message);\n  if (n < 2) process.once('unhandledRejection', h);\n}\nprocess.once('unhandledRejection', h);\nprocess.on('unhandledRejection', (err) => { console.log('on:', err.message); });\nPromise.reject(new Error('r1'));\nPromise.reject(new Error('r2'));\nPromise.reject(new Error('r3'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nonce 1 r1\non: r1\non: r2\nonce 2 r2\non: r3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O05 ONCE: rejectionHandled: a once and an on listener across two late catches", async () => {
  const { stdout, stderr, exitCode } = await runRow("O05", "'use strict';\nprocess.on('unhandledRejection', (err) => { console.log('unhandled:', err.message); });\nprocess.once('rejectionHandled', () => { console.log('once handled'); });\nprocess.on('rejectionHandled', () => { console.log('on handled'); });\nconst a = Promise.reject(new Error('a'));\nconst b = Promise.reject(new Error('b'));\nsetTimeout(() => {\n  a.catch(() => { console.log('caught a'); });\n  setTimeout(() => {\n    b.catch(() => { console.log('caught b'); });\n  }, 5);\n}, 5);\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nunhandled: a\nunhandled: b\ncaught a\nonce handled\non handled\ncaught b\non handled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O06 ONCE: rejectionHandled: a once and an on listener, both catches in one turn", async () => {
  const { stdout, stderr, exitCode } = await runRow("O06", "'use strict';\nprocess.on('unhandledRejection', () => {});\nprocess.once('rejectionHandled', () => { console.log('once handled'); });\nprocess.on('rejectionHandled', () => { console.log('on handled'); });\nconst a = Promise.reject(new Error('a'));\nconst b = Promise.reject(new Error('b'));\nsetTimeout(() => {\n  a.catch(() => {});\n  b.catch(() => {});\n  Promise.resolve().then(() => console.log('obs'));\n}, 5);\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nobs\nonce handled\non handled\non handled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O07 ONCE: rejectionHandled: a once listener re-registering itself", async () => {
  const { stdout, stderr, exitCode } = await runRow("O07", "'use strict';\nlet n = 0;\nfunction h() {\n  n++;\n  console.log('once handled', n);\n  if (n < 2) process.once('rejectionHandled', h);\n}\nprocess.on('unhandledRejection', () => {});\nprocess.once('rejectionHandled', h);\nprocess.on('rejectionHandled', () => { console.log('on handled'); });\nconst a = Promise.reject(new Error('a'));\nconst b = Promise.reject(new Error('b'));\nconst c = Promise.reject(new Error('c'));\nsetTimeout(() => { a.catch(() => {}); b.catch(() => {}); c.catch(() => {}); }, 5);\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nonce handled 1\non handled\non handled\nonce handled 2\non handled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// RESOLVE
// ============================================================

test("T01 RESOLVE: an async function returning an any that holds a typed promise is a named run-time refusal (board #176)", async () => {
  // Node v24 prints "sync\nobs1\nobs2\nasync-return any 7 number\nobs3\n" and exits 0; this tier traps.
  const { stdout, stderr } = await runRowTrap("T01", "// @dynamic\nasync function f(): Promise<number> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nasync function g(): Promise<any> { const x: any = id(f()); return x; }\ng().then((v: any) => console.log(`async-return any ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"obs1\")).then(() => console.log(\"obs2\")).then(() => console.log(\"obs3\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: resolving a promise with a dyn promise value is not supported yet\n");
});

test("T02 RESOLVE: Promise.resolve of an any that holds a typed promise is a named run-time refusal (board #176)", async () => {
  // Node v24 prints "sync\nresolve any 7\n" and exits 0; this tier traps.
  const { stdout, stderr } = await runRowTrap("T02", "// @dynamic\nasync function n(): Promise<number> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nPromise.resolve(x).then((v) => console.log(`resolve any ${v}`));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: resolving a promise with a dyn promise value is not supported yet\n");
});

test("T03 RESOLVE: control: the same module shapes with a non-promise any", async () => {
  const { stdout, stderr, exitCode } = await runRow("T03", "// @dynamic\nasync function f(): Promise<number> { return 7; }\nfunction id(v: unknown): unknown { return v; }\nconst boxed: any = id(f());\nasync function g(): Promise<any> { const x: any = id(5); return x; }\ng().then((v: any) => console.log(`async-return any ${v} ${typeof v}`));\nboxed.then((v: any) => console.log(`boxed ${v}`));\nconst y: any = id(6);\nPromise.resolve(y).then((v: any) => console.log(`resolve any ${v}`));\nPromise.resolve().then(() => console.log(\"obs1\")).then(() => console.log(\"obs2\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nasync-return any 5 number\nboxed 7\nresolve any 6\nobs1\nobs2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T04 RESOLVE: a second resolve of an already-resolved promise is ignored, not refused", async () => {
  const { stdout, stderr, exitCode } = await runRow("T04", "'use strict';\nfunction id(v) { return v; }\nasync function g() { return 7; }\nid(g()).then((v) => console.log('trio', v));\nnew Promise((res) => { res(1); res(g()); }).then((v) => console.log('np', v, typeof v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ntrio 7\nnp 1 number\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("T05 RESOLVE: a resolve after a reject is ignored, not refused", async () => {
  const { stdout, stderr, exitCode } = await runRow("T05", "'use strict';\nfunction id(v) { return v; }\nasync function g() { return 7; }\nid(g()).then((v) => console.log('trio', v));\nnew Promise((res, rej) => { rej(new Error('first')); res(g()); }).catch((e) => console.log('caught', e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\ntrio 7\ncaught first\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// ONCE
// ============================================================

test("O08 ONCE: an on listener removing itself before a once listener", async () => {
  const { stdout, stderr, exitCode } = await runRow("O08", "'use strict';\nfunction a(err) { console.log('a', err.message); process.removeListener('unhandledRejection', a); }\nprocess.on('unhandledRejection', a);\nprocess.once('unhandledRejection', (err) => { console.log('once', err.message); });\nprocess.on('unhandledRejection', (err) => { console.log('on', err.message); });\nPromise.reject(new Error('r1'));\nPromise.reject(new Error('r2'));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\na r1\nonce r1\non r1\non r2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O09 ONCE: rejectionHandled: an on listener removing itself before a once listener", async () => {
  const { stdout, stderr, exitCode } = await runRow("O09", "'use strict';\nfunction a() { console.log('a handled'); process.removeListener('rejectionHandled', a); }\nprocess.on('unhandledRejection', () => {});\nprocess.on('rejectionHandled', a);\nprocess.once('rejectionHandled', () => { console.log('once handled'); });\nprocess.on('rejectionHandled', () => { console.log('on handled'); });\nconst p1 = Promise.reject(new Error('r1'));\nconst p2 = Promise.reject(new Error('r2'));\nsetTimeout(() => {\n  p1.catch(() => {});\n  setTimeout(() => { p2.catch(() => {}); }, 5);\n}, 5);\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\na handled\nonce handled\non handled\non handled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// REACTION
// ============================================================

test("R23 REACTION: a finally handler on a rejected promise keeps the rejection", async () => {
  const { stdout, stderr, exitCode } = await runRow("R23", "'use strict';\nfunction id(v) { return v; }\nasync function bad() { throw new Error('fin-src'); }\nid(bad()).finally(() => console.log('fin')).then((v) => console.log('never', v), (e) => console.log('still rejected', e.message));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nfin\nstill rejected fin-src\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// CORPUS — full stdout and exit code
// ============================================================

test("C1 CORPUS: 1452 returns through finally blocks", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C1", "1452-return-through-finally.ts");
  expect(stdout).toBe("finally ran, x = 99\nsnapshot: 1\ncleanup a\ncleanup b\nstart-a start-b\ninner finally\nouter finally\nnested: value\nloop cleanup\nloop cleanup\n20 -1\ncatch-path finally\ncaught\nreplaced by replacer\nvoid cleanup true\nno return taken\nvoid cleanup false\nunion cleanup\n7\nunion cleanup\nnull\nouter arr cleanup, len 3\nx,y,inner-after-return-computed\nasync cleanup\n18\nasync cleanup\nnull\nawait caught: async replacer\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C2 CORPUS: 1453 a manual allSettled over concurrent workers", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C2", "1453-pmap-settled.ts");
  expect(stdout).toBe("worked 1 at 0\nworked 2 at 1\nfulfilled\nrejected\n3\ntrue false\nfilled\n2\n0\n0\nworked 4 at 3\nworked 5 at 4\nworked 7 at 6\nfulfilled,fulfilled,rejected,fulfilled,fulfilled,rejected,fulfilled\n7\nnone: 0\nworked 5 at 1\nrejected,fulfilled\nworked 10 at 1\nrejected,fulfilled\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C3 CORPUS: 409 async parameters and a loop box", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C3", "409-params-async-generics.ts");
  expect(stdout).toBe("0\n5\na\n1 2 2\n2 4 2\nsolo\nduo+b\ntri\nprefix sees 30\n63\nprefix sees 1\n5\n0\n6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C4 CORPUS: 2210 typed promises crossing the checked-dynamic tree", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C4", "2210-dyn-promise-crossing.cjs");
  expect(stdout).toBe("object [object Promise] {\"p\":{}}\nsame value: true\nsync tail\nthen 7\nchained 8\ncaught Error: boom\nfinally ran\nadopted 7\nafter finally recovered\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C5 CORPUS: 2735 the rejection-event family, once listeners included", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C5", "2735-rejection-events.cjs");
  expect(stdout).toBe("sync tail\nonce: first\non: first\non: last\nattaching late handler\nrejectionHandled: true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG01 CORPUS: REGRESSION 2673-generators-finally-chain (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG01", "2673-generators-finally-chain.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\n2 {\"value\":\"inner-fin\",\"done\":false}\n3 {\"value\":\"outer-fin\",\"done\":false}\n4 THREW boom\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG02 CORPUS: REGRESSION 2674-generators-finally-plain-outer (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG02", "2674-generators-finally-plain-outer.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\n2 {\"value\":\"inner-fin\",\"done\":false}\nouter-fin ran\n3 THREW boom\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG03 CORPUS: REGRESSION 2675-generators-finally-plain-inner (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG03", "2675-generators-finally-plain-inner.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\ninner-fin ran\n2 {\"value\":\"outer-fin\",\"done\":false}\n3 THREW boom\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG04 CORPUS: REGRESSION 2676-generators-finally-catch-order (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG04", "2676-generators-finally-catch-order.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\n2 {\"value\":\"inner-fin\",\"done\":false}\n3 {\"value\":\"caught:boom\",\"done\":false}\n4 {\"value\":\"end\",\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG05 CORPUS: REGRESSION 2677-generators-finally-fallthrough (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG05", "2677-generators-finally-fallthrough.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\n2 {\"value\":\"inner-fin\",\"done\":false}\n3 {\"value\":\"caught:boom\",\"done\":false}\n4 {\"value\":\"end\",\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG06 CORPUS: REGRESSION 2678-generators-finally-genret-group (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG06", "2678-generators-finally-genret-group.ts");
  expect(stdout).toBe("1 {\"value\":\"before\",\"done\":false}\n2 {\"value\":\"inside\",\"done\":false}\n3 {\"value\":\"fin\",\"done\":false}\n4 {\"value\":\"early\",\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG07 CORPUS: REGRESSION 2679-generators-finally-return-chain (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG07", "2679-generators-finally-return-chain.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\n2 {\"value\":\"inner-fin\",\"done\":false}\n3 {\"value\":\"outer-fin\",\"done\":false}\n4 {\"value\":\"early\",\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG08 CORPUS: REGRESSION 2680-generators-finally-throw-done (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG08", "2680-generators-finally-throw-done.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\n2 {\"value\":\"fin\",\"done\":false}\n3 THREW boom\n4 {\"done\":true}\n5 {\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG09 CORPUS: REGRESSION 2681-async-finally-throw (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG09", "2681-async-finally-throw.ts");
  expect(stdout).toBe("spawned\nfinally ran\nrejected boom\nmain done\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG10 CORPUS: REGRESSION 2682-async-finally-normal (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG10", "2682-async-finally-normal.ts");
  expect(stdout).toBe("spawned\nfinally ran\nresolved ok\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG11 CORPUS: REGRESSION 2683-generators-finally-catch-between (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG11", "2683-generators-finally-catch-between.ts");
  expect(stdout).toBe("1 {\"value\":\"a\",\"done\":false}\n2 {\"value\":\"inner-fin\",\"done\":false}\n3 {\"value\":\"caught:boom\",\"done\":false}\n4 {\"value\":\"outer-fin\",\"done\":false}\n5 {\"value\":\"end\",\"done\":true}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("RG12 CORPUS: REGRESSION 2684-async-finally-catch-between (a claimed finally-chain program)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("RG12", "2684-async-finally-catch-between.ts");
  expect(stdout).toBe("spawned\ninner-fin\ncaught:boom\nouter-fin\nresolved end\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
