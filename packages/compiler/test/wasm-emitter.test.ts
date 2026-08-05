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

test("S015: keyed reads on unknown see OWN properties only", async () => {
  // Node consults the prototype chain here and answers a real function;
  // every tsinter lane answers undefined because the dyn tree stores own
  // entries and has no prototype. No corpus program can pin this — one
  // whose output observed it would fail the differential by construction.
  // Node's answers, for the record:
  //   o["toString"]        -> function toString() { [native code] }
  //   o["hasOwnProperty"]  -> function hasOwnProperty() { [native code] }
  //   a["slice"]           -> function slice() { [native code] }
  // The forms that DO work are the modeled ones, asserted alongside so a
  // reader sees where the line falls.
  const res = await buildWasm(
    "dyn-proto.js",
    [
      "function p(u) { return String(u); }",
      "const o = JSON.parse('{\"a\":1}');",
      "const a = JSON.parse('[10,20]');",
      "const s = JSON.parse('\"ab\"');",
      "console.log(p(o.toString) + ' ' + p(o.hasOwnProperty) + ' ' + p(o.valueOf));",
      "console.log(p(a.slice) + ' ' + p(s.charAt));",
      "console.log(p(o.a) + ' ' + p(a.length) + ' ' + p(a[1]) + ' ' + p(s.length) + ' ' + p(s[0]));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "undefined undefined undefined",
      "undefined undefined",
      "1 2 20 2 a", // the modeled forms are exact
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

test("dyn keyed write: V8's refusal texts on every receiver that has no slot", async () => {
  // Node's own strings, verified against node 24 with this exact program
  // (strict mode — sloppy mode swallows the primitive writes silently).
  // No corpus program reaches them: the one that tries (2601) prints its
  // dyn reads through console.log, which needs the inspect surface.
  const res = await buildWasm(
    "dyn-keyset-throws.js",
    [
      "'use strict';",
      "const cases = ['null', '5', '1.5', '\"abc\"', 'true', 'false'];",
      "try { JSON.parse('null')['x'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('5')['x'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('1.5')['x'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('\"abc\"')['x'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('true')['q'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('false')['q'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      // The S016 lines. Node's answers, verified:
      //   a['nope'] = 1     -> adds the property, no throw
      //   a['length'] = 1   -> TRUNCATES the array, no throw
      //   s['0'] = 'z'      -> "Cannot assign to read only property '0'
      //                         of string 'abc'" (a DIFFERENT V8 message)
      //   s['length'] = 9   -> the same read-only message for 'length'
      // The out-of-range string index below is NOT a divergence — Node
      // says "Cannot create property" there too, which is why it sits
      // beside them.
      "try { JSON.parse('[1]')['nope'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('[1,2,3]')['length'] = 1; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('\"abc\"')['0'] = 'z'; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('\"abc\"')['length'] = 9; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { JSON.parse('\"abc\"')['9'] = 'z'; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "console.log(cases.length);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "Cannot set properties of null (setting 'x')",
      "Cannot create property 'x' on number '5'",
      "Cannot create property 'x' on number '1.5'",
      "Cannot create property 'x' on string 'abc'",
      "Cannot create property 'q' on boolean 'true'",
      "Cannot create property 'q' on boolean 'false'",
      "Cannot create property 'nope' on array", // S016 — Node adds it
      "Cannot create property 'length' on array", // S016 — Node truncates
      "Cannot create property '0' on string 'abc'", // S016 — Node: read only
      "Cannot create property 'length' on string 'abc'", // S016 — same
      "Cannot create property '9' on string 'abc'", // agrees with Node
      "6",
      "",
    ].join("\n"),
  );
});

test("S016: dyn array index writes PAD where Node leaves holes", async () => {
  // The exact half and the divergent half in one program. Exact: length,
  // in-place replacement, and every read — all match Node. Divergent: the
  // padded slots are real own members here and holes there, which only
  // the ENUMERATION and PRESENCE surfaces can see. Node's answers for the
  // second and third lines are "0|3" and "false false true / false true".
  const res = await buildWasm(
    "dyn-keyset-arr.js",
    [
      "'use strict';",
      "function s(u) {",
      "  if (typeof u === 'string') return u;",
      "  if (typeof u === 'number') return String(u);",
      "  if (u === undefined) return 'undefined';",
      "  return '?';",
      "}",
      "function j(u) {",
      "  const n = typeof u.length === 'number' ? u.length : 0;",
      "  let out = '';",
      "  for (let i = 0; i < n; i = i + 1) { out = out + (i > 0 ? '|' : '') + String(u[i]); }",
      "  return out;",
      "}",
      "const a = JSON.parse('[1,2,3]');",
      "a[0] = 'zero';",
      "a[5] = 'five';",
      "console.log(s(a[0]) + ' ' + s(a[1]) + ' ' + s(a[3]) + ' ' + s(a[4]) + ' ' + s(a[5]) + ' ' + s(a.length));",
      "const b = JSON.parse('[]');",
      "b[2] = 9;",
      "console.log(s(b.length) + ' ' + s(b[0]) + ' ' + s(b[2]));",
      "const o = JSON.parse('{\"a\":1}');",
      "o['b'] = 2;",
      "o['b'] = 3;",
      "o[7] = true;",
      "console.log(s(o.a) + ' ' + s(o.b) + ' ' + s(o['7']));",
      // The divergence itself: Node keys are ["0","3"], and both the
      // presence tests answer false for the hole.
      "const h = JSON.parse('[1]');",
      "h[3] = 9;",
      "console.log(j(Object.keys(h)));",
      "console.log(String('1' in h) + ' ' + String('2' in h) + ' ' + String('3' in h));",
      "console.log(String(Object.hasOwn(h, '1')) + ' ' + String(Object.hasOwn(h, '3')));",
      // ... while length and the reads stay Node-exact.
      "console.log(s(h.length) + ' ' + s(h[1]) + ' ' + s(h[3]));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "zero 2 undefined undefined five 6",
      "3 undefined 9",
      "1 3 ?",
      "0|1|2|3", // Node: 0|3
      "true true true", // Node: false false true
      "true true", // Node: false true
      "4 undefined 9", // Node agrees exactly
      "",
    ].join("\n"),
  );
});

test("S016: Object.assign onto a non-object target drops the copy SILENTLY", async () => {
  // The one keyed-write arm that does not announce itself. Node writes
  // `k` through onto the array and lists it in Object.keys (["0","1","k"]
  // there); here the source is walked and dropped with no throw. The
  // returned target is the same value on both.
  const res = await buildWasm(
    "dyn-assign-nonobj.js",
    [
      "'use strict';",
      "function j(u) {",
      "  const n = typeof u.length === 'number' ? u.length : 0;",
      "  let out = '';",
      "  for (let i = 0; i < n; i = i + 1) { out = out + (i > 0 ? '|' : '') + String(u[i]); }",
      "  return out;",
      "}",
      "const arrTarget = JSON.parse('[1,2]');",
      "const r = Object.assign(arrTarget, JSON.parse('{\"k\":7}'));",
      "console.log(String(arrTarget.k) + ' ' + String(r === arrTarget) + ' ' + j(Object.keys(arrTarget)));",
      // An OBJECT target is exact, so the boundary is visible in place.
      "const objTarget = JSON.parse('{\"a\":9}');",
      "Object.assign(objTarget, JSON.parse('{\"a\":1,\"b\":2}'));",
      "console.log(j(Object.keys(objTarget)) + ' ' + String(objTarget.a) + String(objTarget.b));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "undefined true 0|1", // Node: "7 true 0|1|k"
      "a|b 12", // Node agrees exactly
      "",
    ].join("\n"),
  );
});

test("S017: for-of over a COMPUTED member names the value, not the source", async () => {
  // V8 renders the source expression in a for-of head whenever it can.
  // The lowering supplies that spelling for an identifier and a DOTTED
  // member — both exact below — but not for a computed access, where the
  // message falls back to the value's kind. Node's answers for the two
  // divergent lines are "arr[0] is not iterable" and "o[k] is not
  // iterable". DESTRUCTURING position is not affected: V8 itself uses the
  // kind wording for any member access there, which the last two lines
  // pin as agreeing.
  const res = await buildWasm(
    "dyn-iter-spelling.js",
    [
      "'use strict';",
      "const arr = JSON.parse('[5]');",
      "const o = JSON.parse('{\"p\":5}');",
      "const n5 = JSON.parse('5');",
      "const k = 'p';",
      "try { for (const v of arr[0]) { } } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { for (const v of o[k]) { } } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { for (const v of o.p) { } } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { for (const v of n5) { } } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { const [z] = arr[0]; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { const [z] = n5; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "number 5 is not iterable (cannot read property Symbol(Symbol.iterator))", // Node: arr[0] is not iterable
      "number 5 is not iterable (cannot read property Symbol(Symbol.iterator))", // Node: o[k] is not iterable
      "o.p is not iterable", // exact
      "n5 is not iterable", // exact
      "number 5 is not iterable (cannot read property Symbol(Symbol.iterator))", // exact
      "n5 is not iterable", // exact
      "",
    ].join("\n"),
  );
});

test("dyn ??, ?. and strict equality against each scalar kind", async () => {
  // The cheap arms, pinned so they stay correct: `??` decides on the
  // runtime KIND (0, "" and false are not nullish) and runs its right
  // side lazily; `?.` short-circuits on the same two kinds; and
  // dynScalarEq tests the kind tag then the payload — f64.eq for numbers
  // (NaN false, +0 === -0), content for strings, the flag for booleans,
  // and whole-value identity when both sides are dyn. Node agrees with
  // every line.
  const res = await buildWasm(
    "dyn-nullish-eq.js",
    [
      "'use strict';",
      "function s(u) {",
      "  if (typeof u === 'string') return u;",
      "  if (typeof u === 'number') return String(u);",
      "  if (typeof u === 'boolean') return String(u);",
      "  if (u === null) return 'null';",
      "  if (u === undefined) return 'undefined';",
      "  return '?';",
      "}",
      "const b = JSON.parse('{\"n\":5,\"s\":\"hi\",\"t\":true,\"z\":0,\"e\":\"\",\"f\":false,\"nul\":null,\"arr\":[1],\"obj\":{}}');",
      // ?? — only the two unit kinds take the default.
      "console.log(s(b.n ?? 'd') + ' ' + s(b.z ?? 'd') + ' ' + s(b.e ?? 'd') + ' ' + s(b.f ?? 'd') + ' ' + s(b.nul ?? 'd') + ' ' + s(b.missing ?? 'd'));",
      // ?? is LAZY: the counter moves only for the two nullish reads.
      "let calls = 0;",
      "function mk() { calls = calls + 1; return 'made'; }",
      "console.log(s(b.n ?? mk()) + ' ' + s(b.nul ?? mk()) + ' ' + s(b.missing ?? mk()) + ' calls=' + String(calls));",
      // && / || keep JS value semantics over the same truthiness.
      "console.log(s(b.n && 'yes') + ' ' + s(b.z && 'yes') + ' ' + s(b.e || 'alt') + ' ' + s(b.f || 'alt'));",
      // ?. short-circuits on nullish receivers only.
      "console.log(s(b.nul?.deep) + ' ' + s(b.missing?.deep) + ' ' + s(b.arr?.length) + ' ' + s(b.obj?.nope));",
      // dynScalarEq: number, string, boolean, and both-dyn.
      "console.log(String(b.n === 5) + String(b.n === 6) + String(b.n !== 5));",
      "console.log(String(b.s === 'hi') + String(b.s === 'no') + String(b.s !== 'hi'));",
      "console.log(String(b.t === true) + String(b.t === false) + String(b.f === false));",
      "console.log(String(b.z === 0) + String(b.e === '') + String(b.nul === null) + String(b.missing === undefined));",
      // Both sides dyn: scalars by value, reference kinds by identity.
      "console.log(String(b.n === b.n) + String(b.arr === b.arr) + String(b.arr === b.obj) + String(b.nul === b.missing));",
      // A number that is not the receiver's kind is never equal.
      "console.log(String(b.s === b.n) + String(b.z === b.f) + String(b.obj === b.obj));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "5 0  false d d",
      "5 made made calls=2",
      "yes 0 alt alt",
      "undefined undefined 1 undefined",
      "truefalsefalse",
      "truefalsefalse",
      "truefalsetrue",
      "truetruetruetrue",
      "truetruefalsefalse",
      "falsefalsetrue",
      "",
    ].join("\n"),
  );
});

test("dyn Object.hasOwn: the modeled forms, including the STR arm C omits", async () => {
  // Every line here is Node's answer. The STRING receiver is the one the
  // native lanes get wrong today (scr_dyn_has_own has OBJ and ARR arms
  // and no STR arm, so it answers false for "length" and "0" while
  // scr_dyn_key_get happily reads both) — this lane answers Node and the
  // C runtime converges under its own task. No corpus program can pin it
  // while the lanes disagree: one that observed it would fail the C
  // differential.
  const res = await buildWasm(
    "dyn-hasown.js",
    [
      "'use strict';",
      "function b(x) { return x ? 'T' : 'F'; }",
      "const o = JSON.parse('{\"name\":\"x\",\"zero\":0,\"nul\":null}');",
      "const k = 'na' + 'me';",
      "console.log(b(Object.hasOwn(o, k)) + b(Object.hasOwn(o, 'zero')) + b(Object.hasOwn(o, 'nul')) + b(Object.hasOwn(o, 'nope')) + b(Object.hasOwn(o, 'toString')));",
      "const a = JSON.parse('[1,2,3]');",
      "console.log(b(Object.hasOwn(a, 'length')) + b(Object.hasOwn(a, '0')) + b(Object.hasOwn(a, '3')) + b(Object.hasOwn(a, '01')) + b(Object.hasOwn(a, '1.0')));",
      "const s = JSON.parse('\"abc\"');",
      "console.log(b(Object.hasOwn(s, 'length')) + b(Object.hasOwn(s, '0')) + b(Object.hasOwn(s, '2')) + b(Object.hasOwn(s, '3')) + b(Object.hasOwn(s, 'toString')));",
      "console.log(b(Object.hasOwn(JSON.parse('5'), 'x')) + b(Object.hasOwn(JSON.parse('true'), 'x')));",
      "try { Object.hasOwn(JSON.parse('null'), 'x'); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "TTTFF",
      "TTFFF",
      "TTTFF", // Node: TTTFF — the C lane answers FFFFF on this line
      "FF",
      "Cannot convert undefined or null to object",
      "",
    ].join("\n"),
  );
});

test("dyn fn: the boxed CLOSURE is what identity compares, never the box", async () => {
  // The one hazard the whole function boundary turns on. FN_CLOS is
  // typed `eq` and `ref.eq(null, null)` is TRUE, so a box built over the
  // calling ABI's dead ref.null closure argument instead of the value's
  // own closure would make EVERY pair of boxed functions compare equal —
  // silently, with `f === f` still answering true to hide it. `u === v`
  // on line 1 is the assertion that catches it: two distinct capture-free
  // functions of the SAME signature, which is exactly the pair that
  // shares a closure struct type and would share a null.
  //
  // Every line is Node's answer, and the C lane agrees on all of them.
  const res = await buildWasm(
    "dyn-fn-identity.ts",
    [
      "function add(a: number, b: number): number { return a + b; }",
      "function sub(a: number, b: number): number { return a - b; }",
      "function mk(): (n: number) => number { let s = 0; return (n: number) => { s += n; return s; }; }",
      "const u: unknown = add;",
      "const u2: unknown = add;",
      "const v: unknown = sub;",
      // Two boxes of ONE function are one JS value; two boxes of two are not.
      "console.log(`${u === u2} ${u === v} ${u === u}`);",
      "const f = u as (a: number, b: number) => number;",
      "const g = v as (a: number, b: number) => number;",
      // The exact-unwrap path: a cast back to the IDENTICAL signature is
      // the very same closure, so `=== add` holds.
      "console.log(`${f === add} ${g === sub} ${f === g} ${f === f}`);",
      "const c1 = mk();",
      "const c2 = mk();",
      "const b1: unknown = c1;",
      "const b2: unknown = c2;",
      "const b3: unknown = c1;",
      // Capturing closures too — the env struct is the identity there.
      "console.log(`${b1 === b2} ${b1 === b3}`);",
      "const back = b1 as (n: number) => number;",
      // And the state is SHARED: one counter, reached both ways.
      "console.log(`${back === c1} ${back(2)} ${back(3)} ${c1(4)}`);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["true false true", "true true false true", "false true", "true 2 5 9", ""].join("\n"),
  );
});

test("dyn fn: JS ARITY through the thunk, and the adapter's result check", async () => {
  // The thunk is where a call's arguments meet the boxed signature's
  // declared parameters. Missing arguments are THE undefined immortal —
  // a dyn parameter takes it (line 3: `typeof x` is "undefined"), a
  // number parameter throws the path-annotated TypeError naming `$[i]`.
  // Extra arguments are evaluated by the CALLER and then never read,
  // which is why "eval extra" prints before the result. The last line is
  // the adapter's half: a wrapper whose real return type is not the
  // target's is caught at the ROOT path on the way out.
  //
  // Node erases all of this (S009's stance). Its full output is
  //   eval extra / 3 / undefined / number / s3
  // — five lines to our six: NOTHING at all where the first check fires
  // (that statement discards its result, so there is no console.log to
  // reach), and "s3" where the last one does. The contract here is
  // byte-parity with the C emitter, verified against a C-lane build of
  // this same program.
  const res = await buildWasm(
    "dyn-fn-arity.ts",
    [
      "function pick(a: number, b: number): number { return a + b; }",
      "function takesDyn(x: unknown): string { return typeof x; }",
      "function side(tag: string): number { console.log('eval ' + tag); return 1; }",
      "const u: unknown = pick;",
      "const one = u as (a: number) => unknown;",
      "try { one(7); } catch (e) { console.log((e as Error).message); }",
      "const b: any = pick;",
      "console.log(`${b(1, 2, side('extra')) as number}`);",
      "const d: any = takesDyn;",
      "console.log(d() as string);",
      "console.log(d(5) as string);",
      "function lies(a: number): string { return 's' + a; }",
      "const lu: unknown = lies;",
      "const lying = lu as (a: number) => number;",
      "try { console.log(`${lying(3)}`); } catch (e) { console.log((e as Error).message); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "expected number at $[1], got undefined", // Node: prints nothing here
      "eval extra", // the dropped argument still ran
      "3",
      "undefined", // a missing arg reaching a dyn parameter
      "number",
      "expected number at $, got string", // Node: prints s3
      "",
    ].join("\n"),
  );
});

test("S018: the not-a-function TypeError names the callee's SOURCE text", async () => {
  // Four of these seven disagree with Node, and they are the four the
  // register names: V8 re-renders the callee from its own AST (stripping
  // parens, normalizing whitespace, spelling a string-literal computed
  // key as a dotted one) while the lowering threads a compile-time
  // spelling through. The other three agree exactly. The C lane
  // reproduces every line, verified against a C-lane build.
  const res = await buildWasm(
    "dyn-fn-naf.ts",
    [
      "const o: any = JSON.parse('{\"f\":1,\"a\":{\"b\":2},\"arr\":[1]}');",
      "const g: any = o.f;",
      "const k = 'f';",
      "try { g(1); } catch (e) { console.log((e as Error).message); }",
      "try { (g)(1); } catch (e) { console.log((e as Error).message); }",
      "try { o.a.b(); } catch (e) { console.log((e as Error).message); }",
      "try { o . a . b (); } catch (e) { console.log((e as Error).message); }",
      "try { o['f'](); } catch (e) { console.log((e as Error).message); }",
      "try { o[k](); } catch (e) { console.log((e as Error).message); }",
      "try { o.arr[0](); } catch (e) { console.log((e as Error).message); }",
      "try { (true ? g : g)(1); } catch (e) { console.log((e as Error).message); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "g is not a function", // agrees
      "value is not a function", // S018 — Node: "g"
      "o.a.b is not a function", // agrees
      "o . a . b is not a function", // S018 — Node: "o.a.b"
      "o['f'] is not a function", // S018 — Node: "o.f"
      "o[k] is not a function", // agrees — the KEY is not evaluated
      "o.arr[0] is not a function", // agrees
      // S018 — Node: "(intermediate value)(intermediate value)(intermediate
      // value)", its wording for a callee with no referenceable spelling.
      "value is not a function",
      "",
    ].join("\n"),
  );
});

test("S019/S016: a boxed function's members, its String() and the write it refuses", async () => {
  // What a FUNC box answers, and the three places that is not Node.
  // `typeof` and the PRESENCE forms are exact — the last two being where
  // this lane deliberately leaves the C runtime behind (scr_dyn_has_own
  // has no FUNC arm, so the C lane answers false for all six). String()
  // is S019: the source is gone in a compiled program, so this is the
  // native-code form Node itself prints for its builtins. The WRITE is
  // S016: functions are objects in Node and `f.x = 1` sticks there,
  // while a FUNC payload here has no table to put it in.
  //
  // The `name` and `length` READS happen to agree with Node on both
  // functions here — each is defined AT the binding it is boxed from and
  // has no defaulted parameter, which is S020's coinciding case. The
  // cases where they do not agree are pinned in S020's own test; do not
  // read this one as evidence that the two members are exact.
  const res = await buildWasm(
    "dyn-fn-members.ts",
    [
      "function named(a: number, b: number): number { return a + b; }",
      "const anon = function (a: number): number { return a; };",
      "const b1: any = named;",
      "const b2: any = anon;",
      "console.log(`${b1.name as string} ${b1.length as number} ${typeof b1}`);",
      "console.log(`[${b2.name as string}] ${b2.length as number}`);",
      "function b(x: boolean): string { return x ? 'T' : 'F'; }",
      "console.log(b('name' in b1) + b('length' in b1) + b('nope' in b1));",
      "console.log(b(Object.hasOwn(b1, 'name')) + b(Object.hasOwn(b1, 'length')) + b(Object.hasOwn(b1, 'zz')));",
      "const s: string = `${b1}`;",
      "console.log(s);",
      "try { b1.x = 1; console.log('wrote'); } catch (e) { console.log((e as Error).message); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "named 2 function", // agrees — S020's coinciding case
      // Also agrees: JS infers this name for an anonymous expression from
      // the binding, which is the one spelling the lowering has too.
      "[anon] 1",
      "TTF", // Node: TTF — the C lane answers FFF
      "TTF", // Node: TTF — the C lane answers FFF
      // S019 — Node prints the SOURCE, and under --experimental-strip-types
      // the type annotations are blanked to SPACES rather than removed:
      //   "function named(a        , b        )         { return a + b; }"
      "function named() { [native code] }",
      "Cannot create property 'x' on function", // S016 — Node writes it
      "",
    ].join("\n"),
  );
});

test("S020: f.name is the BOX SITE's binding and f.length the DECLARED count", async () => {
  // Both members are compile-time approximations captured where the box
  // is built, and both are close enough to be mistaken for exact. Every
  // Node answer below was verified against real Node, and the C lane
  // reproduces this lane's column value for value.
  //
  // `name` agrees whenever the function was DEFINED at the binding it is
  // boxed from — which is most code, and why the divergence hides. It
  // parts company through an alias, out of a factory, and (worst) through
  // any converting composite, where there is no binding to read at all
  // and the value goes anonymous.
  //
  // `length` agrees until a parameter has a DEFAULT: JS counts formals
  // before the first initializer. TypeScript's `?` is not a default and
  // does not diverge. Only the NUMBER is wrong — the last line calls
  // through a box with the defaulted argument missing and gets Node's
  // answer, because a defaulted parameter is typed `T | undefined` and
  // the body applies its own default.
  const res = await buildWasm(
    "dyn-fn-name-length.ts",
    [
      "function realName(a: number, b: number): number { return a + b; }",
      "const alias = realName;",
      "const b1: any = alias;",
      "const b2: any = realName;",
      "console.log(`[${b1.name as string}] [${b2.name as string}]`);",
      "function factory(): (z: number) => number {",
      "  function innerFn2(z: number): number { return z; }",
      "  return innerFn2;",
      "}",
      "const got = factory();",
      "const b3: any = got;",
      "console.log(`[${b3.name as string}]`);",
      // The composite path: a function that reaches dyn as a THUNK RESULT
      // and as an ADAPTER ARGUMENT, neither of which has an fnName.
      "function outerMaker(): (n: number) => number {",
      "  function inner(n: number): number { return n; }",
      "  return inner;",
      "}",
      "const om: any = outerMaker;",
      "const res1: any = om();",
      "function takesFn(f: (n: number) => number): unknown { return f as unknown; }",
      "function passed(n: number): number { return n; }",
      "const tf: any = takesFn;",
      "const res2: any = tf(passed);",
      "console.log(`[${res1.name as string}] [${res2.name as string}]`);",
      "function def(a: number, b: number = 1): number { return a + b; }",
      "function def2(a: number = 0, b: number = 1): number { return a + b; }",
      "function opt(a: number, b?: number): number { return a + (b ?? 0); }",
      "function mix(a: number, b?: number, c: number = 3): number { return a + (b ?? 0) + c; }",
      "const d1: any = def;",
      "const d2: any = def2;",
      "const d3: any = opt;",
      "const d4: any = mix;",
      "console.log(`${d1.length as number} ${d2.length as number} ${d3.length as number} ${d4.length as number}`);",
      "console.log(`${d1(5) as number} ${d1(5, 2) as number} ${d3(5) as number} ${d4(5) as number}`);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // S020 — Node: "[realName] [realName]". An alias does not rename a
      // function; Node fixes the name at definition.
      "[alias] [realName]",
      "[got]", // S020 — Node: "[innerFn2]"
      "[] []", // S020 — Node: "[inner] [passed]"
      // S020's four length shapes, in order: def / def2 / opt / mix.
      // Node: "1 0 2 2" — only `opt` (the `?` marker, which erases and so
      // gets counted on both lanes) agrees, and `mix` shows the split
      // inside one signature: its `?` is counted, its `= 3` is not.
      "2 2 2 3",
      // Agrees exactly — the defaults still APPLY through the box, which
      // is S020's narrowness paragraph. Only the reported count is wrong.
      "6 7 5 8",
      "",
    ].join("\n"),
  );
});

test("dyn invoke: the Array surface a dyn receiver dispatches to", async () => {
  // Every Array.prototype name the frontend's dispatch allowlist admits,
  // over a JSON.parse receiver. All of it is Node-exact — the C lane
  // prints the same lines, verified against a C-lane build — so this
  // pins semantics the corpus cannot: the programs that exercise dyn
  // dispatch all print their receivers, and the inspect surface has not
  // landed.
  const res = await buildWasm(
    "dyn-invoke-arr.ts",
    [
      "const a: any = JSON.parse('[3,1,2]');",
      "const out: string[] = [];",
      "out.push('push ' + String(a.push(9)) + ' ' + String(a.join('-')));",
      "out.push('pop ' + String(a.pop()) + ' shift ' + String(a.shift()));",
      "out.push('unshift ' + String(a.unshift(7, 8)) + ' ' + String(a.join(',')));",
      "out.push('slice ' + String(a.slice(1, 3).join('|')) + ' neg ' + String(a.slice(-2).join('|')));",
      "out.push('at ' + String(a.at(0)) + ' ' + String(a.at(-1)) + ' ' + String(a.at(99)));",
      "out.push('indexOf ' + String(a.indexOf(2)) + ' ' + String(a.indexOf(404)));",
      "out.push('lastIndexOf ' + String(a.lastIndexOf(1)) + ' includes ' + String(a.includes(8)));",
      "out.push('concat ' + String(a.concat([100], 200).join(',')));",
      "out.push('reverse ' + String(a.reverse().join(',')));",
      // A null or undefined ELEMENT joins as empty — Array.prototype
      // .join's own rule, one level down from toStr's array arm.
      "const holes: any = JSON.parse('[1,null,3]');",
      "out.push('holes [' + String(holes.join(',')) + '] nested [' + String(JSON.parse('[[1,2],[3]]').join(';')) + ']');",
      "const empty: any = JSON.parse('[]');",
      "out.push('empty ' + String(empty.pop()) + ' ' + String(empty.shift()) + ' [' + String(empty.join(',')) + ']');",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "push 4 3-1-2-9",
      "pop 9 shift 3",
      "unshift 4 7,8,1,2",
      "slice 8|1 neg 1|2",
      "at 7 2 undefined",
      "indexOf 3 -1",
      "lastIndexOf 2 includes true",
      "concat 7,8,1,2,100,200",
      "reverse 2,1,8,7",
      "holes [1,,3] nested [1,2;3]",
      "empty undefined undefined []",
      "",
    ].join("\n"),
  );
});

test("dyn invoke: callbacks see (elem, i, receiver), and sort is the spec's", async () => {
  // The callback family calls through the boxed thunk (stage 4's
  // machinery), so a TYPED callback validates each argument on the way
  // in. sort answers the RECEIVER by identity, sinks undefined before
  // any comparison, and orders by ToString image by default — which the
  // C runtime compares in code-POINT order and this lane in UTF-16 code
  // UNITS, ECMAScript's own (S005's flag, and S023's closing note). The
  // two agree on everything below; they part company only across the
  // surrogate boundary, which no corpus program touches.
  const res = await buildWasm(
    "dyn-invoke-cb.ts",
    [
      "const a: any = JSON.parse('[3,1,2]');",
      "const out: string[] = [];",
      "a.forEach(function (v: number, i: number, self: unknown): void {",
      "  out.push('fe ' + String(v) + '@' + String(i) + ' arr=' + String(Array.isArray(self)));",
      "});",
      "out.push('map ' + String(a.map(function (v: number): number { return v * 2; }).join(',')));",
      "out.push('filter ' + String(a.filter(function (v: number): boolean { return v > 1; }).join(',')));",
      "out.push('some ' + String(a.some(function (v: number): boolean { return v === 2; })) +",
      "  ' ' + String(a.some(function (v: number): boolean { return v === 99; })));",
      "out.push('every ' + String(a.every(function (v: number): boolean { return v > 0; })) +",
      "  ' ' + String(a.every(function (v: number): boolean { return v > 2; })));",
      "out.push('find ' + String(a.find(function (v: number): boolean { return v < 3; })) +",
      "  ' ' + String(a.find(function (v: number): boolean { return v > 99; })));",
      "out.push('findIndex ' + String(a.findIndex(function (v: number): boolean { return v === 2; })) +",
      "  ' ' + String(a.findIndex(function (v: number): boolean { return v === 99; })));",
      "const s1: any = JSON.parse('[10,9,1,2]');",
      "out.push('default ' + String(s1.sort().join(',')) + ' identity ' + String(s1.sort() === s1));",
      "const s2: any = JSON.parse('[10,9,1,2]');",
      "out.push('cmp ' + String(s2.sort(function (x: number, y: number): number { return x - y; }).join(',')));",
      // Stability: equal keys keep first-seen order, so the ORIGINAL
      // spelling of each one-character key survives the sort.
      "const s3: any = JSON.parse('[\"b\",\"a\",\"c\",\"aa\"]');",
      "out.push('str ' + String(s3.sort().join(',')));",
      // undefined sinks; null does NOT — it sorts by its text.
      "const s4: any = JSON.parse('[3,null,1]');",
      "s4.push(undefined);",
      "out.push('sink ' + String(s4.sort().join(',')) + ' len ' + String(s4.length));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "fe 3@0 arr=true",
      "fe 1@1 arr=true",
      "fe 2@2 arr=true",
      "map 6,2,4",
      "filter 3,2",
      "some true false",
      "every true false",
      "find 1 undefined",
      "findIndex 2 -1",
      "default 1,10,2,9 identity true",
      "cmp 1,2,9,10",
      "str a,aa,b,c",
      "sink 1,3,, len 4",
      "",
    ].join("\n"),
  );
});

test("dyn invoke: the callback family binds `length` ONCE, like the spec", async () => {
  // ECMA-262 binds `len` before the Repeat, so an element the callback
  // APPENDS is never visited — verified against Node for all seven.
  // The C runtime re-reads the length as its loop limit and does visit
  // them (it would print steps=5 and a five-element array on every line
  // but `every`'s), which is a bug rather than a stance, so this lane
  // does not inherit it. The elements stay live in the other direction:
  // an in-place write mid-loop IS seen, because each step re-reads the
  // slot.
  const res = await buildWasm(
    "dyn-invoke-len.ts",
    [
      "const out: string[] = [];",
      "function grow(m: string): string {",
      "  const a: any = JSON.parse('[1,2]');",
      "  let steps = 0;",
      "  const cb = function (v: number): boolean {",
      "    steps = steps + 1; if (steps < 4) { a.push(v + 10); } return false;",
      "  };",
      "  if (m === 'forEach') a.forEach(cb);",
      "  else if (m === 'map') a.map(cb);",
      "  else if (m === 'filter') a.filter(cb);",
      "  else if (m === 'some') a.some(cb);",
      "  else if (m === 'every') a.every(cb);",
      "  else if (m === 'find') a.find(cb);",
      "  else a.findIndex(cb);",
      "  return m + ' steps=' + String(steps) + ' arr=' + String(a.join(','));",
      "}",
      "for (const m of ['forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex']) out.push(grow(m));",
      "const ip: any = JSON.parse('[1,2,3]');",
      "const seen: string[] = [];",
      "ip.forEach(function (v: number, i: number): void { seen.push(String(v)); if (i === 0) { ip[2] = 99; } });",
      "out.push('inplace ' + seen.join(','));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // Two steps each: the callback's pushes land past the bound length.
      "forEach steps=2 arr=1,2,11,12",
      "map steps=2 arr=1,2,11,12",
      "filter steps=2 arr=1,2,11,12",
      "some steps=2 arr=1,2,11,12",
      // `every` short-circuits on the first falsy answer, so it takes one.
      "every steps=1 arr=1,2,11",
      "find steps=2 arr=1,2,11,12",
      "findIndex steps=2 arr=1,2,11,12",
      "inplace 1,2,99",
      "",
    ].join("\n"),
  );
});

test("S023: the dyn invoke ladder — Node's refusals, and the fences that are ours", async () => {
  // The four rungs, in order. Everything here but the three
  // "not supported yet" lines is Node's own answer, byte for byte;
  // those three are S023, and they are plain Errors rather than
  // TypeErrors precisely so a handler testing for one is not misled.
  // The callable-callback gate is the one place this lane leaves the C
  // runtime behind: V8 names the operand's TYPE ("number 5",
  // `string "abc"`) where the C runtime renders its ToString image.
  const res = await buildWasm(
    "dyn-invoke-ladder.ts",
    [
      "function msg(f: () => void): string {",
      "  try { f(); return '(no throw)'; } catch (e) { return (e as Error).name + ': ' + (e as Error).message; }",
      "}",
      "const arr: any = JSON.parse('[1,2]');",
      "const str: any = JSON.parse('\"abc\"');",
      "const num: any = JSON.parse('5');",
      "const obj: any = JSON.parse('{\"a\":1}');",
      "const nul: any = JSON.parse('null');",
      "const out: string[] = [];",
      "out.push(msg(() => { nul.push(1); }));",
      "out.push(msg(() => { arr.nope(); }));",
      "out.push(msg(() => { str.push(1); }));",
      "out.push(msg(() => { num.push(1); }));",
      "out.push(msg(() => { obj.push(1); }));",
      "out.push(msg(() => { str.at(0); }));",
      "out.push(msg(() => { str.indexOf(1); }));",
      "out.push(msg(() => { arr.slice('x'); }));",
      "out.push('str.slice ' + String(str.slice(1)) + ' indexOf ' + String(str.indexOf('b')) +",
      "  ' lastIndexOf ' + String(str.lastIndexOf('c')) + ' includes ' + String(str.includes('bc')));",
      "out.push(msg(() => { arr.map(5); }));",
      "out.push(msg(() => { arr.map(str); }));",
      "out.push(msg(() => { arr.map(obj); }));",
      "out.push(msg(() => { arr.forEach(); }));",
      "out.push(msg(() => { arr.sort(5); }));",
      "out.push(msg(() => { arr.sort(obj); }));",
      "out.push(msg(() => { arr.sort(JSON.parse('[9,8]')); }));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // Rung four: a nullish receiver never reaches the member at all.
      "TypeError: Cannot read properties of null (reading 'push')",
      // Rung three: the name is on no prototype this kind has.
      "TypeError: arr.nope is not a function",
      "TypeError: str.push is not a function",
      "TypeError: num.push is not a function",
      "TypeError: obj.push is not a function",
      // Rung two, S023: real on String.prototype, unimplemented here.
      "Error: 'String.prototype.at' on a dynamic value is not supported yet",
      "Error: 'String.prototype.indexOf' on a dynamic value is not supported yet",
      "TypeError: arr.slice: non-number index arguments on a dynamic receiver are not supported yet",
      // Rung one: the implemented String pairs, exact.
      "str.slice bc indexOf 1 lastIndexOf 2 includes true",
      // The callback gate, V8's typed wording. Node agrees with every
      // line; the C runtime says "5", "abc" and "[object Object]".
      "TypeError: number 5 is not a function",
      'TypeError: string "abc" is not a function',
      "TypeError: object is not a function",
      "TypeError: undefined is not a function",
      // sort's own gate folds the whole VALUE in instead of naming its
      // type — V8's choice here, and not the value's `String()` either:
      // a message must not run user code, so an object is "#<Object>"
      // and an array "[object Array]". Node says each of these.
      "TypeError: The comparison function must be either a function or undefined: 5",
      "TypeError: The comparison function must be either a function or undefined: #<Object>",
      "TypeError: The comparison function must be either a function or undefined: [object Array]",
      "",
    ].join("\n"),
  );
});

test("dyn invoke: fromIndex, and the SameValueZero `includes` alone uses", async () => {
  // Argument 1 of indexOf/lastIndexOf/includes, on both receivers that
  // have the methods. Every line is Node's, verified — and the two
  // receivers do NOT share a rule: an array's fromIndex is RELATIVE
  // (negatives count from the end), a string's is CLAMPED to [0, len],
  // and NaN reads as 0 on both except String.lastIndexOf, whose
  // ToNumber sends it to +infinity. The C lane threads none of this
  // (it ignores the argument entirely) — task-tracked separately.
  const res = await buildWasm(
    "dyn-invoke-fromindex.ts",
    [
      "const a: any = JSON.parse('[1,2,3,1,2,3]');",
      "const s: any = JSON.parse('\"abcabc\"');",
      "const out: string[] = [];",
      "out.push('arr idx ' + String(a.indexOf(1)) + ' ' + String(a.indexOf(1, 1)) + ' ' +",
      "  String(a.indexOf(2, 3)) + ' ' + String(a.indexOf(1, -2)) + ' ' + String(a.indexOf(1, 99)));",
      "out.push('arr last ' + String(a.lastIndexOf(1)) + ' ' + String(a.lastIndexOf(1, 2)) + ' ' +",
      "  String(a.lastIndexOf(3, -4)) + ' ' + String(a.lastIndexOf(1, -99)) + ' ' + String(a.lastIndexOf(1, 99)));",
      "out.push('arr inc ' + String(a.includes(1, 1)) + ' ' + String(a.includes(1, 4)) + ' ' +",
      "  String(a.includes(3, -1)) + ' ' + String(a.includes(1, -99)));",
      "out.push('str idx ' + String(s.indexOf('a')) + ' ' + String(s.indexOf('a', 1)) + ' ' +",
      "  String(s.indexOf('b', 3)) + ' ' + String(s.indexOf('a', -2)) + ' ' + String(s.indexOf('a', 99)));",
      "out.push('str last ' + String(s.lastIndexOf('a')) + ' ' + String(s.lastIndexOf('a', 2)) + ' ' +",
      "  String(s.lastIndexOf('a', -1)) + ' ' + String(s.lastIndexOf('a', 99)));",
      "out.push('str inc ' + String(s.includes('a', 1)) + ' ' + String(s.includes('a', 4)));",
      // An empty vector's lastIndexOf has no index to default to.
      "const e: any = JSON.parse('[]');",
      "out.push('empty ' + String(e.lastIndexOf(1)) + ' ' + String(e.lastIndexOf(1, 0)) + ' ' + String(e.indexOf(1)));",
      // NaN: the fromIndex rule, then the SameValueZero split. `includes`
      // finds a NaN that `indexOf` and `lastIndexOf` cannot, which is
      // JS's own routing (SameValueZero against strict equality) and not
      // an inconsistency of ours. -0 matches +0 on every path.
      "const nan: number = Number.NaN;",
      "const n: any = JSON.parse('[1,2]');",
      "n.push(nan);",
      "out.push('nan find ' + String(n.includes(nan)) + ' ' + String(n.indexOf(nan)) + ' ' + String(n.lastIndexOf(nan)));",
      "out.push('nan from ' + String(a.indexOf(1, nan)) + ' ' + String(a.lastIndexOf(1, nan)) + ' ' +",
      "  String(s.indexOf('a', nan)) + ' ' + String(s.lastIndexOf('a', nan)));",
      "const z: any = JSON.parse('[0]');",
      "out.push('zero ' + String(z.includes(-0)) + ' ' + String(z.indexOf(-0)));",
      // An explicit `undefined` fromIndex is PRESENT, and one method
      // branches on presence: Array.lastIndexOf coerces it to 0 and
      // searches index 0 alone, where the ABSENT form starts at len-1.
      // Every other index argument spells its default as its undefined
      // case, so the two coincide there — the rest of this line.
      "const un: any = JSON.parse('[]').at(5);",
      "out.push('undef last ' + String(a.lastIndexOf(2, un)) + ' ' + String(a.lastIndexOf(2)) + ' ' +",
      "  String(a.lastIndexOf(1, un)) + ' ' + String(a.lastIndexOf(1)));",
      "out.push('undef rest ' + String(a.indexOf(2, un)) + ' ' + String(a.includes(3, un)) + ' ' +",
      "  String(a.at(un)) + ' [' + String(a.slice(1, un).join(',')) + '] ' +",
      "  String(s.indexOf('a', un)) + ' ' + String(s.lastIndexOf('a', un)) + ' [' + String(s.slice(1, un)) + ']');",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "arr idx 0 3 4 -1 -1",
      // -99 shifts below zero and scans NOTHING — it does not clamp to 0
      // the way a forward start does.
      "arr last 3 0 2 -1 3",
      "arr inc true false true true",
      // The string's -2 clamps to 0 rather than counting from the end.
      "str idx 0 3 4 0 -1",
      "str last 3 0 0 3",
      "str inc true false",
      "empty -1 -1 -1",
      "nan find true -1 -1",
      // NaN is 0 everywhere but String.lastIndexOf, which searches all.
      "nan from 0 0 0 3",
      "zero true 0",
      // Present-and-undefined against absent: -1 vs 4, 0 vs 3.
      "undef last -1 4 0 3",
      "undef rest 1 true 1 [2,3,1,2,3] 0 3 [bcabc]",
      "",
    ].join("\n"),
  );
});

test("S016: `map` binds the length for its OUTPUT, so a shrink leaves a slot", async () => {
  // The spec builds map's result at the length it captured before the
  // first step, so a callback that shrinks the receiver skips steps and
  // the output keeps their slots. Node leaves HOLES there and this tier
  // has none, so the slots hold `undefined` — length, `join`, `at` and
  // an indexed read all agree with Node, and only `Object.keys` parts
  // company. That is S016's padded-slot divergence by a second route.
  // The other collectors are dense in Node too, so theirs just end
  // shorter; `forEach` simply stops early.
  const res = await buildWasm(
    "dyn-invoke-shrink.ts",
    [
      "const out: string[] = [];",
      "const a: any = JSON.parse('[1,2,3,4]');",
      "const r: any = a.map(function (v: number, i: number): number { if (i === 0) { a.pop(); a.pop(); } return v * 2; });",
      "const rk: string[] = Object.keys(r);",
      "out.push('map len ' + String(r.length) + ' join [' + String(r.join(',')) + '] at2 ' + String(r.at(2)) +",
      "  ' idx2 ' + String(r[2]) + ' keys [' + rk.join(',') + ']');",
      "const b: any = JSON.parse('[1,2,3,4]');",
      "const f: any = b.filter(function (v: number, i: number): boolean { if (i === 0) { b.pop(); } return true; });",
      "out.push('filter len ' + String(f.length) + ' join [' + String(f.join(',')) + ']');",
      "const c: any = JSON.parse('[1,2,3,4]');",
      "const seen: string[] = [];",
      "c.forEach(function (v: number, i: number): void { seen.push(String(i) + ':' + String(v)); if (i === 0) { c.shift(); } });",
      "out.push('forEach ' + seen.join(' ') + ' len ' + String(c.length));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // S016 — Node answers keys [0,1]; every other field on this line is
      // Node's own, the empty join fields included.
      "map len 4 join [2,4,,] at2 undefined idx2 undefined keys [0,1,2,3]",
      "filter len 3 join [1,2,3]",
      "forEach 0:1 1:3 2:4 len 3",
      "",
    ].join("\n"),
  );
});

test("dyn invoke: a nullish receiver throws at the MEMBER GET, before any argument", async () => {
  // `nul.push(f())` never runs `f`: JS reads the member first and the
  // read is what throws. The test is the side-effect log, which stays
  // empty on that line and fills on the two that DO reach their
  // arguments (a receiver with no such method still evaluates them —
  // the call is what fails there, not the get). Node-exact.
  const res = await buildWasm(
    "dyn-invoke-order.ts",
    [
      "const l1: string[] = [];",
      "const l2: string[] = [];",
      "const l3: string[] = [];",
      "function s1(): number { l1.push('a'); return 1; }",
      "function s2(): number { l2.push('b'); return 1; }",
      "function s3(): number { l3.push('c'); return 1; }",
      "function show(f: () => unknown): string {",
      "  try { f(); return '(no throw)'; } catch (e) { return (e as Error).message; }",
      "}",
      "const nul: any = JSON.parse('null');",
      "const num: any = JSON.parse('5');",
      "const arr: any = JSON.parse('[1]');",
      "const out: string[] = [];",
      "out.push('null: ' + show(() => { return nul.push(s1()); }) + ' log [' + l1.join(',') + ']');",
      "out.push('num: ' + show(() => { return num.push(s2()); }) + ' log [' + l2.join(',') + ']');",
      "out.push('nope: ' + show(() => { return arr.nope(s3()); }) + ' log [' + l3.join(',') + ']');",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "null: Cannot read properties of null (reading 'push') log []",
      "num: num.push is not a function log [b]",
      "nope: arr.nope is not a function log [c]",
      "",
    ].join("\n"),
  );
});

test("S023: apply's argsArray — the array-like fence and the primitive's own TypeError", async () => {
  // Node reads `length` and the index members off an array-LIKE object
  // and calls successfully; this tier reads neither, so that case takes
  // the ladder's loud fence rather than borrowing V8's message for it.
  // A PRIMITIVE argsArray is the case that message is really for, and
  // Node throws it there too — that line is exact.
  const res = await buildWasm(
    "dyn-invoke-apply-like.ts",
    [
      "function f(a: unknown, b: unknown): string { return String(a) + '/' + String(b); }",
      "function box(v: unknown): unknown { return v; }",
      "const g: any = box(f);",
      "function mk(): unknown { return JSON.parse('{\"length\":2,\"0\":\"x\",\"1\":\"y\"}'); }",
      "const al: any = mk();",
      "function show(h: () => unknown): string {",
      "  try { return 'ok ' + String(h()); } catch (e) { return (e as Error).name + ': ' + (e as Error).message; }",
      "}",
      "const out: string[] = [];",
      "out.push('arraylike ' + show(() => { return g.apply(null, al); }));",
      "out.push('string ' + show(() => { return g.apply(null, 'ab'); }));",
      "out.push('number ' + show(() => { return g.apply(null, 5); }));",
      "out.push('array ' + show(() => { return g.apply(null, JSON.parse('[\"p\",\"q\"]')); }));",
      "out.push('nullish ' + show(() => { return g.apply(null, null); }));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // S023 — Node answers "ok x/y" here, which is exactly why this is a
      // fence and not the message below.
      "arraylike Error: 'Function.prototype.apply' with an array-like argsArray on a dynamic value is not supported yet",
      "string TypeError: CreateListFromArrayLike called on non-object",
      "number TypeError: CreateListFromArrayLike called on non-object",
      "array ok p/q",
      "nullish ok undefined/undefined",
      "",
    ].join("\n"),
  );
});

test("S024: a comparator's answer is read from numbers and booleans only", async () => {
  // The result reads the shared numeric slot, which no other kind fills,
  // so a STRING-returning comparator — consistent, and one Node sorts
  // correctly by applying ToNumber — reads as 0 at every pair and sorts
  // nothing. An INCONSISTENT boolean comparator is outside any claim:
  // ECMA-262 leaves it implementation-defined and the two simply differ.
  const res = await buildWasm(
    "dyn-invoke-cmpret.ts",
    [
      "const out: string[] = [];",
      "const a: any = JSON.parse('[3,1,2]');",
      "out.push('string ' + String(a.sort(function (x: number, y: number): string {",
      "  return x < y ? '-1' : (x > y ? '1' : '0');",
      "}).join(',')));",
      "const b: any = JSON.parse('[3,1,2]');",
      "out.push('boolean ' + String(b.sort(function (x: number, y: number): boolean { return x > y; }).join(',')));",
      // The kinds that DO read: a numeric comparator, and the default.
      "const c: any = JSON.parse('[3,1,2]');",
      "out.push('number ' + String(c.sort(function (x: number, y: number): number { return x - y; }).join(',')));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // S024 — Node answers 1,2,3: it ToNumbers the strings.
      "string 3,1,2",
      // S024 — Node answers 3,1,2 for the inconsistent one.
      "boolean 1,2,3",
      "number 1,2,3",
      "",
    ].join("\n"),
  );
});

test("S025: a dyn object spelling the reserved `%error` key IS an error", async () => {
  // Nothing reserves the marker on the way in, so JSON.parse over
  // untrusted input reaches the error encoding directly. Only its
  // PRESENCE is read, never its value. The C lane reproduces every line.
  const res = await buildWasm(
    "dyn-error-collision.ts",
    [
      "function mk(): unknown { return JSON.parse('{\"%error\":true,\"name\":\"Fake\",\"message\":\"m\"}'); }",
      "const u: any = mk();",
      "const out: string[] = [];",
      "const k: string[] = Object.keys(u);",
      "out.push('shaped isErr ' + String(u instanceof Error) + ' str [' + String(u) + '] typeof ' + typeof u +",
      "  ' keys [' + k.join(',') + ']');",
      "function bare(): unknown { return JSON.parse('{\"%error\":1}'); }",
      "const v: any = bare();",
      "out.push('bare isErr ' + String(v instanceof Error) + ' str [' + String(v) + ']');",
      "function falsy(): unknown { return JSON.parse('{\"%error\":false}'); }",
      "const w: any = falsy();",
      "out.push('falsy isErr ' + String(w instanceof Error) + ' str [' + String(w) + ']');",
      // The neighbour without the key is an ordinary object, exactly.
      "function plain(): unknown { return JSON.parse('{\"name\":\"Fake\",\"message\":\"m\"}'); }",
      "const p: any = plain();",
      "out.push('plain isErr ' + String(p instanceof Error) + ' str [' + String(p) + ']');",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // S025 — Node answers isErr false and str [object Object] on the
      // first three; the key list is Node's own on all four.
      "shaped isErr true str [Fake: m] typeof object keys [%error,name,message]",
      // With no name or message beside it, the error text is EMPTY.
      "bare isErr true str []",
      "falsy isErr true str []",
      "plain isErr false str [[object Object]]",
      "",
    ].join("\n"),
  );
});

test("S021: a crossed error's name and message are a SNAPSHOT of the crossing", async () => {
  // The encoding copies both strings, and the identity cache then pins
  // the box — so a mutation performed on the typed error AFTER it
  // crossed is invisible on every dyn read, including a second crossing.
  // Node reads both live. Identity holds on both lanes.
  const res = await buildWasm(
    "dyn-error-snapshot.ts",
    [
      "function run(): string {",
      "  try { throw new TypeError('boom'); } catch (e) {",
      "    const first: unknown = e;",
      "    (e as Error).message = 'MUTATED';",
      "    (e as Error).name = 'Renamed';",
      "    const second: unknown = e;",
      "    const x: any = first;",
      "    const y: any = second;",
      "    return 'first ' + String(x.name) + '/' + String(x.message) +",
      "      ' second ' + String(y.name) + '/' + String(y.message) +",
      "      ' same ' + String(x === y) + ' str [' + String(x) + ']';",
      "  }",
      "}",
      "console.log(run());",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  // S021 — Node answers Renamed/MUTATED on both sides and
  // [Renamed: MUTATED]; `same true` is exact on every lane.
  expect(stdout.toString("utf8")).toBe(
    "first TypeError/boom second TypeError/boom same true str [TypeError: boom]\n",
  );
});

test("S021/S022: a caught value crossing into `unknown`", async () => {
  // What the %error encoding answers, what it enumerates, and what a
  // payload with no dyn shape becomes. Node agrees with every line here
  // but the two marked ones; the C lane agrees with ALL of them,
  // identity included — one error crossing twice is one value on both,
  // because both go through the same per-error cache.
  const res = await buildWasm(
    "dyn-caught.ts",
    [
      "function cross(): unknown { try { throw new TypeError('boom'); } catch (e) { return e; } }",
      "const c: any = cross();",
      "const out: string[] = [];",
      "out.push('str [' + String(c) + '] isErr ' + String(c instanceof Error) + ' typeof ' + typeof c);",
      "out.push('name ' + String(c.name) + ' message ' + String(c.message) + ' marker ' + String(c['%error']));",
      "const keys: string[] = Object.keys(c);",
      "out.push('keys [' + keys.join(',') + ']');",
      // Error.prototype.toString's two empty-side rules.
      "function named(): unknown { try { const e = new Error('m'); e.name = ''; throw e; } catch (e) { return e; } }",
      "function noMsg(): unknown { try { const e = new Error(); e.name = 'Weird'; throw e; } catch (e) { return e; } }",
      "out.push('empties [' + String(named()) + '] [' + String(noMsg()) + ']');",
      // Identity: the SAME error, twice.
      "function twice(): string {",
      "  let x: unknown = undefined; let y: unknown = undefined;",
      "  const e = new Error('same');",
      "  try { throw e; } catch (v) { x = v; }",
      "  try { throw e; } catch (v) { y = v; }",
      "  let p: unknown = undefined; let q: unknown = undefined;",
      "  try { throw new Error('a'); } catch (v) { p = v; }",
      "  try { throw new Error('a'); } catch (v) { q = v; }",
      "  return 'same ' + String(x === y) + ' distinct ' + String(p === q);",
      "}",
      "out.push(twice());",
      // A user subclass rides errT, so it crosses like a builtin.
      "class CustomError extends Error {",
      "  constructor(m: string) { super(m); this.name = 'CustomError'; }",
      "}",
      "function custom(): unknown { try { throw new CustomError('cf'); } catch (e) { return e; } }",
      "const cu: any = custom();",
      "out.push('custom [' + String(cu) + '] isErr ' + String(cu instanceof Error) + ' name ' + String(cu.name));",
      // S022: a record has no dyn shape in the cell.
      "type Rec = { a: number };",
      "function rec(): unknown { try { const r: Rec = { a: 1 }; throw r; } catch (e) { return e; } }",
      "const r: any = rec();",
      "const rk: string[] = Object.keys(r);",
      "out.push('rec typeof ' + typeof r + ' truthy ' + String(r ? 'y' : 'n') + ' a ' + String(r.a) +",
      "  ' keys [' + rk.join(',') + '] isErr ' + String(r instanceof Error));",
      // Scalars are exact, and a thrown DYN value comes back as itself.
      "function scalar(): string {",
      "  let s: unknown = undefined; let n: unknown = undefined; let b: unknown = undefined;",
      "  try { throw 'plain'; } catch (e) { s = e; }",
      "  try { throw 42; } catch (e) { n = e; }",
      "  try { throw false; } catch (e) { b = e; }",
      "  return 'scalars ' + String(s) + ' ' + String(n) + ' ' + String(b) +",
      "    ' ' + typeof s + ' ' + typeof n + ' ' + typeof b;",
      "}",
      "out.push(scalar());",
      "const src: unknown = JSON.parse('{\"k\":1}');",
      "function bounce(v: unknown): unknown { try { throw v; } catch (e) { const u: unknown = e; return u; } }",
      "const back: any = bounce(src);",
      "out.push('bounce same ' + String(back === src) + ' k ' + String(back.k));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "str [TypeError: boom] isErr true typeof object",
      // S021 — Node reads name and message the same way but answers
      // `undefined` for the marker, which it has no equivalent of.
      "name TypeError message boom marker true",
      // S021 — Node answers [] here: its name and message are not
      // enumerable and its marker does not exist.
      "keys [%error,name,message]",
      "empties [m] [Weird]",
      "same true distinct false",
      "custom [CustomError: cf] isErr true name CustomError",
      // S022 — Node reads `a` as 1 and lists ["a"].
      "rec typeof object truthy y a undefined keys [] isErr false",
      "scalars plain 42 false string number boolean",
      "bounce same true k 1",
      "",
    ].join("\n"),
  );
});

test("dyn invoke: FUNC apply/call, and an object's OWN member", async () => {
  // The two Function.prototype names the dispatch admits, plus the OBJ
  // arm every name has (own properties shadow prototypes in JS too).
  // Node-exact throughout, C lane included. `apply` hands the argument
  // array's own payload straight to the thunk — no copy — so JS arity
  // does the rest: a missing argument IS undefined.
  const res = await buildWasm(
    "dyn-invoke-fn.ts",
    [
      "function msg(f: () => void): string {",
      "  try { f(); return '(no throw)'; } catch (e) { return (e as Error).message; }",
      "}",
      "function add3(a: unknown, b: unknown, c: unknown): string {",
      "  return String(a) + ':' + String(b) + ':' + String(c);",
      "}",
      "function box(v: unknown): unknown { return v; }",
      "const f: any = box(add3);",
      "const out: string[] = [];",
      "out.push('apply ' + String(f.apply(null, ['x', 'y', 'z'])));",
      "out.push('none ' + String(f.apply(undefined)) + ' null ' + String(f.apply(null, null)));",
      "out.push('call ' + String(f.call(null, 1, 2, 3)) + ' bare ' + String(f.call(null)));",
      "out.push('nonarr ' + msg(() => { f.apply(null, 5); }));",
      "out.push('f.push ' + msg(() => { f.push(1); }));",
      "function greet(who: unknown): string { return 'hi ' + String(who); }",
      "const obj: any = JSON.parse('{}');",
      "obj['greet'] = box(greet);",
      "obj['notFn'] = 5;",
      "out.push('own ' + String(obj.greet('there')));",
      "out.push('missing ' + msg(() => { obj.forEach(function (): void {}); }));",
      "out.push('notFn ' + msg(() => { obj.notFn(); }));",
      // Through an array element: mustCall's shape, one level in.
      "const arr: any = box([box(add3)]);",
      "out.push('nested ' + String(arr.at(0).apply(null, [1, 2, 3])));",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "apply x:y:z",
      "none undefined:undefined:undefined null undefined:undefined:undefined",
      "call 1:2:3 bare undefined:undefined:undefined",
      "nonarr CreateListFromArrayLike called on non-object",
      "f.push f.push is not a function",
      "own hi there",
      "missing obj.forEach is not a function",
      "notFn obj.notFn is not a function",
      "nested 1:2:3",
      "",
    ].join("\n"),
  );
});

test("dyn own-key ORDER: integer-like keys first, and where that range ends", async () => {
  // Object.keys' own-key order is the one place the array-index predicate
  // has to be WIDER than the keyed read's: the ordering range is
  // [0, 2^32-2], while canonIdx bails around 2^31. The near-misses pin
  // both edges. Node's answer for the mixed line, verified:
  //   ["0","9","10","4294967294","z","01","1.5","4294967295"," 1"]
  // — "4294967294" sorts as an index, "4294967295" (2^32-1) does not,
  // and neither do "01", "1.5" or a key with a leading space.
  const res = await buildWasm(
    "dyn-keyorder.js",
    [
      "'use strict';",
      "function j(u) {",
      "  const n = typeof u.length === 'number' ? u.length : 0;",
      "  let out = '';",
      "  for (let i = 0; i < n; i++) { out = out + (i > 0 ? '|' : '') + String(u[i]); }",
      "  return out;",
      "}",
      "const mixed = JSON.parse('{\"z\":1,\"01\":2,\"1.5\":3,\"4294967295\":4,\"4294967294\":5,\"0\":6,\" 1\":7,\"10\":8,\"9\":9}');",
      "console.log(j(Object.keys(mixed)));",
      "const small = JSON.parse('{\"b\":\"x\",\"2\":\"two\",\"a\":\"y\",\"0\":\"zero\"}');",
      "console.log(j(Object.keys(small)));",
      "console.log(j(Object.values(small)));",
      "const arr = JSON.parse('[\"p\",\"q\"]');",
      "console.log(j(Object.keys(arr)) + ' ' + j(Object.values(arr)));",
      "const str = JSON.parse('\"hi\"');",
      "console.log(j(Object.keys(str)) + ' ' + j(Object.values(str)));",
      "console.log('[' + j(Object.keys(JSON.parse('5'))) + ']');",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "0|9|10|4294967294|z|01|1.5|4294967295| 1",
      "0|2|b|a",
      "zero|two|x|y",
      "0|1 p|q",
      "0|1 h|i",
      "[]",
      "",
    ].join("\n"),
  );
});

test("dyn destructuring: V8's not-iterable and not-destructurable wordings", async () => {
  // Both families name things the emitter has to get from different
  // places: the ITERATION refusal describes the VALUE's kind (and Node
  // says bare "object" for a plain {}, not only for nullish), while the
  // pack form and the object form carry the SOURCE SPELLING from the IR.
  // Verified against node 24 with this program.
  const res = await buildWasm(
    "dyn-destr-texts.js",
    [
      "'use strict';",
      "const num = JSON.parse('5');",
      "const obj = JSON.parse('{\"a\":1}');",
      "try { const [z] = num; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { const [z] = obj; } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { const [z] = JSON.parse('{\"a\":1}'); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { const [z] = JSON.parse('null'); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { const [z] = JSON.parse('true'); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "let aa;",
      "try { ({ a: aa } = num); console.log('num ok ' + String(aa)); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "const nul = JSON.parse('null');",
      "try { ({ a: aa } = nul); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "const und = JSON.parse('[]')[3];",
      "try { ({ a: aa } = und); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "try { ({} = und); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "num is not iterable",
      "obj is not iterable",
      "object is not iterable (cannot read property Symbol(Symbol.iterator))",
      "object null is not iterable (cannot read property Symbol(Symbol.iterator))",
      "boolean true is not iterable (cannot read property Symbol(Symbol.iterator))",
      "num ok undefined",
      "Cannot destructure property 'a' of 'nul' as it is null.",
      "Cannot destructure property 'a' of 'und' as it is undefined.",
      "Cannot destructure 'und' as it is undefined.",
      "",
    ].join("\n"),
  );
});

test("dyn array destructuring steps by CODE POINT, unlike a keyed read", async () => {
  // The string iterator hands out whole code points — an astral
  // character arrives unsplit — where `s[0]` answers one UTF-16 unit.
  // S002's storage is what makes both exact; Node agrees line for line.
  const res = await buildWasm(
    "dyn-destr-astral.js",
    [
      "'use strict';",
      "const [c1, c2, c3] = JSON.parse('\"a\\\\ud83d\\\\ude00b\"');",
      "console.log(String(c1) + ' ' + String(c2) + ' ' + String(c3));",
      "console.log(String(c1.length) + ' ' + String(c2.length) + ' ' + String(c3.length));",
      "const s = JSON.parse('\"a\\\\ud83d\\\\ude00b\"');",
      "console.log(String(s.length) + ' ' + String(s[1] === s[1]));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["a \u{1F600} b", "1 2 1", "4 true", ""].join("\n"));
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
