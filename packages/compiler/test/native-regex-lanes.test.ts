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
 * Required: wasm, c and llvm print the SAME output, byte for byte, and
 * Node's, on every row the tier builds or rejects with V8's SyntaxError.
 * The FENCED rows (S102: a pattern Node builds and this tier does not —
 * classified up front by the same compiler run at build time) run apart:
 * since GH #86 (SEMANTICS.md S122) the fence ENDS a WasmGC program, so the
 * wasm lane runs one program per fence key and pins its stderr line, while
 * the c and llvm lanes — where S102's fence stays a catchable Error (S122's
 * residue) — run every fenced row in one program and print the named
 * Error, the same on both, where Node builds the regex.
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
import { runWasm, runWasmToTrap } from "./wasm-host.js";

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
  test("wasm = c = llvm = Node byte for byte off the named fences; the fences end a WasmGC program and stay the named Error on c and llvm", async () => {
    const pool = patternPool(Number(process.env["REGEX_GATE_MUTATIONS"] ?? 30000), Number(process.env["REGEX_GATE_SEED"] ?? 0x5eed1));
    const rows: string[] = [];
    // the fenced rows, apart: their rendered row and fence key
    const fencedRows: { row: string; key: string }[] = [];
    let accepted = 0;
    let swept = 0;
    let skipped = 0;
    for (const r of pool) {
      if (hasLoneSurrogate(r.pattern) || hasLoneSurrogate(r.flags)) {
        skipped++;
        continue;
      }
      let sweep = false;
      const outcome = compileRegex(r.pattern, r.flags);
      if (outcome.kind === "fence") {
        fencedRows.push({ row: renderRow(r.pattern, r.flags, false), key: outcome.key });
        continue;
      }
      if (outcome.kind === "ok") {
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

    // the fenced rows: one program on the native lanes and under Node ...
    const fEntry = join(dir, "regex-fenced.ts");
    writeFileSync(fEntry, regexLanesProgram(fencedRows.map((f) => f.row).join("\n"), SUBJECTS));
    const fNode = execFileSync(process.execPath, [fEntry], { maxBuffer: 1 << 30 }).toString();
    const fOuts: Record<string, string> = {};
    for (const lane of ["c", "llvm"] as const) {
      const res = await compile(fEntry, { outPath: join(dir, `regex-fenced-${lane}`), outDir: join(dir, `fout-${lane}`), backend: lane, sanitize: SAN });
      if (!res.ok) throw new Error(`${lane} (fenced): ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      fOuts[lane] = execFileSync(res.binaryPath, { maxBuffer: 1 << 30 }).toString();
    }
    // ... and on the wasm lane one program per key: the fence ends it
    const firstOfKey = new Map<string, string>();
    for (const f of fencedRows) if (!firstOfKey.has(f.key)) firstOfKey.set(f.key, f.row);
    const wasmFenceErr: Record<string, string> = {};
    for (const [key, row] of firstOfKey) {
      const kEntry = join(dir, `regex-fence-${key}.ts`);
      writeFileSync(kEntry, regexLanesProgram(row, SUBJECTS));
      const res = await compile(kEntry, { outPath: join(dir, `regex-fence-${key}.wasm`), outDir: join(dir, `kout-${key}`), backend: "wasm" });
      if (!res.ok) throw new Error(`wasm (fence ${key}): ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      const r = await runWasmToTrap(res.binaryPath);
      expect(String(r.stdout)).toBe("");
      wasmFenceErr[key] = String(r.stderr);
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

    // and Node's, on every unfenced row
    const lane = byRow(outs["wasm"]!);
    const want = byRow(node);
    const diffs: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const got = lane.get(i) ?? [];
      const exp = want.get(i) ?? [];
      if (got.join("\n") !== exp.join("\n")) diffs.push(`row ${i} ${rows[i]}\n  node ${exp.join("\n       ")}\n  lane ${got.join("\n       ")}`);
    }

    // the fenced rows: c = llvm, each the named Error (S122's c/llvm
    // residue) where Node builds the regex; the wasm lane's program ends
    // at the fence with its stderr line (GH #86)
    expect(sameAs(fOuts["c"]!, fOuts["llvm"]!)).toBe(null);
    const fLane = byRow(fOuts["c"]!);
    const fWant = byRow(fNode);
    const fences = new Map<string, number>();
    for (let i = 0; i < fencedRows.length; i++) {
      const got = fLane.get(i) ?? [];
      const exp = fWant.get(i) ?? [];
      const key = fencedRows[i]!.key;
      const fence = got.length === 1 ? / Error "new RegExp\(\): '([^']+)' is not supported yet" libCall:regex\.new:(\S+)$/.exec(got[0]!) : null;
      if (fence === null || fence[1] !== key || fence[2] !== key || exp.length === 0 || exp[0]!.includes(" Error ")) {
        diffs.push(`fenced row ${i} (${key}) ${fencedRows[i]!.row}\n  node ${exp.join("\n       ")}\n  c    ${got.join("\n       ")}`);
        continue;
      }
      fences.set(key, (fences.get(key) ?? 0) + 1);
    }
    for (const [key, err] of Object.entries(wasmFenceErr)) {
      expect(err).toBe(`tsinter: unsupported: new RegExp(): '${key}' is not supported yet [libCall:regex.new:${key}]\n`);
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
