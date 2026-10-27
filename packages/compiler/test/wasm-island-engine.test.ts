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
import { resetRegexBuildtimeForTests } from "../src/backend/wasm/regex-buildtime.js";
// @ts-expect-error -- a plain .mjs repo script, no declaration file
import { renderWebPrelude } from "../../../scripts/gen-web-prelude.mjs";

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

/** Runs `f` with this process's TZ set (Node re-reads its zone), then puts
 * it back: the shared host's tzCall answers from this process's Date. */
async function withTz<T>(tz: string, f: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, "TZ");
  const saved = process.env["TZ"];
  process.env["TZ"] = tz;
  try {
    return await f();
  } finally {
    if (had) process.env["TZ"] = saved;
    else delete process.env["TZ"];
  }
}

describe("E0: the engine artifact and the merger", () => {
  test("the checked-in artifact matches its recorded sha256 and passes the format check", () => {
    const img = loadEngine();
    expect(img.imports.map((i) => `${i.module}.${i.name}`).sort()).toEqual([
      "tsinter_engine.math_random",
      "tsinter_engine.perf_now",
      "tsinter_engine.pow",
      "tsinter_engine.random",
      "tsinter_engine.tz_name",
      "tsinter_engine.tz_offset",
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
    // module of this shape would mint, plus the two clocks and the entropy
    // read (the web prelude's crypto, E2) and the local zone (tzCall,
    // the engine's Date, S113) — no WASI.
    expect(WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`)).toEqual([
      "tsinter.write",
      "tsinter.now",
      "tsinter.seed",
      "tsinter.wallClock",
      "tsinter.random",
      "tsinter.tzCall",
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
    // Measured at E1: the engine's code (506KB), data (107KB) and function
    // names (31KB) plus the bridge, 665,633 bytes; E2's shared web prelude
    // (its source text rides in the data) and the engine's Node Math
    // (ieee754.cc, the shared ports, %w.jsPow) brought it to 751,908, and the review ports of
    // Node's web classes to 841,906. Bounds,
    // not a pin: a vendor bump moves it.
    expect(cost).toBeGreaterThan(600_000);
    expect(cost).toBeLessThan(860_000);
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

  test("tier-only (S103 (d)): QuickJS's error texts; the engine's local time is the host's zone (S113)", async () => {
    const r = await withTz("Asia/Kolkata", () =>
      run(
        "texts-tz",
        [
          `try { __island_eval("null.x"); } catch (e) { if (e instanceof TypeError) console.log(e.message); }`,
          `try { __island_eval("undefined()"); } catch (e) { if (e instanceof TypeError) console.log(e.message); }`,
          `console.log(__island_eval("new Date(0).getTimezoneOffset()"), __island_eval("new Date(0).getHours()"));`,
        ].join("\n"),
      ),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("cannot read property 'x' of null\nnot a function\n-330 5\n");
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
    await writeFile(entry, `console.log(__island_eval("new WebSocket('ws://x').url"));\n`);
    const res = await compile(entry, { outPath: join(scratch, "fence-static.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
    expect(res.diagnostics[0]!.message).toContain("libCall:island.eval:engine-global:WebSocket");
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
    expect(fenced).toContain("setTimeout");
    // The shared web prelude's globals are the engine's own now (E2).
    for (const n of ["console", "TextEncoder", "TextDecoder", "URLSearchParams", "crypto", "structuredClone", "ReadableStream"]) {
      expect(fenced).not.toContain(n);
    }
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
      tsinter_engine: { math_random: () => 0.5, random: () => {}, pow: Math.pow, tz_offset: () => 0, tz_name: () => 0, perf_now: () => 0 },
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
        `for (const name of ["setTimeout", "clearInterval", "URL", "process", "fetch", "Intl", "Atomics", "WebSocket", "WritableStream", "CompressionStream"]) {`,
        `  try { console.log(__island_eval("typeof " + name)); } catch (e) { if (e instanceof Error) console.log(e.name, e.message); }`,
        `}`,
        `const ws = ["Web", "Socket"].join("");`,
        `console.log(__island_eval("globalThis." + ws + " = 'mine'; " + ws), __island_eval("typeof queueMicrotask"), __island_eval("typeof performance.now"));`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    const fence = (n: string): string => `Error ${n} inside __island_eval is not supported yet on the wasm lane (SEMANTICS.md S103)\n`;
    expect(r.stdout).toBe(
      ["setTimeout", "clearInterval", "URL", "process", "fetch", "Intl", "Atomics", "WebSocket", "WritableStream", "CompressionStream"].map(fence).join("") +
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

  test("a regex literal whose build-time compiler is built mid-walk keeps the engine module's memory index (1206)", async () => {
    // The build-time regex compiler is a separate ModuleBuilder, built on
    // first use; building it inside an engine module's walk used to reset
    // the walk's memory index to 0 ("%w.re.lit ... built for memory 0").
    resetRegexBuildtimeForTests();
    const r = await run("regex-mid-walk", `console.log("a-b".replace(/-/g, "+"), __island_eval("'x-y'.replace(/-/g, '+')"));`);
    expect(r.stdout).toBe("a+b x+y\n");
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

const PRELUDE_JS = join(dirname(engineArtifactPath()), "../../src/scr_web_prelude.js");
const PRELUDE_H = join(dirname(engineArtifactPath()), "../../src/scr_web_prelude.h");

describe("E2: the web globals are the native island's own text", () => {
  test("scr_web_prelude.h is the generator's rendering of scr_web_prelude.js (a hand-edited header goes red here)", () => {
    expect(readFileSync(PRELUDE_H, "utf8")).toBe(renderWebPrelude(readFileSync(PRELUDE_JS, "utf8")));
  });

  test("the engine artifact embeds scr_web_prelude.js byte for byte (a stale engine.wasm goes red here)", () => {
    const text = readFileSync(PRELUDE_JS, "utf8");
    expect(text.length).toBeGreaterThan(50_000);
    const bytes = readFileSync(engineArtifactPath());
    // NUL-terminated, as the C array lays it out.
    expect(bytes.indexOf(Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]))).toBeGreaterThan(0);
  });

  test("console writes the same stdout and stderr as static output, in order, formatted like native (S108 (a))", async () => {
    const r = await run(
      "console-order",
      [
        `console.log("static 1");`,
        `console.log(__island_eval("console.log('island', 1.5, -0, true, null, undefined, [1, [2]], { x: 1 }, 5n, Symbol('s')); console.info('i'); console.debug('d'); 'ret'"));`,
        `console.error("static err");`,
        `console.log(__island_eval("console.warn('w'); console.error('e', 2); console.log(); console.log('%s!', 'x'); 'ret2'"));`,
        `console.log(__island_eval("console.log({ toString() { throw 1; } }); typeof console.dir"));`,
        `console.log("static 2");`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    // Byte-identical to the c and llvm lanes (the same prelude); Node
    // inspects objects instead (S108 (a)): "[ 1, [ 2 ] ] { x: 1 }" and
    // "{ toString: [Function: toString] }". Primitives, %s and the rest are
    // Node's (web-globals.test.ts holds them to Node live).
    expect(r.stdout).toBe(
      "static 1\nisland 1.5 -0 true null undefined 1,2 [object Object] 5n Symbol(s)\ni\nd\nret\n\nx!\nret2\n[value]\nfunction\nstatic 2\n",
    );
    expect(r.stderr).toBe("static err\nw\ne 2\n");
  });

  test("crypto reads the module's own `random` import: chunked past 4096 bytes, offset views, v4 UUIDs", async () => {
    // A scripted entropy source: the byte stream 0, 1, 2, ... (mod 256)
    // across calls, so chunking and the copy into the engine's memory are
    // both visible.
    let k = 0;
    let mem: WebAssembly.Memory | null = null;
    const path = await build(
      "crypto-random",
      [
        `console.log(__island_eval("crypto.randomUUID()"));`,
        `console.log(__island_eval("(() => { const a = crypto.getRandomValues(new Uint8Array(5000)); let ok = true; for (let i = 0; i < a.length; i++) if (a[i] !== (16 + i) % 256) ok = false; return ok + ' ' + a[4095] + ' ' + a[4096] + ' ' + a[4999]; })()"));`,
        `console.log(__island_eval("(() => { const b = new Uint8Array(8); crypto.getRandomValues(new Uint8Array(b.buffer, 3, 2)); return b.join(','); })()"));`,
        `console.log(__island_eval("(() => { try { crypto.getRandomValues(new Uint8Array(65537)); } catch (e) { return e.name + ': ' + e.message; } })()"));`,
      ].join("\n"),
    );
    const r = await runWasm(path, {
      imports: {
        random(ptr: number, len: number): void {
          const u8 = new Uint8Array(mem!.buffer, ptr, len);
          for (let i = 0; i < len; i++) u8[i] = k++ % 256;
        },
      },
      onInstance: (inst) => {
        mem = inst.exports["memory"] as WebAssembly.Memory;
      },
    });
    expect(r.exitCode).toBe(0);
    // 16 + 5000 bytes drawn so far: the third eval's two bytes are
    // (5016, 5017) mod 256 = 152, 153.
    expect(String(r.stdout)).toBe(
      "00010203-0405-4607-8809-0a0b0c0d0e0f\n" +
        "true 15 16 151\n" +
        "0,0,0,152,153,0,0,0\n" +
        "QuotaExceededError: The requested length exceeds 65,536 bytes\n",
    );
  });

  for (const tz of ["UTC", "America/Chicago", "Australia/Lord_Howe"]) {
    test(`Date#toString carries Node's zone-name suffix — the host's NAME (tzCall, S113), TZ=${tz}`, async () => {
      const r = await withTz(tz, () =>
        run(
          "date-suffix",
          `console.log(__island_eval("new Date(0).toString() + ' | ' + new Date(86400000).toTimeString() + ' | ' + new Date(-5364662400000).toString() + ' | ' + String(new Date(NaN))"));`,
        ),
      );
      const want = await withTz(tz, async () =>
        `${new Date(0).toString()} | ${new Date(86400000).toTimeString()} | ${new Date(-5364662400000).toString()} | Invalid Date\n`,
      );
      expect(r.stdout).toBe(want);
    });
  }

  test("tier-only (S103 (b)): the timer globals stay fenced, and AbortSignal.timeout throws the same named error", async () => {
    const r = await run(
      "timer-fences",
      [
        `const st = ["set", "Timeout"].join("");`,
        `try { __island_eval(st + "(() => {}, 1)"); } catch (e) { if (e instanceof Error) console.log(e.message); }`,
        `try { __island_eval("AbortSignal.timeout(5)"); } catch (e) { if (e instanceof Error) console.log(e.message); }`,
        `console.log(__island_eval("AbortSignal.abort().aborted + ' ' + AbortSignal.abort().reason.name + ' ' + new AbortController().signal.aborted"));`,
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "setTimeout inside __island_eval is not supported yet on the wasm lane (SEMANTICS.md S103)\n" +
        "AbortSignal.timeout inside __island_eval is not supported yet on the wasm lane (SEMANTICS.md S103)\n" +
        "true AbortError false\n",
    );
    const entry = join(scratch, "timer-static.ts");
    await writeFile(entry, `console.log(__island_eval("setTimeout(() => {}, 0); 1"));\n`);
    const res = await compile(entry, { outPath: join(scratch, "timer-static.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]!.message).toContain("libCall:island.eval:engine-global:setTimeout");
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
    const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi, tsinter_engine: { math_random: () => 0.5, random: () => {}, pow: Math.pow, tz_offset: () => 0, tz_name: () => 0, perf_now: () => 0 } });
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
    // E2: the shared web globals in the loop too (encoders, form encoding,
    // base64, structuredClone, a promise job). Not streams: a stream and
    // its controller form a reference cycle, freed only when the engine's
    // cycle collector next runs (its own allocation threshold), so the live
    // count after a stream eval depends on when that was (measured at E2:
    // it oscillates between 282 and 373, unbounded growth absent, over
    // 4,000 stream evals) — native's teardown audit is what proves
    // streams leak-free.
    const web = (i: number): string =>
      `new TextDecoder().decode(new TextEncoder().encode('é${i}😀')) + new URLSearchParams('a=${i}&b=2').toString() + atob(btoa('x${i}')) + ` +
      `JSON.stringify(structuredClone({ m: new Map([[${i}, [1]]]) }).m.size) + ` +
      `(Promise.resolve(${i}).then((v) => v + 1), '')`;
    for (let i = 0; i < 5; i++) ev(body(i));
    for (let i = 0; i < 5; i++) ev(web(i));
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
    for (let i = 0; i < 100; i++) expect(ev(web(i))).toBe(0);
    expect(e["isl_drain_jobs"]!()).toBeGreaterThan(0);
    expect(e["isl_live_allocs"]!()).toBe(baseline);
  });
});
