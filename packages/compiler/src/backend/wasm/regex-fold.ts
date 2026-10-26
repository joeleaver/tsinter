/* Build-time regex outcomes for the emitter, from the ONE compiler
 * (follow-up unit E): every constant pattern — a regex literal, the
 * sticky clone a literal `.split()` receiver needs, a `new RegExp(p, f)`
 * whose texts fold — is compiled by running the run-time compiler
 * (regex-compiler.ts) in this process (regex-buildtime.ts). This file only
 * maps its outcome onto what each emitter site does with it:
 *
 *   - `new RegExp(p, f)`: a constructed value, a constant-folded V8
 *     SyntaxError (the compiler's own message, canonical flags), or — for
 *     a pattern outside the tier — the SAME named fence Error the run-time
 *     compiler throws (SEMANTICS.md S102), thrown at the call: a constant
 *     `new RegExp` in code that never runs must not refuse the program;
 *   - a regex literal: a constructed value, or a refusal — by the fence
 *     key, or `invalid-pattern` for a pattern Node rejects (an early
 *     SyntaxError: the whole script fails to load, which this tier does not
 *     model; TSC reports most of them first).
 *
 * The build-time compiler runs on the host's WasmGC. If it cannot be
 * instantiated or traps, the site refuses by name
 * (`build-time-compiler-unavailable`) rather than throwing out of the
 * compiler.
 *
 * The TypeScript pipeline that used to make these decisions (parser,
 * assembler, disposition layer, syntax-reason classifier) is gone; the
 * run-time compiler's gate (wasm-regex-runtime-compiler.test.ts) holds the
 * one compiler to Node and to libregexp's lre_compile. */
import { compileRegex, type RegexCompileOutcome } from "./regex-buildtime.js";

export const BUILD_TIME_UNAVAILABLE = "build-time-compiler-unavailable";

export type RegexFoldOutcome =
  | { kind: "ok"; source: string; flags: string; bytes: Uint8Array; captureCount: number; groupNames: string[] | null }
  | { kind: "syntax"; message: string }
  /** throw S102's named fence Error (message, code) at the call */
  | { kind: "fence"; key: string; message: string; code: string }
  | { kind: "refuse"; key: string };

export type RegexLiteralOutcome =
  | { kind: "ok"; source: string; flags: string; bytes: Uint8Array; captureCount: number; groupNames: string[] | null }
  | { kind: "refuse"; key: string };

function tryCompile(patternText: string, flagsText: string): RegexCompileOutcome | null {
  try {
    return compileRegex(patternText, flagsText);
  } catch {
    return null;
  }
}

export function foldRegexNew(patternText: string, flagsText: string): RegexFoldOutcome {
  return tryCompile(patternText, flagsText) ?? { kind: "refuse", key: BUILD_TIME_UNAVAILABLE };
}

export function foldRegexLiteral(patternText: string, flagsText: string): RegexLiteralOutcome {
  const r = tryCompile(patternText, flagsText);
  if (r === null) return { kind: "refuse", key: BUILD_TIME_UNAVAILABLE };
  if (r.kind === "fence") return { kind: "refuse", key: r.key };
  if (r.kind === "syntax") return { kind: "refuse", key: "invalid-pattern" };
  return r;
}
