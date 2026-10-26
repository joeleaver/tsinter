/* The literal-operand float fold every lane applies where V8's parser folds
 * (SEMANTICS.md S036): the wasm tier folds + - * / % ** with it, the native
 * lanes fold `**` with it (their other operators reach the C compiler's own
 * folding). `**` is computed by pow.ts's jsPowValue -- the transcription of
 * the run-time helper -- never by the compiling host's own pow. */
import type { IrExpr } from "../ir/nodes.js";
import { jsPowValue } from "./wasm/pow.js";

/** Attempts to fold `e` to a plain host number -- RECURSIVE over
 * literal-derived float arithmetic, mirroring V8's OWN measured
 * constant-folding boundary (SEMANTICS.md S036 has the full table), not a
 * general partial evaluator:
 *  - a `numLit` folds to its value, UNLESS that value is EXACTLY
 *    +/-Infinity: `Infinity`/`NaN` as source globals lower to a BARE
 *    numLit with no other marker (lower-exprs.ts), so a numLit holding
 *    +/-Infinity AT A LEAF POSITION is, in this IR, indistinguishable from
 *    the bare `Infinity` global — which V8 measurably does NOT
 *    constant-fold (`Infinity-Infinity`, `0*Infinity`: the runtime/hardware
 *    NaN pattern, not canonical). Treating a leaf-position Infinity as
 *    unfoldable (poisoning its containing expression) reproduces that
 *    boundary exactly. `NaN` has no equivalent ambiguity — there is no
 *    OTHER way to spell a NaN-valued numLit — so it folds normally alongside
 *    ordinary finite literals (`NaN+1`, `NaN*2`: both measured to fold).
 *  - a `bin` node with a foldable op folds if BOTH operands (recursively)
 *    fold — this is what lets a literal-DERIVED Infinity, e.g. `1/0`,
 *    re-enter the fold pool for an ENCLOSING expression like `(1/0)-(1/0)`
 *    (measured to fold), even though a BARE `Infinity` leaf cannot: the
 *    poison rule above only fires for a numLit reached DIRECTLY, not for a
 *    value that arrived by recursively folding a sub-expression.
 *  - a unary `-` over a foldable operand folds (its negation) — covers
 *    `-(1/0)`-shaped expressions; `-0`/`-Infinity`/`-NaN` never reach this
 *    arm because lowerPrefixUnary already pre-folds unary-minus directly
 *    over a numLit operand into a signed numLit itself.
 *  - anything else (varRef, calls, ...) does not fold: NO constant
 *    propagation, no variable lookthrough, by design (measured: `const z =
 *    0; z / z` stays a genuine runtime division on Node too — folding it
 *    would be the INVERSE divergence).
 * A NaN result's bits are not this function's business: callers emit the
 * canonical quiet NaN for it (the bits V8's folded constant has). */
export function foldFloatConst(e: IrExpr): number | undefined {
  if (e.kind === "numLit") {
    if (e.value === Infinity || e.value === -Infinity) return undefined;
    return e.value;
  }
  if (e.kind === "unary" && e.op === "-") {
    const v = foldFloatConst(e.operand);
    return v === undefined ? undefined : -v;
  }
  if (e.kind === "bin") {
    if (e.op !== "+" && e.op !== "-" && e.op !== "*" && e.op !== "/" && e.op !== "%" && e.op !== "**") {
      return undefined;
    }
    const l = foldFloatConst(e.left);
    if (l === undefined) return undefined;
    const r = foldFloatConst(e.right);
    if (r === undefined) return undefined;
    switch (e.op) {
      case "+": return l + r;
      case "-": return l - r;
      case "*": return l * r;
      case "/": return l / r;
      case "%": return l % r;
      // The tier's own `**` (pow.ts), never the compiling host's: the same
      // arms and bits the run-time helper computes.
      case "**": return jsPowValue(l, r);
    }
  }
  return undefined;
}

/** True when `e` reads the `NaN` global somewhere (a bare NaN-valued numLit:
 * there is no other way to spell one). */
function readsNaNGlobal(e: IrExpr): boolean {
  if (e.kind === "numLit") return Number.isNaN(e.value);
  if (e.kind === "unary") return readsNaNGlobal(e.operand);
  if (e.kind === "bin") return readsNaNGlobal(e.left) || readsNaNGlobal(e.right);
  return false;
}

/** A unary minus over a literal-only operand V8's parser folds -- `-(0/0)`,
 * `-((-8) ** 1.5)` -- folds WITH it, on every lane: Node's result is one
 * constant, and a NaN constant is the canonical quiet NaN, never the
 * negation of one (`7ff8000000000000`, measured). An operand that reads the
 * `NaN` global does not fold (V8 reads the global at run time: `-NaN` and
 * `-(NaN + 1)` are `fff8000000000000`), nor does a bare numLit (the
 * frontend has already folded `-literal` into a signed numLit). Undefined
 * when the negation is a run-time one. */
export function foldNegation(e: IrExpr): number | undefined {
  if (e.kind !== "unary" || e.op !== "-" || e.operand.kind === "numLit") return undefined;
  if (readsNaNGlobal(e.operand)) return undefined;
  const v = foldFloatConst(e.operand);
  return v === undefined ? undefined : -v;
}
