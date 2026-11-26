/* Unit S125-J, M0 (SEMANTICS.md S125 amendment (J)): arm-failure
 * attribution. A refused S125 copy at a site where the compiler first
 * tried to share the value (U2's dynamic arm, an A4 boxed instance, or
 * S125 (a)'s per-call-site instance) and that attempt did not lower names
 * the attempt and the first diagnostic its lowering reported. The copy and
 * its refusal are unchanged; only the diagnostic's text grows, so a census
 * can tell an S125 problem from a blocker inside the callee.
 *
 * The record outlives a pass: lowerToIr hands every arm round one map, so
 * a failure seen in an earlier round still names itself in the round whose
 * diagnostics are reported. The first failure at a site wins. */
import { dirname, relative } from "node:path";
import * as ts from "../ts7/adapter.js";
import type { SrcLoc } from "../../ir/nodes.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";

/** What was tried at the site: the dynamic arm (U2a, A4) or S125 (a)'s
 * instance typed by the argument's own type — or (L) the async result arm,
 * which a use of the function other than `await f(…)` keeps from being
 * taken (dyn-arm-async.ts). */
export type ArmTry = "arm" | "share" | "async";

/** Why an attempt did not lower: the first diagnostic's code and
 * message, and where it was reported — kept apart so the note can name
 * that place relative to the refused site, the same on every machine. */
export interface FailureText {
  text: string;
  at?: { file: string; line: number };
}

export interface ArmFailure {
  kind: ArmTry;
  /** The first diagnostic of the failed lowering. */
  why: FailureText;
}

/** Site → first failure, shared across the arm rounds of one build. */
export type ArmFailures = Map<string, ArmFailure>;

const siteKey = (loc: SrcLoc): string => `${loc.file}:${loc.start}:${loc.end}`;

/** The longest callee message kept whole; longer ones end in an ellipsis. */
const MAX_MESSAGE = 240;

/** A diagnostic as the attribution names it: code, message, and where. */
export function describeDiag(L: Lowerer, d: ScrDiagnostic): FailureText {
  const msg = d.message.length > MAX_MESSAGE ? `${d.message.slice(0, MAX_MESSAGE - 1)}…` : d.message;
  const sf = L.program.getSourceFile(d.loc.file);
  const text = `${d.code} ${msg}`;
  return sf !== undefined ? { text, at: { file: d.loc.file, line: ts.getLineAndCharacterOfPosition(sf, d.loc.start).line + 1 } } : { text };
}

/** Records that the attempt `kind` made for the value at each of `locs`
 * (the argument, and the argument without its parentheses) failed. */
export function noteArmFailure(L: Lowerer, locs: SrcLoc[], kind: ArmTry, why: FailureText): void {
  for (const loc of locs) {
    const k = siteKey(loc);
    if (!L.armFailures.has(k)) L.armFailures.set(k, { kind, why });
  }
}

/** The text a refused S125 copy at `loc` gains: empty unless an attempt to
 * share the value there failed. */
export function armFailureNote(L: Lowerer, loc: SrcLoc): string {
  const f = L.armFailures.get(siteKey(loc));
  if (f === undefined) return "";
  if (f.kind === "async") return ` (the async function's result arm (S125 (L)) was not taken: ${f.why.text}${where(loc, f.why)})`;
  const what = f.kind === "arm" ? "the dynamic arm" : "the instance that shares the object (S125 (a))";
  return ` (${what} was tried here and did not lower: ${f.why.text}${where(loc, f.why)})`;
}

/** Where the failure was reported, from the refused site: its line when
 * it is in the site's own file, otherwise the file relative to the
 * site's directory (never an absolute path, which would name the
 * machine the build ran on). */
function where(site: SrcLoc, why: FailureText): string {
  if (why.at === undefined) return "";
  if (why.at.file === site.file) return ` [line ${why.at.line}]`;
  const rel = relative(dirname(site.file), why.at.file).split("\\").join("/");
  return ` [${rel}:${why.at.line}]`;
}
