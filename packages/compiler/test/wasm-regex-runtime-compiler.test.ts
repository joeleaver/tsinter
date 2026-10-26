/* Unit P1 — the run-time RegExp compiler's gate (regex-compiler.ts).
 *
 * The cross-check that would let the build-time TypeScript pipeline be
 * retired (P2): over every pattern in regex-pattern-pool.ts (claims,
 * generated grammar, every corpus literal, every regex unit-test fixture,
 * and seeded mutations), the run-time compiler (compileViaWasm), the
 * build-time pipeline (foldRegexNew — the emitter's own regex.new
 * decision sequence) and libregexp's lre_compile (regex-lre-oracle.ts),
 * and Node's own `new RegExp` as the oracle of record.
 *
 * Per pattern, the run-time outcome must be one of:
 *   - accepted: Node accepts with the same .source and .flags, and the
 *     bytecode (header, body, named-group trailer), capture count and
 *     group names equal the build-time pipeline's — and lre_compile's,
 *     except on the rows listed in LRE_DIFF below;
 *   - a SyntaxError: Node throws a SyntaxError with the identical message;
 *   - a named fence (SEMANTICS.md S102): counted by key, so fence growth
 *     shows up in the report.
 * Zero "accepted where Node throws", zero wrong messages, zero byte
 * differences against the build-time pipeline where both accept. */
import { describe, expect, test } from "vitest";
import { foldRegexNew, type RegexFoldOutcome } from "../src/backend/wasm/regex-fold.js";
import { lreCompileBatch } from "./regex-lre-oracle.js";
import { patternPool, type PoolRow } from "./regex-pattern-pool.js";
import { compileViaWasm, type RuntimeOutcome } from "./regex-runtime-harness.js";

type NodeOutcome = { kind: "ok"; source: string; flags: string } | { kind: "throw"; name: string; message: string };

function nodeOf(p: string, f: string): NodeOutcome {
  try {
    const r = new RegExp(p, f);
    return { kind: "ok", source: r.source, flags: r.flags };
  } catch (e) {
    return { kind: "throw", name: (e as Error).name, message: (e as Error).message };
  }
}

function tsOf(p: string, f: string): RegexFoldOutcome | { kind: "crash"; message: string } {
  try {
    return foldRegexNew(p, f);
  } catch (e) {
    return { kind: "crash", message: String(e) };
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
  bytesDifferTs: string[];
  /** recorded differences */
  tsRefusesRtAccepts: string[];
  tsAcceptsNodeThrows: string[];
  fenceWhereTsBuilds: string[];
  lreCompared: number;
  lreDiff: string[];
  lreDiffUnknown: string[];
  lreDiffKinds: Map<string, number>;
  lreErr: string[];
  lreSkipped: number;
  tsDeferred: number;
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
    bytesDifferTs: [],
    tsRefusesRtAccepts: [],
    tsAcceptsNodeThrows: [],
    fenceWhereTsBuilds: [],
    lreCompared: 0,
    lreDiff: [],
    lreDiffUnknown: [],
    lreDiffKinds: new Map(),
    lreErr: [],
    lreSkipped: 0,
    tsDeferred: 0,
    lreErrDupNames: 0,
  };
  const forLre: { pattern: string; flags: string; bytes: Uint8Array; tag: string }[] = [];
  for (const row of rows) {
    const { pattern: p, flags: f } = row;
    const tag = `${JSON.stringify(p)} /${f}/ (${row.origin})`;
    const rt: RuntimeOutcome = compileViaWasm(p, f);
    const node = nodeOf(p, f);
    const tsr = tsOf(p, f);
    if (tsr.kind === "ok" && node.kind === "throw") rep.tsAcceptsNodeThrows.push(`${tag}: ${node.message}`);
    if (rt.kind === "ok") {
      rep.accepted++;
      if (node.kind !== "ok") {
        rep.acceptedNodeThrows.push(`${tag}: Node ${node.message}`);
        continue;
      }
      if (node.source !== rt.source || node.flags !== rt.flags) rep.sourceOrFlagsDiffer.push(`${tag}: node ${node.source} ${node.flags} / rt ${rt.source} ${rt.flags}`);
      if (tsr.kind === "ok") {
        const same =
          hex(tsr.bytes) === hex(rt.bytes) &&
          tsr.captureCount === rt.captureCount &&
          JSON.stringify(tsr.groupNames) === JSON.stringify(rt.groupNames) &&
          tsr.source === rt.source &&
          tsr.flags === rt.flags;
        if (!same) rep.bytesDifferTs.push(`${tag}: ts ${hex(tsr.bytes)} ${tsr.source} / rt ${hex(rt.bytes)} ${rt.source}`);
      } else if (tsr.kind === "runtime") {
        rep.tsDeferred++; // the build time hands these texts to this compiler
      } else {
        rep.tsRefusesRtAccepts.push(`${tag}: ts ${JSON.stringify(tsr)}`);
      }
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
      if (tsr.kind === "ok" && node.kind === "ok") rep.fenceWhereTsBuilds.push(`${tag}: ${rt.key}`);
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

/** The two places the build-time pipeline (and so this compiler, which
 * follows it) emits different bytes from lre_compile, both pre-existing:
 *   - a `{0,N}` / `{1,N}` bound at or past 2^31-1 (parse_digits clamps it to
 *     INT32_MAX, which lre_compile then reads as "unbounded" and compiles
 *     as `*` / `+`; regex-assembler.ts keeps it a finite count);
 *   - `\k<name>` when groups of that name sit both before and after it
 *     (lre_compile's find_group_name lists only the ones already parsed;
 *     regex-parser.ts's scanCaptures lists all of them).
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
    `ts defers to the run-time compiler and it accepts ${rep.tsDeferred}; ts refuses / rt accepts ${rep.tsRefusesRtAccepts.length}; ts accepts / Node throws ${rep.tsAcceptsNodeThrows.length}; fence where ts builds ${rep.fenceWhereTsBuilds.length}`,
  ];
  const sample = (name: string, xs: string[]): void => {
    if (xs.length > 0) lines.push(`${name} (${xs.length}):\n  ${xs.slice(0, 40).map((x) => x.slice(0, 300)).join("\n  ")}`);
  };
  sample("HARD accepted where Node throws", rep.acceptedNodeThrows);
  sample("HARD source/flags differ", rep.sourceOrFlagsDiffer);
  sample("HARD wrong message", rep.wrongMessage);
  sample("HARD SyntaxError where Node accepts", rep.syntaxNodeAccepts);
  sample("HARD bytes differ from the build-time pipeline", rep.bytesDifferTs);
  sample("ts refuses, rt accepts", rep.tsRefusesRtAccepts);
  sample("ts accepts, Node throws", rep.tsAcceptsNodeThrows);
  sample("fence where ts builds", rep.fenceWhereTsBuilds);
  sample("HARD lre differs, not a known pipeline difference", rep.lreDiffUnknown);
  sample("lre ERR", rep.lreErr);
  return lines.join("\n");
}

describe("run-time RegExp compiler gate", () => {
  test("byte, verdict and message parity over the whole pool", () => {
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
    expect(rep.bytesDifferTs).toEqual([]);
    expect(rep.lreDiffUnknown).toEqual([]);
    // The build-time pipeline never builds a regex Node rejects: the two
    // classes it used to (a duplicate group name V8 rejects; `\k` inside a
    // class when the pattern has named groups) now defer to this compiler.
    expect(rep.tsAcceptsNodeThrows).toEqual([]);
    expect(rep.lreErr).toEqual([]);
  }, 1_200_000);
});
