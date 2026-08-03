/* The wasm backend end to end, without the corpus: compile a small
 * program, validate the binary, instantiate it against the abi.ts host
 * contract, and compare output byte for byte. The corpus harness
 * (tests/harness/wasm-differential.test.ts) is the real conformance gate;
 * this exists for sub-second feedback while working on the emitter, and
 * to pin the artifact contract (the import/export names, the refusal
 * shape) at the API level. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function buildWasm(name: string, source: string) {
  const entry = join(scratch, name);
  await writeFile(entry, source);
  return compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
}

async function runWasm(modulePath: string): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]) };
}

/** S007's bridge shape: run to an EXPECTED trap, returning the output
 * that preceded it. A run that completes is the failure here — the
 * program under test must trap. */
async function runWasmToTrap(modulePath: string): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  const trap = await Promise.resolve()
    .then(() => (instance.exports["_start"] as () => void)())
    .then(
      () => null,
      (err: unknown) => err,
    );
  expect(trap).toBeInstanceOf(WebAssembly.RuntimeError);
  return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]) };
}

test("hello world compiles, validates, and runs byte-exactly", async () => {
  const res = await buildWasm("hello.ts", 'console.log("hello world");\n');
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(res.backend).toBe("wasm");
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout, stderr } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("hello world\n");
  expect(stderr.length).toBe(0);
});

test("the claimed surface: strings, bools, calls, if/else, console.error", async () => {
  const res = await buildWasm(
    "surface.ts",
    [
      "function greet(name: string): string {",
      "  return name;",
      "}",
      'const who: string = "world";',
      "const yes: boolean = true;",
      "if (yes) {",
      '  console.log("hello", greet(who), true, false);',
      "} else {",
      '  console.log("never");',
      "}",
      "console.log();",
      'console.error("oops", "π ✓");',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout, stderr } = await runWasm(res.binaryPath);
  // Node's formatting: args joined with one space, newline, true/false.
  expect(stdout.toString("utf8")).toBe("hello world true false\n\n");
  expect(stderr.toString("utf8")).toBe("oops π ✓\n");
});

test("scalar runtime: fmod, ToInt32, and string ops match Node bit-for-bit", async () => {
  // Numbers can't PRINT yet (toString is the next increment), so every
  // expectation routes through a comparison — which is exactly what pins
  // the hand-emitted helpers: fmod (musl port) and toInt32 (exponent
  // surgery; i64.trunc_sat would saturate where JS wraps).
  const res = await buildWasm(
    "scalars.ts",
    [
      "function check(name: string, ok: boolean): void {",
      '  console.log(name, ok ? "ok" : "FAIL");',
      "}",
      "const big: number = 3700000000;",
      "const twoPow53: number = 9007199254740992;",
      'check("fmod", 7.5 % 2 === 1.5 && -8 % 3 === -2 && 3 % 5 === 3 && 5.5 % -2 === 1.5);',
      "const nan: number = big - big + 0 / 0;",
      'check("fmod-nan", !(nan % 2 === nan % 2) && !(5 % (big - big) === 5 % (big - big)));',
      'check("toInt32-wrap", (big | 0) === -594967296 && (twoPow53 | 0) === 0 && (1e300 | 0) === 0);',
      'check("toInt32-neg", (-big | 0) === 594967296 && (~5) === -6);',
      'check("shifts", (1 << 31) === -2147483648 && (-1 >>> 0) === 4294967295 && (-8 >> 1) === -4);',
      'check("nan-compare", !(nan < 1) && !(nan > 1) && !(nan === nan));',
      'const s: string = "con" + "cat";',
      'check("strings", s === "concat" && "apple" < "banana" && "a" < "ab" && !(s !== "concat"));',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["fmod ok", "fmod-nan ok", "toInt32-wrap ok", "toInt32-neg ok", "shifts ok", "nan-compare ok", "strings ok", ""].join("\n"),
  );
});

test("UTF-16 fidelity: astral output, lone surrogates, S005 ordering", async () => {
  // Strings store UTF-16 code units (SEMANTICS.md S002): lone surrogates
  // keep their identity in storage — only the WRITE boundary replaces
  // them with U+FFFD, exactly like Node's stdout — and a supplementary
  // character round-trips as one 4-byte UTF-8 sequence. Comparisons are
  // runtime-computed so the frontend can't constant-fold them.
  const res = await buildWasm(
    "utf16.ts",
    [
      'const astral: string = "𝄞 clef 🎼";',
      "console.log(astral);",
      'const lone: string = "\\uD800";',
      'const repl: string = "\\uFFFD";',
      'console.log("lone keeps identity:", lone !== repl, lone === "\\uD800");',
      "console.log(lone);",
      // S005: code-point order sorts U+1D11E ABOVE U+E000 (JS's unit
      // order would answer the opposite — the documented divergence).
      'const supplementary: string = "\\uD834\\uDD1E";',
      'const privateUse: string = "\\uE000";',
      'console.log("S005 code-point order:", privateUse < supplementary);',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["𝄞 clef 🎼", "lone keeps identity: true true", "�", "S005 code-point order: true", ""].join("\n"),
  );
});

test("unions: tags, unit singletons, equality (strict and SameValue), console", async () => {
  // The tagged shared-base representation end to end: wrap/narrow through
  // typeof narrowing, unit-arm tests (unionIsTag), nullish's tag test
  // against ToBoolean's value test, per-union equality — f64 arms by
  // value (strict: NaN !== NaN, +0 === -0; SameValue flips both), ref
  // arms by identity — and console's per-union formatting incl. the -0
  // inspect-ism (insp.f64).
  const res = await buildWasm(
    "unions.ts",
    [
      "function num(x: number): number | undefined {",
      "  return x < -1000 ? undefined : x;",
      "}",
      "console.log(num(5), num(-2000), num(-0), num(0 / 0));",
      "const a = num(3);",
      "const b = num(3);",
      'console.log("eq-by-value:", a === b, a !== b);',
      "const n1 = num(0 / 0);",
      "const n2 = num(0 / 0);",
      'console.log("nan:", n1 === n2, Object.is(n1, n2));',
      'console.log("zeros:", num(0) === num(-0), Object.is(num(0), num(-0)));',
      "let s: string | null = null;",
      'console.log(s ?? "was-null", s === null);',
      's = "";',
      // ?? passes "" through (tag test); || takes the default (ToBoolean).
      'console.log(s ?? "was-null", s || "empty", s === null);',
      "const r1 = { v: 1 };",
      "const r2 = { v: 1 };",
      "function pick(r: { v: number } | null): { v: number } | null { return r; }",
      'console.log("ref-identity:", pick(r1) === pick(r1), pick(r1) === pick(r2));',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "5 undefined -0 NaN",
      "eq-by-value: true false",
      "nan: false true",
      "zeros: true false",
      "was-null true",
      " empty false",
      "ref-identity: true false",
      "",
    ].join("\n"),
  );
});

test("unions: discriminant dispatch, optional chains, templates, pop/shift", async () => {
  const res = await buildWasm(
    "unions2.ts",
    [
      'type Shape = { kind: "circle"; r: number } | { kind: "square"; s: number };',
      "function area(sh: Shape): number {",
      '  return sh.kind === "circle" ? 3 * sh.r * sh.r : sh.s * sh.s;',
      "}",
      'console.log(area({ kind: "circle", r: 2 }), area({ kind: "square", s: 3 }));',
      "function conf(on: boolean): { port: number } | undefined {",
      "  return on ? { port: 8080 } : undefined;",
      "}",
      // The chain short-circuits WITHOUT evaluating the body: undefined.
      "console.log(conf(true)?.port, conf(false)?.port);",
      "const u: string | undefined = conf(false)?.port === 1 ? \"x\" : undefined;",
      "console.log(`tmpl=${u}`);",
      "const nums = [1, 2, 3];",
      "console.log(nums.pop(), nums.shift(), nums.length, nums[0]);",
      "const empty: string[] = [];",
      "console.log(empty.shift());",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["12 9", "8080 undefined", "tmpl=undefined", "3 1 1 2", "undefined", ""].join("\n"),
  );
});

test("S007: an uncaught throw exits through the _start trap", async () => {
  // The exception protocol evaluates every thrown value (error.new is a
  // real in-tier construction now); nothing catches these, so the
  // pending cell survives to _start's check and the trap reports
  // Node's uncaught exit — with all prior output flushed.
  const lit = await buildWasm("throw-lit.ts", ['console.log("before");', 'throw new Error("boom");', ""].join("\n"));
  if (!lit.ok) throw new Error(`refused: ${lit.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(lit.binaryPath))).toBe(true);
  const litRun = await runWasmToTrap(lit.binaryPath);
  expect(litRun.stdout.toString("utf8")).toBe("before\n");

  // An effectful thrown expression evaluates in Node's order FIRST — its
  // side effects land before the trap.
  const eff = await buildWasm(
    "throw-effect.ts",
    [
      "function boom(): string {",
      '  console.log("side effect first");',
      '  return "thrown";',
      "}",
      'console.log("before");',
      "throw boom();",
      "",
    ].join("\n"),
  );
  if (!eff.ok) throw new Error(`refused: ${eff.diagnostics[0]?.message}`);
  const effRun = await runWasmToTrap(eff.binaryPath);
  expect(effRun.stdout.toString("utf8")).toBe("before\nside effect first\n");
});

test("string intrinsics: UTF-16-exact surface, surrogate fidelity", async () => {
  // The faithful-storage wins ride along: split("") of an astral char
  // yields the two REAL lone halves (upstream's U+FFFD divergence is
  // gone with the UTF-8 storage that forced it), pad truncation keeps
  // the lone high half, and isWellFormed is a real scan where the C
  // runtime answers its storage invariant's constant.
  const res = await buildWasm(
    "strings.ts",
    [
      'const s = "Hello, World";',
      "console.log(s.length, s.charAt(4), s.charCodeAt(4), s.charCodeAt(99));",
      'console.log(s.indexOf("o"), s.indexOf("o", 5), s.indexOf(""), s.includes("o", 9), s.startsWith("Hell"), s.endsWith("rld"));',
      "console.log(s.slice(-5), s.slice(7, 2), s.substring(7, 2), s.substring(-3, 5));",
      'console.log("ab".repeat(3), "  x\\t ".trim(), " y ".trimStart(), " y ".trimEnd());',
      'console.log("a,b,,c".split(",").join("|"), "abc".split("").join("-"), "".split("x").length);',
      'const units = "a\\u{1D11E}b".split("");',
      "console.log(units.length, units[1].charCodeAt(0), units[2].charCodeAt(0));",
      'console.log("5".padStart(3, "0"), "5".padEnd(4, "ab"), "x".padStart(4, "\\u{1D11E}").charCodeAt(2));',
      'console.log("x\\uD834y".isWellFormed(), "ok".isWellFormed(), "x\\uD834y".toWellFormed().charCodeAt(1));',
      'let steps = "";',
      'for (const ch of "a\\u{1D11E}b") steps += ch.length.toString();',
      "console.log(steps);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "12 o 111 NaN",
      "4 8 0 false true true",
      "World  llo,  Hello",
      "ababab x y   y",
      "a|b||c a-b-c 1",
      "4 55348 56606",
      "005 5aba 55348",
      "false true 65533",
      "121",
      "",
    ].join("\n"),
  );
});

test("exception protocol: catch, finally paths, rethrow, TDZ", async () => {
  const res = await buildWasm(
    "exceptions.ts",
    [
      "function boom(k: number): number {",
      '  if (k === 1) throw "s";',
      "  if (k === 2) throw 41;",
      '  if (k === 3) throw new TypeError("t");',
      "  return 7;",
      "}",
      "for (const k of [0, 1, 2, 3]) {",
      "  try {",
      '    console.log("ok", boom(k));',
      "  } catch (e) {",
      '    if (typeof e === "string") console.log("str", e);',
      '    else if (typeof e === "number") console.log("num", e + 1);',
      "    else console.log(e instanceof TypeError, e instanceof RangeError, e instanceof Error);",
      "  }",
      "}",
      "function via(): number {",
      "  try {",
      "    return 10;",
      "  } finally {",
      '    console.log("fin-return");',
      "  }",
      "}",
      "console.log(via());",
      "try {",
      "  try {",
      '    throw "inner";',
      "  } finally {",
      '    console.log("fin-exc");',
      "  }",
      "} catch (e) {",
      '  console.log("propagated", typeof e === "string");',
      "}",
      "try {",
      "  try {",
      "    throw 1;",
      "  } catch (e) {",
      "    throw e;",
      "  }",
      "} catch (e2) {",
      '  if (typeof e2 === "number") console.log("rethrown", e2);',
      "}",
      "function make(): () => number {",
      "  const get = (): number => later;",
      "  try {",
      "    console.log(get());",
      "  } catch (e) {",
      '    console.log("tdz caught");',
      "  }",
      "  const later = 42;",
      "  return get;",
      "}",
      "console.log(make()());",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "ok 7",
      "str s",
      "num 42",
      "true false true",
      "fin-return",
      "10",
      "fin-exc",
      "propagated true",
      "rethrown 1",
      "tdz caught",
      "42",
      "",
    ].join("\n"),
  );
});

test("S009: a checked cast on a catch binding validates, it does not erase", async () => {
  // No corpus program can pin this: Node erases `as`, so `(e as Error)`
  // on a thrown string answers `undefined` there while every backend here
  // throws the catchable TypeError. The passing half rides the corpus.
  const res = await buildWasm(
    "caught-check.ts",
    [
      "function msgOf(v: string | number): string {",
      "  try {",
      '    if (typeof v === "string") throw v;',
      '    throw new RangeError("r" + v);',
      "  } catch (e) {",
      "    return (e as Error).message;",
      "  }",
      "}",
      "console.log(msgOf(1));",
      "try {",
      '  console.log(msgOf("nope"));',
      "} catch (e) {",
      '  if (e instanceof TypeError) console.log(e.name + ": " + e.message);',
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["r1", "TypeError: caught value is not an instance of Error (checked cast)", ""].join("\n"),
  );
});

test("S008: repeat's invalid count is the RangeError trap", async () => {
  const res = await buildWasm(
    "repeat-neg.ts",
    ['console.log("pre");', 'console.log("x".repeat(-1));', ""].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const run = await runWasmToTrap(res.binaryPath);
  expect(run.stdout.toString("utf8")).toBe("pre\n");
});

test("strIntrinsic: the lre-backed case pair refuses by member", async () => {
  const res = await buildWasm("lower.ts", 'console.log("AbC".toLowerCase());\n');
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
  expect(res.wasmSurvey).toContain("strIntrinsic:toLowerCase");
});

test("out-of-tier constructs refuse with SC3001 and ride the survey", async () => {
  // Regex — a whole engine — sits far past every near-term increment, so
  // this example won't rot into the tier the way arithmetic and arrays
  // did. If it ever compiles, congratulations: pick whatever is furthest
  // out then.
  const res = await buildWasm("refused.ts", 'const re = /a+b/; console.log(re.test("aab"));\n');
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
  expect(res.wasmSurvey).toBeDefined();
  expect(res.wasmSurvey).toContain("expr:regexLit");
});
