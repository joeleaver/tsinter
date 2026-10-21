/* INC-28 U3 — node:string_decoder's StringDecoder on the WasmGC tier
 * (strdec.ts): HOST-FREE rows. Each row generates a program, compiles it for
 * the wasm backend, runs it through wasm-host.ts, and compares its stdout
 * with Node's own run of the SAME source (`node --experimental-transform-
 * types`, the harness oracle) — Node is the judge, never a table written by
 * hand. Every decoded string is printed as its UTF-16 code units, so a lone
 * surrogate is compared exactly. Every row names the single edit that would
 * make it fail. */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-strdec-u3-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;

/** Compiles `src` for wasm and runs it; runs Node on the same file; both
 * stdouts and exit codes. */
async function both(src: string): Promise<{ wasm: string; node: string; wasmExit: number; nodeExit: number | null }> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  const w = await runWasm(res.binaryPath);
  const n = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { wasm: w.stdout, node: n.stdout, wasmExit: w.exitCode, nodeExit: n.status };
}

/** The program's shared printer: a string as its code units. */
const PRELUDE =
  'import { StringDecoder } from "node:string_decoder";\n' +
  "const units = (s: string): string => {\n" +
  '  let out = "";\n' +
  "  for (let i = 0; i < s.length; i++) out += (i > 0 ? \",\" : \"\") + String(s.charCodeAt(i));\n" +
  '  return "[" + out + "]";\n' +
  "};\n";

/** One decoder per case for `enc`: every part written in order, then
 * end(), then one more write after the reset. */
function caseRunner(fnName: string, enc: string): string {
  return (
    `function ${fnName}(cases: number[][][]): void {\n` +
    "  for (const parts of cases) {\n" +
    `    const d = new StringDecoder(${JSON.stringify(enc)});\n` +
    "    let line = \"\";\n" +
    "    for (const p of parts) line += units(d.write(Buffer.from(p))) + \" \";\n" +
    "    line += \"END \" + units(d.end());\n" +
    "    line += \" AFTER \" + units(d.write(Buffer.from([0x41, 0x00, 0x42])));\n" +
    "    console.log(line);\n" +
    "  }\n" +
    "}\n"
  );
}

/** Every way to cut `bytes` into three (possibly empty) consecutive parts. */
function splits3(bytes: number[]): number[][][] {
  const out: number[][][] = [];
  for (let i = 0; i <= bytes.length; i++) {
    for (let j = i; j <= bytes.length; j++) out.push([bytes.slice(0, i), bytes.slice(i, j), bytes.slice(j)]);
  }
  return out;
}

/** A deterministic generator (xorshift32) so a failing case reproduces. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** `count` random multi-write cases: 1-6 parts of 0-6 bytes each drawn
 * from `alphabet`. */
function fuzz(seed: number, count: number, alphabet: number[]): number[][][] {
  const r = rng(seed);
  const out: number[][][] = [];
  for (let k = 0; k < count; k++) {
    const parts: number[][] = [];
    const np = 1 + (r() % 6);
    for (let p = 0; p < np; p++) {
      const len = r() % 7;
      const part: number[] = [];
      for (let b = 0; b < len; b++) part.push(alphabet[r() % alphabet.length]!);
      parts.push(part);
    }
    out.push(parts);
  }
  return out;
}

const UTF8_SEQS: number[][] = [
  [0x61, 0xc3, 0xa9, 0x62], // é
  [0xe2, 0x82, 0xac], // €
  [0xf0, 0x9f, 0x92, 0xa9], // U+1F4A9
  [0x68, 0xf0, 0x9f, 0x98, 0x80, 0x69], // U+1F600 between ASCII
  [0xe2, 0x28, 0xa1], // invalid continuation
  [0xc3], // lone lead
  [0xe2, 0x82], // truncated 3-byte
  [0xf0, 0x9f, 0x92], // truncated 4-byte
  [0x80, 0x81, 0xbf], // bare continuations
  [0xff, 0xfe, 0x41], // never-valid bytes
  [0xc0, 0x80], // overlong NUL
  [0xe0, 0x80, 0x80], // overlong 3-byte
  [0xed, 0xa0, 0x80], // encoded surrogate
  [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
  [0xf5, 0x80, 0x80, 0x80], // F5 lead (Node's table: 4 bytes)
  [0xf8, 0x88, 0x80, 0x80, 0x80], // 5-byte form
  [0xe2, 0x82, 0xf0, 0x9f], // interrupted by a new lead
  [0xc3, 0xa9, 0x80, 0x80, 0x80], // complete, then four continuations
  [0xf0, 0x9f, 0x92, 0xa9, 0xf0, 0x9f, 0x92, 0xa9], // two astral
];

describe("INC-28 U3 string_decoder — host-free rows (Node is the judge)", () => {
  test("U3-SD-01 utf8: every three-way split of nineteen sequences (valid 2/3/4-byte, truncated, invalid, overlong, surrogate, F5/F8 leads, interrupted), end() and the reset — SINGLE-EDIT: the utf8 tail scan stops at two bytes", async () => {
    const cases = UTF8_SEQS.flatMap(splits3);
    const src = PRELUDE + caseRunner("run", "utf8") + `run(${JSON.stringify(cases)});\n`;
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
    expect(r.wasm.split("\n").length).toBe(cases.length + 1);
    expect(r.wasmExit).toBe(0);
  }, 120000);

  test("U3-SD-02 utf8: 600 random multi-write cases over a lead/continuation-heavy alphabet — SINGLE-EDIT: an interrupting non-continuation byte buffered", async () => {
    const cases = fuzz(0x5eed01, 600, [0x41, 0x80, 0x9f, 0xbf, 0xc2, 0xc3, 0xdf, 0xe0, 0xe2, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff, 0xa9, 0x82]);
    const src = PRELUDE + caseRunner("run", "utf8") + `run(${JSON.stringify(cases)});\n`;
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
  }, 120000);

  test("U3-SD-03 utf16le: every three-way split of pairs, lone leads and trails, odd lengths and a lead completed by its odd byte; end() keeps a held lead as the lone surrogate and drops an odd byte — SINGLE-EDIT: end() decodes the odd byte", async () => {
    const seqs: number[][] = [
      [0x61, 0x00, 0x3d, 0xd8, 0xa9, 0xdc, 0x62, 0x00], // a, U+1F4A9, b
      [0x3d, 0xd8], // lone lead
      [0xa9, 0xdc, 0x61, 0x00], // lone trail first
      [0x61, 0x00, 0x62], // odd length
      [0x3d, 0xd8, 0x61, 0x00], // lead then a non-trail
      [0x3d, 0xd8, 0x3d, 0xd8, 0xa9, 0xdc], // lead, then a pair
      [0x00, 0xd8, 0x00, 0xdc, 0xff, 0xdb, 0xff, 0xdf],
    ];
    const cases = seqs.flatMap(splits3);
    const src = PRELUDE + caseRunner("run", "utf16le") + `run(${JSON.stringify(cases)});\n`;
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
  }, 120000);

  test("U3-SD-04 utf16le: 600 random multi-write cases over a surrogate-heavy alphabet — SINGLE-EDIT: the trailing-lead hold tests the low byte instead of the high", async () => {
    const cases = fuzz(0x5eed02, 600, [0x00, 0x41, 0xd8, 0xdb, 0xdc, 0xdf, 0x3d, 0xa9]);
    const src = PRELUDE + caseRunner("run", "utf16le") + `run(${JSON.stringify(cases)});\n`;
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
  }, 120000);

  test("U3-SD-05 base64 and base64url: every three-way split of 0-7 byte inputs and 400 random cases each; end() pads base64 and not base64url — SINGLE-EDIT: the remainder taken mod 4", async () => {
    const seqs: number[][] = [[], [0xfb], [0xfb, 0xff], [0xfb, 0xff, 0xbf], [1, 2, 3, 4], [251, 255, 254, 251, 0], [0, 1, 2, 3, 4, 5], [9, 8, 7, 6, 5, 4, 3]];
    const cases = [...seqs.flatMap(splits3), ...fuzz(0x5eed03, 400, [0, 1, 0x3e, 0x3f, 0xfb, 0xfe, 0xff, 0x80])];
    const src = PRELUDE + caseRunner("b64", "base64") + caseRunner("b64u", "base64url") + `const cases = ${JSON.stringify(cases)};\nb64(cases);\nb64u(cases);\n`;
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
  }, 120000);

  test("U3-SD-06 the stateless three (latin1, ascii, hex) and the aliases binary, ucs2, utf-16le, utf-8: random cases, write is toString and end() is empty — SINGLE-EDIT: ascii decoded as latin1", async () => {
    const cases = fuzz(0x5eed04, 200, [0x00, 0x41, 0x7f, 0x80, 0xe9, 0xff, 0xc3, 0xa9]);
    const src =
      PRELUDE +
      caseRunner("l1", "latin1") +
      caseRunner("as", "ascii") +
      caseRunner("hx", "hex") +
      caseRunner("bi", "binary") +
      caseRunner("u2", "ucs2") +
      caseRunner("u16", "utf-16le") +
      caseRunner("u8", "utf-8") +
      `const cases = ${JSON.stringify(cases)};\nl1(cases);\nas(cases);\nhx(cases);\nbi(cases);\nu2(cases);\nu16(cases);\nu8(cases);\n`;
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
  }, 120000);

  test("U3-SD-07 one decoder carried through many writes, ends and writes again, per encoding (the reset after end() and state across many chunks) — SINGLE-EDIT: the packed count read from the high byte", async () => {
    const parts = fuzz(0x5eed05, 1, [0xe2, 0x82, 0xac, 0x41, 0xf0, 0x9f, 0x3d, 0xd8, 0xdc])[0]!;
    const many = fuzz(0x5eed06, 40, [0xe2, 0x82, 0xac, 0x41, 0xf0, 0x9f, 0x3d, 0xd8, 0xdc]).flat();
    let src = PRELUDE;
    for (const enc of ["utf8", "utf16le", "base64", "base64url", "hex"]) {
      src +=
        `{\n  const d = new StringDecoder(${JSON.stringify(enc)});\n  let line = "";\n` +
        `  const all: number[][] = ${JSON.stringify([...parts, ...many])};\n` +
        "  all.forEach((p, i) => {\n    line += units(d.write(Buffer.from(p)));\n    if (i % 7 === 6) line += \"|\" + units(d.end()) + \"|\";\n  });\n" +
        "  line += \"END\" + units(d.end());\n  console.log(line);\n}\n";
    }
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
    expect(r.wasm.split("\n").length).toBe(6);
  }, 120000);

  test("U3-SD-08 the decoder's write takes a Uint8Array view with a nonzero offset (subarray) and a Buffer slice: the bytes decoded are the view's — SINGLE-EDIT: the chunk copied from its storage's start", async () => {
    const src =
      PRELUDE +
      'const big = Buffer.from([0x41, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x92, 0xa9, 0x42]);\n' +
      'const d = new StringDecoder("utf8");\n' +
      "console.log(units(d.write(big.subarray(1, 3))), units(d.write(big.subarray(3, 6))), units(d.write(big.slice(6))), units(d.end()));\n" +
      'const u = new StringDecoder("utf16le");\n' +
      "const raw = new Uint8Array([9, 0x3d, 0xd8, 0xa9, 0xdc, 9]);\n" +
      "console.log(units(u.write(raw.subarray(1, 4))), units(u.write(raw.subarray(4, 5))), units(u.end()));\n" +
      'const h = new StringDecoder("hex");\n' +
      "console.log(h.write(big.subarray(2, 5)), h.end() === \"\");\n";
    const r = await both(src);
    expect(r.wasm).toBe(r.node);
  }, 120000);
});
