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
