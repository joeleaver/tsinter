/* The build-time `new RegExp(pattern, flags)` pipeline over pattern and
 * flags texts already known at compile time — factored out of emitter.ts's
 * `regex.new` case (unit P1) so the run-time compiler's gate
 * (wasm-regex-runtime-compiler.test.ts) runs the EXACT decision sequence
 * the emitter does, not a copy of it. The emitter turns each outcome into
 * code: a constructed value, a constant-folded SyntaxError throw, or a
 * refusal by name.
 *
 * Order (unchanged from the emitter's own): flags legality -> /v -> the
 * disposition layer (unicode-casefold, unported-unicode-property,
 * modifiers, Annex-B families) -> a genuine syntax error (exact V8 text for
 * the three structurally-decidable reasons, otherwise refused) -> assemble.
 *
 * Two corrections made with the run-time unit, both measured against
 * Node v24.18.1: the SyntaxError message carries the CANONICAL flags (V8
 * prints `/(/gi` for `new RegExp("(", "ig")`), and `.source` is V8's own
 * EscapeRegExpSource (a `/` inside a class, or one already escaped, is not
 * escaped again; a backslash before a line terminator is dropped). Three
 * internal assertions the pipeline could reach from a folded pattern (a
 * modifier group turning on /i under /u, more than 255 nested quantifier
 * registers, 65535 class ranges) used to throw out of the compiler; they
 * now refuse by name. */
import { assemble, collectGroupNames, type AssembleFlags } from "./regex-assembler.js";
import { canonicalFlagsV8, RX_PATTERN_SIZE_LIMIT } from "./regex-compiler-tables.js";
import { classifyRegexLitRefusal, usesUnicodeCasefold } from "./regex-disposition.js";
import type { RegexAst } from "./regex-ast.js";
import { parsePattern } from "./regex-parser.js";
import { classifyRegexSyntaxErrorReason, escapeRegExpPattern } from "./regex-syntax-reason.js";

export type RegexFoldOutcome =
  | { kind: "ok"; source: string; flags: string; bytes: Uint8Array; captureCount: number; groupNames: string[] | null }
  | { kind: "syntax"; message: string }
  | { kind: "refuse"; key: string }
  /** Defer to the run-time compiler (regex-compiler.ts) over the constant
   * texts: its verdict is V8's where this pipeline has no wording or is
   * known to accept what V8 rejects. `why` names the case. */
  | { kind: "runtime"; why: "unclassified-syntax-error" | "v8-only-rejection" | "unicode-casefold-syntax" };


/** Constructs this pipeline accepts but V8 rejects (gate rows): a group
 * name used twice (libregexp's duplicate check is looser than V8's), and
 * `\k` inside a class when the pattern has named groups ("Invalid
 * escape"). Both go to the run-time compiler, whose V8 rules decide. */
function v8OnlyRejectionCandidate(pattern: string, ast: RegexAst): boolean {
  const names = [...collectGroupNames(ast).values()].map((v) => v.name).filter((n): n is string => n !== null);
  if (new Set(names).size !== names.length) return true;
  if (names.length === 0) return false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      if (inClass && pattern[i + 1] === "k") return true;
      i++;
    } else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
  }
  return false;
}

const LEGAL_FLAG_CHARS = "dgimsuvy";

export function foldRegexNew(patternText: string, flagsText: string): RegexFoldOutcome {
  // Flags legality: an illegal or repeated letter is always V8's
  // "Invalid flags supplied to RegExp constructor '<flags>'", the raw
  // flags text echoed back, whatever this tier supports.
  const seen = new Set<string>();
  for (const c of flagsText) {
    if (!LEGAL_FLAG_CHARS.includes(c) || seen.has(c)) {
      return { kind: "syntax", message: `Invalid flags supplied to RegExp constructor '${flagsText}'` };
    }
    seen.add(c);
  }
  // u together with v is an invalid flags string (V8), before the /v fence.
  if (flagsText.includes("u") && flagsText.includes("v")) {
    return { kind: "syntax", message: `Invalid flags supplied to RegExp constructor '${flagsText}'` };
  }
  if (flagsText.includes("v")) return { kind: "refuse", key: "unicode-sets-flag" };

  const flags: AssembleFlags = {
    global: flagsText.includes("g"),
    ignoreCase: flagsText.includes("i"),
    multiLine: flagsText.includes("m"),
    dotAll: flagsText.includes("s"),
    unicode: flagsText.includes("u"),
    sticky: flagsText.includes("y"),
  };
  try {
    let ast: RegexAst | null = null;
    if (!usesUnicodeCasefold(flags.ignoreCase, flags.unicode)) {
      const parsed = parsePattern(patternText, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
      ast = parsed !== null && parsed.next === patternText.length ? parsed.ast : null;
    }
    const refusal = classifyRegexLitRefusal(patternText, ast, flags.ignoreCase, flags.multiLine, flags.dotAll, flags.unicode, parsePattern);
    if (refusal === "unicode-casefold") {
      // /iu is out of tier, but Node reports a syntax error first; the
      // grammar does not depend on /i, so the /u parse decides.
      const u = parsePattern(patternText, 0, true, false, flags.multiLine, flags.dotAll);
      if (u === null || u.next !== patternText.length) return { kind: "runtime", why: "unicode-casefold-syntax" };
    }
    if (refusal !== null) return { kind: "refuse", key: refusal };
    if (ast === null) {
      const reason = classifyRegexSyntaxErrorReason(patternText);
      if (reason === null) return { kind: "runtime", why: "unclassified-syntax-error" };
      return { kind: "syntax", message: `Invalid regular expression: /${patternText}/${canonicalFlagsV8(flagsText)}: ${reason}` };
    }
    if (v8OnlyRejectionCandidate(patternText, ast)) return { kind: "runtime", why: "v8-only-rejection" };
    if (patternText.length > RX_PATTERN_SIZE_LIMIT) return { kind: "refuse", key: "pattern-too-large" };
    const asm = assemble(ast, flags);
    const groupNamesMap = collectGroupNames(ast);
    const hasNamed = [...groupNamesMap.values()].some((v) => v.name !== null);
    return {
      kind: "ok",
      source: escapeRegExpPattern(patternText),
      flags: "dgimsuy"
        .split("")
        .filter((c) => flagsText.includes(c))
        .join(""),
      bytes: asm.bytes,
      captureCount: asm.captureCount,
      groupNames: hasNamed ? Array.from({ length: asm.captureCount - 1 }, (_, i) => groupNamesMap.get(i + 1)?.name ?? "") : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ignoreCase+isUnicode")) return { kind: "refuse", key: "modifiers" };
    if (msg.includes("too many imbricated quantifiers")) return { kind: "refuse", key: "too-many-registers" };
    if (msg.includes("too many ranges")) return { kind: "refuse", key: "too-many-ranges" };
    throw e;
  }
}
