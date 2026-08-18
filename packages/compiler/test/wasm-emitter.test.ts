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
import { parseFnEvalConstruct } from "../src/backend/wasm/emitter.js";

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

/** The --dynamic twin: jsval (`any` under --dynamic) exists ONLY under
 * this flag (nodes.ts's own jsval doc) — every increment-21 island test
 * below needs it. */
async function buildWasmDyn(name: string, source: string) {
  const entry = join(scratch, name);
  await writeFile(entry, source);
  return compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    dynamic: true,
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

test("toString:caught — String(e) over every exception-cell kind", async () => {
  // scr_caught_to_string ported (nodes.ts's "toString" node doc, the
  // exception cell's own snapshot — NOT the `unknown`-crossing sibling in
  // the "dyn: String(unknown)" test below, and not `e.toString()` on a
  // statically-typed Error, which was already reachable through the SAME
  // errToStrHelper via the "error.toString" libCall). Every text here is
  // measured against Node directly (`try { throw x } catch (e) {
  // console.log(String(e)) }`), not transcribed from the C runtime:
  //   throw 42        -> "42"            throw 3.14 -> "3.14"
  //   throw true/false -> "true"/"false"
  //   throw "hello"   -> "hello"
  //   throw new Error("msg") -> "Error: msg"
  //   throw new Error("")   -> "Error"          (message-less: name alone)
  //   throw new MyError("boom") (this.name = "MyError") -> "MyError: boom"
  //   throw {a:1} / throw [1,2,3] / throw function(){} -> all "[object
  //     Object]" in THIS runtime, where Node answers "[object Object]",
  //     "1,2,3", and the function's own source respectively — the exception
  //     cell type-erases every non-scalar, non-Error payload to one
  //     untyped ref with no shape to walk (S021/S022's family of
  //     representation-limit divergences for this same snapshot, ported
  //     from the C runtime's scr_caught_to_string, whose REF arm takes the
  //     identical fallthrough — shared with the LLVM/C lanes already).
  const res = await buildWasm(
    "caught-tostring.ts",
    [
      "class MyError extends Error {",
      "  constructor(msg: string) {",
      "    super(msg);",
      "    this.name = 'MyError';",
      "  }",
      "}",
      "try { throw 42; } catch (e) { console.log('f64-int', String(e)); }",
      "try { throw 3.14; } catch (e) { console.log('f64-frac', String(e)); }",
      "try { throw true; } catch (e) { console.log('bool-true', String(e)); }",
      "try { throw false; } catch (e) { console.log('bool-false', String(e)); }",
      "try { throw 'hello'; } catch (e) { console.log('str', String(e)); }",
      "try { throw new Error('msg'); } catch (e) { console.log('err', String(e)); }",
      "try { throw new Error(''); } catch (e) { console.log('err-empty', String(e)); }",
      "try { throw new MyError('boom'); } catch (e) { console.log('custom', String(e)); }",
      "try { throw { a: 1 }; } catch (e) { console.log('obj', String(e)); }",
      "try { throw [1, 2, 3]; } catch (e) { console.log('arr', String(e)); }",
      "try { throw function named() {}; } catch (e) { console.log('fn', String(e)); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "f64-int 42",
      "f64-frac 3.14",
      "bool-true true",
      "bool-false false",
      "str hello",
      "err Error: msg",
      "err-empty Error",
      "custom MyError: boom",
      "obj [object Object]",
      "arr [object Object]",
      "fn [object Object]",
      "",
    ].join("\n"),
  );
});

test("toString:caught — the F64 arm's edge payloads", async () => {
  // The gate probe's unvaried axes: the F64 arm formats through
  // f64ToStrHelper, which the pins above only exercised on finite
  // positives. Non-finite payloads and the negative zero take String()'s
  // rules, not inspect's — String(-0) is "0" where console.log(-0) prints
  // "-0" (%w.inspF64's signed-zero read never runs here). Every expected
  // text measured against Node directly (`try { throw x } catch (e) {
  // console.log(String(e)) }`).
  const res = await buildWasm(
    "caught-tostring-edge.ts",
    [
      "try { throw NaN; } catch (e) { console.log('nan', String(e)); }",
      "try { throw Infinity; } catch (e) { console.log('inf', String(e)); }",
      "try { throw -Infinity; } catch (e) { console.log('ninf', String(e)); }",
      "try { throw -0; } catch (e) { console.log('negzero', String(e)); }",
      "try { throw ''; } catch (e) { console.log('empty', JSON.stringify(String(e))); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["nan NaN", "inf Infinity", "ninf -Infinity", "negzero 0", 'empty ""', ""].join("\n"),
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

test("JSON.stringify: the compact forms a static type serializes to", async () => {
  // The type-directed walkers, one arm at a time: records in DECLARED
  // order, tuples as JSON arrays, arrays with their loop, nesting through
  // both, and unions dispatching on the tag (the null arm writes the text
  // `null`). Every expectation was captured by running the same program
  // under Node 24.18.
  const res = await buildWasm(
    "json-write-shapes.ts",
    [
      "interface Rec { b: number; a: string; ok: boolean }",
      "interface Inner { z: number }",
      "interface Outer { n: number[]; r: Inner }",
      "interface W { v: string | number | null }",
      'const rec: Rec = { b: 1, a: "x", ok: false };',
      "console.log(JSON.stringify(rec));",
      "console.log(JSON.stringify([1, 2, 3]));",
      'console.log(JSON.stringify(["a", "b"]));',
      'const tup: [string, number, boolean] = ["a", 1, true];',
      "console.log(JSON.stringify(tup));",
      "console.log(JSON.stringify([[1], [2, 3]]));",
      "const outer: Outer = { n: [1, 2], r: { z: 1 } };",
      "console.log(JSON.stringify(outer));",
      "const none: number[] = [];",
      "console.log(JSON.stringify(none));",
      "console.log(JSON.stringify('plain'), JSON.stringify(true), JSON.stringify(false));",
      "const vs: (string | number | null)[] = ['a', 1, null];",
      "console.log(JSON.stringify(vs));",
      "const ws: W[] = [{ v: null }, { v: 's' }, { v: 2 }];",
      "console.log(JSON.stringify(ws));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      '{"b":1,"a":"x","ok":false}',
      "[1,2,3]",
      '["a","b"]',
      '["a",1,true]',
      "[[1],[2,3]]",
      '{"n":[1,2],"r":{"z":1}}',
      "[]",
      '"plain" true false',
      '["a",1,null]',
      '[{"v":null},{"v":"s"},{"v":2}]',
      "",
    ].join("\n"),
  );
});

test("JSON.stringify: the number rule — non-finite is null, -0 is 0", async () => {
  // JSON has no NaN and no Infinity, so all three serialize as `null`
  // (which is NOT what String() does — the same value prints "NaN"
  // through console.log two lines apart here). Zero loses its sign for
  // the same reason String(-0) does.
  const res = await buildWasm(
    "json-write-nums.ts",
    [
      "const zero: number = 0;",
      "const negZero: number = -0;",
      "const nan: number = 0 / 0;",
      "const inf: number = 1 / 0;",
      "console.log(JSON.stringify([zero, negZero, 1, -1, 0.5, 1e21, 1 / 3, 1e-7]));",
      "console.log(JSON.stringify(nan), JSON.stringify(inf), JSON.stringify(-inf));",
      "console.log(JSON.stringify(negZero), String(negZero), String(nan));",
      "console.log(JSON.stringify([9007199254740993, 1.7976931348623157e308, 5e-324]));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "[0,0,1,-1,0.5,1e+21,0.3333333333333333,1e-7]",
      "null null null",
      "0 0 NaN",
      "[9007199254740992,1.7976931348623157e+308,5e-324]",
      "",
    ].join("\n"),
  );
});

test("S002: JSON.stringify is Node's WELL-FORMED form, lone surrogates escaped", async () => {
  // The one place stringify must diverge from the C reference. C walks
  // UTF-8 bytes whose storage substituted U+FFFD long before stringify
  // ever ran, so it has no surrogate to decide about; this tier stores
  // real UTF-16 units (S002), so an unpaired half arrives intact and Node
  // escapes it — ES2019's well-formed rule. A PAIR passes through as its
  // two units. No corpus program can pin any of this: the native lanes
  // disagree by construction, which is exactly S002's stance.
  //
  // Note what is NOT escaped: '/', DEL (0x7f), and every non-ASCII
  // character. Captured from Node 24.18 with the JS twin of this program.
  const res = await buildWasm(
    "json-write-escapes.ts",
    [
      `const s: string = '"' + '\\\\' + '\\b\\f\\n\\r\\t' + '\\u0000\\u001f\\u007f' + '/' + 'é✓';`,
      "console.log(JSON.stringify(s));",
      // Each half of the surrogate range, alone: all four escape.
      `console.log(JSON.stringify(['\\ud800', '\\udc00', '\\udbff', '\\udfff']));`,
      // A pair passes verbatim, and stays verbatim next to a lone half.
      `console.log(JSON.stringify(['\\ud83d\\ude00', 'a\\ud83d\\ude00b', '\\ud800\\ud83d\\ude00', '\\ud83d\\ude00\\udc00']));`,
      // Low-then-high is TWO unpaired halves, not a pair the wrong way up.
      `console.log(JSON.stringify(['\\udc00\\ud800', '\\ud800\\ud800\\udc00']));`,
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      String.raw`"\"\\\b\f\n\r\t\u0000\u001f` + '\u007f/é✓"',
      String.raw`["\ud800","\udc00","\udbff","\udfff"]`,
      '["😀","a😀b","' + String.raw`\ud800` + '😀","😀' + String.raw`\udc00` + '"]',
      '["' + String.raw`\udc00\ud800` + '","' + String.raw`\ud800` + '𐀀"]',
      "",
    ].join("\n"),
  );
});

test("JSON.stringify: record KEYS escape by the SAME rule as values", async () => {
  // Node escapes keys with the full well-formed rule (verified against
  // Node 24.18). The C generator writes keys RAW through cStringLiteral,
  // which is a latent native-lane divergence for any key needing an
  // escape — C's bug, not a rule to inherit, so no corpus program can pin
  // this either. The labels here are baked at COMPILE time, which is why
  // the escape rule exists twice (jsonQuote in TS, jbPutStr in wasm).
  //
  // A lone-surrogate KEY is absent on purpose: tsc 7's checker talks to
  // its native half over a JSON channel that rejects an unpaired half in
  // a property name, so such a program cannot be compiled at all. That
  // unit is pinned as a VALUE by the S002 test above, through the very
  // rule jsonQuote mirrors.
  const res = await buildWasm(
    "json-write-keys.ts",
    [
      "interface K {",
      `  '"quoted"': number;`,
      "  'new\\nline': number;",
      "  'ctl\\u0001x': number;",
      "  'back\\\\slash': number;",
      "  plain: number;",
      "}",
      "const k: K = {",
      `  '"quoted"': 1,`,
      "  'new\\nline': 2,",
      "  'ctl\\u0001x': 3,",
      "  'back\\\\slash': 4,",
      "  plain: 5,",
      "};",
      "console.log(JSON.stringify(k));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    String.raw`{"\"quoted\"":1,"new\nline":2,"ctl\u0001x":3,"back\\slash":4,"plain":5}` + "\n",
  );
});

test("JSON.stringify: a key a PROGRAM spelled '%x' serializes, unlike an internal", async () => {
  // The distinction is the mechanism, and getting it wrong is a silent
  // miscompile rather than a refusal. Compiler-synthesized members
  // (Dirent's %dtype) are hidden from JSON because declaredOrder OMITS
  // them — not because of anything about their name. A key a program
  // actually wrote is in declaredOrder, so it serializes, and Node and
  // the native lanes all print it. An emitter that filtered on the '%'
  // prefix instead would drop it and say nothing; that is the bug this
  // pins against, and a shape whose keys ALL start with '%' is the case
  // where such a filter produces an empty object out of a full one.
  //
  // Captured from Node 24.18. No corpus program uses a '%' key, which is
  // why the axis went untested until an oracle probe varied it.
  const res = await buildWasm(
    "json-write-pct-keys.ts",
    [
      "interface Pct { '%dtype': number; plain: string }",
      "interface AllPct { '%a': number; '%b': number }",
      "const pct: Pct = { '%dtype': 1, plain: 'a' };",
      "console.log(JSON.stringify(pct));",
      "console.log(JSON.stringify({ '%x': 1, y: 2 }));",
      "const allPct: AllPct = { '%a': 1, '%b': 2 };",
      "console.log(JSON.stringify(allPct));",
      "console.log(JSON.stringify([pct]));",
      "console.log(JSON.stringify(pct, null, 2));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      '{"%dtype":1,"plain":"a"}',
      '{"%x":1,"y":2}',
      '{"%a":1,"%b":2}',
      '[{"%dtype":1,"plain":"a"}]',
      "{",
      '  "%dtype": 1,',
      '  "plain": "a"',
      "}",
      "",
    ].join("\n"),
  );
});

test("JSON.stringify: optional fields DROP, exactly like Node", async () => {
  // An undefined-armed field turns comma placement into runtime state (a
  // `first` flag); an all-required shape keeps its separators baked into
  // the label literals. Both paths are here, plus the all-optional shape
  // holding nothing — the only way to reach `{}` on this tier, since an
  // empty interface types as `unknown` and takes the dyn root instead.
  const res = await buildWasm(
    "json-write-optional.ts",
    [
      "interface P { a?: string; b: number; c?: number }",
      "interface Q { only?: number }",
      "const p1: P = { b: 1 };",
      "const p2: P = { a: 'x', b: 1, c: 2 };",
      "const p3: P = { a: 'x', b: 1 };",
      "const p4: P = { b: 1, c: 2 };",
      "console.log(JSON.stringify(p1), JSON.stringify(p2), JSON.stringify(p3), JSON.stringify(p4));",
      "const q: Q = {};",
      "console.log(JSON.stringify(q), JSON.stringify({ only: 1 } as Q));",
      "console.log(JSON.stringify([p1, p2]));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      '{"b":1} {"a":"x","b":1,"c":2} {"a":"x","b":1} {"b":1,"c":2}',
      '{} {"only":1}',
      '[{"b":1},{"a":"x","b":1,"c":2}]',
      "",
    ].join("\n"),
  );
});

test("JSON.stringify: `space` re-indents with Node's gap algorithm", async () => {
  // The pretty form is a REWRITE of the compact text, so what it has to
  // get right is the state machine: empty `{}` and `[]` stay inline,
  // structural characters INSIDE a string are untouched, the key colon
  // gains one space, and a string space (not just a number) works.
  // Scalars ignore the space entirely. Captured from Node 24.18.
  const res = await buildWasm(
    "json-write-indent.ts",
    [
      "interface Meta { n: number; ok: boolean }",
      // All-optional and holding nothing: the tier's only `{}` (an empty
      // interface types as `unknown`, which is the dyn root).
      "interface Empty { only?: number }",
      "interface Doc { name: string; tags: string[]; meta: Meta; empty: Empty; none: number[] }",
      "const doc: Doc = { name: 'x', tags: ['a', 'b'], meta: { n: 1, ok: true }, empty: {}, none: [] };",
      "console.log(JSON.stringify(doc, null, 2));",
      "console.log('---');",
      "console.log(JSON.stringify(doc, null, '--'));",
      "console.log('---');",
      `console.log(JSON.stringify({ s: 'a:b,c{d}e"f' }, null, 2));`,
      "console.log('---');",
      "console.log(JSON.stringify([1, [2, [3]]], null, 1));",
      "console.log('---');",
      "console.log(JSON.stringify('scalar', null, 2), JSON.stringify(7, null, 2));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "{",
      '  "name": "x",',
      '  "tags": [',
      '    "a",',
      '    "b"',
      "  ],",
      '  "meta": {',
      '    "n": 1,',
      '    "ok": true',
      "  },",
      '  "empty": {},',
      '  "none": []',
      "}",
      "---",
      "{",
      '--"name": "x",',
      '--"tags": [',
      '----"a",',
      '----"b"',
      "--],",
      '--"meta": {',
      '----"n": 1,',
      '----"ok": true',
      "--},",
      '--"empty": {},',
      '--"none": []',
      "}",
      "---",
      "{",
      `  "s": "a:b,c{d}e${String.raw`\"`}f"`,
      "}",
      "---",
      "[",
      " 1,",
      " [",
      "  2,",
      "  [",
      "   3",
      "  ]",
      " ]",
      "]",
      "---",
      '"scalar" 7',
      "",
    ].join("\n"),
  );
});

test("JSON.stringify over a dyn ROOT: the tree's own kinds drive the walk", async () => {
  // No static type to direct a serializer, so the dyn tree's kinds do it.
  // The lines that are easy to get wrong, and what each pins:
  //
  //  - OWN-KEY ORDER. Integer-like keys come out ASCENDING FIRST whatever
  //    order they went in, because Node's stringify uses
  //    EnumerableOwnPropertyNames. The C runtime walks its entry table in
  //    insertion order and so answers {"2":1,"1":2,...} here — a
  //    native-lane divergence this tier does not inherit (task #7).
  //  - ABSENCE, which means three different things by position: an object
  //    MEMBER holding undefined or a function drops with its key, an
  //    array SLOT holding one prints null, and a dropped ROOT becomes the
  //    TEXT "undefined" (Node returns the undefined VALUE, which
  //    console.log renders identically — the lowering's documented rule).
  //  - A promise has no own enumerable properties, so it is `{}`.
  //
  // Every expectation captured by running the JS twin under Node 24.18.
  const res = await buildWasm(
    "json-dyn-root.ts",
    [
      `const u1: unknown = JSON.parse('[1,"a",true,null,2.5]');`,
      "console.log(JSON.stringify(u1));",
      `const u2: unknown = JSON.parse('{"b":1,"a":[1,{"c":null}]}');`,
      "console.log(JSON.stringify(u2));",
      `const u3: unknown = JSON.parse('{"2":1,"1":2,"b":3,"a":4}');`,
      "console.log(JSON.stringify(u3));",
      "const o: any = {};",
      "o.a = 1; o.b = undefined; o.c = function () { return 1; }; o.d = 2;",
      "console.log(JSON.stringify(o as unknown));",
      "const arr: any = [1, undefined, 2];",
      "console.log(JSON.stringify(arr as unknown));",
      "const hole: any = [];",
      "hole[3] = 1;",
      "console.log(JSON.stringify(hole as unknown));",
      "const gone: unknown = undefined;",
      "console.log(JSON.stringify(gone));",
      // Through a dyn-typed BINDING: `p as unknown` keeps the static
      // Promise type at the call, which the frontend fences.
      "const p: Promise<unknown> = Promise.resolve(1 as unknown);",
      "const pu: unknown = p;",
      "console.log(JSON.stringify(pu));",
      `const nums: unknown = JSON.parse('[1e21,0.1,-0]');`,
      "console.log(JSON.stringify(nums));",
      "const keyed: any = {};",
      `keyed['a"b'] = 'q\\nr';`,
      "console.log(JSON.stringify(keyed as unknown));",
      `const doc: unknown = JSON.parse('{"b":[1,{"c":"x"}],"a":{}}');`,
      "console.log(JSON.stringify(doc, null, 2));",
      // A dropped root is dropped whatever `space` says — Node returns
      // the undefined VALUE and never reaches its gap algorithm, and the
      // re-indenter here leaves the text "undefined" alone because it
      // reacts only to structural characters. A boxed CLOSURE is the
      // other root that drops, alongside undefined.
      "console.log(JSON.stringify(gone, null, 2));",
      "const f = function (): number { return 1; };",
      "const fu: unknown = f;",
      "console.log(JSON.stringify(fu), JSON.stringify(fu, null, 2));",
      // The same two values in the two positions that keep them: an
      // object member drops with its key, an array slot prints null.
      "const drops: any = {};",
      "drops.a = f; drops.b = undefined; drops.c = 1;",
      "console.log(JSON.stringify(drops as unknown, null, 2));",
      "const slots: any = [];",
      "slots.push(f); slots.push(undefined);",
      "console.log(JSON.stringify(slots as unknown, null, 2));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      '[1,"a",true,null,2.5]',
      '{"b":1,"a":[1,{"c":null}]}',
      '{"1":2,"2":1,"b":3,"a":4}',
      '{"a":1,"d":2}',
      "[1,null,2]",
      "[null,null,null,1]",
      "undefined",
      "{}",
      "[1e+21,0.1,0]",
      String.raw`{"a\"b":"q\nr"}`,
      "{",
      '  "b": [',
      "    1,",
      "    {",
      '      "c": "x"',
      "    }",
      "  ],",
      '  "a": {}',
      "}",
      "undefined",
      "undefined undefined",
      "{",
      '  "c": 1',
      "}",
      "[",
      "  null,",
      "  null",
      "]",
      "",
    ].join("\n"),
  );
});

test("S021: a crossed error stringifies as its MEMBERS, where Node answers {}", async () => {
  // The dyn tree has no non-enumerable properties, so the error encoding
  // stores name/message as ordinary members beside the reserved `%error`
  // marker — and stringify, which walks own enumerable keys, prints them.
  // S021 names this exact output as one of its consequences; this is the
  // pin. Node answers `{}` for the same throw (Error's own properties are
  // non-enumerable). The native lanes agree with this tier, because C
  // builds the same encoding.
  const res = await buildWasm(
    "json-dyn-error.ts",
    [
      'try { throw new TypeError("boom"); }',
      "catch (e) { const u: unknown = e; console.log(JSON.stringify(u)); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(`{"%error":true,"name":"TypeError","message":"boom"}\n`);
});

test("S026: the dyn stringify walker caps depth at 1000, catchably", async () => {
  // Node caps this too, and reports the SAME RangeError with the SAME
  // message — its limit is just implementation-defined and stack-
  // dependent (measured on Node 24.18: roughly 875 levels at
  // --stack-size=200, ~4.5k at the default, ~18k at --stack-size=4000,
  // drifting a few levels run to run). Ours is a fixed 1000, which is
  // what S026 registers.
  //
  // 999 links means 1000 nested objects, which is exactly the cap; one
  // more throws. A CYCLIC tree is the OTHER way to recurse forever, and it
  // is now reported the way Node reports it — the circular-structure
  // TypeError, message and edge path included — because the dyn walker
  // grew the seen stack S026 named as the fix. The depth cap is what
  // catches a deep ACYCLIC tree, the seen stack what catches a cyclic one,
  // and the two share `jbEnter`. (The C runtime has neither guard and dies
  // of SIGSEGV with the stack exhausted, which is the uncatchable version
  // of both failures.)
  //
  // The tree is built at TOP LEVEL on purpose: a dyn value bound by a
  // block-scoped `const` inside a loop is COPIED rather than aliased on
  // this tier, so the usual `const x = {}; o.a = x; o = x` idiom builds a
  // tree one level deep. That is a pre-existing dyn-surface bug, filed
  // separately; this test steps around it rather than depending on it.
  const res = await buildWasm(
    "json-dyn-depth.ts",
    [
      "const a: any = {};",
      "let oa: any = a;",
      "let xa: any = null;",
      "for (let i = 0; i < 999; i++) { xa = {}; oa.a = xa; oa = xa; }",
      "console.log('999 links:', JSON.stringify(a as unknown).length);",
      "const b: any = {};",
      "let ob: any = b;",
      "let xb: any = null;",
      "for (let i = 0; i < 1000; i++) { xb = {}; ob.a = xb; ob = xb; }",
      "try { JSON.stringify(b as unknown); console.log('1000 links: no throw'); }",
      "catch (e) { if (e instanceof RangeError) console.log('1000 links: RangeError: ' + e.message); else console.log('wrong kind'); }",
      "const c: any = {};",
      "c.self = c;",
      "try { JSON.stringify(c as unknown); console.log('cyclic: no throw'); }",
      "catch (e) { if (e instanceof TypeError) console.log('cyclic: ' + e.message); else console.log('wrong kind'); }",
      // An ARRAY root and a longer edge path, so the message's `index N`
      // form and its intermediate lines are pinned over a DYN tree too (the
      // static walker's own pins are in the circular-structures test).
      "const av: any = [];",
      "const inner: any = [];",
      "av[0] = inner;",
      "inner[0] = av;",
      "try { JSON.stringify(av as unknown); }",
      "catch (e) { console.log((e as Error).message); }",
      "const nest: any = {};",
      "const mid: any = {};",
      "const leaf: any = {};",
      "nest.a = mid;",
      "mid.b = leaf;",
      "leaf.back = nest;",
      "try { JSON.stringify(nest as unknown); }",
      "catch (e) { console.log((e as Error).message); }",
      // The buffer and the depth counter both reset for the next call —
      // a throw mid-walk must not poison the one after it.
      `console.log('recovered:', JSON.stringify(JSON.parse('{"ok":1}')));`,
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "999 links: 5996",
      "1000 links: RangeError: Maximum call stack size exceeded",
      // V8's message, byte for byte — the same builder the static walker
      // uses, now reached from the dyn walk.
      "cyclic: Converting circular structure to JSON",
      "    --> starting at object with constructor 'Object'",
      "    --- property 'self' closes the circle",
      "Converting circular structure to JSON",
      "    --> starting at object with constructor 'Array'",
      "    |     index 0 -> object with constructor 'Array'",
      "    --- index 0 closes the circle",
      "Converting circular structure to JSON",
      "    --> starting at object with constructor 'Object'",
      "    |     property 'a' -> object with constructor 'Object'",
      "    |     property 'b' -> object with constructor 'Object'",
      "    --- property 'back' closes the circle",
      `recovered: {"ok":1}`,
      "",
    ].join("\n"),
  );
});

test("circular structures: V8's message, byte for byte", async () => {
  // A recursive record type admits reference cycles, and stringifying one
  // throws V8's exact TypeError. The corpus program (2484) covers the
  // shapes it can; these are the ones it cannot reach:
  //
  //  - THE ELLIPSIS BOUNDARY. More than three hops elide the middle,
  //    keeping the first two and the last. Three hops do not elide, so
  //    the rule is pinned on both sides of the edge rather than only
  //    past it.
  //  - AN ARRAY as the starting object, which is the only way to see
  //    "constructor 'Array'" on the `--> starting at` line and a
  //    property edge on the closing one.
  //  - A DAG is NOT a cycle: detection is STACK membership, so a shared
  //    subtree serializes twice, exactly like Node.
  //  - Recovery, which is what the site's prologue buys: after a throw
  //    the walk never reached its finish, so the buffer AND the seen
  //    stack are both left dirty for the next call to reset.
  //
  // Every line was diffed against Node 24.18 running the same program.
  const res = await buildWasm(
    "json-circular.ts",
    [
      "interface L { next: L | null }",
      "interface Box { items: Box[] }",
      "function msg(f: () => void): string {",
      "  try { f(); return 'no throw'; }",
      "  catch (e) { return e instanceof TypeError ? (e as Error).message : 'wrong kind'; }",
      "}",
      "function chain(n: number): L {",
      "  const head: L = { next: null };",
      "  let cur: L = head;",
      "  for (let i = 0; i < n; i++) { const x: L = { next: null }; cur.next = x; cur = x; }",
      "  cur.next = head;",
      "  return head;",
      "}",
      "for (const n of [2, 3, 4]) {",
      "  console.log('--- hops ' + String(n));",
      "  console.log(msg(() => { JSON.stringify(chain(n)); }));",
      "}",
      "const b: Box = { items: [] };",
      "b.items.push(b);",
      "console.log('--- array root');",
      "console.log(msg(() => { JSON.stringify(b.items); }));",
      "const shared: Box = { items: [] };",
      "const dag: Box = { items: [shared, shared] };",
      "console.log('--- dag');",
      "console.log(JSON.stringify(dag));",
      "const acyclic: L = { next: { next: null } };",
      "console.log('--- recovered');",
      "console.log(JSON.stringify(acyclic), JSON.stringify(acyclic, null, 2).length);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const hop = "    |     property 'next' -> object with constructor 'Object'";
  expect(stdout.toString("utf8")).toBe(
    [
      "--- hops 2",
      "Converting circular structure to JSON",
      "    --> starting at object with constructor 'Object'",
      hop,
      hop,
      "    --- property 'next' closes the circle",
      "--- hops 3",
      "Converting circular structure to JSON",
      "    --> starting at object with constructor 'Object'",
      hop,
      hop,
      hop,
      "    --- property 'next' closes the circle",
      "--- hops 4",
      "Converting circular structure to JSON",
      "    --> starting at object with constructor 'Object'",
      hop,
      hop,
      "    |     ...",
      hop,
      "    --- property 'next' closes the circle",
      "--- array root",
      "Converting circular structure to JSON",
      "    --> starting at object with constructor 'Array'",
      "    |     index 0 -> object with constructor 'Object'",
      "    --- property 'items' closes the circle",
      "--- dag",
      '{"items":[{"items":[]},{"items":[]}]}',
      "--- recovered",
      '{"next":{"next":null}} 36',
      "",
    ].join("\n"),
  );
});

test("S026: the STATIC walker for a recursive type is capped too", async () => {
  // A walker for a recursive TYPE recurses at runtime, so a deep but
  // perfectly ACYCLIC value has unbounded recursion and nothing to do
  // with cycles. Uncapped this was measured trapping between 5000 and
  // 10000 links — and trapping UNCATCHABLY, the program's own `try`
  // never running and its buffered output never flushed, which is the
  // abort family rather than an exception. Sharing S026's counter with
  // the seen-stack bracket makes it the same catchable failure the dyn
  // walker gives, at the same documented depth.
  //
  // What the other lanes do here, measured: Node throws a catchable
  // RangeError at ~4.5k on its default stack, and the C lane serializes
  // 120000 levels happily before SIGSEGVing somewhere under 300000. So
  // 1200 links serialize under both of those and throw here — the limit
  // divergence S026 registers, now on the static path too.
  const res = await buildWasm(
    "json-deep-static.ts",
    [
      "interface L { next: L | null }",
      "function build(n: number): L {",
      "  const head: L = { next: null };",
      "  let cur: L = head;",
      "  for (let i = 0; i < n; i++) { const x: L = { next: null }; cur.next = x; cur = x; }",
      "  return head;",
      "}",
      // 999 links is 1000 nested objects: exactly the cap.
      "for (const d of [999, 1000, 5000]) {",
      "  try { console.log(d, 'ok', JSON.stringify(build(d)).length); }",
      "  catch (e) { if (e instanceof RangeError) console.log(d, 'RangeError:', e.message); else console.log(d, 'wrong kind'); }",
      "}",
      // The counter resets with the buffer and the seen stack, so an
      // ordinary value after an over-cap throw still serializes.
      "console.log('recovered:', JSON.stringify(build(2)));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "999 ok 9004",
      "1000 RangeError: Maximum call stack size exceeded",
      "5000 RangeError: Maximum call stack size exceeded",
      'recovered: {"next":{"next":{"next":null}}}',
      "",
    ].join("\n"),
  );
});

test("circular structures: the throw reaches the CALLER, and the first one wins", async () => {
  // Two wrong-answer shapes, both found by review rather than by any
  // test, and both about the throw's PLUMBING rather than its detection.
  //
  //  - THE SITE MUST CHECK. A root that merely CONTAINS a cyclic type
  //    without being reachable from itself is not itself cycle-capable,
  //    so a site predicate asking "is the root cyclic?" answered false
  //    and skipped the pending check — the walk threw, the site returned
  //    a garbage string, and an unreachable trap followed downstream.
  //    Outer-over-cyclic-Inner and the tuple root are that shape, for
  //    the circular TypeError AND for the depth RangeError.
  //  - THE FIRST THROW WINS. The exception cell is filled
  //    unconditionally, so a walk that kept going after failing once
  //    reported whatever failed LAST: `x.a = x; x.b = x` named
  //    property 'b' where Node names 'a', and a sibling's depth
  //    RangeError overwrote a circular TypeError outright — which an
  //    `instanceof TypeError` catch then misses entirely.
  //
  // Node's answers, captured by running the same program, except the
  // holder/depth line: a 2000-deep chain serializes fine under Node
  // (its limit is ~4.5k) and throws here at the fixed 1000, which is the
  // limit divergence SEMANTICS.md S026 registers.
  const res = await buildWasm(
    "json-circular-plumbing.ts",
    [
      "interface Inner { self: Inner | null; tag: string }",
      "interface Outer { name: string; inner: Inner }",
      "interface Two { a: Two | null; b: Two | null }",
      "interface Deep { next: Deep | null }",
      "interface Mixed { a: Mixed | null; b: Deep | null }",
      "interface Holder { label: string; deep: Deep }",
      "function caught(f: () => void): string {",
      "  try { f(); return 'no throw'; }",
      "  catch (e) {",
      "    if (e instanceof TypeError) { const m = (e as Error).message.split('\\n'); return 'TypeError|' + m[0] + '|' + m[m.length - 1]; }",
      "    if (e instanceof RangeError) return 'RangeError: ' + (e as Error).message;",
      "    return 'other';",
      "  }",
      "}",
      "function chain(n: number): Deep {",
      "  const head: Deep = { next: null };",
      "  let cur: Deep = head;",
      "  for (let i = 0; i < n; i++) { const x: Deep = { next: null }; cur.next = x; cur = x; }",
      "  return head;",
      "}",
      "const inner: Inner = { self: null, tag: 'i' };",
      "inner.self = inner;",
      "const outer: Outer = { name: 'o', inner };",
      "console.log('outer/circular:', caught(() => { JSON.stringify(outer); }));",
      "const holder: Holder = { label: 'h', deep: chain(2000) };",
      "console.log('holder/depth:', caught(() => { JSON.stringify(holder); }));",
      "const tup: [string, Inner] = ['t', inner];",
      "console.log('tuple/circular:', caught(() => { JSON.stringify(tup); }));",
      "const two: Two = { a: null, b: null };",
      "two.a = two; two.b = two;",
      "console.log('two-cycles:', caught(() => { JSON.stringify(two); }));",
      "const mixed: Mixed = { a: null, b: null };",
      "mixed.a = mixed; mixed.b = chain(2000);",
      "console.log('kind:', caught(() => { JSON.stringify(mixed); }));",
      "console.log('recovered:', JSON.stringify({ ok: 1 }));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const circ = "TypeError|Converting circular structure to JSON|    --- property ";
  expect(stdout.toString("utf8")).toBe(
    [
      `outer/circular: ${circ}'self' closes the circle`,
      "holder/depth: RangeError: Maximum call stack size exceeded",
      `tuple/circular: ${circ}'self' closes the circle`,
      `two-cycles: ${circ}'a' closes the circle`,
      `kind: ${circ}'a' closes the circle`,
      'recovered: {"ok":1}',
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
      // Rung two, S023: `.at` is REAL now (increment 21 stage B, gate
      // 2 — 1113's own measured need, shared here for free since
      // dyn.invoke() is the SAME ladder jsval ≡ dyn routes through);
      // `.indexOf` with a non-string needle stays the S023 fence.
      "(no throw)",
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

test("dyn.this: the ambient receiver — OBJ dispatch, apply/call, nesting, throw-restore", async () => {
  // `this` in a plain (non-arrow, non-method) function in a JS source
  // file is the checked-dynamic AMBIENT receiver (lower-exprs.ts's
  // dyn.this libCall, scr_dyn_this_get ported): empty stack answers the
  // strict-mode plain-call undefined; the OBJ-dispatch and FUNC
  // apply/call arms of dyn.invoke (the ONLY wasm-reachable push sites —
  // dynInvoke only exists for DYN_DISPATCH_METHODS names, so the
  // receiver must be reached through one of those, not an arbitrary
  // property name) bind it around their call window, C-exact
  // (scr_dyn_invoke.c:358-397). Node-verified throughout.
  const res = await buildWasm(
    "dyn-this.js",
    [
      "function bare() {",
      '  return this === undefined ? "bare-undefined" : "bare-bound";',
      "}",
      "const out = [];",
      "out.push(bare());",
      "",
      "function readTag() {",
      '  return this ? String(this.tag) : "no-this";',
      "}",
      "const obj = JSON.parse('{\"tag\":\"objtag\"}');",
      "obj.forEach = readTag;",
      "out.push('obj:' + obj.forEach());",
      "",
      "function outerRead() {",
      "  const before = this.tag;",
      "  const innerResult = obj2.push();",
      "  const after = this.tag;",
      "  return before + '/' + innerResult + '/' + after;",
      "}",
      "function innerRead() {",
      "  return this.tag;",
      "}",
      "const obj1 = JSON.parse('{\"tag\":\"outer\"}');",
      "obj1.forEach = outerRead;",
      "const obj2 = JSON.parse('{\"tag\":\"inner\"}');",
      "obj2.push = innerRead;",
      "out.push('nested-obj:' + obj1.forEach());",
      "",
      "function throwing() {",
      "  throw new Error('boom');",
      "}",
      "function wrapper() {",
      "  const before = this.tag;",
      "  let caught = null;",
      "  try {",
      "    thrower.on();",
      "  } catch (e) {",
      "    caught = e.message;",
      "  }",
      "  const after = this.tag;",
      "  return before + '/' + caught + '/' + after;",
      "}",
      "const thrower = JSON.parse('{\"tag\":\"thrower\"}');",
      "thrower.on = throwing;",
      "const wrapperObj = JSON.parse('{\"tag\":\"wrapper\"}');",
      "wrapperObj.on = wrapper;",
      "out.push('throw:' + wrapperObj.on());",
      "",
      "const fnBag = JSON.parse('{}');",
      "fnBag.fn = readTag;",
      "out.push('call:' + fnBag.fn.call(JSON.parse('{\"tag\":\"viaCall\"}')));",
      "out.push('apply:' + fnBag.fn.apply(JSON.parse('{\"tag\":\"viaApply\"}')));",
      "out.push('call-none:' + fnBag.fn.call());",
      "out.push('call-null:' + fnBag.fn.call(null));",
      "out.push('call-undef:' + fnBag.fn.call(undefined));",
      "",
      "function outerCall() {",
      "  const before = this ? this.tag : 'no-this';",
      "  const innerResult = fnBag.fn.call(innerArg);",
      "  const after = this ? this.tag : 'no-this';",
      "  return before + '/' + innerResult + '/' + after;",
      "}",
      "const outerBag = JSON.parse('{}');",
      "outerBag.fn = outerCall;",
      "const innerArg = JSON.parse('{\"tag\":\"innerCall\"}');",
      "out.push('nested-call:' + outerBag.fn.call(JSON.parse('{\"tag\":\"outerCall\"}')));",
      "",
      "console.log(out.join('\\n'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "bare-undefined",
      "obj:objtag",
      "nested-obj:outer/inner/outer",
      "throw:wrapper/boom/wrapper",
      "call:viaCall",
      "apply:viaApply",
      "call-none:no-this",
      "call-null:no-this",
      "call-undef:no-this",
      "nested-call:outerCall/innerCall/outerCall",
      "",
    ].join("\n"),
  );
});

test("dyn.this: a suspendable body reading it refuses LOUD, not a silent post-await miscompile", async () => {
  // statemachine.ts's checkEligible() fence: `dyn.this`'s ambient-receiver
  // bracket (thisPush/thisPop around dyn.invoke's OBJ/apply/call arms) is
  // a synchronous push-call-pop around ONE callFn() invocation, and this
  // backend's async/generator lowering makes a suspending call RETURN at
  // its first await (the wrapper/resume split) rather than blocking the
  // way a native fiber does — so the pop would already have run by the
  // time resumption (promises.ts's drain()) replays the rest of the body,
  // and a `this` read after that point would silently see whatever the
  // ambient stack holds at resume time, not the receiver the call bound.
  // Every `this` read simply refused before this rider, so a suspendable
  // body reaching one is a NEWLY OPENED window — fenced rather than left
  // latent, unconditionally (before/after the first await undistinguished
  // — this minimal body has no await at all, and still refuses).
  const res = await buildWasm(
    "dyn-this-suspending.js",
    ["async function m() {", "  return this;", "}", "m();", ""].join("\n"),
  );
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
  expect(res.diagnostics[0]?.message).toContain("(libCall:dyn.this:suspending)");
  expect(res.wasmSurvey).toBeDefined();
  expect(res.wasmSurvey).toContain("libCall:dyn.this:suspending");
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

test("strIntrinsic: the lre-backed case pair compiles and runs (increment 20 stage B — gate open)", async () => {
  // Was "refuses by member" through stage A; the gate opened in stage B
  // (emitter.ts's early-refuse deleted, casing.ts wired into the main
  // strIntrinsic switch) — this now exercises the real end-to-end path,
  // not just the builder-level pin suite in wasm-casing.test.ts.
  const res = await buildWasm(
    "lower.ts",
    ['console.log("AbC".toLowerCase());', 'console.log("AbC".toUpperCase());', ""].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["abc", "ABC", ""].join("\n"));
});

test("strIntrinsic: toUpperCase reaches the helper through a typeof-narrowed union receiver (2584 shape)", async () => {
  // rev-preread.md §5's receiver-shape axis: the union collapses to the
  // checked-dynamic representation wholesale, and a typeof guard narrows
  // it back to a static string BEFORE the backend sees the receiver — the
  // corpus 2584 shape verbatim. Verified against Node before writing in.
  const res = await buildWasm(
    "union-narrow.ts",
    [
      "type Thing = string | number | boolean;",
      "function classify(v: Thing): string {",
      '  if (typeof v === "string") return `str:${v.toUpperCase()}`;',
      '  return "other";',
      "}",
      'console.log(classify("hi"));',
      "console.log(classify(41));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["str:HI", "other", ""].join("\n"));
});

test("strIntrinsic: optional-chain nullish receiver does NOT invoke toLowerCase (1562 shape, discriminating)", async () => {
  // rev-preread.md §5/§10: the discriminating direction is x?.toLowerCase()
  // with x nullish — must not invoke the helper and must not trap. A
  // buggy short-circuit (invoking the helper on a null receiver) would
  // trap here rather than print "undefined" — verified against Node
  // before writing in (corpus 1562's own maybe()?.trim().toLowerCase()
  // shape).
  const res = await buildWasm(
    "opt-chain-nullish.ts",
    [
      "function maybe(cond: boolean): string | undefined {",
      '  return cond ? "  Hi  " : undefined;',
      "}",
      "console.log(`${maybe(true)?.trim().toLowerCase()}`);",
      "console.log(`${maybe(false)?.trim().toLowerCase()}`);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["hi", "undefined", ""].join("\n"));
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

test("classes: increment 22 stage A lifts the gate for the emitter root ONLY — a stream root still refuses", async () => {
  // The EventEmitter rock is gone: classes.ts's rootKind now answers
  // "emitter" (liftable) rather than "runtime" for a %EventEmitter-rooted
  // class, and plan() injects the two-field ScrEmitter prefix (registry
  // ref, display name) past `vt`. A stream-rooted class's base chain
  // passes through a RUNTIME_STREAM_CLASSES name first (checked before
  // the emitter check in rootKind, exactly because every stream class's
  // OWN base chain reaches %EventEmitter further up) — its C prefix embeds
  // stream state this tier has no port of, so it keeps refusing unchanged.
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
  expect(ee.ok).toBe(true);
  if (ee.ok) {
    expect(WebAssembly.validate(readFileSync(ee.binaryPath))).toBe(true);
    const { stdout } = await runWasm(ee.binaryPath);
    expect(stdout.toString("utf8")).toBe("0\n");
  }

  const stream = await buildWasm(
    "extends-stream.ts",
    [
      'import { Readable } from "node:stream";',
      "class R extends Readable {",
      "  _read(): void {}",
      "}",
      "const r = new R();",
      "console.log(r instanceof Readable);",
      "",
    ].join("\n"),
  );
  expect(stream.ok).toBe(false);
  if (!stream.ok) {
    expect(stream.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
    expect(stream.wasmSurvey).toContain("class:extends-runtime");
  }
});

test("events registry: own-key event names — '__proto__'/'toString'/'__defineGetter__'/'hasOwnProperty' behave as ORDINARY names, not inherited Object.prototype members (corpus 1761's own construct — the full corpus program cannot be claimed yet, since its second half needs real stream construction; this pins the EventEmitter-only half directly, byte-exact against Node)", async () => {
  // bucketFind's own name comparison (events.ts) is a raw UTF-16 content
  // walk through strEqHelper — the SAME equality every other string
  // comparison in this backend uses — so it never touches a JS
  // prototype chain at all and this holds by construction; pinned
  // anyway per the standing rule that "holds by construction" is an
  // argument, not a substitute for the guard.
  const res = await buildWasm(
    "own-key-names.cjs",
    [
      "'use strict';",
      "const EventEmitter = require('events');",
      "const ee = new EventEmitter();",
      "ee.on('__proto__', (v) => { console.log('proto', v); });",
      "ee.on('toString', (v) => { console.log('tostring', v); });",
      "ee.on('__defineGetter__', (v) => { console.log('getter', v); });",
      "ee.on('hasOwnProperty', (v) => { console.log('hop', v); });",
      "ee.emit('__proto__', 1);",
      "ee.emit('toString', 2);",
      "ee.emit('__defineGetter__', 3);",
      "ee.emit('hasOwnProperty', 4);",
      "console.log(ee.eventNames().join(','));",
      "console.log(ee.listenerCount('__proto__'));",
      "",
    ].join("\n"),
  );
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const { stdout } = await runWasm(res.binaryPath);
    // Node-measured (node --experimental-transform-types, CJS require —
    // the require() form 1761 itself uses).
    expect(stdout.toString("utf8")).toBe(
      ["proto 1", "tostring 2", "getter 3", "hop 4", "__proto__,toString,__defineGetter__,hasOwnProperty", "1", ""].join("\n"),
    );
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

test("S031: hybrid record own-key order is declared-then-overflow", async () => {
  // No corpus program can pin this: Node's single ordered table puts
  // integer-like keys ascending FIRST regardless of which "store" (JS has
  // none) a key came from, so a program exercising the split fails the
  // differential on every lane by construction. Measured on Node 24.18
  // against the C lane (SEMANTICS.md S031): the declared field sorts
  // BEFORE the integer-like overflow keys here, and integer-like keys
  // still sort ascending WITHIN the overflow half.
  const res = await buildWasm(
    "hybrid-key-order.ts",
    [
      "interface Basic {",
      "  known: number;",
      "  [k: string]: number;",
      "}",
      "const r: Basic = { known: 1 };",
      "r.b = 2;",
      'r["3"] = 3;',
      "r.a = 4;",
      'r["1"] = 5;',
      "console.log(Object.keys(r).join('|'));",
      "console.log(JSON.stringify(r));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["known|1|3|b|a", '{"known":1,"1":5,"3":3,"b":2,"a":4}', ""].join("\n"),
  );
});

test("S031 amendment: `__proto__` is an ordinary overflow key, not the prototype accessor", async () => {
  // Node routes a bracket write naming "__proto__" through
  // Object.prototype's accessor (a non-object value is a silent no-op, no
  // own property is created); the overflow map special-cases no key
  // string, so it stores an ordinary entry. Measured on Node 24.18 against
  // the C lane (SEMANTICS.md S031's amendment) — no corpus program can pin
  // the Node-divergent side for the usual byte-exact reason.
  const res = await buildWasm(
    "hybrid-proto-key.ts",
    [
      "interface U {",
      "  [k: string]: number;",
      "}",
      "const r: U = {};",
      "r.a = 1;",
      'r["__proto__"] = 99;',
      "r.b = 2;",
      "console.log(Object.keys(r).join('|'));",
      "console.log(JSON.stringify(r));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["a|__proto__|b", '{"a":1,"__proto__":99,"b":2}', ""].join("\n"),
  );
});

test("S032: a dynamic-keyed record read with no representable \"missing\" answer TRAPS", async () => {
  // S003's array-OOB stance applied to the record surface: a bare `V` with
  // no undefined arm can't answer `undefined` for a miss, so it traps
  // instead. No corpus program can pin the trap for the same S003 reason
  // (the harness skips the stderr compare on nonzero exit; only the exit
  // code and PRECEDING stdout need to match, and they do — Node itself
  // prints `undefined` and keeps running, so a corpus program observing
  // this exact read fails the differential by construction).
  const trapRes = await buildWasm(
    "record-miss-trap.ts",
    [
      "interface Basic {",
      "  known: number;",
      "  [k: string]: number;",
      "}",
      "console.log('pre');",
      "const r: Basic = { known: 1 };",
      "console.log(r.missing);",
      "",
    ].join("\n"),
  );
  if (!trapRes.ok) throw new Error(`refused: ${trapRes.diagnostics[0]?.message}`);
  const trapRun = await runWasmToTrap(trapRes.binaryPath);
  expect(trapRun.stdout.toString("utf8")).toBe("pre\n");

  // The SAME miss, but the index signature's value type carries its own
  // undefined arm (S032's "explicit annotation" branch of the "V |
  // undefined" rule) — the checker's result type CAN hold undefined, so
  // the read returns the interned undefined arm instead of trapping, and
  // agrees with Node.
  const okRes = await buildWasm(
    "record-miss-ok.ts",
    [
      "interface Loose {",
      "  known: number;",
      "  [k: string]: number | undefined;",
      "}",
      "const r: Loose = { known: 1 };",
      "console.log(r.missing === undefined, r.missing);",
      "",
    ].join("\n"),
  );
  if (!okRes.ok) throw new Error(`refused: ${okRes.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(okRes.binaryPath);
  expect(stdout.toString("utf8")).toBe("true undefined\n");
});

test("S033: a dynamic-keyed write naming no declared field on a signature-free record throws", async () => {
  // The "mockable module" pattern (corpus 2470): every declared field
  // shares one common type, so the frontend accepts the computed-key
  // write, but the record itself is a monomorphic struct with a FIXED
  // field set. Node adds the property; this tier throws a catchable
  // TypeError and stores nothing. No corpus program can pin the throwing
  // side (Node's silent-success text differs by construction).
  const res = await buildWasm(
    "fixed-shape-write.ts",
    [
      "interface Funcs {",
      "  tick: () => void;",
      "  tock: () => void;",
      "}",
      "function setKey(r: Funcs, k: string, v: () => void): void {",
      "  // @ts-expect-error -- generic-write pattern",
      "  r[k] = v;",
      "}",
      "const box: Funcs = { tick: () => console.log('t1'), tock: () => console.log('t2') };",
      "setKey(box, 'tick', () => console.log('mocked'));",
      "box.tick();",
      "try {",
      "  setKey(box, 'nope', () => console.log('never'));",
      "  console.log('no-throw');",
      "} catch (e) {",
      "  if (e instanceof TypeError) console.log('caught:', e.message);",
      "  else console.log('other');",
      "}",
      "console.log('done');",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["mocked", "caught: Cannot add property 'nope' to a fixed-shape object", "done", ""].join("\n"),
  );
});

test("S009 amendment: a dynamic-keyed write validates a declared field's type on a hybrid record", async () => {
  // The SAME trust-but-verify mechanism `e as C` uses (S009), reached from
  // a second site: `r[k] = v` where the runtime key `k` names a DECLARED
  // field whose static type is narrower than the index signature's value
  // type `v` arrives as. Node stores whatever `v` is; here the write
  // validates through the identical dynCheck machinery and throws,
  // leaving the field untouched. No corpus program can pin the throwing
  // side for the usual byte-exact reason.
  const res = await buildWasm(
    "hybrid-declared-write-check.ts",
    [
      "interface Mixed {",
      "  known: number;",
      "  [k: string]: unknown;",
      "}",
      "function setKey(r: Mixed, k: string, v: unknown): void {",
      "  r[k] = v;",
      "}",
      "const m: Mixed = { known: 1 };",
      "try {",
      "  setKey(m, 'known', 'not a number');",
      "  console.log('no-throw', m.known);",
      "} catch (e) {",
      "  if (e instanceof TypeError) console.log('caught:', e.message, m.known);",
      "  else console.log('other');",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("caught: expected number at $.known, got string 1\n");
});

test("bytes: construction forms, length/byteLength, and the element coercion matrix", async () => {
  // The four bytesNew source forms (empty, ToIndex length, same-elem
  // copy, number[] coerced copy) plus JS-exact element write coercion
  // across every elem kind (increment 18 stage A's core surface).
  const res = await buildWasm(
    "bytes-core.ts",
    [
      "const a = new Uint8Array(4);",
      "console.log(a.length, a.byteLength);",
      "a[0] = 256; a[1] = -1; a[2] = 3.9; a[3] = NaN;",
      "console.log(a[0], a[1], a[2], a[3]);",
      "const u = new Uint32Array(2);",
      "u[0] = 4294967296; u[1] = -1;",
      "console.log(u[0], u[1], u.byteLength);",
      "const i = new Int32Array(1);",
      "i[0] = 4294967295;",
      "console.log(i[0]);",
      "const f = new Float32Array(1);",
      "f[0] = 0.1;",
      "console.log(f[0]);",
      "console.log(new Uint8Array(3.7).length, new Uint8Array(NaN).length, new Uint8Array().length);",
      "const seeded = new Uint8Array([1, 2.7, -1, 256]);",
      "console.log(seeded[0], seeded[1], seeded[2], seeded[3]);",
      "const copy = new Uint8Array(seeded);",
      "copy[0] = 9;",
      "console.log(seeded[0], copy[0]);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "4 4",
      "0 255 3 0",
      "0 4294967295 8",
      "-1",
      "0.10000000149011612",
      "3 0 0",
      "1 2 255 0",
      "1 9",
      "",
    ].join("\n"),
  );
});

test("S003 amendment: typed-array out-of-bounds get traps", async () => {
  const res = await buildWasm(
    "bytes-oob-get.ts",
    ['console.log("pre");', 'const a = new Uint8Array(2);', "console.log(a[2]);", ""].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const run = await runWasmToTrap(res.binaryPath);
  expect(run.stdout.toString("utf8")).toBe("pre\n");
});

test("S003 amendment: typed-array out-of-bounds set traps", async () => {
  const res = await buildWasm(
    "bytes-oob-set.ts",
    ['console.log("pre");', 'const a = new Uint8Array(2);', "a[2] = 1;", 'console.log("unreached");', ""].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const run = await runWasmToTrap(res.binaryPath);
  expect(run.stdout.toString("utf8")).toBe("pre\n");
});

test("S003 amendment: a non-integer typed-array index traps", async () => {
  const res = await buildWasm(
    "bytes-frac-index.ts",
    ['console.log("pre");', 'const a = new Uint8Array(2);', "console.log(a[0.5]);", ""].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const run = await runWasmToTrap(res.binaryPath);
  expect(run.stdout.toString("utf8")).toBe("pre\n");
});

test("the OOB seam: the SAME buffer's out-of-range access is TYPED-traps (S003) through a statically bytes<u8> receiver, but undefined-read/silent-no-op-write (JS semantics) through the identical value crossed into `unknown` — a same-value-two-semantics split, pinned so nothing later 'unifies' the two contracts (the B2 Buffer/DataView ladder-difference precedent, same shape)", async () => {
  // Dyn-space side first — Node's own answers (measured, node -e): an
  // out-of-range READ through `unknown` answers `undefined`, and an
  // out-of-range WRITE through `unknown` is a silent no-op (typed arrays
  // are fixed-length; Node never grows one). Both print, then the SAME
  // underlying buffer is read out of range through its ORIGINAL typed
  // binding, which traps — S003's amendment, unchanged by this round,
  // exercised here specifically to contrast it against the dyn-space
  // answers on the identical storage rather than a fresh buffer.
  const res = await buildWasm(
    "bytes-oob-seam.js",
    [
      "'use strict';",
      "function toU(b) { return b; }",
      "const src = new Uint8Array([1, 2, 3]);",
      "const u = toU(src);",
      "console.log(String(u[10]));", // dyn OOB read: undefined
      "u[10] = 99;", // dyn OOB write: silent no-op
      "console.log(src.length, src[2]);", // unchanged: 3 3
      "console.log(src[10]);", // the SAME buffer, typed access: TRAPS
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const run = await runWasmToTrap(res.binaryPath);
  expect(run.stdout.toString("utf8")).toBe(["undefined", "3 3", ""].join("\n"));
});

test("bytes: subarray is a VIEW (aliases the owner), plain slice COPIES", async () => {
  // Measured against Node directly: subarray()/Buffer's slice() alias;
  // only the plain TypedArray slice() copies — the nodes.ts comment this
  // increment fixed had it backwards.
  const res = await buildWasm(
    "bytes-views.ts",
    [
      "const a = new Uint8Array([1, 2, 3, 4]);",
      "const sub = a.subarray(1, 3);",
      "sub[0] = 99;",
      "console.log(a[1], sub.length, sub[0] !== a[0]);",
      "const cp = a.slice(1, 3);",
      "cp[0] = 111;",
      "console.log(a[1], cp[0]);",
      "const inner = sub.subarray(1, 2);",
      "inner[0] = 5;",
      "console.log(a[2], inner.byteOffset, sub.byteOffset, a.byteOffset);",
      "console.log(a.subarray(0) !== a, a.subarray(0).length === a.length);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["99 2 true", "99 111", "5 2 1 0", "true true", ""].join("\n"));
});

test("bytes: new Uint8Array(n)'s RangeError renders the ORIGINAL argument, not its truncation", async () => {
  // Measured against Node directly (`new Uint8Array(-1.5)`): the message
  // is "...length: -1.5", NOT the C runtime's trunc-first "...length: -1"
  // — a genuine scr_bytes.c-vs-Node divergence this port does NOT
  // replicate (reported to the PM as a C-lane correction, out of scope
  // to fix there).
  const res = await buildWasm(
    "bytes-new-rangeerror.ts",
    [
      "try {",
      "  new Uint8Array(-1.5);",
      "  console.log('no-throw');",
      "} catch (e) {",
      "  if (e instanceof RangeError) console.log('caught:', (e as Error).message);",
      "  else console.log('other');",
      "}",
      "try {",
      "  new Uint8Array(Infinity);",
      "} catch (e) {",
      "  console.log('caught:', (e as Error).message);",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["caught: Invalid typed array length: -1.5", "caught: Invalid typed array length: Infinity", ""].join("\n"),
  );
});

test("bytes: with()/setFrom()'s constant RangeError messages, and identity", async () => {
  const res = await buildWasm(
    "bytes-with-setfrom.ts",
    [
      "const a = new Uint8Array([1, 2, 3]);",
      "const w = a.with(1, 9);",
      "console.log(w !== a, w.join(','), a.join(','));",
      "try {",
      "  a.with(10, 0);",
      "  console.log('no-throw');",
      "} catch (e) {",
      "  console.log('caught:', (e as Error).message);",
      "}",
      "const dst = new Uint8Array(2);",
      "try {",
      "  dst.set(new Uint8Array([1, 2, 3]));",
      "  console.log('no-throw');",
      "} catch (e) {",
      "  console.log('caught:', (e as Error).message);",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "true 1,9,3 1,2,3",
      "caught: Invalid typed array index",
      "caught: offset is out of bounds",
      "",
    ].join("\n"),
  );
});

test("bytes: fillElem is per-element, clamping, never throws, and returns the receiver", async () => {
  const res = await buildWasm(
    "bytes-fillelem.ts",
    [
      "const u = new Uint32Array(5);",
      "const r = u.fill(7);",
      "console.log(r === u, u[0], u[4]);",
      "u.fill(0x1_0000_0002, 1, 3);",
      "console.log(u[0], u[1], u[2], u[3]);",
      "u.fill(3, -2);",
      "console.log(u[2], u[3], u[4]);",
      "const i = new Int32Array(2);",
      "i.fill(-5.9);",
      "console.log(i[0], i[1]);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["true 7 7", "7 2 2 7", "2 3 3", "-5 -5", ""].join("\n"));
});

test("bytes: validate-sweep — every %w.bytes.* helper, every legal elem kind, emits a VALID module", async () => {
  // A helper no test calls is a helper no test even validates
  // (WebAssembly.validate, not just `compile()` reporting success) — the
  // gap that let equalsHelper's local-type bug (A1) through review. This
  // sweep force-emits every typedarrays.ts helper across every elem kind
  // the lowering legally routes it to: bytesNew's four source forms,
  // get/bytesSet, length/byteLength/byteOffset, slice/subarray, setFrom,
  // toArray (reached only via spread — `[...x]` — never a callable
  // member), and — u8-only, per the Buffer/TypedArray lowering gates —
  // join/with/toReversed/equals; u32/i32/f32 additionally exercise
  // fillElem (their non-u8 fill path). Grow this sweep as stages B/C add
  // helpers.
  const res = await buildWasm(
    "bytes-validate-sweep.ts",
    [
      "function sweep(): void {",
      "  const a = Buffer.from([1, 2, 3, 4]);",
      "  const aCopy = Buffer.from(a);",
      "  const aLen = Buffer.alloc(3);",
      "  const aEmpty = new Uint8Array();",
      "  console.log(a.length, a.byteLength, a.byteOffset);",
      "  console.log(a[0]);",
      "  a[0] = 9;",
      "  console.log(a.slice(1, 3).length, a.subarray(1, 3).length);",
      "  const dst = Buffer.alloc(4);",
      "  dst.set(a, 0);",
      "  console.log([...a].length, a.join(','), a.with(0, 5).length, a.toReversed().length, a.equals(aCopy));",
      "  console.log(aLen.length, aEmpty.length, dst.length);",
      "",
      "  const u = new Uint32Array([1, 2, 3]);",
      "  const uCopy = new Uint32Array(u);",
      "  const uLen = new Uint32Array(2);",
      "  const uEmpty = new Uint32Array();",
      "  console.log(u.length, u.byteLength, u.byteOffset);",
      "  console.log(u[0]);",
      "  u[0] = 9;",
      "  console.log(u.slice(1, 2).length, u.subarray(1, 2).length);",
      "  const udst = new Uint32Array(3);",
      "  udst.set(u, 0);",
      "  console.log([...u].length);",
      "  u.fill(7, 0, 1);",
      "  console.log(uLen.length, uEmpty.length, uCopy.length, udst.length);",
      "",
      "  const i = new Int32Array([1, 2, 3]);",
      "  const iCopy = new Int32Array(i);",
      "  const iLen = new Int32Array(2);",
      "  const iEmpty = new Int32Array();",
      "  console.log(i.length, i.byteLength, i.byteOffset);",
      "  console.log(i[0]);",
      "  i[0] = -9;",
      "  console.log(i.slice(1, 2).length, i.subarray(1, 2).length);",
      "  const idst = new Int32Array(3);",
      "  idst.set(i, 0);",
      "  console.log([...i].length);",
      "  i.fill(-7, 0, 1);",
      "  console.log(iLen.length, iEmpty.length, iCopy.length, idst.length);",
      "",
      "  const f = new Float32Array([1.5, 2.5, 3.5]);",
      "  const fCopy = new Float32Array(f);",
      "  const fLen = new Float32Array(2);",
      "  const fEmpty = new Float32Array();",
      "  console.log(f.length, f.byteLength, f.byteOffset);",
      "  console.log(f[0]);",
      "  f[0] = 9.5;",
      "  console.log(f.slice(1, 2).length, f.subarray(1, 2).length);",
      "  const fdst = new Float32Array(3);",
      "  fdst.set(f, 0);",
      "  console.log([...f].length);",
      "  f.fill(7.5, 0, 1);",
      "  console.log(fLen.length, fEmpty.length, fCopy.length, fdst.length);",
      "}",
      "sweep();",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      // "4 4 0": the trailing 0 is `a.byteOffset` for a Buffer.from(...)
      // value — OUR answer (we never pool), not Node's. Node pools
      // Buffer.from/allocUnsafe out of a shared per-process buffer, so
      // its byteOffset there is a NONDETERMINISTIC, climbing pool cursor
      // (measured: 0 then 16 across two calls in one process) — SEMANTICS.md
      // S035. The u32/i32/f32 sweep's own "...0" byteOffset answers below
      // (plain `new TypedArray(...)`, never pooled by Node either) are
      // genuine Node parity, not this same divergence.
      "4 4 0",
      "1",
      "2 2",
      "4 9,2,3,4 4 4 false",
      "3 0 4",
      "3 12 0",
      "1",
      "1 1",
      "3",
      "2 0 3 3",
      "3 12 0",
      "1",
      "1 1",
      "3",
      "2 0 3 3",
      "3 12 0",
      "1.5",
      "1 1",
      "3",
      "2 0 3 3",
      "",
    ].join("\n"),
  );
});

test("bytes: equals — length mismatch, content mismatch, self, empty, and a nonzero-offset VIEW", async () => {
  const res = await buildWasm(
    "bytes-equals.ts",
    [
      "const a = Buffer.from([1, 2, 3]);",
      "const b = Buffer.from([1, 2, 3]);",
      "const c = Buffer.from([1, 2, 4]);",
      "const shorter = Buffer.from([1, 2]);",
      "console.log(a.equals(b), a.equals(c), a.equals(shorter), a.equals(a));",
      "const empty1 = Buffer.alloc(0);",
      "const empty2 = Buffer.alloc(0);",
      "console.log(empty1.equals(empty2));",
      "const owner = Buffer.from([9, 1, 2, 3, 9]);",
      "const view = owner.subarray(1, 4);",
      "console.log(view.equals(a), view.equals(c));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["true false false true", "true", "true false", ""].join("\n"));
});

test("S034: typed-array construction traps when the requested BYTE size is at or past 2^31", async () => {
  // Node itself allows this (measured: `new Uint8Array(2147483648)`
  // succeeds under Node 24.18 — a real 2 GiB allocation); this tier's
  // WasmGC array length is bounded by a SIGNED i32 conversion, so the
  // guard traps deterministically before that conversion can misbehave.
  // The just-under-cap SUCCESS path is deliberately untested (S008's own
  // precedent: no corpus program can carry a ~2 GiB appetite).
  const res = await buildWasm(
    "bytes-alloc-cap.ts",
    ['console.log("pre");', "new Uint8Array(2147483648);", 'console.log("unreached");', ""].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const run = await runWasmToTrap(res.binaryPath);
  expect(run.stdout.toString("utf8")).toBe("pre\n");
});

test("bytes: every typed array is truthy, empty or not (`if (buf)` const-true)", async () => {
  const res = await buildWasm(
    "bytes-truthy.ts",
    [
      "const empty = new Uint8Array();",
      "const nonEmpty = new Uint8Array([1]);",
      "console.log(empty ? 'truthy' : 'falsy', nonEmpty ? 'truthy' : 'falsy');",
      "console.log(!!empty, !!nonEmpty);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["truthy truthy", "true true", ""].join("\n"));
});

test("bytes: encodings — toString/Buffer.from round-trip every direction, both ways", async () => {
  // Every one of the 7 encodings, both directions, including bytes that
  // are NOT valid UTF-8 (0xff, control chars) through toString("utf8")'s
  // replacement path, and an astral character round-tripping through
  // utf8 encode+decode. Expected bytes captured directly from Node
  // 24.18 (process.stdout.write, not console.log, to keep this a pure
  // byte comparison — no formatting).
  const res = await buildWasm(
    "bytes-encodings.ts",
    [
      "const a = Buffer.from([1, 2, 3, 4, 255, 0]);",
      "console.log(a.toString('hex'));",
      "console.log(a.toString('base64'));",
      "console.log(a.toString('base64url'));",
      "console.log(a.toString('latin1'));",
      "console.log(a.toString('ascii'));",
      "console.log(a.toString('utf16le'));",
      "console.log(a.toString('utf8'));",
      "console.log(a.toString());",
      "",
      "const s = Buffer.from('hello world', 'utf8');",
      "console.log(s.toString('utf8'));",
      "const h = Buffer.from('aabbcc', 'hex');",
      "console.log(h.toString('hex'));",
      "const b64 = Buffer.from('AQIDBAU=', 'base64');",
      "console.log(b64.toString('hex'));",
      "const b64u = Buffer.from('AQIDBAU', 'base64url');",
      "console.log(b64u.toString('hex'));",
      "const l1 = Buffer.from('hello', 'latin1');",
      "console.log(l1.toString('hex'));",
      "const asc = Buffer.from('hello', 'ascii');",
      "console.log(asc.toString('hex'));",
      "const u16 = Buffer.from('hi', 'utf16le');",
      "console.log(u16.toString('hex'));",
      "",
      "const astral = Buffer.from('a\\u{1F600}b', 'utf8');",
      "console.log(astral.toString('utf8'));",
      "console.log(astral.toString('hex'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("hex")).toBe(
    "3031303230333034666630300a41514944425038410a41514944425038410a01020304c3bf000a010203047f000ac881d083c3bf0a01020304efbfbd000a01020304efbfbd000a68656c6c6f20776f726c640a6161626263630a303130323033303430350a303130323033303430350a363836353663366336660a363836353663366336660a36383030363930300a61f09f9880620a3631663039663938383036320a",
  );
});

test("bytes: hex/base64/base64url — a length/pattern sweep round-trip plus Node-lenient decode edge cases", async () => {
  // The design doc's mandatory hex/base64 fuzz round-trip, as a fixed
  // vector set rather than a randomized run (deterministic, reviewable):
  // varying lengths (0, 1, 2, 3-byte non-multiple-of-3, 8, 5, 10, 15),
  // all-0x00 and all-0xff patterns (the base64 alphabet's own edges),
  // PLUS the Node-lenient decode edges scr_bytes_from_str documents:
  // an invalid pair/odd tail stopping hex decode early, uppercase hex,
  // whitespace and punctuation skipped mid-base64, and a standard-
  // alphabet string decoded WITHOUT its padding (Node accepts both).
  const res = await buildWasm(
    "bytes-hex-b64-fuzz.ts",
    [
      "const patterns: number[][] = [",
      "  [],",
      "  [0],",
      "  [255],",
      "  [0, 255],",
      "  [1, 2, 3],",
      "  [1, 2, 3, 4],",
      "  [1, 2, 3, 4, 5],",
      "  [0, 0, 0, 0, 0, 0, 0, 0],",
      "  [255, 255, 255, 255, 255],",
      "  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],",
      "  [16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240],",
      "];",
      "for (const p of patterns) {",
      "  const b = Buffer.from(p);",
      "  console.log(b.toString('hex'));",
      "  console.log(b.toString('base64'));",
      "  console.log(b.toString('base64url'));",
      "}",
      "console.log(Buffer.from('a1g2', 'hex').toString('hex'));",
      "console.log(Buffer.from('a1b', 'hex').toString('hex'));",
      "console.log(Buffer.from('A1B2C3', 'hex').toString('hex'));",
      "console.log(Buffer.from('AQ ID BA U=', 'base64').toString('hex'));",
      "console.log(Buffer.from('AQIDBAU', 'base64').toString('hex'));",
      "console.log(Buffer.from('A!Q@I#D$B%A^U&=*', 'base64').toString('hex'));",
      "console.log(Buffer.from('', 'hex').toString('hex'));",
      "console.log(Buffer.from('', 'base64').toString('hex'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("hex")).toBe(
    "0a0a0a30300a41413d3d0a41410a66660a2f773d3d0a5f770a303066660a4150383d0a4150380a3031303230330a415149440a415149440a30313032303330340a4151494442413d3d0a4151494442410a303130323033303430350a415149444241553d0a415149444241550a303030303030303030303030303030300a41414141414141414141413d0a41414141414141414141410a666666666666666666660a2f2f2f2f2f2f383d0a5f5f5f5f5f5f380a30313032303330343035303630373038303930610a41514944424155474277674a43673d3d0a41514944424155474277674a43670a3130323033303430353036303730383039306130623063306430653066300a4543417751464267634943516f4c4441304f44770a4543417751464267634943516f4c4441304f44770a61310a61310a6131623263330a303130323033303430350a303130323033303430350a303130323033303430350a0a0a",
  );
});

test("bytes: readNum/writeNum — every fixed integer width/endianness, plus Node-exact bounds and value-range errors", async () => {
  // The design doc's mandatory Node-exact ERR_OUT_OF_RANGE messages,
  // including the addNumericalSeparator underscore-grouping case
  // (offset/value magnitudes past 2^32) — this is what actually
  // exercises the shared numReceived/boundsError machinery.
  const res = await buildWasm(
    "bytes-readnum-writenum.ts",
    [
      "const caught = (fn: () => number): void => {",
      "  try { console.log(fn()); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "const b = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);",
      "console.log(b.readUInt8(0));",
      "console.log(b.readInt8(4));",
      "console.log(b.readUInt16BE(0));",
      "console.log(b.readUInt16LE(0));",
      "console.log(b.readInt16BE(4));",
      "console.log(b.readInt16LE(4));",
      "console.log(b.readUInt32BE(0));",
      "console.log(b.readUInt32LE(0));",
      "console.log(b.readInt32BE(0));",
      "console.log(b.readInt32LE(0));",
      "",
      "const w = Buffer.alloc(8);",
      "console.log(w.writeUInt8(255, 0));",
      "console.log(w.writeInt8(-1, 1));",
      "console.log(w.writeUInt16BE(0x1234, 2));",
      "console.log(w.writeUInt32LE(0xdeadbeef, 4));",
      "console.log(w.toString('hex'));",
      "",
      "caught(() => b.readUInt8(6));",
      "caught(() => b.readUInt8(-1));",
      "caught(() => b.readUInt8(1.5));",
      "caught(() => b.readUInt32LE(3));",
      "caught(() => w.writeUInt8(256, 0));",
      "caught(() => w.writeUInt8(-1, 0));",
      "caught(() => w.writeInt8(128, 0));",
      "caught(() => w.writeInt8(-129, 0));",
      "caught(() => w.writeUInt32BE(4294967296, 0));",
      "caught(() => w.writeUInt8(1, 8));",
      "caught(() => w.writeUInt8(1, -1));",
      "caught(() => w.writeUInt8(1, 5e9));",
      "caught(() => w.writeInt32LE(-5e9, 0));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "1",
      "-1",
      "258",
      "513",
      "-2",
      "-257",
      "16909060",
      "67305985",
      "16909060",
      "67305985",
      "1",
      "2",
      "4",
      "8",
      "ffff1234efbeadde",
      'caught:RangeError:The value of "offset" is out of range. It must be >= 0 and <= 5. Received 6',
      'caught:RangeError:The value of "offset" is out of range. It must be >= 0 and <= 5. Received -1',
      'caught:RangeError:The value of "offset" is out of range. It must be an integer. Received 1.5',
      'caught:RangeError:The value of "offset" is out of range. It must be >= 0 and <= 2. Received 3',
      'caught:RangeError:The value of "value" is out of range. It must be >= 0 and <= 255. Received 256',
      'caught:RangeError:The value of "value" is out of range. It must be >= 0 and <= 255. Received -1',
      'caught:RangeError:The value of "value" is out of range. It must be >= -128 and <= 127. Received 128',
      'caught:RangeError:The value of "value" is out of range. It must be >= -128 and <= 127. Received -129',
      'caught:RangeError:The value of "value" is out of range. It must be >= 0 and <= 4294967295. Received 4294967296',
      'caught:RangeError:The value of "offset" is out of range. It must be >= 0 and <= 7. Received 8',
      'caught:RangeError:The value of "offset" is out of range. It must be >= 0 and <= 7. Received -1',
      'caught:RangeError:The value of "offset" is out of range. It must be >= 0 and <= 7. Received 5_000_000_000',
      'caught:RangeError:The value of "value" is out of range. It must be >= -2147483648 and <= 2147483647. Received -5_000_000_000',
      "",
    ].join("\n"),
  );
});

test("bytes: utf8 decode — exhaustive 1-byte and 2-byte sequences", async () => {
  const res = await buildWasm(
    "bytes-utf8-sweep-1-2byte.ts",
    [
      "for (let a = 0; a < 256; a++) {",
      "  const buf1 = Buffer.from([a]);",
      "  const s1 = buf1.toString('utf8');",
      "  let line1 = 'A' + a + ':' + s1.length;",
      "  for (let i = 0; i < s1.length; i++) line1 += ':' + s1.charCodeAt(i);",
      "  console.log(line1);",
      "  for (let b = 0; b < 256; b++) {",
      "    const buf2 = Buffer.from([a, b]);",
      "    const s2 = buf2.toString('utf8');",
      "    let line2 = 'B' + a + ':' + b + ':' + s2.length;",
      "    for (let i = 0; i < s2.length; i++) line2 += ':' + s2.charCodeAt(i);",
      "    console.log(line2);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const expected: string[] = [];
  for (let a = 0; a < 256; a++) {
    const s1 = Buffer.from([a]).toString("utf8");
    let line1 = `A${a}:${s1.length}`;
    for (let i = 0; i < s1.length; i++) line1 += `:${s1.charCodeAt(i)}`;
    expected.push(line1);
    for (let b = 0; b < 256; b++) {
      const s2 = Buffer.from([a, b]).toString("utf8");
      let line2 = `B${a}:${b}:${s2.length}`;
      for (let i = 0; i < s2.length; i++) line2 += `:${s2.charCodeAt(i)}`;
      expected.push(line2);
    }
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
}, 300_000);

test("bytes: utf8 decode — exhaustive 3-byte sequences over the interesting leads (0xE0-0xEF x 65536 continuations)", async () => {
  const res = await buildWasm(
    "bytes-utf8-sweep-3byte.ts",
    [
      "for (let lead = 0xe0; lead <= 0xef; lead++) {",
      "  for (let c1 = 0; c1 < 256; c1++) {",
      "    for (let c2 = 0; c2 < 256; c2++) {",
      "      const buf = Buffer.from([lead, c1, c2]);",
      "      const s = buf.toString('utf8');",
      "      let line = lead + ':' + c1 + ':' + c2 + ':' + s.length;",
      "      for (let i = 0; i < s.length; i++) line += ':' + s.charCodeAt(i);",
      "      console.log(line);",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const expected: string[] = [];
  for (let lead = 0xe0; lead <= 0xef; lead++) {
    for (let c1 = 0; c1 < 256; c1++) {
      for (let c2 = 0; c2 < 256; c2++) {
        const s = Buffer.from([lead, c1, c2]).toString("utf8");
        let line = `${lead}:${c1}:${c2}:${s.length}`;
        for (let i = 0; i < s.length; i++) line += `:${s.charCodeAt(i)}`;
        expected.push(line);
      }
    }
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
}, 300_000);

test("bytes: utf8 decode — 4-byte leads truncated after 3 bytes (0xF0-0xF4 x 65536 continuations)", async () => {
  const res = await buildWasm(
    "bytes-utf8-sweep-4byte-trunc3.ts",
    [
      "for (let lead = 0xf0; lead <= 0xf4; lead++) {",
      "  for (let c1 = 0; c1 < 256; c1++) {",
      "    for (let c2 = 0; c2 < 256; c2++) {",
      "      const buf = Buffer.from([lead, c1, c2]);",
      "      const s = buf.toString('utf8');",
      "      let line = lead + ':' + c1 + ':' + c2 + ':' + s.length;",
      "      for (let i = 0; i < s.length; i++) line += ':' + s.charCodeAt(i);",
      "      console.log(line);",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const expected: string[] = [];
  for (let lead = 0xf0; lead <= 0xf4; lead++) {
    for (let c1 = 0; c1 < 256; c1++) {
      for (let c2 = 0; c2 < 256; c2++) {
        const s = Buffer.from([lead, c1, c2]).toString("utf8");
        let line = `${lead}:${c1}:${c2}:${s.length}`;
        for (let i = 0; i < s.length; i++) line += `:${s.charCodeAt(i)}`;
        expected.push(line);
      }
    }
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
}, 300_000);

test("bytes: utf8 decode — 4-byte structured sweep (0xF0-0xF4 leads x every c1 x boundary c2/c3 combinations)", async () => {
  const res = await buildWasm(
    "bytes-utf8-sweep-4byte-structured.ts",
    [
      "const bounds = [0x00, 0x7f, 0x80, 0xbf, 0xc0, 0xff];",
      "for (let lead = 0xf0; lead <= 0xf4; lead++) {",
      "  for (let c1 = 0; c1 < 256; c1++) {",
      "    for (let bi = 0; bi < 6; bi++) {",
      "      for (let bj = 0; bj < 6; bj++) {",
      "        const c2 = bounds[bi];",
      "        const c3 = bounds[bj];",
      "        const buf = Buffer.from([lead, c1, c2, c3]);",
      "        const s = buf.toString('utf8');",
      "        let line = lead + ':' + c1 + ':' + c2 + ':' + c3 + ':' + s.length;",
      "        for (let i = 0; i < s.length; i++) line += ':' + s.charCodeAt(i);",
      "        console.log(line);",
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const bounds = [0x00, 0x7f, 0x80, 0xbf, 0xc0, 0xff];
  const expected: string[] = [];
  for (let lead = 0xf0; lead <= 0xf4; lead++) {
    for (let c1 = 0; c1 < 256; c1++) {
      for (const c2 of bounds) {
        for (const c3 of bounds) {
          const s = Buffer.from([lead, c1, c2, c3]).toString("utf8");
          let line = `${lead}:${c1}:${c2}:${c3}:${s.length}`;
          for (let i = 0; i < s.length; i++) line += `:${s.charCodeAt(i)}`;
          expected.push(line);
        }
      }
    }
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
}, 300_000);

test("bytes: utf16le — lone surrogate input round-trips through MY implementation, both directions", async () => {
  const res = await buildWasm(
    "bytes-utf16le-lone-surrogate.ts",
    [
      "const decHi = Buffer.from([0x00, 0xd8]).toString('utf16le');",
      "console.log(decHi.length + ':' + decHi.charCodeAt(0));",
      "const decLo = Buffer.from([0x00, 0xdc]).toString('utf16le');",
      "console.log(decLo.length + ':' + decLo.charCodeAt(0));",
      "const encHi = Buffer.from('\\ud800', 'utf16le');",
      "console.log(encHi.toString('hex'));",
      "const encLo = Buffer.from('\\udc00', 'utf16le');",
      "console.log(encLo.toString('hex'));",
      "console.log(Buffer.from('\\ud800', 'utf8').toString('hex'));",
      "console.log(Buffer.from('\\udc00', 'utf8').toString('hex'));",
      "const odd = Buffer.from([0x41, 0x00, 0xff]).toString('utf16le');",
      "console.log(odd.length + ':' + odd.charCodeAt(0));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const decHi = Buffer.from([0x00, 0xd8]).toString("utf16le");
  const decLo = Buffer.from([0x00, 0xdc]).toString("utf16le");
  const encHi = Buffer.from("\ud800", "utf16le");
  const encLo = Buffer.from("\udc00", "utf16le");
  const odd = Buffer.from([0x41, 0x00, 0xff]).toString("utf16le");
  const expected = [
    `${decHi.length}:${decHi.charCodeAt(0)}`,
    `${decLo.length}:${decLo.charCodeAt(0)}`,
    encHi.toString("hex"),
    encLo.toString("hex"),
    Buffer.from("\ud800", "utf8").toString("hex"),
    Buffer.from("\udc00", "utf8").toString("hex"),
    `${odd.length}:${odd.charCodeAt(0)}`,
    "",
  ].join("\n");
  expect(stdout.toString("utf8")).toBe(expected);
});

test("bytes: utf8 encode — every code point 0..0x10FFFF through fromStr('utf8') -> hex, diffed vs Node", async () => {
  const res = await buildWasm(
    "bytes-utf8-encode-sweep.ts",
    [
      "for (let cp = 0; cp < 0x110000; cp++) {",
      "  if (cp < 0x10000) {",
      "    const b0 = cp & 0xff;",
      "    const b1 = (cp >> 8) & 0xff;",
      "    const s = Buffer.from([b0, b1]).toString('utf16le');",
      "    const enc = Buffer.from(s, 'utf8');",
      "    console.log(cp + ':' + enc.toString('hex'));",
      "  } else {",
      "    const cpp = cp - 0x10000;",
      "    const hi = 0xd800 + (cpp >> 10);",
      "    const lo = 0xdc00 + (cpp & 0x3ff);",
      "    const b0 = hi & 0xff;",
      "    const b1 = (hi >> 8) & 0xff;",
      "    const b2 = lo & 0xff;",
      "    const b3 = (lo >> 8) & 0xff;",
      "    const s = Buffer.from([b0, b1, b2, b3]).toString('utf16le');",
      "    const enc = Buffer.from(s, 'utf8');",
      "    console.log(cp + ':' + enc.toString('hex'));",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const expected: string[] = [];
  for (let cp = 0; cp < 0x110000; cp++) {
    let s: string;
    if (cp < 0x10000) {
      s = String.fromCharCode(cp);
    } else {
      const cpp = cp - 0x10000;
      const hi = 0xd800 + (cpp >> 10);
      const lo = 0xdc00 + (cpp & 0x3ff);
      s = String.fromCharCode(hi) + String.fromCharCode(lo);
    }
    expected.push(`${cp}:${Buffer.from(s, "utf8").toString("hex")}`);
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
}, 300_000);

test("bytes: hex — exhaustive encode (256 byte values)", async () => {
  const res = await buildWasm(
    "bytes-hex-encode-sweep.ts",
    [
      "for (let b = 0; b < 256; b++) {",
      "  console.log(b + ':' + Buffer.from([b]).toString('hex'));",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const expected: string[] = [];
  for (let b = 0; b < 256; b++) expected.push(`${b}:${Buffer.from([b]).toString("hex")}`);
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: hex — exhaustive decode over length-1 (odd-length truncation, 256 char values) and length-2 (65536 pairs)", async () => {
  const res = await buildWasm(
    "bytes-hex-decode-sweep.ts",
    [
      "for (let v = 0; v < 256; v++) {",
      "  const s1 = Buffer.from([v, 0]).toString('utf16le');",
      "  const d1 = Buffer.from(s1, 'hex');",
      "  console.log('L1:' + v + ':' + d1.toString('hex'));",
      "}",
      "for (let v1 = 0; v1 < 256; v1++) {",
      "  for (let v2 = 0; v2 < 256; v2++) {",
      "    const s2 = Buffer.from([v1, 0, v2, 0]).toString('utf16le');",
      "    const d2 = Buffer.from(s2, 'hex');",
      "    console.log('L2:' + v1 + ':' + v2 + ':' + d2.toString('hex'));",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const expected: string[] = [];
  for (let v = 0; v < 256; v++) {
    const s1 = String.fromCharCode(v);
    expected.push(`L1:${v}:${Buffer.from(s1, "hex").toString("hex")}`);
  }
  for (let v1 = 0; v1 < 256; v1++) {
    for (let v2 = 0; v2 < 256; v2++) {
      const s2 = String.fromCharCode(v1) + String.fromCharCode(v2);
      expected.push(`L2:${v1}:${v2}:${Buffer.from(s2, "hex").toString("hex")}`);
    }
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
}, 300_000);

test("bytes: base64/base64url — seeded xorshift32 fuzz over lengths 0-64, both directions (seed printed for reproducibility)", async () => {
  const SEED = 0x2f6e2b1;
  const res = await buildWasm(
    "bytes-base64-fuzz.ts",
    [
      `let x = ${SEED};`,
      "function nextByte(): number {",
      "  x = x ^ (x << 13);",
      "  x = x ^ (x >>> 17);",
      "  x = x ^ (x << 5);",
      "  return (x >>> 0) & 0xff;",
      "}",
      "for (let len = 0; len <= 64; len++) {",
      "  const bytes: number[] = [];",
      "  for (let i = 0; i < len; i++) bytes.push(nextByte());",
      "  const buf = Buffer.from(bytes);",
      "  const b64 = buf.toString('base64');",
      "  const b64u = buf.toString('base64url');",
      "  const back64 = Buffer.from(b64, 'base64');",
      "  const back64u = Buffer.from(b64u, 'base64url');",
      "  console.log(len + ':' + b64 + ':' + b64u + ':' + back64.toString('hex') + ':' + back64u.toString('hex'));",
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);

  // Same xorshift32 algorithm, run identically in plain JS (bitwise ops are
  // exact 32-bit int semantics in JS too, so this matches the wasm i32 ops
  // bit for bit — no Math.imul or float-precision concerns since xorshift32
  // only uses ^, <<, >>>).
  let xState = SEED;
  function nextByte(): number {
    xState = xState ^ (xState << 13);
    xState = xState ^ (xState >>> 17);
    xState = xState ^ (xState << 5);
    return (xState >>> 0) & 0xff;
  }
  const expected: string[] = [];
  for (let len = 0; len <= 64; len++) {
    const bytes: number[] = [];
    for (let i = 0; i < len; i++) bytes.push(nextByte());
    const buf = Buffer.from(bytes);
    const b64 = buf.toString("base64");
    const b64u = buf.toString("base64url");
    const back64 = Buffer.from(b64, "base64");
    const back64u = Buffer.from(b64u, "base64url");
    expected.push(
      `${len}:${b64}:${b64u}:${back64.toString("hex")}:${back64u.toString("hex")}`,
    );
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: writeNum — fractional/NaN/Infinity value-range validation, measured against Node (raw value compared BEFORE truncation)", async () => {
  // Node's checkInt/checkUInt family compares the RAW (possibly fractional)
  // value against [min, max] BEFORE any truncation happens — NOT an
  // integer-ness check. Measured directly (Node 24.18):
  //   writeUInt8(-0.5)  throws (raw -0.5 < min 0, even though truncating
  //                             toward zero would land in range at 0)
  //   writeUInt8(1.9)   succeeds, writes 1 (raw in range, THEN truncates)
  //   writeInt8(-1.9)   succeeds, writes 0xff (raw in [-128,127])
  //   writeUInt8(NaN)   succeeds, writes 0 (every NaN comparison is false,
  //                             so NaN passes the range gate, then the
  //                             value->bits step maps NaN to 0)
  //   writeUInt8(Infinity/-Infinity) always throws (a real out-of-range
  //                             magnitude, not caught by the NaN carve-out)
  // This test measures ALL 10 kinds against these exact axes and diffs the
  // wasm-compiled implementation against Node computed the same way in
  // this same process — not against a hand-transcribed expectation.
  const kinds: { kind: string; method: string; width: number; signed: boolean; min: number; max: number }[] = [
    { kind: "u8", method: "writeUInt8", width: 1, signed: false, min: 0, max: 255 },
    { kind: "i8", method: "writeInt8", width: 1, signed: true, min: -128, max: 127 },
    { kind: "u16be", method: "writeUInt16BE", width: 2, signed: false, min: 0, max: 65535 },
    { kind: "u16le", method: "writeUInt16LE", width: 2, signed: false, min: 0, max: 65535 },
    { kind: "i16be", method: "writeInt16BE", width: 2, signed: true, min: -32768, max: 32767 },
    { kind: "i16le", method: "writeInt16LE", width: 2, signed: true, min: -32768, max: 32767 },
    { kind: "u32be", method: "writeUInt32BE", width: 4, signed: false, min: 0, max: 4294967295 },
    { kind: "u32le", method: "writeUInt32LE", width: 4, signed: false, min: 0, max: 4294967295 },
    { kind: "i32be", method: "writeInt32BE", width: 4, signed: true, min: -2147483648, max: 2147483647 },
    { kind: "i32le", method: "writeInt32LE", width: 4, signed: true, min: -2147483648, max: 2147483647 },
  ];

  const numLit = (v: number): string => {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return String(v);
  };

  const srcLines: string[] = [
    "const caught = (fn: () => number): void => {",
    "  try { console.log(fn()); }",
    "  catch (e) {",
    "    const err = e as Error;",
    "    console.log('caught:' + err.name + ':' + err.message);",
    "  }",
    "};",
  ];
  for (const { kind, method, width, signed, min, max } of kinds) {
    const fracIn = signed ? -1.9 : 1.9;
    const fracBelow = min - 0.5;
    const fracAbove = max + 0.5;
    const intAbove = max + 1;
    const intBelow = min - 1;
    srcLines.push(`// ${kind} (${method})`);
    srcLines.push(
      `{ const b = Buffer.alloc(${width}); b.${method}(${numLit(fracIn)}, 0); console.log(b.toString('hex')); }`,
    );
    srcLines.push(
      `{ const b = Buffer.alloc(${width}); b.${method}(NaN, 0); console.log(b.toString('hex')); }`,
    );
    srcLines.push(`caught(() => Buffer.alloc(${width}).${method}(${numLit(fracBelow)}, 0));`);
    srcLines.push(`caught(() => Buffer.alloc(${width}).${method}(${numLit(fracAbove)}, 0));`);
    srcLines.push(`caught(() => Buffer.alloc(${width}).${method}(Infinity, 0));`);
    srcLines.push(`caught(() => Buffer.alloc(${width}).${method}(-Infinity, 0));`);
    srcLines.push(`caught(() => Buffer.alloc(${width}).${method}(${numLit(intAbove)}, 0));`);
    srcLines.push(`caught(() => Buffer.alloc(${width}).${method}(${numLit(intBelow)}, 0));`);
  }
  srcLines.push("");

  const res = await buildWasm("bytes-writenum-fractional-sweep.ts", srcLines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);

  // Expected: the exact same calls, against real Node Buffer, in this
  // same process — never a hand-transcribed literal.
  const expected: string[] = [];
  const call = (method: string, width: number, value: number): void => {
    const buf = Buffer.alloc(width);
    try {
      (buf as unknown as Record<string, (v: number, o: number) => number>)[method]!(value, 0);
      expected.push(buf.toString("hex"));
    } catch (e) {
      const err = e as Error;
      expected.push(`caught:${err.name}:${err.message}`);
    }
  };
  for (const { method, width, signed, min, max } of kinds) {
    const fracIn = signed ? -1.9 : 1.9;
    call(method, width, fracIn);
    call(method, width, NaN);
    call(method, width, min - 0.5);
    call(method, width, max + 0.5);
    call(method, width, Infinity);
    call(method, width, -Infinity);
    call(method, width, max + 1);
    call(method, width, min - 1);
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: swap16/32/64 — in-place reversal, chains, and Node's constant size-mismatch error", async () => {
  const res = await buildWasm(
    "bytes-swap.ts",
    [
      "const caught = (fn: () => Buffer): void => {",
      "  try { console.log(fn().toString('hex')); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "console.log(Buffer.from([1, 2, 3, 4]).swap16().toString('hex'));",
      "console.log(Buffer.from([1, 2, 3, 4]).swap32().toString('hex'));",
      "console.log(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64().toString('hex'));",
      "console.log(Buffer.alloc(0).swap16().toString('hex'));",
      "const b = Buffer.from([1, 2, 3, 4]);",
      "const r = b.swap16();",
      "console.log(r === b);",
      "caught(() => Buffer.from([1, 2, 3]).swap16());",
      "caught(() => Buffer.from([1, 2, 3, 4, 5]).swap32());",
      "caught(() => Buffer.from([1, 2, 3]).swap64());",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "02010403",
      "04030201",
      "0807060504030201",
      "",
      "true",
      'caught:RangeError:Buffer size must be a multiple of 16-bits',
      'caught:RangeError:Buffer size must be a multiple of 32-bits',
      'caught:RangeError:Buffer size must be a multiple of 64-bits',
      "",
    ].join("\n"),
  );
});

test("bytes: indexOf/lastIndexOf/includes(+Num) — search family, Node-measured across offsets, empty needle, and alignment", async () => {
  const res = await buildWasm(
    "bytes-indexof.ts",
    [
      "const b = Buffer.from('hello world hello');",
      "console.log(b.indexOf('hello'));",
      "console.log(b.lastIndexOf('hello'));",
      "console.log(b.indexOf('hello', 1));",
      "console.log(b.lastIndexOf('hello', 10));",
      "console.log(b.indexOf('xyz'));",
      "console.log(b.includes('world'));",
      "console.log(b.includes('xyz'));",
      "console.log(b.indexOf(''));",
      "console.log(b.indexOf('', 100));",
      "console.log(b.indexOf('hello', -100));",
      "console.log(b.indexOf('hello', -5));",
      "console.log(b.lastIndexOf('hello', -100));",
      "console.log(b.indexOf('l', NaN));",
      "console.log(b.indexOf(104));",
      "console.log(b.lastIndexOf(104));",
      "console.log(b.includes(122));",
      "console.log(b.indexOf(104, 1));",
      "const u = Buffer.from('aXaY', 'utf16le');",
      "console.log(u.toString('hex'));",
      "console.log(u.indexOf('a', 0, 'utf16le'));",
      "console.log(u.indexOf('a', 1, 'utf16le'));",
      "console.log(u.lastIndexOf('a', 'utf16le'));",
      "console.log(u.lastIndexOf('a', 7, 'utf16le'));",
      "console.log(u.includes('a', 0, 'utf16le'));",
      "console.log(u.includes('Z', 0, 'utf16le'));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const b = Buffer.from("hello world hello");
  const u = Buffer.from("aXaY", "utf16le");
  const expected = [
    b.indexOf("hello"),
    b.lastIndexOf("hello"),
    b.indexOf("hello", 1),
    b.lastIndexOf("hello", 10),
    b.indexOf("xyz"),
    b.includes("world"),
    b.includes("xyz"),
    b.indexOf(""),
    b.indexOf("", 100),
    b.indexOf("hello", -100),
    b.indexOf("hello", -5),
    b.lastIndexOf("hello", -100),
    b.indexOf("l", NaN),
    b.indexOf(104),
    b.lastIndexOf(104),
    b.includes(122),
    b.indexOf(104, 1),
    u.toString("hex"),
    u.indexOf("a", 0, "utf16le"),
    u.indexOf("a", 1, "utf16le"),
    u.lastIndexOf("a", "utf16le"),
    u.lastIndexOf("a", 7, "utf16le"),
    u.includes("a", 0, "utf16le"),
    u.includes("Z", 0, "utf16le"),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("bytes: indexOf/lastIndexOf utf16le alignment — every starting offset rounds DOWN to even, both directions (a scr_bytes.c divergence: the C reference rounds forward UP)", async () => {
  const srcLines: string[] = ["const u = Buffer.from('aXaY', 'utf16le');"];
  for (let off = 0; off <= 9; off++) {
    srcLines.push(`console.log(u.indexOf('a', ${off}, 'utf16le'));`);
    srcLines.push(`console.log(u.lastIndexOf('a', ${off}, 'utf16le'));`);
  }
  srcLines.push("");
  const res = await buildWasm("bytes-indexof-align-sweep.ts", srcLines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const u = Buffer.from("aXaY", "utf16le");
  const expected: (string | number)[] = [];
  for (let off = 0; off <= 9; off++) {
    expected.push(u.indexOf("a", off, "utf16le"));
    expected.push(u.lastIndexOf("a", off, "utf16le"));
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: validateOff vs boundsErrorHelper — the SAME input produces two different Node error shapes, pinned explicitly", async () => {
  // fill/compareBuf/copy/writeStr's validateOffset ladder ("&&", Infinity
  // classified as "not an integer") is a DIFFERENT error family from
  // readNum/writeNum's boundsErrorHelper ladder ("and", Infinity falls
  // through to the range check) — measured directly, not unified. This
  // test feeds the SAME value (Infinity) through one call from each
  // family and asserts the two DIFFERENT resulting messages, so a future
  // refactor can't accidentally merge the two helpers.
  const res = await buildWasm(
    "bytes-validateoff-vs-boundserror.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "const w = Buffer.alloc(8);",
      "caught(() => { w.writeUInt8(1, Infinity); });", // boundsErrorHelper family
      "caught(() => { w.fill(1, Infinity); });", // validateOff family
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const w1 = Buffer.alloc(8);
  const boundsErrorMsg = (() => {
    try {
      w1.writeUInt8(1, Infinity);
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  })();
  const w2 = Buffer.alloc(8);
  const validateOffMsg = (() => {
    try {
      w2.fill(1, Infinity);
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  })();
  // Confirm, in THIS process, that the two messages really do differ —
  // otherwise this test would silently stop testing anything meaningful.
  expect(boundsErrorMsg).not.toBe(validateOffMsg);
  expect(boundsErrorMsg).toContain("It must be >= 0 and <= ");
  expect(validateOffMsg).toContain("It must be an integer.");
  expect(stdout.toString("utf8")).toBe([boundsErrorMsg, validateOffMsg, ""].join("\n"));
});

test("bytes: fill/fillNum/fillStr — pattern application, cycling, edge offsets, and Node-exact validateOff errors", async () => {
  const res = await buildWasm(
    "bytes-fill.ts",
    [
      "const caught = (fn: () => Buffer): void => {",
      "  try { console.log(fn().toString('hex')); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "console.log(Buffer.alloc(5).fill(9).toString('hex'));",
      "console.log(Buffer.from([1,2,3,4,5]).fill(9, 2, 2).toString('hex'));",
      "console.log(Buffer.from([1,2,3,4,5]).fill(9, 3, 1).toString('hex'));",
      "console.log(Buffer.from([1,2,3,4,5]).fill(9, 100).toString('hex'));",
      "console.log(Buffer.alloc(0).fill(9).toString('hex'));",
      "console.log(Buffer.alloc(7).fill(Buffer.from([1,2,3])).toString('hex'));",
      "console.log(Buffer.alloc(2).fill(256 + 65).toString('hex'));",
      "console.log(Buffer.alloc(2).fill(-1).toString('hex'));",
      "console.log(Buffer.alloc(4).fill('').toString('hex'));",
      "console.log(Buffer.alloc(8).fill('ab', 1, 5, 'utf8').toString('hex'));",
      "const b = Buffer.alloc(4);",
      "console.log(b.fill(1) === b);",
      "caught(() => Buffer.from([1,2,3,4,5]).fill(9, -2));",
      "caught(() => Buffer.from([1,2,3,4,5]).fill(9, 0, 100));",
      "caught(() => Buffer.alloc(4).fill(Buffer.alloc(0)));",
      "caught(() => Buffer.alloc(4).fill('a', 1.5));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const caughtJs = (fn: () => Buffer): string => {
    try {
      return fn().toString("hex");
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const expected = [
    Buffer.alloc(5).fill(9).toString("hex"),
    Buffer.from([1, 2, 3, 4, 5]).fill(9, 2, 2).toString("hex"),
    Buffer.from([1, 2, 3, 4, 5]).fill(9, 3, 1).toString("hex"),
    Buffer.from([1, 2, 3, 4, 5]).fill(9, 100).toString("hex"),
    Buffer.alloc(0).fill(9).toString("hex"),
    Buffer.alloc(7).fill(Buffer.from([1, 2, 3])).toString("hex"),
    Buffer.alloc(2).fill(256 + 65).toString("hex"),
    Buffer.alloc(2).fill(-1).toString("hex"),
    Buffer.alloc(4).fill("").toString("hex"),
    Buffer.alloc(8).fill("ab", 1, 5, "utf8").toString("hex"),
    "true",
    caughtJs(() => Buffer.from([1, 2, 3, 4, 5]).fill(9, -2)),
    caughtJs(() => Buffer.from([1, 2, 3, 4, 5]).fill(9, 0, 100)),
    caughtJs(() => Buffer.alloc(4).fill(Buffer.alloc(0))),
    caughtJs(() => Buffer.alloc(4).fill("a", 1.5)),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("bytes: compareBuf — sign of first mismatch, prefix ordering, windowed comparisons, empty windows, and Node-exact validateOff errors", async () => {
  const res = await buildWasm(
    "bytes-compare.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "const a = Buffer.from([1,2,3,4]);",
      "const b = Buffer.from([1,2,3,5]);",
      "console.log(a.compare(b));",
      "console.log(b.compare(a));",
      "console.log(a.compare(Buffer.from([1,2,3,4])));",
      "console.log(a.compare(b, 0, 3, 0, 3));",
      "console.log(a.compare(b, 0, 3));",
      "console.log(Buffer.from([1,2]).compare(Buffer.from([1,2,3])));",
      "console.log(Buffer.from([1,2,3]).compare(Buffer.from([1,2])));",
      "console.log(a.compare(b, 2, 2));",
      "console.log(a.compare(b, 0, 4, 2, 2));",
      "caught(() => { a.compare(b, 1.5); });",
      "caught(() => { a.compare(b, -1); });",
      "caught(() => { a.compare(b, 0, 100); });",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([1, 2, 3, 5]);
  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const expected = [
    a.compare(b),
    b.compare(a),
    a.compare(Buffer.from([1, 2, 3, 4])),
    a.compare(b, 0, 3, 0, 3),
    a.compare(b, 0, 3),
    Buffer.from([1, 2]).compare(Buffer.from([1, 2, 3])),
    Buffer.from([1, 2, 3]).compare(Buffer.from([1, 2])),
    a.compare(b, 2, 2),
    a.compare(b, 0, 4, 2, 2),
    caughtJs(() => a.compare(b, 1.5)),
    caughtJs(() => a.compare(b, -1)),
    caughtJs(() => a.compare(b, 0, 100)),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("bytes: copy — overlap-safe memmove, floor-not-trunc coercion, non-finite-args-become-0 (a scr_bytes.c divergence), and Node-exact validateOff errors", async () => {
  const res = await buildWasm(
    "bytes-copy.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "const src = Buffer.from([1,2,3,4,5]);",
      "{ const d = Buffer.alloc(5); const n = src.copy(d); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, 1.7); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, 0, 1.7); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, NaN); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, Infinity); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, -Infinity); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, 0, Infinity); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, 0, 0, Infinity); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, 1e20); console.log(n + ':' + d.toString('hex')); }",
      "{ const d = Buffer.alloc(5); const n = src.copy(d, 100); console.log(n + ':' + d.toString('hex')); }",
      "{ const buf = Buffer.from([1,2,3,4,5]); const n = buf.copy(buf, 1, 0, 3); console.log(n + ':' + buf.toString('hex')); }",
      "{ const buf = Buffer.from([1,2,3,4,5]); const n = buf.copy(buf, 0, 2, 5); console.log(n + ':' + buf.toString('hex')); }",
      "caught(() => { src.copy(Buffer.alloc(5), -1); });",
      "caught(() => { src.copy(Buffer.alloc(5), -1.5); });",
      "caught(() => { src.copy(Buffer.alloc(5), 0, -1); });",
      "caught(() => { src.copy(Buffer.alloc(5), 0, 0, -1); });",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const src = Buffer.from([1, 2, 3, 4, 5]);
  const run = (fn: (d: Buffer) => number): string => {
    const d = Buffer.alloc(5);
    const n = fn(d);
    return `${n}:${d.toString("hex")}`;
  };
  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const buf1 = Buffer.from([1, 2, 3, 4, 5]);
  const n1 = buf1.copy(buf1, 1, 0, 3);
  const buf2 = Buffer.from([1, 2, 3, 4, 5]);
  const n2 = buf2.copy(buf2, 0, 2, 5);
  const expected = [
    run((d) => src.copy(d)),
    run((d) => src.copy(d, 1.7)),
    run((d) => src.copy(d, 0, 1.7)),
    run((d) => src.copy(d, NaN)),
    run((d) => src.copy(d, Infinity)),
    run((d) => src.copy(d, -Infinity)),
    run((d) => src.copy(d, 0, Infinity)),
    run((d) => src.copy(d, 0, 0, Infinity)),
    run((d) => src.copy(d, 1e20)),
    run((d) => src.copy(d, 100)),
    `${n1}:${buf1.toString("hex")}`,
    `${n2}:${buf2.toString("hex")}`,
    caughtJs(() => src.copy(Buffer.alloc(5), -1)),
    caughtJs(() => src.copy(Buffer.alloc(5), -1.5)),
    caughtJs(() => src.copy(Buffer.alloc(5), 0, -1)),
    caughtJs(() => src.copy(Buffer.alloc(5), 0, 0, -1)),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("bytes: writeStr — budget clamping (validated length vs remaining-after-offset), utf8/utf16le boundary truncation, and Node-exact errors", async () => {
  const res = await buildWasm(
    "bytes-writestr.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "{ const b = Buffer.alloc(8); const n = b.write('hi'); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(8); const n = b.write('hi', 2); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(8); const n = b.write('hello', 1, 3); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(3); const n = b.write('hello', 1); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(4); const n = b.write('hello', 2, 3); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(4); const n = b.write('hello', 0, 4); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(4); const n = b.write('hi', 4); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(3); const n = b.write('a\\u{1F600}', 0); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(3); const n = b.write('a\\u{1F600}', 0, 3, 'utf16le'); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(8); const n = b.write('68656c6c6f', 'hex'); console.log(n + ':' + b.toString('hex')); }",
      "{ const b = Buffer.alloc(2); const n = b.write('aabbcc', 0, 2, 'hex'); console.log(n + ':' + b.toString('hex')); }",
      "caught(() => { Buffer.alloc(4).write('hi', 100); });",
      "caught(() => { Buffer.alloc(4).write('hi', 1.5); });",
      "caught(() => { Buffer.alloc(4).write('hi', 0, 100); });",
      "caught(() => { Buffer.alloc(4).write('hi', 0, -1); });",
      "caught(() => { Buffer.alloc(4).write('hi', 5); });",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const run = (len: number, fn: (b: Buffer) => number): string => {
    const b = Buffer.alloc(len);
    const n = fn(b);
    return `${n}:${b.toString("hex")}`;
  };
  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const expected = [
    run(8, (b) => b.write("hi")),
    run(8, (b) => b.write("hi", 2)),
    run(8, (b) => b.write("hello", 1, 3)),
    run(3, (b) => b.write("hello", 1)),
    run(4, (b) => b.write("hello", 2, 3)),
    run(4, (b) => b.write("hello", 0, 4)),
    run(4, (b) => b.write("hi", 4)),
    run(3, (b) => b.write("a\u{1F600}", 0)),
    run(3, (b) => b.write("a\u{1F600}", 0, 3, "utf16le")),
    run(8, (b) => b.write("68656c6c6f", "hex")),
    run(2, (b) => b.write("aabbcc", 0, 2, "hex")),
    caughtJs(() => Buffer.alloc(4).write("hi", 100)),
    caughtJs(() => Buffer.alloc(4).write("hi", 1.5)),
    caughtJs(() => Buffer.alloc(4).write("hi", 0, 100)),
    caughtJs(() => Buffer.alloc(4).write("hi", 0, -1)),
    caughtJs(() => Buffer.alloc(4).write("hi", 5)),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("bytes: Buffer.byteLength(str, enc) — exact per-encoding formulas across empty/ASCII/BMP/astral strings", async () => {
  const strs = ["", "a", "ab", "abc", "hello", "a\\u00e9", "a\\u{1F600}b"];
  const encs = ["utf8", "latin1", "ascii", "utf16le", "hex", "base64", "base64url"];
  const srcLines: string[] = [];
  for (const s of strs) {
    for (const enc of encs) {
      srcLines.push(`console.log(Buffer.byteLength('${s}', '${enc}'));`);
    }
  }
  srcLines.push("");
  const res = await buildWasm("bytes-bytelength.ts", srcLines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const realStrs = ["", "a", "ab", "abc", "hello", "aé", "a\u{1F600}b"];
  const expected: string[] = [];
  for (const s of realStrs) {
    for (const enc of encs) {
      expected.push(String(Buffer.byteLength(s, enc as BufferEncoding)));
    }
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: Buffer.isEncoding — every accepted alias, both cases, and near-miss strings that must answer false", async () => {
  const cases = [
    "utf8", "utf-8", "UTF8", "UTF-8", "hex", "HEX", "base64", "BASE64",
    "base64url", "BASE64URL", "latin1", "LATIN1", "binary", "BINARY",
    "ascii", "ASCII", "utf16le", "UTF16LE", "utf-16le", "UTF-16LE",
    "ucs2", "UCS2", "ucs-2", "UCS-2", "ucs-16le", "utf32le", "garbage", "",
  ];
  const srcLines = cases.map((s) => `console.log(Buffer.isEncoding('${s}'));`);
  srcLines.push("");
  const res = await buildWasm("bytes-isencoding.ts", srcLines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const expected = cases.map((s) => String(Buffer.isEncoding(s)));
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: toString(enc, start, end) — its OWN clamp rule (negatives clamp to 0, no relative-to-end), never throws", async () => {
  const b = Buffer.from("hello world");
  const cases: [number, number][] = [
    [2, Infinity],
    [2, 5],
    [-2, Infinity],
    [-2, 5],
    [0, -2],
    [-100, -100],
    [100, 200],
    [5, 2],
    [NaN, 5],
    [2, NaN],
    [1.9, 5.9],
  ];
  const srcLines: string[] = ["const b = Buffer.from('hello world');"];
  for (const [start, end] of cases) {
    const startSrc = Number.isNaN(start) ? "NaN" : start === -Infinity ? "-Infinity" : String(start);
    const endSrc = Number.isNaN(end) ? "NaN" : end === Infinity ? "Infinity" : String(end);
    srcLines.push(`console.log(JSON.stringify(b.toString('utf8', ${startSrc}, ${endSrc})));`);
  }
  srcLines.push("console.log(JSON.stringify(b.toString('utf8')));");
  srcLines.push("");
  const res = await buildWasm("bytes-tostring-range.ts", srcLines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const expected = cases.map(([start, end]) => JSON.stringify(b.toString("utf8", start, end)));
  expected.push(JSON.stringify(b.toString("utf8")));
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: Buffer.concat/concatLen — truncate/zero-pad, empty-list short-circuit (even with an invalid length), never-identity, and Node-exact length errors", async () => {
  const res = await buildWasm(
    "bytes-concat.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "const a = Buffer.from([1,2,3]);",
      "const b = Buffer.from([4,5]);",
      "console.log(Buffer.concat([a,b]).toString('hex'));",
      "console.log(Buffer.concat([]).toString('hex'));",
      "{ const r = Buffer.concat([a]); console.log((r === a) + ':' + r.toString('hex')); }",
      "console.log(Buffer.concat([a,b], 5).toString('hex'));",
      "console.log(Buffer.concat([a,b], 3).toString('hex'));",
      "console.log(Buffer.concat([a,b], 8).toString('hex'));",
      "console.log(Buffer.concat([a,b], 0).toString('hex'));",
      "console.log(Buffer.concat([], 5).toString('hex'));",
      "console.log(Buffer.concat([Buffer.alloc(0), Buffer.from([1,2])]).toString('hex'));",
      "{ const r = Buffer.concat([a], 5); console.log((r === a) + ':' + r.toString('hex')); }",
      "console.log(Buffer.concat([a], 1).toString('hex'));",
      "caught(() => { Buffer.concat([], -1); });",
      "caught(() => { Buffer.concat([a,b], -1); });",
      "caught(() => { Buffer.concat([a,b], 1.5); });",
      "caught(() => { Buffer.concat([a,b], NaN); });",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const a = Buffer.from([1, 2, 3]);
  const b = Buffer.from([4, 5]);
  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const r1 = Buffer.concat([a]);
  const r2 = Buffer.concat([a], 5);
  const expected = [
    Buffer.concat([a, b]).toString("hex"),
    Buffer.concat([]).toString("hex"),
    `${r1 === a}:${r1.toString("hex")}`,
    Buffer.concat([a, b], 5).toString("hex"),
    Buffer.concat([a, b], 3).toString("hex"),
    Buffer.concat([a, b], 8).toString("hex"),
    Buffer.concat([a, b], 0).toString("hex"),
    Buffer.concat([], 5).toString("hex"),
    Buffer.concat([Buffer.alloc(0), Buffer.from([1, 2])]).toString("hex"),
    `${r2 === a}:${r2.toString("hex")}`,
    Buffer.concat([a], 1).toString("hex"),
    caughtJs(() => Buffer.concat([], -1)),
    caughtJs(() => Buffer.concat([a, b], -1)),
    caughtJs(() => Buffer.concat([a, b], 1.5)),
    caughtJs(() => Buffer.concat([a, b], NaN)),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("S034: concatLen's allocation-cap guard (the THIRD site) traps for a requested totalLength at or past 2^31 bytes", async () => {
  const res = await buildWasm(
    "bytes-concatlen-s034.ts",
    [
      "console.log('pre');",
      "Buffer.concat([Buffer.from([1])], 2147483648);",
      "console.log('unreached');",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasmToTrap(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("pre\n");
});

test("bytes: Buffer.byteLength(str, 'base64'/'base64url') — the padding-strip rule, not the naive (len*3)>>>2 (a bug this exact sweep caught)", async () => {
  const cases = ["SGVsbG8=", "SGVsbG8==", "SGVsbG8", "", "QQ==", "QQ===", "====", "QUJD", "QUJDRA==", "=", "A=", "A==="];
  const srcLines: string[] = [];
  for (const s of cases) {
    srcLines.push(`console.log(Buffer.byteLength('${s}', 'base64'));`);
    srcLines.push(`console.log(Buffer.byteLength('${s}', 'base64url'));`);
  }
  srcLines.push("");
  const res = await buildWasm("bytes-bytelength-b64-padding.ts", srcLines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const expected: string[] = [];
  for (const s of cases) {
    expected.push(String(Buffer.byteLength(s, "base64")));
    expected.push(String(Buffer.byteLength(s, "base64url")));
  }
  expect(stdout.toString("utf8")).toBe(expected.join("\n") + "\n");
});

test("bytes: readNum/writeNum float kinds (f32be/f32le/f64be/f64le) — no value gate, Infinity narrows, NaN is bit-exact passthrough (literal folds match Node's own constant fold, S036), and Node-exact offset errors", async () => {
  const res = await buildWasm(
    "bytes-readnum-writenum-float.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) {",
      "    const err = e as Error;",
      "    console.log('caught:' + err.name + ':' + err.message);",
      "  }",
      "};",
      "// basic round trips",
      "{ const b = Buffer.alloc(4); b.writeFloatBE(1.5, 0); console.log(b.toString('hex') + ':' + b.readFloatBE(0)); }",
      "{ const b = Buffer.alloc(4); b.writeFloatLE(1.5, 0); console.log(b.toString('hex') + ':' + b.readFloatLE(0)); }",
      "{ const b = Buffer.alloc(8); b.writeDoubleBE(1.5, 0); console.log(b.toString('hex') + ':' + b.readDoubleBE(0)); }",
      "{ const b = Buffer.alloc(8); b.writeDoubleLE(1.5, 0); console.log(b.toString('hex') + ':' + b.readDoubleLE(0)); }",
      "// Infinity / huge-value narrowing",
      "{ const b = Buffer.alloc(4); b.writeFloatBE(Infinity, 0); console.log(b.toString('hex')); }",
      "{ const b = Buffer.alloc(4); b.writeFloatBE(-Infinity, 0); console.log(b.toString('hex')); }",
      "{ const b = Buffer.alloc(4); b.writeFloatBE(1e300, 0); console.log(b.toString('hex')); }",
      "{ const b = Buffer.alloc(8); b.writeDoubleBE(Infinity, 0); console.log(b.toString('hex')); }",
      "// NaN (canonical JS NaN) — already canonical",
      "{ const b = Buffer.alloc(4); b.writeFloatBE(NaN, 0); console.log(b.toString('hex')); }",
      "{ const b = Buffer.alloc(8); b.writeDoubleBE(NaN, 0); console.log(b.toString('hex')); }",
      "// S036: a LITERAL-operand arithmetic NaN (0/0 written directly as",
      "// source literals) constant-folds at compile time to the CANONICAL",
      "// bit pattern, matching Node's own literal constant-fold exactly —",
      "// this is the corpus-1660 fix. This is emitter-level folding",
      "// (emitBin), not write-side canonicalization — see the separate",
      "// runtime-NaN test below for the genuinely-computed (unfolded) case,",
      "// which passes through the host toolchain's own NaN bits unchanged.",
      "{ const b = Buffer.alloc(8); b.writeDoubleBE(0 / 0, 0); console.log(b.toString('hex')); }",
      "{ const b = Buffer.alloc(4); b.writeFloatBE(0 / 0, 0); console.log(b.toString('hex')); }",
      "// custom-payload / signaling NaN round trip: read a hand-built bit",
      "// pattern via readNum, write the SAME value back, compare bytes.",
      "// Bit-exact passthrough, matching Node exactly (no folding involved —",
      "// these values arrive via Buffer.from/readDoubleBE, never as IR",
      "// numLit operands, so emitBin's literal fold never sees them).",
      "{ const src = Buffer.from('7ff8000000000001', 'hex'); const v = src.readDoubleBE(0); const dst = Buffer.alloc(8); dst.writeDoubleBE(v, 0); console.log(dst.toString('hex')); }",
      "{ const src = Buffer.from('fff8000000000000', 'hex'); const v = src.readDoubleBE(0); const dst = Buffer.alloc(8); dst.writeDoubleBE(v, 0); console.log(dst.toString('hex')); }",
      "{ const src = Buffer.from('7ff0000000000001', 'hex'); const v = src.readDoubleBE(0); const dst = Buffer.alloc(8); dst.writeDoubleBE(v, 0); console.log(dst.toString('hex')); }",
      "{ const src = Buffer.from('7fc00001', 'hex'); const v = src.readFloatBE(0); const dst = Buffer.alloc(4); dst.writeFloatBE(v, 0); console.log(dst.toString('hex')); }",
      "{ const src = Buffer.from('7f800001', 'hex'); const v = src.readFloatBE(0); const dst = Buffer.alloc(4); dst.writeFloatBE(v, 0); console.log(dst.toString('hex')); }",
      "// offset errors",
      "caught(() => { Buffer.alloc(4).writeFloatBE(1.5, 100); });",
      "caught(() => { Buffer.alloc(4).writeFloatBE(1.5, 1.5); });",
      "caught(() => { Buffer.alloc(8).readDoubleBE(100); });",
      "caught(() => { Buffer.alloc(4).readFloatBE(1); });",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const run = (fn: () => string): string => fn();
  const expected = [
    run(() => {
      const b = Buffer.alloc(4);
      b.writeFloatBE(1.5, 0);
      return `${b.toString("hex")}:${b.readFloatBE(0)}`;
    }),
    run(() => {
      const b = Buffer.alloc(4);
      b.writeFloatLE(1.5, 0);
      return `${b.toString("hex")}:${b.readFloatLE(0)}`;
    }),
    run(() => {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(1.5, 0);
      return `${b.toString("hex")}:${b.readDoubleBE(0)}`;
    }),
    run(() => {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(1.5, 0);
      return `${b.toString("hex")}:${b.readDoubleLE(0)}`;
    }),
    run(() => {
      const b = Buffer.alloc(4);
      b.writeFloatBE(Infinity, 0);
      return b.toString("hex");
    }),
    run(() => {
      const b = Buffer.alloc(4);
      b.writeFloatBE(-Infinity, 0);
      return b.toString("hex");
    }),
    run(() => {
      const b = Buffer.alloc(4);
      b.writeFloatBE(1e300, 0);
      return b.toString("hex");
    }),
    run(() => {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(Infinity, 0);
      return b.toString("hex");
    }),
    run(() => {
      const b = Buffer.alloc(4);
      b.writeFloatBE(NaN, 0);
      return b.toString("hex");
    }),
    run(() => {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(NaN, 0);
      return b.toString("hex");
    }),
    // S036: literal-operand 0/0 constant-folds at compile time to the
    // canonical bit pattern, matching Node's own literal fold exactly
    // (both sides measured to give 7ff8000000000000 / 7fc00000 here).
    "7ff8000000000000",
    "7fc00000",
    // Crafted/signaling NaN bytes echo through unchanged — bit-exact
    // passthrough, Node-exact (no folding possible: these values never
    // exist as IR numLit operands).
    run(() => {
      const src = Buffer.from("7ff8000000000001", "hex");
      const v = src.readDoubleBE(0);
      const dst = Buffer.alloc(8);
      dst.writeDoubleBE(v, 0);
      return dst.toString("hex");
    }),
    run(() => {
      const src = Buffer.from("fff8000000000000", "hex");
      const v = src.readDoubleBE(0);
      const dst = Buffer.alloc(8);
      dst.writeDoubleBE(v, 0);
      return dst.toString("hex");
    }),
    run(() => {
      const src = Buffer.from("7ff0000000000001", "hex");
      const v = src.readDoubleBE(0);
      const dst = Buffer.alloc(8);
      dst.writeDoubleBE(v, 0);
      return dst.toString("hex");
    }),
    run(() => {
      const src = Buffer.from("7fc00001", "hex");
      const v = src.readFloatBE(0);
      const dst = Buffer.alloc(4);
      dst.writeFloatBE(v, 0);
      return dst.toString("hex");
    }),
    run(() => {
      const src = Buffer.from("7f800001", "hex");
      const v = src.readFloatBE(0);
      const dst = Buffer.alloc(4);
      dst.writeFloatBE(v, 0);
      return dst.toString("hex");
    }),
    caughtJs(() => Buffer.alloc(4).writeFloatBE(1.5, 100)),
    caughtJs(() => Buffer.alloc(4).writeFloatBE(1.5, 1.5)),
    caughtJs(() => Buffer.alloc(8).readDoubleBE(100)),
    caughtJs(() => Buffer.alloc(4).readFloatBE(1)),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("bin: literal-operand constant folding — behavioral parity across +,-,*,/,%,**, validates, and covers the previously-refused literal ** case (SEMANTICS.md S036)", async () => {
  const source = [
    "console.log((2 + 3).toString());",
    "console.log((2 - 3).toString());",
    "console.log((2 * 3).toString());",
    "console.log((7 / 2).toString());",
    "console.log((7 % 2).toString());",
    "console.log((2 ** 10).toString());", // previously an unconditional SC3001 refusal — literal-literal now folds
    "console.log((0 / 0).toString());", // folded NaN — byte-level pinned separately in the float-kinds test
    "console.log((-0 * 1).toString());", // sign-bit case: fold must not normalize -0 away
    "",
  ].join("\n");
  const res = await buildWasm("bin-literal-fold.ts", source);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const expected = [
    (2 + 3).toString(),
    (2 - 3).toString(),
    (2 * 3).toString(),
    (7 / 2).toString(),
    (7 % 2).toString(),
    (2 ** 10).toString(),
    (0 / 0).toString(),
    (-0 * 1).toString(),
    "",
  ].join("\n");
  expect(stdout.toString("utf8")).toBe(expected);
});

test("bin: ** still refuses for NON-literal operands — folding is literal-operand only, no constant propagation or variable lookthrough", async () => {
  const res = await buildWasm(
    "bin-pow-nonliteral.ts",
    ["const a: number = 2;", "const b: number = 10;", "console.log((a ** b).toString());", ""].join("\n"),
  );
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
  expect(res.wasmSurvey).toContain("bin:**");
});

test("bin: a variable-sourced division is NOT folded away — proves no over-folding by diffing raw f64.div (0xa3) opcode counts between otherwise-identical programs", async () => {
  // Two programs, structurally identical (same locals, one console.log
  // call each) except line 3: the baseline assigns `c = a` (a plain
  // varRef, no arithmetic); the test program assigns `c = a / b` (a
  // REAL division over two `const`-bound variables — provably constant-
  // valued by a human reader, but NOT IR numLit nodes, so emitBin's fold
  // check must not touch it). Any 0xa3 bytes contributed by unrelated
  // stdlib code (e.g. number formatting) are identical in both binaries
  // and cancel out of the diff — only the count DELTA is asserted, not
  // an absolute count, so this doesn't assume anything about baseline
  // noise elsewhere in the module.
  const countF64Div = (bytes: Uint8Array): number => {
    let n = 0;
    for (const b of bytes) if (b === 0xa3) n++;
    return n;
  };
  const baseline = await buildWasm(
    "bin-nofold-baseline.ts",
    ["const a: number = 4;", "const b: number = 2;", "const c: number = a;", "console.log(c.toString());", ""].join(
      "\n",
    ),
  );
  if (!baseline.ok) throw new Error(`refused: ${baseline.diagnostics[0]?.message}`);
  const withDivision = await buildWasm(
    "bin-nofold-division.ts",
    [
      "const a: number = 4;",
      "const b: number = 2;",
      "const c: number = a / b;",
      "console.log(c.toString());",
      "",
    ].join("\n"),
  );
  if (!withDivision.ok) throw new Error(`refused: ${withDivision.diagnostics[0]?.message}`);
  const baselineCount = countF64Div(readFileSync(baseline.binaryPath));
  const withDivisionCount = countF64Div(readFileSync(withDivision.binaryPath));
  expect(withDivisionCount).toBe(baselineCount + 1);
  // Behavioral cross-check: the (unfolded) division still computes the
  // right answer at runtime.
  const { stdout } = await runWasm(withDivision.binaryPath);
  expect(stdout.toString("utf8")).toBe(`${(4 / 2).toString()}\n`);
});

test("bin: the measured V8 folding boundary — Infinity/NaN globals, recursive literal-derived folds, in-process Node diff (SEMANTICS.md S036's table)", async () => {
  // Every row is the reviewer's measured boundary table, re-verified here
  // independently (in-process Node diff, not a hardcoded hex string, so
  // this travels correctly if a future toolchain moves the hardware
  // pattern). FOLDS rows must give the CANONICAL NaN on both sides;
  // DOES-NOT-FOLD rows must give the SAME (hardware) pattern on both
  // sides, whatever that pattern is on this host/toolchain.
  const folds: [string, string, () => number][] = [
    ["0/0", "0 / 0", () => 0 / 0],
    ["0.0/0.0", "0.0 / 0.0", () => 0.0 / 0.0],
    ["(0)/(0)", "(0) / (0)", () => (0) / (0)],
    ["-0/0", "-0 / 0", () => -0 / 0],
    ["0/-0", "0 / -0", () => 0 / -0],
    ["0%0", "0 % 0", () => 0 % 0],
    ["(1/0)-(1/0)", "(1 / 0) - (1 / 0)", () => (1 / 0) - (1 / 0)], // literal-DERIVED Infinity is a foldable intermediate
    ["(1/0)*0", "(1 / 0) * 0", () => (1 / 0) * 0],
    ["NaN", "NaN", () => NaN],
    ["NaN+1", "NaN + 1", () => NaN + 1],
    ["NaN*2", "NaN * 2", () => NaN * 2],
  ];
  const doesNotFold: [string, string, () => number][] = [
    ["0*Infinity", "0 * Infinity", () => 0 * Infinity], // the Infinity GLOBAL does not fold, unlike a literal-derived Infinity
    ["Infinity-Infinity", "Infinity - Infinity", () => Infinity - Infinity],
    ["Infinity/Infinity", "Infinity / Infinity", () => Infinity / Infinity],
    ["Infinity*0", "Infinity * 0", () => Infinity * 0],
  ];
  const rows = [...folds, ...doesNotFold];
  const lines = rows.map(
    ([, expr]) => `{ const b = Buffer.alloc(8); b.writeDoubleBE(${expr}, 0); console.log(b.toString('hex')); }`,
  );
  const res = await buildWasm("bin-boundary-table.ts", [...lines, ""].join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const wasmLines = stdout.toString("utf8").trim().split("\n");

  // Node's own answer for the SAME expressions, computed in-process (not
  // hardcoded) so a future toolchain's hardware pattern doesn't break
  // this test — only the WASM-VS-NODE agreement is asserted.
  const nodeHex = (fn: () => number): string => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(fn(), 0);
    return b.toString("hex");
  };
  for (let i = 0; i < rows.length; i++) {
    const [label, , fn] = rows[i]!;
    expect(wasmLines[i], `row "${label}"`).toBe(nodeHex(fn));
  }
  // The fold rows specifically must be canonical (not just "match Node
  // by coincidence") — this is the actual claim S036 makes.
  for (let i = 0; i < folds.length; i++) {
    expect(wasmLines[i], `fold row "${folds[i]![0]}" must be canonical`).toBe("7ff8000000000000");
  }
});

test("bytes: writeNum float LE — the reviewer's LE-shaped NaN vectors, including f32's quiet-but-preserve-payload round trip, in-process Node diff", async () => {
  // f64: no narrowing conversion involved, so every vector should be a
  // pure bit-exact echo, LE included. f32: readFloatLE/writeFloatLE
  // widen to f64 then narrow back to f32 (JS numbers are always f64) —
  // an ALREADY-QUIET input echoes exactly, but a SIGNALING input (top
  // mantissa bit clear) gets QUIETED (top mantissa bit set) while every
  // OTHER payload bit is preserved — a hardware artifact of the
  // f32->f64->f32 conversion path, not something this tier's write side
  // does deliberately; Node has the identical artifact (measured), so
  // this is Node-exact, not a divergence.
  const f64Vectors = ["010000000000f87f", "010000000000f8ff", "010000000000f07f", "ffffffffffffffff"];
  const f32Vectors = ["0100c07f", "0100c0ff", "0100807f", "ffffffff"]; // third one is the signaling case
  const lines: string[] = [];
  for (const h of f64Vectors) {
    lines.push(
      `{ const src = Buffer.from('${h}', 'hex'); const v = src.readDoubleLE(0); const dst = Buffer.alloc(8); dst.writeDoubleLE(v, 0); console.log(dst.toString('hex')); }`,
    );
  }
  for (const h of f32Vectors) {
    lines.push(
      `{ const src = Buffer.from('${h}', 'hex'); const v = src.readFloatLE(0); const dst = Buffer.alloc(4); dst.writeFloatLE(v, 0); console.log(dst.toString('hex')); }`,
    );
  }
  const res = await buildWasm("bytes-writenum-float-le-vectors.ts", [...lines, ""].join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const wasmLines = stdout.toString("utf8").trim().split("\n");

  const expected: string[] = [];
  for (const h of f64Vectors) {
    const src = Buffer.from(h, "hex");
    const v = src.readDoubleLE(0);
    const dst = Buffer.alloc(8);
    dst.writeDoubleLE(v, 0);
    expected.push(dst.toString("hex"));
  }
  for (const h of f32Vectors) {
    const src = Buffer.from(h, "hex");
    const v = src.readFloatLE(0);
    const dst = Buffer.alloc(4);
    dst.writeFloatLE(v, 0);
    expected.push(dst.toString("hex"));
  }
  expect(wasmLines).toEqual(expected);
  // Pin the specific signaling-quiets-but-preserves-payload claim
  // explicitly, not just via the diff above.
  expect(expected[6]).toBe("0100c07f"); // f32Vectors[2] = "0100807f" (signaling) -> quiets
  expect(wasmLines[6]).toBe("0100c07f");
});

test("bytes: writeNum float — a GENUINELY runtime-computed NaN (array-element division, not a literal) passes through as bit-exact as Node's own runtime NaN (SEMANTICS.md S036)", async () => {
  // Deliberately NOT a literal 0/0: emitBin's literal-operand fold only
  // fires when BOTH operands are IR numLit nodes, and an array read is
  // not one — this exercises the UNFOLDED path, where this tier passes
  // the division's own bits through unchanged, exactly like the fixed-
  // width integer helpers do for every other value. Whatever bit pattern
  // the host toolchain's wasm f64.div/f32 narrowing actually produces is
  // the expected answer here — NOT hardcoded, diffed against a real Node
  // run of the SAME source, so this test travels correctly to a future
  // toolchain or host architecture that computes a different pattern.
  const source = [
    "const arr: number[] = [0, 0];",
    "const b1 = Buffer.alloc(8); b1.writeDoubleBE(arr[0]! / arr[1]!, 0); console.log(b1.toString('hex'));",
    "const b2 = Buffer.alloc(8); b2.writeDoubleLE(arr[0]! / arr[1]!, 0); console.log(b2.toString('hex'));",
    "const b3 = Buffer.alloc(4); b3.writeFloatBE(arr[0]! / arr[1]!, 0); console.log(b3.toString('hex'));",
    "const b4 = Buffer.alloc(4); b4.writeFloatLE(arr[0]! / arr[1]!, 0); console.log(b4.toString('hex'));",
    "",
  ].join("\n");
  const res = await buildWasm("bytes-writenum-float-runtime-nan.ts", source);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const arr: number[] = [0, 0];
  const b1 = Buffer.alloc(8);
  b1.writeDoubleBE(arr[0]! / arr[1]!, 0);
  const b2 = Buffer.alloc(8);
  b2.writeDoubleLE(arr[0]! / arr[1]!, 0);
  const b3 = Buffer.alloc(4);
  b3.writeFloatBE(arr[0]! / arr[1]!, 0);
  const b4 = Buffer.alloc(4);
  b4.writeFloatLE(arr[0]! / arr[1]!, 0);
  const expected = [b1.toString("hex"), b2.toString("hex"), b3.toString("hex"), b4.toString("hex"), ""].join("\n");
  expect(stdout.toString("utf8")).toBe(expected);
});

test("bytes: readNumVar/writeNumVar — every byteLength 1-6, all four kinds, the byteLength-first check order, NaN-writes-zero, Node-exact errors, and the byteLength>4 symbolic message-format switch", async () => {
  const srcLines: string[] = [
    "const caught = (fn: () => void): void => {",
    "  try { fn(); console.log('no throw'); }",
    "  catch (e) {",
    "    const err = e as Error;",
    "    console.log('caught:' + err.name + ':' + err.message);",
    "  }",
    "};",
  ];
  // Round-trip every byteLength 1-6, all four kinds, with a representative value.
  for (let bl = 1; bl <= 6; bl++) {
    const uval = `0x${"12".repeat(bl)}`;
    srcLines.push(
      `{ const w = Buffer.alloc(${bl}); w.writeUIntLE(${uval}, 0, ${bl}); console.log(w.toString('hex') + ':' + w.readUIntLE(0, ${bl})); }`,
      `{ const w = Buffer.alloc(${bl}); w.writeUIntBE(${uval}, 0, ${bl}); console.log(w.toString('hex') + ':' + w.readUIntBE(0, ${bl})); }`,
      `{ const w = Buffer.alloc(${bl}); w.writeIntLE(-1, 0, ${bl}); console.log(w.toString('hex') + ':' + w.readIntLE(0, ${bl})); }`,
      `{ const w = Buffer.alloc(${bl}); w.writeIntBE(-1, 0, ${bl}); console.log(w.toString('hex') + ':' + w.readIntBE(0, ${bl})); }`,
    );
  }
  // NaN writes zero, byteLength-first check order, value range, offset ladder.
  srcLines.push(
    "{ const w = Buffer.alloc(3); const n = w.writeUIntLE(NaN, 0, 3); console.log(n + ':' + w.toString('hex')); }",
    "{ const w = Buffer.alloc(3); const n = w.writeIntLE(NaN, 0, 3); console.log(n + ':' + w.toString('hex')); }",
    "{ const w = Buffer.alloc(3); const n = w.writeUIntLE(1.9, 0, 3); console.log(n + ':' + w.toString('hex')); }",
    "{ const w = Buffer.alloc(3); const n = w.writeIntLE(-1.9, 0, 3); console.log(n + ':' + w.toString('hex')); }",
    "caught(() => { Buffer.alloc(8).readUIntLE(0, 0); });",
    "caught(() => { Buffer.alloc(8).readUIntLE(0, 7); });",
    "caught(() => { Buffer.alloc(8).readUIntLE(0, -1); });",
    "caught(() => { Buffer.alloc(8).readUIntLE(0, -1.5); });",
    "caught(() => { Buffer.alloc(8).readUIntLE(0, NaN); });",
    "caught(() => { Buffer.alloc(8).readUIntLE(0, Infinity); });",
    "caught(() => { Buffer.alloc(8).readUIntLE(0, -Infinity); });",
    "caught(() => { Buffer.alloc(8).readUIntLE(100, 7); });", // byteLength error wins over offset
    "caught(() => { Buffer.alloc(8).writeUIntLE(999999999, 100, 7); });", // byteLength error wins
    "caught(() => { Buffer.alloc(8).writeUIntLE(-1, 0, 0); });", // byteLength error wins over value
    "caught(() => { Buffer.alloc(3).writeUIntLE(16777216, 0, 3); });",
    "caught(() => { Buffer.alloc(3).writeUIntLE(16777215, 0, 3); Buffer.alloc(3).writeUIntLE(-1, 0, 3); });",
    "caught(() => { Buffer.alloc(3).readUIntLE(1, 3); });", // offset out of range for byteLength
    "caught(() => { Buffer.alloc(3).readUIntLE(0.5, 3); });",
    // Value-range error message format switch at byteLength > 4 (measured
    // against Node directly): 1-4 keeps the decimal "must be >= MIN and
    // <= MAX"; 5-6 switches to symbolic "must be >= 0 and < 2 ** N" /
    // "must be >= -(2 ** N) and < 2 ** N" with an EXCLUSIVE upper bound.
    // `**` isn't supported by this backend, so literal decimals stand in
    // for `2 ** 40` etc. below.
    "caught(() => { const b = Buffer.alloc(8); b.writeUIntLE(1099511627776, 0, 5); });", // unsigned width5 over max (2**40)
    "caught(() => { const b = Buffer.alloc(8); b.writeIntLE(549755813888, 0, 5); });", // signed width5 over max (2**39)
    "caught(() => { const b = Buffer.alloc(8); b.writeIntLE(-549755813889, 0, 5); });", // signed width5 under min (-(2**39)-1)
    "caught(() => { const b = Buffer.alloc(8); b.writeUIntLE(281474976710656, 0, 6); });", // unsigned width6 over max (2**48)
    "caught(() => { const b = Buffer.alloc(8); b.writeIntLE(140737488355328, 0, 6); });", // signed width6 over max (2**47)
    "caught(() => { const b = Buffer.alloc(8); b.writeIntLE(-140737488355329, 0, 6); });", // signed width6 under min (-(2**47)-1)
    "caught(() => { const b = Buffer.alloc(8); b.writeUIntBE(4294967296, 0, 4); });", // unsigned width4 (decimal format still, 2**32)
    "caught(() => { const b = Buffer.alloc(8); b.writeIntBE(2147483648, 0, 4); });", // signed width4 (decimal format still, 2**31)
    "",
  );
  const res = await buildWasm("bytes-readnumvar-writenumvar.ts", srcLines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const expected: string[] = [];
  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  for (let bl = 1; bl <= 6; bl++) {
    const uval = Number(`0x${"12".repeat(bl)}`);
    {
      const w = Buffer.alloc(bl);
      w.writeUIntLE(uval, 0, bl);
      expected.push(`${w.toString("hex")}:${w.readUIntLE(0, bl)}`);
    }
    {
      const w = Buffer.alloc(bl);
      w.writeUIntBE(uval, 0, bl);
      expected.push(`${w.toString("hex")}:${w.readUIntBE(0, bl)}`);
    }
    {
      const w = Buffer.alloc(bl);
      w.writeIntLE(-1, 0, bl);
      expected.push(`${w.toString("hex")}:${w.readIntLE(0, bl)}`);
    }
    {
      const w = Buffer.alloc(bl);
      w.writeIntBE(-1, 0, bl);
      expected.push(`${w.toString("hex")}:${w.readIntBE(0, bl)}`);
    }
  }
  {
    const w = Buffer.alloc(3);
    const n = w.writeUIntLE(NaN, 0, 3);
    expected.push(`${n}:${w.toString("hex")}`);
  }
  {
    const w = Buffer.alloc(3);
    const n = w.writeIntLE(NaN, 0, 3);
    expected.push(`${n}:${w.toString("hex")}`);
  }
  {
    const w = Buffer.alloc(3);
    const n = w.writeUIntLE(1.9, 0, 3);
    expected.push(`${n}:${w.toString("hex")}`);
  }
  {
    const w = Buffer.alloc(3);
    const n = w.writeIntLE(-1.9, 0, 3);
    expected.push(`${n}:${w.toString("hex")}`);
  }
  expected.push(
    caughtJs(() => Buffer.alloc(8).readUIntLE(0, 0)),
    caughtJs(() => Buffer.alloc(8).readUIntLE(0, 7)),
    caughtJs(() => Buffer.alloc(8).readUIntLE(0, -1)),
    caughtJs(() => Buffer.alloc(8).readUIntLE(0, -1.5)),
    caughtJs(() => Buffer.alloc(8).readUIntLE(0, NaN)),
    caughtJs(() => Buffer.alloc(8).readUIntLE(0, Infinity)),
    caughtJs(() => Buffer.alloc(8).readUIntLE(0, -Infinity)),
    caughtJs(() => Buffer.alloc(8).readUIntLE(100, 7)),
    caughtJs(() => Buffer.alloc(8).writeUIntLE(999999999, 100, 7)),
    caughtJs(() => Buffer.alloc(8).writeUIntLE(-1, 0, 0)),
    caughtJs(() => Buffer.alloc(3).writeUIntLE(2 ** 24, 0, 3)),
    caughtJs(() => {
      Buffer.alloc(3).writeUIntLE(2 ** 24 - 1, 0, 3);
      Buffer.alloc(3).writeUIntLE(-1, 0, 3);
    }),
    caughtJs(() => Buffer.alloc(3).readUIntLE(1, 3)),
    caughtJs(() => Buffer.alloc(3).readUIntLE(0.5, 3)),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeUIntLE(2 ** 40, 0, 5);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeIntLE(2 ** 39, 0, 5);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeIntLE(-(2 ** 39) - 1, 0, 5);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeUIntLE(2 ** 48, 0, 6);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeIntLE(2 ** 47, 0, 6);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeIntLE(-(2 ** 47) - 1, 0, 6);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeUIntBE(2 ** 32, 0, 4);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeIntBE(2 ** 31, 0, 4);
    }),
    "",
  );
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

/* ── increment 18 stage C, round R1: DataView. Every test below diffs
 * against Node computed IN-PROCESS (never a hardcoded literal), matching
 * the rest of this file's oracle discipline. `new DataView(new
 * ArrayBuffer(n), ...)` must stay INLINE (a free-standing ArrayBuffer
 * variable is fenced, SC2020) — every source string below constructs it
 * that way. ────────────────────────────────────────────────────────── */

test("DataView: construction — all forms, two separate RangeError ladders, ToIndex truncation (not floor), NaN-as-0", async () => {
  const res = await buildWasm(
    "dataview-construction.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) { const err = e as Error; console.log('caught:' + err.name + ':' + err.message); }",
      "};",
      "{ const dv = new DataView(new ArrayBuffer(8)); console.log(dv.byteLength + ':' + dv.byteOffset); }",
      "{ const u8 = new Uint8Array(8); const dv = new DataView(u8.buffer, 2); console.log(dv.byteLength + ':' + dv.byteOffset); }",
      "{ const u8 = new Uint8Array(8); const dv = new DataView(u8.buffer, 2, 4); console.log(dv.byteLength + ':' + dv.byteOffset); }",
      "caught(() => { new DataView(new ArrayBuffer(8), -1); });",
      "caught(() => { new DataView(new ArrayBuffer(8), 100); });",
      "caught(() => { new DataView(new ArrayBuffer(8), 0, -1); });",
      "caught(() => { new DataView(new ArrayBuffer(8), 4, 8); });",
      "caught(() => { new DataView(new ArrayBuffer(8), 0, Infinity); });",
      "caught(() => { new DataView(new ArrayBuffer(8), Infinity); });",
      "{ const dv = new DataView(new ArrayBuffer(8), 1.5); console.log(dv.byteOffset); }",
      "caught(() => { new DataView(new ArrayBuffer(8), -1.5); });",
      "{ const dv = new DataView(new ArrayBuffer(8), NaN); console.log(dv.byteOffset); }",
      "{ const dv = new DataView(new ArrayBuffer(8), 0, NaN); console.log(dv.byteLength); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const expected = [
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      return `${dv.byteLength}:${dv.byteOffset}`;
    })(),
    (() => {
      const u8 = new Uint8Array(8);
      const dv = new DataView(u8.buffer, 2);
      return `${dv.byteLength}:${dv.byteOffset}`;
    })(),
    (() => {
      const u8 = new Uint8Array(8);
      const dv = new DataView(u8.buffer, 2, 4);
      return `${dv.byteLength}:${dv.byteOffset}`;
    })(),
    caughtJs(() => new DataView(new ArrayBuffer(8), -1)),
    caughtJs(() => new DataView(new ArrayBuffer(8), 100)),
    caughtJs(() => new DataView(new ArrayBuffer(8), 0, -1)),
    caughtJs(() => new DataView(new ArrayBuffer(8), 4, 8)),
    caughtJs(() => new DataView(new ArrayBuffer(8), 0, Infinity)),
    caughtJs(() => new DataView(new ArrayBuffer(8), Infinity)),
    (() => new DataView(new ArrayBuffer(8), 1.5).byteOffset)(),
    caughtJs(() => new DataView(new ArrayBuffer(8), -1.5)),
    (() => new DataView(new ArrayBuffer(8), NaN).byteOffset)(),
    (() => new DataView(new ArrayBuffer(8), 0, NaN).byteLength)(),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

test("DataView: integer get/set — all six widths, BE/LE, signed sign-extension, NO value-range RangeError (only offset can throw)", async () => {
  const lines: string[] = [
    "const caught = (fn: () => void): void => {",
    "  try { fn(); console.log('no throw'); }",
    "  catch (e) { const err = e as Error; console.log('caught:' + err.name + ':' + err.message); }",
    "};",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint8(0, 200); console.log(dv.getUint8(0)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setInt8(0, -100); console.log(dv.getInt8(0)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint16(0, 0xABCD); console.log(dv.getUint16(0)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint16(0, 0xABCD, true); console.log(dv.getUint16(0, true)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setInt16(0, -1234); console.log(dv.getInt16(0)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setInt16(0, -1234, true); console.log(dv.getInt16(0, true)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, 0xABCDEF01); console.log(dv.getUint32(0)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, 0xABCDEF01, true); console.log(dv.getUint32(0, true)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setInt32(0, -123456789); console.log(dv.getInt32(0)); }",
    "{ const dv = new DataView(new ArrayBuffer(8)); dv.setInt32(0, -123456789, true); console.log(dv.getInt32(0, true)); }",
    // BE write vs LE read differ (proves the runtime LE branch actually swaps bytes)
    "{ const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, 0x01020304); console.log(dv.getUint32(0, true)); }",
    // offset OOB — flat constant message across widths and directions
    "caught(() => { const dv = new DataView(new ArrayBuffer(4)); dv.getUint32(1); });",
    "caught(() => { const dv = new DataView(new ArrayBuffer(4)); dv.setUint8(4, 1); });",
    "caught(() => { const dv = new DataView(new ArrayBuffer(4)); dv.getInt16(3); });",
    // NO value-range RangeError: an out-of-range value wraps silently
    "{ const dv = new DataView(new ArrayBuffer(4)); dv.setInt8(0, 300); console.log(dv.getInt8(0)); }",
    "{ const dv = new DataView(new ArrayBuffer(4)); dv.setUint8(0, -1); console.log(dv.getUint8(0)); }",
    "",
  ];
  const res = await buildWasm("dataview-int-getset.ts", lines.join("\n"));
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const expected = [
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint8(0, 200);
      return dv.getUint8(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setInt8(0, -100);
      return dv.getInt8(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint16(0, 0xabcd);
      return dv.getUint16(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint16(0, 0xabcd, true);
      return dv.getUint16(0, true);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setInt16(0, -1234);
      return dv.getInt16(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setInt16(0, -1234, true);
      return dv.getInt16(0, true);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 0xabcdef01);
      return dv.getUint32(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 0xabcdef01, true);
      return dv.getUint32(0, true);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setInt32(0, -123456789);
      return dv.getInt32(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setInt32(0, -123456789, true);
      return dv.getInt32(0, true);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint32(0, 0x01020304);
      return dv.getUint32(0, true);
    })(),
    caughtJs(() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.getUint32(1);
    }),
    caughtJs(() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint8(4, 1);
    }),
    caughtJs(() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.getInt16(3);
    }),
    (() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setInt8(0, 300);
      return dv.getInt8(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint8(0, -1);
      return dv.getUint8(0);
    })(),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.map(String).join("\n"));
});

test("DataView: the SAME bad offset (non-integer, NaN) — Buffer's readNum/writeNum ladder THROWS, DataView's ladder silently ToIndex-truncates. Pinned explicitly so no future refactor unifies the two contracts (the B2 ladder-difference precedent)", async () => {
  const res = await buildWasm(
    "dataview-vs-buffer-leniency.ts",
    [
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) { const err = e as Error; console.log('caught:' + err.name + ':' + err.message); }",
      "};",
      // Buffer: a non-integer offset THROWS (stage B's readNum ladder).
      "caught(() => { const b = Buffer.alloc(8); b.readUInt8(1.5); });",
      "caught(() => { const b = Buffer.alloc(8); b.writeUInt8(1, 1.5); });",
      "caught(() => { const b = Buffer.alloc(8); b.readUInt8(NaN); });",
      // DataView: the SAME shape of bad offset silently truncates instead.
      "{ const dv = new DataView(new ArrayBuffer(8)); console.log(dv.getUint8(1.5)); }",
      "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint8(1.5, 9); console.log(dv.getUint8(1)); }",
      "{ const dv = new DataView(new ArrayBuffer(8)); console.log(dv.getUint8(NaN)); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const expected = [
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.readUInt8(1.5);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.writeUInt8(1, 1.5);
    }),
    caughtJs(() => {
      const b = Buffer.alloc(8);
      b.readUInt8(NaN);
    }),
    (() => new DataView(new ArrayBuffer(8)).getUint8(1.5))(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint8(1.5, 9);
      return dv.getUint8(1);
    })(),
    (() => new DataView(new ArrayBuffer(8)).getUint8(NaN))(),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.map(String).join("\n"));
  // The actual CLAIM this test exists to pin: Buffer's three cases must
  // all be "caught:...", DataView's three must all be "no throw"-shaped
  // (plain numeric output) — assert the CONTRAST directly, not just
  // byte-for-byte parity with Node (which would still pass even if BOTH
  // sides had accidentally started throwing, or both stopped).
  const lines = stdout.toString("utf8").trim().split("\n");
  expect(lines.slice(0, 3).every((l) => l.startsWith("caught:RangeError:"))).toBe(true);
  expect(lines.slice(3, 6).every((l) => !l.startsWith("caught:"))).toBe(true);
});

test("DataView: float get/set — passthrough, and the S036 NaN-provenance boundary (literal-folded canonical, crafted echo, runtime-computed hardware pattern) on both endiannesses", async () => {
  const hexDv = (varName: string, n: number): string => {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(`${varName}.getUint8(${i})`);
    return `console.log([${parts.join(", ")}].join(','));`;
  };
  const lines = [
    `{ const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, 1.5); console.log(dv.getFloat64(0)); }`,
    `{ const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, 1.5, true); console.log(dv.getFloat32(0, true)); }`,
    // literal-folded arithmetic NaN -> canonical, BE and LE
    `{ const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, 0 / 0); ${hexDv("dv", 8)} }`,
    `{ const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, 0 / 0); ${hexDv("dv", 4)} }`,
    `{ const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, 0 / 0, true); ${hexDv("dv", 8)} }`,
    `{ const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, 0 / 0, true); ${hexDv("dv", 4)} }`,
    // crafted/signaling NaN round trip -> bit-exact echo
    `{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, 0x7ff80000); dv.setUint32(4, 1); const v = dv.getFloat64(0); const dv2 = new DataView(new ArrayBuffer(8)); dv2.setFloat64(0, v); ${hexDv("dv2", 8)} }`,
    // genuinely runtime-computed NaN -> hardware pattern, BE and LE, both widths
    `{ const arr: number[] = [0, 0]; const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, arr[0]! / arr[1]!); ${hexDv("dv", 8)} }`,
    `{ const arr: number[] = [0, 0]; const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, arr[0]! / arr[1]!, true); ${hexDv("dv", 8)} }`,
    `{ const arr: number[] = [0, 0]; const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, arr[0]! / arr[1]!); ${hexDv("dv", 4)} }`,
    `{ const arr: number[] = [0, 0]; const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, arr[0]! / arr[1]!, true); ${hexDv("dv", 4)} }`,
    "",
  ].join("\n");
  const res = await buildWasm("dataview-float-nan.ts", lines);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const dvBytes = (dv: DataView): string => {
    const parts: number[] = [];
    for (let i = 0; i < dv.byteLength; i++) parts.push(dv.getUint8(i));
    return parts.join(",");
  };
  const expected = [
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, 1.5);
      return dv.getFloat64(0);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, 1.5, true);
      return dv.getFloat32(0, true);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, 0 / 0);
      return dvBytes(dv);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, 0 / 0);
      return dvBytes(dv);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, 0 / 0, true);
      return dvBytes(dv);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, 0 / 0, true);
      return dvBytes(dv);
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 0x7ff80000);
      dv.setUint32(4, 1);
      const v = dv.getFloat64(0);
      const dv2 = new DataView(new ArrayBuffer(8));
      dv2.setFloat64(0, v);
      return dvBytes(dv2);
    })(),
    (() => {
      const arr: number[] = [0, 0];
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, arr[0]! / arr[1]!);
      return dvBytes(dv);
    })(),
    (() => {
      const arr: number[] = [0, 0];
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, arr[0]! / arr[1]!, true);
      return dvBytes(dv);
    })(),
    (() => {
      const arr: number[] = [0, 0];
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, arr[0]! / arr[1]!);
      return dvBytes(dv);
    })(),
    (() => {
      const arr: number[] = [0, 0];
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, arr[0]! / arr[1]!, true);
      return dvBytes(dv);
    })(),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.map(String).join("\n"));
});

test("DataView: getBigUint64/getBigInt64 composed as Number(...) — round-to-nearest-even bigint-to-double conversion", async () => {
  const res = await buildWasm(
    "dataview-big-as-number.ts",
    [
      "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, 0); dv.setUint32(4, 1); console.log(Number(dv.getBigUint64(0))); }",
      "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, 0xFFFFFFFF); dv.setUint32(4, 0xFFFFFFFF); console.log(Number(dv.getBigUint64(0))); }",
      "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, 0xFFFFFFFF); dv.setUint32(4, 0xFFFFFFFF); console.log(Number(dv.getBigInt64(0))); }",
      "{ const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, 1); dv.setUint32(4, 0); console.log(Number(dv.getBigUint64(0, true))); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const expected = [
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 0);
      dv.setUint32(4, 1);
      return Number(dv.getBigUint64(0));
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 0xffffffff);
      dv.setUint32(4, 0xffffffff);
      return Number(dv.getBigUint64(0));
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 0xffffffff);
      dv.setUint32(4, 0xffffffff);
      return Number(dv.getBigInt64(0));
    })(),
    (() => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, 1);
      dv.setUint32(4, 0);
      return Number(dv.getBigUint64(0, true));
    })(),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.map(String).join("\n"));
});

test("DataView: aliasing over a Uint32Array's storage — write through the view, read through the element access, and back (the byte-granular $bytes representation gives this for free)", async () => {
  const res = await buildWasm(
    "dataview-aliasing.ts",
    [
      "{ const u32 = new Uint32Array(2); const dv = new DataView(u32.buffer); dv.setUint32(0, 0x11223344); console.log(u32[0]); }",
      "{ const u32 = new Uint32Array(2); u32[0] = 0x11223344; const dv = new DataView(u32.buffer); console.log(dv.getUint32(0)); }",
      "{ const u32 = new Uint32Array(2); const dv = new DataView(u32.buffer); dv.setUint32(4, 0xAABBCCDD); console.log(u32[1]); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const expected = [
    (() => {
      const u32 = new Uint32Array(2);
      const dv = new DataView(u32.buffer);
      dv.setUint32(0, 0x11223344);
      return u32[0];
    })(),
    (() => {
      const u32 = new Uint32Array(2);
      u32[0] = 0x11223344;
      const dv = new DataView(u32.buffer);
      return dv.getUint32(0);
    })(),
    (() => {
      const u32 = new Uint32Array(2);
      const dv = new DataView(u32.buffer);
      dv.setUint32(4, 0xaabbccdd);
      return u32[1];
    })(),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.map(String).join("\n"));
});

test("DataView: a view constructed over ANOTHER view's .buffer rebases against the ROOT buffer, not the parent view's own window — the corpus 1407 regression (two bugs: bounds capacity via receiver.BLEN instead of the shared storage array's real length, and double-counting receiver.OFF into the new offset)", async () => {
  const res = await buildWasm(
    "dataview-rebase.ts",
    [
      "const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);",
      "const v = new DataView(buf.buffer, 2, 5);", // window: bytes[2..7), i.e. values 3..7
      "const inner = new DataView(v.buffer, 6, 2);", // offset 6 is ROOT-relative -> bytes[6..8) = values 7,8
      "console.log(inner.byteOffset + ':' + inner.byteLength + ':' + inner.getUint8(0) + ':' + inner.getUint16(0));",
      "const caught = (fn: () => void): void => {",
      "  try { fn(); console.log('no throw'); }",
      "  catch (e) { const err = e as Error; console.log('caught:' + err.name + ':' + err.message); }",
      "};",
      // offset 6 + length 3 = 9, past the ROOT's 8 bytes (not past v's own
      // window end at root-offset 7, which a receiver.BLEN-based bounds
      // check would have wrongly allowed through as if it fit).
      "caught(() => { new DataView(v.buffer, 6, 3); });",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);

  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const v = new DataView(buf.buffer, 2, 5);
  const inner = new DataView(v.buffer, 6, 2);
  const caughtJs = (fn: () => unknown): string => {
    try {
      fn();
      return "no throw";
    } catch (e) {
      const err = e as Error;
      return `caught:${err.name}:${err.message}`;
    }
  };
  const expected = [
    `${inner.byteOffset}:${inner.byteLength}:${inner.getUint8(0)}:${inner.getUint16(0)}`,
    caughtJs(() => new DataView(v.buffer, 6, 3)),
    "",
  ];
  expect(stdout.toString("utf8")).toBe(expected.join("\n"));
});

/* ── increment 18 stage C: dyn↔bytes crossing (SEMANTICS.md S014's bytes
 * amendment) ──────────────────────────────────────────────────────────── */

test("S014 bytes amendment: crossing `unknown` ALIASES a Uint8Array — write-after-crossing observed on BOTH sides, and identity survives two independent extractions", async () => {
  // Node's own answers (measured, node -e): every line here is the SAME
  // object reference under the erased `unknown`/`as` boundary, so a write
  // through either side is visible through the other, and extracting
  // twice from the same crossed value gives back the same object both to
  // itself and to the original. The dyn tree models this by boxing the
  // SAME `$bytes` struct ref at `dynFrom` and handing back that SAME ref
  // at extraction (dynCheck) — never a copy — which is the S014
  // amendment this file's header comment documents. `u === u2` is the
  // pointed test: `unknown === unknown` is the one strict-equality shape
  // a checked `.ts` program can form over composite dyn values (the
  // frontend's dynScalarEq lowering), and it forces both sides through
  // dyn.strictEq's dedicated BYTES arm (comparing the payload ref via
  // ref.eq, not the `$dyn` box, which is a fresh box each crossing and
  // would wrongly compare unequal without that arm).
  const res = await buildWasm(
    "dyn-bytes-alias.ts",
    [
      "function toU(b: Uint8Array): unknown { return b; }",
      "function fromU(u: unknown): Uint8Array { return u as Uint8Array; }",
      "const src = new Uint8Array([1, 2, 3]);",
      "const u = toU(src);",
      "src[0] = 99;", // mutate the ORIGINAL after crossing
      "const out = fromU(u);",
      "console.log(out[0]);", // sees the post-crossing mutation: aliased
      "out[1] = 77;", // mutate the EXTRACTED value
      "console.log(src[1]);", // the original sees it too: aliased back
      "const back = fromU(u);",
      "console.log(out === back);",
      "const u2 = toU(back);",
      "console.log(u === u2);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(["99", "77", "true", "true", ""].join("\n"));
});

test("dyn↔bytes crossing: a non-u8 typed array refuses loudly, not a silent miscompile or a compiler crash", async () => {
  // The frontend's dynConvertible gate fences this BEFORE it ever reaches
  // the wasm backend's own (redundant, defense-in-depth) `dynFrom:bytes:
  // u32`-style refusal — measured directly: SC1101 fires at lowering
  // time, on every backend, not just wasm. The LLVM lane's generic
  // crossing site (dyn.ts:365/582/1023 there) has a matching compiler-
  // internal `throw` for the same non-u8 case, but it is unreachable
  // from any real program for the identical reason — the frontend never
  // lowers a non-u8 typed array INTO a dynFrom node in the first place.
  // Either way: a named, loud refusal, never a crash or a wrong answer.
  const res = await buildWasm(
    "dyn-bytes-nonu8.ts",
    ["function toU(b: Uint32Array): unknown { return b; }", "console.log(toU(new Uint32Array([1])));", ""].join(
      "\n",
    ),
  );
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected a refusal");
  expect(res.diagnostics[0]?.code).toBe("SC1101");
  expect(res.diagnostics[0]?.message).toBe("converting typed values to 'unknown' is not supported yet");
});

test("dyn↔bytes crossing: Object.hasOwn/keys/values/entries see numeric indices ONLY — never 'length' (measured: a typed array's own-key list has no length entry, unlike arrays and strings)", async () => {
  const res = await buildWasm(
    "dyn-bytes-keys.js",
    [
      "'use strict';",
      "function toU(b) { return b; }",
      "function b(x) { return x ? 'T' : 'F'; }",
      "const u = toU(new Uint8Array([10, 20, 30]));",
      "console.log(b(Object.hasOwn(u, '0')) + b(Object.hasOwn(u, '3')) + b(Object.hasOwn(u, 'length')));",
      "console.log(Object.keys(u).join(','));",
      "console.log(Object.values(u).join(','));",
      "console.log(JSON.stringify(Object.entries(u)));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["TFF", "0,1,2", "10,20,30", '[["0",10],["1",20],["2",30]]', ""].join("\n"),
  );
});

test("dyn↔bytes crossing: keyed write through `unknown` — in-range numeric writes THROUGH to the shared storage, OOB numeric is a SILENT no-op (matches Node: typed arrays are fixed-length, unlike arrays which grow), a non-numeric key throws (S016's array precedent — no property table on this payload either)", async () => {
  const res = await buildWasm(
    "dyn-bytes-keyset.js",
    [
      "'use strict';",
      "function toU(b) { return b; }",
      "const src = new Uint8Array([1, 2, 3]);",
      "const u = toU(src);",
      "u[1] = 55;",
      "console.log(src[1]);", // in-range: writes through
      "u[10] = 99;", // OOB numeric: Node silently no-ops (fixed length)
      "console.log(src.length + ' ' + String(u[10]));",
      "try { u.nope = 1; console.log('no throw'); } catch (e) { console.log(/** @type {Error} */ (e).message); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["55", "3 undefined", "Cannot create property 'nope' on Uint8Array", ""].join("\n"),
  );
});

test("dyn↔bytes crossing: JSON.stringify — a plain Uint8Array serializes as its own enumerable numeric keys, matching Object.keys exactly", async () => {
  // Buffer's `{"type":"Buffer","data":[...]}` form is currently
  // unreachable through the generic crossing path (SEMANTICS.md S037:
  // the isBuffer flag is pinned false there), so only this half is
  // reachable from a compiled program today; putDyn's Buffer branch is
  // exercised structurally by WebAssembly.validate() on every build that
  // reaches this function, not by an observable program. A dyn-rooted
  // stringify (a bare `unknown` root, or a `Record<string, unknown>`
  // member — corpus 916's own shape) is what actually reaches putDyn's
  // runtime walker; an object LITERAL with a concrete `unknown`-typed
  // property is a DIFFERENT, statically-typed stringify path this test
  // is not aimed at.
  const res = await buildWasm(
    "dyn-bytes-json.ts",
    [
      "function toU(b: Uint8Array): unknown { return b; }",
      "const u = toU(new Uint8Array([1, 2, 3]));",
      "console.log(JSON.stringify(u));",
      "const scratch: Record<string, unknown> = {};",
      "scratch.buf = toU(new Uint8Array([1, 2, 3]));",
      "console.log(JSON.stringify(scratch));",
      "console.log(JSON.stringify(toU(new Uint8Array(0))));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(['{"0":1,"1":2,"2":3}', '{"buf":{"0":1,"1":2,"2":3}}', "{}", ""].join("\n"));
});

test("SEMANTICS.md S037: a real Buffer crossing the generic `unknown` path prints the WRONG (Uint8Array-flavored) answer on String() and JSON.stringify — pinning OUR tier's actual behavior, NOT Node's (Node: String(ub) is 'hi', JSON.stringify(ub) is {\"type\":\"Buffer\",\"data\":[104,105]} — measured, and deliberately NOT what this asserts)", async () => {
  const res = await buildWasm(
    "dyn-bytes-buffer-flag-false.ts",
    [
      "function toU(b: Uint8Array): unknown { return b; }",
      "const ub = toU(Buffer.from('hi'));",
      "console.log(String(ub));",
      "console.log(JSON.stringify(ub));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  // OUR answer (S037): comma-joined elements, numeric-keyed JSON — the
  // Uint8Array flavor, because the flag is pinned false at this generic
  // crossing site. If this test ever starts asserting "hi" and
  // {"type":"Buffer",...} instead, board #25 landed and S037's "Tested
  // by" section needs updating to say so, not silent deletion.
  expect(stdout.toString("utf8")).toBe(["104,105", '{"0":104,"1":105}', ""].join("\n"));
});

test("union: `Buffer | string`.toString() — the bytes arm decodes UTF-8 through the SAME per-union %w.u.toStr helper the scalar arms use (corpus 1566's own construct), including the empty-buffer and multi-byte-UTF-8 edges", async () => {
  const res = await buildWasm(
    "union-tostring-bytes.ts",
    [
      "function pick(n: number): Buffer | string {",
      "  return n > 0 ? Buffer.from([0xe2, 0x9c, 0x93]) : 'plain';",
      "}",
      "console.log(pick(1).toString());",
      "console.log(pick(0).toString());",
      "function pickEmpty(n: number): Buffer | string {",
      "  return n > 0 ? Buffer.alloc(0) : '';",
      "}",
      "console.log(JSON.stringify(pickEmpty(1).toString()));",
      "console.log(JSON.stringify(pickEmpty(0).toString()));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  // Buffer.from([0xe2,0x9c,0x93]) is the UTF-8 encoding of U+2713 (✓) —
  // the union arm's UTF-8 decode, not a comma-joined element list. A
  // plain (non-Buffer) Uint8Array arm would print "226,156,147" instead;
  // SEMANTICS.md S038 registers that this tier answers Buffer-flavored
  // UNCONDITIONALLY for every bytes union arm (matching the pre-existing
  // C/LLVM stance), so that case is deliberately NOT asserted here.
  //
  // Note: `String(x)`/template-literal ToString on this SAME union type
  // is a DIFFERENT frontend gate (ensureString's own `stringable` list,
  // lower-exprs.ts) that does not admit bytes arms at all yet — a
  // pre-existing, separate refusal (SC1090) untouched by this round; only
  // the explicit `.toString()` method call (lowerUnionToStringCall) is in
  // scope here, matching corpus 1566's own spelling.
  expect(stdout.toString("utf8")).toBe(["✓", "plain", '""', '""', ""].join("\n"));
});

/* ── Increment 19 stage A3: genResume's next/return/throw state ladder ──
 * The differential census is the real behavioral bar (six corpus programs
 * — 2010/2015/2016/2017/2018/2457 — now byte-diff clean against Node
 * through the FULL for-of, yield-star, and async-composition surface;
 * separately, 2013 confirms the shared hoister entry — see A3-2). No
 * corpus program calls `.throw()` outside a finally-gated one (stage B),
 * so its census effect is nil today — these tests carry the weight for
 * it, pinning ladder corners no corpus program happens to exercise:
 * reentrancy (a generator resuming ITSELF mid-body, all three modes now
 * that all three are built), `.return()`'s exact-value round-trip on
 * UNSTARTED/DONE (never a stale `$gen.out`), and `.throw()`'s own four
 * corners (UNSTARTED, DONE, SUSPENDED-caught, SUSPENDED-uncaught).
 * Expected strings are Node-measured directly (`node
 * --experimental-transform-types`) against the identical source below —
 * see inc19-probes/probe-a3-reentrancy.ts, probe-a3-return-fastpath.ts,
 * and probe-a3-3-throw.ts. */
test("genResume (A3): reentrancy throws Node's exact TypeError, all three modes", async () => {
  // `self` stays a bare (never-null) Generator binding — a `Generator |
  // null` union has no compiled home yet (a real, separate, pre-existing
  // gap: union arms don't support generator types), unrelated to A3
  // itself, so the probe source is shaped to avoid it entirely. Same
  // reason for `instanceof TypeError` + `.name`/`.message` over
  // `.constructor.name`: `Function.name` (a caught error's own
  // constructor) has no scriptc lowering yet — this file's established
  // idiom elsewhere (e.g. the S018 test above) for the identical reason.
  const res = await buildWasm(
    "gen-reentrancy.ts",
    [
      "let self: Generator<number, string, unknown>;",
      "function* g(): Generator<number, string, unknown> {",
      "  try {",
      "    self.next();",
      "  } catch (e) {",
      '    if (e instanceof TypeError) console.log("reentrant-next", e.name + ": " + e.message);',
      '    else console.log("reentrant-next wrong-kind");',
      "  }",
      "  try {",
      '    self.return("R" as never);',
      "  } catch (e) {",
      '    if (e instanceof TypeError) console.log("reentrant-return", e.name + ": " + e.message);',
      '    else console.log("reentrant-return wrong-kind");',
      "  }",
      "  try {",
      '    self.throw(new Error("x"));',
      "  } catch (e) {",
      '    if (e instanceof TypeError) console.log("reentrant-throw", e.name + ": " + e.message);',
      '    else console.log("reentrant-throw wrong-kind");',
      "  }",
      "  yield 1;",
      '  return "done";',
      "}",
      "self = g();",
      "self.next();",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "reentrant-next TypeError: Generator is already running",
      "reentrant-return TypeError: Generator is already running",
      "reentrant-throw TypeError: Generator is already running",
      "",
    ].join("\n"),
  );
});

test("genResume (A3): .return()'s value round-trips verbatim on UNSTARTED and DONE, never a stale $gen.out", async () => {
  const res = await buildWasm(
    "gen-return-fastpath.ts",
    [
      "function* g(): Generator<number, string, unknown> {",
      "  yield 1;",
      '  return "ret";',
      "}",
      "const a = g();",
      'const r1 = a.return("R" as never);',
      "console.log(r1.done, r1.value);",
      "const r2 = a.next();",
      "console.log(r2.done, r2.value);",
      "",
      "const b = g();",
      "b.next();",
      "b.next();",
      'const r3 = b.return("R2" as never);',
      "console.log(r3.done, r3.value);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  // r1: UNSTARTED, .return("R") answers {value:"R",done:true} verbatim.
  // r2: the NEXT .next() call stays DONE, value undefined — never re-reads
  // r1's "R" (there is no `out` write on the UNSTARTED/DONE fast path).
  // r3: DONE (after two .next() calls drained the one yield and the
  // return), .return("R2") answers the NEW argument, not the "ret" the
  // body itself returned.
  expect(stdout.toString("utf8")).toBe(["true R", "true undefined", "true R2", ""].join("\n"));
});

test("genResume (A3): .throw() on UNSTARTED and DONE rethrows verbatim at the call site, body never entered, marks/keeps DONE", async () => {
  const res = await buildWasm(
    "gen-throw-fastpath.ts",
    [
      "function show(label: string, f: () => unknown): void {",
      "  try {",
      "    console.log(label, JSON.stringify(f()));",
      "  } catch (e) {",
      '    if (e instanceof Error) console.log(label, "THREW", e.name + ": " + e.message);',
      '    else console.log(label, "THREW wrong-kind");',
      "  }",
      "}",
      "function* g(): Generator<number, string, unknown> {",
      '  console.log("body-entered (SHOULD NOT PRINT)");',
      "  yield 1;",
      '  return "ret";',
      "}",
      "const it = g();",
      'show("unstarted-throw", () => it.throw(new Error("boom")));',
      'show("unstarted-after", () => it.next());',
      "",
      "function* g2(): Generator<number, string, unknown> {",
      "  yield 1;",
      '  return "ret";',
      "}",
      "const it2 = g2();",
      "it2.next();",
      "it2.next(); // DONE",
      'show("done-throw", () => it2.throw(new Error("post-done")));',
      'show("done-after", () => it2.next());',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  // Node-measured (probe-a3-3-throw.ts): body-entered never prints, the
  // exact Error rethrows at the call site both times, and .next()
  // afterward reports done:true in both cases (the DONE case is
  // idempotent — .throw() on an already-DONE generator just rethrows,
  // it does not "fail" or leave the generator in some other state).
  expect(stdout.toString("utf8")).toBe(
    [
      "unstarted-throw THREW Error: boom",
      "unstarted-after {\"done\":true}",
      "done-throw THREW Error: post-done",
      "done-after {\"done\":true}",
      "",
    ].join("\n"),
  );
});

test("genResume (A3): .throw() on SUSPENDED — the body's own catch takes it and continues, or an uncaught injection propagates and marks DONE", async () => {
  const res = await buildWasm(
    "gen-throw-suspended.ts",
    [
      "function show(label: string, f: () => unknown): void {",
      "  try {",
      "    console.log(label, JSON.stringify(f()));",
      "  } catch (e) {",
      '    if (e instanceof Error) console.log(label, "THREW", e.name + ": " + e.message);',
      '    else console.log(label, "THREW wrong-kind");',
      "  }",
      "}",
      "function* g(): Generator<string, string, unknown> {",
      "  try {",
      '    yield "body";',
      "  } catch (e) {",
      '    const caught = yield "caught:" + (e as Error).message;',
      '    console.log("sent-after-catch", JSON.stringify(caught));',
      "  }",
      '  return "normal-end";',
      "}",
      "const it = g();",
      'show("caught-next", () => it.next());',
      'show("caught-throw", () => it.throw(new Error("inj")));',
      'show("caught-resume", () => it.next("SENT"));',
      "",
      "function* g2(): Generator<number, string, unknown> {",
      "  yield 1;",
      '  return "normal-end";',
      "}",
      "const it2 = g2();",
      'show("uncaught-next", () => it2.next());',
      'show("uncaught-throw", () => it2.throw(new Error("uncaught-boom")));',
      'show("uncaught-after", () => it2.next());',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  // Node-measured (probe-a3-3-throw.ts). The injected error's message
  // ("inj") reaches the body's own `catch (e)` as the REAL error, not a
  // GENRET-shaped wrapper (emitThrowValue writes a real EXC_* kind) — the
  // body resumes past the catch and yields again. The second generator's
  // injection has no surrounding try/catch, so it propagates straight
  // through .throw()'s own call site (the SAME emitPendingCheck every
  // other may-throw call site already gets) and marks the generator DONE.
  expect(stdout.toString("utf8")).toBe(
    [
      'caught-next {"value":"body","done":false}',
      'caught-throw {"value":"caught:inj","done":false}',
      'sent-after-catch "SENT"',
      'caught-resume {"value":"normal-end","done":true}',
      'uncaught-next {"value":1,"done":false}',
      "uncaught-throw THREW Error: uncaught-boom",
      'uncaught-after {"done":true}',
      "",
    ].join("\n"),
  );
});

/* ── Increment 19 stage B: finalizer linearization ──
 * A suspension — or a return/uncaught-throw/GENRET crossing — inside a
 * try/catch/finally now linearizes (statemachine.ts's TRY/CATCH section,
 * "STAGE B ADDITION"). The differential census (2011/2012/2014, plus the
 * async stretch rider 1022) is the real behavioral bar; this test pins a
 * corner no corpus program happens to exercise: the reviewer's own
 * pre-read probe (probe-stageB-prereview.mjs) for the full injection-
 * over-park 2x2 (all four cells Node-measured "newest wins" — the same
 * corpus/probe pins genuine return-over-return, probe-gen-ladder.ts's
 * corner #6).
 *
 * The ONE constructible stale-park shape the pre-read flagged — a
 * source-level `return` parking RETURN in a finally that itself
 * suspends, then a CONSUMER `.throw()` injection at that suspend point —
 * is pinned in wasm-statemachine.test.ts's "stage B: parkThrow write
 * discipline (full-source regressions)" describe block, NOT here. A
 * single, non-nested finally (the shape this file used to carry under
 * that name) never actually reaches parkThrow at all — with nothing
 * enclosing it, the injected throw hits catchArm()'s TRUE default
 * directly, so a test built on that shape and labeled "write-discipline
 * pin" was never exercising write discipline; it was exercising the
 * default path under a false name, and it is exactly the artifact that
 * misled two reviewers into believing the mechanism was covered when it
 * was not. The correctly-labeled control for that same non-nested shape,
 * and the real nested pin that does reach parkThrow, both live in
 * wasm-statemachine.test.ts now (full-source `compile()`-based, with the
 * explicit no-trap assertion and the mutation-checked nested THROW
 * regression this shape's own history — a crash, then a silent
 * miscompile — showed a crash-only or stdout-only pin cannot catch).
 * Deleted here rather than relabeled in place: duplicate coverage under
 * a stale name in the wrong file serves nobody. */
test("stage B: the injection-over-park 2x2, all four cells (reviewer pre-read, probe-stageB-prereview.mjs — genuine return-over-return is probe-gen-ladder.ts's corner #6, not this probe's mislabeled same-named line, which only performs the first return)", async () => {
  const res = await buildWasm(
    "gen-stageb-injectionmatrix.ts",
    [
      "function show(label: string, f: () => unknown): void {",
      "  try {",
      "    console.log(label, JSON.stringify(f()));",
      "  } catch (e) {",
      '    if (e instanceof Error) console.log(label, "THREW", e.name + ": " + e.message);',
      '    else console.log(label, "THREW wrong-kind");',
      "  }",
      "}",
      "function make(): Generator<string, string, unknown> {",
      "  function* g(): Generator<string, string, unknown> {",
      "    try {",
      '      yield "body";',
      "    } finally {",
      '      yield "fin";',
      "    }",
      '    return "normal-end";',
      "  }",
      "  return g();",
      "}",
      "{",
      "  const it = make();",
      "  it.next();",
      '  it.return("A"); // parks A, finalizer yields "fin" — corner #6\'s own first return',
      '  show("return-over-return", () => it.return("B"));',
      "}",
      "{",
      "  const it = make();",
      "  it.next();",
      '  it.return("A");',
      '  show("throw-over-return", () => it.throw(new Error("T")));',
      "}",
      "{",
      "  const it = make();",
      "  it.next();",
      '  it.throw(new Error("P"));',
      '  show("return-over-throw", () => it.return("R"));',
      "}",
      "{",
      "  const it = make();",
      "  it.next();",
      '  it.throw(new Error("P1"));',
      '  show("throw-over-throw", () => it.throw(new Error("T2")));',
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  // Node-measured (probe-stageB-prereview.mjs's A/B/C/D lines): every
  // cell is "the newest injection wins" — return-over-return completes
  // with the SECOND value, throw-over-return propagates the throw
  // (discarding the parked return), return-over-throw completes with the
  // return's value (discarding the parked throw), throw-over-throw
  // propagates the SECOND throw.
  expect(stdout.toString("utf8")).toBe(
    [
      'return-over-return {"value":"B","done":true}',
      "throw-over-return THREW Error: T",
      'return-over-throw {"value":"R","done":true}',
      "throw-over-throw THREW Error: T2",
      "",
    ].join("\n"),
  );
});

test("insp.buffer: the STATIC-typed-Buffer path (console.log of a real, non-dyn Buffer) — the 49/50/51/52 INSPECT_MAX_BYTES truncation seam pinned directly against Node (corpus 1635 covers 50/51/52/200 differentially; this adds 49, one below the boundary, with all four side by side), plus an explicit cross-check that this NEW call site's `bufferForm()` reuse is byte-identical to the dyn walker's EXISTING isBuffer=true consumer (wasm-bytes-flag.test.ts's own '<Buffer 01 02 03>' assertion for the SAME [1,2,3] content) — not merely inferred across files", async () => {
  const { inspect } = await import("node:util");
  const bytesOf = (n: number): number[] => Array.from({ length: n }, (_, i) => (i * 7 + 1) % 251);
  const lengths = [49, 50, 51, 52];
  const res = await buildWasm(
    "insp-buffer-truncation.ts",
    [
      ...lengths.map((n) => `console.log(Buffer.from([${bytesOf(n).join(",")}]));`),
      "console.log(Buffer.from([1, 2, 3]));",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  const lines = stdout.toString("utf8").split("\n");
  // Node itself is the oracle for the expected strings (real Buffer + real
  // util.inspect) — no hand-rolled formatter, so a mistake in an
  // expectation here can't cancel a mistake in the emitter.
  lengths.forEach((n, i) => {
    expect(lines[i]).toBe(inspect(Buffer.from(bytesOf(n))));
  });
  // The cross-path consistency check: this NEW static insp.buffer call
  // site's output for [1,2,3] must be byte-identical to the dyn walker's
  // EXISTING isBuffer=true consumer's own assertion for the same content
  // (wasm-bytes-flag.test.ts, "inspect.ts's dyn walker" test) — both call
  // the SAME `bufferForm()` (inspect.ts), so a divergence here would mean
  // a second, subtly different renderer crept in despite the reuse claim.
  expect(lines[4]).toBe("<Buffer 01 02 03>");
});

/* ── increment 21 stage A: the static island's representation ──────────
 * jsval ≡ dyn (mapType(jsval) is the SAME (ref null $dyn) mapType(dyn)
 * answers), dynFromJsval is identity, and the NO-COERCION jsOps route
 * through the existing dyn runtime. Every program below is verified
 * against the real Node oracle (dynamic --experimental-transform-types
 * runs, values transcribed by hand from that output — not guessed) or,
 * where no Node oracle exists (jsExit's boundary-failure texts — a
 * scriptc-only synthetic diagnostic, same footing as S009's dynCheck
 * messages), against the reference C backend's OWN output, matching
 * SEMANTICS.md's established convention for texts with no Node analog. */

test("increment 21 stage A: the mapType canary — closures capturing `any` (jsval) locals, mutation through the shared box visible from every closure over it (the 1122-any-captures.ts shape, reduced to the no-coercion op surface: the full corpus program also needs callMethod, out of stage A's scope)", async () => {
  const res = await buildWasmDyn(
    "captures-canary.ts",
    [
      'const obj: any = { n: 10, label: "L" };',
      "const captured: any = obj;",
      "const read = (): string => `${captured.label}:${captured.n}`;",
      "console.log(read());",
      "captured.n = 11;",
      "console.log(read());",
      "",
      "let mut: any = 1;",
      "const bump = (): string => {",
      "  mut = 2;",
      "  return `${mut}`;",
      "};",
      "console.log(bump());",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  // Node-verified (node --experimental-transform-types): mutating `n`
  // through the captured box is visible to every closure sharing it (the
  // capture box's own share-not-copy contract), and reassigning `mut`
  // inside `bump` demonstrates a bare scalar reassignment through
  // jsMarshal, not just construction.
  expect(stdout.toString("utf8")).toBe(["L:10", "L:11", "2", ""].join("\n"));
});

test("increment 21 stage A: dynFromJsval is IDENTITY — a jsval crossing to `unknown` TWICE from the same island local is === both times (no wrapping introduces distinctness; jsval ≡ dyn means both crossings push the SAME dyn ref)", async () => {
  const res = await buildWasmDyn(
    "dynfromjsval-identity.ts",
    [
      "function mint(): any {",
      '  return { tag: "hi" };',
      "}",
      "const island: any = mint();",
      "const a: unknown = island;",
      "const b: unknown = island;",
      "console.log(a === b);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("true\n"); // Node-verified
});

test("increment 21 stage A: the NO-COERCION jsOp surface — objLit/arrLit/getProp/setProp/getIdx/setIdx/typeof/toStr/truthy/undefLit/nullLit over island values, byte-exact against Node (node --experimental-transform-types, type-stripped run of the identical source)", async () => {
  const source = [
    'const o: any = { a: 1, b: "two", list: [10, 20, 30] };',
    "console.log(typeof o.a, typeof o.b, typeof o.list);",
    "console.log(`${o.a} ${o.b}`);",
    "console.log(`${o.list[0]} ${o.list[1]} ${o.list[2]}`);",
    "o.list[1] = 99;",
    "console.log(`${o.list[1]}`);",
    "o.c = true;",
    "console.log(`${o.c}`, typeof o.c);",
    'console.log(o ? "truthy-obj" : "falsy-obj");',
    "const zero: any = 0;",
    'console.log(zero ? "truthy-zero" : "falsy-zero");',
    'const arr: any = [1, "x", true];',
    "console.log(`${arr[0]} ${arr[1]} ${arr[2]}`);",
    "const nothing: any = undefined;",
    "const nul: any = null;",
    "console.log(typeof nothing, typeof nul);",
    "console.log(`${o.a}-${o.b}-${o.list[0]}`);",
    "",
  ].join("\n");
  const res = await buildWasmDyn("jsop-surface.ts", source);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  const { stdout } = await runWasm(res.binaryPath);
  // Node-verified transcription (node --experimental-transform-types on
  // this EXACT source): every line below is copied from that real run,
  // not hand-computed.
  expect(stdout.toString("utf8")).toBe(
    [
      "number string object",
      "1 two",
      "10 20 30",
      "99",
      "true boolean",
      "truthy-obj",
      "falsy-zero",
      "1 x true",
      "undefined object",
      "1-two-10",
      "",
    ].join("\n"),
  );
});

test("increment 21 stage A: jsOp:getProp through undefined throws Node's own catchable TypeError, message-exact (2580's own construct: a missing member reads undefined; a read THROUGH it throws)", async () => {
  const res = await buildWasmDyn(
    "getprop-through-undefined.ts",
    [
      "function mint(): any {",
      "  return { n: 5 };",
      "}",
      "const bag: any = mint();",
      "try {",
      "  console.log(`${bag.missing.x}`);",
      "} catch (e) {",
      '  console.log(`caught: ${e}`);',
      "}",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  // Node's own text (V8's TypeError for a property read through
  // undefined) — verified directly against node --experimental-
  // transform-types on this exact source.
  expect(stdout.toString("utf8")).toBe("caught: TypeError: Cannot read properties of undefined (reading 'x')\n");
});

test("increment 21 stage A: jsExit strict primitives — happy path reads the exact tag, a wrong-kind exit throws \"expected <want>, got <typeof>\" (scriptc-only synthetic diagnostic, ported verbatim from scr_island.c's isl_exit_fail — no Node oracle exists for this text since Node has no static/island boundary at all; verified against the reference C backend's OWN output on the identical source, matching SEMANTICS.md S009's convention for texts with no Node analog)", async () => {
  const source = [
    "function mint(): any {",
    '  return { n: "not-a-number" };',
    "}",
    "const src: any = mint();",
    "try {",
    "  const { n }: { n: number } = src;",
    "  console.log(n);",
    "} catch (e) {",
    '  console.log(`caught: ${e}`);',
    "}",
    'console.log("done");',
    "",
  ].join("\n");
  const wasm = await buildWasmDyn("jsexit-scalar-fail.ts", source);
  if (!wasm.ok) throw new Error(`refused: ${wasm.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(wasm.binaryPath);
  const c = await compile(join(scratch, "jsexit-scalar-fail.ts"), {
    outPath: join(scratch, "jsexit-scalar-fail.c.out"),
    outDir: scratch,
    dynamic: true,
    backend: "c",
  });
  if (!c.ok) throw new Error(`c reference refused: ${c.diagnostics[0]?.message}`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const cOut = await promisify(execFile)(c.binaryPath);
  expect(stdout.toString("utf8")).toBe(cOut.stdout);
  expect(stdout.toString("utf8")).toBe("caught: TypeError: expected number, got string\ndone\n");
});

test("increment 21 stage A: jsExit array<jsval> — the sanctioned `any[]` exit form, Array.isArray-gated, elements BY REFERENCE (the dyn ARR payload's own vector handed over directly, no copy: module.ts's STRUCTURAL type interning already makes array<jsval>'s wasm struct index identical to dyn's own ARR-payload vector struct, whether or not vecKeyFor's jsval arm exists — that arm's real effect is sharing ONE helper-function family between array<jsval> and array<dyn>, a cache-dedup, not a type-compatibility requirement); a non-array exit throws \"expected an array, got <typeof>\", verified against the reference C backend the same way as the scalar case above", async () => {
  const source = [
    "function mintArr(): any {",
    "  return [1, 2, 3];",
    "}",
    "function takeArr(p: any[]): string {",
    "  return `${p[0]} ${p[1]} ${p[2]} ${p.length}`;",
    "}",
    "const held: any = mintArr();",
    "console.log(takeArr(held));",
    "",
    "function mintNotArr(): any {",
    "  return 5;",
    "}",
    "try {",
    "  const bad: any = mintNotArr();",
    "  console.log(takeArr(bad));",
    "} catch (e) {",
    '  console.log(`caught: ${e}`);',
    "}",
    'console.log("done");',
    "",
  ].join("\n");
  const wasm = await buildWasmDyn("jsexit-array.ts", source);
  if (!wasm.ok) throw new Error(`refused: ${wasm.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(wasm.binaryPath);
  const c = await compile(join(scratch, "jsexit-array.ts"), {
    outPath: join(scratch, "jsexit-array.c.out"),
    outDir: scratch,
    dynamic: true,
    backend: "c",
  });
  if (!c.ok) throw new Error(`c reference refused: ${c.diagnostics[0]?.message}`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const cOut = await promisify(execFile)(c.binaryPath);
  expect(stdout.toString("utf8")).toBe(cOut.stdout);
  expect(stdout.toString("utf8")).toBe(
    ["1 2 3 3", "caught: TypeError: expected an array, got number", "done", ""].join("\n"),
  );
});

test("increment 21 stage A: insp.jsval — console.log of a composite holding jsval elements (`any[]`, the sanctioned corpus form) renders through the SAME dyn walker plain unknown values use, byte-exact against Node's util.inspect-flavored console.log", async () => {
  const res = await buildWasmDyn("insp-jsval-array.ts", "const arr: any[] = [1, 'hi', true];\nconsole.log(arr);\n");
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("[ 1, 'hi', true ]\n"); // Node-verified
});

test("increment 21 stage B gate 1: jsOp add (a coercion op) is now IMPLEMENTED — supersedes the stage-A pin that this refused NAMED under \"expr:jsOp\"; numeric `any + any` now compiles and answers Node's own sum", async () => {
  const res = await buildWasmDyn(
    "jsop-add-works.ts",
    ["const a: any = 1;", "const b: any = 2;", "const c: any = a + b;", "console.log(`${c}`);", ""].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("3\n");
});


test("increment 21 stage A: getProp's Number.prototype PLACEHOLDER six — export-destructured off a number literal, every name answers a real function (not the round-1 miss's silent undefined for toPrecision/toExponential/valueOf/toLocaleString); these six alone get placeholders, everything else in reach fences (see the fence-table tests below) rather than answering wrong", async () => {
  const res = await buildWasmDyn(
    "num-proto-surface.ts",
    [
      "export let { toString } = 1;",
      "export const { toFixed } = 2.5;",
      "export const { toExponential } = 3;",
      "export const { toPrecision } = 4;",
      "export const { valueOf } = 5;",
      "console.log(`${typeof toString} ${typeof toFixed} ${typeof toExponential} ${typeof toPrecision} ${typeof valueOf}`);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("function function function function function\n"); // Node-verified
});

test("increment 21 stage A gate fix F1: unmodeled prototype-member getProp reads fence LOUDLY (a plain, catchable Error — S023's own text family, never a TypeError, never silent undefined) — per-kind fence text over NUM/BOOL/STR/ARR, plus Object.prototype's own members on a NUM receiver outside its placeholder six (round-1's own gap: `typeof n.hasOwnProperty` silently answered undefined, Node answers a function)", async () => {
  const res = await buildWasmDyn(
    "getprop-fence-per-kind.ts",
    [
      "const n: any = 5;",
      "try { console.log(typeof n.hasOwnProperty); } catch (e) { console.log(`caught-num: ${e}`); }",
      "const b: any = true;",
      "try { console.log(typeof b.toString); } catch (e) { console.log(`caught-bool: ${e}`); }",
      'const s: any = "hi";',
      "try { console.log(typeof s.charAt); } catch (e) { console.log(`caught-str: ${e}`); }",
      "const arr: any = [1, 2, 3];",
      "try { console.log(typeof arr.push); } catch (e) { console.log(`caught-arr: ${e}`); }",
      'console.log("done");',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  // No Node oracle for these texts (an unmodeled-member fence is a
  // scriptc-only synthetic diagnostic — the construct itself compiles
  // and runs fine in Node, since Node HAS these methods; this tier
  // simply does not implement the method BODIES yet, S023's own
  // "TODO marker, not a stance" framing). The plain-Error mechanism and
  // text FAMILY are what's pinned, matching S023 exactly.
  expect(stdout.toString("utf8")).toBe(
    [
      "caught-num: Error: 'Object.prototype.hasOwnProperty' on an island value is not supported yet",
      "caught-bool: Error: 'Boolean.prototype.toString' on an island value is not supported yet",
      "caught-str: Error: 'String.prototype.charAt' on an island value is not supported yet",
      "caught-arr: Error: 'Array.prototype.push' on an island value is not supported yet",
      "done",
      "",
    ].join("\n"),
  );
});

test("increment 21 stage A gate fix F1: OWN property shadows the prototype fence on an OBJ receiver (Node-measured: `({toString: 5}).toString` is `5`, not a function — an own field of the SAME NAME as a fenced prototype member must win, never fence); a genuinely absent Object.prototype-named member on an empty object still fences", async () => {
  const res = await buildWasmDyn(
    "getprop-own-shadow.ts",
    [
      "const o: any = { toString: 5 };",
      "console.log(typeof o.toString, `${o.toString}`);",
      "const empty: any = {};",
      "try { console.log(typeof empty.hasOwnProperty); } catch (e) { console.log(`caught: ${e}`); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    ["number 5", "caught: Error: 'Object.prototype.hasOwnProperty' on an island value is not supported yet", ""].join(
      "\n",
    ),
  );
});

test("increment 21 stage A gate fix F2: native-method placeholder IDENTITY — ONE interned dyn FUNC per NAME, not per call site (Node-measured, reviewer's zz6a/zz6b/zz6c): different names never ===, the SAME name off DIFFERENT receivers always === (Number.prototype.toString IS one function object), and a placeholder never === a real closure", async () => {
  const diffName = await buildWasmDyn(
    "placeholder-diff-name.ts",
    [
      "const v: any = 5;",
      "const w: any = 6;",
      "const a: unknown = v.toString;",
      "const b: unknown = w.toFixed;",
      "console.log(a === b);",
      "const c: unknown = w.toString;",
      "console.log(a === c);",
      "",
    ].join("\n"),
  );
  if (!diffName.ok) throw new Error(`refused: ${diffName.diagnostics[0]?.message}`);
  const r1 = await runWasm(diffName.binaryPath);
  expect(r1.stdout.toString("utf8")).toBe("false\ntrue\n"); // Node-verified (zz6b)

  const vsReal = await buildWasmDyn(
    "placeholder-vs-real.ts",
    [
      "const f = (): number => 1;",
      "const v: any = 5;",
      "const u1: unknown = f;",
      "const u3: unknown = v.toString;",
      "console.log(u1 === u3);",
      "",
    ].join("\n"),
  );
  if (!vsReal.ok) throw new Error(`refused: ${vsReal.diagnostics[0]?.message}`);
  const r2 = await runWasm(vsReal.binaryPath);
  expect(r2.stdout.toString("utf8")).toBe("false\n"); // Node-verified (zz6c)
});

test("increment 21 stage A gate fix F3: island-array NON-INDEX keyed writes throw the S016 fence text, inherited unchanged through jsOp:setIdx's shared keySet() — but this is a NEW, wasm-lane-ONLY divergence, not an inherited one: a NEGATIVE or non-canonical-index string key is an ORDINARY property write in Node AND on the native lane (a REAL engine array under --dynamic, not a dyn tree — the C reference does NOT throw here, measured directly), so only the wasm lane inherits S016's dyn-array limitation (no expando map) by representing jsval as dyn; pinned so the lead's promised S016 island amendment registers the CORRECT (wasm-only) shape, not the S016 dyn-world shape verbatim", async () => {
  const source = [
    "const a: any = [1, 2, 3];",
    "try { a[-1] = 7; console.log('no-throw'); } catch (e) { console.log(`caught: ${e}`); }",
    'try { a["foo"] = 7; console.log("no-throw2"); } catch (e) { console.log(`caught2: ${e}`); }',
    "console.log(`${a.length}`);",
    "",
  ].join("\n");
  const wasm = await buildWasmDyn("setidx-nonindex-fence.ts", source);
  if (!wasm.ok) throw new Error(`refused: ${wasm.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(wasm.binaryPath);
  const c = await compile(join(scratch, "setidx-nonindex-fence.ts"), {
    outPath: join(scratch, "setidx-nonindex-fence.c.out"),
    outDir: scratch,
    dynamic: true,
    backend: "c",
  });
  if (!c.ok) throw new Error(`c reference refused: ${c.diagnostics[0]?.message}`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const cOut = await promisify(execFile)(c.binaryPath);
  // The native island is a REAL engine array (matches Node: ordinary
  // property write, no throw) — the wasm lane diverges from BOTH,
  // pinned explicitly so nothing later assumes they agree.
  expect(cOut.stdout).toBe("no-throw\nno-throw2\n3\n");
  expect(stdout.toString("utf8")).toBe(
    [
      "caught: TypeError: Cannot create property '-1' on array",
      "caught2: TypeError: Cannot create property 'foo' on array",
      "3",
      "",
    ].join("\n"),
  );
});

test("increment 21 stage A gate fix F4: jsExit array<jsval> SPINE aliasing — a write OR a push through the exited array is observed from the ORIGINAL jsval binding, byte-exact against Node (the whole dyn ARR vector hands over by reference, not just element identity); the reference C backend instead COPIES at the exit boundary and diverges from Node here — a per-lane split the wasm lane's aliasing avoids, registered separately", async () => {
  const writeSource = [
    "function mintArr(): any { return [1, 2, 3]; }",
    "function poke(p: any[]): void { p[0] = 99; }",
    "const held: any = mintArr();",
    "poke(held);",
    "console.log(`${held[0]} ${held[1]}`);",
    "",
  ].join("\n");
  const wasmWrite = await buildWasmDyn("arrexit-alias-write.ts", writeSource);
  if (!wasmWrite.ok) throw new Error(`refused: ${wasmWrite.diagnostics[0]?.message}`);
  const rWrite = await runWasm(wasmWrite.binaryPath);
  expect(rWrite.stdout.toString("utf8")).toBe("99 2\n"); // Node-verified
  const cWrite = await compile(join(scratch, "arrexit-alias-write.ts"), {
    outPath: join(scratch, "arrexit-alias-write.c.out"),
    outDir: scratch,
    dynamic: true,
    backend: "c",
  });
  if (!cWrite.ok) throw new Error(`c reference refused: ${cWrite.diagnostics[0]?.message}`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const cWriteOut = await promisify(execFile)(cWrite.binaryPath);
  // The registered per-lane split: C COPIES at the exit (the write is
  // invisible on the original), wasm ALIASES (Node-exact). Pinned
  // explicitly so nothing later "fixes" wasm to match C by accident.
  expect(cWriteOut.stdout).toBe("1 2\n");

  const growSource = [
    "function mintArr(): any { return [1, 2, 3]; }",
    "function grow(p: any[]): number { p.push(4); return p.length; }",
    "const held: any = mintArr();",
    "console.log(`${grow(held)} ${held.length}`);",
    "",
  ].join("\n");
  const wasmGrow = await buildWasmDyn("arrexit-alias-grow.ts", growSource);
  if (!wasmGrow.ok) throw new Error(`refused: ${wasmGrow.diagnostics[0]?.message}`);
  const rGrow = await runWasm(wasmGrow.binaryPath);
  expect(rGrow.stdout.toString("utf8")).toBe("4 4\n"); // Node-verified
  const cGrow = await compile(join(scratch, "arrexit-alias-grow.ts"), {
    outPath: join(scratch, "arrexit-alias-grow.c.out"),
    outDir: scratch,
    dynamic: true,
    backend: "c",
  });
  if (!cGrow.ok) throw new Error(`c reference refused: ${cGrow.diagnostics[0]?.message}`);
  const cGrowOut = await promisify(execFile)(cGrow.binaryPath);
  expect(cGrowOut.stdout).toBe("4 3\n"); // C copies: held.length stays stale
});

test("increment 21 stage A gate round 2 fix D1: Function.prototype members on a FUNC-kind jsval receiver fence as 'Function.prototype.<name>', not 'Object.prototype.<name>' — reachable through F2's OWN placeholders (a placeholder IS a real FUNC-kind jsval): `const f: any = v.toString; typeof f.call` used to silently answer undefined (no table had 'call' at all); apply/bind/call/toString are the closed Function.prototype own-member set (Node-measured, caller/arguments excluded as throwing accessors)", async () => {
  const res = await buildWasmDyn(
    "getprop-fence-func.ts",
    [
      "const v: any = 5;",
      "const f: unknown = v.toString;", // a FUNC-kind jsval placeholder, round-tripped through unknown only to hold it — read back below via a fresh jsval read
      "const g: any = v.toString;",
      "try { console.log(typeof g.call); } catch (e) { console.log(`caught-call: ${e}`); }",
      "try { console.log(typeof g.apply); } catch (e) { console.log(`caught-apply: ${e}`); }",
      "try { console.log(typeof g.bind); } catch (e) { console.log(`caught-bind: ${e}`); }",
      "try { console.log(typeof g.hasOwnProperty); } catch (e) { console.log(`caught-hasown: ${e}`); }",
      "console.log(typeof f);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  // No Node oracle for the fence texts themselves (Node HAS these
  // methods; this tier fences the unmodeled BODY, S023's own framing).
  // 'call'/'apply'/'bind' attribute Function.prototype; 'hasOwnProperty'
  // (present on Function.prototype's OWN chain via Object.prototype, not
  // Function.prototype itself) still correctly attributes Object.
  expect(stdout.toString("utf8")).toBe(
    [
      "caught-call: Error: 'Function.prototype.call' on an island value is not supported yet",
      "caught-apply: Error: 'Function.prototype.apply' on an island value is not supported yet",
      "caught-bind: Error: 'Function.prototype.bind' on an island value is not supported yet",
      "caught-hasown: Error: 'Object.prototype.hasOwnProperty' on an island value is not supported yet",
      "function",
      "",
    ].join("\n"),
  );
});

test("increment 21 stage A gate round 2 fix D2: the four annex-B accessor-definer names (__defineGetter__/__defineSetter__/__lookupGetter__/__lookupSetter__) are function-valued on EVERY kind's prototype chain (Node-measured, reviewer's g4 probe) and must fence like any other Object.prototype member, not silently answer undefined", async () => {
  const res = await buildWasmDyn(
    "getprop-fence-annexb.ts",
    [
      "const n: any = 5;",
      "try { console.log(typeof n.__defineGetter__); } catch (e) { console.log(`caught-num: ${e}`); }",
      "const arr: any = [1, 2];",
      "try { console.log(typeof arr.__lookupSetter__); } catch (e) { console.log(`caught-arr: ${e}`); }",
      "const o: any = {};",
      "try { console.log(typeof o.__defineSetter__); } catch (e) { console.log(`caught-obj: ${e}`); }",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    [
      "caught-num: Error: 'Object.prototype.__defineGetter__' on an island value is not supported yet",
      "caught-arr: Error: 'Object.prototype.__lookupSetter__' on an island value is not supported yet",
      "caught-obj: Error: 'Object.prototype.__defineSetter__' on an island value is not supported yet",
      "",
    ].join("\n"),
  );
});

test("increment 21 stage A gate round 2 fix D3: the NUM arm's fence attribution — a name Number.prototype does NOT itself carry (hasOwnProperty, only on Object.prototype) fences as 'Object.prototype.hasOwnProperty' on a NUM receiver, not 'Number.prototype.hasOwnProperty' (round 2's own catch: every sibling arm already spelled the generic-table name correctly, only NUM's copy-pasted the kind's own constructor name by mistake)", async () => {
  const res = await buildWasmDyn(
    "getprop-fence-num-attribution.ts",
    ["const n: any = 5;", "try { console.log(typeof n.hasOwnProperty); } catch (e) { console.log(`${e}`); }", ""].join(
      "\n",
    ),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("Error: 'Object.prototype.hasOwnProperty' on an island value is not supported yet\n");
});

test("increment 21 stage A gate round 2 fix D7: jsMarshal(dyn) aliasing — a dyn-typed value marshaled into an island (`any`) slot TWICE from the SAME `unknown` local, then both round-tripped back to `unknown` (dynFromJsval, identity), are === to each other — the S014 island amendment's dyn-operand identity arm, mirrored for the marshal-IN direction the way the existing dynFromJsval-identity test covers marshal-OUT. Also asserts the reference C backend's OWN value (round 3 note 1): the native lane deep-COPIES at this same boundary (S014's DEFAULT rule, not the wasm-only exception), so C answers `false` where wasm/Node answer `true` — pinned explicitly so a later 'fix' can never silently align wasm to C's copy instead of Node's identity", async () => {
  const source = [
    'const u: unknown = JSON.parse(\'{"a":1}\');',
    "const a: any = u;",
    "const b: any = u;",
    "const ua: unknown = a;",
    "const ub: unknown = b;",
    "console.log(ua === ub);",
    "",
  ].join("\n");
  const res = await buildWasmDyn("jsmarshal-dyn-identity.ts", source);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("true\n"); // Node-verified

  const c = await compile(join(scratch, "jsmarshal-dyn-identity.ts"), {
    outPath: join(scratch, "jsmarshal-dyn-identity.c.out"),
    outDir: scratch,
    dynamic: true,
    backend: "c",
  });
  if (!c.ok) throw new Error(`c reference refused: ${c.diagnostics[0]?.message}`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const cOut = await promisify(execFile)(c.binaryPath);
  // The per-lane split: C copies at the jsMarshal(dyn) boundary (S014's
  // default rule), so its two "marshaled" values are DIFFERENT objects
  // and the round-trip identity check answers false — unlike wasm, which
  // aliases and matches Node's true.
  expect(cOut.stdout).toBe("false\n");
});

test("increment 21 stage A gate round 3 fix R1/R2: '__proto__' (every kind, an Object.prototype ACCESSOR — never function-valued, so it cannot live in the function-shaped tables) and 'caller'/'arguments' (FUNC only, Function.prototype's own THROWING accessors) fence loudly instead of silently answering undefined; both are catchable and the program survives, matching the reviewer's h1 shape", async () => {
  const res = await buildWasmDyn(
    "getprop-fence-accessors.ts",
    [
      "function mintObj(): any { return { a: 1 }; }",
      "const o: any = mintObj();",
      "try { console.log(typeof o.__proto__); } catch (e) { console.log(`1: ${e}`); }",
      "try { console.log(`${o.__proto__}`); } catch (e) { console.log(`2: ${e}`); }",
      "const v: any = 5;",
      "const f: any = v.toString;",
      "try { console.log(typeof f.caller); } catch (e) { console.log(`3: ${e}`); }",
      "try { console.log(typeof f.arguments); } catch (e) { console.log(`4: ${e}`); }",
      'console.log("done");',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  // No Node oracle for the fence texts (Node answers the real prototype
  // object for __proto__, and throws ITS OWN strict-mode TypeError for
  // caller/arguments — this tier fences all three loudly instead of
  // modeling either, S023's own "TODO marker" framing).
  expect(stdout.toString("utf8")).toBe(
    [
      "1: Error: 'Object.prototype.__proto__' on an island value is not supported yet",
      "2: Error: 'Object.prototype.__proto__' on an island value is not supported yet",
      "3: Error: 'Function.prototype.caller' on an island value is not supported yet",
      "4: Error: 'Function.prototype.arguments' on an island value is not supported yet",
      "done",
      "",
    ].join("\n"),
  );
});

test("increment 21 stage A gate round 3 fix R3: a LITERAL \"__proto__\" key in an island object literal refuses at COMPILE TIME (jsOp:objLit-proto-key) — a wasm-ALONE divergence otherwise: real JS treats `{__proto__: v}` as the prototype-setter special form (non-object v is a silent no-op, no own property is ever created, `typeof o.__proto__` reads the real prototype object, \"object\"), where this tier's objPut would silently store it as an ordinary own entry (\"number\") — Node-measured AND confirmed against the reference C backend, both answering \"object\" where the pre-fix wasm lane answered \"number\" (the reviewer's h6/h6b shape)", async () => {
  const res = await buildWasmDyn(
    "objlit-proto-key.ts",
    [
      "const o: any = { __proto__: 5, plain: 1 };",
      "console.log(`${o.plain}`);",
      "try { console.log(typeof o.__proto__); } catch (e) { console.log(`read: ${e}`); }",
      'console.log("survived");',
      "",
    ].join("\n"),
  );
  if (res.ok) throw new Error("expected a refusal, got a compiled module");
  expect(res.diagnostics[0]?.message).toContain("jsOp:objLit-proto-key");
});

test("increment 21 stage A gate round 3 fix R3 negative control: keys that merely CONTAIN \"proto\" (\"proto\", \"__proto\", \"a__proto__b\" — none is the EXACT string \"__proto__\") are ordinary own entries, unaffected by the compile-time refusal, byte-exact against Node", async () => {
  const res = await buildWasmDyn(
    "objlit-proto-key-negative.ts",
    [
      "const a: any = { proto: 1, __proto: 2, a__proto__b: 3 };",
      "console.log(`${a.proto} ${a.__proto} ${a.a__proto__b}`);",
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("1 2 3\n"); // Node-verified
});

// ── increment 21 stage B, gate 3: the Function-eval recognizer's cross-
// layer pins (review request) ─────────────────────────────────────────────

test("increment 21 stage B gate 3: the Function-eval recognizer's PARSER — the closed grammar's own producer shapes all parse, and deliberately non-matching bodies (a genuinely DIFFERENT `new Function(...)` shape reaching this recognizer, never producible by the frontend's own two synthesis sites, but the recognizer must still refuse it rather than mis-parse) all return null. Backend non-match refusal pin, per review: exercises the recognizer's OWN fallback path directly, since a user's own `new Function(...)` is rejected upstream at the frontend (SC2020) and structurally never reaches this recognizer at all — this is the only way to reach a genuinely non-matching body.", () => {
  // Positive: the closed grammar's own shapes (scratchpad/function-helper-
  // decision.md §2's measured bodies) all parse to a non-null plan.
  const positive: [string[], string][] = [
    [["v"], '"use strict";({} = v);return [];'],
    [["v"], '"use strict";([] = v);return [];'],
    [["v"], '"use strict";var __0;({["x"]: __0} = v);return [__0];'],
    [["v"], '"use strict";var __0;([__0] = v);return [__0];'],
    [["v"], '"use strict";var __0,__1,__2;([__0,,__1,...__2] = v);return [__0,__1,__2];'],
    [["v"], '"use strict";var __0;({["missing"]:__0=42} = v);return [__0];'],
    [["v", "__d0"], '"use strict";({["p"]:{}=__d0} = v);return [];'],
    [["v", "__d0"], '"use strict";var __0;({[__d0]:__0} = v);return [__0];'],
    [[], 'throw new TypeError("a class")'],
  ];
  for (const [params, body] of positive) {
    expect(parseFnEvalConstruct([...params, body]), JSON.stringify(body)).not.toBeNull();
  }
  // Negative: deliberately non-matching bodies MUST refuse (return null),
  // never mis-parse. A bare identifier key (not JSON-string-quoted, never
  // producible by JSON.stringify), extra whitespace (the grammar is exact,
  // byte for byte), a wrong starting temp index (the grammar's own
  // sequential-bind invariant), a wrong leading param name (not "v"), and a
  // completely unrelated body (a user's hypothetical direct `new
  // Function(...)` source, standing in for the "not this recognizer's own
  // synthesis" case the design doc's §5 describes).
  const negative: string[][] = [
    ["v", '"use strict";({garbage} = v);return [];'],
    ["v", "console.log('evil');"],
    ["v", '"use strict";({} = v);return [] ;'],
    ["v", '"use strict";var __1;({["x"]: __1} = v);return [__1];'],
    ["notv", '"use strict";({} = v);return [];'],
    ["x", "return x + 1"],
    [],
  ];
  for (const paramTexts of negative) {
    expect(parseFnEvalConstruct(paramTexts), JSON.stringify(paramTexts)).toBeNull();
  }
});

test("increment 21 stage B gate 3: the Function-eval recognizer's EMITTER — end to end, byte-exact against Node: a nested object pattern with literal defaults, an array pattern with a hole and defaults, and the empty-pattern forms", async () => {
  const res = await buildWasmDyn(
    "fneval-emitter.ts",
    [
      "const src: any = { p: { q: 5 } };",
      "const { p: { q = 1 } = {} } = src;",
      "console.log(`${q}`);",
      "const src2: any = {};",
      "const { p: { q: q2 = 2 } = {} } = src2;",
      "console.log(`${q2}`);",
      "const arr: any = [10];",
      "const [a1, , a2 = 42] = arr;",
      "console.log(`${a1} ${a2}`);",
      "({} = ({} as any));",
      "([] = ([1, 2] as any));",
      'console.log("done");',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${JSON.stringify(res.diagnostics)}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe("5\n2\n10 42\ndone\n");
});

test("increment 21 stage B gate 3: the frontend fixture pin — enginePatternSpec's synthesized body for a representative nested/computed/rest pattern is EXACTLY the text the recognizer's grammar expects (fails on template drift: a change to lower-stmts.ts's synthesis that this recognizer has not been updated for breaks HERE, in the IR, before it could silently desync from the backend)", async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), "tsinter-wasm-ir-"));
  try {
    const entry = join(scratchDir, "fneval-fixture.ts");
    await writeFile(
      entry,
      [
        "declare function use(x: unknown): void;",
        "function f(src: any, extra: any) {",
        '  const { ["missing"]: a = 42, ...rest } = src;',
        "  use(a); use(rest); use(extra);",
        "}",
        "f({}, 1);",
        "",
      ].join("\n"),
    );
    // The wasm lane only writes the IR file on a SUCCESSFUL wasm build
    // (index.ts's own `emitIr` gate sits after `emitWasmModule` succeeds);
    // this pattern's rest clause refuses on wasm today (fnEval:objectRest,
    // gate 3's own scoped-out surface), so the pin uses the DEFAULT
    // backend (native, LLVM-or-C fallback) instead — the FRONTEND lowering
    // that builds the `construct(Function, ...)` synthesis is identical
    // regardless of which backend consumes the resulting IR afterward, and
    // the native lanes accept this pattern today (they execute it through
    // the real engine, which is the whole reason this synthesis exists).
    const res = await compile(entry, {
      outPath: join(scratchDir, "fneval-fixture"),
      outDir: scratchDir,
      dynamic: true,
      emitIr: true,
    });
    if (!res.ok) throw new Error(`refused: ${JSON.stringify(res.diagnostics)}`);
    const irFile = join(scratchDir, "fneval-fixture.ir.json");
    const ir = readFileSync(irFile, "utf8");
    // The IR is JSON, so the synthesized body string's own quotes come
    // through backslash-escaped in the file's raw text.
    expect(ir).toContain('[\\"missing\\"]:__0=42');
    expect(ir).toContain("...__1");
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});

test("increment 21 stage B N2 gate-closing pin: dyn.ts's toFixed precision fence actually EXECUTES — review round 2's fence branch shipped as INVALID WASM once (a stack-imbalance compile error, `ifResult(strRef)`'s throw arm never pushed a value) and was caught only by a sweep script that ran it, never by anything that merely typechecked or asserted refusal without instantiating the module; this pins that a fenced call throws the exact named Error AND the program survives past the catch, alongside an in-window neighbour that computes Node's exact text in the SAME run, so the two together would have caught the original bug", async () => {
  const res = await buildWasmDyn(
    "tofixed-fence.ts",
    [
      "const x: any = 5;",
      "try {",
      "  console.log(`${x.toFixed(100)}`);",
      "} catch (e) {",
      "  console.log(`${(e as Error).message}`);",
      "}",
      "const y: any = 0.1;",
      "console.log(`${y.toFixed(14)}`);",
      'console.log("survived");',
      "",
    ].join("\n"),
  );
  if (!res.ok) throw new Error(`refused: ${JSON.stringify(res.diagnostics)}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.toString("utf8")).toBe(
    "'Number.prototype.toFixed' at this precision is not supported yet\n" +
      "0.10000000000000\n" +
      "survived\n",
  );
});
