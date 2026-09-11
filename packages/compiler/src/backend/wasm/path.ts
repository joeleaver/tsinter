/* INC-26 pass P2 (brief-p2-v2.md 89fd68aa; design-host-v7.txt cccf7d6e
 * §3.1/§5; cp1-plan-p2.txt 3a5721e2) — the path family: scr_path.c's two
 * function-by-function ports (posix, win32), transcribed into the tier's
 * `(array i16)` UTF-16 string idiom. A pure TRANSCRIPTION, not a host
 * contract (uri.ts is the precedent for that shape): no new import, no
 * register entry — scr_path.c's own header says "Nothing here throws:
 * these are pure string algorithms" (resolve consults getcwd like Node's,
 * modelled here by a HOST read, not a throw).
 *
 * STRING-BUILDING (CP1 §3/§3a): WasmGC arrays are fixed-length at
 * allocation (no array.grow), so PathBuf's realloc-as-you-go has no
 * literal wasm analogue. Every builder here follows uri.ts's percentEncode
 * idiom: a scratch `(array i16)` sized to a per-function CONSERVATIVE
 * bound (derived from the C source's own append calls, stated at each
 * function), a running output-length local, ONE `code.arrayCopy` trim
 * into an exact-size result at the end.
 *
 * THE CWD SNAPSHOT (D2 ERRATUM 1, DECISIONS.md): `resolve`/`win32Resolve`
 * consult the cwd. Measured directly against process.ts (CP1 §3a): P1
 * built "ensure*" snapshot globals for argv/env only — process.cwd's own
 * emitter.ts dispatch arm calls `%w.proc.readHostStr(HOST_STR_KIND_CWD,0)`
 * FRESH on every call, with no cache. So THIS file owns the one-host-
 * call-per-program property itself: `cwdSnapshot()` below is PathBuilder's
 * own memo (the same "null-check a nullable global, populate once" idiom
 * as process.ts's own `ensureArgv()`), reusing process.ts's `readHostStr`
 * (threaded in via deps) rather than a fresh hostStr call site. Neither
 * process.ts nor abi.ts is edited by this pass.
 *
 * THE SHORT-CIRCUIT AUDIT (design §5.4, brief §3B): `i32.and`/`i32.or` do
 * NOT short-circuit (uri.ts's own lesson, INC-25 P5). Every `&&`/`||` in
 * scr_path.c whose right operand indexes a buffer, dereferences a pointer,
 * or calls a function is transcribed as a nested `if` (or an equivalent
 * branch/guard reordering), never a bare `i32.and`/`i32.or` — the audit
 * table (impl-p2/findings-p2.txt) enumerates all 105 occurrences (the
 * population corrected from the design's raw 106/84 by excluding one
 * PROSE occurrence inside a comment at scr_path.c:943; CP1 §4/DECISIONS.md)
 * and cites the exact site in this file that discharges (or need not
 * discharge — NOT-APPLICABLE) each one.
 */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";
import { LEN, type VecInfo } from "./arrays.js";
import { HOST_STR_KIND_CWD } from "./abi.js";

/* ── ASCII code points this file compares against, named once ────────── */
const CH_SLASH = 0x2f; // '/'
const CH_BACKSLASH = 0x5c; // '\\'
const CH_DOT = 0x2e; // '.'
const CH_COLON = 0x3a; // ':'
const CH_QUESTION = 0x3f; // '?'
const CH_A_UPPER = 0x41; // 'A'
const CH_Z_UPPER = 0x5a; // 'Z'
const CH_A_LOWER = 0x61; // 'a'
const CH_Z_LOWER = 0x7a; // 'z'
const CH_CASE_DELTA = 0x20; // 'a' - 'A'

export interface PathDeps {
  strRef: () => ValType;
  strType: () => number;
  /** process.ts's `%w.proc.readHostStr(kind, index) -> str` — the ONE
   * existing accessor every hostStr read in the tier goes through
   * (abi.ts §2.2's retry contract). PathBuilder calls it EXACTLY ONCE
   * per module instantiation (via `cwdSnapshot()`'s own memo below),
   * never once per `resolve()`/`win32Resolve()` call. */
  readHostStr: () => number;
  /** The `arrayOf(STRING)` VecInfo/ops process.ts already built for
   * argv — reused verbatim for join/resolve's packed-array argument
   * (the frontend lowers every call, including the 0-ary forms, into
   * ONE `arrayLit` of this exact shape; CP1 §2/design §5.2). Length is
   * `structGet(stringVecInfo().struct, LEN)` directly (every builder in
   * this codebase reads a vec's length that way — arrays.ts's own LEN
   * constant, imported above); `stringVecGet` is the bounds-checked
   * `%w.vec.get:<key>(vec, f64 index) -> str` function index. */
  stringVecInfo: () => VecInfo;
  stringVecRef: () => ValType;
  stringVecGet: () => number;
  /** `%w.vec.newLen:<key>(f64)->vec` and `%w.vec.set:<key>(vec,f64,elem)`
   * — used ONLY by `relative`/`win32Relative` to build the one-element
   * packs `scr_path_relative` passes to `resolve` internally. */
  stringVecNewLen: () => number;
  stringVecSet: () => number;
  /** emitter.ts's `%w.strEq(ref,ref)->i32` (content equality), the SAME
   * shared helper process.ts already reuses via its own `strEq` dep —
   * not a second helper under a new name (the CACHED lesson). */
  strEq: () => number;
}

export class PathBuilder {
  private readonly fns = new Map<string, number>();
  private cwdGlobal: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: PathDeps,
  ) {}

  private strRef(): ValType {
    return this.deps.strRef();
  }
  private strType(): number {
    return this.deps.strType();
  }

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.path.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── the cwd snapshot (D2 ERRATUM 1) ──────────────────────────────────── */

  private cwdGlobalIdx(): number {
    if (this.cwdGlobal === null) {
      const t = this.strRef();
      if (t.kind !== "ref") throw new Error("emitter bug: strRef() must be a ref type");
      this.cwdGlobal = this.mb.addGlobal(t, true, (w) => {
        w.u8(0xd0); // ref.null
        w.sleb(t.typeIndex);
      });
    }
    return this.cwdGlobal;
  }

  /** `%w.path.cwdSnapshot() -> str` — D2 ERRATUM 1's own fix: process.ts
   * has no cwd cache (only argv/env got P1 "ensure*" snapshot globals),
   * so PathBuilder owns one. A null check on the interned global IS the
   * "loaded" flag, exactly `ensureArgv()`'s own idiom (process.ts) —
   * ONE `readHostStr(HOST_STR_KIND_CWD, 0)` call per module instance,
   * cached here, never re-read. */
  cwdSnapshotHelper(): number {
    return this.cached("cwdSnapshot", [], [this.strRef()], (idx) => {
      const c = new Code();
      c.globalGet(this.cwdGlobalIdx());
      c.refIsNull();
      c.ifVoid();
      c.i32Const(HOST_STR_KIND_CWD);
      c.i32Const(0); // index is ignored for this kind
      c.call(this.deps.readHostStr());
      c.globalSet(this.cwdGlobalIdx());
      c.end();
      c.globalGet(this.cwdGlobalIdx());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /* ── shared internals (mirror scr_path.c's own shared internals) ─────── */

  /** `%w.path.isSep(code, win32) -> i32 bool` — scr_path_is_sep/
   * scr_path_w32_is_sep: win32 recognizes both slashes, posix only '/'. */
  isSepHelper(): number {
    return this.cached("isSep", [I32, I32], [I32], (idx) => {
      const c = new Code();
      const CODE = 0;
      const WIN32 = 1;
      c.localGet(WIN32);
      c.ifResult(I32);
      c.localGet(CODE);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.localGet(CODE);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.i32Or();
      c.else_();
      c.localGet(CODE);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `%w.path.normalizeString(path, allowAboveRoot, win32) -> str` —
   * scr_path_normalize_string, Node's own normalizeString (lib/path.js),
   * shared by both families. `res` in the C is a PathBuf that starts
   * EMPTY at every one of the four call sites (normalize_raw/w32_
   * normalize_raw/resolve/win32_resolve all pass a freshly pb_init'd
   * buffer) — so this port's own SCRATCH always starts at O=0 too, no
   * pre-populated-input case to model.
   * CONSERVATIVE BOUND: output length <= input length + 1. Every append
   * either copies a substring already consumed from `path` (a retained
   * segment), or writes a literal ".." that mirrors two dot characters
   * just consumed, or writes ONE separator per retained segment — the
   * single case that can exceed a strict input-length bound is the
   * synthetic end-of-string separator (the `i == len` iteration can
   * inject one separator not present in `path`), bounded at +1.
   * SHORT-CIRCUIT AUDIT (findings-p2.txt cites each by scr_path.c line):
   * the `POPPED` flag below unifies the C's two `continue` statements
   * (scr_path.c ~L125/~L132) with the res->len==0 fall-through into ONE
   * shape (set POPPED, then gate the `..`-append on `!POPPED`) — this is
   * a MEANING-PRESERVING restructuring, not a short-circuit translation
   * choice: `continue` in C's `for` loop still runs the increment, and
   * this port's manual loop increments I unconditionally at the bottom
   * exactly once per iteration either way, so the rewrite changes no
   * observable behaviour. */
  normalizeStringHelper(): number {
    return this.cached("normalizeString", [this.strRef(), I32, I32], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const ALLOW = 1;
      const WIN32 = 2;
      const LEN = 3;
      const SEP = 4;
      const LSL = 5; // last_segment_length
      const LAST_SLASH = 6; // signed, -1 sentinel
      const DOTS = 7;
      const CODE = 8;
      const I = 9;
      const SCRATCH = 10;
      const O = 11; // res->len
      const POPPED = 12; // did the dots==2 branch already pop/reset? (skip the .. append)
      const J = 13;
      const LSI = 14; // last_slash_index
      const PS = 15; // prev_slash
      const SEGSTART = 16;
      const SEGLEN = 17;
      const BREAK_OUTER = 18;
      const TMP = 19;

      const strT = this.strType();

      // LEN = path.length; SEP = win32 ? '\\' : '/'
      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(WIN32);
      c.ifResult(I32);
      c.i32Const(CH_BACKSLASH);
      c.else_();
      c.i32Const(CH_SLASH);
      c.end();
      c.localSet(SEP);
      // last_segment_length=0; last_slash=-1; dots=0; code=0;
      c.i32Const(0);
      c.localSet(LSL);
      c.i32Const(-1);
      c.localSet(LAST_SLASH);
      c.i32Const(0);
      c.localSet(DOTS);
      c.i32Const(0);
      c.localSet(CODE);
      // SCRATCH = new array(LEN+1); O = 0
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(O);
      // I = 0
      c.i32Const(0);
      c.localSet(I);

      c.block(); // OUTER_BREAK
      c.loop(); // OUTER_CONTINUE
      c.localGet(I);
      c.localGet(LEN);
      c.i32GtS();
      c.brIf(1); // for (; i <= len; ...) -- stop once i > len

      // if (i < len) code = path[i]; else { if (isSep(code)) break; else code = '/'; }
      c.i32Const(0);
      c.localSet(BREAK_OUTER);
      c.localGet(I);
      c.localGet(LEN);
      c.i32LtS();
      c.ifVoid();
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CODE);
      c.else_();
      c.localGet(CODE);
      c.localGet(WIN32);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(1);
      c.localSet(BREAK_OUTER);
      c.else_();
      c.i32Const(CH_SLASH);
      c.localSet(CODE);
      c.end();
      c.end();
      c.localGet(BREAK_OUTER);
      c.brIf(1); // break the outer loop (shallow check, not a deep br)

      c.localGet(CODE);
      c.localGet(WIN32);
      c.call(this.isSepHelper());
      c.ifVoid();
      // ── separator branch ──────────────────────────────────────────
      c.localGet(LAST_SLASH);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.i32Eq();
      c.localGet(DOTS);
      c.i32Const(1);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      // NOOP — nothing to do
      c.else_();
      c.localGet(DOTS);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      // ── ".." branch ──────────────────────────────────────────────
      c.i32Const(0);
      c.localSet(POPPED);
      // needsPopOrEmpty = O<2 || lsl!=2 || scratch[O-1]!='.' || scratch[O-2]!='.'
      c.localGet(O);
      c.i32Const(2);
      c.i32LtS();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(LSL);
      c.i32Const(2);
      c.i32Ne();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.i32Const(CH_DOT);
      c.i32Ne();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGetU(strT);
      c.i32Const(CH_DOT);
      c.i32Ne();
      c.end();
      c.end();
      c.end();
      c.ifVoid();
      c.localGet(O);
      c.i32Const(2);
      c.i32GtS();
      c.ifVoid();
      // pop the last segment: find the last SEP in scratch[0,O)
      c.i32Const(-1);
      c.localSet(LSI);
      c.localGet(O);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(J);
      c.block();
      c.loop();
      c.localGet(J);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(SCRATCH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.localGet(SEP);
      c.i32Eq();
      c.ifVoid();
      c.localGet(J);
      c.localSet(LSI);
      c.br(2);
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(LSI);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(O);
      c.i32Const(0);
      c.localSet(LSL);
      c.else_();
      c.localGet(LSI);
      c.localSet(O);
      // prev_slash: last SEP in scratch[0, O)
      c.i32Const(-1);
      c.localSet(PS);
      c.localGet(O);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(J);
      c.block();
      c.loop();
      c.localGet(J);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(SCRATCH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.localGet(SEP);
      c.i32Eq();
      c.ifVoid();
      c.localGet(J);
      c.localSet(PS);
      c.br(2);
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(O);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(PS);
      c.i32Sub();
      c.localSet(LSL);
      c.end();
      c.i32Const(1);
      c.localSet(POPPED);
      c.else_();
      c.localGet(O);
      c.i32Const(0);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(O);
      c.i32Const(0);
      c.localSet(LSL);
      c.i32Const(1);
      c.localSet(POPPED);
      c.end();
      c.end();
      c.end(); // end needsPopOrEmpty ifVoid
      c.localGet(POPPED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ALLOW);
      c.ifVoid();
      c.localGet(O);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.localGet(SEP);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.localSet(O);
      c.end();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(2);
      c.i32Add();
      c.localSet(O);
      c.i32Const(2);
      c.localSet(LSL);
      c.end();
      c.end();
      c.else_();
      // ── normal segment branch ──────────────────────────────────────
      c.localGet(LAST_SLASH);
      c.i32Const(1);
      c.i32Add();
      c.localSet(SEGSTART);
      c.localGet(I);
      c.localGet(SEGSTART);
      c.i32Sub();
      c.localSet(SEGLEN);
      c.localGet(O);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.localGet(SEP);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.localSet(O);
      c.end();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.localGet(PATH);
      c.localGet(SEGSTART);
      c.localGet(SEGLEN);
      c.arrayCopy(strT, strT);
      c.localGet(O);
      c.localGet(SEGLEN);
      c.i32Add();
      c.localSet(O);
      c.localGet(SEGLEN);
      c.localSet(LSL);
      c.end(); // end IF-C (dots==2 / normal-segment split)
      c.end(); // end IF-B (NOOP-cond split) -- the NOOP arm falls through to here too
      // last_slash = i; dots = 0; -- UNCONDITIONAL tail: runs for the NOOP
      // arm, the dots==2 arm and the normal-segment arm alike (matches the
      // C exactly: this statement sits AFTER the whole if/elif/else chain,
      // not nested inside any one arm — a bug caught and fixed in this
      // same pass, see CP2 findings).
      c.localGet(I);
      c.localSet(LAST_SLASH);
      c.i32Const(0);
      c.localSet(DOTS);
      c.else_(); // IF-A's else: code is NOT a separator
      // code == '.' && dots != -1 ? ++dots : dots = -1
      c.localGet(CODE);
      c.i32Const(CH_DOT);
      c.i32Eq();
      c.ifVoid();
      c.localGet(DOTS);
      c.i32Const(-1);
      c.i32Ne();
      c.ifVoid();
      c.localGet(DOTS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(DOTS);
      c.end();
      c.else_();
      c.i32Const(-1);
      c.localSet(DOTS);
      c.end();
      c.end(); // end isSep(code) ifVoid

      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end(); // end loop
      c.end(); // end block

      // shrink SCRATCH[0, O) into a fresh, exactly-sized result
      c.localGet(O);
      c.arrayNewDefault(strT);
      c.localSet(TMP);
      c.localGet(TMP);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(strT, strT);
      c.localGet(TMP);

      this.mb.setBody(
        idx,
        // 3 LEN,4 SEP,5 LSL,6 LAST_SLASH,7 DOTS,8 CODE,9 I,10 SCRATCH,
        // 11 O,12 POPPED,13 J,14 LSI,15 PS,16 SEGSTART,17 SEGLEN,
        // 18 BREAK_OUTER,19 TMP
        [
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          this.strRef(),
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          this.strRef(),
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /* ── posix (one-for-one with scr_path_*) ──────────────────────────────── */

  /** `%w.path.isAbsolute(path) -> i32 bool` — scr_path_is_absolute:
   * `path->len > 0 && path->data[0] == '/'`. The right operand INDEXES a
   * buffer (audit: scr_path.c:279) — nested `if`, never `i32.and`. */
  isAbsoluteHelper(): number {
    return this.cached("isAbsolute", [this.strRef()], [I32], (idx) => {
      const c = new Code();
      const PATH = 0;
      const strT = this.strType();
      c.localGet(PATH);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.ifResult(I32);
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.else_();
      c.i32Const(0);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `%w.path.dirname(path) -> str` — scr_path_dirname, byte-for-byte. */
  dirnameHelper(): number {
    return this.cached("dirname", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LEN = 1;
      const HASROOT = 2;
      const END = 3;
      const MATCHED = 4;
      const I = 5;
      const FOUND = 6;
      const RESULT = 7;
      const strT = this.strType();
      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(LEN);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.localSet(HASROOT);
      c.i32Const(-1);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(MATCHED);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(1);
      c.i32LtS();
      c.brIf(1);
      c.i32Const(0);
      c.localSet(FOUND);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(FOUND);
      c.end();
      c.else_();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.end();
      c.localGet(FOUND);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(HASROOT);
      c.ifVoid();
      c.i32Const(CH_SLASH);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.else_();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.end();
      c.localGet(HASROOT);
      c.ifVoid();
      c.localGet(END);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(CH_SLASH);
      c.i32Const(CH_SLASH);
      c.arrayNewFixed(strT, 2);
      c.return_();
      c.end();
      c.end();
      c.localGet(END);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.i32Const(0);
      c.localGet(END);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }

  /** `%w.path.extname(path) -> str` — scr_path_extname, byte-for-byte.
   * The final disqualify test (scr_path.c:385-386, audit: all four
   * operands PURE) is a bare `i32.or`/`i32.and` chain, matching the
   * audit's own disposition for that occurrence set. */
  extnameHelper(): number {
    return this.cached("extname", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LEN = 1;
      const STARTDOT = 2;
      const STARTPART = 3;
      const END = 4;
      const MATCHED = 5;
      const PREDOT = 6;
      const I = 7;
      const CODE = 8;
      const BRK = 9;
      const RESULT = 10;
      const strT = this.strType();
      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.i32Const(-1);
      c.localSet(STARTDOT);
      c.i32Const(0);
      c.localSet(STARTPART);
      c.i32Const(-1);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(MATCHED);
      c.i32Const(0);
      c.localSet(PREDOT);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CODE);
      c.i32Const(0);
      c.localSet(BRK);
      c.localGet(CODE);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(STARTPART);
      c.i32Const(1);
      c.localSet(BRK);
      c.end();
      c.else_();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(END);
      c.end();
      c.localGet(CODE);
      c.i32Const(CH_DOT);
      c.i32Eq();
      c.ifVoid();
      c.localGet(STARTDOT);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(STARTDOT);
      c.else_();
      c.localGet(PREDOT);
      c.i32Const(1);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(PREDOT);
      c.end();
      c.end();
      c.else_();
      c.localGet(STARTDOT);
      c.i32Const(-1);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(-1);
      c.localSet(PREDOT);
      c.end();
      c.end();
      c.end();
      c.localGet(BRK);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // disqualify = start_dot==-1 || end==-1 || pre_dot_state==0 ||
      //   (pre_dot_state==1 && start_dot==end-1 && start_dot==start_part+1)
      // (scr_path.c:385-386 — all four operands PURE per the audit)
      c.localGet(STARTDOT);
      c.i32Const(-1);
      c.i32Eq();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.i32Or();
      c.localGet(PREDOT);
      c.i32Const(0);
      c.i32Eq();
      c.i32Or();
      c.localGet(PREDOT);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(STARTDOT);
      c.localGet(END);
      c.i32Const(1);
      c.i32Sub();
      c.i32Eq();
      c.i32And();
      c.localGet(STARTDOT);
      c.localGet(STARTPART);
      c.i32Const(1);
      c.i32Add();
      c.i32Eq();
      c.i32And();
      c.i32Or();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();
      c.localGet(END);
      c.localGet(STARTDOT);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.localGet(STARTDOT);
      c.localGet(END);
      c.localGet(STARTDOT);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      // 1 LEN,2 STARTDOT,3 STARTPART,4 END,5 MATCHED,6 PREDOT,7 I,8 CODE,
      // 9 BRK,10 RESULT
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }

  /** `%w.path.basename(path, suffix) -> str` — scr_path_basename. The
   * lowering always supplies BOTH arguments (design §5.2/M-09: the
   * frontend completes an omitted suffix to `str("")`), so this port
   * needs only the 2-ary shape — matching the C's own single entry
   * point (`ScrStr *suffix`, never NULL). */
  basenameHelper(): number {
    return this.cached("basename", [this.strRef(), this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const SUFFIX = 1;
      const LEN = 2;
      const START = 3;
      const END = 4;
      const MATCHED = 5;
      const SUFFIXLEN = 6;
      const HASSUFFIX = 7;
      const EXTIDX = 8;
      const FNSE = 9; // first_non_slash_end
      const I = 10;
      const CODE = 11;
      const BRK = 12;
      const RESULT = 13;
      const strT = this.strType();

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.i32Const(0);
      c.localSet(START);
      c.i32Const(-1);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(MATCHED);
      c.localGet(SUFFIX);
      c.arrayLen();
      c.localSet(SUFFIXLEN);
      // hasSuffix = suffix.len > 0 && suffix.len <= path.len (both PURE
      // field-length reads — scr_path.c:309 — bare i32.and is safe)
      c.localGet(SUFFIXLEN);
      c.i32Const(0);
      c.i32GtS();
      c.localGet(SUFFIXLEN);
      c.localGet(LEN);
      c.i32LeS();
      c.i32And();
      c.localSet(HASSUFFIX);

      c.localGet(HASSUFFIX);
      c.ifVoid();
      // suffix.len == path.len && memcmp(...)==0 -> "" (CALL on the
      // right, scr_path.c:310 — nested if mandatory)
      c.localGet(SUFFIXLEN);
      c.localGet(LEN);
      c.i32Eq();
      c.ifVoid();
      c.localGet(PATH);
      c.localGet(SUFFIX);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();
      c.end();
      c.localGet(SUFFIXLEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(EXTIDX);
      c.i32Const(-1);
      c.localSet(FNSE);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CODE);
      c.i32Const(0);
      c.localSet(BRK);
      c.localGet(CODE);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(START);
      c.i32Const(1);
      c.localSet(BRK);
      c.end();
      c.else_();
      c.localGet(FNSE);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(FNSE);
      c.end();
      c.localGet(EXTIDX);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(CODE);
      c.localGet(SUFFIX);
      c.localGet(EXTIDX);
      c.arrayGetU(strT);
      c.i32Eq();
      c.ifVoid();
      c.localGet(EXTIDX);
      c.i32Const(1);
      c.i32Sub();
      c.localTee(EXTIDX);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(END);
      c.end();
      c.else_();
      c.i32Const(-1);
      c.localSet(EXTIDX);
      c.localGet(FNSE);
      c.localSet(END);
      c.end(); // closes E (code==suffix[extidx])
      c.end(); // closes D (ext_idx>=0)
      c.end(); // closes A (code=='/' vs else)
      c.localGet(BRK);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(START);
      c.localGet(END);
      c.i32Eq();
      c.ifVoid();
      c.localGet(FNSE);
      c.localSet(END);
      c.else_();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(LEN);
      c.localSet(END);
      c.end();
      c.end();
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.localGet(START);
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();

      // no usable suffix: the shorter loop (no ext tracking)
      c.i32Const(-1);
      c.localSet(END);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.i32Const(0);
      c.localSet(BRK);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(START);
      c.i32Const(1);
      c.localSet(BRK);
      c.end();
      c.else_();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(END);
      c.end();
      c.end();
      c.localGet(BRK);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.localGet(START);
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      // 2 LEN,3 START,4 END,5 MATCHED,6 SUFFIXLEN,7 HASSUFFIX,8 EXTIDX,
      // 9 FNSE,10 I,11 CODE,12 BRK,13 RESULT
      this.mb.setBody(
        idx,
        [I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.toNamespacedPath(path) -> str` — scr_path_to_namespaced_
   * path: identity on posix (`scr_str_retain(path)`; a GC ref needs no
   * manual retain). */
  toNamespacedPathHelper(): number {
    return this.cached("toNamespacedPath", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `%w.path.normalizeRaw(path) -> str` — scr_path_normalize_raw. Every
   * piece's exact length is known before allocating (no scratch/trim
   * needed): `(isAbs?1:0) + norm.length + (trailingSep?1:0)`. */
  normalizeRawHelper(): number {
    return this.cached("normalizeRaw", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LEN = 1;
      const ISABS = 2;
      const TRAILSEP = 3;
      const NORM = 4;
      const NORMLEN = 5;
      const OUTLEN = 6;
      const RESULT = 7;
      const POS = 8;
      const strT = this.strType();

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(LEN);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.localSet(ISABS);
      c.localGet(PATH);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.localSet(TRAILSEP);

      c.localGet(PATH);
      c.localGet(ISABS);
      c.i32Eqz();
      c.i32Const(0); // win32 = false
      c.call(this.normalizeStringHelper());
      c.localSet(NORM);
      c.localGet(NORM);
      c.arrayLen();
      c.localSet(NORMLEN);

      c.localGet(NORMLEN);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ISABS);
      c.ifVoid();
      c.i32Const(CH_SLASH);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.localGet(TRAILSEP);
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.i32Const(CH_SLASH);
      c.arrayNewFixed(strT, 2);
      c.return_();
      c.else_();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.end();

      c.localGet(ISABS);
      c.localGet(NORMLEN);
      c.i32Add();
      c.localGet(TRAILSEP);
      c.i32Add();
      c.localSet(OUTLEN);
      c.localGet(OUTLEN);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.i32Const(0);
      c.localSet(POS);
      c.localGet(ISABS);
      c.ifVoid();
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_SLASH);
      c.arraySet(strT);
      c.i32Const(1);
      c.localSet(POS);
      c.end();
      c.localGet(RESULT);
      c.localGet(POS);
      c.localGet(NORM);
      c.i32Const(0);
      c.localGet(NORMLEN);
      c.arrayCopy(strT, strT);
      c.localGet(POS);
      c.localGet(NORMLEN);
      c.i32Add();
      c.localSet(POS);
      c.localGet(TRAILSEP);
      c.ifVoid();
      c.localGet(RESULT);
      c.localGet(POS);
      c.i32Const(CH_SLASH);
      c.arraySet(strT);
      c.end();
      c.localGet(RESULT);
      this.mb.setBody(idx, [I32, I32, I32, this.strRef(), I32, I32, this.strRef(), I32], c.bytes());
      return idx;
    });
  }

  /** `%w.path.normalize(path) -> str` — scr_path_normalize, a thin
   * wrapper over normalizeRaw (kept as its own named function for
   * citation fidelity with the C's own two-entry-point shape). */
  normalizeHelper(): number {
    return this.cached("normalize", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.call(this.normalizeRawHelper());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `%w.path.join(parts) -> str` — scr_path_join. `parts` is the
   * lowering's packed `arrayOf(STRING)` (design §5.2/M-09: every call,
   * INCLUDING the 0-ary form, arrives this way). A pre-pass sums every
   * part's length (a safe upper bound on the joined-before-normalize
   * buffer: sum(lengths) + n separators), then a second pass writes it. */
  joinHelper(): number {
    return this.cached("join", [this.deps.stringVecRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PARTS = 0;
      const N = 1;
      const I = 2;
      const TOTAL = 3;
      const ARG = 4;
      const ARGLEN = 5;
      const SCRATCH = 6;
      const O = 7;
      const ANY = 8;
      const RESULT = 9;
      const strT = this.strType();
      const vi = this.deps.stringVecInfo();

      c.localGet(PARTS);
      c.structGet(vi.struct, LEN);
      c.localSet(N);
      c.localGet(N);
      c.localSet(TOTAL); // upper bound: sum(lengths) + N separators
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PARTS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.arrayLen();
      c.localGet(TOTAL);
      c.i32Add();
      c.localSet(TOTAL);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(TOTAL);
      c.arrayNewDefault(strT);
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(O);
      c.i32Const(0);
      c.localSet(ANY);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PARTS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.localSet(ARG);
      c.localGet(ARG);
      c.arrayLen();
      c.localSet(ARGLEN);
      c.localGet(ARGLEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ANY);
      c.ifVoid();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(CH_SLASH);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.localSet(O);
      c.end();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.localGet(ARG);
      c.i32Const(0);
      c.localGet(ARGLEN);
      c.arrayCopy(strT, strT);
      c.localGet(O);
      c.localGet(ARGLEN);
      c.i32Add();
      c.localSet(O);
      c.i32Const(1);
      c.localSet(ANY);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(ANY);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.localGet(O);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.call(this.normalizeRawHelper());
      this.mb.setBody(
        idx,
        [I32, I32, I32, this.strRef(), I32, this.strRef(), I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.resolve(parts) -> str` — scr_path_resolve. Node walks the
   * args LAST-first, PREPENDING, until one is absolute (the cwd is a
   * final virtual argument at i==-1). This port builds the same
   * right-to-left by writing into a shared scratch FROM THE RIGHT EDGE
   * backward: each prepended segment's content lands immediately before
   * whatever is already in place, so the "already-resolved" suffix never
   * needs to move — only the cursor (POS) does. Conservative bound:
   * sum(all N parts' lengths) + cwd.length + (N+1) separators (every
   * part PLUS the virtual cwd slot could be visited, even though the
   * loop may stop earlier once an absolute segment is found). */
  resolveHelper(): number {
    return this.cached("resolve", [this.deps.stringVecRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PARTS = 0;
      const N = 1;
      const I = 2;
      const TOTAL = 3;
      const CWD = 4;
      const CWDLEN = 5;
      const BOUND = 6;
      const SCRATCH = 7;
      const POS = 8;
      const RESOLVEDABS = 9;
      const SEG = 10;
      const SEGLEN = 11;
      const NEWPOS = 12;
      const RESLEN = 13;
      const RESSTR = 14;
      const NORM = 15;
      const NORMLEN = 16;
      const OUT = 17;
      const strT = this.strType();
      const vi = this.deps.stringVecInfo();

      c.localGet(PARTS);
      c.structGet(vi.struct, LEN);
      c.localSet(N);
      c.call(this.cwdSnapshotHelper());
      c.localSet(CWD);
      c.localGet(CWD);
      c.arrayLen();
      c.localSet(CWDLEN);

      c.localGet(N);
      c.localSet(TOTAL);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PARTS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.arrayLen();
      c.localGet(TOTAL);
      c.i32Add();
      c.localSet(TOTAL);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(TOTAL);
      c.localGet(CWDLEN);
      c.i32Add();
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.i32Add();
      c.localSet(BOUND);

      c.localGet(BOUND);
      c.arrayNewDefault(strT);
      c.localSet(SCRATCH);
      c.localGet(BOUND);
      c.localSet(POS); // resolved so far is scratch[POS, BOUND) -- starts empty
      c.i32Const(0);
      c.localSet(RESOLVEDABS);

      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I); // i = n-1
      c.block();
      c.loop();
      // for (; i >= -1 && !resolved_absolute; i--)
      c.localGet(I);
      c.i32Const(-1);
      c.i32LtS();
      c.brIf(1);
      c.localGet(RESOLVEDABS);
      c.brIf(1);

      c.localGet(I);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(this.strRef());
      c.localGet(PARTS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.else_();
      c.localGet(CWD);
      c.end();
      c.localSet(SEG);
      c.localGet(SEG);
      c.arrayLen();
      c.localSet(SEGLEN);

      c.localGet(SEGLEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(BOUND);
      c.localGet(POS);
      c.i32Sub();
      c.localSet(RESLEN); // length of the resolved-so-far suffix
      c.localGet(POS);
      c.localGet(SEGLEN);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.localSet(NEWPOS);
      c.localGet(SCRATCH);
      c.localGet(NEWPOS);
      c.localGet(SEG);
      c.i32Const(0);
      c.localGet(SEGLEN);
      c.arrayCopy(strT, strT);
      c.localGet(SCRATCH);
      c.localGet(NEWPOS);
      c.localGet(SEGLEN);
      c.i32Add();
      c.i32Const(CH_SLASH);
      c.arraySet(strT);
      c.localGet(NEWPOS);
      c.localSet(POS);
      c.localGet(SCRATCH);
      c.localGet(POS);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.localSet(RESOLVEDABS);
      c.end();

      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      // norm = normalizeString(scratch[POS,BOUND), !resolved_absolute, false)
      c.localGet(BOUND);
      c.localGet(POS);
      c.i32Sub();
      c.localSet(RESLEN);
      c.localGet(RESLEN);
      c.arrayNewDefault(strT);
      c.localSet(RESSTR);
      c.localGet(RESSTR);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.localGet(POS);
      c.localGet(RESLEN);
      c.arrayCopy(strT, strT);
      c.localGet(RESSTR);
      c.localGet(RESOLVEDABS);
      c.i32Eqz();
      c.i32Const(0); // win32 = false
      c.call(this.normalizeStringHelper());
      c.localSet(NORM);
      c.localGet(NORM);
      c.arrayLen();
      c.localSet(NORMLEN);

      c.localGet(RESOLVEDABS);
      c.ifResult(this.strRef());
      c.localGet(NORMLEN);
      c.i32Const(1);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(OUT);
      c.localGet(OUT);
      c.i32Const(0);
      c.i32Const(CH_SLASH);
      c.arraySet(strT);
      c.localGet(OUT);
      c.i32Const(1);
      c.localGet(NORM);
      c.i32Const(0);
      c.localGet(NORMLEN);
      c.arrayCopy(strT, strT);
      c.localGet(OUT);
      c.else_();
      c.localGet(NORMLEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifResult(this.strRef());
      c.localGet(NORM);
      c.else_();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.end();
      c.end();

      this.mb.setBody(
        idx,
        [
          I32,
          I32,
          I32,
          this.strRef(),
          I32,
          I32,
          this.strRef(),
          I32,
          I32,
          this.strRef(),
          I32,
          I32,
          I32,
          this.strRef(),
          this.strRef(),
          I32,
          this.strRef(),
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.relative(from, to) -> str` — scr_path_relative: from =
   * resolve([from]), to = resolve([to]) via one-element packs, then the
   * common-prefix walk. The mismatch break uses a bare `brIf` on the
   * comparison directly (strings.ts's indexOf precedent) — nothing needs
   * recording before breaking, unlike basename/dirname/extname's scans. */
  relativeHelper(): number {
    return this.cached("relative", [this.strRef(), this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const FROM = 0;
      const TO = 1;
      const RFROM = 2;
      const RTO = 3;
      const FROMEND = 4; // rfrom.length (from_start is always 1)
      const FROMLEN = 5;
      const TOLEN = 6; // rto.length - 1 (to_start is always 1)
      const LENGTH = 7;
      const I = 8;
      const LASTCOMMONSEP = 9;
      const FROMCODE = 10;
      const RESULT = 11;
      const BOUND = 12;
      const SCRATCH = 13;
      const O = 14;
      const J = 15;
      const SUFFIXSTART = 16;
      const SUFFIXLEN = 17;
      const PACK = 18; // the one-element vec `resolve` takes, rebuilt per side
      const strT = this.strType();

      c.localGet(FROM);
      c.localGet(TO);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();

      // rfrom = resolve([from]); rto = resolve([to]) -- the vec must be
      // held in a local across `stringVecSet` (void: it does not hand
      // the vec back), then pushed AGAIN for `resolve`'s own argument.
      c.f64Const(1);
      c.call(this.deps.stringVecNewLen());
      c.localSet(PACK);
      c.localGet(PACK);
      c.f64Const(0);
      c.localGet(FROM);
      c.call(this.deps.stringVecSet());
      c.localGet(PACK);
      c.call(this.resolveHelper());
      c.localSet(RFROM);
      c.f64Const(1);
      c.call(this.deps.stringVecNewLen());
      c.localSet(PACK);
      c.localGet(PACK);
      c.f64Const(0);
      c.localGet(TO);
      c.call(this.deps.stringVecSet());
      c.localGet(PACK);
      c.call(this.resolveHelper());
      c.localSet(RTO);

      c.localGet(RFROM);
      c.localGet(RTO);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();

      c.localGet(RFROM);
      c.arrayLen();
      c.localSet(FROMEND); // from_start=1 always: rfrom is always at least "/"
      c.localGet(FROMEND);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(FROMLEN);
      c.localGet(RTO);
      c.arrayLen();
      c.i32Const(1);
      c.i32Sub();
      c.localSet(TOLEN);
      c.localGet(FROMLEN);
      c.localGet(TOLEN);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(FROMLEN);
      c.else_();
      c.localGet(TOLEN);
      c.end();
      c.localSet(LENGTH);

      c.i32Const(-1);
      c.localSet(LASTCOMMONSEP);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LENGTH);
      c.i32GeS();
      c.brIf(1);
      c.localGet(RFROM);
      c.i32Const(1);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.localSet(FROMCODE);
      c.localGet(FROMCODE);
      c.localGet(RTO);
      c.i32Const(1);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Ne();
      c.brIf(1); // mismatch: break, leaving I at the mismatch index
      c.localGet(FROMCODE);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(LASTCOMMONSEP);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(I);
      c.localGet(LENGTH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(TOLEN);
      c.localGet(LENGTH);
      c.i32GtS();
      c.ifVoid();
      c.localGet(RTO);
      c.i32Const(1);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(TOLEN);
      c.localGet(I);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(RTO);
      c.i32Const(1);
      c.localGet(I);
      c.i32Add();
      c.i32Const(1);
      c.i32Add();
      c.localGet(TOLEN);
      c.localGet(I);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(TOLEN);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(RTO);
      c.i32Const(1);
      c.localGet(TOLEN);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();
      c.else_();
      c.localGet(FROMLEN);
      c.localGet(LENGTH);
      c.i32GtS();
      c.ifVoid();
      c.localGet(RFROM);
      c.i32Const(1);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(LASTCOMMONSEP);
      c.else_();
      c.localGet(I);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(LASTCOMMONSEP);
      c.end();
      c.end();
      c.end();
      c.end();
      c.end();

      // trailer: ".." per remaining from-segment, then the to suffix.
      // BOUND must upper-bound the "up" loop's worst case (every position
      // from lastCommonSep+2 through fromEnd is a boundary) -- that loop
      // runs (fromEnd - lastCommonSep - 1) times, each iteration writing
      // at most 3 chars ("/.."). THE 3D THREE-WAY ORACLE CAUGHT A REAL
      // BUG HERE: this used to compute `fromEnd - (1 - lastCommonSep)`
      // (i.e. fromEnd - 1 + lastCommonSep, the WRONG sign on
      // lastCommonSep) instead of `fromEnd - lastCommonSep - 1` -- the
      // two agree only when lastCommonSep is 0, and UNDER-allocate by
      // 2*|lastCommonSep| whenever lastCommonSep is negative (its own
      // "no common separator" sentinel, -1) -- e.g. path.posix.relative
      // ("a","ab") (fromEnd=2, lastCommonSep=-1): buggy bound = 0*3+3 =
      // 3, correct = 2*3+3 = 9, actual result "../ab" needs 5 -- an
      // out-of-bounds arraySet inside the "up" loop. Found via the
      // three-way oracle's own path-cases-posix.txt fuzz corpus, not the
      // 9-program differential tier (none of them call relative() on a
      // same-length-prefix pair).
      c.localGet(FROMEND);
      c.localGet(LASTCOMMONSEP);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.i32Const(3);
      c.i32Mul();
      c.localGet(RTO);
      c.arrayLen();
      c.i32Add();
      c.localSet(BOUND);
      c.localGet(BOUND);
      c.arrayNewDefault(strT);
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(O);
      c.localGet(LASTCOMMONSEP);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(1);
      c.i32Add();
      c.localSet(J); // j = from_start + last_common_sep + 1
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(FROMEND);
      c.i32GtS();
      c.brIf(1);
      c.localGet(J);
      c.localGet(FROMEND);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(RFROM);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.end();
      c.ifVoid();
      c.localGet(O);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(2);
      c.i32Add();
      c.localSet(O);
      c.else_();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(CH_SLASH);
      c.arraySet(strT);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(2);
      c.i32Add();
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(3);
      c.i32Add();
      c.localSet(O);
      c.end();
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();

      c.i32Const(1);
      c.localGet(LASTCOMMONSEP);
      c.i32Add();
      c.localSet(SUFFIXSTART);
      c.localGet(RTO);
      c.arrayLen();
      c.localGet(SUFFIXSTART);
      c.i32Sub();
      c.localSet(SUFFIXLEN);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.localGet(RTO);
      c.localGet(SUFFIXSTART);
      c.localGet(SUFFIXLEN);
      c.arrayCopy(strT, strT);
      c.localGet(O);
      c.localGet(SUFFIXLEN);
      c.i32Add();
      c.localSet(O);

      c.localGet(O);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);

      this.mb.setBody(
        idx,
        [
          this.strRef(), // 2 RFROM
          this.strRef(), // 3 RTO
          I32, // 4 FROMEND
          I32, // 5 FROMLEN
          I32, // 6 TOLEN
          I32, // 7 LENGTH
          I32, // 8 I
          I32, // 9 LASTCOMMONSEP
          I32, // 10 FROMCODE
          this.strRef(), // 11 RESULT
          I32, // 12 BOUND
          this.strRef(), // 13 SCRATCH
          I32, // 14 O
          I32, // 15 J
          I32, // 16 SUFFIXSTART
          I32, // 17 SUFFIXLEN
          this.deps.stringVecRef(), // 18 PACK
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /* ── win32 internal predicates (mirror scr_path_w32_* exactly) ────────── */

  /** `%w.path.w32IsDeviceRoot(code) -> i32 bool` — both operands PURE
   * (scr_path.c:480 — bare i32.and/i32.or is the audit's own answer). */
  w32IsDeviceRootHelper(): number {
    return this.cached("w32IsDeviceRoot", [I32], [I32], (idx) => {
      const c = new Code();
      const CODE = 0;
      c.localGet(CODE);
      c.i32Const(CH_A_UPPER);
      c.i32GeS();
      c.localGet(CODE);
      c.i32Const(CH_Z_UPPER);
      c.i32LeS();
      c.i32And();
      c.localGet(CODE);
      c.i32Const(CH_A_LOWER);
      c.i32GeS();
      c.localGet(CODE);
      c.i32Const(CH_Z_LOWER);
      c.i32LeS();
      c.i32And();
      c.i32Or();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `%w.path.w32Lower(code) -> i32` — scr_path_w32_lower, ASCII-only
   * (the header's own documented divergence: non-ASCII case-folding is
   * NOT modelled). */
  w32LowerHelper(): number {
    return this.cached("w32Lower", [I32], [I32], (idx) => {
      const c = new Code();
      const CODE = 0;
      c.localGet(CODE);
      c.i32Const(CH_A_UPPER);
      c.i32GeS();
      c.localGet(CODE);
      c.i32Const(CH_Z_UPPER);
      c.i32LeS();
      c.i32And();
      c.ifResult(I32);
      c.localGet(CODE);
      c.i32Const(CH_CASE_DELTA);
      c.i32Add();
      c.else_();
      c.localGet(CODE);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `%w.path.w32Ieq(a, b, n) -> i32 bool` — scr_path_w32_ieq over the
   * first n code units of each (every call site passes offset 0). A
   * mismatch `return_()`s false immediately; falling out of the loop
   * means every position matched. */
  w32IeqHelper(): number {
    return this.cached("w32Ieq", [this.strRef(), this.strRef(), I32], [I32], (idx) => {
      const c = new Code();
      const A = 0;
      const B = 1;
      const N = 2;
      const I = 3;
      const strT = this.strType();
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(A);
      c.localGet(I);
      c.arrayGetU(strT);
      c.call(this.w32LowerHelper());
      c.localGet(B);
      c.localGet(I);
      c.arrayGetU(strT);
      c.call(this.w32LowerHelper());
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** `%w.path.w32ColonIndex(path, from) -> i32` — scr_path_w32_colon_
   * index. A match `return_()`s the index immediately. */
  w32ColonIndexHelper(): number {
    return this.cached("w32ColonIndex", [this.strRef(), I32], [I32], (idx) => {
      const c = new Code();
      const PATH = 0;
      const FROM = 1;
      const LEN = 2;
      const I = 3;
      const strT = this.strType();
      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(FROM);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(-1);
      this.mb.setBody(idx, [I32, I32], c.bytes());
      return idx;
    });
  }

  /** `%w.path.w32IsReserved(path, colonIndex) -> i32 bool` —
   * scr_path_w32_is_reserved, RE-DERIVED for UTF-16 (not a literal
   * transcription: the C walks UTF-8 BYTES — `(path[last] & 0xC0) ==
   * 0x80` is a continuation-byte test, `len - last == 4` detects a
   * 4-byte astral sequence — and this tier stores UTF-16 CODE UNITS.
   * The header comment states the JS-level intent directly: colonIndex
   * -1 means the device is `path.slice(0, -1)`, dropping the final
   * UTF-16 code unit; if that unit is the LOW half of a surrogate pair
   * (an astral final character), the drop leaves a LONE HIGH SURROGATE,
   * which can never equal an ASCII reserved name — so the UTF-16
   * equivalent of the C's byte-count check is simply "the last code
   * unit is a low surrogate" and answers the SAME false. Reserved-name
   * lengths below are CODE-UNIT counts (the C's byte lengths do not
   * apply): the superscript digits U+00B9/B2/B3 are ONE BMP code unit
   * each, so "COM¹" is 4 units, not the C's 5 bytes. */
  w32IsReservedHelper(): number {
    return this.cached("w32IsReserved", [this.strRef(), I32], [I32], (idx) => {
      const c = new Code();
      const PATH = 0;
      const COLONIDX = 1;
      const LEN = 2;
      const END = 3;
      const K = 4; // scratch: the raw code unit under test, per unrolled position
      const strT = this.strType();
      const SUP1 = 0xb9;
      const SUP2 = 0xb2;
      const SUP3 = 0xb3;
      const C_ = 67,
        O_ = 79,
        N_ = 78,
        P_ = 80,
        R_ = 82,
        A_ = 65,
        U_ = 85,
        X_ = 88,
        M_ = 77,
        L_ = 76,
        T_ = 84;
      const D1 = 49; // '1'
      const names: number[][] = [
        [C_, O_, N_],
        [P_, R_, N_],
        [A_, U_, X_],
        [N_, U_, L_],
      ];
      for (let d = 0; d < 9; d++) names.push([C_, O_, M_, D1 + d]);
      for (let d = 0; d < 9; d++) names.push([L_, P_, T_, D1 + d]);
      names.push([C_, O_, M_, SUP1], [C_, O_, M_, SUP2], [C_, O_, M_, SUP3]);
      names.push([L_, P_, T_, SUP1], [L_, P_, T_, SUP2], [L_, P_, T_, SUP3]);

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(COLONIDX);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(COLONIDX);
      c.localGet(LEN);
      c.i32GtS();
      c.ifResult(I32);
      c.localGet(LEN);
      c.else_();
      c.localGet(COLONIDX);
      c.end();
      c.localSet(END);
      c.else_();
      c.localGet(LEN);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      // the UTF-16 re-derivation (see the doc comment above): a low
      // surrogate as the final code unit means slice(0,-1) would leave a
      // dangling high surrogate, which can never match an ASCII name.
      c.localGet(PATH);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.localSet(K);
      c.localGet(K);
      c.i32Const(0xdc00);
      c.i32GeU();
      c.localGet(K);
      c.i32Const(0xdfff);
      c.i32LeU();
      c.i32And();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(END);
      c.end();

      // Every name and every one of its (<=4) positions is compile-time
      // known, so both loops are UNROLLED here in TypeScript — no wasm-
      // level loop is needed, and every `path[j]` read below is already
      // bounds-proven by the preceding END==name.length check.
      for (const name of names) {
        c.localGet(END);
        c.i32Const(name.length);
        c.i32Eq();
        c.ifVoid();
        for (let j = 0; j < name.length; j++) {
          c.localGet(PATH);
          c.i32Const(j);
          c.arrayGetU(strT);
          c.localSet(K);
          c.localGet(K);
          c.i32Const(CH_A_LOWER);
          c.i32GeS();
          c.localGet(K);
          c.i32Const(CH_Z_LOWER);
          c.i32LeS();
          c.i32And();
          c.ifResult(I32);
          c.localGet(K);
          c.i32Const(CH_CASE_DELTA);
          c.i32Sub();
          c.else_();
          c.localGet(K);
          c.end();
          c.i32Const(name[j]!);
          c.i32Eq();
          if (j > 0) c.i32And();
        }
        c.ifVoid();
        c.i32Const(1);
        c.return_();
        c.end();
        c.end();
      }
      c.i32Const(0);
      // 2 LEN, 3 END, 4 K
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /* ── win32 exported surface (mirror scr_path_win32_* one-for-one) ─────── */

  /** `%w.path.win32IsAbsolute(path) -> i32 bool` — scr_path_win32_is_
   * absolute. Written as an early-return guard chain (behaviourally
   * identical to the C's `A || (B && C && D && E)`, each guard being
   * exactly the nested-if the audit requires for a CALL/INDEX right
   * operand, without the depth bookkeeping a literal nested-if
   * transcription would need). */
  win32IsAbsoluteHelper(): number {
    return this.cached("win32IsAbsolute", [this.strRef()], [I32], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LEN = 1;
      const strT = this.strType();
      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(LEN);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(LEN);
      c.i32Const(2);
      c.i32GtS();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.call(this.w32IsDeviceRootHelper());
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(PATH);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(PATH);
      c.i32Const(2);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** `%w.path.win32Dirname(path) -> str` — scr_path_win32_dirname. */
  win32DirnameHelper(): number {
    return this.cached("win32Dirname", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LEN = 1;
      const ROOTEND = 2; // -1 sentinel
      const OFFSET = 3;
      const CODE = 4;
      const J = 5;
      const LAST = 6;
      const END = 7;
      const MATCHED = 8;
      const I = 9;
      const FOUND = 10;
      const RESULT = 11;
      const strT = this.strType();

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(LEN);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.i32Const(-1);
      c.localSet(ROOTEND);
      c.i32Const(0);
      c.localSet(OFFSET);
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.localSet(CODE);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CODE);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifResult(this.strRef());
      c.i32Const(1);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.i32Const(0);
      c.i32Const(1);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.else_();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.end();
      c.return_();
      c.end();
      c.localGet(CODE);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      // possible UNC root
      c.i32Const(1);
      c.localSet(ROOTEND);
      c.i32Const(1);
      c.localSet(OFFSET);
      c.localGet(PATH);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(2);
      c.localSet(J);
      c.i32Const(2);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(LEN);
      c.i32LtS();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      c.localGet(J);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.i32Eqz();
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(LEN);
      c.i32LtS();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      c.localGet(J);
      c.localSet(LAST); // last = j (was backwards: j = last — a real bug)
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(LEN);
      c.i32Eq();
      c.ifVoid();
      // UNC root only
      c.localGet(LEN);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.i32Const(0);
      c.localGet(LEN);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.ifVoid();
      // UNC root with leftovers: root_end = j+1, offset = j+1
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(ROOTEND);
      c.localGet(ROOTEND);
      c.localSet(OFFSET);
      c.end();
      c.end();
      c.end();
      c.end();
      c.else_();
      c.localGet(CODE);
      c.call(this.w32IsDeviceRootHelper());
      c.localGet(PATH);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.localGet(LEN);
      c.i32Const(2);
      c.i32GtS();
      c.ifResult(I32);
      c.localGet(PATH);
      c.i32Const(2);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.else_();
      c.i32Const(0);
      c.end();
      c.ifResult(I32);
      c.i32Const(3);
      c.else_();
      c.i32Const(2);
      c.end();
      c.localSet(ROOTEND);
      c.localGet(ROOTEND);
      c.localSet(OFFSET);
      c.end();
      c.end();

      c.i32Const(-1);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(MATCHED);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(OFFSET);
      c.i32LtS();
      c.brIf(1);
      c.i32Const(0);
      c.localSet(FOUND);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(FOUND);
      c.end();
      c.else_();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.end();
      c.localGet(FOUND);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ROOTEND);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.localGet(ROOTEND);
      c.localSet(END);
      c.end();
      c.localGet(END);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.i32Const(0);
      c.localGet(END);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      // 1 LEN,2 ROOTEND,3 OFFSET,4 CODE,5 J,6 LAST,7 END,8 MATCHED,9 I,
      // 10 FOUND,11 RESULT
      this.mb.setBody(
        idx,
        [I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.win32Basename(path, suffix) -> str` — scr_path_win32_
   * basename: posix basename's exact structure, plus a drive-letter
   * START offset and both-slashes separator tests. */
  win32BasenameHelper(): number {
    return this.cached("win32Basename", [this.strRef(), this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const SUFFIX = 1;
      const LEN = 2;
      const START = 3;
      const END = 4;
      const MATCHED = 5;
      const SUFFIXLEN = 6;
      const HASSUFFIX = 7;
      const EXTIDX = 8;
      const FNSE = 9;
      const I = 10;
      const CODE = 11;
      const BRK = 12;
      const RESULT = 13;
      const strT = this.strType();

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.i32Const(0);
      c.localSet(START);
      c.i32Const(-1);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(MATCHED);
      // drive-letter prefix: start = 2 (its own separator is not trailing)
      c.localGet(LEN);
      c.i32Const(2);
      c.i32GeS();
      c.ifVoid(); // len>=2 guards path[0]/path[1] below (audit: nested if, not i32.and)
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.call(this.w32IsDeviceRootHelper());
      c.ifVoid();
      c.localGet(PATH);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(2);
      c.localSet(START);
      c.end();
      c.end();
      c.end();

      c.localGet(SUFFIX);
      c.arrayLen();
      c.localSet(SUFFIXLEN);
      c.localGet(SUFFIXLEN);
      c.i32Const(0);
      c.i32GtS();
      c.localGet(SUFFIXLEN);
      c.localGet(LEN);
      c.i32LeS();
      c.i32And();
      c.localSet(HASSUFFIX);

      c.localGet(HASSUFFIX);
      c.ifVoid();
      c.localGet(SUFFIXLEN);
      c.localGet(LEN);
      c.i32Eq();
      c.ifVoid();
      c.localGet(PATH);
      c.localGet(SUFFIX);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();
      c.end();
      c.localGet(SUFFIXLEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(EXTIDX);
      c.i32Const(-1);
      c.localSet(FNSE);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(START);
      c.i32LtS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CODE);
      c.i32Const(0);
      c.localSet(BRK);
      c.localGet(CODE);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(START);
      c.i32Const(1);
      c.localSet(BRK);
      c.end();
      c.else_();
      c.localGet(FNSE);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(FNSE);
      c.end();
      c.localGet(EXTIDX);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(CODE);
      c.localGet(SUFFIX);
      c.localGet(EXTIDX);
      c.arrayGetU(strT);
      c.i32Eq();
      c.ifVoid();
      c.localGet(EXTIDX);
      c.i32Const(1);
      c.i32Sub();
      c.localTee(EXTIDX);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(END);
      c.end();
      c.else_();
      c.i32Const(-1);
      c.localSet(EXTIDX);
      c.localGet(FNSE);
      c.localSet(END);
      c.end();
      c.end();
      c.end();
      c.localGet(BRK);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(START);
      c.localGet(END);
      c.i32Eq();
      c.ifVoid();
      c.localGet(FNSE);
      c.localSet(END);
      c.else_();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(LEN);
      c.localSet(END);
      c.end();
      c.end();
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.localGet(START);
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();

      // no usable suffix: the shorter loop (no ext tracking)
      c.i32Const(-1);
      c.localSet(END);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(START);
      c.i32LtS();
      c.brIf(1);
      c.i32Const(0);
      c.localSet(BRK);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(START);
      c.i32Const(1);
      c.localSet(BRK);
      c.end();
      c.else_();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(END);
      c.end();
      c.end();
      c.localGet(BRK);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.localGet(START);
      c.localGet(END);
      c.localGet(START);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      // 2 LEN,3 START,4 END,5 MATCHED,6 SUFFIXLEN,7 HASSUFFIX,8 EXTIDX,
      // 9 FNSE,10 I,11 CODE,12 BRK,13 RESULT
      this.mb.setBody(
        idx,
        [I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.win32Extname(path) -> str` — scr_path_win32_extname:
   * posix extname's exact structure, plus a drive-letter START/
   * START_PART offset and both-slashes separator tests. */
  win32ExtnameHelper(): number {
    return this.cached("win32Extname", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LEN = 1;
      const START = 2;
      const STARTDOT = 3;
      const STARTPART = 4;
      const END = 5;
      const MATCHED = 6;
      const PREDOT = 7;
      const I = 8;
      const CODE = 9;
      const BRK = 10;
      const RESULT = 11;
      const strT = this.strType();
      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      c.i32Const(0);
      c.localSet(START);
      c.i32Const(0);
      c.localSet(STARTPART);
      c.localGet(LEN);
      c.i32Const(2);
      c.i32GeS();
      c.ifVoid(); // len>=2 guards path[0]/path[1] below (audit: nested if)
      c.localGet(PATH);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Eq();
      c.ifVoid();
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.call(this.w32IsDeviceRootHelper());
      c.ifVoid();
      c.i32Const(2);
      c.localSet(START);
      c.i32Const(2);
      c.localSet(STARTPART);
      c.end();
      c.end();
      c.end();
      c.i32Const(-1);
      c.localSet(STARTDOT);
      c.i32Const(-1);
      c.localSet(END);
      c.i32Const(1);
      c.localSet(MATCHED);
      c.i32Const(0);
      c.localSet(PREDOT);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(START);
      c.i32LtS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CODE);
      c.i32Const(0);
      c.localSet(BRK);
      c.localGet(CODE);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.localGet(MATCHED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(STARTPART);
      c.i32Const(1);
      c.localSet(BRK);
      c.end();
      c.else_();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(MATCHED);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(END);
      c.end();
      c.localGet(CODE);
      c.i32Const(CH_DOT);
      c.i32Eq();
      c.ifVoid();
      c.localGet(STARTDOT);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(STARTDOT);
      c.else_();
      c.localGet(PREDOT);
      c.i32Const(1);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(PREDOT);
      c.end();
      c.end();
      c.else_();
      c.localGet(STARTDOT);
      c.i32Const(-1);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(-1);
      c.localSet(PREDOT);
      c.end();
      c.end();
      c.end();
      c.localGet(BRK);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(STARTDOT);
      c.i32Const(-1);
      c.i32Eq();
      c.localGet(END);
      c.i32Const(-1);
      c.i32Eq();
      c.i32Or();
      c.localGet(PREDOT);
      c.i32Const(0);
      c.i32Eq();
      c.i32Or();
      c.localGet(PREDOT);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(STARTDOT);
      c.localGet(END);
      c.i32Const(1);
      c.i32Sub();
      c.i32Eq();
      c.i32And();
      c.localGet(STARTDOT);
      c.localGet(STARTPART);
      c.i32Const(1);
      c.i32Add();
      c.i32Eq();
      c.i32And();
      c.i32Or();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();
      c.localGet(END);
      c.localGet(STARTDOT);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(PATH);
      c.localGet(STARTDOT);
      c.localGet(END);
      c.localGet(STARTDOT);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      // 1 LEN,2 START,3 STARTDOT,4 STARTPART,5 END,6 MATCHED,7 PREDOT,
      // 8 I,9 CODE,10 BRK,11 RESULT
      this.mb.setBody(
        idx,
        [I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.w32NormalizeRaw(path) -> str` — scr_path_w32_normalize_raw,
   * the most intricate function in this file (UNC/device-root parsing,
   * the reserved-name and CVE-2024-36139 guards). Each of the C's
   * `return;` statements becomes a `return_()` here, in the same order,
   * so the control-flow shape stays traceable against the source. `dev`
   * is built as a plain string local wherever it is a slice of `path`
   * (the drive-letter and reserved-name cases) and via a small bounded
   * scratch (len+8: "\\\\", a UNC/device-root component of the input,
   * plus a handful of literal separators/prefixes) only in the UNC
   * cases, which are the only ones that append PIECE BY PIECE. */
  w32NormalizeRawHelper(): number {
    return this.cached("w32NormalizeRaw", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LEN = 1;
      const ROOTEND = 2;
      const HASDEV = 3;
      const ISABS = 4;
      const CODE = 5;
      const J = 6;
      const LAST = 7;
      const FPSTART = 8;
      const FPLEN = 9;
      const DEV = 10;
      const CI = 11;
      const PDLEN = 12;
      const DEVSCRATCH = 13;
      const DEVO = 14;
      const TAIL = 15;
      const NORM = 16;
      const RESULT = 17;
      const INDEX = 18;
      const OUTLEN = 19;
      const POS = 20;
      const strT = this.strType();

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(LEN);
      // len==0 -> "." (scr_path.c:552-555). THE 3D THREE-WAY ORACLE
      // CAUGHT A REAL BUG HERE: this pushed CH_BACKSLASH ('\\') instead
      // of CH_DOT ('.'), so path.win32.normalize("") answered "\\"
      // instead of Node's "." — none of the 9-program differential tier
      // nor the committed path-cases.txt fuzz corpus calls normalize on
      // a bare empty string (the len==1 case right below, "a single
      // FORWARD slash normalizes", is a different branch entirely and
      // was already correct).
      c.localGet(LEN);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifResult(this.strRef());
      c.i32Const(CH_BACKSLASH);
      c.arrayNewFixed(strT, 1);
      c.else_();
      c.localGet(PATH);
      c.end();
      c.return_();
      c.end();

      c.i32Const(0);
      c.localSet(ROOTEND);
      c.i32Const(0);
      c.localSet(HASDEV);
      c.i32Const(0);
      c.localSet(ISABS);
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.localSet(DEV);
      c.localGet(PATH);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.localSet(CODE);

      c.localGet(CODE);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      // ── possible UNC root ──────────────────────────────────────────
      c.i32Const(1);
      c.localSet(ISABS);
      c.localGet(PATH);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(2);
      c.localSet(J);
      c.i32Const(2);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(LEN);
      c.i32LtS();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      c.localGet(LAST);
      c.localSet(FPSTART);
      c.localGet(J);
      c.localGet(LAST);
      c.i32Sub();
      c.localSet(FPLEN);
      c.localGet(J);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.i32Eqz();
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(LEN);
      c.i32LtS();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      c.localGet(J);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATH);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(LEN);
      c.i32Eq();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32Or();
      c.ifVoid();
      c.localGet(FPLEN);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(PATH);
      c.localGet(FPSTART);
      c.arrayGetU(strT);
      c.i32Const(CH_DOT);
      c.i32Eq();
      c.localGet(PATH);
      c.localGet(FPSTART);
      c.arrayGetU(strT);
      c.i32Const(CH_QUESTION);
      c.i32Eq();
      c.i32Or();
      c.i32And();
      c.ifVoid();
      // a device root (\\.\ or \\?\)
      c.i32Const(4);
      c.localGet(FPLEN);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEVSCRATCH);
      c.localGet(DEVSCRATCH);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVSCRATCH);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVSCRATCH);
      c.i32Const(2);
      c.localGet(PATH);
      c.localGet(FPSTART);
      c.localGet(FPLEN);
      c.arrayCopy(strT, strT);
      c.i32Const(2);
      c.localGet(FPLEN);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEV);
      c.localGet(DEV);
      c.i32Const(0);
      c.localGet(DEVSCRATCH);
      c.i32Const(0);
      c.localGet(DEV);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.i32Const(1);
      c.localSet(HASDEV);
      c.i32Const(4);
      c.localSet(ROOTEND);
      c.localGet(PATH);
      c.i32Const(0);
      c.call(this.w32ColonIndexHelper());
      c.localSet(CI);
      c.localGet(CI);
      c.i32Const(4);
      c.i32GeS();
      c.ifVoid();
      c.localGet(CI);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(4);
      c.i32Sub();
      c.localSet(PDLEN);
      c.i32Const(4);
      c.localGet(PDLEN);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEVSCRATCH);
      c.localGet(DEVSCRATCH);
      c.i32Const(0);
      c.localGet(PATH);
      c.i32Const(4);
      c.localGet(PDLEN);
      c.arrayCopy(strT, strT);
      c.localGet(DEVSCRATCH);
      c.localGet(PDLEN);
      c.i32Const(1);
      c.i32Sub();
      c.call(this.w32IsReservedHelper());
      c.ifVoid();
      c.i32Const(4);
      c.localGet(PDLEN);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEV);
      c.localGet(DEV);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEV);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEV);
      c.i32Const(2);
      c.i32Const(CH_QUESTION);
      c.arraySet(strT);
      c.localGet(DEV);
      c.i32Const(3);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEV);
      c.i32Const(4);
      c.localGet(PATH);
      c.i32Const(4);
      c.localGet(PDLEN);
      c.arrayCopy(strT, strT);
      c.i32Const(4);
      c.localGet(PDLEN);
      c.i32Add();
      c.localSet(ROOTEND);
      c.end();
      c.end();
      c.else_();
      c.localGet(J);
      c.localGet(LEN);
      c.i32Eq();
      c.ifVoid();
      // a UNC root only — normalized, nothing left to process
      // length = 2 ("\\\\") + fp_len + 1 ('\\') + (len-last) + 1 ('\\')
      c.i32Const(4);
      c.localGet(FPLEN);
      c.i32Add();
      c.localGet(LEN);
      c.localGet(LAST);
      c.i32Sub();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.localGet(PATH);
      c.localGet(FPSTART);
      c.localGet(FPLEN);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.localGet(FPLEN);
      c.i32Add();
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(3);
      c.localGet(FPLEN);
      c.i32Add();
      c.localGet(PATH);
      c.localGet(LAST);
      c.localGet(LEN);
      c.localGet(LAST);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.i32Const(3);
      c.localGet(FPLEN);
      c.i32Add();
      c.localGet(LEN);
      c.localGet(LAST);
      c.i32Sub();
      c.i32Add();
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.return_();
      c.else_();
      // a UNC root with leftovers
      c.i32Const(3);
      c.localGet(FPLEN);
      c.i32Add();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Sub();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEVSCRATCH);
      c.localGet(DEVSCRATCH);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVSCRATCH);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVSCRATCH);
      c.i32Const(2);
      c.localGet(PATH);
      c.localGet(FPSTART);
      c.localGet(FPLEN);
      c.arrayCopy(strT, strT);
      c.localGet(DEVSCRATCH);
      c.i32Const(2);
      c.localGet(FPLEN);
      c.i32Add();
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVSCRATCH);
      c.i32Const(3);
      c.localGet(FPLEN);
      c.i32Add();
      c.localGet(PATH);
      c.localGet(LAST);
      c.localGet(J);
      c.localGet(LAST);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(DEVSCRATCH);
      c.localSet(DEV);
      c.i32Const(1);
      c.localSet(HASDEV);
      c.localGet(J);
      c.localSet(ROOTEND);
      c.end();
      c.end();
      c.end();
      c.end();
      c.else_();
      c.i32Const(1);
      c.localSet(ROOTEND);
      c.end();
      c.end();
      c.else_();
      // ── not a leading separator: colon-based device/reserved check ──
      c.localGet(PATH);
      c.i32Const(0);
      c.call(this.w32ColonIndexHelper());
      c.localSet(CI);
      c.localGet(CI);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(CODE);
      c.call(this.w32IsDeviceRootHelper());
      c.localGet(CI);
      c.i32Const(1);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.i32Const(2);
      c.arrayNewDefault(strT);
      c.localSet(DEV);
      c.localGet(DEV);
      c.i32Const(0);
      c.localGet(PATH);
      c.i32Const(0);
      c.i32Const(2);
      c.arrayCopy(strT, strT);
      c.i32Const(1);
      c.localSet(HASDEV);
      c.i32Const(2);
      c.localSet(ROOTEND);
      // len>2 && is_sep(path[2]) — the right operand INDEXES path[2],
      // unsafe when len<=2 (e.g. the bare "C:" input): nested if, not
      // a bare i32.and (the exact audit-flagged shape, design §5.4).
      c.localGet(LEN);
      c.i32Const(2);
      c.i32GtS();
      c.ifVoid();
      c.localGet(PATH);
      c.i32Const(2);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(1);
      c.localSet(ISABS);
      c.i32Const(3);
      c.localSet(ROOTEND);
      c.end();
      c.end();
      c.else_();
      c.localGet(PATH);
      c.localGet(CI);
      c.call(this.w32IsReservedHelper());
      c.ifVoid();
      c.localGet(CI);
      c.i32Const(1);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEV);
      c.localGet(DEV);
      c.i32Const(0);
      c.localGet(PATH);
      c.i32Const(0);
      c.localGet(CI);
      c.i32Const(1);
      c.i32Add();
      c.arrayCopy(strT, strT);
      c.i32Const(1);
      c.localSet(HASDEV);
      c.localGet(CI);
      c.i32Const(1);
      c.i32Add();
      c.localSet(ROOTEND);
      c.end();
      c.end();
      c.end();
      c.end();

      // tail = root_end<len ? normalizeString(path[root_end,len), !is_absolute, true) : ""
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.localSet(TAIL);
      c.localGet(ROOTEND);
      c.localGet(LEN);
      c.i32LtS();
      c.ifVoid();
      c.localGet(LEN);
      c.localGet(ROOTEND);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(NORM);
      c.localGet(NORM);
      c.i32Const(0);
      c.localGet(PATH);
      c.localGet(ROOTEND);
      c.localGet(LEN);
      c.localGet(ROOTEND);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(NORM);
      c.localGet(ISABS);
      c.i32Eqz();
      c.i32Const(1);
      c.call(this.normalizeStringHelper());
      c.localSet(TAIL);
      c.end();

      c.localGet(TAIL);
      c.arrayLen();
      c.i32Eqz();
      c.localGet(ISABS);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.i32Const(1);
      c.arrayNewDefault(strT);
      c.localSet(TAIL);
      c.localGet(TAIL);
      c.i32Const(0);
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.end();
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(PATH);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Const(1);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(NORM);
      c.localGet(NORM);
      c.i32Const(0);
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(NORM);
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(NORM);
      c.localSet(TAIL);
      c.end();
      c.end();

      // CVE-2024-36139 guard
      c.localGet(ISABS);
      c.i32Eqz();
      c.localGet(HASDEV);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(PATH);
      c.i32Const(0);
      c.call(this.w32ColonIndexHelper());
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Const(2);
      c.i32GeS();
      c.ifVoid(); // len>=2 guards tail[0]/tail[1] below (audit: nested if)
      c.localGet(TAIL);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.call(this.w32IsDeviceRootHelper());
      c.ifVoid();
      c.localGet(TAIL);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(2);
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end(); // closes "tail[1]==':'"
      c.end(); // closes "isDeviceRoot(tail[0])"
      c.end(); // closes "tail.len>=2"
      c.localGet(PATH);
      c.i32Const(0);
      c.call(this.w32ColonIndexHelper());
      c.localSet(INDEX);
      c.block();
      c.loop();
      c.localGet(INDEX);
      c.i32Const(-1);
      c.i32Eq();
      c.brIf(1);
      // index==len-1 || is_sep(path[index+1]) — the right operand reads
      // path[index+1], OOB exactly when index==len-1 (audit: nested if,
      // never a bare i32.or, since the left disjunct being true is
      // precisely the case that makes the right unsafe to evaluate).
      c.localGet(INDEX);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Sub();
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(PATH);
      c.localGet(INDEX);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.end();
      c.ifVoid();
      c.i32Const(2);
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();
      c.localGet(PATH);
      c.localGet(INDEX);
      c.i32Const(1);
      c.i32Add();
      c.call(this.w32ColonIndexHelper());
      c.localSet(INDEX);
      c.br(0);
      c.end();
      c.end();
      c.end();
      c.end();

      // the reserved-name device-less prefix
      c.localGet(PATH);
      c.i32Const(0);
      c.call(this.w32ColonIndexHelper());
      c.localSet(CI);
      c.localGet(PATH);
      c.localGet(CI);
      c.call(this.w32IsReservedHelper());
      c.ifVoid();
      c.i32Const(2);
      c.localGet(DEV);
      c.arrayLen();
      c.i32Add();
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.localGet(DEV);
      c.i32Const(0);
      c.localGet(DEV);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.localGet(DEV);
      c.arrayLen();
      c.i32Add();
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();

      c.localGet(HASDEV);
      c.i32Eqz();
      c.ifResult(this.strRef());
      c.localGet(ISABS);
      c.ifResult(this.strRef());
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Const(1);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(1);
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.else_();
      c.localGet(TAIL);
      c.end();
      c.else_();
      c.localGet(ISABS);
      c.localSet(OUTLEN); // borrow OUTLEN as a plain i32 (0/1) accumulator
      c.localGet(DEV);
      c.arrayLen();
      c.localGet(OUTLEN);
      c.i32Add();
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(DEV);
      c.i32Const(0);
      c.localGet(DEV);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.i32Const(0);
      c.localSet(POS);
      c.localGet(DEV);
      c.arrayLen();
      c.localSet(POS);
      c.localGet(ISABS);
      c.ifVoid();
      c.localGet(RESULT);
      c.localGet(POS);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(POS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(POS);
      c.end();
      c.localGet(RESULT);
      c.localGet(POS);
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.end();

      this.mb.setBody(
        idx,
        [
          I32, // 1 LEN
          I32, // 2 ROOTEND
          I32, // 3 HASDEV
          I32, // 4 ISABS
          I32, // 5 CODE
          I32, // 6 J
          I32, // 7 LAST
          I32, // 8 FPSTART
          I32, // 9 FPLEN
          this.strRef(), // 10 DEV
          I32, // 11 CI
          I32, // 12 PDLEN
          this.strRef(), // 13 DEVSCRATCH
          I32, // 14 DEVO (unused directly; kept for index-plan parity)
          this.strRef(), // 15 TAIL
          this.strRef(), // 16 NORM
          this.strRef(), // 17 RESULT
          I32, // 18 INDEX
          I32, // 19 OUTLEN
          I32, // 20 POS
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.win32Normalize(path) -> str` — a thin wrapper over
   * w32NormalizeRaw, matching scr_path_win32_normalize's own shape. */
  win32NormalizeHelper(): number {
    return this.cached("win32Normalize", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.call(this.w32NormalizeRawHelper());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `%w.path.win32Join(parts) -> str` — scr_path_win32_join: the same
   * pre-pass-sum join as posix (backslash separator), then the UNC-
   * prefix collapse (rebuilt as a fresh shorter array — WasmGC has no
   * in-place shrink, unlike the C's memmove), then the reserved-device-
   * name check over each backslash-delimited segment (materialized as
   * its own string slice, since w32ColonIndex/w32IsReserved take a
   * whole string, not a pointer+length pair). */
  win32JoinHelper(): number {
    return this.cached("win32Join", [this.deps.stringVecRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PARTS = 0;
      const N = 1;
      const I = 2;
      const TOTAL = 3;
      const ARG = 4;
      const ARGLEN = 5;
      const SCRATCH = 6;
      const O = 7;
      const ANY = 8;
      const FIRSTLEN = 9;
      const JOINED = 10;
      const SLASHCOUNT = 11;
      const NEEDSREPLACE = 12;
      const NEWLEN = 13;
      const NEWJOINED = 14;
      const RESERVED = 15;
      const START = 16;
      const SEGLEN = 17;
      const SEG = 18;
      const CI = 19;
      const RESULT = 20;
      const strT = this.strType();
      const vi = this.deps.stringVecInfo();

      c.localGet(PARTS);
      c.structGet(vi.struct, LEN);
      c.localSet(N);
      c.localGet(N);
      c.localSet(TOTAL);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PARTS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.arrayLen();
      c.localGet(TOTAL);
      c.i32Add();
      c.localSet(TOTAL);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(TOTAL);
      c.arrayNewDefault(strT);
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(O);
      c.i32Const(0);
      c.localSet(ANY);
      c.i32Const(0);
      c.localSet(FIRSTLEN);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PARTS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.localSet(ARG);
      c.localGet(ARG);
      c.arrayLen();
      c.localSet(ARGLEN);
      c.localGet(ARGLEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ANY);
      c.ifVoid();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.localSet(O);
      c.else_();
      c.localGet(ARGLEN);
      c.localSet(FIRSTLEN);
      c.end();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.localGet(ARG);
      c.i32Const(0);
      c.localGet(ARGLEN);
      c.arrayCopy(strT, strT);
      c.localGet(O);
      c.localGet(ARGLEN);
      c.i32Add();
      c.localSet(O);
      c.i32Const(1);
      c.localSet(ANY);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(ANY);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.return_();
      c.end();

      c.localGet(O);
      c.arrayNewDefault(strT);
      c.localSet(JOINED);
      c.localGet(JOINED);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(strT, strT);

      // the UNC-collapse guard (scr_path.c's needs_replace/slash_count)
      c.i32Const(1);
      c.localSet(NEEDSREPLACE);
      c.i32Const(0);
      c.localSet(SLASHCOUNT);
      c.localGet(JOINED);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(1);
      c.localSet(SLASHCOUNT);
      c.localGet(FIRSTLEN);
      c.i32Const(1);
      c.i32GtS();
      c.ifVoid(); // firstLen>1 guards joined[1] below (audit: nested if)
      c.localGet(JOINED);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(2);
      c.localSet(SLASHCOUNT);
      c.localGet(FIRSTLEN);
      c.i32Const(2);
      c.i32GtS();
      c.ifVoid();
      c.localGet(JOINED);
      c.i32Const(2);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(3);
      c.localSet(SLASHCOUNT);
      c.else_();
      c.i32Const(0);
      c.localSet(NEEDSREPLACE);
      c.end();
      c.end();
      c.end();
      c.end();
      c.end();

      c.localGet(NEEDSREPLACE);
      c.ifVoid();
      c.block();
      c.loop();
      c.localGet(SLASHCOUNT);
      c.localGet(JOINED);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(JOINED);
      c.localGet(SLASHCOUNT);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.i32Eqz();
      c.brIf(1);
      c.localGet(SLASHCOUNT);
      c.i32Const(1);
      c.i32Add();
      c.localSet(SLASHCOUNT);
      c.br(0);
      c.end();
      c.end();
      c.localGet(SLASHCOUNT);
      c.i32Const(2);
      c.i32GeS();
      c.ifVoid();
      c.localGet(JOINED);
      c.arrayLen();
      c.localGet(SLASHCOUNT);
      c.i32Sub();
      c.i32Const(1);
      c.i32Add();
      c.localSet(NEWLEN);
      c.localGet(NEWLEN);
      c.arrayNewDefault(strT);
      c.localSet(NEWJOINED);
      c.localGet(NEWJOINED);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(NEWJOINED);
      c.i32Const(1);
      c.localGet(JOINED);
      c.localGet(SLASHCOUNT);
      c.localGet(JOINED);
      c.arrayLen();
      c.localGet(SLASHCOUNT);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(NEWJOINED);
      c.localSet(JOINED);
      c.end();
      c.end();

      // reserved-device-name check over each "\\"-delimited segment
      c.i32Const(0);
      c.localSet(RESERVED);
      c.i32Const(0);
      c.localSet(START);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(JOINED);
      c.arrayLen();
      c.i32GtS();
      c.brIf(1);
      c.localGet(RESERVED);
      c.brIf(1);
      c.localGet(I);
      c.localGet(JOINED);
      c.arrayLen();
      c.i32Eq();
      c.localGet(I);
      c.localGet(JOINED);
      c.arrayLen();
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(JOINED);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.else_();
      c.i32Const(0);
      c.end();
      c.i32Or();
      c.ifVoid();
      c.localGet(I);
      c.localGet(START);
      c.i32GtS();
      c.ifVoid();
      c.localGet(I);
      c.localGet(START);
      c.i32Sub();
      c.localSet(SEGLEN);
      c.localGet(SEGLEN);
      c.arrayNewDefault(strT);
      c.localSet(SEG);
      c.localGet(SEG);
      c.i32Const(0);
      c.localGet(JOINED);
      c.localGet(START);
      c.localGet(SEGLEN);
      c.arrayCopy(strT, strT);
      c.localGet(SEG);
      c.i32Const(0);
      c.call(this.w32ColonIndexHelper());
      c.localSet(CI);
      c.localGet(CI);
      c.i32Const(-1);
      c.i32Ne();
      c.ifVoid();
      c.localGet(SEG);
      c.localGet(CI);
      c.call(this.w32IsReservedHelper());
      c.ifVoid();
      c.i32Const(1);
      c.localSet(RESERVED);
      c.end();
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(START);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(RESERVED);
      c.ifVoid();
      c.localGet(JOINED);
      c.arrayLen();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(JOINED);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(RESULT);
      c.localGet(I);
      c.localGet(JOINED);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localTee(CI); // reuse CI as a char scratch here
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(CH_BACKSLASH);
      c.else_();
      c.localGet(CI);
      c.end();
      c.arraySet(strT);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(RESULT);
      c.return_();
      c.end();

      c.localGet(JOINED);
      c.call(this.w32NormalizeRawHelper());
      this.mb.setBody(
        idx,
        [
          I32, // 1 N
          I32, // 2 I
          I32, // 3 TOTAL
          this.strRef(), // 4 ARG
          I32, // 5 ARGLEN
          this.strRef(), // 6 SCRATCH
          I32, // 7 O
          I32, // 8 ANY
          I32, // 9 FIRSTLEN
          this.strRef(), // 10 JOINED
          I32, // 11 SLASHCOUNT
          I32, // 12 NEEDSREPLACE
          I32, // 13 NEWLEN
          this.strRef(), // 14 NEWJOINED
          I32, // 15 RESERVED
          I32, // 16 START
          I32, // 17 SEGLEN
          this.strRef(), // 18 SEG
          I32, // 19 CI
          this.strRef(), // 20 RESULT
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.win32Resolve(parts) -> str` — scr_path_win32_resolve.
   * TWO measured departures from a literal transcription, both stated
   * here rather than left implicit:
   * (1) the loop's own C condition is `for (i=n-1; i>=-1; i--)` — NO
   *     `&& !resolved_absolute` guard (unlike posix resolve) — because
   *     an absolute segment alone does not stop the scan: win32 keeps
   *     looking for a CONSISTENT drive letter until it also has a
   *     device, via the explicit `if (resolved_absolute) { if (dev.len
   *     > 0) break; }` inside the body. This port keeps that shape
   *     exactly (a BREAK_OUTER flag checked once per iteration at loop-
   *     top level, set from two places: this early-break and the
   *     later `if (is_absolute && dev.len>0) break`).
   * (2) the `i==-1, dev.len!=0` branch's `getenv("=C:")`-style hidden
   *     per-drive cwd lookup is a Windows CRT feature this tier's own
   *     header says is compile-time `#ifdef`'d to POSIX behaviour
   *     (§ file header, the `#ifndef _WIN32` fast-path flip) — on the
   *     POSIX host this always compiles to, `getenv("=X:")` returns
   *     NULL unconditionally, so `dcwd && *dcwd` is always false and
   *     the C itself always falls through to `scr_path_cwd`. This port
   *     goes straight there, never modelling a getenv call that could
   *     never succeed on this tier's actual target. */
  win32ResolveHelper(): number {
    return this.cached("win32Resolve", [this.deps.stringVecRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PARTS = 0;
      const N = 1;
      const I = 2;
      const DEV = 3;
      const TAIL = 4;
      const RESOLVEDABS = 5;
      const PATHB = 6;
      const ARGLEN = 7;
      const FAST = 8;
      const A0 = 9;
      const EMPTYORDOT = 10;
      const PLEN = 11;
      const ROOTEND = 12;
      const DEVICE = 13;
      const ISABS = 14;
      const CODE = 15;
      const J = 16;
      const LAST = 17;
      const FPSTART = 18;
      const FPLEN = 19;
      const BREAKOUTER = 20;
      const K = 21;
      const NORM = 22;
      const OUT = 23;
      const POS = 24;
      const NT = 25;
      const strT = this.strType();
      const vi = this.deps.stringVecInfo();

      c.localGet(PARTS);
      c.structGet(vi.struct, LEN);
      c.localSet(N);
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.localSet(DEV);
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.localSet(TAIL);
      c.i32Const(0);
      c.localSet(RESOLVEDABS);

      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(-1);
      c.i32LtS();
      c.brIf(1);

      c.i32Const(0);
      c.localSet(BREAKOUTER);
      c.localGet(I);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(this.strRef());
      c.localGet(PARTS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.else_();
      c.localGet(DEV);
      c.arrayLen();
      c.i32Eqz();
      c.ifResult(this.strRef());
      c.call(this.cwdSnapshotHelper());
      c.localSet(PATHB);
      c.i32Const(0);
      c.localSet(FAST);
      c.localGet(N);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(FAST);
      c.end();
      c.localGet(FAST);
      c.i32Eqz();
      c.localGet(N);
      c.i32Const(1);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.localGet(PARTS);
      c.f64Const(0);
      c.call(this.deps.stringVecGet());
      c.localSet(A0);
      // empty_or_dot = a0.len==0 || (a0.len==1 && a0.data[0]=='.') — the
      // right disjunct's own right operand reads a0.data[0], OOB when
      // a0.len==0: nested if throughout, never a bare i32.or/i32.and
      // (audit: this is exactly the shape a bare AND/OR must not take).
      c.localGet(A0);
      c.arrayLen();
      c.i32Eqz();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(A0);
      c.arrayLen();
      c.i32Const(1);
      c.i32Eq();
      c.ifResult(I32);
      c.localGet(A0);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(CH_DOT);
      c.i32Eq();
      c.else_();
      c.i32Const(0);
      c.end();
      c.end();
      c.localSet(EMPTYORDOT);
      c.localGet(EMPTYORDOT);
      c.localGet(PATHB);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.i32And();
      c.ifVoid();
      // both prior conjuncts already hold true (we're inside the if) —
      // FAST is simply this third term, no further AND needed.
      c.localGet(PATHB);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.localSet(FAST);
      c.end();
      c.end();
      c.localGet(FAST);
      c.ifVoid();
      // build a FRESH flipped copy — PATHB here IS the cached cwd
      // snapshot's own array (cwdSnapshotHelper's shared global); it
      // must never be mutated in place, or every later cwd read in
      // this program would see the flip too. NT/J are reused as plain
      // scratch (both are free at this point in the function: NT's own
      // use is later, after this early return already fires when FAST).
      c.localGet(PATHB);
      c.arrayLen();
      c.arrayNewDefault(strT);
      c.localSet(NT);
      c.i32Const(0);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(PATHB);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(NT);
      c.localGet(K);
      c.localGet(PATHB);
      c.localGet(K);
      c.arrayGetU(strT);
      c.localTee(J);
      c.i32Const(CH_SLASH);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(CH_BACKSLASH);
      c.else_();
      c.localGet(J);
      c.end();
      c.arraySet(strT);
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();
      c.localGet(NT);
      c.return_();
      c.end();
      c.localGet(PATHB);
      c.else_();
      c.call(this.cwdSnapshotHelper());
      c.end();
      c.end();
      // the OUTER if (i>=0 ? stringVecGet(i) : the dev.len==0/else block
      // above) leaves ITS result here — consumed exactly once, at this
      // scope, not nested one level too deep inside the dev.len==0 else.
      c.localSet(PATHB);

      // scr_path.c's `if (arg->len == 0) { ...; continue; }` (i>=0 only —
      // a positional argument that is the empty string skips the ENTIRE
      // rest of this iteration, never touching root_end/device/tail; the
      // i==-1 branches (cwd / per-drive env fallback) never produce an
      // empty pathb, so gating the WHOLE remaining body on PATHB being
      // non-empty is a faithful, universal stand-in for that `continue`).
      // THE 3D THREE-WAY ORACLE CAUGHT THIS AS A REAL BUG: this guard was
      // MISSING entirely, so `path.win32.resolve("")` read PATHB[0] on a
      // zero-length array (path.win32.resolve("") skips its only
      // argument via this exact C continue, then falls through to the
      // cwd fast path) -- an out-of-bounds trap, not caught by the 9-
      // program differential tier (1610 never calls resolve with an
      // empty positional argument).
      c.localGet(PATHB);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();

      // compute root_end/is_absolute/device for THIS pathb
      c.localGet(PATHB);
      c.arrayLen();
      c.localSet(PLEN);
      c.i32Const(0);
      c.localSet(ROOTEND);
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.localSet(DEVICE);
      c.i32Const(0);
      c.localSet(ISABS);
      c.localGet(PATHB);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.localSet(CODE);

      c.localGet(PLEN);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CODE);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(1);
      c.localSet(ROOTEND);
      c.i32Const(1);
      c.localSet(ISABS);
      c.end();
      c.else_();
      c.localGet(CODE);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(1);
      c.localSet(ISABS);
      c.localGet(PATHB);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(2);
      c.localSet(J);
      c.i32Const(2);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(PLEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATHB);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(PLEN);
      c.i32LtS();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      c.localGet(LAST);
      c.localSet(FPSTART);
      c.localGet(J);
      c.localGet(LAST);
      c.i32Sub();
      c.localSet(FPLEN);
      c.localGet(J);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(PLEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATHB);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.i32Eqz();
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(PLEN);
      c.i32LtS();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      c.localGet(J);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(PLEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(PATHB);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.brIf(1);
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(J);
      c.localGet(PLEN);
      c.i32Eq();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Ne();
      c.i32Or();
      c.ifVoid();
      c.localGet(FPLEN);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(PATHB);
      c.localGet(FPSTART);
      c.arrayGetU(strT);
      c.i32Const(CH_DOT);
      c.i32Eq();
      c.localGet(PATHB);
      c.localGet(FPSTART);
      c.arrayGetU(strT);
      c.i32Const(CH_QUESTION);
      c.i32Eq();
      c.i32Or();
      c.i32And();
      c.i32Eqz();
      c.ifVoid();
      // a UNC root
      c.i32Const(3);
      c.localGet(FPLEN);
      c.i32Add();
      c.localGet(J);
      c.localGet(LAST);
      c.i32Sub();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEVICE);
      c.localGet(DEVICE);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVICE);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVICE);
      c.i32Const(2);
      c.localGet(PATHB);
      c.localGet(FPSTART);
      c.localGet(FPLEN);
      c.arrayCopy(strT, strT);
      c.localGet(DEVICE);
      c.i32Const(2);
      c.localGet(FPLEN);
      c.i32Add();
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVICE);
      c.i32Const(3);
      c.localGet(FPLEN);
      c.i32Add();
      c.localGet(PATHB);
      c.localGet(LAST);
      c.localGet(J);
      c.localGet(LAST);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(J);
      c.localSet(ROOTEND);
      c.else_();
      // a device root (\\.\PHYSICALDRIVE0 style)
      c.i32Const(2);
      c.localGet(FPLEN);
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(DEVICE);
      c.localGet(DEVICE);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVICE);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(DEVICE);
      c.i32Const(2);
      c.localGet(PATHB);
      c.localGet(FPSTART);
      c.localGet(FPLEN);
      c.arrayCopy(strT, strT);
      c.i32Const(4);
      c.localSet(ROOTEND);
      c.end();
      c.end();
      c.end();
      c.end();
      c.else_();
      c.i32Const(1);
      c.localSet(ROOTEND);
      c.end();
      c.else_();
      c.localGet(CODE);
      c.call(this.w32IsDeviceRootHelper());
      c.localGet(PATHB);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.i32Const(2);
      c.arrayNewDefault(strT);
      c.localSet(DEVICE);
      c.localGet(DEVICE);
      c.i32Const(0);
      c.localGet(PATHB);
      c.i32Const(0);
      c.i32Const(2);
      c.arrayCopy(strT, strT);
      c.i32Const(2);
      c.localSet(ROOTEND);
      // len>2 && is_sep(pathb[2]) — nested if, not i32.and (audit)
      c.localGet(PLEN);
      c.i32Const(2);
      c.i32GtS();
      c.ifVoid();
      c.localGet(PATHB);
      c.i32Const(2);
      c.arrayGetU(strT);
      c.i32Const(1);
      c.call(this.isSepHelper());
      c.ifVoid();
      c.i32Const(1);
      c.localSet(ISABS);
      c.i32Const(3);
      c.localSet(ROOTEND);
      c.end(); // closes "is_sep(pathb[2])"
      c.end(); // closes "len>2"
      c.end(); // closes "is_device_root(code) && path[1]==':'" (IF-2's else)
      c.end(); // closes IF-2 ("is_sep(code)", opened its else at line 4858)
      c.end(); // closes IF-1 (the len==1 / isSep(code)-else three-way)
      // (the outer block/loop stay open — device reconciliation and
      // tail-building below are still part of THIS iteration's body)

      // device/dev reconciliation. A MISMATCH is the C's `continue` (skip
      // straight to the next i, never touching the tail/resolved_absolute
      // below) — NOT a `break`. Reusing K (dead here: the FAST branch that
      // owns it above either returned or fell through already) as a
      // CONTINUEITER flag, kept structurally separate from BREAKOUTER.
      c.i32Const(0);
      c.localSet(K);
      c.localGet(DEVICE);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(DEV);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(DEVICE);
      c.arrayLen();
      c.localGet(DEV);
      c.arrayLen();
      c.i32Eq();
      c.i32Eqz();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(DEVICE);
      c.localGet(DEV);
      c.localGet(DEV);
      c.arrayLen();
      c.call(this.w32IeqHelper());
      c.i32Eqz();
      c.end();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(K); // CONTINUEITER = true (device mismatch)
      c.end();
      c.else_();
      c.localGet(DEVICE);
      c.localSet(DEV);
      c.end();
      c.end();

      c.localGet(K);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(BREAKOUTER);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(RESOLVEDABS);
      c.ifVoid();
      c.localGet(DEV);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(BREAKOUTER);
      c.end();
      c.else_();
      // resolvedTail = path[root_end,len) + '\\' + tail
      c.localGet(PLEN);
      c.localGet(ROOTEND);
      c.i32Sub();
      c.i32Const(1);
      c.i32Add();
      c.localGet(TAIL);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(NT);
      c.localGet(NT);
      c.i32Const(0);
      c.localGet(PATHB);
      c.localGet(ROOTEND);
      c.localGet(PLEN);
      c.localGet(ROOTEND);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(NT);
      c.localGet(PLEN);
      c.localGet(ROOTEND);
      c.i32Sub();
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(NT);
      c.localGet(PLEN);
      c.localGet(ROOTEND);
      c.i32Sub();
      c.i32Const(1);
      c.i32Add();
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(NT);
      c.localSet(TAIL);
      c.localGet(ISABS);
      c.localSet(RESOLVEDABS);
      c.localGet(ISABS);
      c.localGet(DEV);
      c.arrayLen();
      c.i32Const(0);
      c.i32GtS();
      c.i32And();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(BREAKOUTER);
      c.end(); // closes "is_absolute && dev.len>0"
      c.end(); // closes "if(resolvedAbs) {...} else {...}"
      c.end(); // closes "if(!BREAKOUTER)"
      c.end(); // closes "if(!CONTINUEITER)" (K==0)
      c.end(); // closes "if(PATHB.length>0)" (arg->len==0 continue stand-in)

      c.localGet(BREAKOUTER);
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(TAIL);
      c.arrayLen();
      c.arrayNewDefault(strT);
      c.localSet(NORM);
      c.localGet(NORM);
      c.i32Const(0);
      c.localGet(TAIL);
      c.i32Const(0);
      c.localGet(TAIL);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(NORM);
      c.localGet(RESOLVEDABS);
      c.i32Eqz();
      c.i32Const(1);
      c.call(this.normalizeStringHelper());
      c.localSet(NORM);

      c.localGet(RESOLVEDABS);
      c.ifResult(this.strRef());
      c.i32Const(1);
      c.localGet(DEV);
      c.arrayLen();
      c.i32Add();
      c.localGet(NORM);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(OUT);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(DEV);
      c.i32Const(0);
      c.localGet(DEV);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(OUT);
      c.localGet(DEV);
      c.arrayLen();
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(OUT);
      c.localGet(DEV);
      c.arrayLen();
      c.i32Const(1);
      c.i32Add();
      c.localGet(NORM);
      c.i32Const(0);
      c.localGet(NORM);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(OUT);
      c.else_();
      c.localGet(DEV);
      c.arrayLen();
      c.localGet(NORM);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(OUT);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(DEV);
      c.i32Const(0);
      c.localGet(DEV);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(OUT);
      c.localGet(DEV);
      c.arrayLen();
      c.localGet(NORM);
      c.i32Const(0);
      c.localGet(NORM);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(OUT);
      c.arrayLen();
      c.i32Eqz();
      c.ifResult(this.strRef());
      c.i32Const(CH_DOT);
      c.arrayNewFixed(strT, 1);
      c.else_();
      c.localGet(OUT);
      c.end();
      c.end();

      this.mb.setBody(
        idx,
        [
          I32, // 1 N
          I32, // 2 I
          this.strRef(), // 3 DEV
          this.strRef(), // 4 TAIL
          I32, // 5 RESOLVEDABS
          this.strRef(), // 6 PATHB
          I32, // 7 ARGLEN (unused directly; kept for index-plan parity)
          I32, // 8 FAST
          this.strRef(), // 9 A0
          I32, // 10 EMPTYORDOT
          I32, // 11 PLEN
          I32, // 12 ROOTEND
          this.strRef(), // 13 DEVICE
          I32, // 14 ISABS
          I32, // 15 CODE
          I32, // 16 J
          I32, // 17 LAST
          I32, // 18 FPSTART
          I32, // 19 FPLEN
          I32, // 20 BREAKOUTER
          I32, // 21 K
          this.strRef(), // 22 NORM
          this.strRef(), // 23 OUT
          I32, // 24 POS (unused directly; kept for index-plan parity)
          this.strRef(), // 25 NT
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.win32Relative(from, to) -> str` — scr_path_win32_
   * relative. NOT a copy of posix relative's structure: win32 case-
   * folds both sides for comparison (via fresh lowered copies — the
   * OUTPUT slices still come from the ORIGINAL resolved strings, never
   * the folded ones), trims leading/trailing backslashes on BOTH sides
   * (posix hardcodes a single leading '/'), and has a genuine extra arm
   * posix's version does not: `if (i != length) { if (last_common_sep
   * == -1) result = toOrig; }` — a mismatch before any common separator
   * returns the WHOLE resolved `to`, verbatim. `result` is modelled as
   * a HASRESULT flag (a GC ref has no cheap "not yet computed" sentinel
   * here) rather than the C's NULL check. */
  win32RelativeHelper(): number {
    return this.cached("win32Relative", [this.strRef(), this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const FROM = 0;
      const TO = 1;
      const RFROM = 2;
      const RTO = 3;
      const FLOW = 4;
      const TLOW = 5;
      const FROMSTART = 6;
      const FROMEND = 7;
      const FROMLEN = 8;
      const TOSTART = 9;
      const TOEND = 10;
      const TOLEN = 11;
      const LENGTH = 12;
      const I = 13;
      const LASTCOMMONSEP = 14;
      const RESULT = 15;
      const HASRESULT = 16;
      const K = 17;
      const CH = 18;
      const SCRATCH = 19;
      const O = 20;
      const J = 21;
      const PACK = 22;
      const strT = this.strType();

      c.localGet(FROM);
      c.localGet(TO);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();

      c.f64Const(1);
      c.call(this.deps.stringVecNewLen());
      c.localSet(PACK);
      c.localGet(PACK);
      c.f64Const(0);
      c.localGet(FROM);
      c.call(this.deps.stringVecSet());
      c.localGet(PACK);
      c.call(this.win32ResolveHelper());
      c.localSet(RFROM);
      c.f64Const(1);
      c.call(this.deps.stringVecNewLen());
      c.localSet(PACK);
      c.localGet(PACK);
      c.f64Const(0);
      c.localGet(TO);
      c.call(this.deps.stringVecSet());
      c.localGet(PACK);
      c.call(this.win32ResolveHelper());
      c.localSet(RTO);

      c.localGet(RFROM);
      c.localGet(RTO);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();

      // lowered copies (ASCII-only, matching w32Lower's own divergence)
      c.localGet(RFROM);
      c.arrayLen();
      c.arrayNewDefault(strT);
      c.localSet(FLOW);
      c.i32Const(0);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(RFROM);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(FLOW);
      c.localGet(K);
      c.localGet(RFROM);
      c.localGet(K);
      c.arrayGetU(strT);
      c.call(this.w32LowerHelper());
      c.arraySet(strT);
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();
      c.localGet(RTO);
      c.arrayLen();
      c.arrayNewDefault(strT);
      c.localSet(TLOW);
      c.i32Const(0);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(RTO);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(TLOW);
      c.localGet(K);
      c.localGet(RTO);
      c.localGet(K);
      c.arrayGetU(strT);
      c.call(this.w32LowerHelper());
      c.arraySet(strT);
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();

      c.localGet(FLOW);
      c.localGet(TLOW);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(strT);
      c.return_();
      c.end();

      // trim leading/trailing backslashes (BOTH sides)
      c.i32Const(0);
      c.localSet(FROMSTART);
      c.block();
      c.loop();
      c.localGet(FROMSTART);
      c.localGet(FLOW);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(FLOW);
      c.localGet(FROMSTART);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Ne();
      c.brIf(1);
      c.localGet(FROMSTART);
      c.i32Const(1);
      c.i32Add();
      c.localSet(FROMSTART);
      c.br(0);
      c.end();
      c.end();
      c.localGet(FLOW);
      c.arrayLen();
      c.localSet(FROMEND);
      c.block();
      c.loop();
      c.localGet(FROMEND);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(FROMSTART);
      c.i32LeS();
      c.brIf(1);
      c.localGet(FLOW);
      c.localGet(FROMEND);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Ne();
      c.brIf(1);
      c.localGet(FROMEND);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(FROMEND);
      c.br(0);
      c.end();
      c.end();
      c.localGet(FROMEND);
      c.localGet(FROMSTART);
      c.i32Sub();
      c.localSet(FROMLEN);

      c.i32Const(0);
      c.localSet(TOSTART);
      c.block();
      c.loop();
      c.localGet(TOSTART);
      c.localGet(TLOW);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(TLOW);
      c.localGet(TOSTART);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Ne();
      c.brIf(1);
      c.localGet(TOSTART);
      c.i32Const(1);
      c.i32Add();
      c.localSet(TOSTART);
      c.br(0);
      c.end();
      c.end();
      c.localGet(TLOW);
      c.arrayLen();
      c.localSet(TOEND);
      c.block();
      c.loop();
      c.localGet(TOEND);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(TOSTART);
      c.i32LeS();
      c.brIf(1);
      c.localGet(TLOW);
      c.localGet(TOEND);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Ne();
      c.brIf(1);
      c.localGet(TOEND);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(TOEND);
      c.br(0);
      c.end();
      c.end();
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.i32Sub();
      c.localSet(TOLEN);

      c.localGet(FROMLEN);
      c.localGet(TOLEN);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(FROMLEN);
      c.else_();
      c.localGet(TOLEN);
      c.end();
      c.localSet(LENGTH);

      c.i32Const(-1);
      c.localSet(LASTCOMMONSEP);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LENGTH);
      c.i32GeS();
      c.brIf(1);
      c.localGet(FLOW);
      c.localGet(FROMSTART);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.localGet(TLOW);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Ne();
      c.brIf(1);
      c.localGet(FLOW);
      c.localGet(FROMSTART);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(LASTCOMMONSEP);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.i32Const(0);
      c.localSet(HASRESULT);
      c.localGet(I);
      c.localGet(LENGTH);
      c.i32Ne();
      c.ifVoid();
      c.localGet(LASTCOMMONSEP);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(RTO);
      c.localSet(RESULT);
      c.i32Const(1);
      c.localSet(HASRESULT);
      c.end();
      c.else_();
      c.localGet(TOLEN);
      c.localGet(LENGTH);
      c.i32GtS();
      c.ifVoid();
      c.localGet(TLOW);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.i32Const(1);
      c.i32Add();
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(RTO);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.i32Const(1);
      c.i32Add();
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.i32Const(1);
      c.i32Add();
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.i32Const(1);
      c.localSet(HASRESULT);
      c.else_();
      c.localGet(I);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(RTO);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.localGet(I);
      c.i32Add();
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.i32Const(1);
      c.localSet(HASRESULT);
      c.end();
      c.end();
      c.end();
      // THE 3D THREE-WAY ORACLE CAUGHT A REAL BUG HERE: the "else if"
      // below used posix.relative's own rule (`i===0 -> lastCommonSep=0`)
      // instead of win32.relative's OWN rule (Node's real source: `else
      // if (i===2) lastCommonSep=3`, "we get here if `to` is the device
      // root", e.g. from='C:\\foo\\bar' to='C:\\') — a DIFFERENT
      // function, DIFFERENT absolute constants, not a copy-paste-safe
      // shared shape despite the surrounding structure looking twin-
      // symmetric with posix's own branch. Example that reddened this:
      // win32.relative("x.CON/prn/", "x.") needs lastCommonSep=3 (i==2
      // here) to answer "..\\.." — the wrong rule left it unset (-1),
      // which the safety net two blocks below then coerced to 0, and the
      // wrong suffix start appended a stray "x." onto the correct answer.
      c.localGet(HASRESULT);
      c.i32Eqz();
      c.localGet(FROMLEN);
      c.localGet(LENGTH);
      c.i32GtS();
      c.i32And();
      c.ifVoid();
      c.localGet(FLOW);
      c.localGet(FROMSTART);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localSet(LASTCOMMONSEP);
      c.else_();
      c.localGet(I);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(3);
      c.localSet(LASTCOMMONSEP);
      c.end();
      c.end();
      c.end();
      c.localGet(HASRESULT);
      c.i32Eqz();
      c.localGet(LASTCOMMONSEP);
      c.i32Const(-1);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(LASTCOMMONSEP);
      c.end();
      c.end();

      c.localGet(HASRESULT);
      c.ifVoid();
      c.localGet(RESULT);
      c.return_();
      c.end();

      // trailer: ".." per remaining from-segment, then the to suffix.
      // Same bound shape as relativeHelper (posix); FIXED there for the
      // same reason (fromEnd - lastCommonSep - 1, not fromEnd - 1 +
      // lastCommonSep) even though NOT independently exploitable here:
      // this function's own safety net two blocks above already forces
      // lastCommonSep to 0 whenever it would otherwise be -1 (Node's own
      // win32.relative does the same coercion, unlike posix.relative),
      // so lastCommonSep is never negative by this point and the two
      // formulas agree (equal at 0, and the WRONG formula only ever
      // under-counts when lastCommonSep is negative). Fixed anyway for
      // consistency with the twin function, not asserted as a live bug.
      c.localGet(FROMEND);
      c.localGet(LASTCOMMONSEP);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.i32Const(3);
      c.i32Mul();
      c.localGet(RTO);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(O);
      c.localGet(FROMSTART);
      c.localGet(LASTCOMMONSEP);
      c.i32Add();
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(FROMEND);
      c.i32GtS();
      c.brIf(1);
      c.localGet(J);
      c.localGet(FROMEND);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(FLOW);
      c.localGet(J);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.end();
      c.ifVoid();
      c.localGet(O);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(2);
      c.i32Add();
      c.localSet(O);
      c.else_();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(SCRATCH);
      c.localGet(O);
      c.i32Const(2);
      c.i32Add();
      c.i32Const(CH_DOT);
      c.arraySet(strT);
      c.localGet(O);
      c.i32Const(3);
      c.i32Add();
      c.localSet(O);
      c.end();
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();

      c.localGet(TOSTART);
      c.localGet(LASTCOMMONSEP);
      c.i32Add();
      c.localSet(TOSTART);
      c.localGet(O);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(TOSTART);
      c.localGet(RTO);
      c.arrayLen();
      c.i32LtS();
      c.ifVoid();
      c.localGet(RTO);
      c.localGet(TOSTART);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(TOSTART);
      c.i32Const(1);
      c.i32Add();
      c.localSet(TOSTART);
      c.end();
      c.end();
      c.end();
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.i32GtS();
      c.ifVoid();
      c.localGet(SCRATCH);
      c.localGet(O);
      c.localGet(RTO);
      c.localGet(TOSTART);
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(O);
      c.localGet(TOEND);
      c.localGet(TOSTART);
      c.i32Sub();
      c.i32Add();
      c.localSet(O);
      c.end();

      c.localGet(O);
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);

      this.mb.setBody(
        idx,
        [
          this.strRef(), // 2 RFROM
          this.strRef(), // 3 RTO
          this.strRef(), // 4 FLOW
          this.strRef(), // 5 TLOW
          I32, // 6 FROMSTART
          I32, // 7 FROMEND
          I32, // 8 FROMLEN
          I32, // 9 TOSTART
          I32, // 10 TOEND
          I32, // 11 TOLEN
          I32, // 12 LENGTH
          I32, // 13 I
          I32, // 14 LASTCOMMONSEP
          this.strRef(), // 15 RESULT
          I32, // 16 HASRESULT
          I32, // 17 K
          I32, // 18 CH (unused directly; kept for index-plan parity)
          this.strRef(), // 19 SCRATCH
          I32, // 20 O
          I32, // 21 J
          this.deps.stringVecRef(), // 22 PACK
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `%w.path.win32ToNamespacedPath(path) -> str` —
   * scr_path_win32_to_namespaced_path. */
  win32ToNamespacedPathHelper(): number {
    return this.cached("win32ToNamespacedPath", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const PACK = 1;
      const RESOLVED = 2;
      const CODE = 3;
      const RESULT = 4;
      const strT = this.strType();

      c.localGet(PATH);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(PATH);
      c.return_();
      c.end();

      c.f64Const(1);
      c.call(this.deps.stringVecNewLen());
      c.localSet(PACK);
      c.localGet(PACK);
      c.f64Const(0);
      c.localGet(PATH);
      c.call(this.deps.stringVecSet());
      c.localGet(PACK);
      c.call(this.win32ResolveHelper());
      c.localSet(RESOLVED);

      // Node's `resolvedPath.length <= 2` counts UTF-16 units directly —
      // this tier's arrayLen already IS the UTF-16 unit count.
      c.localGet(RESOLVED);
      c.arrayLen();
      c.i32Const(2);
      c.i32LeS();
      c.ifVoid();
      c.localGet(PATH);
      c.return_();
      c.end();

      c.localGet(RESOLVED);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(RESOLVED);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.ifVoid();
      c.localGet(RESOLVED);
      c.i32Const(2);
      c.arrayGetU(strT);
      c.localSet(CODE);
      c.localGet(CODE);
      c.i32Const(CH_QUESTION);
      c.i32Ne();
      c.localGet(CODE);
      c.i32Const(CH_DOT);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      // a non-long UNC root: convert to a long UNC path
      c.i32Const(8);
      c.localGet(RESOLVED);
      c.arrayLen();
      c.i32Const(2);
      c.i32Sub();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.i32Const(CH_QUESTION);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(3);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(4);
      c.i32Const(CH_A_UPPER + 20); // 'U'
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(5);
      c.i32Const(CH_A_UPPER + 13); // 'N'
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(6);
      c.i32Const(CH_A_UPPER + 2); // 'C'
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(7);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(8);
      c.localGet(RESOLVED);
      c.i32Const(2);
      c.localGet(RESOLVED);
      c.arrayLen();
      c.i32Const(2);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();
      c.end();
      c.else_();
      c.localGet(RESOLVED);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.call(this.w32IsDeviceRootHelper());
      c.localGet(RESOLVED);
      c.i32Const(1);
      c.arrayGetU(strT);
      c.i32Const(CH_COLON);
      c.i32Eq();
      c.i32And();
      c.localGet(RESOLVED);
      c.i32Const(2);
      c.arrayGetU(strT);
      c.i32Const(CH_BACKSLASH);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      // a device root: convert to a long UNC path
      c.i32Const(4);
      c.localGet(RESOLVED);
      c.arrayLen();
      c.i32Add();
      c.arrayNewDefault(strT);
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.i32Const(0);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(1);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(2);
      c.i32Const(CH_QUESTION);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(3);
      c.i32Const(CH_BACKSLASH);
      c.arraySet(strT);
      c.localGet(RESULT);
      c.i32Const(4);
      c.localGet(RESOLVED);
      c.i32Const(0);
      c.localGet(RESOLVED);
      c.arrayLen();
      c.arrayCopy(strT, strT);
      c.localGet(RESULT);
      c.return_();
      c.end();
      c.end();

      c.localGet(RESOLVED);
      this.mb.setBody(idx, [this.deps.stringVecRef(), this.strRef(), I32, this.strRef()], c.bytes());
      return idx;
    });
  }
}
