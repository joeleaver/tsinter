/* Boards #176, #177, #182 and #184 — a promise held in an `any` on the
 * WasmGC tier, adopted the way Node adopts it.
 *
 * The emitter's "adopting a promise held in dyn" section (emitter.ts) is
 * the mechanism: settle's adoption prologue (the resolve function's
 * NewPromiseResolveThenableJob — one hop, then a subscription), the
 * PromiseResolve fast path %w.dynprom.resolve (`Promise.resolve(x)` and
 * `await x` answer a promise held in `x` itself), island
 * then/catch/finally on a promise receiver through the reaction trio, and
 * the gated payload reader %w.prom.readDyn for a `Promise<any>` that is a
 * typed promise underneath. The import spine keeps its own timing (board
 * #181, SEMANTICS.md S083's import() cells): the SPINE rows pin it.
 *
 * Every expected line below is an INLINED literal. A run row's stdout is a
 * real Node v24.18.1 run (`node --experimental-transform-types` for .ts,
 * plain `node` otherwise) of the SAME source, byte for byte (Node's stderr
 * empty, exit 0). A trap row asserts this tier's report with Node's answer
 * stated beside it: an unhandled rejection reported as SEMANTICS.md S010
 * registers it, or the named refusal for a non-promise thenable (Joe's
 * ruling: full thenable adoption is not built). Typed promises resolved
 * with promises (board #170) stay S083's and are rowed in
 * wasm-async-u4.test.ts. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-adopt-"));
  // .ts rows compile in an ES-module directory, .cjs rows in a CommonJS
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
 * own rule). */
function isDynamic(src: string): boolean {
  return /^\/\/ @dynamic\s*$/m.test(src.split("\n", 2).join("\n"));
}

async function build(id: string, src: string, ext: string): Promise<string> {
  const dir = join(scratch, ext === "cjs" ? "cjs" : "esm");
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  return res.binaryPath;
}

async function runRow(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const run = await runWasm(await build(id, src, ext));
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

/** A row expecting an uncaught trap: runWasmToTrap asserts the trap and
 * reports what was printed before it. */
async function runRowTrap(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string }> {
  const run = await runWasmToTrap(await build(id, src, ext));
  return { stdout: String(run.stdout), stderr: String(run.stderr) };
}

/** A multi-file row expected to refuse: the entry is main.ts. */
async function refuseRowDir(id: string, files: Record<string, string>): Promise<{ diagnostics: string[]; survey: string[] }> {
  const dir = join(scratch, "esm", id);
  await mkdir(dir);
  for (const [name, src] of Object.entries(files)) await writeFile(join(dir, name), `${src}\n`);
  const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "main.wasm"), outDir: dir, backend: "wasm", dynamic: isDynamic(files["main.ts"]!) });
  if (res.ok) throw new Error(`${id} compiled but was expected to refuse`);
  return {
    diagnostics: [...new Set(res.diagnostics.map((d) => `${d.code}:${d.message}`))].sort(),
    survey: [...(res.wasmSurvey ?? [])].sort(),
  };
}

/** A multi-file row expecting an uncaught trap: the entry is main.ts. */
async function runRowDirTrap(id: string, files: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const dir = join(scratch, "esm", id);
  await mkdir(dir);
  for (const [name, src] of Object.entries(files)) await writeFile(join(dir, name), `${src}\n`);
  const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "main.wasm"), outDir: dir, backend: "wasm", dynamic: isDynamic(files["main.ts"]!) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasmToTrap(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr) };
}

/** A corpus program, built the way the differential harness builds it
 * (a `// @dynamic` head gets --dynamic; a directory's entry is main.ts). */
async function runCorpusRow(id: string, relPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = fileURLToPath(new URL(`../../../tests/corpus/${relPath}`, import.meta.url));
  const dynamic = isDynamic(await readFile(entry, "utf8"));
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

// ============================================================
// RESOLVE — the resolve function and PromiseResolve over a dyn value (board #176)
// ============================================================

test("AD01 RESOLVE: Promise.resolve of an any-held dyn promise answers that promise: no job", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD01", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 7; }\nconst x: any = id(n());\nPromise.resolve(x).then((v: any) => console.log(`resolve any ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nresolve any 7 number\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD02 RESOLVE: an async function returning an any-held dyn promise adopts it with Node's two jobs", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD02", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<unknown> { return 7; }\nasync function g(): Promise<any> { const x: any = id(f()); return x; }\ng().then((v: any) => console.log(`async-return any ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\nasync-return any 7 number\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD03 RESOLVE: new Promise resolved with an any-held dyn promise adopts it with Node's two jobs", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD03", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<unknown> { return 7; }\nconst x: any = id(f());\nnew Promise((res) => res(x)).then((v: any) => console.log(`np any ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\nnp any 7 number\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD05 RESOLVE: Promise.resolve of an any-held TYPED number promise answers that promise (a gated module)", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD05", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<number> { return 7; }\nconst x: any = id(n());\nPromise.resolve(x).then((v: any) => console.log(`resolve any ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nresolve any 7 number\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD06 RESOLVE: an async function returning an any-held TYPED number promise adopts it (a gated module)", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD06", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<number> { return 7; }\nasync function g(): Promise<any> { const x: any = id(f()); return x; }\ng().then((v: any) => console.log(`async-return any ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\nasync-return any 7 number\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD07 RESOLVE: a PENDING any-held promise settled inside o1: resolve, await, then and return register in Node's order", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD07", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nlet fire: (v: unknown) => void = () => {};\nconst pend = new Promise<unknown>((r) => { fire = r; });\nconst x: any = id(pend);\nPromise.resolve(x).then((v: any) => console.log(`resolve-pending ${v}`));\nasync function g(): Promise<any> { return x; }\ng().then((v: any) => console.log(`return-pending ${v}`));\nasync function main(): Promise<void> { const v = await x; console.log(`await-pending ${v}`); }\nmain();\nx.then((v: any) => console.log(`then-pending ${v}`));\nPromise.resolve().then(() => { fire(7); console.log(\"o1\"); }).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\nresolve-pending 7\nawait-pending 7\nthen-pending 7\no2\nreturn-pending 7\no3\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD08 RESOLVE: a REJECTED any-held typed promise through return, new Promise, Promise.resolve and await", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD08", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<number> { throw new Error(\"boom\"); }\nconst x: any = id(f());\nasync function g(): Promise<any> { return x; }\ng().catch((e: any) => { console.log(`return-rejected ${String(e)}`); return 0; });\nnew Promise((r) => r(x)).catch((e: any) => { console.log(`np-rejected ${String(e)}`); return 0; });\nPromise.resolve(x).catch((e: any) => { console.log(`resolve-rejected ${String(e)}`); return 0; });\nasync function main(): Promise<void> { try { await x; } catch (e) { console.log(`await-rejected ${String(e)}`); } }\nmain();\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nresolve-rejected Error: boom\nawait-rejected Error: boom\no1\no2\nreturn-rejected Error: boom\nnp-rejected Error: boom\no3\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD09 RESOLVE: a promise resolved with itself through an any rejects with Node's chaining-cycle TypeError", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD09", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nlet res: (v: unknown) => void = () => {};\nconst p: any = id(new Promise<unknown>((r) => { res = r; }));\nres(p);\np.catch((e: any) => console.log(`cycle ${e.name} ${e.message}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\ncycle TypeError Chaining cycle detected for promise #<Promise>\no1\no2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD10 RESOLVE: an any-held TYPED record promise read by await, a typed then and Promise.all (the gated payload readers)", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD10", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function m(): Promise<{ a: number; b: string }> { return { a: 1, b: \"two\" }; }\nconst x: any = id(m());\nasync function main(): Promise<void> { const v = await x; console.log(`await ${v.a} ${v.b} ${JSON.stringify(v)}`); }\nmain();\nPromise.resolve(x).then((v: any) => console.log(`resolve ${v.a} ${JSON.stringify(v)}`));\nPromise.all([Promise.resolve(x), Promise.resolve(x)]).then((vs: any[]) => console.log(`all ${vs.length} ${vs[0].a} ${vs[1].b}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nawait 1 two {\"a\":1,\"b\":\"two\"}\nresolve 1 {\"a\":1,\"b\":\"two\"}\no1\nall 2 1 two\no2\no3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD11 RESOLVE: an any-held TYPED record promise read through Promise.race and Promise.all (the race copies through the dyn view)", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD11", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function m(): Promise<{ a: number; b: string }> { return { a: 1, b: \"two\" }; }\nconst x: any = id(m());\nPromise.race([Promise.resolve(x)]).then((v: any) => console.log(`race ${v.a} ${v.b} ${JSON.stringify(v)}`));\nPromise.all([Promise.resolve(x)]).then((vs: any[]) => console.log(`all ${vs[0].a} ${vs[0].b}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\nrace 1 two {\"a\":1,\"b\":\"two\"}\nall 1 two\no2\no3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD12 RESOLVE: any-held TYPED string, boolean and void promises through Promise.resolve and await", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD12", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function s(): Promise<string> { return \"seven\"; }\nasync function b(): Promise<boolean> { return true; }\nasync function v(): Promise<void> { }\nconst xs: any = id(s()); const xb: any = id(b()); const xv: any = id(v());\nPromise.resolve(xs).then((q: any) => console.log(`str ${q} ${typeof q} ${q.length}`));\nPromise.resolve(xb).then((q: any) => console.log(`bool ${q} ${typeof q}`));\nPromise.resolve(xv).then((q: any) => console.log(`void ${q} ${typeof q}`));\nasync function main(): Promise<void> { const a = await xs; const c = await xb; const d = await xv; console.log(`awaits ${a} ${c} ${d}`); }\nmain();\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nstr seven string 5\nbool true boolean\nvoid undefined undefined\nawaits seven true undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD13 RESOLVE: an island then handler re-returning its own receiver, beside an async function returning a plain any", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD13", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<number> { return 7; }\nconst u: unknown = id(n());\nconst x: any = u;\nconst y: any = id(5);\nasync function g(): Promise<any> { return y; }\ng().then((v: any) => console.log(`plain ${v}`));\nx.then((v: any) => { console.log(`first ${v}`); return x; }).then((v: any) => console.log(`readopt ${v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nplain 5\nfirst 7\no1\no2\no3\nreadopt 7\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD15 RESOLVE: a resolve function resolved with an any-held promise is already resolved: a later resolve or reject is ignored, and resolve(1) then resolve(x) keeps 1", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD15", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 7; }\nasync function t(): Promise<number> { return 9; }\nconst x: any = id(n());\nnew Promise((res) => { res(x); res(1); }).then((v: any) => console.log(`a ${v}`));\nnew Promise((res) => { res(1); res(x); }).then((v: any) => console.log(`b ${v}`));\nnew Promise((res, rej) => { res(x); rej(new Error(\"late\")); }).then((v: any) => console.log(`c ${v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nb 1\no1\no2\na 7\nc 7\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD16 RESOLVE: already resolved to an any-held TYPED promise, a later reject is ignored (a gated module)", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD16", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 7; }\nasync function t(): Promise<number> { return 9; }\nconst x: any = id(t());\nnew Promise((res, rej) => { res(x); rej(new Error(\"late\")); }).then((v: any) => console.log(`c ${v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\nc 9\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD17 RESOLVE: a captured resolver called again in a later job after resolving with an any-held promise is ignored", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD17", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 7; }\nasync function t(): Promise<number> { return 9; }\nconst x: any = id(n());\nlet rr: (v: unknown) => void = () => {};\nnew Promise((res) => { rr = res; res(x); }).then((v: any) => console.log(`d ${v}`));\nPromise.resolve().then(() => rr(42));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\nd 7\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD18 RESOLVE: plain JavaScript: a promise read back from an untyped object through return, Promise.resolve, new Promise with a late reject, await, then and a re-adopting then", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD18", "// @dynamic\n'use strict';\nasync function n() { return 7; }\nconst box = JSON.parse('{}');\nbox.p = n();\nconst x = box.p;\nasync function g() { return x; }\ng().then((v) => console.log(`g ${v}`));\nPromise.resolve(x).then((v) => console.log(`res ${v}`));\nnew Promise((r, j) => { r(x); j(new Error('late')); }).then((v) => console.log(`np ${v}`));\n(async () => { console.log(`aw ${await x}`); })();\nx.then((v) => console.log(`then ${v}`));\nx.then(() => x).then((v) => console.log(`readopt ${v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\"));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("sync\nres 7\naw 7\nthen 7\no1\no2\ng 7\nnp 7\no3\nreadopt 7\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("AD14 RESOLVE: a dyn Promise.race over an any-held TYPED record promise beside a typed same-type Promise.race and the trio (separate copy reactions)", async () => {
  const { stdout, stderr, exitCode } = await runRow("AD14", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function m(): Promise<{ a: number; b: string }> { return { a: 1, b: \"two\" }; }\nasync function n(): Promise<number> { return 7; }\nasync function k(): Promise<number> { return 8; }\nconst x: any = id(m());\nPromise.race([Promise.resolve(x)]).then((v: any) => console.log(`dyn race ${v.a} ${v.b}`));\nPromise.race([n(), k()]).then((w) => console.log(`typed race ${w}`));\nx.catch((e: any) => console.log(\"never\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\ndyn race 1 two\ntyped race 7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// ISLAND — then / catch / finally and await on an any receiver (boards #177 #182 #184)
// ============================================================

test("IS01 ISLAND: a rejected any-held promise's then passes the rejection through to an unhandled report", async () => {
  // Node v24 prints the same stdout, then the rejection with its stack, and exits 1; this tier reports it as SEMANTICS.md S010 registers and traps.
  const { stdout, stderr } = await runRowTrap("IS01", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<unknown> { throw new Error(\"boom\"); }\nconst x: any = id(f());\nx.then((v: any) => console.log(`then ${v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: boom\n");
});

test("IS02 ISLAND: then then catch on a rejected any-held promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS02", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<unknown> { throw new Error(\"boom\"); }\nconst x: any = id(f());\nx.then((v: any) => console.log(`then ${v}`)).catch((e: any) => console.log(`caught ${e}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\ncaught Error: boom\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("IS03 ISLAND: await of an any holding a number: one job, no cast", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS03", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(5);\nasync function main(): Promise<void> { const v = await x; console.log(`await ${v}`); }\nmain();\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nawait 5\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("IS04 ISLAND: catch directly on a rejected any-held promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS04", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<unknown> { throw new Error(\"boom\"); }\nconst x: any = id(f());\nx.catch((e: any) => console.log(`caught ${e}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\ncaught Error: boom\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("IS05 ISLAND: an island then handler returning an any-held promise: adopted with Node's two jobs (board #182)", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS05", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 1; }\nasync function m(): Promise<unknown> { return 7; }\nconst x: any = id(n()); const y: any = id(m());\nx.then(() => y).then((v: any) => console.log(`adopted ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\no1\no2\no3\nadopted 7 number\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("IS06 ISLAND: await of an any-held dyn promise beside five observers: Node's one job (board #184)", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS06", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 7; }\nconst x: any = id(n());\nasync function main(): Promise<void> { const v = await x; console.log(`await any ${v} ${typeof v}`); }\nmain();\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nawait any 7 number\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("IS07 ISLAND: control: a plain island then on a fulfilled any-held promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS07", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 7; }\nconst x: any = id(n());\nx.then((v: any) => console.log(`then any ${v} ${typeof v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\")).then(() => console.log(\"o5\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nthen any 7 number\no1\no2\no3\no4\no5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("IS08 ISLAND: finally and a two-handler then on an any-held promise", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS08", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<unknown> { return 7; }\nconst x: any = id(f());\nx.finally(() => console.log(\"fin\")).then((v: any) => console.log(`after ${v}`));\nx.then(undefined, (e: any) => console.log(\"no\")).then((v: any) => console.log(`pass ${v}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nfin\no1\npass 7\no2\no3\nafter 7\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("IS09 ISLAND: a two-handler then and finally on rejected and fulfilled any-held promises, a finally handler that throws", async () => {
  const { stdout, stderr, exitCode } = await runRow("IS09", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function f(): Promise<unknown> { throw new Error(\"boom\"); }\nasync function n(): Promise<unknown> { return 7; }\nconst x: any = id(f());\nconst y: any = id(n());\nx.then(undefined, (e: any) => { console.log(`onR ${e.message}`); return 1; }).then((v: any) => console.log(`after onR ${v}`));\nx.finally(() => console.log(\"fin-r\")).catch((e: any) => console.log(`fin-r caught ${e.message}`));\ny.then((v: any) => v + 1, (e: any) => console.log(\"never\")).then((v: any) => console.log(`two ${v}`));\ny.finally(() => { throw new Error(\"in-fin\"); }).catch((e: any) => console.log(`fin threw ${e.message}`));\nPromise.resolve().then(() => console.log(\"o1\")).then(() => console.log(\"o2\")).then(() => console.log(\"o3\")).then(() => console.log(\"o4\"));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("sync\nonR boom\nfin-r\no1\nafter onR 1\ntwo 8\nfin threw in-fin\no2\no3\nfin-r caught boom\no4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ============================================================
// THENABLE — a non-promise thenable held in any is a named run-time refusal (Joe's ruling 2026-10-23)
// ============================================================

test("TH01 THENABLE: an object with its own then method returned from an async function and passed to Promise.resolve", async () => {
  // Node v24 adopts the thenable and prints "sync\nthenable number\nresolve number\n"; this tier refuses by name (full thenable adoption is not built).
  const { stdout, stderr } = await runRowTrap("TH01", "// @dynamic\nconst t: any = { then(r: any) { r(5); } };\nasync function g(): Promise<any> { return t; }\ng().then((v: any) => console.log(`thenable ${typeof v}`));\nPromise.resolve(t).then((v: any) => console.log(`resolve ${typeof v}`));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: resolving a promise with a non-promise thenable is not supported yet\n");
});

test("TH02 THENABLE: plain JavaScript: an untyped object given a then method, returned from an async function", async () => {
  // Node v24 adopts the thenable and prints "sync\nthenable number\n"; this tier refuses by name (full thenable adoption is not built).
  const { stdout, stderr } = await runRowTrap("TH02", "'use strict';\nconst t = JSON.parse('{\"a\":1}');\nt.then = function (r) { r(5); };\nasync function g() { return t; }\ng().then((v) => console.log('thenable', typeof v));\nconsole.log('sync');", "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: resolving a promise with a non-promise thenable is not supported yet\n");
});

test("TH03 THENABLE: a FUNCTION given its own then method, through Promise.resolve and new Promise", async () => {
  // Node v24 adopts the thenable function and prints "sync\nfnres number\nfnnp number\n"; this tier refuses by name (full thenable adoption is not built).
  const { stdout, stderr } = await runRowTrap("TH03", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nconst f: any = id(function () {});\nf.then = (r: any) => r(6);\nPromise.resolve(f).then((v: any) => console.log(`fnres ${typeof v}`));\nnew Promise((r) => r(f)).then((v: any) => console.log(`fnnp ${typeof v}`));\nconsole.log('sync');", "ts");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: resolving a promise with a non-promise thenable is not supported yet\n");
});

test("TH04 THENABLE: a function expression given its own then method, returned from an async function", async () => {
  // Node v24 adopts the thenable function and prints "sync\nfn number\n"; this tier refuses by name (full thenable adoption is not built).
  const { stdout, stderr } = await runRowTrap("TH04", "// @dynamic\nfunction id(v: unknown): unknown { return v; }\nasync function n(): Promise<unknown> { return 7; }\nasync function t(): Promise<number> { return 9; }\nconst f: any = function () {};\nf.then = (r: any) => r(5);\nasync function g(): Promise<any> { return f; }\ng().then((v: any) => console.log(`fn ${typeof v}`));\nconsole.log(\"sync\");", "ts");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: resolving a promise with a non-promise thenable is not supported yet\n");
});

// ============================================================
// SPINE — the import() spine keeps its own bridge (board #181 owns its timing)
// ============================================================

test("SP01 SPINE: 2052 a self-import through the import spine (Node's output)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("SP01", "2052-dynamic-import-self.ts");
  expect(stdout).toBe("entry body done\nself 7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("SP02 SPINE: 2685 a synchronous imported module throwing inside the spine's then handler (Node's output)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("SP02", "2685-dynamic-import-sync-throw/main.ts");
  expect(stdout).toBe("before\nboom:before\ncaught Error: boom\nafter\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("SP03 SPINE: NOT-LIFTED: the spine's copying bridge in a gated module beside a typed same-type Promise.race still refuses by name", async () => {
  const { diagnostics, survey } = await refuseRowDir("SP03", { "m.ts": "export const v = 3;", "main.ts": "// @dynamic\nasync function n(): Promise<number> { return 7; }\nasync function k(): Promise<number> { return 8; }\nfunction id(v: unknown): unknown { return v; }\nconst x: any = id(n());\nimport(\"./m.ts\").then((ns: any) => console.log(`imported ${ns.v}`));\nPromise.race([n(), k()]).then((w) => console.log(`race ${w}`));\nconsole.log(`sync ${typeof x}`);" });
  expect(diagnostics).toEqual(["SC3001:the wasm backend does not support this construct yet (dynFrom:promise:race-copy); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
  expect(survey).toEqual(["dynFrom:promise:race-copy"]);
});

test("SP04 SPINE: an imported module exporting a function named then: the namespace is a thenable, refused by name", async () => {
  // Node v24 adopts the namespace thenable and prints "sync\nimported number\n"; this tier refuses by name (full thenable adoption is not built).
  const { stdout, stderr } = await runRowDirTrap("SP04", { "m.ts": "export function then(resolve: (v: number) => void): void { resolve(5); }", "main.ts": "// @dynamic\nasync function main(): Promise<void> {\n  const ns: any = await import(\"./m.ts\");\n  console.log(`imported ${typeof ns}`);\n}\nmain();\nconsole.log(\"sync\");" });
  expect(stdout).toBe("sync\n");
  expect(stderr).toBe("Uncaught Error: resolving a promise with a non-promise thenable is not supported yet\n");
});
