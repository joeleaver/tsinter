/* increment 23 P3, rider 2 — the FILE-SCHEME SUBSET of scr_url.c's URL
 * parser (reference: scr_url.c:344-709, `scr_url_new` + `parse_rooted_path`
 * + `scr_url_to_path_impl`'s posix arm). Builds ONLY what `url.fileURLToPath
 * (str)` needs: a `file:` scheme string parses to an absolute POSIX path,
 * byte-exact against Node v24.18.1 (the oracle — the C source is a
 * reference for the ALGORITHM SHAPE, never an authority over Node's own
 * observable behavior).
 *
 * rev-23's axis-D sweep (increment 23 P3 fix round F2-p3, plus a class-4
 * follow-up ruling) found and closed real, corpus-reachable silent-wrong-
 * path bugs: query strings, fragments, backslash-as-separator (file: is a
 * WHATWG SPECIAL scheme — LOUD in scheme position, since it changes the
 * slash-count bucket, not just invisible mid-path), AND raw non-ASCII
 * path bytes (Node's own parser percent-encodes-then-decodes a raw code
 * unit LOSSLESSLY except for an unpaired surrogate, which becomes U+FFFD
 * — this tier reproduces exactly that, needing no UTF-8 byte machinery
 * for the raw side at all) all now match Node exactly (measured against
 * wide matrices: interleaved / and \ runs, query/fragment chars landing
 * inside what would otherwise be the authority span, a real astral
 * character round-tripping as its own intact surrogate pair). See
 * SEMANTICS.md S060 for what remains NARROWER than Node on purpose:
 *   - Dot-segment resolution (".", "..") is NOT ported — Node's own WHATWG
 *     parser collapses these at parse time (measured: `file:///a/../b` ->
 *     `/b`); this tier detects a bare dot-segment (RAW *or* the %2e/%2E
 *     percent-encoded spellings — both close this pass, F-3) and traps by
 *     name instead of returning the uncollapsed form.
 *   - Non-ASCII path bytes reached via a PERCENT ESCAPE ONLY (the raw
 *     half is fixed, see above) — a percent-decoded byte >= 0x80 (F-1(4))
 *     — is NOT UTF-8-decoded: the C reference's own `enc_path` step and a
 *     real UTF-8-decode-with-surrogate-emission step need machinery this
 *     rider does not build (2385, the ONE corpus program this rider
 *     claims, uses only ASCII paths; 1356/1611, the two OTHER corpus
 *     programs that reach this parser, do not CLAIM through it either way
 *     — both refuse earlier, at `url.href`/`process.cwd`). Traps by name.
 *   - A malformed percent-escape (not exactly 2 hex digits after '%', or
 *     not enough characters left) is NOT ported either (F-1(4b)): Node
 *     throws a catchable `URIError: "URI malformed"` for every case
 *     measured (a lone/trailing '%', non-hex digits, a truncated multi-
 *     byte lead, an invalid/overlong/surrogate-encoding sequence) — this
 *     tier has no URIError class (RUNTIME_ERROR_CLASSES: Error/TypeError/
 *     RangeError/SyntaxError/DOMException only; adding one is not cheap
 *     this round) so it traps by name instead, same style as its sibling
 *     above — a future real UTF-8 decoder must trap every one of these
 *     invalid-sequence classes under this SAME mechanism, or it silently
 *     reintroduces this exact bug on the inputs this round closed.
 * Posix arm only (this runtime never targets win32).
 *
 * `url.fileURLToPathStr` is the string-receiver form lower-builtins.ts's
 * own `fileURLToPath(str)` lowering already produces (`url.
 * fileURLToPathUrl`, the URL-VALUE receiver form, is a DIFFERENT rider's
 * job — out of scope here, per the brief's own "claims 2385 ONLY"). */
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

  /** %w.url.hexVal(ch: i32) -> i32 — the nibble value, or -1. */
  private hexValHelper(): number {
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

  /** %w.url.trimAndStrip(input: str) -> str — WHATWG's own pre-filter
   * (scr_url.c:344-361): strip leading/trailing C0-or-space, then every
   * embedded TAB/LF/CR. A fresh, exact-length string; every later offset
   * in `fileURLToPathStr` is relative to THIS text, never the raw input. */
  private trimAndStripHelper(): number {
    const strT = this.deps.strType();
    return this.cached("url.trimAndStrip", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const INPUT = 0;
      const LEN = 1;
      const B = 2;
      const E = 3;
      const I = 4;
      const CH = 5;
      const OUT = 6;
      const OUTLEN = 7;
      const RESULT = 8;

      c.localGet(INPUT);
      c.arrayLen();
      c.localSet(LEN);
      c.i32Const(0);
      c.localSet(B);
      c.block();
      c.loop();
      c.localGet(B);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(B);
      c.arrayGetU(strT);
      c.i32Const(0x20);
      c.i32GtS();
      c.brIf(1);
      c.localGet(B);
      c.i32Const(1);
      c.i32Add();
      c.localSet(B);
      c.br(0);
      c.end();
      c.end();
      c.localGet(LEN);
      c.localSet(E);
      c.block();
      c.loop();
      c.localGet(E);
      c.localGet(B);
      c.i32LeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(E);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.i32Const(0x20);
      c.i32GtS();
      c.brIf(1);
      c.localGet(E);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(E);
      c.br(0);
      c.end();
      c.end();
      // Filtered copy over [B, E): skip TAB(0x09)/LF(0x0a)/CR(0x0d).
      c.localGet(E);
      c.localGet(B);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(OUTLEN);
      c.localGet(B);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(E);
      c.i32GeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x09);
      c.i32Eq();
      c.localGet(CH);
      c.i32Const(0x0a);
      c.i32Eq();
      c.i32Or();
      c.localGet(CH);
      c.i32Const(0x0d);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.else_();
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.localGet(CH);
      c.arraySet(strT);
      c.localGet(OUTLEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OUTLEN);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUTLEN);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(OUTLEN);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      this.mb.setBody(
        idx,
        [I32 /* LEN=1 */, I32 /* B=2 */, I32 /* E=3 */, I32 /* I=4 */, I32 /* CH=5 */, this.strRef() /* OUT=6 */, I32 /* OUTLEN=7 */, this.strRef() /* RESULT=8 */],
        c.bytes(),
      );
    });
  }

  /** %w.url.fileURLToPathStr(input: str) -> str, may-throw — the
   * string-receiver form of `fileURLToPath`. Every message is byte-exact
   * against Node v24.18.1 (own measurement, plan.txt §2a; F-1's fix round
   * re-measured the query/fragment/backslash matrix fresh, see SEMANTICS.md
   * S060). */
  fileURLToPathStr(): number {
    const strT = this.deps.strType();
    return this.cached("url.fileURLToPathStr", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const RAW = 0;
      const INPUT = 1;
      const LEN = 2;
      const SCHEME_LEN = 3;
      const CH = 4;
      const REST = 5;
      const SLASHES = 6;
      const AUTH_START = 7;
      const AUTH_END = 8;
      const HOST_LEN = 9;
      const PATH_START = 10;
      const PATH_END = 11;
      const OUT = 12;
      const OUTLEN = 13;
      const I = 14;
      const SEG_START = 15;
      const SEGLEN = 16;
      const HI = 17;
      const LO = 18;
      const DEC = 19;
      const RESULT = 20;
      const HOSTMATCH = 21;
      const EFFLEN = 22;
      const NEXTCH = 23;

      const throwInvalidUrl = (): void => {
        this.deps.setCellError(
c,
"%TypeError",
"TypeError", (x) => this.deps.lit(x, "Invalid URL"), "ERR_INVALID_URL");
        c.refNull(strT);
        c.return_();
      };

      c.localGet(RAW);
      c.call(this.trimAndStripHelper());
      c.localSet(INPUT);
      c.localGet(INPUT);
      c.arrayLen();
      c.localSet(LEN);

      // ── scheme: [A-Za-z][A-Za-z0-9+-.]* ":" (scr_url.c:363-378).
      c.i32Const(0);
      c.localSet(SCHEME_LEN);
      c.localGet(LEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(INPUT);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x41);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x5a);
      c.i32LeS();
      c.i32And();
      c.localGet(CH);
      c.i32Const(0x61);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x7a);
      c.i32LeS();
      c.i32And();
      c.i32Or();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(SCHEME_LEN);
      c.end();
      c.end();
      c.localGet(SCHEME_LEN);
      c.i32Const(0);
      c.i32Ne();
      c.ifVoid();
      c.block();
      c.loop();
      c.localGet(SCHEME_LEN);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(SCHEME_LEN);
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x41);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x5a);
      c.i32LeS();
      c.i32And();
      c.localGet(CH);
      c.i32Const(0x61);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x7a);
      c.i32LeS();
      c.i32And();
      c.i32Or();
      c.localGet(CH);
      c.i32Const(0x30);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x39);
      c.i32LeS();
      c.i32And();
      c.i32Or();
      c.localGet(CH);
      c.i32Const(0x2b); // '+'
      c.i32Eq();
      c.i32Or();
      c.localGet(CH);
      c.i32Const(0x2d); // '-'
      c.i32Eq();
      c.i32Or();
      c.localGet(CH);
      c.i32Const(0x2e); // '.'
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(SCHEME_LEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(SCHEME_LEN);
      c.br(0);
      c.end();
      c.end();
      c.end();
      c.localGet(SCHEME_LEN);
      c.i32Const(0);
      c.i32Eq();
      c.localGet(SCHEME_LEN);
      c.localGet(LEN);
      c.i32GeS();
      c.i32Or();
      c.ifVoid();
      throwInvalidUrl();
      c.end();
      c.localGet(INPUT);
      c.localGet(SCHEME_LEN);
      c.arrayGetU(strT);
      c.i32Const(0x3a); // ':'
      c.i32Ne();
      c.ifVoid();
      throwInvalidUrl();
      c.end();

      // scheme must be exactly "file" case-insensitively.
      c.localGet(SCHEME_LEN);
      c.i32Const(4);
      c.i32Ne();
      c.ifVoid();
      this.deps.setCellError(
c,
"%TypeError",
"TypeError", (x) => this.deps.lit(x, "The URL must be of scheme file"), "ERR_INVALID_URL_SCHEME");
      c.refNull(strT);
      c.return_();
      c.end();
      const schemeMatches = "file";
      for (let k = 0; k < 4; k++) {
        c.localGet(INPUT);
        c.i32Const(k);
        c.arrayGetU(strT);
        c.call(this.asciiLowerHelper());
        c.i32Const(schemeMatches.charCodeAt(k));
        c.i32Ne();
        c.ifVoid();
        this.deps.setCellError(
c,
"%TypeError",
"TypeError", (x) => this.deps.lit(x, "The URL must be of scheme file"), "ERR_INVALID_URL_SCHEME");
        c.refNull(strT);
        c.return_();
        c.end();
      }

      // ── authority/path (scr_url.c:411-463's is_file branch).
      c.localGet(SCHEME_LEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(REST);

      // ── EFFLEN: truncate at the first UNESCAPED '?' or '#' (F-1(1)/(2),
      // rev-23 axis-D) — Node's own generic URL parser splits query/
      // fragment off the WHOLE remainder (authority AND path both) BEFORE
      // any special-scheme state runs; a raw '?'/'#' landing inside what
      // would otherwise be the AUTHORITY span still cuts it short there
      // too, not just the path (measured: `file://localhost?x/foo` -> "/",
      // NOT a "localhost?x" host mismatch). A percent-escaped %3F/%23 is
      // not a RAW byte, so this raw-byte scan never sees it — it survives
      // to decode as a literal '?'/'#' later (measured: `file:///tmp/%3F`
      // -> "/tmp/?"; `file:///tmp/x%3Fq=1` -> "/tmp/x?q=1").
      c.localGet(LEN);
      c.localSet(EFFLEN);
      c.localGet(REST);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x3f); // '?'
      c.i32Eq();
      c.localGet(CH);
      c.i32Const(0x23); // '#'
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.localGet(I);
      c.localSet(EFFLEN);
      c.br(2); // the `if` itself is depth 0, the loop is depth 1 — depth
      // 2 is the enclosing `block`, the one that actually exits this scan
      // (an earlier off-by-one here — `br(1)`, which only re-enters the
      // loop with I unchanged — looped forever on the FIRST '?'/'#' byte;
      // caught by actually running the new pins, not by review).
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      // '\' is treated EXACTLY like '/' everywhere below — `file:` is a
      // WHATWG SPECIAL scheme, where a raw backslash is a path separator
      // too (F-1(3), measured against a full mixed / and \ matrix,
      // including interleaved runs: `file:/\/tmp/x` -> "/tmp/x",
      // `file:\/\/tmp/x` -> "//tmp/x", `file://localhost\tmp\x` -> "/tmp/x"
      // — every case matches treating '\' as a plain slash-equivalent
      // EVERYWHERE a raw '/' is tested below, with NO other special-
      // casing needed). The percent-decode copy loop is the ONE place a
      // raw backslash actually gets WRITTEN — as '/' (Node never emits a
      // literal '\' in a posix path; measured: `file:///tmp/a\b` ->
      // "/tmp/a/b"). A percent-ESCAPED backslash (%5C/%5c) is a decoded
      // BYTE, not this raw-byte normalization's concern, and is left
      // alone (measured: `file:///tmp/a%5cb` -> "/tmp/a\\b", a literal
      // backslash IN the output — Node's own normalization runs on raw
      // URL characters only, before percent-decoding happens).
      c.i32Const(0);
      c.localSet(SLASHES);
      c.block();
      c.loop();
      c.localGet(REST);
      c.localGet(SLASHES);
      c.i32Add();
      c.localGet(EFFLEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(REST);
      c.localGet(SLASHES);
      c.i32Add();
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x2f);
      c.i32Eq();
      c.localGet(CH);
      c.i32Const(0x5c);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(SLASHES);
      c.i32Const(1);
      c.i32Add();
      c.localSet(SLASHES);
      c.br(0);
      c.end();
      c.end();

      c.i32Const(0);
      c.localSet(HOST_LEN);
      c.i32Const(0);
      c.localSet(AUTH_START);
      c.localGet(SLASHES);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.localGet(REST);
      c.i32Const(2);
      c.i32Add();
      c.localSet(AUTH_START);
      c.localGet(AUTH_START);
      c.localSet(AUTH_END);
      c.block();
      c.loop();
      c.localGet(AUTH_END);
      c.localGet(EFFLEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(AUTH_END);
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x2f);
      c.i32Eq();
      c.localGet(CH);
      c.i32Const(0x5c);
      c.i32Eq();
      c.i32Or();
      c.brIf(1);
      c.localGet(AUTH_END);
      c.i32Const(1);
      c.i32Add();
      c.localSet(AUTH_END);
      c.br(0);
      c.end();
      c.end();
      c.localGet(AUTH_END);
      c.localGet(AUTH_START);
      c.i32Sub();
      c.localSet(HOST_LEN);
      c.localGet(AUTH_END);
      c.localSet(PATH_START);
      c.else_();
      c.localGet(SLASHES);
      c.i32Const(2);
      c.i32GtS();
      c.ifResult(I32);
      c.i32Const(2);
      c.else_();
      c.localGet(SLASHES);
      c.end();
      c.localSet(SLASHES); // reused: "skip" count now
      c.localGet(REST);
      c.localGet(SLASHES);
      c.i32Add();
      c.localSet(PATH_START);
      c.end();

      // "localhost" (case-insensitive) empties the host.
      c.localGet(HOST_LEN);
      c.i32Const(9);
      c.i32Eq();
      c.ifVoid();
      const localhost = "localhost";
      c.i32Const(1);
      c.localSet(HOSTMATCH);
      for (let k = 0; k < 9; k++) {
        c.localGet(INPUT);
        c.localGet(AUTH_START);
        c.i32Const(k);
        c.i32Add();
        c.arrayGetU(strT);
        c.call(this.asciiLowerHelper());
        c.i32Const(localhost.charCodeAt(k));
        c.i32Eq();
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0);
        c.localSet(HOSTMATCH);
        c.end();
      }
      c.localGet(HOSTMATCH);
      c.ifVoid();
      c.i32Const(0);
      c.localSet(HOST_LEN);
      c.end();
      c.end();

      c.localGet(HOST_LEN);
      c.i32Const(0);
      c.i32Ne();
      c.ifVoid();
      this.deps.setCellError(
c,
"%TypeError",
"TypeError",
        (x) => this.deps.lit(x, 'File URL host must be "localhost" or empty on linux'),
        "ERR_INVALID_FILE_URL_HOST",
      );
      c.refNull(strT);
      c.return_();
      c.end();

      c.localGet(EFFLEN);
      c.localSet(PATH_END);

      // ── percent-decode [PATH_START, PATH_END). Every raw, non-percent
      // byte is copied through unchanged EXCEPT: '\', normalized to '/'
      // (F-1(3)); and a raw non-ASCII code unit, which Node's own parser
      // percent-encodes-then-decodes losslessly on the way through — a
      // round trip this tier does NOT need to actually perform, since a
      // raw code unit is already the value that round trip would produce
      // (measured, class-4 amendment: raw é/astral/U+0080 all pass
      // through Node UNCHANGED, no throw — the EARLIER raw-code-unit
      // trap this file used to have here was ITSELF a divergence, firing
      // on inputs Node accepts; removed). The ONE exception Node's own
      // WHATWG encode step does NOT leave alone is an UNPAIRED
      // (lone) surrogate — Node's percent-encode substitutes U+FFFD for
      // it (measured: a lone `\uD800` -> U+FFFD, not itself; a REAL
      // (paired) astral character round-trips as its own intact
      // surrogate pair, unchanged) — this tier reproduces that ONE
      // special case directly on the raw code units, needing no byte-
      // level UTF-8 machinery at all for the raw side.
      // Every '%' now MUST resolve to a genuine 2-hex-digit escape
      // (F-1(4b) — a malformed one used to fall through and copy the
      // literal '%' through; Node throws `URIError: URI malformed` for
      // every case measured: a lone or trailing '%', non-hex digits, a
      // truncated multi-byte UTF-8 lead — this tier has no URIError
      // class, not cheap to add this round, so it traps by name instead,
      // same style/class as its siblings). A decoded byte >= 0x80 traps
      // too (S060(b), now covering ONLY the percent-decoded side — the
      // raw side above is FIXED, no longer a divergence): `file:///tmp/
      // %C3%A9` decodes to bytes that ARE valid UTF-8 for 'é' (%C3%A9 IS
      // this EXACT input, byte-for-byte, on 1356's own line 9), but this
      // tier has no UTF-8-decode-with-surrogate-emission step built this
      // round — a scope call, not an oversight: 1356 and 1611 (the
      // astral U+1F30D case) are not CLAIMED by this rider whichever way
      // this is built — both refuse earlier, at `url.href`/`process.cwd`
      // respectively — so the choice is invisible to the corpus census
      // either way; the byte-wise trap is the cheaper, lower-risk one to
      // land correctly in a bounded fix round, matching rev-23's own
      // "cheapest honest fix" framing — real UTF-8 decoding (which
      // WOULD need to trap all 7 measured invalid-sequence classes under
      // this SAME named mechanism, not just emit whatever bytes decode)
      // stays open for whichever future rider next touches this parser.
      // ROOTING (scr_url.c's own parse_rooted_path comment: "treats one
      // leading sep as the root; prepend one if absent so 'tmp' parses as
      // '/tmp'" — special URLs, file: included, never have an empty path
      // either): the 2-slash authority form always has PATH_START
      // pointing AT a '/' or '\' already (AUTH_END's own scan stops
      // there); the host-less 0/1-slash forms and the empty-path form do
      // not, so a leading '/' is prepended there and ONLY there — never
      // doubled.
      c.localGet(PATH_END);
      c.localGet(PATH_START);
      c.i32Sub();
      c.i32Const(2);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(OUTLEN);
      c.localGet(PATH_START);
      c.localGet(PATH_END);
      c.i32GeS();
      c.ifResult(I32);
      c.i32Const(1); // empty path: needs rooting
      c.else_();
      c.localGet(INPUT);
      c.localGet(PATH_START);
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x2f);
      c.i32Ne();
      c.localGet(CH);
      c.i32Const(0x5c);
      c.i32Ne();
      c.i32And();
      c.end();
      c.ifVoid();
      c.localGet(OUT);
      c.i32Const(0);
      c.i32Const(0x2f);
      c.arraySet(strT);
      c.i32Const(1);
      c.localSet(OUTLEN);
      c.end();
      c.localGet(PATH_START);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(PATH_END);
      c.i32GeS();
      c.brIf(1);
      c.localGet(INPUT);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x25); // '%'
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(2);
      c.i32Add();
      c.localGet(PATH_END);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(INPUT);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strT);
      c.call(this.hexValHelper());
      c.localSet(HI);
      c.localGet(INPUT);
      c.localGet(I);
      c.i32Const(2);
      c.i32Add();
      c.arrayGetU(strT);
      c.call(this.hexValHelper());
      c.localSet(LO);
      c.localGet(HI);
      c.i32Const(0);
      c.i32GeS();
      c.localGet(LO);
      c.i32Const(0);
      c.i32GeS();
      c.i32And();
      c.else_();
      c.i32Const(0); // not enough room for 2 hex digits
      c.end();
      c.ifVoid();
      c.localGet(HI);
      c.i32Const(4);
      c.i32Shl();
      c.localGet(LO);
      c.i32Or();
      c.localSet(DEC);
      c.localGet(DEC);
      c.i32Const(0x2f);
      c.i32Eq();
      c.ifVoid();
      this.deps.setCellError(
c,
"%TypeError",
"TypeError",
        (x) => this.deps.lit(x, "File URL path must not include encoded / characters"),
        "ERR_INVALID_FILE_URL_PATH",
      );
      c.refNull(strT);
      c.return_();
      c.end();
      c.localGet(DEC);
      c.i32Const(0x80);
      c.i32GeS();
      c.ifVoid();
      this.deps.setCellError(
c,
"%TypeError",
"TypeError",
        (x) =>
          this.deps.lit(
            x,
            "non-ASCII fileURLToPath paths are not supported yet (SEMANTICS.md S060)",
          ),
        null,
      );
      c.refNull(strT);
      c.return_();
      c.end();
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.localGet(DEC);
      c.arraySet(strT);
      c.localGet(OUTLEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OUTLEN);
      c.localGet(I);
      c.i32Const(3);
      c.i32Add();
      c.localSet(I);
      c.else_();
      this.deps.setCellError(
c,
"%TypeError",
"TypeError",
        (x) =>
          this.deps.lit(
            x,
            "malformed percent-escape in a file URL path is not supported yet (SEMANTICS.md S060)",
          ),
        null,
      );
      c.refNull(strT);
      c.return_();
      c.end();
      c.else_();
      // literal (non-percent) branch. Four cases, in order: backslash
      // (normalize to '/'); a high surrogate with a valid following low
      // surrogate (copy the PAIR through verbatim — a real astral char
      // round-trips intact); a lone (unpaired) surrogate, high or low
      // (substitute U+FFFD, Node's own WHATWG-encode behavior); anything
      // else, including ordinary non-ASCII code units (copy through
      // unchanged — class-4 amendment, see the comment above).
      c.localGet(CH);
      c.i32Const(0x5c);
      c.i32Eq();
      c.ifVoid();
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.i32Const(0x2f);
      c.arraySet(strT);
      c.localGet(OUTLEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OUTLEN);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.else_();
      c.localGet(CH);
      c.i32Const(0xd800);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0xdbff);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(PATH_END);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(INPUT);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strT);
      c.localSet(NEXTCH);
      c.localGet(NEXTCH);
      c.i32Const(0xdc00);
      c.i32GeS();
      c.localGet(NEXTCH);
      c.i32Const(0xdfff);
      c.i32LeS();
      c.i32And();
      c.else_();
      c.i32Const(0);
      c.end();
      c.ifVoid();
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.localGet(CH);
      c.arraySet(strT);
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.i32Const(1);
      c.i32Add();
      c.localGet(NEXTCH);
      c.arraySet(strT);
      c.localGet(OUTLEN);
      c.i32Const(2);
      c.i32Add();
      c.localSet(OUTLEN);
      c.localGet(I);
      c.i32Const(2);
      c.i32Add();
      c.localSet(I);
      c.else_();
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.i32Const(0xfffd);
      c.arraySet(strT);
      c.localGet(OUTLEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OUTLEN);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.end();
      c.else_();
      c.localGet(CH);
      c.i32Const(0xdc00);
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0xdfff);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.i32Const(0xfffd);
      c.arraySet(strT);
      c.localGet(OUTLEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OUTLEN);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.else_();
      c.localGet(OUT);
      c.localGet(OUTLEN);
      c.localGet(CH);
      c.arraySet(strT);
      c.localGet(OUTLEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OUTLEN);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.end(); // closes E (isLowSurr)
      c.end(); // closes B (isHighSurr)
      c.end(); // closes A (backslash)
      c.end(); // closes the ISPERCENT-IF itself (the missing one — an
      // early build hit "expected 0 elements on the stack for fallthru,
      // found 1": A/B/D/E's own closes are for the NEW nesting this
      // branch added, but the ISPERCENT-IF opened long before any of
      // that and still needs its own terminating end(), separate from
      // (one more than) what the OLD single-ifResult literal branch
      // needed — caught by actually instantiating the module, not by
      // review or by the type checker.
      c.br(0);
      c.end();
      c.end();

      // ── dot-segment scope trap, ON DECODED SEGMENTS (F-3 — S060(a)'s
      // own heading always claimed "traps by name", but its body let the
      // %2e/%2E percent-encoded spellings pass straight through
      // undetected. Percent-decoding has already happened by this point,
      // and OUT is guaranteed to contain no '/' from decoding (a decoded
      // '/' throws above; a raw '\' was already normalized to '/' during
      // the copy), so '/' is OUT's one and only segment delimiter — this
      // scan closes BOTH spellings with the identical mechanism the old
      // raw-byte version used, just reading OUT instead of INPUT (measured:
      // `file:///a/%2e%2e/b`, `file:///a/.%2e/b`, `file:///a/%2e./b` all
      // now throw, matching the pre-existing raw `file:///a/../b` throw;
      // `file:///a/%2eb/c` and `file:///a/%2e%2e%2e/b` do NOT — ".b" and
      // "..." are ordinary segments, not dot-segments, exactly like the
      // pre-existing "a..b" pin already established).
      c.i32Const(0);
      c.localSet(SEG_START);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(OUTLEN);
      c.i32GtS();
      c.brIf(1);
      c.localGet(I);
      c.localGet(OUTLEN);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(OUT);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(0x2f);
      c.i32Eq();
      c.end();
      c.ifVoid();
      c.localGet(I);
      c.localGet(SEG_START);
      c.i32Sub();
      c.localSet(SEGLEN);
      c.localGet(SEGLEN);
      c.i32Const(1);
      c.i32Eq();
      c.ifResult(I32);
      c.localGet(OUT);
      c.localGet(SEG_START);
      c.arrayGetU(strT);
      c.i32Const(0x2e);
      c.i32Eq();
      c.else_();
      c.i32Const(0);
      c.end();
      c.localGet(SEGLEN);
      c.i32Const(2);
      c.i32Eq();
      c.ifResult(I32);
      c.localGet(OUT);
      c.localGet(SEG_START);
      c.arrayGetU(strT);
      c.i32Const(0x2e);
      c.i32Eq();
      c.localGet(OUT);
      c.localGet(SEG_START);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Const(0x2e);
      c.i32Eq();
      c.i32And();
      c.else_();
      c.i32Const(0);
      c.end();
      c.i32Or();
      c.ifVoid();
      this.deps.setCellError(
c,
"%TypeError",
"TypeError",
        (x) =>
          this.deps.lit(
            x,
            "dot-segment path resolution is not supported yet (SEMANTICS.md S060)",
          ),
        null,
      );
      c.refNull(strT);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(SEG_START);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(OUTLEN);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(OUTLEN);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);

      this.mb.setBody(
        idx,
        [
          this.strRef() /* INPUT=1 */,
          I32 /* LEN=2 */,
          I32 /* SCHEME_LEN=3 */,
          I32 /* CH=4 */,
          I32 /* REST=5 */,
          I32 /* SLASHES=6 */,
          I32 /* AUTH_START=7 */,
          I32 /* AUTH_END=8 */,
          I32 /* HOST_LEN=9 */,
          I32 /* PATH_START=10 */,
          I32 /* PATH_END=11 */,
          this.strRef() /* OUT=12 */,
          I32 /* OUTLEN=13 */,
          I32 /* I=14 */,
          I32 /* SEG_START=15 */,
          I32 /* SEGLEN=16 */,
          I32 /* HI=17 */,
          I32 /* LO=18 */,
          I32 /* DEC=19 */,
          this.strRef() /* RESULT=20 */,
          I32 /* HOSTMATCH=21 */,
          I32 /* EFFLEN=22 */,
          I32 /* NEXTCH=23 */,
        ],
        c.bytes(),
      );
    });
  }
}
