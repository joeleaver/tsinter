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
import { I32, ModuleBuilder } from "../src/backend/wasm/module.js";

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

test("S009: `as` on an unknown value validates, and the failure names the path", async () => {
  // Same inherited divergence one layer out: Node erases `u as number`
  // and hands the string straight through, so NO corpus program can pin
  // these texts. The contract they DO have is byte-parity with the C
  // emitter's scr_dyn_check_fail — "expected <want> at <path>, got
  // <kind>", where the path is the root `$` for a scalar target and the
  // kind noun comes from scr_dyn_kind_name (null is "null", a unit is
  // "undefined"). Verified against a C-lane build of this same program.
  const res = await buildWasm(
    "dyn-check-fail.ts",
    [
      "function asNum(u: unknown): number { return u as number; }",
      "function asStr(u: unknown): string { return u as string; }",
      "function asBool(u: unknown): boolean { return u as boolean; }",
      "console.log(asNum(7), asStr(\"s\"), asBool(true));",
      "const bad: string[] = [];",
      'try { asNum("seven"); } catch (e) { if (e instanceof TypeError) bad.push(e.name + ": " + e.message); }',
      "try { asStr(1); } catch (e) { if (e instanceof TypeError) bad.push(e.message); }",
      "try { asBool(undefined); } catch (e) { if (e instanceof TypeError) bad.push(e.message); }",
      "try { asNum(null); } catch (e) { if (e instanceof TypeError) bad.push(e.message); }",
      "for (const b of bad) console.log(b);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "7 s true",
      "TypeError: expected number at $, got string",
      "expected string at $, got number",
      "expected boolean at $, got undefined",
      "expected number at $, got null",
      "",
    ].join("\n"),
  );
});

test("S009: a composite `as` names the PATH it failed at", async () => {
  // Same no-oracle situation as the scalar case, one layer down: Node
  // erases the cast entirely, so only the C emitter's texts can be the
  // contract. What is worth pinning here is the PATH grammar — `$` at the
  // root, `.key` per object step, `[i]` per array step — because it is
  // built from heap nodes threaded through the walkers, and a wrong
  // parent link produces a plausible-looking but wrong path. Verified
  // against a C-lane build of this same program.
  const res = await buildWasm(
    "dyn-check-path.ts",
    [
      "type Item = { name: string; price: number };",
      "type Order = { id: string; items: Item[] };",
      "function toU(o: unknown): unknown { return o; }",
      "function asOrder(u: unknown): Order { return u as Order; }",
      "function msg(build: () => void): void {",
      "  try { build(); console.log('no throw'); }",
      "  catch (e) { if (e instanceof TypeError) console.log(e.message); else console.log('other'); }",
      "}",
      "const good: Order = { id: 'o1', items: [{ name: 'a', price: 1 }] };",
      "console.log(asOrder(toU(good)).items[0].price);",
      "type BadA = { id: string; items: { name: string; price: string }[] };",
      "msg(() => { asOrder(toU({ id: 'o2', items: [{ name: 'a', price: 'x' }] } as BadA)); });",
      "type BadB = { id: string; items: { name: string }[] };",
      "msg(() => { asOrder(toU({ id: 'o3', items: [{ name: 'a' }] } as BadB)); });",
      "msg(() => { asOrder(toU('nope')); });",
      "type BadC = { id: string; items: number };",
      "msg(() => { asOrder(toU({ id: 'o4', items: 3 } as BadC)); });",
      "type Pair = [string, number];",
      "function asPair(u: unknown): Pair { return u as Pair; }",
      "msg(() => { asPair(toU(['a', 1, 2] as [string, number, number])); });",
      "msg(() => { asPair(toU(['a', 'b'] as [string, string])); });",
      // Two bad fields at once: WHICH one the message names is the
      // check walker's iteration order, and it must be the shape's
      // CANONICAL (sorted) order — what the C and LLVM walkers use — not
      // the declared spelling. Declared order here is z, a; canonical is
      // a, z, so the answer is "$.a". Iterating declared order made this
      // lane name a different field than the native ones.
      "type Ord = { z: number; a: number };",
      "function asOrd(u: unknown): Ord { return u as Ord; }",
      "msg(() => { asOrd(toU({ z: 'bad', a: 'bad' })); });",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "1",
      "expected number at $.items[0].price, got string",
      // A MISSING key reports exactly like a present one holding
      // undefined — the walker passes a null `got` and kindName's null
      // arm answers "undefined".
      "expected number at $.items[0].price, got undefined",
      "expected object at $, got string",
      "expected array at $.items, got number",
      // Arity failures carry their own message: the element type is not
      // what went wrong.
      "expected array of length 2 at $, got array",
      "expected number at $[1], got string",
      "expected number at $.a, got string",
      "",
    ].join("\n"),
  );
});

test("dyn: ToBoolean over every constructible kind", async () => {
  // The truthiness ladder (scr_dyn_truthy) reached the only way a source
  // can reach it — a JS-lane implicit-any binding in a condition, since
  // TypeScript sources are fenced to "validate with `as` first". Node IS
  // the oracle for the answers; no claimed corpus program exercises the
  // ladder, and the -0/NaN arms are exactly the ones a naive `!= 0` gets
  // wrong.
  const res = await buildWasm(
    "dyn-truthy.js",
    [
      'function t(u) { return u ? "y" : "n"; }',
      'console.log(t(0) + t(-0) + t(NaN) + t(1) + t("") + t("a") + t(undefined) + t(null) + t(true) + t(false));',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("nnnynynnyn\n");
});

test("dyn: String(unknown) is Array.prototype.toString, not the JSON writer", async () => {
  // Node IS the oracle for these, but no claimed corpus program walks the
  // arms that are easy to get wrong: a null or undefined ELEMENT renders
  // EMPTY (while the same value at the TOP level spells itself out), and
  // nested arrays FLATTEN through the recursion rather than bracketing.
  // The number arm is String()'s, not the serializer's — NaN and Infinity
  // spell out where JSON would write null.
  const res = await buildWasm(
    "dyn-tostring.js",
    [
      "function s(u) { return String(u); }",
      "console.log(s(undefined), s(null), s(true), s(false));",
      "console.log(s(0), s(-0), s(NaN), s(Infinity), s(-Infinity), s(1e21), s(0.1));",
      "console.log(s('plain'));",
      "console.log(s([1, 2, 3]));",
      "console.log(s([1, null, 3, undefined, 5]));",
      "console.log(s([[1, 2], [3, [4, 5]]]));",
      "console.log(s([]));",
      "console.log(s({ a: 1 }));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "undefined null true false",
      "0 0 NaN Infinity -Infinity 1e+21 0.1",
      "plain",
      "1,2,3",
      "1,,3,,5",
      "1,2,3,4,5",
      "",
      "[object Object]",
      "",
    ].join("\n"),
  );
});

test("JSON.parse: syntax errors carry V8's texts, not the C runtime's", async () => {
  // These ARE Node-observable (a catch binding reads e.message), so Node is
  // the oracle and the C runtime's approximation — which matches V8 in 4 of
  // 18 of these cases — is not inherited. No corpus program pins them:
  // 1004 deliberately catches bindingless. Every expectation below was
  // captured from Node itself.
  const res = await buildWasm(
    "json-errors.ts",
    [
      "const cases: string[] = [",
      "  '', '[', '{', '[1,]', '{\"a\":}', '{a:1}', '[01]', '[1.]', '[1e]', '[-]',",
      "  '\"abc', '\"a\\\\qb\"', '{\"a\" 1}', '[1 2]', '1 2', '{}extra',",
      "  '[1,2,3,4,5,6,7,8,9,10,11,12,13,x]', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaax',",
      "  'NaN', 'undefined', '\"\\\\u00zz\"', '{\"a\"', '[1',",
      // A post-comma key failure is a DIFFERENT V8 sentence from a
      // first-key one, and the leading ellipsis is gated on the POSITION
      // reaching the window radius rather than on the clamped window
      // start — they differ only at exactly pos == 10, which is this
      // input. Both were parity misses the first pass shipped.
      "  '{\"a\":1,}', '{\"a\":1,2}', '[\"aaaaaa\",@,\"aaaaaa\"]',",
      "];",
      "for (const c of cases) {",
      "  try { JSON.parse(c); console.log('OK'); }",
      "  catch (e) { if (e instanceof Error) console.log(e.name + ': ' + e.message); else console.log('non-error'); }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "SyntaxError: Unexpected end of JSON input",
      "SyntaxError: Unexpected end of JSON input",
      "SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)",
      `SyntaxError: Unexpected token ']', "[1,]" is not valid JSON`,
      `SyntaxError: Unexpected token '}', "{"a":}" is not valid JSON`,
      "SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)",
      "SyntaxError: Unexpected number in JSON at position 2 (line 1 column 3)",
      "SyntaxError: Unterminated fractional number in JSON at position 3 (line 1 column 4)",
      "SyntaxError: Exponent part is missing a number in JSON at position 3 (line 1 column 4)",
      "SyntaxError: No number after minus sign in JSON at position 2 (line 1 column 3)",
      "SyntaxError: Unterminated string in JSON at position 4 (line 1 column 5)",
      "SyntaxError: Bad escaped character in JSON at position 3 (line 1 column 4)",
      "SyntaxError: Expected ':' after property name in JSON at position 5 (line 1 column 6)",
      "SyntaxError: Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)",
      "SyntaxError: Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)",
      "SyntaxError: Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)",
      // The snippet window: whole input at <=20 units, else +/-10 around the
      // offending position with an ellipsis on whichever side was cut.
      `SyntaxError: Unexpected token 'x', ...",11,12,13,x]" is not valid JSON`,
      `SyntaxError: Unexpected token 'a', "aaaaaaaaaa"... is not valid JSON`,
      // The three JS literals that look like values get V8's bare form —
      // but only as the WHOLE input, which is why these have no prefix.
      `SyntaxError: "NaN" is not valid JSON`,
      `SyntaxError: "undefined" is not valid JSON`,
      "SyntaxError: Bad Unicode escape in JSON at position 5 (line 1 column 6)",
      // A structural expectation fires even at end of input; only a missing
      // VALUE reports "Unexpected end of JSON input".
      "SyntaxError: Expected ':' after property name in JSON at position 4 (line 1 column 5)",
      "SyntaxError: Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)",
      "SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
      "SyntaxError: Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
      `SyntaxError: Unexpected token '@', ..."["aaaaaa",@,"aaaaaa""... is not valid JSON`,
      "",
    ].join("\n"),
  );
});

test("S002: JSON.parse keeps lone surrogates, unlike the native lanes' U+FFFD", async () => {
  // The tier stores UTF-16 code units, so a \\u escape appends its unit
  // verbatim: a pair written as two escapes combines, and an unpaired half
  // survives — which is Node's answer. The C runtime substitutes U+FFFD
  // here as a house policy; S002 says that class is removed, not inherited,
  // so no corpus program can cover it (the native lanes disagree).
  const res = await buildWasm(
    "json-surrogates.ts",
    [
      "const lone = JSON.parse('\"\\\\ud800\"') as string;",
      "console.log(lone.length, lone.charCodeAt(0));",
      "const pair = JSON.parse('\"\\\\ud83d\\\\ude00\"') as string;",
      "console.log(pair.length, pair.charCodeAt(0), pair.charCodeAt(1));",
      "const mixed = JSON.parse('\"a\\\\udc00b\"') as string;",
      "console.log(mixed.length, mixed.charCodeAt(1));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["1 55296", "2 55357 56832", "3 56320", ""].join("\n"));
});

test("S013: JSON.parse's depth cap is 1000 and throws a CATCHABLE RangeError", async () => {
  // The boundary's first pin on any lane. Node has no cap at all, so this
  // is the divergence S013 registers; what a corpus program could never
  // show is that the failure is CATCHABLE — it goes through the exception
  // cell, unlike the S003/S006/S008 trap family.
  const res = await buildWasm(
    "json-depth.ts",
    [
      "function nest(n: number): string { return '['.repeat(n) + ']'.repeat(n); }",
      "JSON.parse(nest(1000));",
      "console.log('parsed 1000');",
      "try { JSON.parse(nest(1001)); console.log('no throw'); }",
      "catch (e) { if (e instanceof RangeError) console.log('RangeError: ' + e.message); else console.log('wrong kind'); }",
      "console.log('still running');",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["parsed 1000", "RangeError: Maximum call stack size exceeded", "still running", ""].join("\n"),
  );
});

test("JSON.parse numbers are correctly rounded on both paths", async () => {
  // This was 2b-i's trap-boundary pin; 2b-ii flipped its second half from
  // "traps" to Node's value. The two paths are Clinger's fast path (exact
  // for <=15 significant digits with |exp10| <= 22) and Simple Decimal
  // Conversion for everything else. Which path a given input takes is not
  // observable from a program — only the value is — so both halves assert
  // Node's answer and the split is a performance boundary, not a semantic
  // one. The 100k round-trip fuzz is the real gate; this pins the edges a
  // reader would want to see named.
  const ok = await buildWasm(
    "json-num-fast.ts",
    [
      "const xs: number[] = [",
      "  JSON.parse('0') as number, JSON.parse('-0') as number, JSON.parse('42') as number,",
      "  JSON.parse('-2.5') as number, JSON.parse('3e2') as number, JSON.parse('1e-7') as number,",
      "  JSON.parse('123456789012345') as number,", // 15 significant digits
      "  JSON.parse('1e22') as number, JSON.parse('1e-22') as number,",
      "];",
      "for (const x of xs) console.log(x);",
      "",
    ].join("\n"),
  );
  if (!ok.ok) throw new Error(`refused: ${ok.diagnostics[0]?.message}`);
  const fast = await runWasm(ok.binaryPath);
  expect(fast.stdout.toString("utf8")).toBe(
    // console.log(-0) prints "-0": that is util.inspect's rendering, not
    // String(-0) — the same inspect-ism %w.inspF64 exists for.
    ["0", "-0", "42", "-2.5", "300", "1e-7", "123456789012345", "1e+22", "1e-22", ""].join("\n"),
  );

  // Past Clinger's cap, so Simple Decimal Conversion answers. The four
  // input classes: digit count, exponent overflow/underflow, a short
  // mantissa with an out-of-range exponent, and the subnormal band.
  const slow = await buildWasm(
    "json-num-slow.ts",
    [
      "const xs: number[] = [",
      "  JSON.parse('1234567890123456') as number,",       // 16 digits
      "  JSON.parse('12345678901234567') as number,",      // 17
      "  JSON.parse('3.141592653589793') as number,",
      "  JSON.parse('0.30000000000000004') as number,",
      "  JSON.parse('9007199254740993') as number,",
      "  JSON.parse('1e999') as number,",                  // overflow
      "  JSON.parse('-1e999') as number,",
      "  JSON.parse('1e-999') as number,",                 // underflow
      "  JSON.parse('1e30') as number,",                   // short mantissa, |exp| > 22
      "  JSON.parse('5e-324') as number,",                 // smallest subnormal
      "  JSON.parse('2.2250738585072014e-308') as number,",
      "  JSON.parse('1.7976931348623157e308') as number,",
      "  JSON.parse('1.' + '9'.repeat(100)) as number,",   // past the digit buffer
      "];",
      "for (const x of xs) console.log(x);",
      "",
    ].join("\n"),
  );
  if (!slow.ok) throw new Error(`refused: ${slow.diagnostics[0]?.message}`);
  const run = await runWasm(slow.binaryPath);
  expect(run.stdout.toString("utf8")).toBe(
    [
      "1234567890123456",
      "12345678901234568",
      "3.141592653589793",
      "0.30000000000000004",
      "9007199254740992",
      "Infinity",
      "-Infinity",
      "0",
      "1e+30",
      "5e-324",
      "2.2250738585072014e-308",
      "1.7976931348623157e+308",
      "2",
      "",
    ].join("\n"),
  );
});

/** `m * 2^e` as an exact decimal string (m * 2^-k = m * 5^k / 10^k). */
function exactBinary(m: bigint, e: number): string {
  if (m === 0n) return "0";
  const neg = m < 0n;
  const mag = neg ? -m : m;
  let out: string;
  if (e >= 0) {
    out = (mag << BigInt(e)).toString();
  } else {
    const k = -e;
    let d = (mag * 5n ** BigInt(k)).toString();
    if (d.length <= k) d = "0".repeat(k - d.length + 1) + d;
    out = (d.slice(0, d.length - k) + "." + d.slice(d.length - k)).replace(/\.?0+$/, "");
  }
  return (neg ? "-" : "") + out;
}

/** The exact midpoint between `x` and the next double away from zero. */
function midpointOf(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(x);
  const bits = b.readBigUInt64LE();
  const expo = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  const m = expo === 0 ? frac : frac | (1n << 52n);
  const e = expo === 0 ? -1074 : expo - 1075;
  // The sign bit is masked out of the extraction above, so reapply it —
  // without this every generated midpoint is positive and the negative
  // half of the tie path goes untested by this generator.
  return (bits >> 63n ? "-" : "") + exactBinary(2n * m + 1n, e - 1);
}

/* ── JSON.parse's decimal->binary direction (json.ts) ──────────────────────
 * The inverse of numfmt's Ryu port, gated the same way: random double bit
 * patterns pushed through JSON.stringify and parsed back, asserting BIT
 * equality with Node. Correctly-rounded parsing has no cheap partial
 * credit — a wrong answer is one ULP off and silent — so a generated
 * sweep, not a hand-picked list, is what makes it trustworthy. This runs
 * 20k for suite speed; the landing gate was 100k with zero mismatches. */
test("JSON.parse round-trips random doubles bit-exactly", async () => {
  const N = 20000;
  let seed = 0x2b11n;
  const rnd = (): bigint => {
    seed ^= (seed << 13n) & 0xffffffffffffffffn;
    seed ^= seed >> 7n;
    seed ^= (seed << 17n) & 0xffffffffffffffffn;
    return seed & 0xffffffffffffffffn;
  };
  const buf = Buffer.alloc(8);
  const cases: string[] = [];
  for (let i = 0; i < N; i++) {
    buf.writeBigUInt64LE(rnd());
    const d = buf.readDoubleLE(0);
    if (Number.isFinite(d)) cases.push(JSON.stringify(d));
  }
  // The hard set rides along: both ends of the range, the subnormal band,
  // exact ties, the digit-buffer clamp, exponent overflow and underflow.
  cases.push(
    "5e-324", "1e-323", "2.2250738585072014e-308", "1.7976931348623157e308",
    "1e308", "1e309", "1e999", "1e-999", "1e22", "1e23", "1e30",
    "0.5", "1.5", "2.5", "9007199254740993", "12345678901234567",
    "1." + "9".repeat(100), "0." + "0".repeat(320) + "1", "1" + "0".repeat(400),
    "-5e-324", "-1.7976931348623157e308", "-0.1",
  );
  // TRUE MIDPOINTS — the cases the round-trip sweep above structurally
  // CANNOT reach. JSON.stringify emits the shortest form that round-trips,
  // and a shortest form is never an exact tie: if it were, a shorter
  // string would have named the same double. So every exact
  // round-half-even decision is invisible to a round-trip fuzz, which is
  // precisely where a rounding bug hides. These are generated instead:
  // decompose a double into m * 2^e and render (2m+1) * 2^(e-1) exactly,
  // which is the midpoint between it and its successor.
  for (let i = 0; i < 3000; i++) {
    buf.writeBigUInt64LE(rnd());
    const d = buf.readDoubleLE(0);
    if (!Number.isFinite(d) || d === 0) continue;
    cases.push(midpointOf(d));
  }
  // ...including the one that made this generator necessary: exactly
  // 2^-1075, the midpoint between zero and the smallest subnormal, whose
  // tie test has no preceding digit at all.
  cases.push(exactBinary(1n, -1075));
  for (const m of [1n, 2n, 3n]) cases.push(exactBinary(2n * m + 1n, -1075));
  // Strictly above that tie by one digit past the buffer: the sticky bit
  // is the only thing that can tell them apart.
  cases.push(exactBinary(1n, -1075) + "0".repeat(150) + "1");
  const res = await buildWasm(
    "json-fuzz.ts",
    "const cases: string[] = [\n" +
      cases.map((c) => "  " + JSON.stringify(c) + ",").join("\n") +
      "\n];\nfor (const c of cases) console.log(JSON.parse(c) as number);\n",
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const got = (await runWasm(res.binaryPath)).stdout.toString("utf8").split("\n");
  const bad: string[] = [];
  cases.forEach((c, i) => {
    const v = JSON.parse(c) as number;
    // console.log renders -0 as "-0" (the inspect-ism String() lacks).
    const want = Object.is(v, -0) ? "-0" : String(v);
    if (got[i] !== want) bad.push(`${c}: wasm ${got[i]} vs node ${want}`);
  });
  expect(bad.slice(0, 10)).toEqual([]);
});

test("JSON.parse: exact round-half-even ties, including the one with no preceding digit", async () => {
  // Named rather than left inside the sweep because one of them is a
  // REGRESSION FENCE: exactly 2^-1075 — the midpoint between zero and the
  // smallest subnormal — reaches the tie test with no digit before the
  // rounding position, and the unguarded read of that digit was an
  // uncatchable abort on untrusted input. Node answers 0 (half-even, and
  // zero is even). The others are the first subnormal midpoints, correct
  // before the fix, which is exactly what makes them a fence.
  const ties = [
    exactBinary(1n, -1075), // 0
    exactBinary(3n, -1075), // 1e-323  (1.5 units -> 2, even)
    exactBinary(5n, -1075), // 1e-323  (2.5 units -> 2, even)
    exactBinary(7n, -1075), // 2e-323  (3.5 units -> 4, even)
    // Strictly ABOVE the first tie, by a digit far past the 800 the buffer
    // keeps: only the sticky bit distinguishes it, and it must round up.
    exactBinary(1n, -1075) + "0".repeat(150) + "1",
  ];
  const res = await buildWasm(
    "json-ties.ts",
    "const cases: string[] = [\n" +
      ties.map((c) => "  " + JSON.stringify(c) + ",").join("\n") +
      "\n];\nfor (const c of cases) console.log(JSON.parse(c) as number);\n",
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["0", "1e-323", "1e-323", "2e-323", "5e-324", ""].join("\n"));
});

test("JSON.parse: trailing garbage after a complete number reports cleanly", async () => {
  // The reject-before-value class. The number token is grammatical, so its
  // value is genuinely computed to build the box; what matters is that the
  // CALLER then reports the garbage rather than the number path failing
  // first. While the fallback trapped, this whole class aborted instead.
  const res = await buildWasm(
    "json-num-garbage.ts",
    [
      "for (const c of ['12345678901234567890@', '1.9999999999999999999x', '1e999!']) {",
      "  try { JSON.parse(c); console.log('OK'); }",
      "  catch (e) { if (e instanceof Error) console.log(e.message); else console.log('non-error'); }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "Unexpected non-whitespace character after JSON at position 20 (line 1 column 21)",
      "Unexpected non-whitespace character after JSON at position 21 (line 1 column 22)",
      "Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)",
      "",
    ].join("\n"),
  );
});

test("S014: crossing the dyn boundary COPIES — mutations do not propagate", async () => {
  // No corpus program can ever pin this, and not for the usual reason: a
  // program whose output depends on the aliasing would DIVERGE from Node
  // and fail the differential by construction. Node erases the casts and
  // hands the same object back, so it prints 3 where every tsinter lane
  // prints 2 — the source mutation lands on an object the extracted value
  // does not share. Reproduced identically on the C lane.
  const res = await buildWasm(
    "dyn-copy.ts",
    [
      "type Box = { n: number; tags: string[] };",
      "function toU(b: Box): unknown { return b; }",
      "function fromU(u: unknown): Box { return u as Box; }",
      "const src: Box = { n: 1, tags: ['a'] };",
      "const u = toU(src);",
      "src.n = 2;", // after the conversion: the dyn tree already copied
      "const out = fromU(u);",
      "out.n = out.n + 1;", // after the extraction: src cannot see this
      "console.log(src.n, out.n);", // Node: 3 3 — here: 2 2
      "const back = fromU(u);",
      "back.tags.push('b');",
      "console.log(src.tags.length, back.tags.length);", // Node: 2 2 — here: 1 2
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["2 2", "1 2", ""].join("\n"));
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

test("classes: a type family that references itself in every direction", async () => {
  // The rec-group span's reason to exist, in one program: `Node.kids` is
  // an ARRAY of the class being declared (the vector's element array
  // reaches back into a type that does not exist yet), `Node.parent` is a
  // UNION arm over it, and `Leaf` subtypes the class whose own field
  // mentions the subtype. None of it can be interned in dependency order.
  // The union field is also read BEFORE any constructor assigns it, which
  // is what `new`'s undefined-arm seed answers for — a null there would
  // trap in the union's truthiness helper instead.
  const res = await buildWasm(
    "classgraph.ts",
    [
      "class Node2 {",
      "  label: string;",
      "  kids: Node2[] = [];",
      "  parent: Node2 | undefined;",
      "  constructor(label: string) { this.label = label; }",
      "  path(): string { return this.parent === undefined ? this.label : this.label; }",
      "}",
      "class Leaf extends Node2 {",
      "  weight: number;",
      "  constructor(label: string, weight: number) { super(label); this.weight = weight; }",
      "}",
      'const root = new Node2("root");',
      'const leaf = new Leaf("leaf", 3);',
      "leaf.parent = root;",
      "root.kids.push(leaf);",
      "const seen: Node2 = leaf;",
      "console.log(root.label, root.kids.length, seen.label, leaf.weight);",
      // The unassigned union field reads back as undefined, not null.
      "console.log(root.parent === undefined, leaf.parent === undefined);",
      "leaf.weight++;",
      "console.log(leaf.weight, seen.path());",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("root 1 leaf 3\ntrue false\n4 leaf\n");
});

test("classes: the EventEmitter family is the last one that refuses", async () => {
  // Both of the rocks that used to sit here are gone: `extends Error`
  // compiles since the error unification made a user subclass an ordinary
  // subtype of the builtin error struct, and throwing a NON-error class
  // compiles since the promise payload gained an interval slot. What is
  // left is the runtime hierarchy whose C prefix embeds registry and
  // stream state this tier has no port of.
  const ee = await buildWasm(
    "extends-ee.ts",
    [
      'import { EventEmitter } from "node:events";',
      "class Bus extends EventEmitter {",
      "  count: number = 0;",
      "}",
      "const b = new Bus();",
      "console.log(b.count);",
      "",
    ].join("\n"),
  );
  expect(ee.ok).toBe(false);
  if (!ee.ok) {
    expect(ee.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
    expect(ee.wasmSurvey).toContain("class:extends-runtime");
  }
});

test("ModuleBuilder: the rec-group span's four guards fail loudly", () => {
  // These are the type-side twin of `declareFunc` without a body, and no
  // corpus program can reach them: a planning walk that skipped work
  // would otherwise serialize a placeholder as an empty struct and let
  // validation blame something unrelated. Pinned directly.
  const outsideSpan = new ModuleBuilder();
  expect(() => outsideSpan.reserveType("class:X")).toThrow(/outside a rec group/);

  const unreserved = new ModuleBuilder();
  unreserved.beginRecGroup();
  const idx = unreserved.reserveType("class:X");
  unreserved.defineType(idx, { kind: "struct", fields: [{ storage: I32, mutable: true }] });
  // Defining twice is the same bug as defining an index nobody claimed.
  expect(() => unreserved.defineType(idx, { kind: "struct", fields: [] })).toThrow(/was not reserved/);

  const live = new ModuleBuilder();
  live.beginRecGroup();
  live.reserveType("class:Y");
  expect(() => live.endRecGroup()).toThrow(/never defined: class:Y/);

  // A reservation that outlives its span cannot reach emit() through
  // endRecGroup, so the emit()-time guard is reached with the span still
  // open — both halves of the same contract.
  const unfinished = new ModuleBuilder();
  unfinished.beginRecGroup();
  unfinished.reserveType("class:Z");
  expect(() => unfinished.emit()).toThrow(/rec group still open/);

  // And the span-closed path: a group that closed cleanly emits.
  const ok = new ModuleBuilder();
  ok.beginRecGroup();
  const a = ok.reserveType("class:A");
  const b = ok.reserveType("class:B");
  // Mutual reference in both directions — the whole point of the span.
  ok.defineType(a, { kind: "struct", fields: [{ storage: { kind: "ref", nullable: true, typeIndex: b }, mutable: true }] });
  ok.defineType(b, { kind: "struct", fields: [{ storage: { kind: "ref", nullable: true, typeIndex: a }, mutable: true }] });
  ok.endRecGroup();
  expect(WebAssembly.validate(ok.emit())).toBe(true);
});

test("classes: preorder intervals answer instanceof across a whole forest", async () => {
  // The corpus exercises instanceof inside single hierarchies; what it
  // cannot pin is that the NUMBERING is right in the shapes where a wrong
  // scheme still looks plausible — a second root (whose interval must not
  // overlap the first's), a three-deep chain (where an ancestor's interval
  // has to span a grandchild), a sibling branch (which must NOT be
  // covered), and a GENERIC family, whose synthetic ancestor is the base
  // of every instantiation so one interval answers for all of them — that
  // is how `new Box<number>()` and `new Box<string>()` are both `instanceof
  // Box`, exactly as JS has one `Box` at runtime.
  const res = await buildWasm(
    "forest.ts",
    [
      'class Base { tag: string = "base"; }',
      "class Mid extends Base { m: number = 1; }",
      "class Deep extends Mid { d: number = 2; }",
      "class Side extends Base { s: number = 3; }",
      "class Root2 { r: number = 0; }",
      "class Root2Sub extends Root2 { z: number = 4; }",
      "class Box<T> extends Base { v: T; constructor(v: T) { super(); this.v = v; } }",
      "function label(x: Base): string {",
      '  if (x instanceof Deep) return "deep";',
      '  if (x instanceof Box) return "box";',
      '  if (x instanceof Mid) return "mid";',
      '  if (x instanceof Side) return "side";',
      '  return "base";',
      "}",
      "const all: Base[] = [new Base(), new Mid(), new Deep(), new Side(),",
      '  new Box<number>(7), new Box<string>("s")];',
      'let acc = "";',
      'for (const x of all) acc += label(x) + ",";',
      "console.log(acc);",
      "const deep: Base = new Deep();",
      // Ancestors true through the whole chain, the sibling branch false.
      "console.log(deep instanceof Base, deep instanceof Mid, deep instanceof Deep, deep instanceof Side);",
      "const other: Root2 = new Root2Sub();",
      "console.log(other instanceof Root2, other instanceof Root2Sub);",
      "const bn: Base = new Box<number>(1);",
      'const bs: Base = new Box<string>("x");',
      "const plain: Base = new Base();",
      // The family interval spans BOTH instantiations and nothing else.
      "console.log(bn instanceof Box, bs instanceof Box, plain instanceof Box);",
      // Reference identity beside it: distinct allocations differ.
      "console.log(bn === bs, bn === bn, deep !== plain);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    "base,mid,deep,side,box,box,\ntrue true true false\ntrue true\ntrue true false\nfalse true true\n",
  );
});

test("classes: dispatch lands on an UNOVERRIDDEN ancestor's implementation", async () => {
  // The case the corpus does not isolate, and the one a subtree-only
  // reachability walk gets wrong: `Dog` declares no `speak`, so a
  // virtualCall on a Dog-typed receiver must land on `%Animal.speak` — an
  // implementation ABOVE the static receiver. It is only reachable at all
  // because a SIBLING (Puppy) overrides, which is what puts `speak` in a
  // slot in the first place; without that the frontend devirtualizes and
  // nothing here runs. Bird overriding both methods pins the adapter path
  // beside it (an override's `this` is narrower than the slot's, so the
  // funcref stored is a cast-and-forward thunk, not the method itself).
  const res = await buildWasm(
    "dispatch.ts",
    [
      "class Animal {",
      "  name: string;",
      "  constructor(n: string) { this.name = n; }",
      '  speak(): string { return this.name + " makes a sound"; }',
      "  legs(): number { return 4; }",
      "}",
      'class Dog extends Animal { constructor() { super("dog"); } }',
      'class Puppy extends Dog { speak(): string { return "yip"; } }',
      "class Bird extends Animal {",
      '  constructor() { super("bird"); }',
      '  speak(): string { return "tweet"; }',
      "  legs(): number { return 2; }",
      "}",
      'const zoo: Animal[] = [new Animal("thing"), new Dog(), new Puppy(), new Bird()];',
      'let out = "";',
      'for (const a of zoo) out += a.speak() + "/" + a.legs() + " ";',
      "console.log(out.trim());",
      // Dispatch through a Dog-typed reference: the inherited slot.
      "const d: Dog = new Dog();",
      "const p: Dog = new Puppy();",
      'console.log(d.speak(), "|", p.speak());',
      // Virtual ACCESSORS ride the same slots (`get:area` is an ordinary
      // method name by IR time).
      "class Shape { get area(): number { return 0; } }",
      "class Sq extends Shape { s: number = 3; get area(): number { return this.s * this.s; } }",
      "const shapes: Shape[] = [new Shape(), new Sq()];",
      'let a2 = "";',
      'for (const s of shapes) a2 += s.area + ",";',
      "console.log(a2);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    "thing makes a sound/4 dog makes a sound/4 yip/4 tweet/2\ndog makes a sound | yip\n0,9,\n",
  );
});

test("errors: a caught binding tells USER subclasses apart, and `as` still checks", async () => {
  // What the class-id compare this replaced could never do. An
  // Error-typed catch binding can hold anything error-rooted, so the
  // handler's `instanceof` chain has to discriminate a two-deep user
  // hierarchy AND the builtins, in the order written — which is a
  // preorder-interval test over the position the cell recorded at throw
  // time, never a cast. The corpus covers the passing half; the failing
  // half of the checked cast is S009's inherited divergence (Node erases
  // `as`, so no byte-exact lane exists) and is pinned here.
  const res = await buildWasm(
    "err-subclasses.ts",
    [
      "class AppError extends Error {",
      "  status: number;",
      '  constructor(m: string, s: number) { super(m); this.name = "AppError"; this.status = s; }',
      "}",
      "class DbError extends AppError {",
      '  constructor(m: string) { super(m, 500); this.name = "DbError"; }',
      "}",
      "function classify(n: number): string {",
      "  try {",
      '    if (n === 0) throw new DbError("db");',
      '    if (n === 1) throw new AppError("app", 400);',
      '    if (n === 2) throw new TypeError("bad type");',
      '    throw new Error("plain");',
      "  } catch (e) {",
      '    if (e instanceof DbError) return "db " + e.status + " " + e.name;',
      '    if (e instanceof AppError) return "app " + e.status;',
      '    if (e instanceof TypeError) return "type " + e.message;',
      '    if (e instanceof Error) return "err " + e.message;',
      '    return "other";',
      "  }",
      "}",
      "for (let i = 0; i < 4; i = i + 1) console.log(classify(i));",
      // S009 against a USER subclass: the payload is a RangeError, so the
      // interval guard fails and the catchable TypeError names AppError.
      "try {",
      "  try {",
      '    throw new RangeError("r");',
      "  } catch (e) {",
      "    console.log((e as AppError).status);",
      "  }",
      "} catch (e) {",
      '  if (e instanceof TypeError) console.log(e.name + ": " + e.message);',
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "db 500 DbError",
      "app 400",
      "type bad type",
      "err plain",
      "TypeError: caught value is not an instance of AppError (checked cast)",
      "",
    ].join("\n"),
  );
});

test("async: a plain user class FULFILS a promise (only rejections are gated)", async () => {
  // No corpus program isolates this — the ones that would are blocked
  // further along — but the two directions are genuinely different and
  // the difference is easy to lose. A REJECTION payload has to stay
  // error-rooted, because when it re-enters as an exception the cell's
  // class interval is recovered from the payload's own vt. A FULFILMENT
  // is read back by the awaiting site's STATIC type, so it needs no vt
  // and no gate: any class the tier can represent rides it.
  const res = await buildWasm(
    "async-class-value.ts",
    [
      "class Item {",
      "  id: number;",
      "  label: string;",
      "  constructor(id: number, label: string) { this.id = id; this.label = label; }",
      "}",
      "async function make(n: number): Promise<Item> {",
      '  return new Item(n, "item" + n);',
      "}",
      "async function main(): Promise<void> {",
      "  const a = await make(1);",
      "  const b = await make(2);",
      "  console.log(a.id, a.label, b.id, b.label);",
      "}",
      "main();",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("1 item1 2 item2\n");
});

test("classvals: one immortal class object per class, construct and test through it", async () => {
  // The whole class-as-a-value surface in one program. The load-bearing
  // bit the corpus does not isolate is that `K1` and `K2` — a base and a
  // derived class flowing through the SAME `typeof Animal` slot — must
  // share one wasm type, because a classval upcast leaves the reference
  // untouched. That is why the class-object struct is keyed by hierarchy
  // ROOT and constructor ABI rather than by class, and why the construct
  // thunk answers with the root's struct and the call site casts down.
  //
  // `instanceof k` with a RUNTIME target is the other half: the bounds
  // are read off the class object instead of inlined, which is the only
  // reader $ci's `post` has.
  const res = await buildWasm(
    "classvals.ts",
    [
      "class Animal {",
      "  name: string;",
      "  constructor(n: string) { this.name = n; }",
      "}",
      "class Dog extends Animal {",
      "  constructor(n: string) { super(n); }",
      "}",
      "const K1: typeof Animal = Animal;",
      "const K2: typeof Animal = Dog;",
      "console.log(K1.name, K2.name);",
      'const a = new K1("generic");',
      'const d = new K2("rex");',
      "console.log(a.name, d.name, a instanceof Animal, d instanceof Dog);",
      // Identity: the object is interned, so `K1 === K1` holds.
      "console.log(K1 === K1, K1 === K2, K2 !== K1);",
      "const ks: (typeof Animal)[] = [K1, K2];",
      'let out = "";',
      'for (const k of ks) out += k.name + ":" + new k("x").name + " ";',
      "console.log(out.trim());",
      "function isA(v: Animal, k: typeof Animal): boolean { return v instanceof k; }",
      "console.log(isA(d, K1), isA(d, K2), isA(a, K2), isA(a, K1));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "Animal Dog",
      "generic rex true true",
      "true false true",
      "Animal:x Dog:x",
      "true true false true",
      "",
    ].join("\n"),
  );
});

test("throw: a non-error class survives the round trip, synchronously and through a rejection", async () => {
  // The reason the promise payload carries a 4th slot. Both paths must
  // recover the DYNAMIC class: the synchronous one reads the interval the
  // cell recorded, and the async one reads it back off the promise —
  // before, a rejection carried only (kind, f64, ref) and the class was
  // lost the moment an async function turned a throw into one. Nothing in
  // the corpus exercises the async half over a non-error class.
  const res = await buildWasm(
    "throw-plain-class.ts",
    [
      "class Carrier { code: number; constructor(c: number) { this.code = c; } }",
      'class Sub extends Carrier { tag: string; constructor(t: string) { super(1); this.tag = t; } }',
      "function hurl(n: number): string {",
      "  if (n === 0) throw new Carrier(7);",
      '  if (n === 1) throw new Sub("s");',
      '  if (n === 2) throw new Error("plain");',
      '  return "none";',
      "}",
      "for (let i = 0; i < 4; i = i + 1) {",
      "  try {",
      "    console.log(hurl(i));",
      "  } catch (e) {",
      '    if (e instanceof Sub) console.log("sub", e.tag, e.code);',
      '    else if (e instanceof Carrier) console.log("carrier", e.code);',
      '    else if (e instanceof Error) console.log("err", e.message);',
      '    else console.log("other");',
      "  }",
      "}",
      "async function boom(n: number): Promise<string> {",
      '  if (n === 0) throw new Sub("async");',
      '  return "ok";',
      "}",
      "async function main(): Promise<void> {",
      "  try { console.log(await boom(0)); } catch (e) {",
      '    if (e instanceof Sub) console.log("caught async sub", e.tag);',
      '    else console.log("caught async other");',
      "  }",
      "  console.log(await boom(1));",
      "}",
      "main();",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["carrier 7", "sub s 1", "err plain", "none", "caught async sub async", "ok", ""].join("\n"),
  );
});
