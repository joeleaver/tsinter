/* ONE shared regex table for every lane (follow-up unit D, "native regex
 * = wasm = Node"; SEMANTICS.md S065, S102).
 *
 * The regex gate's whole pattern pool (regex-pattern-pool.ts: claims, the
 * generated grammar, every corpus literal, the retired unit tests'
 * fixtures and 30,000 seeded mutations — 31,114 rows) goes through ONE
 * program (regex-lanes-program.ts), compiled for wasm, c and llvm and run
 * by Node. Per row the program prints what `new RegExp(p, f)` does — the
 * value's .source and .flags, V8's SyntaxError text, or the fence's named
 * Error and `code` — and for a deterministic sample of the accepted rows
 * (every 5th, and every /u row) what search, test, match, replace (every
 * GetSubstitution form), replaceAll and matchAll return over a set of
 * subjects, the #269 surrogate-pair positions included.
 *
 * Required: wasm, c and llvm print the SAME output, byte for byte; and each
 * equals Node's on every row except the fenced ones (S102: the lane throws
 * the named Error where Node builds the regex — counted by key).
 *
 * Rows holding a lone surrogate are left out: the native lanes' UTF-8
 * strings cannot carry one (their registered string representation, not a
 * regex difference); subjects that hold astral pairs print slices as
 * lengths for the same reason (regex-lanes-program.ts).
 *
 * SCRIPTC_SAN=1 builds the native lanes with ASan + the RC audit. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { compileRegex } from "../src/backend/wasm/regex-buildtime.js";
import { patternPool } from "./regex-pattern-pool.js";
import { regexLanesProgram, renderRow } from "./regex-lanes-program.js";
import { runWasm } from "./wasm-host.js";

const SAN = process.env["SCRIPTC_SAN"] === "1";

const SUBJECTS = [
  "",
  "a",
  "abcabc",
  "aaa",
  "Hello World 123",
  "ab\nc\r\nd",
  "AbC aBc",
  "a\u{1F600}b",
  "\u{1F600}\u{1F600}",
  "ßİſK k",
  "foo.bar(baz)[0]{1}",
  "2024-01-02T03:04:05Z",
];

const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

/** Output lines grouped by row id (the number before the first space or
 * dot). */
function byRow(out: string): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const id = Number(/^(\d+)/.exec(line)![1]);
    let a = m.get(id);
    if (a === undefined) m.set(id, (a = []));
    a.push(line);
  }
  return m;
}

describe("one regex table, every lane", () => {
  test("wasm = c = llvm byte for byte, and = Node except the named fences", async () => {
    const pool = patternPool(Number(process.env["REGEX_GATE_MUTATIONS"] ?? 30000), Number(process.env["REGEX_GATE_SEED"] ?? 0x5eed1));
    const rows: string[] = [];
    let accepted = 0;
    let swept = 0;
    let skipped = 0;
    for (const r of pool) {
      if (hasLoneSurrogate(r.pattern) || hasLoneSurrogate(r.flags)) {
        skipped++;
        continue;
      }
      let sweep = false;
      if (compileRegex(r.pattern, r.flags).kind === "ok") {
        sweep = accepted % 5 === 0 || r.flags.includes("u");
        accepted++;
        if (sweep) swept++;
      }
      rows.push(renderRow(r.pattern, r.flags, sweep));
    }
    // Outside node_modules: Node strips the program's types itself, and
    // refuses to under node_modules.
    const dir = mkdtempSync(join(tmpdir(), "tsinter-regex-lanes-"));
    const entry = join(dir, "regex-lanes.ts");
    writeFileSync(entry, regexLanesProgram(rows.join("\n"), SUBJECTS));

    const node = execFileSync(process.execPath, [entry], { maxBuffer: 1 << 30 }).toString();
    const outs: Record<string, string> = {};
    for (const lane of ["wasm", "c", "llvm"] as const) {
      const outPath = join(dir, lane === "wasm" ? "regex-lanes.wasm" : `regex-lanes-${lane}`);
      const res = await compile(entry, { outPath, outDir: join(dir, `out-${lane}`), backend: lane, sanitize: lane !== "wasm" && SAN });
      if (!res.ok) throw new Error(`${lane}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      outs[lane] = lane === "wasm" ? (await runWasm(res.binaryPath)).stdout : execFileSync(res.binaryPath, { maxBuffer: 1 << 30 }).toString();
    }
    rmSync(dir, { recursive: true, force: true });

    // every lane the same, byte for byte
    const sameAs = (a: string, b: string): string | null => {
      if (a === b) return null;
      const x = a.split("\n");
      const y = b.split("\n");
      for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `line ${i}:\n  ${x[i]}\n  ${y[i]}`;
      return "differ";
    };
    expect(sameAs(outs["wasm"]!, outs["c"]!)).toBe(null);
    expect(sameAs(outs["wasm"]!, outs["llvm"]!)).toBe(null);

    // and Node's, except where the lane throws the named fence Error
    const lane = byRow(outs["wasm"]!);
    const want = byRow(node);
    const fences = new Map<string, number>();
    const diffs: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const got = lane.get(i) ?? [];
      const exp = want.get(i) ?? [];
      const fence = got.length === 1 ? / Error "new RegExp\(\): '([^']+)' is not supported yet" libCall:regex\.new:(\S+)$/.exec(got[0]!) : null;
      if (fence !== null && fence[1] === fence[2] && !exp[0]!.includes(" Error ")) {
        fences.set(fence[1]!, (fences.get(fence[1]!) ?? 0) + 1);
        continue;
      }
      if (got.join("\n") !== exp.join("\n")) diffs.push(`row ${i} ${rows[i]}\n  node ${exp.join("\n       ")}\n  lane ${got.join("\n       ")}`);
    }
    const lines = outs["wasm"]!.split("\n").length;
    console.log(
      `regex lanes: ${rows.length} rows (${skipped} with a lone surrogate left out), ${accepted} accepted, ${swept} swept over ${SUBJECTS.length} subjects; ` +
        `${lines} output lines; fenced ${[...fences.values()].reduce((a, b) => a + b, 0)} ${JSON.stringify(Object.fromEntries([...fences].sort()))}; ${diffs.length} differences from Node`,
    );
    expect(diffs.slice(0, 20)).toEqual([]);
    expect(rows.length).toBeGreaterThan(10000);
  }, 3_600_000);
});
