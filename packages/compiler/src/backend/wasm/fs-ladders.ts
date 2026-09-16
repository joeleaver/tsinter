/* INC-26 pass P6 (brief-p6-v2.md 77aed358d6ca166c/65 + delta-01
 * 58fd63fe6a4b026f/17 + delta-02 eba33a02484f182e/26, enumerated by
 * delta-order-p6.txt; cp1-plan-p6.txt 3dd2d6d407ca4eb0/578 + its addendum
 * b0feebfff5c49576/233) — the fs argument-validation ladders' own builder,
 * in PathBuilder's shape (its own `cached()` memo, its own `%w.fsl.*`
 * name prefix). CHECKPOINT-1 SCOPE: exactly two of the twelve keys,
 * fs.toUnixTimestamp and fs.existsChk (the timer arm) — the other ten
 * follow in later checkpoints, IN THE C's ORDER of checks unless §0 names
 * a measured Node correction (rule 9): transcribed from
 * packages/runtime/src/scr_bytes_io.c:234-665 (region 92ed64ec), Node
 * wins wherever the brief says so, and a C divergence the brief does not
 * name is a board (#153/#154), never copied and never "fixed" under
 * packages/runtime/src/.
 *
 * fs.toUnixTimestamp (:241) — numeric STRINGS short-circuit first via
 * ToNumber's loose-equality gate (self-equality rejects only a genuine
 * NaN parse); THEN finite NUMBERS pass, negatives answering now()/1000
 * (Node's "past times" shape — the row pins TYPE only, never the exact
 * value); everything else throws Node's exact ERR_INVALID_ARG_TYPE, with
 * its own typo ("an Time in seconds") preserved verbatim. Node's Date arm
 * is UNREACHABLE BY CONSTRUCTION here (lower-classes.ts:5026 refuses
 * `new Date(...)`; no "date" kind in DYN_HANDLE_KINDS) — no arm, no entry.
 *
 * fs.existsChk (:381) — cb must be a function (the ONE throwing arm);
 * a path that is neither string nor Buffer answers `callback(false)`
 * SYNCHRONOUSLY (Node's own wart, kept exactly — the callback runs
 * BEFORE the caller's next statement); every other path schedules the
 * REAL probe on a 0ms timer via a hand-built TWO-CAPTURE closure (path,
 * cb) — the wasm analogue of the C's `scr_fs_exists_fire`/
 * `scr_set_timeout(clo, 0)`. The fire function reuses P4's EXISTING
 * `existsSyncHelper()` (fs.ts:1754) for the STRING-path answer; a BYTES
 * (Buffer) path reaching the fire function TRAPS — an honest, loud
 * failure (never a silent wrong answer) because no bytes-to-string
 * decode primitive exists anywhere in this backend today (grepped; none
 * found) and neither corpus program ever supplies a Buffer path to
 * fs.exists. STATED here rather than silently narrowed; a future pass
 * that needs it builds the decoder and lifts the trap.
 *
 * THE PRESCAN WIDENING (delta-02, CP1-D-prescan): both arms reuse HOST
 * IMPORTS (`tsinter.wallClock`, the timer heap's `tsinter.now`,
 * `tsinter.fsCall` via existsSyncHelper) that emitter.ts mints only when
 * a static IR prescan recognizes the reaching construct BY NAME — see
 * emitter.ts's `dateNowReachable`/`timerSurfaceReachable`/
 * `fsCallReachable`, each widened by one exact-match line citing the
 * `process.activeResources` precedent already sitting in
 * `timerSurfaceReachable`'s own comment (this same failure class, found
 * and fixed once before P6 existed).
 *
 * THE ERROR SHAPE (§0.5): every throw here is
 * `emitSetCellError(c, className, name, pushMessage, codeLit)` — the SAME
 * primitive `error.argTypeThrow`'s own dispatch arm uses (emitter.ts
 * ~12543), injected because this file's functions are STANDALONE (no
 * `this.fn`/`this.emitUnwind()` to call): each arm sets the pending
 * exception cell and returns a PLACEHOLDER value, exactly fs.ts's own
 * documented contract ("the CALLER does `code.call(...);
 * this.emitPendingCheck();` immediately after") — never calling unwind
 * itself. */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type FieldType, type ValType } from "./module.js";
import { DK, DYN_KIND, DYN_NUM, DYN_REF, OBJ_LEN, OBJ_ENTRIES, ENTRY_KEY, ENTRY_VALUE, BYTES_PAYLOAD_REF } from "./dyn.js";

export interface FsLaddersDeps {
  strRef: () => ValType;
  strType: () => number;
  dynRef: () => ValType;
  dynT: () => number;
  arrRef: () => ValType;
  /** `%w.strToNum(s) -> f64` — StringToNumber, ECMA-262 7.1.4.1.1
   * (emitter.ts's existing `strToNumHelper`). */
  strToNum: () => number;
  /** `tsinter.wallClock`'s import index — present because
   * `dateNowReachable` now also recognizes "fs.toUnixTimestamp"
   * (delta-02). Milliseconds since epoch, f64, Date.now()'s own value. */
  wallClockFunc: () => number;
  /** `%w.dyn.specificType(d) -> str` — the "Received ..." tail. */
  specificType: () => number;
  /** `%w.strConcat`-equivalent (emitter.ts's `concatHelper`). */
  concat: () => number;
  /** Push a compile-time string literal onto `c` (emitter.ts's
   * `pushStrLitInto`). */
  pushStrLit: (c: Code, value: string) => void;
  /** The general cell-error builder (emitter.ts's `emitSetCellError`,
   * the explicit-buffer form — `error.argTypeThrow`'s own primitive). */
  setCellError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, codeLit: string | null) => void;
  /** Box an i32 boolean into a `$dyn` (emitter.ts's `dyn.boxBool`,
   * inline-emitting — leaves a dynRef on `c`'s stack). */
  boxBool: (c: Code, pushValue: (c: Code) => void) => void;
  /** THE immortal `undefined` dyn singleton's global index
   * (`dyn.undefinedGlobal()`, `scr_dyn_undefined()`'s wasm home). */
  undefinedGlobal: () => number;
  /** `%w.dyn.call(callee, args, what) -> dyn` — call a dyn value as a
   * function (`dynCall`'s own primitive; a null answer means the
   * exception cell is pending, exactly the C's `scr_dyn_call` contract). */
  callFn: () => number;
  /** `%w.vec.push1:dyn` — append one dyn value to a dyn array
   * (`dyn.arrPush()`). */
  arrPush: () => number;
  /** A fresh, empty dyn array (`vecs.newLen(dynVecInfo())` — f64 length
   * 0 already applied by the caller here). */
  dynArrNewLen: () => number;
  /** P4's EXISTING `fs.ts` helper (fs.ts:1754): `%w.fs.existsSync(path)
   * -> i32` bool, no error path at all (design's PROBE-SHAPED rule). */
  existsSyncHelper: () => number;
  /** timers.ts's statement-position `%w.timers.setTimeout(closRef, ms)`
   * — no handle, matching fs.exists' own "never hands JS a Timeout". */
  setTimeout: () => number;
  /** The base `() => void` closure pair every timer callback uses
   * (emitter.ts's `this.closPairFor([], [])`, `voidClos()`'s own value —
   * `timerSurfaceReachable` now also recognizes "fs.existsChk", delta-02). */
  voidClosPair: () => { clos: number; fn: number };
  /** "Print the reason, then trap" — S058's cycle-trap primitive
   * (inspect.ts's own `namedTrap` dep, emitter.ts ~6363), reused here for
   * board #155: a NAMED, loud, uncatchable trap for a reachable input
   * this backend genuinely cannot answer yet, never a bare `unreachable`
   * (which is indistinguishable from a compiler defect). */
  namedTrap: (c: Code, message: string) => void;

  /* ── added for the remaining ten keys (mkdtempChk onward) ──────────── */
  /** dyn.ts's OBJ payload accessors — `objGet` for assertEncoding's
   * options.encoding read, `objT`/`objRef`/`entriesArrayType`/`entryT`/
   * `entryRef` for mkdtempSyncChk's own OWN entry-by-entry utf8 walk
   * (scr_fs_mkdtemp_sync_chk's loop, ported — objGet alone cannot tell
   * "no OTHER key present", only "is this key present"). */
  objT: () => number;
  objRef: () => ValType;
  objGet: () => number;
  entriesArrayType: () => number;
  entryT: () => number;
  entryRef: () => ValType;
  /** `%w.strEq(ref,ref)->i32` — content equality, for the entry-key walk. */
  strEq: () => number;
  /** `%w.bytes.isEncoding(str) -> i32` (typedarrays.ts, Buffer.isEncoding). */
  isEncoding: () => number;
  /** `%w.bytes.numReceived(f64) -> str` — Node's ERR_OUT_OF_RANGE
   * "Received" rendering, underscore grouping included (typedarrays.ts,
   * reused verbatim per rev-29's own CP1 note — never re-derived). */
  numReceived: () => number;
  /** `%w.jsToNumber(dyn) -> f64` — full ECMA ToNumber (emitter.ts's
   * existing `jsToNumberHelper`), for readChk's `length |= 0` coercion. */
  jsToNumber: () => number;
  /** `%w.toInt32(f64) -> i32` — ECMA ToInt32 (emitter.ts's existing
   * `toInt32Helper`), readChk's other half of `length |= 0`. */
  toInt32: () => number;
  /** `%w.dyn.notFn(what) -> void` (dyn.ts:5320) — reused verbatim for the
   * lchmod family's Linux not-a-function arms, confirmed by CP1's FIRST
   * MEASUREMENT (B) to throw with no `code` property. */
  notFn: () => number;
  /** P4's EXISTING `fs.ts` helper: `%w.fs.mkdtempSync(prefix) -> str`,
   * may set the pending cell (ENOENT etc.) — the caller's
   * `emitPendingCheck()` handles it, same contract as every other fs.ts
   * wrapper. */
  mkdtempSyncHelper: () => number;
  /** typedarrays.ts's `.length` accessor (readChk's buffer-bound check). */
  bytesLength: () => number;
  /** dyn.ts's `$dynBytes` WRAPPER struct type (`{bytes, isBuffer}`) — a
   * BYTES-kind dyn's DYN_REF holds THIS, never the raw `$bytes` struct
   * directly (dyn.ts's own `bytesPayloadBytes`, mirrored here since it
   * is Emitter-private-adjacent and this file needs the same unwrap). */
  bytesPayloadT: () => number;
}

export class FsLaddersBuilder {
  private readonly fns = new Map<string, number>();
  private existsFireShape: { struct: number; fn: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: FsLaddersDeps,
  ) {}

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.fsl.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /** The Node-exact ERR_INVALID_ARG_TYPE shape `error.argTypeThrow`'s own
   * dispatch arm builds, factored for reuse across every ladder arm:
   * `The "<name>" argument must be <expected>. Received <specificType(got)>`. */
  private throwArgType(c: Code, name: string, expected: string, pushGot: (c: Code) => void): void {
    this.deps.setCellError(
      c,
      "%TypeError",
      "TypeError",
      (cc) => {
        this.deps.pushStrLit(cc, `The "${name}" argument must be ${expected}. Received `);
        pushGot(cc);
        cc.call(this.deps.specificType());
        cc.call(this.deps.concat());
      },
      "ERR_INVALID_ARG_TYPE",
    );
  }

  /** fs._toUnixTimestamp(t) -> f64 (scr_fs_to_unix_timestamp, :241).
   * Order is the content (rev-29 R-12): numeric STRINGS answer their own
   * ToNumber value FIRST; then finite NUMBERS (negatives via wallClock);
   * everything else throws. */
  toUnixTimestamp(): number {
    return this.cached("toUnixTimestamp", [this.deps.dynRef()], [F64], (idx) => {
      const c = new Code();
      const T = 0; // param: the dyn time value
      const K = 1;
      const N = 2;
      const dynT = this.deps.dynT();

      c.localGet(T);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);

      // (1) STR: strToNum, then `n == n` (ToNumber's own NaN-fails gate —
      // +time == time in the C, equivalent because a value parsed BY
      // ToNumber loosely equals its own source string by construction).
      c.localGet(K);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.ifVoid();
      c.localGet(T);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      c.call(this.deps.strToNum());
      c.localSet(N);
      c.localGet(N);
      c.localGet(N);
      c.f64Eq();
      c.ifVoid();
      c.localGet(N);
      c.return_();
      c.end();
      c.end();

      // (2) finite NUMBER: negative -> now()/1000; else the value itself.
      c.localGet(K);
      c.i32Const(DK.NUM);
      c.i32Eq();
      c.ifVoid();
      c.localGet(T);
      c.structGet(dynT, DYN_NUM);
      c.localSet(N);
      // isfinite(n): not NaN, not +Infinity, not -Infinity — three pure
      // comparisons on the SAME local, no buffer index/deref/call on
      // either side, so a bare i32.and is safe (path.ts's own audit rule).
      c.localGet(N);
      c.localGet(N);
      c.f64Eq();
      c.localGet(N);
      c.f64Const(Number.POSITIVE_INFINITY);
      c.f64Ne();
      c.i32And();
      c.localGet(N);
      c.f64Const(Number.NEGATIVE_INFINITY);
      c.f64Ne();
      c.i32And();
      c.ifVoid();
      c.localGet(N);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(F64);
      c.call(this.deps.wallClockFunc());
      c.f64Const(1000);
      c.f64Div();
      c.else_();
      c.localGet(N);
      c.end();
      c.return_();
      c.end();
      c.end();

      // (3) else: Node's exact throw, its own typo preserved verbatim.
      this.throwArgType(c, "time", "an instance of Date or an Time in seconds", (cc) => cc.localGet(T));
      c.f64Const(0); // placeholder — the caller's emitPendingCheck unwinds first
      this.mb.setBody(idx, [I32, F64], c.bytes());
    });
  }

  /** The two-capture (path, cb) closure fs.existsChk schedules onto the
   * timer heap — built once, memoized: the struct SUBTYPES the base
   * void-closure type (doneClosFor's own shape, emitter.ts ~4928-4970),
   * and the fire function is the C's `scr_fs_exists_fire`, ported. */
  private existsFire(): { struct: number; fn: number } {
    if (this.existsFireShape !== null) return this.existsFireShape;
    const pair = this.deps.voidClosPair();
    const dynRefT = this.deps.dynRef();
    const PATH_FIELD = 1;
    const CB_FIELD = 2;
    const fields: FieldType[] = [
      { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
      { storage: dynRefT, mutable: false }, // PATH_FIELD
      { storage: dynRefT, mutable: false }, // CB_FIELD
    ];
    const struct = this.mb.subStructType("fsl:existsFire", fields, pair.clos);
    const fn = this.mb.declareFunc(pair.fn, "%w.fsl.existsFire");
    this.mb.declareFuncRef(fn); // referenced via `refFunc` at the schedule site below
    const made = { struct, fn };
    this.existsFireShape = made;

    const c = new Code();
    const SELF = 0; // param0: the closure ref, generically typed (pair.clos)
    const SELFT = 1;
    const PATH = 2;
    const CB = 3;
    const ANS = 4;
    const ARGS = 5;
    const dynT = this.deps.dynT();

    c.localGet(SELF);
    c.refCast(struct);
    c.localSet(SELFT);
    c.localGet(SELFT);
    c.structGet(struct, PATH_FIELD);
    c.localSet(PATH);
    c.localGet(SELFT);
    c.structGet(struct, CB_FIELD);
    c.localSet(CB);

    // ans = false, then: STR -> existsSyncHelper; BYTES -> a NAMED trap
    // (board #155, rev-29's CP1 review N-1: the input IS reachable —
    // existsChk's own gate schedules for STR OR BYTES, and a Buffer
    // path lowers fine (canConvertToDyn accepts bytes<u8>) — so a bare
    // `unreachable` here would be indistinguishable from a compiler
    // defect. No bytes-to-string decode primitive exists anywhere in
    // this backend today (grepped; none found), and a compile-time
    // refusal would be the better shape but needs the FORBID-PREFIX
    // frontend, so this loud runtime trap is the only in-scope form);
    // anything else (unreachable by construction: existsChk only ever
    // schedules this closure for STR/BYTES paths) falls through to
    // `false`.
    c.i32Const(0);
    c.localSet(ANS);
    c.localGet(PATH);
    c.structGet(dynT, DYN_KIND);
    c.i32Const(DK.STR);
    c.i32Eq();
    c.ifVoid();
    c.localGet(PATH);
    c.structGet(dynT, DYN_REF);
    c.refCast(this.deps.strType());
    c.call(this.deps.existsSyncHelper());
    c.localSet(ANS);
    c.else_();
    c.localGet(PATH);
    c.structGet(dynT, DYN_KIND);
    c.i32Const(DK.BYTES);
    c.i32Eq();
    c.ifVoid();
    this.deps.namedTrap(c, "fs.exists: a Buffer path has no bytes-to-string decode primitive in this backend (board #155)");
    c.end();
    c.end();

    c.f64Const(0);
    c.call(this.deps.dynArrNewLen());
    c.localSet(ARGS);
    c.localGet(ARGS);
    this.deps.boxBool(c, (cc) => cc.localGet(ANS));
    c.call(this.deps.arrPush());
    c.localGet(CB);
    c.localGet(ARGS);
    this.deps.pushStrLit(c, "the fs.exists callback");
    c.call(this.deps.callFn());
    c.drop();
    // No pending-exception check here: an uncaught throw from `cb` stays
    // set in the cell, and `tick()`'s own generic per-callback
    // `emitDeathCheck` (timers.ts) reports and traps AFTER this function
    // returns — the SAME generic path every OTHER timer callback dies
    // through, not a fs.exists-specific mechanism.
    this.mb.setBody(fn, [{ kind: "ref", nullable: true, typeIndex: struct }, dynRefT, dynRefT, I32, this.deps.arrRef()], c.bytes());
    return made;
  }

  /** fs.existsChk(path, cb) -> dyn undefined (scr_fs_exists_async, :381).
   * cb-not-function is the ONE throwing arm; an unvalidatable path
   * answers `callback(false)` SYNCHRONOUSLY (Node's wart); otherwise the
   * real probe is scheduled on a 0ms timer via the two-capture closure
   * above. */
  existsChk(): number {
    return this.cached("existsChk", [this.deps.dynRef(), this.deps.dynRef()], [this.deps.dynRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const CB = 1;
      const K = 2;
      const ARGS = 3;
      const dynT = this.deps.dynT();
      const fire = this.existsFire();

      // (1) cb must be a function.
      c.localGet(CB);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      this.throwArgType(c, "cb", "of type function", (cc) => cc.localGet(CB));
      c.globalGet(this.deps.undefinedGlobal());
      c.return_();
      c.end();

      // (2) path kind decides sync-wart vs. real schedule.
      c.localGet(PATH);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      c.localGet(K);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      // REAL: build the two-capture closure and schedule it at 0ms.
      c.refFunc(fire.fn);
      c.localGet(PATH);
      c.localGet(CB);
      c.structNew(fire.struct);
      c.f64Const(0);
      c.call(this.deps.setTimeout());
      c.else_();
      // WART: callback(false) SYNCHRONOUSLY, no timer at all.
      c.f64Const(0);
      c.call(this.deps.dynArrNewLen());
      c.localSet(ARGS);
      c.localGet(ARGS);
      this.deps.boxBool(c, (cc) => cc.i32Const(0));
      c.call(this.deps.arrPush());
      c.localGet(CB);
      c.localGet(ARGS);
      this.deps.pushStrLit(c, "the fs.exists callback");
      c.call(this.deps.callFn());
      c.drop();
      c.end();

      c.globalGet(this.deps.undefinedGlobal());
      this.mb.setBody(idx, [I32, this.deps.arrRef()], c.bytes());
    });
  }

  /** assertEncoding(opts) -> i32 (1 = pass, 0 = fail + the cell already
   * set) — scr_fs_encoding_chk, :295, shared by mkdtempSyncChk/
   * readFileChk/opendirChk/streamOptsChk. THE FALSY GATE (Node's
   * `encoding && !Buffer.isEncoding(encoding)`, the C's own arm order):
   * an OBJECT's "encoding" MEMBER when present (absent -> pass);
   * otherwise opts itself. Then: absent -> pass; STRING empty -> pass,
   * a valid Buffer.isEncoding name -> pass; BOOL false -> pass; NUM 0 ->
   * pass; anything else throws ERR_INVALID_ARG_VALUE. The Received tail
   * is Node-exact (single-quoted) for the STRING case, which is the only
   * shape either corpus program supplies; every OTHER kind reaching the
   * throw (NUM nonzero, BOOL true, ARR/OBJ/FUNC/BYTES/PROMISE) is
   * ungated and uses specificType()'s rendering as a stated best-effort,
   * not a measured Node string — board #153 if a future row needs it
   * precisely. */
  private assertEncoding(): number {
    return this.cached("assertEncoding", [this.deps.dynRef()], [I32], (idx) => {
      const c = new Code();
      const OPTS = 0;
      const ENC = 1;
      const K = 2;
      const GOT = 3;
      const S = 4;
      const dynT = this.deps.dynT();

      c.localGet(OPTS);
      c.localSet(ENC);
      c.localGet(OPTS);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Eq();
      c.ifVoid();
      c.localGet(OPTS);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.objT());
      this.deps.pushStrLit(c, "encoding");
      c.call(this.deps.objGet());
      c.localSet(GOT);
      c.localGet(GOT);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(GOT);
      c.localSet(ENC);
      c.end();

      c.localGet(ENC);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);

      c.localGet(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();

      c.localGet(K);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ENC);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      c.localSet(S);
      c.localGet(S);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(S);
      c.call(this.deps.isEncoding());
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.end();

      c.localGet(K);
      c.i32Const(DK.BOOL);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ENC);
      c.structGet(dynT, DYN_NUM);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.end();

      c.localGet(K);
      c.i32Const(DK.NUM);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ENC);
      c.structGet(dynT, DYN_NUM);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.end();

      this.deps.setCellError(
        c,
        "%TypeError",
        "TypeError",
        (cc) => {
          cc.localGet(K);
          cc.i32Const(DK.STR);
          cc.i32Eq();
          cc.ifResult(this.deps.strRef());
          this.deps.pushStrLit(cc, "The argument 'encoding' is invalid encoding. Received '");
          cc.localGet(S);
          cc.call(this.deps.concat());
          this.deps.pushStrLit(cc, "'");
          cc.call(this.deps.concat());
          cc.else_();
          this.deps.pushStrLit(cc, "The argument 'encoding' is invalid encoding. Received ");
          cc.localGet(ENC);
          cc.call(this.deps.specificType());
          cc.call(this.deps.concat());
          cc.end();
        },
        "ERR_INVALID_ARG_VALUE",
      );
      c.i32Const(0);
      this.mb.setBody(idx, [this.deps.dynRef(), I32, this.deps.dynRef(), this.deps.strRef()], c.bytes());
    });
  }

  /** fs.mkdtempChk(prefix, cb, fence) -> void (scr_fs_mkdtemp_chk, :413).
   * cb, then prefix; the async op fences. Node's ENCODING step is
   * UNBUILDABLE#154: the IR lowering passes only args[0]/prefix and the
   * LAST arg/cb, dropping any options object before the runtime ever
   * sees it (lower-builtins.ts's "mkdtemp" case) — stated, not built. */
  mkdtempChk(): number {
    return this.cached("mkdtempChk", [this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()], [], (idx) => {
      const c = new Code();
      const PREFIX = 0;
      const CB = 1;
      const FENCE = 2;
      const dynT = this.deps.dynT();

      c.localGet(CB);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      this.throwArgType(c, "cb", "of type function", (cc) => cc.localGet(CB));
      c.return_();
      c.end();

      c.localGet(PREFIX);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.localGet(PREFIX);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      this.throwArgType(c, "prefix", "of type string or an instance of Buffer or URL", (cc) => cc.localGet(PREFIX));
      c.return_();
      c.end();

      this.deps.setCellError(c, "%Error", "Error", (cc) => cc.localGet(FENCE), null);
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** fs.mkdtempSyncChk(prefix, opts, fence) -> str (scr_fs_mkdtemp_sync_
   * chk, :424). *** D1 (build-determining): Node's order is ENCODING
   * FIRST, then prefix *** — the C has it inverted (board #153). Then
   * the REAL mkdtemp runs when the options KEEP utf8 semantics (absent,
   * `{}`, or an encoding spelled utf8/utf-8) AND the prefix is a
   * string; the fence otherwise — quoted from the C, not paraphrased:
   * `if (!utf8 || prefix->kind != SCR_DYN_STR) { fence; }`. */
  mkdtempSyncChk(): number {
    return this.cached("mkdtempSyncChk", [this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const PREFIX = 0;
      const OPTS = 1;
      const FENCE = 2;
      const UTF8 = 3;
      const I = 4;
      const N = 5;
      const E = 6;
      const ENCV = 7;
      const dynT = this.deps.dynT();
      const objT = this.deps.objT();
      const entries = this.deps.entriesArrayType();
      const entryT = this.deps.entryT();

      // (1) assertEncoding — D1: FIRST.
      c.localGet(OPTS);
      c.call(this.assertEncoding());
      c.i32Eqz();
      c.ifVoid();
      c.refNull(this.deps.strType());
      c.return_();
      c.end();

      // (2) prefix.
      c.localGet(PREFIX);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.localGet(PREFIX);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      this.throwArgType(c, "prefix", "of type string or an instance of Buffer or URL", (cc) => cc.localGet(PREFIX));
      c.refNull(this.deps.strType());
      c.return_();
      c.end();

      // (3) utf8 walk (scr_fs_mkdtemp_sync_chk's own entry loop, ported):
      // starts true; an OBJECT's every entry either narrows an "encoding"
      // key to a utf8-spelled string or (any other key, or a
      // non-utf8-spelled encoding) clears utf8; a bare STRING opts value
      // is utf8 iff it IS "utf8"/"utf-8"; anything else present clears it.
      c.i32Const(1);
      c.localSet(UTF8);
      c.localGet(OPTS);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Eq();
      c.ifVoid();
      c.localGet(OPTS);
      c.structGet(dynT, DYN_REF);
      c.refCast(objT);
      const OBJV = 8;
      c.localSet(OBJV);
      c.localGet(OBJV);
      c.structGet(objT, OBJ_LEN);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(OBJV);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(I);
      c.arrayGet(entries);
      c.localTee(E);
      c.structGet(entryT, ENTRY_KEY);
      this.pushLitAsStr(c, "encoding");
      c.call(this.deps.strEq());
      c.ifVoid();
      c.localGet(E);
      c.structGet(entryT, ENTRY_VALUE);
      c.localSet(ENCV);
      c.localGet(ENCV);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(UTF8);
      c.else_();
      c.localGet(ENCV);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      this.pushLitAsStr(c, "utf8");
      c.call(this.deps.strEq());
      c.localGet(ENCV);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      this.pushLitAsStr(c, "utf-8");
      c.call(this.deps.strEq());
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(UTF8);
      c.end();
      c.end();
      c.else_();
      c.i32Const(0);
      c.localSet(UTF8);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.else_();
      c.localGet(OPTS);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.ifVoid();
      c.localGet(OPTS);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      this.pushLitAsStr(c, "utf8");
      c.call(this.deps.strEq());
      c.localGet(OPTS);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      this.pushLitAsStr(c, "utf-8");
      c.call(this.deps.strEq());
      c.i32Or();
      c.localSet(UTF8);
      c.else_();
      c.localGet(OPTS);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(OPTS);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(UTF8);
      c.end();
      c.end();
      c.end();

      // (4) the gate: !utf8 || prefix is not a plain string -> the fence.
      c.localGet(UTF8);
      c.i32Eqz();
      c.localGet(PREFIX);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Ne();
      c.i32Or();
      c.ifVoid();
      this.deps.setCellError(c, "%Error", "Error", (cc) => cc.localGet(FENCE), null);
      c.refNull(this.deps.strType());
      c.return_();
      c.end();

      c.localGet(PREFIX);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      c.call(this.deps.mkdtempSyncHelper());
      this.mb.setBody(idx, [I32, I32, I32, this.deps.entryRef(), this.deps.dynRef(), this.deps.objRef()], c.bytes());
    });
  }

  /** fs.readFileChk(path, opts, cb, fence) -> void (scr_fs_read_file_chk,
   * :460). cb, assertEncoding, path; the async read fences. */
  readFileChk(): number {
    return this.cached(
      "readFileChk",
      [this.deps.dynRef(), this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()],
      [],
      (idx) => {
        const c = new Code();
        const PATH = 0;
        const OPTS = 1;
        const CB = 2;
        const FENCE = 3;
        const dynT = this.deps.dynT();

        c.localGet(CB);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Ne();
        c.ifVoid();
        this.throwArgType(c, "cb", "of type function", (cc) => cc.localGet(CB));
        c.return_();
        c.end();

        c.localGet(OPTS);
        c.call(this.assertEncoding());
        c.i32Eqz();
        c.ifVoid();
        c.return_();
        c.end();

        c.localGet(PATH);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.STR);
        c.i32Eq();
        c.localGet(PATH);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.BYTES);
        c.i32Eq();
        c.i32Or();
        c.i32Eqz();
        c.ifVoid();
        this.throwArgType(c, "path", "of type string or an instance of Buffer or URL", (cc) => cc.localGet(PATH));
        c.return_();
        c.end();

        this.deps.setCellError(c, "%Error", "Error", (cc) => cc.localGet(FENCE), null);
        this.mb.setBody(idx, [I32], c.bytes());
      },
    );
  }

  /** fs.opendirChk(path, opts, fence) -> void (scr_fs_opendir_chk, :470).
   * path, then assertEncoding; the Dir machinery fences. */
  opendirChk(): number {
    return this.cached("opendirChk", [this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()], [], (idx) => {
      const c = new Code();
      const PATH = 0;
      const OPTS = 1;
      const FENCE = 2;
      const dynT = this.deps.dynT();

      c.localGet(PATH);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.localGet(PATH);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      this.throwArgType(c, "path", "of type string or an instance of Buffer or URL", (cc) => cc.localGet(PATH));
      c.return_();
      c.end();

      c.localGet(OPTS);
      c.call(this.assertEncoding());
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();

      this.deps.setCellError(c, "%Error", "Error", (cc) => cc.localGet(FENCE), null);
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** fs.watchFileChk(path, listener, fence) -> void (scr_fs_watch_file_
   * chk, :478). path, then listener's function contract; real watching
   * fences. */
  watchFileChk(): number {
    return this.cached("watchFileChk", [this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()], [], (idx) => {
      const c = new Code();
      const PATH = 0;
      const LISTENER = 1;
      const FENCE = 2;
      const dynT = this.deps.dynT();

      c.localGet(PATH);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.localGet(PATH);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      this.throwArgType(c, "path", "of type string or an instance of Buffer or URL", (cc) => cc.localGet(PATH));
      c.return_();
      c.end();

      c.localGet(LISTENER);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      this.throwArgType(c, "listener", "of type function", (cc) => cc.localGet(LISTENER));
      c.return_();
      c.end();

      this.deps.setCellError(c, "%Error", "Error", (cc) => cc.localGet(FENCE), null);
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** fs.streamOptsChk(path, opts, fence) -> void (scr_fs_stream_opts_chk,
   * :652). *** D2: a NEW leading options-shape guard, built per the
   * sealed brief's own instruction ("the wasm arm builds Node's") ***:
   * opts present, not a string, not an object -> ERR_INVALID_ARG_TYPE
   * "options". Then assertEncoding; options.fd (object opts only, when
   * present): type then range [0,2147483647] named "fd"; else path;
   * then the fence. */
  streamOptsChk(): number {
    return this.cached("streamOptsChk", [this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()], [], (idx) => {
      const c = new Code();
      const PATH = 0;
      const OPTS = 1;
      const FENCE = 2;
      const K = 3;
      const dynT = this.deps.dynT();
      const objT = this.deps.objT();

      // (0) D2's options-shape guard.
      c.localGet(OPTS);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      c.localGet(K);
      c.i32Const(DK.UNDEF);
      c.i32Ne();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Ne();
      c.i32And();
      c.localGet(K);
      c.i32Const(DK.STR);
      c.i32Ne();
      c.i32And();
      c.localGet(K);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      this.throwArgType(c, "options", "one of type string or object", (cc) => cc.localGet(OPTS));
      c.return_();
      c.end();

      // (1) assertEncoding.
      c.localGet(OPTS);
      c.call(this.assertEncoding());
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();

      // (2) options.fd, when opts is an OBJECT and the member is present.
      const FD = 4;
      c.i32Const(0);
      c.localSet(FD); // 0 = "fd" absent, sentinel handled by refIsNull below
      c.localGet(K);
      c.i32Const(DK.OBJ);
      c.i32Eq();
      c.ifVoid();
      c.localGet(OPTS);
      c.structGet(dynT, DYN_REF);
      c.refCast(objT);
      this.pushLitAsStr(c, "fd");
      c.call(this.deps.objGet());
      const FDV = 5;
      c.localSet(FDV);
      c.localGet(FDV);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(FDV);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(FDV);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(FDV);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NUM);
      c.i32Ne();
      c.ifVoid();
      this.deps.setCellError(
        c,
        "%TypeError",
        "TypeError",
        (cc) => {
          this.deps.pushStrLit(cc, `The "options.fd" property must be of type number or an instance of FileHandle. Received `);
          cc.localGet(FDV);
          cc.call(this.deps.specificType());
          cc.call(this.deps.concat());
        },
        "ERR_INVALID_ARG_TYPE",
      );
      c.return_();
      c.end();
      c.localGet(FDV);
      c.structGet(dynT, DYN_NUM);
      const FDN = 6;
      c.localSet(FDN);
      c.localGet(FDN);
      c.f64Const(0);
      c.f64Lt();
      c.localGet(FDN);
      c.f64Const(2147483647);
      c.f64Gt();
      c.localGet(FDN);
      c.localGet(FDN);
      c.f64Ne();
      c.i32Or();
      c.i32Or();
      c.ifVoid();
      this.deps.setCellError(
        c,
        "%RangeError",
        "RangeError",
        (cc) => {
          this.deps.pushStrLit(cc, `The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received `);
          cc.localGet(FDN);
          cc.call(this.deps.numReceived());
          cc.call(this.deps.concat());
        },
        "ERR_OUT_OF_RANGE",
      );
      c.return_();
      c.end();
      c.i32Const(1);
      c.localSet(FD); // fd WAS present and validated
      c.end(); // closes "FDV not (UNDEF|NULL)"
      c.end(); // closes "FDV not null"
      c.end(); // closes "K==OBJ"

      // (3) else path (only when no fd member was present at all).
      c.localGet(FD);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(PATH);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.localGet(PATH);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      this.throwArgType(c, "path", "of type string or an instance of Buffer or URL", (cc) => cc.localGet(PATH));
      c.return_();
      c.end();
      c.end();

      this.deps.setCellError(c, "%Error", "Error", (cc) => cc.localGet(FENCE), null);
      this.mb.setBody(idx, [I32, I32, this.deps.dynRef(), F64], c.bytes());
    });
  }

  /** fs.readChk(fd, buffer, offset, length, position, fence) -> void
   * (scr_fs_read_chk, :583, 65 lines). *** D2 (build-determining): the
   * C's own order is buffer-then-fd and length-block-then-position;
   * Node's real order, built here, is fd(type+integer+range, delta-03's
   * own C2-D1 correction), buffer, [cb unbuildable#154], offset(int+
   * range, NO buffer-bound message),
   * position(type+range, underscore rendering), length(|=0-coerced,
   * bounds LAST after position, possibly a negative bound) ***. */
  readChk(): number {
    return this.cached(
      "readChk",
      [this.deps.dynRef(), this.deps.dynRef(), this.deps.dynRef(), this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()],
      [],
      (idx) => {
        const c = new Code();
        const FD = 0;
        const BUFFER = 1;
        const OFFSET = 2;
        const LENGTH = 3;
        const POSITION = 4;
        const FENCE = 5;
        const dynT = this.deps.dynT();

        // (1) fd: type, THEN INTEGER, then range — D-03/C2-D1 (rev-29's
        // CP2 review): Node's getValidatedFd is validateInt32 (type,
        // NumberIsInteger, range), THREE shapes, not two — the earlier
        // build only had type+range, so fd=1.5 fell through to the
        // buffer arm and fd=NaN rendered the RANGE text where Node
        // renders "must be an integer". Routed through the SAME
        // rangeChkNum() helper offset/position already use — it already
        // carries the integer clause and folds NaN into it. Board #153
        // amended: "fd range AND the integer check" (the C is silent on
        // both).
        const FDN = 6;
        this.rangeChkNum(c, FD, dynT, "fd", 0, 2147483647, ">= 0 && <= 2147483647", FDN);

        // (2) buffer.
        c.localGet(BUFFER);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.BYTES);
        c.i32Ne();
        c.ifVoid();
        this.throwArgType(c, "buffer", "an instance of Buffer, TypedArray, or DataView", (cc) => cc.localGet(BUFFER));
        c.return_();
        c.end();

        // [cb — unbuildable#154: the lowering never passes a callback
        // argument to readChk (lower-builtins.ts's "read" case), so
        // Node's third check has no operand here at all. STATED.]

        // (4) offset (absent -> skip): integer, range [0, MAX_SAFE] —
        // NO buffer-bound message (R-5: the C's own invention, board
        // #153, not built).
        const OK = 7;
        c.localGet(OFFSET);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Ne();
        c.localGet(OFFSET);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NULL);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        this.rangeChkNum(c, OFFSET, dynT, "offset", 0, 9007199254740991, ">= 0 && <= 9007199254740991", OK);
        c.end();

        // (5) position (absent -> skip): "of type bigint or integer"
        // (no separate dyn bigint kind exists — NUM only, per CP1's own
        // addendum (d): unreachable by construction, same class as
        // toUnixTimestamp's Date arm), range [-1, MAX_SAFE], underscore
        // rendering for large values via numReceived().
        c.localGet(POSITION);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Ne();
        c.localGet(POSITION);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NULL);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        c.localGet(POSITION);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NUM);
        c.i32Ne();
        c.ifVoid();
        this.throwArgType(c, "position", "of type bigint or integer", (cc) => cc.localGet(POSITION));
        c.return_();
        c.end();
        this.rangeChkNum(c, POSITION, dynT, "position", -1, 9007199254740991, ">= -1 && <= 9007199254740991", OK);
        c.end();

        // (6) length (absent -> skip): |=0-coerced (jsToNumber then
        // toInt32, ECMA's own `length |= 0`), never type/integer
        // validated; bounds checked LAST, after position — D2's own
        // correction, restated: [0, buflen - offset], the upper bound
        // possibly NEGATIVE.
        c.localGet(LENGTH);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Ne();
        c.localGet(LENGTH);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NULL);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        const LI32 = 8; // I32 — distinct slot from OK(7)'s F64 use above
        c.localGet(LENGTH);
        c.call(this.deps.jsToNumber());
        c.call(this.deps.toInt32());
        c.localSet(LI32);
        c.localGet(LI32);
        c.i32Const(0);
        c.i32LtS();
        c.ifVoid();
        this.deps.setCellError(
          c,
          "%RangeError",
          "RangeError",
          (cc) => {
            this.deps.pushStrLit(cc, `The value of "length" is out of range. It must be >= 0. Received `);
            cc.localGet(LI32);
            cc.f64ConvertI32S();
            cc.call(this.deps.numReceived());
            cc.call(this.deps.concat());
          },
          "ERR_OUT_OF_RANGE",
        );
        c.return_();
        c.end();
        const BUFLEN = 9;
        const OFF = 10;
        c.localGet(BUFFER);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.bytesPayloadT());
        c.structGet(this.deps.bytesPayloadT(), BYTES_PAYLOAD_REF);
        c.call(this.deps.bytesLength());
        c.localSet(BUFLEN);
        c.localGet(OFFSET);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NUM);
        c.i32Eq();
        c.ifResult(F64);
        c.localGet(OFFSET);
        c.structGet(dynT, DYN_NUM);
        c.else_();
        c.f64Const(0);
        c.end();
        c.localSet(OFF);
        c.localGet(LI32);
        c.f64ConvertI32S();
        c.localGet(BUFLEN);
        c.localGet(OFF);
        c.f64Sub();
        c.f64Gt();
        c.ifVoid();
        this.deps.setCellError(
          c,
          "%RangeError",
          "RangeError",
          (cc) => {
            this.deps.pushStrLit(cc, `The value of "length" is out of range. It must be <= `);
            cc.localGet(BUFLEN);
            cc.localGet(OFF);
            cc.f64Sub();
            cc.call(this.deps.numReceived());
            cc.call(this.deps.concat()); // prefix + the bound
            this.deps.pushStrLit(cc, `. Received `);
            cc.call(this.deps.concat()); // + ". Received "
            cc.localGet(LI32);
            cc.f64ConvertI32S();
            cc.call(this.deps.numReceived());
            cc.call(this.deps.concat()); // + the received value
          },
          "ERR_OUT_OF_RANGE",
        );
        c.return_();
        c.end();
        c.end();

        this.deps.setCellError(c, "%Error", "Error", (cc) => cc.localGet(FENCE), null);
        this.mb.setBody(idx, [F64, F64, I32, F64, F64], c.bytes());
      },
    );
  }

  /** Shared int-range check over a NUM-kind dyn local: type already
   * confirmed non-absent by the caller; if NOT a NUM -> ERR_INVALID_ARG_
   * TYPE "of type number"; else integer + [min,max] -> ERR_OUT_OF_RANGE
   * with the given range text. `scratchBase` picks ONE unused F64 local
   * (the caller owns the numbering — every call site in this file reuses
   * the SAME index across sequential, non-overlapping calls, since a
   * wasm local's declared type is fixed for the whole function: a LATER
   * call passing the same scratchBase is fine only if nothing else in
   * the function claims that index at a DIFFERENT type). */
  private rangeChkNum(c: Code, local: number, dynT: number, name: string, min: number, max: number, rangeText: string, scratchBase: number): void {
    c.localGet(local);
    c.structGet(dynT, DYN_KIND);
    c.i32Const(DK.NUM);
    c.i32Ne();
    c.ifVoid();
    this.throwArgType(c, name, "of type number", (cc) => cc.localGet(local));
    c.return_();
    c.end();
    const N = scratchBase;
    c.localGet(local);
    c.structGet(dynT, DYN_NUM);
    c.localSet(N);
    // NOT an integer: Number.isInteger's real shape — NaN and fractional
    // values both fail `floor(N) == N` (floor(NaN) is NaN, NaN != NaN);
    // +-Infinity pass that same test (floor(Infinity) === Infinity) but
    // are NOT integers per ECMA, so they need their own explicit arms —
    // all three collapse to ONE "must be an integer" message, matching
    // Node's validateInteger (oracle: offset=NaN and position=0.5 both
    // render this exact template).
    c.localGet(N);
    c.localGet(N);
    c.f64Floor();
    c.f64Ne();
    c.localGet(N);
    c.f64Const(Number.POSITIVE_INFINITY);
    c.f64Eq();
    c.i32Or();
    c.localGet(N);
    c.f64Const(Number.NEGATIVE_INFINITY);
    c.f64Eq();
    c.i32Or();
    c.ifVoid();
    this.deps.setCellError(
      c,
      "%RangeError",
      "RangeError",
      (cc) => {
        this.deps.pushStrLit(cc, `The value of "${name}" is out of range. It must be an integer. Received `);
        cc.localGet(N);
        cc.call(this.deps.numReceived());
        cc.call(this.deps.concat());
      },
      "ERR_OUT_OF_RANGE",
    );
    c.return_();
    c.end();
    c.localGet(N);
    c.f64Const(min);
    c.f64Lt();
    c.localGet(N);
    c.f64Const(max);
    c.f64Gt();
    c.i32Or();
    c.ifVoid();
    this.deps.setCellError(
      c,
      "%RangeError",
      "RangeError",
      (cc) => {
        this.deps.pushStrLit(cc, `The value of "${name}" is out of range. It must be ${rangeText}. Received `);
        cc.localGet(N);
        cc.call(this.deps.numReceived());
        cc.call(this.deps.concat());
      },
      "ERR_OUT_OF_RANGE",
    );
    c.return_();
    c.end();
  }

  /** fs.lchmodChk(path, mode, cb, fence) -> void (scr_fs_lchmod_chk,
   * :505). *** D3: LINUX ARM ONLY *** — scr_fs_lchmod_defined("fs.
   * lchmod") fires before any other check; notFn reused verbatim (CP1's
   * FIRST MEASUREMENT B). Every other C check is macOS-only and NOT
   * built (§0.8/D3). `fence` is unused on Linux — still an IR argument
   * so the signature matches, never read. */
  lchmodChk(): number {
    return this.cached(
      "lchmodChk",
      [this.deps.dynRef(), this.deps.dynRef(), this.deps.dynRef(), this.deps.strRef()],
      [],
      (idx) => {
        const c = new Code();
        this.deps.pushStrLit(c, "fs.lchmod");
        c.call(this.deps.notFn());
        this.mb.setBody(idx, [], c.bytes());
      },
    );
  }

  /** fs.lchmodSyncChk(path, mode) -> dyn (scr_fs_lchmod_sync_chk, :526).
   * *** D3: LINUX ARM ONLY ***. */
  lchmodSyncChk(): number {
    return this.cached("lchmodSyncChk", [this.deps.dynRef(), this.deps.dynRef()], [this.deps.dynRef()], (idx) => {
      const c = new Code();
      this.deps.pushStrLit(c, "fs.lchmodSync");
      c.call(this.deps.notFn());
      c.globalGet(this.deps.undefinedGlobal()); // placeholder; emitPendingCheck unwinds first
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  // fsp.lchmodChk is NOT built here: emitFspSettled uses Emitter's own
  // `this.fn`-scoped scratch-local pool (acquireScratch/releaseScratch),
  // which is only correctly bound while Emitter is walking the ACTUAL
  // enclosing function — a standalone fs-ladders.ts cached() function
  // would corrupt that pool (its build callback runs synchronously
  // mid-walk of whatever OTHER function contains the call site, not a
  // dedicated frame of its own). Built directly in emitter.ts's own
  // dispatch case instead, exactly where P5's own fsp twins live and for
  // the identical reason.

  /** A compile-time string literal pushed as a NARROWED (non-null)
   * string ref — `pushStrLit` alone leaves whatever nullability the
   * injected helper declares; every call site here that immediately
   * feeds `strEq`/`isEncoding` needs the narrowed form, so this wraps it
   * once rather than repeating a cast at each site. */
  private pushLitAsStr(c: Code, value: string): void {
    this.deps.pushStrLit(c, value);
  }
}
