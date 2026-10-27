/* The native regex engine IS the wasm one (follow-up unit D).
 *
 * packages/runtime/src/scr_regex_engine.h is the wasm regex engine module
 * (backend/wasm/regex-engine-module.ts) translated to C by
 * backend/wasm2c.ts. This holds the translation equal to the module it
 * came from, run by Node's own WebAssembly, over the regex gate's whole
 * pattern pool (regex-pattern-pool.ts — 31,114 rows by default):
 *   - compile: the verdict, the SyntaxError text, the fence id/message/
 *     code, and for an accepted pattern its source, flags, bytecode,
 *     capture count and group names, byte for byte;
 *   - exec: for a deterministic sample of the accepted patterns, every
 *     start index of a set of subjects (ASCII, case pairs, line
 *     terminators, astral pairs and lone surrogates — the #269 rows), the
 *     result and every capture slot.
 * The harness (fixtures/native-regex/rxharness.c) is compiled with clang,
 * sanitized (ASan + UBSan) when SCRIPTC_SAN=1, and collects after every
 * line, so the collector's roots are exercised too.
 *
 * native-regex-engine-drift.test.ts holds the checked-in header equal to
 * a fresh translation; native-regex-lanes.test.ts (tests/harness) holds
 * the lanes' programs equal to Node. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { regexEngineModule } from "../src/backend/wasm/regex-engine-module.js";
import { patternPool } from "./regex-pattern-pool.js";

const HERE = import.meta.dirname;
const REPO = join(HERE, "..", "..", "..");
const HEADER = join(REPO, "packages", "runtime", "src", "scr_regex_engine.h");
const HARNESS = join(HERE, "fixtures", "native-regex", "rxharness.c");
const SAN = process.env["SCRIPTC_SAN"] === "1";

function harnessBinary(): string {
  const h = createHash("sha256").update(readFileSync(HEADER)).update(readFileSync(HARNESS)).update(SAN ? "san" : "plain").digest("hex").slice(0, 16);
  const dir = join(REPO, "node_modules", ".cache", "tsinter-rxharness");
  const bin = join(dir, `rxharness-${h}`);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  execFileSync("clang", [
    "-std=c11",
    ...(SAN ? ["-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined"] : ["-O2"]),
    "-fno-strict-aliasing",
    "-I", join(REPO, "packages", "runtime", "src"),
    HARNESS,
    "-o", tmp,
  ]);
  renameSync(tmp, bin);
  return bin;
}

interface Wx {
  strNew(n: number): unknown;
  strSet(s: unknown, i: number, u: number): void;
  strLen(s: unknown): number;
  strAt(s: unknown, i: number): number;
  compile(p: unknown, f: unknown): unknown;
  errId(): number;
  errKind(): number;
  errMessage(): unknown;
  errCode(): unknown;
  isNull(r: unknown): number;
  reSource(r: unknown): unknown;
  reFlags(r: unknown): unknown;
  reBcLen(r: unknown): number;
  reBcAt(r: unknown, i: number): number;
  reCap(r: unknown): number;
  reNamesLen(r: unknown): number;
  reName(r: unknown, k: number): unknown;
  reBc(r: unknown): unknown;
  exec(bc: unknown, s: unknown, start: number, cap: unknown): number;
  newCaptureArray(n: number): unknown;
  capGet(c: unknown, i: number): number;
  capLen(c: unknown): number;
}

function wasmEngine(): Wx {
  const WA = (globalThis as unknown as { WebAssembly: { Module: new (b: Uint8Array) => object; Instance: new (m: object, i: object) => { exports: unknown } } }).WebAssembly;
  return new WA.Instance(new WA.Module(regexEngineModule().bytes), {}).exports as Wx;
}

const hex16 = (s: string): string => (s.length === 0 ? "-" : Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, "0")).join(""));

function toW(x: Wx, s: string): unknown {
  const w = x.strNew(s.length);
  for (let i = 0; i < s.length; i++) x.strSet(w, i, s.charCodeAt(i));
  return w;
}
function wHex(x: Wx, w: unknown): string {
  const n = x.strLen(w);
  let out = "";
  for (let i = 0; i < n; i++) out += x.strAt(w, i).toString(16).padStart(4, "0");
  return n === 0 ? "-" : out;
}

/** The harness's output line for one compile, computed by the wasm module. */
function wasmCompileLine(x: Wx, p: string, f: string): { line: string; ok: boolean } {
  const r = x.compile(toW(x, p), toW(x, f));
  if (!x.isNull(r)) {
    let bc = "";
    for (let i = 0, n = x.reBcLen(r); i < n; i++) bc += x.reBcAt(r, i).toString(16).padStart(2, "0");
    const nn = x.reNamesLen(r);
    let names = String(nn);
    for (let k = 0; k < nn; k++) {
      const nm = x.reName(r, k);
      names += "," + (nm === null ? "~" : wHex(x, nm));
    }
    return { line: `ok\t${wHex(x, x.reSource(r))}\t${wHex(x, x.reFlags(r))}\t${bc}\t${x.reCap(r)}\t${names}`, ok: true };
  }
  if (x.errKind() === 1) return { line: `syn\t${wHex(x, x.errMessage())}`, ok: false };
  return { line: `fence\t${x.errId()}\t${wHex(x, x.errMessage())}\t${wHex(x, x.errCode())}`, ok: false };
}

function wasmExecLine(x: Wx, p: string, f: string, subject: string, start: number): string {
  const r = x.compile(toW(x, p), toW(x, f));
  if (x.isNull(r)) return "nocompile";
  const regs = x.reBcAt(r, 3);
  const caps = x.newCaptureArray(x.reCap(r) + ((regs + 1) >> 1));
  const rc = x.exec(x.reBc(r), toW(x, subject), start, caps);
  const slots: number[] = [];
  for (let i = 0, n = x.capLen(caps); i < n; i++) slots.push(x.capGet(caps, i));
  return `m\t${rc}\t${slots.join(",")}`;
}

/** Subjects for the exec sweep: plain text, case pairs, line terminators,
 * digits and word boundaries, astral pairs and lone surrogates (the #269
 * positions between the halves of a pair). */
export const SWEEP_SUBJECTS = [
  "",
  "a",
  "abcabc",
  "aaa",
  "Hello World 123",
  "ab\nc\r\nd",
  "AbC aBc",
  "a\u{1F600}b",
  "\u{1F600}\u{1F600}",
  "x\uD83Dy\uDE00z",
  "ßİſK k",
  "foo.bar(baz)[0]{1}",
  "  tab\there  ",
  "2024-01-02T03:04:05Z",
];

describe("the native regex engine is the wasm engine, translated", () => {
  test("compile: every pool row byte for byte; exec: the sweep, slot for slot", () => {
    const bin = harnessBinary();
    const x = wasmEngine();
    const rows = patternPool(Number(process.env["REGEX_GATE_MUTATIONS"] ?? 30000), Number(process.env["REGEX_GATE_SEED"] ?? 0x5eed1));
    const input: string[] = [];
    const expected: string[] = [];
    const accepted: { p: string; f: string }[] = [];
    for (const row of rows) {
      input.push(`c\t${hex16(row.pattern)}\t${hex16(row.flags)}`);
      const w = wasmCompileLine(x, row.pattern, row.flags);
      expected.push(w.line);
      if (w.ok) accepted.push({ p: row.pattern, f: row.flags });
    }
    // exec: every 7th accepted pattern (and every /u one), each subject,
    // every start index
    let execRows = 0;
    accepted.forEach(({ p, f }, k) => {
      if (k % 7 !== 0 && !f.includes("u")) return;
      for (const s of SWEEP_SUBJECTS) {
        for (let start = 0; start <= s.length; start++) {
          input.push(`x\t${hex16(p)}\t${hex16(f)}\t${hex16(s)}\t${start}`);
          expected.push(wasmExecLine(x, p, f, s, start));
          execRows++;
        }
      }
    });
    const out = execFileSync(bin, { input: input.join("\n") + "\n", maxBuffer: 1 << 30 }).toString().split("\n");
    out.pop();
    expect(out.length).toBe(expected.length);
    const diffs: string[] = [];
    for (let i = 0; i < expected.length; i++) if (out[i] !== expected[i]) diffs.push(`${input[i]}\n  wasm ${expected[i]}\n  c    ${out[i]}`);
    console.log(`native regex engine: ${rows.length} compile rows (${accepted.length} accepted), ${execRows} exec rows, ${diffs.length} differences`);
    expect(diffs.slice(0, 20)).toEqual([]);
    expect(rows.length).toBeGreaterThan(10000);
  }, 1_200_000);
});
