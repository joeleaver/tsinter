/* The two byte-level helpers the URI codec (uri.ts) shares with the URL
 * machinery: %w.url.asciiLower and %w.url.hexVal. Kept byte-for-byte as
 * they were built (every module that reaches decodeURIComponent carries
 * them under these names).
 *
 * INC-29 U3 retired this file's former file-scheme subset of the URL
 * parser (fileURLToPath(string), which trapped by name on dot segments,
 * percent-decoded non-ASCII bytes and malformed escapes — SEMANTICS.md
 * S060, now retired): fileURLToPath runs through the WHATWG URL engine
 * (url-whatwg.ts, Node's ada) and is Node-exact. */
import { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

export interface UrlDeps {
  strRef: () => ValType;
  strType: () => number;
  /** Push an interned string literal. */
  lit: (c: Code, s: string) => void;
  /** Sets the pending-exception cell to a fresh error of `className` —
   * `emitSetCellError` exactly, no unwind attached (the SAME "own Code
   * buffer, own local numbering" contract `stream.ts`'s own
   * `setUncaughtError` documents: this builder's functions are hand-
   * built, never walked as an IrFunction, so a dep that reads "the
   * current function's own return type" would read the WRONG one). Every
   * call site in this file pushes its own return-type-correct
   * placeholder and `return_`s itself right after calling this. */
  setCellError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, codeLit: string | null) => void;
}

export class UrlBuilder {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: UrlDeps,
  ) {}

  private strRef(): ValType {
    return this.deps.strRef();
  }

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /** %w.url.asciiLower(ch: i32) -> i32 — 'A'-'Z' shift by 0x20, else
   * unchanged. A real helper (not inlined stack juggling) so every call
   * site is a plain `call`, never a local-numbering hazard. */
  private asciiLowerHelper(): number {
    return this.cached("url.asciiLower", [I32], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      c.localGet(CH);
      c.i32Const(0x41); // 'A'
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x5a); // 'Z'
      c.i32LeS();
      c.i32And();
      c.ifResult(I32);
      c.localGet(CH);
      c.i32Const(0x20);
      c.i32Add();
      c.else_();
      c.localGet(CH);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** %w.url.hexVal(ch: i32) -> i32 — the nibble value, or -1. Not private:
   * P5's uri.ts (str.decodeUriComponent's strict percent-escape grammar)
   * reuses this exact table via emitter.ts's dependency injection rather
   * than re-deriving it — board #130 is a stale-twin board about
   * DUPLICATED URI-encoder logic in the C lane; re-deriving this nibble
   * table here would mint that same defect shape in the wasm lane
   * (Q2, the LEAD's ruling, INC-25 P5 CP1 addendum — not Joe's; D4/D5
   * are Joe's own rulings this pass, Q1-Q3 are the lead's). */
  hexValHelper(): number {
    return this.cached("url.hexVal", [I32], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      const LOWER = 1;
      c.localGet(CH);
      c.i32Const(0x30);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x39);
      c.i32LeS();
      c.i32And();
      c.ifResult(I32);
      c.localGet(CH);
      c.i32Const(0x30);
      c.i32Sub();
      c.else_();
      c.localGet(CH);
      c.call(this.asciiLowerHelper());
      c.localSet(LOWER);
      c.localGet(LOWER);
      c.i32Const(0x61);
      c.i32GeS();
      c.localGet(LOWER);
      c.i32Const(0x66);
      c.i32LeS();
      c.i32And();
      c.ifResult(I32);
      c.localGet(LOWER);
      c.i32Const(0x61);
      c.i32Sub();
      c.i32Const(10);
      c.i32Add();
      c.else_();
      c.i32Const(-1);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32 /* LOWER=1 */], c.bytes());
    });
  }
}
