/* Phase 2 units E0 + E1 — the island ENGINE inside the WasmGC module.
 *
 * E0: the prebuilt quickjs-ng + isl_core.c artifact
 * (packages/runtime/vendor/quickjs-ng-wasm/engine.wasm, built by
 * scripts/build-engine-wasm.mjs) is spliced into a program's own module by
 * ModuleBuilder.attachEngine — re-indexed in place through its relocations
 * (engine.ts), the engine on memory 0 and ours on memory 1 — ONLY when the
 * program reaches the engine. These rows pin the format check (a relocated
 * index that is not a 5-byte LEB is refused by name), the zero-cost rule
 * (a module that never reaches the engine carries none of it), the merged
 * module's shape, and its size cost.
 *
 * E1: `__island_eval` lowers through the engine — String(result), one
 * context per instance (globals persist), engine exceptions as the same
 * catchable errors the native island bridges (isl_throw_reason), the
 * engine's jobs and unhandled rejections at the static checkpoint, the
 * stack budget's catchable RangeError, and the counting allocator's
 * leak oracle. Every expected stdout below is Node's (the corpus shim:
 * `String((0, eval)(code))`), measured with Node v24.18.1, except the
 * rows marked tier-only (SEMANTICS.md S103's fences, and the stderr of a
 * nonzero exit, which S007/S010 already leave unpinned against Node). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { EngineFormatError, engineArtifactPath, engineFencedGlobals, loadEngine, parseEngine, setEngineArtifactPathForTests } from "../src/backend/wasm/engine.js";
import { execFileSync } from "node:child_process";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-island-engine-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(id: string, src: string, dynamic = true): Promise<string> {
  const entry = join(scratch, `${id}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  return res.binaryPath;
}

async function run(id: string, src: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await runWasm(await build(id, src));
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
}

async function runTrap(id: string, src: string): Promise<{ stdout: string; stderr: string }> {
  const r = await runWasmToTrap(await build(id, src));
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
}

/* ── a tiny section reader for the merged module's shape ─────────────── */
function uleb(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let shift = 0;
  for (;;) {
    const x = b[at++]!;
    v += (x & 0x7f) * 2 ** shift;
    shift += 7;
    if ((x & 0x80) === 0) return [v, at];
  }
}
function sections(b: Uint8Array): { id: number; start: number; end: number }[] {
  const out: { id: number; start: number; end: number }[] = [];
  let i = 8;
  while (i < b.length) {
    const id = b[i]!;
    const [size, s] = uleb(b, i + 1);
    out.push({ id, start: s, end: s + size });
    i = s + size;
  }
  return out;
}
function countOf(b: Uint8Array, id: number): number | null {
  const s = sections(b).find((x) => x.id === id);
  return s === undefined ? null : uleb(b, s.start)[0];
}

describe("E0: the engine artifact and the merger", () => {
  test("the checked-in artifact matches its recorded sha256 and passes the format check", () => {
    const img = loadEngine();
    expect(img.imports.map((i) => `${i.module}.${i.name}`).sort()).toEqual([
      "tsinter_engine.math_random",
      "wasi_snapshot_preview1.clock_time_get",
      "wasi_snapshot_preview1.fd_close",
      "wasi_snapshot_preview1.fd_fdstat_get",
      "wasi_snapshot_preview1.fd_seek",
      "wasi_snapshot_preview1.fd_write",
    ]);
    expect(img.relocs.length).toBeGreaterThan(10000);
    for (const name of ["_initialize", "isl_alloc", "isl_free", "isl_eval16", "isl_drain_jobs", "isl_rejection", "isl_live_allocs"]) {
      expect(img.exports.has(name)).toBe(true);
    }
  });

  test("the format check refuses a relocated index that is not a 5-byte LEB, by name", () => {
    const bytes = new Uint8Array(readFileSync(engineArtifactPath()));
    const img = parseEngine(bytes);
    const code = sections(bytes).find((s) => s.id === 10)!;
    const site = img.relocs.find((r) => r.space === "func")!;
    const broken = bytes.slice();
    // Clear the continuation bit of the site's FIRST byte: a 1-byte LEB
    // followed by four stray bytes — the shape a non-padding linker emits.
    broken[code.start + site.offset] = broken[code.start + site.offset]! & 0x7f;
    expect(() => parseEngine(broken)).toThrow(EngineFormatError);
    expect(() => parseEngine(broken)).toThrow(/func index at code offset \d+ is a 1-byte LEB, not 5/);
  });

  test("the format check refuses a start section and a foreign import kind", () => {
    const bytes = new Uint8Array(readFileSync(engineArtifactPath()));
    const withStart = new Uint8Array([...bytes, 0x08, 0x01, 0x00]);
    expect(() => parseEngine(withStart)).toThrow(/a start section/);
    const imp = sections(bytes).find((s) => s.id === 2)!;
    const broken = bytes.slice();
    // The first import's kind byte (after its two names): function -> table.
    let at = imp.start;
    [, at] = uleb(broken, at); // count
    for (let k = 0; k < 2; k++) {
      const [n, s] = uleb(broken, at);
      at = s + n;
    }
    broken[at] = 0x01;
    expect(() => parseEngine(broken)).toThrow(/is not a function \(kind 1\)/);
  });

  test("a module that never reaches the engine carries none of it (one memory, no table, --dynamic or not)", async () => {
    const src = [
      "const parts: string[] = process.argv.slice(2);",
      "console.log('static', parts.length, 'é' + String.fromCharCode(0xd83c, 0xdf0d), JSON.stringify({ a: [1, 2] }));",
      "setTimeout(() => console.log(Date.now() > 0), 0);",
    ].join("\n");
    const plain = await readFile(await build("no-engine-static", src, false));
    const dynamic = await readFile(await build("no-engine-dynamic", src, true));
    expect(Buffer.compare(plain, dynamic)).toBe(0);
    expect(countOf(plain, 5)).toBe(1);
    expect(countOf(plain, 4)).toBeNull();
    expect(plain.includes(Buffer.from("JS_CallInternal"))).toBe(false);
    expect(plain.length).toBeLessThan(200_000);
  });

  test("an engine module validates, carries the engine on memory 0 and exports memory 1 as `memory`", async () => {
    const bytes = await readFile(await build("engine-shape", `console.log(__island_eval("6 * 7"));`));
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(countOf(bytes, 5)).toBe(2);
    expect(countOf(bytes, 4)).toBe(1);
    const mod = new WebAssembly.Module(bytes);
    // The host contract is unchanged: the same import names a non-engine
    // module of this shape would mint, plus the two clocks — no WASI.
    expect(WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`)).toEqual([
      "tsinter.write",
      "tsinter.now",
      "tsinter.seed",
      "tsinter.wallClock",
    ]);
    const exp = sections(bytes).find((s) => s.id === 7)!;
    const [n, first] = uleb(bytes, exp.start);
    let at = first;
    let memIdx = -1;
    for (let k = 0; k < n; k++) {
      const [len, s] = uleb(bytes, at);
      const name = Buffer.from(bytes.subarray(s, s + len)).toString();
      const kind = bytes[s + len]!;
      const [idx, next] = uleb(bytes, s + len + 1);
      if (name === "memory") {
        expect(kind).toBe(2);
        memIdx = idx;
      }
      at = next;
    }
    expect(memIdx).toBe(1);
  });

  test("module-size cost of carrying the engine", async () => {
    const withEngine = (await readFile(await build("size-engine", `console.log(__island_eval("'hello ' + 'world'"));`))).length;
    const without = (await readFile(await build("size-static", `console.log(String("hello ") + "world");`, false))).length;
    const cost = withEngine - without;
    // Measured at this unit: the engine's code (506KB), data (107KB) and
    // function names (31KB) plus the bridge. Bounds, not a pin: a vendor
    // bump moves it.
    expect(cost).toBeGreaterThan(550_000);
    expect(cost).toBeLessThan(720_000);
  });
});

describe("E1: __island_eval through the engine", () => {
  test("String(result) for every value kind, globals persisting across evals", async () => {
    const r = await run(
      "values",
      [
        `console.log(__island_eval("Symbol('x')"), __island_eval("[1, [2, 3]]"), __island_eval("({})"), __island_eval("(() => 1)"));`,
        `console.log(__island_eval("-0"), __island_eval("2 ** 53 + 1"), __island_eval("1e-7"), __island_eval("123n"), __island_eval("new Date(0).toISOString()"));`,
        `console.log(__island_eval("var acc = 1; acc"), __island_eval("acc += 1; acc"), __island_eval("typeof acc"), __island_eval("let lex = 'L'; lex"), __island_eval("typeof lex"));`,
        `console.log(__island_eval("true"), __island_eval("1 < 0"), __island_eval("undefined"), __island_eval("null"), __island_eval("''").length);`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Symbol(x) 1,2,3 [object Object] () => 1\n0 9007199254740992 1e-7 123 1970-01-01T00:00:00.000Z\n1 2 number L undefined\ntrue false undefined null 0\n",
    );
  });

  test("UTF-16 marshaling is faithful both ways, lone surrogates included", async () => {
    const r = await run(
      "unicode",
      [
        `const out = __island_eval("'a' + '\\\\uD800' + 'b'");`,
        `console.log(out.length, out.charCodeAt(1), out.charCodeAt(2));`,
        `const lone = "x" + String.fromCharCode(0xdc00) + "y";`,
        `console.log(__island_eval("'" + lone + "'.charCodeAt(1)"), __island_eval("'" + lone + "'.length"));`,
        `console.log(__island_eval("'\\u{1F30D}'.codePointAt(0)"), __island_eval("'中'.charCodeAt(0)"));`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3 55296 98\n56320 3\n127757 20013\n");
  });

  test("engine exceptions cross as the native bridge's catchable errors", async () => {
    const r = await run(
      "errors",
      [
        `function attempt(code: string): string {`,
        `  try { return __island_eval(code); } catch { return "recovered"; }`,
        `}`,
        `console.log(attempt("1 + 1"), attempt("throw new TypeError('boom')"), attempt("'still ok'"));`,
        `try { __island_eval("throw new TypeError('island boom')"); } catch (e) { if (e instanceof TypeError) console.log("typed", e.name, e.message); }`,
        `try { __island_eval("class Weird extends Error { constructor(m) { super(m); this.name = 'Weird'; } } throw new Weird('custom')"); }`,
        `catch (e) { if (e instanceof Error && !(e instanceof TypeError)) console.log("custom", e.name, e.message, e.toString()); }`,
        `try { __island_eval("throw 'plain reason'"); } catch (e) { if (typeof e === "string") console.log("string payload", e); if (e instanceof Error) console.log("wrongly an Error"); }`,
        `try { __island_eval("this is ( not JS"); } catch (e) { if (e instanceof SyntaxError) console.log("syntax", e.name); }`,
        `try { __island_eval("undefinedVar + 1"); } catch (e) { if (e instanceof Error) console.log("ref", e.name, e.message); }`,
        `try { __island_eval("null.x"); } catch (e) { if (e instanceof TypeError) console.log("null read", e.name); }`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "2 recovered still ok\ntyped TypeError island boom\ncustom Weird custom Weird: custom\nstring payload plain reason\nsyntax SyntaxError\nref ReferenceError undefinedVar is not defined\nnull read TypeError\n",
    );
  });

  test("an uncaught engine exception reports through the uncaught printer and exits 1", async () => {
    const r = await runTrap(
      "uncaught",
      `console.log("before");\nconst x = __island_eval("(function () { throw new TypeError('boom') })()");\nconsole.log("unreachable", x);`,
    );
    expect(r.stdout).toBe("before\n");
    // tier-only: the nonzero exit's stderr (native's line, not Node's).
    expect(r.stderr).toBe("Uncaught TypeError: boom\n");
  });

  test("unbounded recursion is a catchable RangeError; the engine stays usable; 900 frames fit", async () => {
    const r = await run(
      "overflow",
      [
        `try { __island_eval("function r(n) { return r(n + 1); } r(0)"); } catch (e) { if (e instanceof RangeError) console.log("overflow", e.name, e.message); }`,
        `console.log(__island_eval("function q(n) { return q(n + 1); } try { q(0); 'no-overflow' } catch (e) { e.name }"));`,
        `console.log(__island_eval("'engine still ' + 'usable'"));`,
        `console.log(__island_eval("function d(n) { return n === 0 ? 0 : 1 + d(n - 1); } d(900)"));`,
        `function deep(k: number): string { return k === 0 ? __island_eval("function z(n) { return z(n + 1); } try { z(0) } catch (e) { e.name }") : deep(k - 1); }`,
        `console.log(deep(2000));`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("overflow RangeError Maximum call stack size exceeded\nRangeError\nengine still usable\n900\nRangeError\n");
  });

  test("engine jobs run at the checkpoint: not mid-script, before the next macrotask", async () => {
    const r = await run(
      "jobs",
      [
        `console.log(__island_eval("Promise.resolve(1).then(x => { globalThis.z = x }); 'p'"));`,
        `console.log(__island_eval("String(globalThis.z)"));`,
        `setTimeout(() => { console.log(__island_eval("String(globalThis.z)")); }, 0);`,
        `console.log(__island_eval("Promise.reject(new Error('seen')).catch((e) => {}); 'ok'"));`,
        `console.log(__island_eval("globalThis.p = Promise.reject(new Error('later')); 'armed'"));`,
        `console.log(__island_eval("p.catch(() => { globalThis.caught = 1 }); 'handled'"));`,
        `setTimeout(() => { console.log(__island_eval("String(globalThis.caught)")); }, 0);`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("p\nundefined\nok\narmed\nhandled\n1\n1\n");
  });

  test("an unhandled engine rejection reports at the checkpoint and exits 1", async () => {
    const r = await runTrap("rejection", `console.log(__island_eval("Promise.reject(new TypeError('island boom')); 'armed'"));`);
    expect(r.stdout).toBe("armed\n");
    // tier-only: native's line (scr_island.c isl_report_rejections).
    expect(r.stderr).toBe("Unhandled promise rejection: TypeError: island boom\n");
  });

  test("tier-only (S103 (d), (e)): QuickJS's error texts, and the engine's local time is UTC", async () => {
    const r = await run(
      "texts-tz",
      [
        `try { __island_eval("null.x"); } catch (e) { if (e instanceof TypeError) console.log(e.message); }`,
        `try { __island_eval("undefined()"); } catch (e) { if (e instanceof TypeError) console.log(e.message); }`,
        `console.log(__island_eval("new Date(0).getTimezoneOffset()"), __island_eval("new Date(0).getHours()"));`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("cannot read property 'x' of null\nnot a function\n0 0\n");
  });

  test("tier-only (S103 (a)): engine recursion its budget undercounts overflows the HOST stack, uncatchably", async () => {
    const path = await build(
      "host-overflow",
      `try { console.log(__island_eval("let o = {}; for (let i = 0; i < 100000; i++) o = { o }; JSON.stringify(o).length")); } catch { console.log("caught"); }`,
    );
    await expect(runWasm(path)).rejects.toThrow(/Maximum call stack size exceeded/);
  });

  test("tier-only (S103 (g)): an engine rejection with an 'unhandledRejection' listener is a named error", async () => {
    const r = await runTrap(
      "rejection-listener",
      [
        `process.on("unhandledRejection", (reason: unknown) => { console.log("listener", String(reason)); });`,
        `console.log(__island_eval("Promise.reject(new TypeError('island boom')); 'armed'"));`,
      ].join("\n"),
    );
    expect(r.stdout).toBe("armed\n");
    expect(r.stderr).toBe(
      "Uncaught Error: an island promise rejection with an 'unhandledRejection' listener registered is not supported yet (SEMANTICS.md S103)\n",
    );
  });

  test("eval source the compiler can see that references a fenced global refuses at build time, by name", async () => {
    const entry = join(scratch, "fence-static.ts");
    await writeFile(entry, `console.log(__island_eval("new TextEncoder().encode('a').length"));\n`);
    const res = await compile(entry, { outPath: join(scratch, "fence-static.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
    expect(res.diagnostics[0]!.message).toContain("libCall:island.eval:engine-global:TextEncoder");
    // Identifier position only: inside a quoted string, a comment, after
    // `.` / `?.`, an object key, or as part of a longer word, a fenced name
    // does not refuse.
    const ok = await build(
      "fence-words",
      `console.log(__island_eval("var processed = 'the process is done'; /* console */ var o = { URL: 1 }; o.URL + o?.fetch + typeof globalThis + processed"));`,
    );
    expect((await runWasm(ok)).stdout).toBe("NaNobjectthe process is done\n");
  });

  test("the fence list is generated: engine-fence.json is exactly what the engine fences, every name a Node global it lacks", async () => {
    const fenced = [...engineFencedGlobals()];
    expect(fenced).toContain("Intl");
    expect(fenced).toContain("console");
    const bytes = readFileSync(engineArtifactPath());
    const box: { mem: WebAssembly.Memory | null } = { mem: null };
    const { instance } = await WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: {
        clock_time_get: (_i: number, _p: bigint, out: number) => {
          new DataView(box.mem!.buffer).setBigUint64(out, 0n, true);
          return 0;
        },
        fd_close: () => 0,
        fd_fdstat_get: () => 0,
        fd_seek: () => 70,
        fd_write: () => 0,
      },
      tsinter_engine: { math_random: () => 0.5 },
    });
    box.mem = instance.exports["memory"] as WebAssembly.Memory;
    (instance.exports["_initialize"] as () => void)();
    const p = (instance.exports["isl_fence_list"] as () => number)();
    const u8 = new Uint8Array(box.mem.buffer);
    let end = p;
    while (u8[end] !== 0) end++;
    expect(new TextDecoder().decode(u8.subarray(p, end)).split(",")).toEqual(fenced);
    const nodeGlobals = new Set(Object.getOwnPropertyNames(globalThis));
    for (const n of fenced) expect(nodeGlobals.has(n), n).toBe(true);
  });

  test("tier-only: Node globals the engine lacks are fenced by name, not silently undefined (S103 (b))", async () => {
    const r = await run(
      "fences",
      [
        `for (const name of ["console", "setTimeout", "TextEncoder", "URL", "process", "structuredClone", "Intl", "Atomics", "WebSocket", "CompressionStream"]) {`,
        `  try { console.log(__island_eval("typeof " + name)); } catch (e) { if (e instanceof Error) console.log(e.name, e.message); }`,
        `}`,
        `const te = ["Text", "Encoder"].join("");`,
        `console.log(__island_eval("globalThis." + te + " = 'mine'; " + te), __island_eval("typeof queueMicrotask"), __island_eval("typeof performance.now"));`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    const fence = (n: string): string => `Error ${n} inside __island_eval is not supported yet on the wasm lane (SEMANTICS.md S103)\n`;
    expect(r.stdout).toBe(
      ["console", "setTimeout", "TextEncoder", "URL", "process", "structuredClone", "Intl", "Atomics", "WebSocket", "CompressionStream"].map(fence).join("") +
        "mine function function\n",
    );
  });

  test("tier-only: locale-sensitive methods are fenced by name, not silently different (S103 (b))", async () => {
    const r = await run(
      "locale-fences",
      [
        `for (const src of ["(1234567.891).toLocaleString()", "(5n).toLocaleString()", "new Date(0).toLocaleDateString()", "new Date(0).toLocaleTimeString()",`,
        `    "'a'.localeCompare('b')", "'I'.toLocaleLowerCase('tr')", "'i'.toLocaleUpperCase()", "[1, 2].toLocaleString()", "['a'].toLocaleString()"]) {`,
        `  try { console.log(__island_eval(src)); } catch (e) { if (e instanceof Error) console.log(e.message.split(" inside")[0]); }`,
        `}`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "Number.prototype.toLocaleString\nBigInt.prototype.toLocaleString\nDate.prototype.toLocaleDateString\nDate.prototype.toLocaleTimeString\n" +
        "String.prototype.localeCompare\nString.prototype.toLocaleLowerCase\nString.prototype.toLocaleUpperCase\nNumber.prototype.toLocaleString\na\n",
    );
  });

  test("S103 (h): an Error's string code crosses; other own properties, cause and stack do not", async () => {
    const r = await run(
      "err-props",
      [
        `try { __island_eval("throw Object.assign(new Error('withcode'), { code: 'E1', extra: 5 })"); } catch (e) {`,
        `  const x: any = e; console.log(x.message, x.code, x.extra, typeof x.stack); }`,
        `try { __island_eval("throw Object.assign(new TypeError('numcode'), { code: 7 })"); } catch (e) { const x: any = e; console.log(x.name, x.code); }`,
        `try { __island_eval("throw new TypeError('t', { cause: 'c' })"); } catch (e) { const x: any = e; console.log(x.cause); }`,
        `try { __island_eval("throw Symbol('s')"); } catch (e) { console.log(typeof e === "string" ? e : "not a string"); }`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    // Node: "withcode E1 5 string", "TypeError 7", "c", and the thrown
    // symbol itself (String() of it is "Symbol(s)").
    expect(r.stdout).toBe("withcode E1 undefined undefined\nTypeError undefined\nundefined\nSymbol(s)\n");
  });

  test("the engine's Math.random is the module's own generator: one sequence with static draws, Node's under a seed", async () => {
    const path = await build(
      "shared-random",
      `const v = [Math.random(), Number(__island_eval("Math.random()")), Math.random(), Number(__island_eval("Math.random()"))];\nconsole.log(JSON.stringify(v));`,
    );
    const r = await runWasm(path, { imports: { seed: () => 42n } });
    const node = execFileSync(process.execPath, ["--random-seed=42", "-e", "const v=[];for(let i=0;i<4;i++)v.push(Math.random());console.log(JSON.stringify(v))"], {
      encoding: "utf8",
    });
    expect(r.stdout).toBe(node);
  });

  test("a broken engine artifact is an SC3002 diagnostic, not an exception out of compile()", async () => {
    const dir = join(scratch, "bad-engine");
    await mkdir(dir, { recursive: true });
    const bytes = readFileSync(engineArtifactPath());
    await writeFile(join(dir, "engine.wasm"), bytes.subarray(0, bytes.length - 1));
    await writeFile(join(dir, "engine.wasm.sha256"), readFileSync(`${engineArtifactPath()}.sha256`));
    await writeFile(join(dir, "engine-fence.json"), readFileSync(join(dirname(engineArtifactPath()), "engine-fence.json")));
    setEngineArtifactPathForTests(join(dir, "engine.wasm"));
    try {
      const entry = join(scratch, "bad-engine.ts");
      await writeFile(entry, `console.log(__island_eval("1"));\n`);
      const res = await compile(entry, { outPath: join(scratch, "bad-engine.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
      expect(res.ok).toBe(false);
      expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3002"]);
      expect(res.diagnostics[0]!.message).toMatch(/island engine artifact: .* does not match engine\.wasm\.sha256/);
    } finally {
      setEngineArtifactPathForTests(null);
    }
  });
});

describe("E1: the counting allocator (the engine's leak oracle)", () => {
  test("evals, throws and job drains return the engine's live allocations to their baseline", async () => {
    const bytes = readFileSync(engineArtifactPath());
    const memBox: { mem: WebAssembly.Memory | null } = { mem: null };
    const wasi = {
      clock_time_get: (_id: number, _p: bigint, out: number) => {
        new DataView(memBox.mem!.buffer).setBigUint64(out, 0n, true);
        return 0;
      },
      fd_close: () => 0,
      fd_fdstat_get: () => 0,
      fd_seek: () => 0,
      fd_write: () => 0,
    };
    const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi, tsinter_engine: { math_random: () => 0.5 } });
    const e = instance.exports as Record<string, (...a: number[]) => number>;
    const mem = instance.exports["memory"] as WebAssembly.Memory;
    memBox.mem = mem;
    e["_initialize"]!();
    const ev = (code: string): number => {
      const p = e["isl_alloc"]!(code.length * 2);
      const u = new Uint16Array(mem.buffer, p, code.length);
      for (let i = 0; i < code.length; i++) u[i] = code.charCodeAt(i);
      const k = e["isl_eval16"]!(p, code.length);
      e["isl_free"]!(p);
      e["isl_out_done"]!();
      return k;
    };
    const body = (i: number): string =>
      `(function () { var o = { n: ${i}, tag: 'it' + ${i}, arr: [${i}, ${i} * 2] }; return o.tag + ':' + (o.n + o.arr[1]); })()`;
    for (let i = 0; i < 5; i++) ev(body(i));
    ev("throw new TypeError('warm')");
    ev("Symbol('warm')");
    e["isl_drain_jobs"]!();
    const baseline = e["isl_live_allocs"]!();
    for (let i = 0; i < 300; i++) expect(ev(body(i))).toBe(0);
    for (let i = 0; i < 50; i++) expect(ev(`throw new TypeError('t${i}')`)).toBe(3);
    for (let i = 0; i < 50; i++) expect(ev(`throw 's${i}'`)).toBe(4);
    for (let i = 0; i < 20; i++) expect(ev("Symbol('s')")).toBe(0);
    for (let i = 0; i < 20; i++) ev("Promise.resolve(1).then(x => x + 1); 'p'");
    expect(e["isl_drain_jobs"]!()).toBe(20);
    expect(e["isl_live_allocs"]!()).toBe(baseline);
  });
});
