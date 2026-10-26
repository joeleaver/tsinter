/* The ONE RegExp compiler's gate (regex-compiler.ts; unit P1, and since
 * unit E the only regex compiler: build time runs it too, through
 * regex-buildtime.ts).
 *
 * Over every pattern in regex-pattern-pool.ts (claims, generated grammar,
 * every corpus literal, the retired unit tests' fixtures, and seeded
 * mutations), the compiler's outcome is checked against Node's own
 * `new RegExp` (the oracle of record) and, where it accepts, against
 * libregexp's lre_compile (regex-lre-oracle.ts) byte for byte.
 *
 * Per pattern, the outcome must be one of:
 *   - accepted: Node accepts with the same .source and .flags, and the
 *     bytecode (header, body, named-group trailer) equals lre_compile's,
 *     except on the known-difference rows (knownLreDiff below);
 *   - a SyntaxError: Node throws a SyntaxError with the identical message;
 *   - a named fence (SEMANTICS.md S102): counted by key, so fence growth
 *     shows up in the report.
 * Zero "accepted where Node throws", zero wrong messages.
 *
 * Then the build-time mapping (regex-fold.ts) over the same pool: a
 * `new RegExp` folds to exactly the compiler's outcome, and a literal is
 * built only where Node accepts. */
import { describe, expect, test } from "vitest";
import { compileRegex, type RegexCompileOutcome } from "../src/backend/wasm/regex-buildtime.js";
import { foldRegexLiteral, foldRegexNew } from "../src/backend/wasm/regex-fold.js";
import { lreCompileBatch } from "./regex-lre-oracle.js";
import { patternPool, type PoolRow } from "./regex-pattern-pool.js";

type NodeOutcome = { kind: "ok"; source: string; flags: string } | { kind: "throw"; name: string; message: string };

function nodeOf(p: string, f: string): NodeOutcome {
  try {
    const r = new RegExp(p, f);
    return { kind: "ok", source: r.source, flags: r.flags };
  } catch (e) {
    return { kind: "throw", name: (e as Error).name, message: (e as Error).message };
  }
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

interface Report {
  total: number;
  accepted: number;
  syntax: number;
  fences: Map<string, number>;
  /** hard failures */
  acceptedNodeThrows: string[];
  sourceOrFlagsDiffer: string[];
  wrongMessage: string[];
  syntaxNodeAccepts: string[];
  foldMismatch: string[];
  literalBuiltNodeThrows: string[];
  /** recorded */
  lreCompared: number;
  lreDiff: string[];
  lreDiffUnknown: string[];
  lreDiffKinds: Map<string, number>;
  lreErr: string[];
  lreSkipped: number;
  lreErrDupNames: number;
}

function runGate(rows: readonly PoolRow[]): Report {
  const rep: Report = {
    total: rows.length,
    accepted: 0,
    syntax: 0,
    fences: new Map(),
    acceptedNodeThrows: [],
    sourceOrFlagsDiffer: [],
    wrongMessage: [],
    syntaxNodeAccepts: [],
    foldMismatch: [],
    literalBuiltNodeThrows: [],
    lreCompared: 0,
    lreDiff: [],
    lreDiffUnknown: [],
    lreDiffKinds: new Map(),
    lreErr: [],
    lreSkipped: 0,
    lreErrDupNames: 0,
  };
  const forLre: { pattern: string; flags: string; bytes: Uint8Array; tag: string }[] = [];
  for (const row of rows) {
    const { pattern: p, flags: f } = row;
    const tag = `${JSON.stringify(p)} /${f}/ (${row.origin})`;
    const rt: RegexCompileOutcome = compileRegex(p, f);
    const node = nodeOf(p, f);
    // the build-time mapping: regex.new folds to the outcome itself; a
    // literal builds only what the compiler accepts
    const nw = foldRegexNew(p, f);
    const expectNew = rt; // a fence too: thrown at the call, never a build refusal
    if (JSON.stringify(nw, (_, v) => (v instanceof Uint8Array ? hex(v) : v)) !== JSON.stringify(expectNew, (_, v) => (v instanceof Uint8Array ? hex(v) : v))) {
      rep.foldMismatch.push(`${tag}: new ${JSON.stringify(nw).slice(0, 120)}`);
    }
    const lit = foldRegexLiteral(p, f);
    if (lit.kind === "ok" && node.kind === "throw") rep.literalBuiltNodeThrows.push(`${tag}: ${node.message}`);
    if ((lit.kind === "ok") !== (rt.kind === "ok")) rep.foldMismatch.push(`${tag}: literal ${lit.kind} / compiler ${rt.kind}`);
    if (rt.kind === "ok") {
      rep.accepted++;
      if (node.kind !== "ok") {
        rep.acceptedNodeThrows.push(`${tag}: Node ${node.message}`);
        continue;
      }
      if (node.source !== rt.source || node.flags !== rt.flags) rep.sourceOrFlagsDiffer.push(`${tag}: node ${node.source} ${node.flags} / rt ${rt.source} ${rt.flags}`);
      // The oracle feeds lre_compile TSV rows, and a /u row as UTF-8,
      // where a lone surrogate becomes U+FFFD: rows it cannot carry.
      if (/[\t\n\r\0]/.test(p) || (f.includes("u") && [...p].some((ch) => ch.length === 1 && ch >= "\ud800" && ch <= "\udfff"))) rep.lreSkipped++;
      else forLre.push({ pattern: p, flags: f.replace("d", ""), bytes: rt.bytes, tag });
    } else if (rt.kind === "syntax") {
      rep.syntax++;
      if (node.kind === "ok") rep.syntaxNodeAccepts.push(`${tag}: rt ${rt.message}`);
      else if (node.name !== "SyntaxError" || node.message !== rt.message) rep.wrongMessage.push(`${tag}: node ${node.message} / rt ${rt.message}`);
    } else {
      rep.fences.set(rt.key, (rep.fences.get(rt.key) ?? 0) + 1);
    }
  }
  const lre = lreCompileBatch(forLre);
  for (const r of forLre) {
    const got = lre.get(`${r.pattern} ${r.flags}`);
    if (got === undefined || got === null) {
      // libregexp rejects some duplicate group names V8 (and this
      // compiler) accept, e.g. `(?<n>a(?<n>b)|)|(?<n>c)`: its scope rule
      // is not V8's. Counted, not failed; any other lre_compile error is.
      const names = [...r.pattern.matchAll(/\(\?<([^>=!][^>]*)>/g)].map((m) => m[1]);
      if (new Set(names).size !== names.length) rep.lreErrDupNames++;
      else rep.lreErr.push(r.tag);
      continue;
    }
    rep.lreCompared++;
    if (hex(got.bytes) !== hex(r.bytes)) {
      const line = `${r.tag}: lre ${hex(got.bytes)} / rt ${hex(r.bytes)}`;
      rep.lreDiff.push(line);
      const kind = knownLreDiff(r.pattern);
      if (kind === null) rep.lreDiffUnknown.push(line);
      else rep.lreDiffKinds.set(kind, (rep.lreDiffKinds.get(kind) ?? 0) + 1);
    }
  }
  return rep;
}

/** The two places this compiler emits different bytes from lre_compile
 * (inherited from the retired TypeScript pipeline it was transcribed
 * from), with equal match results:
 *   - a `{0,N}` / `{1,N}` bound at or past 2^31-1 (parse_digits clamps it to
 *     INT32_MAX, which lre_compile then reads as "unbounded" and compiles
 *     as `*` / `+`; this compiler keeps it a finite count);
 *   - `\k<name>` when groups of that name sit both before and after it
 *     (lre_compile's find_group_name lists only the ones already parsed;
 *     this compiler lists all of them).
 * Any other difference is a failure. */
export function knownLreDiff(p: string): string | null {
  for (const m of p.matchAll(/\{(\d+)(,(\d*))?\}/g)) {
    const min = Number(m[1]);
    const max = m[3] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    if (min <= 1 && max !== Infinity && max >= 0x7fffffff) return "int32-bound";
    if (min >= 0x7fffffff && m[3] === "") return "int32-bound";
  }
  for (const m of p.matchAll(/\\k<([^>]+)>/g)) {
    const name = m[1]!;
    const at = m.index!;
    const before = p.slice(0, at).split(`(?<${name}>`).length - 1;
    const after = p.slice(at).split(`(?<${name}>`).length - 1;
    if (before > 0 && after > 0) return "dup-name-backref";
  }
  return null;
}

function summary(rep: Report): string {
  const lines = [
    `patterns ${rep.total}: accepted ${rep.accepted}, SyntaxError ${rep.syntax}, fenced ${[...rep.fences.values()].reduce((a, b) => a + b, 0)}`,
    `fences by key: ${JSON.stringify(Object.fromEntries([...rep.fences].sort()))}`,
    `lre_compile compared ${rep.lreCompared}, differ ${rep.lreDiff.length} ${JSON.stringify(Object.fromEntries(rep.lreDiffKinds))}, lre ERR ${rep.lreErr.length} (+${rep.lreErrDupNames} duplicate-name patterns libregexp rejects), skipped (control characters, or a lone surrogate under /u) ${rep.lreSkipped}`,
  ];
  const sample = (name: string, xs: string[]): void => {
    if (xs.length > 0) lines.push(`${name} (${xs.length}):\n  ${xs.slice(0, 40).map((x) => x.slice(0, 300)).join("\n  ")}`);
  };
  sample("HARD accepted where Node throws", rep.acceptedNodeThrows);
  sample("HARD source/flags differ", rep.sourceOrFlagsDiffer);
  sample("HARD wrong message", rep.wrongMessage);
  sample("HARD SyntaxError where Node accepts", rep.syntaxNodeAccepts);
  sample("HARD build-time mapping differs from the compiler", rep.foldMismatch);
  sample("HARD literal built where Node throws", rep.literalBuiltNodeThrows);
  sample("HARD lre differs, not a known difference", rep.lreDiffUnknown);
  sample("lre ERR", rep.lreErr);
  return lines.join("\n");
}

describe("the one RegExp compiler's gate", () => {
  test("verdict, message and byte parity over the whole pool", () => {
    // REGEX_GATE_MUTATIONS / REGEX_GATE_SEED widen the sweep by hand
    // (exploration); the default is the gate of record.
    const rows = patternPool(Number(process.env["REGEX_GATE_MUTATIONS"] ?? 30000), Number(process.env["REGEX_GATE_SEED"] ?? 0x5eed1));
    const rep = runGate(rows);
    console.log(summary(rep));
    expect(rep.total).toBeGreaterThan(10000);
    expect(rep.acceptedNodeThrows).toEqual([]);
    expect(rep.sourceOrFlagsDiffer).toEqual([]);
    expect(rep.wrongMessage).toEqual([]);
    expect(rep.syntaxNodeAccepts).toEqual([]);
    expect(rep.foldMismatch).toEqual([]);
    // #264: the build time never builds a pattern Node rejects (it used to
    // for some duplicate group names and `\k` inside a class)
    expect(rep.literalBuiltNodeThrows).toEqual([]);
    expect(rep.lreDiffUnknown).toEqual([]);
    expect(rep.lreErr).toEqual([]);
  }, 1_200_000);
});
