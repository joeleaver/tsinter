/* INC-25 pass P6 (option D) — the `date.*`/`intl.numFormatEnUs`/`perf.now`
 * pin file (design-number-v6.txt §5.5/§6.6/§7.6; CP1 cp1-plan-p6.txt
 * e365032f + cp1-addendum-p6.txt bd77f800 §(k); CP1 ACK GO WITH DELTA).
 *
 * D5's own precedent (atob/btoa, wasm-uri.test.ts): every fixed-input row
 * below is a GENUINE DIFFERENTIAL — the EXPECTED value is computed by
 * calling Node's own `new Date(x).toISOString()` / `Date.UTC(...)` /
 * `new Intl.NumberFormat("en-US").format(x)` / `new Date(s).getTime()` IN
 * THIS TEST PROCESS, never a transcribed literal. The fence rows are the
 * one exception CP1 §(k) names explicitly: no Node expectation exists for
 * a fence's own text, so those rows assert the message/`.code` the wasm
 * lane itself produces.
 *
 * FORCED-HOST invariants (v6 §6.6's own instruction) use a LOCAL copy of
 * the shared `instantiate()` shape (wasm-host.ts's own header explains
 * why: the seed pin does the same, so the SHARED host stays serviced from
 * a real/random source and no OTHER test can accidentally depend on a
 * forced value it never asked for).
 *
 * board #126: every path below resolves through `import.meta.url`. */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";
import { LIB_FN_SIGS } from "../src/ir/validate.js";
import { F64, STRING } from "../src/ir/nodes.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-date-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, src: string): Promise<string> {
  const file = join(scratch, name);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  return res.binaryPath;
}

async function importsOf(binaryPath: string): Promise<string[]> {
  const bytes = await readFile(binaryPath);
  const mod = await WebAssembly.compile(bytes);
  return WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
}

// ── (o) signature check — L-2's ruling: read the TABLE, never hash the
// file. None of the six may widen. ──────────────────────────────────────
describe("the six keys' signatures (validate.ts's LIB_FN_SIGS, read directly)", () => {
  test("date.now: [] -> F64", () => {
    expect(LIB_FN_SIGS["date.now"]).toEqual({ argTypes: [], result: F64 });
  });
  test("date.toISOString: [F64] -> STRING", () => {
    expect(LIB_FN_SIGS["date.toISOString"]).toEqual({ argTypes: [F64], result: STRING });
  });
  test("date.parseGetTime: [STRING] -> F64", () => {
    expect(LIB_FN_SIGS["date.parseGetTime"]).toEqual({ argTypes: [STRING], result: F64 });
  });
  test("date.utc: [F64 x7] -> F64", () => {
    expect(LIB_FN_SIGS["date.utc"]).toEqual({
      argTypes: [F64, F64, F64, F64, F64, F64, F64],
      result: F64,
    });
  });
  test("intl.numFormatEnUs: [F64] -> STRING", () => {
    expect(LIB_FN_SIGS["intl.numFormatEnUs"]).toEqual({ argTypes: [F64], result: STRING });
  });
  test("perf.now: [] -> F64", () => {
    expect(LIB_FN_SIGS["perf.now"]).toEqual({ argTypes: [], result: F64 });
  });
});

// ── date.toISOString — genuine differential ─────────────────────────────
describe("date.toISOString — genuine differential (Node computes its own expectation)", () => {
  const rows = [
    0, 1, -1, 1.9, -1.9, -0, 0.999, -0.5, 1e12, -1e12, 86400000, -86400000, 951782400000,
    253402300799999, 253402300800000, -62198755200000, 8640000000000000, -8640000000000000,
    123456789012345, -62167219200000, -62167219200001,
  ];
  for (const ms of rows) {
    test(`new Date(${ms}).toISOString()`, async () => {
      const want = new Date(ms).toISOString();
      const path = await build(`iso-${ms}.ts`, `console.log(new Date(${ms}).toISOString());`);
      const { stdout } = await runWasm(path);
      expect(stdout).toBe(`${want}\n`);
    });
  }
  test("RangeError on NaN and out-of-range — message quoted", async () => {
    const path = await build(
      "iso-range.ts",
      `try { new Date(NaN).toISOString(); } catch (e) { console.log((e as RangeError).name, (e as RangeError).message); }
       try { new Date(8640000000000001).toISOString(); } catch (e) { console.log((e as RangeError).name, (e as RangeError).message); }`,
    );
    const { stdout } = await runWasm(path);
    expect(stdout).toBe("RangeError Invalid time value\nRangeError Invalid time value\n");
  });
});

// ── date.utc — genuine differential ─────────────────────────────────────
describe("date.utc — genuine differential", () => {
  const rows: number[][] = [
    [2017], [2017, 13], [96, 1, 2, 3, 4, 5, 6], [2017, 0, 60], [2000, -3], [NaN],
    [275760, 8, 13], [275760, 8, 14], [-1, 0, 1, 0, 0, 0, -1], [1000000, 0],
    [-271821, 3, 20], [-271821, 3, 19], [99, 0], [100, 0], [-1, 0], [2016, 1, 29],
    [1900, 1, 29], [2000, 1, 29], [2017, 0, 1, 23, 59, 59, 999], [2017, 0, 1, 24, 0, 0, 0],
    [2017, 0, 0], [2017, -1, 31], [1970], [1970, 0, 1, 0, 0, 0, 1],
    [1969, 11, 31, 23, 59, 59, 999], [2 ** 31, 0], [-(2 ** 31), 0], [1e6 + 1, 0],
    [2017, 1e21], [-0, 0], [2017, 12], [2017, 0, 32],
  ];
  for (const args of rows) {
    test(`Date.UTC(${args.join(",")})`, async () => {
      const want = Date.UTC(...(args as [number]));
      const src = `console.log(Date.UTC(${args.map((n) => (Number.isNaN(n) ? "NaN" : n)).join(", ")}));`;
      const path = await build(`utc-${rows.indexOf(args)}.ts`, src);
      const { stdout } = await runWasm(path);
      expect(stdout.trim()).toBe(String(want));
    });
  }
});

// ── intl.numFormatEnUs — genuine differential ───────────────────────────
describe("intl.numFormatEnUs — genuine differential (ICU 78.3, process.versions.icu this session — S068's precedent: a Node upgrade that moves ICU retires this pin without making the tier wrong)", () => {
  const rows = [
    0, 1, 100, 1000, 10000, 999999, -1000000, 1234567.891, -1234567.891, 123456789.9999, 0.5,
    -0.4, 1.0005, 1.0015, 123.4565, 7.995, 0.0625, 999.9995, 0.1 + 0.2, 1.100000023841858, -0,
    NaN, 1 / 0, -1 / 0, -2.5, 5e-4, -5e-4, 0.00049, 1e-7, -1e-7, 5e-324, 1e21, 1e23,
    9007199254740993, 1.7976931348623157e308,
  ];
  for (const x of rows) {
    test(`Intl.NumberFormat("en-US").format(${x})`, async () => {
      const want = new Intl.NumberFormat("en-US").format(x);
      // `${x}` loses the sign of -0 (String(-0) === "0") -- spell it as
      // the literal source text "-0" so the COMPILED PROGRAM actually
      // sees negative zero, not a template-interpolation artifact.
      const lit = Number.isNaN(x) ? "NaN" : Object.is(x, -0) ? "-0" : String(x);
      const src = `console.log(new Intl.NumberFormat("en-US").format(${lit}));`;
      const path = await build(`intl-${rows.indexOf(x)}.ts`, src);
      const { stdout } = await runWasm(path);
      expect(stdout.trim()).toBe(want);
    });
  }
});

// ── date.parseGetTime — grammar rows (genuine differential) ────────────
describe("date.parseGetTime — modelled-grammar rows, genuine differential", () => {
  const rows = [
    "Jul  1 00:00:00 2026 GMT", "Jul 17 17:52:11 2026 GMT", "Feb 30 00:00:00 2026 GMT",
    "Feb  0 00:00:00 2026 GMT", "Jul 1 24:00:00 2026 GMT", "Jul 1 25:00:00 2026 GMT",
    "2026-07-17T12:00:00Z", "2026-07-17T12:00:00+05:30", "-002026-07-17T12:00:00Z",
    "+000000-01-01T00:00:00Z", "2026-13-17T12:00:00Z", "+275760-09-13T00:00:00.000Z",
    "2026-07-17T12:00:00+00:60", "+275760-09-13T00:00:00-01:00", "+275760-09-13T01:00:00+01:00",
    // DELTA-1: grammar 1's own two-digit-year remap, NOT date.utc's rule.
    "Jan 15 12:30:45 0000 GMT", "Jan 15 12:30:45 0049 GMT", "Jan 15 12:30:45 0050 GMT",
    "Jan 15 12:30:45 0099 GMT", "Jan 15 12:30:45 0100 GMT",
    // grammar 2 is UNAFFECTED by the two-digit rule.
    "0001-01-15T12:30:45Z", "0049-01-15T12:30:45Z",
  ];
  for (const s of rows) {
    test(`new Date(${JSON.stringify(s)}).getTime()`, async () => {
      const want = new Date(s).getTime();
      const path = await build(
        `parse-${rows.indexOf(s)}.ts`,
        `console.log(new Date(${JSON.stringify(s)}).getTime());`,
      );
      const { stdout } = await runWasm(path);
      if (Number.isNaN(want)) expect(stdout.trim()).toBe("NaN");
      else expect(stdout.trim()).toBe(String(want));
    });
  }
});

// ── date.parseGetTime — fence rows (no Node expectation exists) ────────
describe("date.parseGetTime — the S069 fence, asserted on its OWN text (no Node expectation exists for a fence)", () => {
  const rows = [
    "Xyz 1 00:00:00 2026 GMT", // wrong month word
    "Jul 1 00:00:00 2026", // missing " GMT"
    "Jul 1 00:00:60 2026 GMT", // ASN1 ss>59 — reinterpreted as a year
    "2026-07-17T12:00:00.1Z", // lenient fraction-digit count
    "2026-07-17t12:00:00Z", // lowercase t
    "2026-07-17T12:00:00", // offset-less date-time
    "Jan 1 2020", // legacy form
    "-000000-01-01", // "-000000", date-only sub-case (Node gives a real value here)
    "Feb 0 00:00:00 0001 GMT", // grammar 1's own year-1..31 day-violation guard
    "0001-13", // grammar 2's own year-1..12 month-violation guard
    // rev-25's DELTA-7: the C matches the ASN1 month word CASE-
    // INSENSITIVELY and the " GMT" tail with a CASE-SENSITIVE 4-byte
    // compare, eleven lines apart in scr_lib.c — a transcriber's natural
    // unification of the two would flip this row from FENCE to a value
    // (Node answers one, so a case-insensitive tail would even agree
    // with Node — the plan's own asymmetry is deliberate, not an
    // oversight, and this row is the one that would catch losing it).
    "Jul  1 00:00:00 2026 gmt",
    // rev-25's DELTA-7, second row: the C requires the tail to be
    // EXACTLY four characters (`end - p != 4`); a "skip trailing
    // whitespace" habit would silently accept this and change the
    // answer the same way.
    "Jul  1 00:00:00 2026 GMT ",
  ];
  for (const s of rows) {
    test(`FENCED: ${JSON.stringify(s)}`, async () => {
      const path = await build(
        `fence-${rows.indexOf(s)}.ts`,
        `try {
           new Date(${JSON.stringify(s)}).getTime();
           console.log("NOT FENCED");
         } catch (e) {
           if (e instanceof Error) {
             console.log(e.name, \`\${(e as NodeJS.ErrnoException).code}\`);
           }
         }`,
      );
      const { stdout } = await runWasm(path);
      expect(stdout).toBe("Error SC1090\n");
    });
  }
});

// ── FORCED-HOST invariants (v6 §6.6) — each states the value is
// unpinnable by construction, per its own comment. Own copy of
// instantiate(), matching the seed pin's own precedent (wasm-host.ts's
// header) — the shared host stays serviced from real/random sources. ──
async function instantiateForced(
  modulePath: string,
  overrides: { now?: () => number; wallClock?: () => number },
): Promise<{ stdout: string }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  // The DEFAULT `now` tracks the pump's own virtual clock (the real
  // harness's own shape) — a caller that overrides `now` with a custom
  // function is responsible for knowing whether this module also arms a
  // real timer (which would then pump against a DIFFERENT clock than the
  // override reads); every override below is used only on timer-free
  // modules for exactly this reason.
  let clock = 0;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
      now: overrides.now ?? ((): number => clock),
      seed: (): bigint => 1n,
      wallClock: overrides.wallClock ?? ((): number => clock),
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
  if (tick !== undefined) {
    for (let turns = 0; ; turns++) {
      if (turns > 1000) throw new Error(`_tick pump did not settle for ${modulePath}`);
      const due = tick(clock);
      if (due < 0) break;
      clock = Math.max(clock, due);
    }
  }
  return { stdout: Buffer.concat(chunks[1]).toString("utf8") };
}

describe("FORCED-HOST invariants — the value is unpinnable by construction (v6 §6.6)", () => {
  test("perf.now origin: a host tick consumed BETWEEN instantiation and _start, then the EXACT first reading asserted (rev-25's own DELTA-6: `< 1000` alone does not discriminate a start-section capture from a _start-entry one under this host shape UNLESS a tick separates instantiate from _start — with none, both would read 7; M-2/raw-now and M-3/lazy-T0 both still fail, on different rows)", async () => {
    const path = await build(
      "perf-origin.ts",
      `import { performance } from "node:perf_hooks";
       const t0 = performance.now();
       console.log(t0);`,
    );
    let k = 0;
    const nowFn = (): number => 5_000_000 + 7 * k++;
    const chunks: { 1: Buffer[] } = { 1: [] };
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(path), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (fd === 1) chunks[1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
        },
        now: nowFn,
        seed: (): bigint => 1n,
        wallClock: (): number => 0,
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    // The ONE tick DELTA-6 requires: consumed BEFORE `_start` runs, by
    // calling the SAME host closure directly (simulating an external
    // clock read the module never sees) — the ordering that would
    // separate a `_start`-entry T0 capture (this backend's own shape,
    // DELTA-5: structurally the only one available) from a hypothetical
    // instantiation-time capture, which reads a SMALLER T0 and would
    // therefore print a STRICTLY LARGER first reading (14, not 7).
    nowFn();
    (instance.exports["_start"] as () => void)();
    const first = Number(Buffer.concat(chunks[1]).toString().trim());
    // T0 = nowFn() call #2 = 5,000,000 + 7*1 = 5,000,007 (call #1 was the
    // pre-_start tick above); the read = nowFn() call #3 = 5,000,014;
    // 5,000,014 - 5,000,007 = 7, EXACTLY — not merely "< 1000".
    expect(first).toBe(7);
  });
  test("perf.now, a virtual pump: a reading after a 20ms deadline advances by EXACTLY 20", async () => {
    const path = await build(
      "perf-pump.ts",
      `import { performance } from "node:perf_hooks";
       const t0 = performance.now();
       setTimeout(() => {
         console.log(performance.now() - t0);
       }, 20);`,
    );
    const { stdout } = await instantiateForced(path, {});
    expect(stdout.trim()).toBe("20");
  });
  test("wallClock returning a fractional value: Date.now() prints the FLOOR (not a truncation — negative fractional values floor toward -Infinity, matching the module's own f64.floor)", async () => {
    const path = await build("wc-floor.ts", `console.log(Date.now());`);
    const { stdout } = await instantiateForced(path, { wallClock: () => 1_700_000_000_000.75 });
    expect(stdout.trim()).toBe("1700000000000");
  });
  test("wallClock returning a DECREASING sequence: Date.now() follows it exactly, no smoothing", async () => {
    const path = await build(
      "wc-backwards.ts",
      `console.log(Date.now()); console.log(Date.now()); console.log(Date.now());`,
    );
    const seq = [1000, 3000, 500];
    let i = 0;
    const { stdout } = await instantiateForced(path, { wallClock: () => seq[i++]! });
    expect(stdout.trim().split("\n")).toEqual(["1000", "3000", "500"]);
  });
  test("wallClock returning the harness's own shape (base+clock) across a virtual sleep: Date.now()-before equals the deadline delta EXACTLY (1582's assertion, made exact)", async () => {
    const path = await build(
      "wc-sleep.ts",
      `async function main() {
         const before = Date.now();
         await new Promise((resolve) => setTimeout(resolve, 20));
         console.log(Date.now() - before);
       }
       void main();`,
    );
    const wallBase = 1_700_000_000_000;
    let clock = 0;
    const chunks: { 1: Buffer[] } = { 1: [] };
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(path), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (fd === 1) chunks[1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
        },
        now: (): number => clock,
        seed: (): bigint => 1n,
        wallClock: (): number => wallBase + clock,
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    (instance.exports["_start"] as () => void)();
    const tick = instance.exports["_tick"] as (now: number) => number;
    for (let turns = 0; ; turns++) {
      if (turns > 1000) throw new Error("pump did not settle");
      const due = tick(clock);
      if (due < 0) break;
      clock = Math.max(clock, due);
    }
    expect(Buffer.concat(chunks[1]).toString().trim()).toBe("20");
  });
});

// ── import-section pins (C-5, wasm-random.test.ts's own shape) ─────────
describe("the `wallClock`/`now` import-section pins (WebAssembly.Module.imports)", () => {
  test("a module reading NEITHER clock declares NEITHER — aimed at the date.-PREFIX-prescan hazard (DELTA-3): Date.UTC-only, never date.now", async () => {
    const path = await build("imp-neither.ts", `console.log(Date.UTC(2017, 0, 1));`);
    const names = await importsOf(path);
    expect(names).not.toContain("tsinter.wallClock");
    expect(names).not.toContain("tsinter.now");
  });
  test("Date.now() alone declares wallClock and NOT now", async () => {
    const path = await build("imp-datenow.ts", `console.log(Number.isInteger(Date.now()));`);
    const names = await importsOf(path);
    expect(names).toContain("tsinter.wallClock");
    expect(names).not.toContain("tsinter.now");
  });
  test("performance.now() alone declares now and NOT wallClock", async () => {
    const path = await build(
      "imp-perfnow.ts",
      `import { performance } from "node:perf_hooks";
       console.log(performance.now() >= 0);`,
    );
    const names = await importsOf(path);
    expect(names).toContain("tsinter.now");
    expect(names).not.toContain("tsinter.wallClock");
  });
  test("new Date(ms).toISOString() with an explicit ms declares NEITHER (D-alpha's own DELTA-3 discriminator: this is the row a date.-PREFIX prescan would over-mint on)", async () => {
    const path = await build("imp-iso.ts", `console.log(new Date(0).toISOString());`);
    const names = await importsOf(path);
    expect(names).not.toContain("tsinter.wallClock");
    expect(names).not.toContain("tsinter.now");
  });
  test("STATIC reachability roots at mod.entry alone: date.now inside a function never called from entry does NOT declare wallClock (wasm-random.test.ts's own hand-built-IR shape)", async () => {
    const { emitWasmModule } = await import("../src/backend/wasm/emitter.js");
    const { VOID, F64: F64_ } = await import("../src/ir/nodes.js");
    const loc = { file: "unreached.ts", start: 0, end: 0 };
    const neverFn = {
      name: "%never.0",
      params: [],
      returnType: F64_,
      locals: [],
      body: [
        {
          kind: "exprStmt" as const,
          loc,
          expr: { kind: "libCall" as const, fn: "date.now", type: F64_, loc, args: [] },
        },
      ],
      loc,
    };
    const entryFn = { name: "%init.0", params: [], returnType: VOID, locals: [], body: [], loc };
    const mod = {
      irVersion: 3 as const,
      sourceFile: "unreached.ts",
      entry: "%init.0",
      globals: [],
      functions: [entryFn, neverFn],
    };
    const bytes = emitWasmModule(mod as Parameters<typeof emitWasmModule>[0]);
    const wmod = await WebAssembly.compile(bytes);
    const names = WebAssembly.Module.imports(wmod).map((i) => `${i.module}.${i.name}`);
    expect(names).not.toContain("tsinter.wallClock");
  });

  // §3B-6 / DELTA per CP1 addendum E-5 — the engine's own enforcement,
  // reproduced here (this session's C-3 measurement + rev's independent
  // one). Presence/callability are LinkErrors; the KIND is enforced only
  // for BigInt; every other JS kind coerces silently, and the DOCUMENTED
  // silent outcomes are asserted as tests too, so a future engine that
  // starts enforcing them goes red HERE.
  async function buildWallClockOnly(): Promise<Uint8Array> {
    const { ModuleBuilder, F64: F64M } = await import("../src/backend/wasm/module.js");
    const { Code } = await import("../src/backend/wasm/code.js");
    const mb = new ModuleBuilder();
    const wc = mb.importFunc("tsinter", "wallClock", mb.funcType([], [F64M]));
    const fn = mb.declareFunc(mb.funcType([], [F64M]), "%test.read");
    const c = new Code();
    c.call(wc);
    mb.setBody(fn, [], c.bytes());
    mb.exportFunc("_start", fn);
    mb.ensureMemory(1);
    return mb.emit();
  }
  test("missing wallClock -> LinkError (function import requires a callable)", async () => {
    const bytes = await buildWallClockOnly();
    await expect(WebAssembly.instantiate(bytes, { tsinter: {} })).rejects.toBeInstanceOf(WebAssembly.LinkError);
  });
  test("namespace absent -> TypeError", async () => {
    const bytes = await buildWallClockOnly();
    await expect(WebAssembly.instantiate(bytes, {})).rejects.toBeInstanceOf(TypeError);
  });
  test("wallClock returns a BigInt -> TypeError AT THE CALL, not at instantiation", async () => {
    const bytes = await buildWallClockOnly();
    const { instance } = await WebAssembly.instantiate(bytes, { tsinter: { wallClock: () => 1n } });
    expect(() => (instance.exports["_start"] as () => number)()).toThrow(TypeError);
  });
  test("DOCUMENTED silent outcomes: a numeric-string host is INDISTINGUISHABLE from a correct one; null->0; undefined/non-numeric-string->NaN", async () => {
    const bytes = await buildWallClockOnly();
    const start = (imports: Record<string, unknown>) =>
      WebAssembly.instantiate(bytes, { tsinter: imports }).then(
        ({ instance }) => (instance.exports["_start"] as () => number)(),
      );
    expect(await start({ wallClock: () => "1700000000000" })).toBe(1700000000000);
    expect(await start({ wallClock: () => null })).toBe(0);
    expect(await start({ wallClock: () => undefined })).toBeNaN();
    expect(await start({ wallClock: () => "not a number" })).toBeNaN();
  });
});
