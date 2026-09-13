/* INC-26 pass P4 (design-host-v7.txt cccf7d6e §2.6/§6.1-§6.4; brief-p4-v2.md
 * eac927bd/304 §3C; DECISIONS.md P4-J1..J3; CP1 delta a910f5e3; cp1-plan-p4.txt
 * 50f95ae4 §7) — the fs core's own builder, in PathBuilder's shape (its own
 * `cached()` memo, its own `%w.fs.*` name prefix).
 *
 * THE HOST NEVER THROWS (§6.1): `fsCall(op, aPtr, aLen, bPtr, bLen, x, y)`
 * answers an i32 STATUS — >= 0 success (a length for length-returning ops,
 * content in the staging region the call was given), < 0 = -errno in THIS
 * MODULE's own FOURTEEN-code enumeration (never the host's raw platform
 * errno, never kill's or chdir's number space). The MODULE builds Node's
 * Error itself, from the code alone — every message here is ASSEMBLED at
 * runtime from (code name, code text, the op's own syscall literal, the
 * shape, the program's own path string(s)), never sourced from the host.
 * ERRATUM E-P4-3 (delta-3e e4da1096, R-1, RULED — APPEND, do not weaken):
 * design §6.3's "twelve" widens to FOURTEEN — codes 13 ELOOP and
 * 14 ENAMETOOLONG, appended (nothing renumbered, the carrier unchanged),
 * because ORDINARY readFileSync inputs (a symlink loop; a long path)
 * reach them, and the twelve-only table rendered "Unknown system error
 * -<n>" where Node prints its own exact wording — two knowingly-wrong
 * messages for inputs a user will actually hit.
 *
 * THE ERROR TABLE IS GENERATED-THEN-HAND-WRITTEN (A-3's two instruments):
 * gen-fs-errno-rows.mjs drives real node:fs and commits fs-errno-rows.json;
 * THIS FILE's CODES table below is written independently from that same
 * measurement (not derived programmatically from the JSON — a table
 * generated from the rows it is checked against would be one instrument,
 * not two) and is CHECKED against the committed rows by the forced-host
 * tests (wasm-host-fs-p4.test.ts).
 *
 * THE FOUR TRANSCRIPTION TRAPS this file's structure is built to avoid
 * (fs-errno-rows.json, rev-26's fserrno-p4.out 4f383ce6): (a) EISDIR is
 * `read`/NO PATH for readFileSync, `open`/WITH the path for write/append —
 * ONE exception, carried as `eisdirOverride` below, never a code-keyed
 * table (design §6.3: the row is keyed on (op,code), NOT on code alone);
 * (b) the syscall literal is the INTERNAL op (rm->`lstat`, readdir->
 * `scandir`, mkdtemp->`mkdtemp`), never the JS call name; (c) mkdtemp's
 * path in its OWN message is the TEMPLATE (prefix + "XXXXXX"), gotten for
 * free here by staging the TEMPLATE STRING as the path, not the bare
 * prefix; (d) existsSync NEVER THROWS — `existsSyncHelper` below has no
 * error path at all, matching design §6.2's PROBE-SHAPED rule.
 *
 * THE rm-ON-A-DIRECTORY SPECIAL CASE (S073's second sentence, CP1 delta
 * (e), measured s073-widening.out bf6bd4ee / this pass's own independent
 * re-measurement): Node's rmSync/rmOptsSync on a directory WITHOUT
 * `recursive` throws a DIFFERENT shape entirely — `.code` =
 * "ERR_FS_EISDIR" (not the ordinary "EISDIR"), a message with NO
 * "EISDIR:" prefix, UNQUOTED path, syscall `rm` — checked BEFORE the
 * ordinary 14-way table for op 14 specifically, never inside it. The
 * adapter (3E) maps this to the SAME EISDIR carrier value (-5) as the
 * ordinary code — the MODULE alone decides (op==14 && code==EISDIR)
 * means "render the special shape", exactly as op 1 decides its own
 * EISDIR exception, with no extra host signal needed. The tier renders
 * this as a PLAIN %Error (never a distinct SystemError class — S073's
 * own stated class divergence: Node's class differs, no non-Node lane
 * models it).
 *
 * THE UNKNOWN ARM (A-11): an errno outside the fourteen carries as
 * -(256+errno) (the SAME carrier kill's and chdir's own UNKNOWN arms use).
 * `.code` renders `E<n>` (NEVER a Node spelling) with the MODULE CONSTANT
 * text "Unknown system error -<n>" — hostStr kind 17 is NOT minted in P4.
 *
 * TWO SLOTS, TWO REGIONS, LIVE AT ONCE (design §2.6, R-8; abi.ts's own
 * doc): slot A (path) at the cursor, slot B (content, or — for length-
 * returning ops — the OUTPUT buffer) at `cursor + roundUp(aLenBytes, 2)`.
 * 2-BYTE ALIGNMENT IS REQUIRED because BOTH hosts read slot B through
 * `new Uint16Array(memory.buffer, ptr, len)`, which THROWS on an odd
 * offset (CP1 delta (d)) — an uncatchable crash, not subtle corruption.
 * ONE `ensureCapacity` call for the COMBINED size; neither slot advances
 * the cursor.
 *
 * ERROR CONSTRUCTION (CP1 delta (a)): every wrapper below is a STANDALONE
 * wasm function (own numbered locals, no `this.fn` dependency —
 * process.ts's `readHostStr` precedent exactly). On failure it writes the
 * PENDING EXCEPTION CELL via `deps.throwCoded` (emitter.ts's
 * `emitSetCellErrorCoded`, the minimal sibling of `emitSetCellError` this
 * pass adds) and returns a PLACEHOLDER value — it does NOT unwind itself.
 * The CALLER (emitter.ts's own dispatch arm) does
 * `code.call(...); this.emitPendingCheck();` immediately after, EXACTLY
 * `json.parse()`'s own existing call-site shape. */
import { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

export interface FsDeps {
  strRef: () => ValType;
  strType: () => number;
  /** `tsinter.fsCall`'s index, or a descriptive throw naming the op
   * (emitter.ts's `fsCallFuncOrThrow`). */
  fsCallFunc: (op: number) => number;
  /** `emitEnsureCapacity`'s own signature — `need` pushes ONE i32 (bytes
   * needed beyond the cursor) and is emitted TWICE by the callee. */
  ensureCapacity: (c: Code, need: () => void) => void;
  /** The output-stage bump-cursor global (emitter.ts's `cursorGlobal`). */
  stageCursor: () => number;
  /** Push a compile-time STRING LITERAL (emitter.ts's `pushStrLitInto`). */
  pushStrLit: (c: Code, value: string) => void;
  /** `%w.strConcat(ref,ref)->ref` — string concatenation. */
  concat: () => number;
  /** `%w.f64ToStr(f64)->str` — Node's exact Number->String. */
  f64ToStr: () => number;
  /** emitter.ts's `emitSetCellErrorCoded` (CP1 delta (a)): builds a
   * builtin error instance and writes it into the pending exception
   * cell; `pushCode` is a RUNTIME callback. Does NOT unwind; the caller
   * does, via `emitPendingCheck()` immediately after the wrapper call
   * returns. */
  throwCoded: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
}

/** The fourteen codes (E-P4-3, delta-3e: appended 13 ELOOP/14
 * ENAMETOOLONG onto the original twelve, nothing renumbered), index i is
 * code number i+1 — the exact numbering the carrier `-(256+errno)` steps
 * around. Independently written from measurement (fserrno-implp4.out /
 * fs-errno-rows.json), never transcribed from design-host-v7.txt's own
 * table. */
/** EXPORTED for fs-errno-rows.test.ts's own cross-check (rev-26's 3B read
 * P-3): "the module's hand-written table checked against the generator's
 * OUTPUT alone, when the generator is checked against Node, is a CHAIN,
 * not two instruments — every link inherits the first link's error." This
 * table is written from measurement (fserrno-implp4.mjs / fs-errno-
 * rows.json / rev-26's own fserrno-p4.out — never derived from any ONE of
 * them programmatically) and the TEST diffs it against the rows file AND
 * (as a one-time verification, since rev's own probe is not a repo
 * artifact) rev's independent probe, so a disagreement says WHICH side is
 * wrong, never assumes this table is correct by construction. */
export const CODES: readonly (readonly [name: string, text: string])[] = [
  ["ENOENT", "no such file or directory"],
  ["EEXIST", "file already exists"],
  ["EACCES", "permission denied"],
  ["ENOTDIR", "not a directory"],
  ["EISDIR", "illegal operation on a directory"],
  ["ENOTEMPTY", "directory not empty"],
  ["EPERM", "operation not permitted"],
  ["EBADF", "bad file descriptor"],
  ["EMFILE", "too many open files"],
  ["ENOSPC", "no space left on device"],
  ["EINVAL", "invalid argument"],
  ["EROFS", "read-only file system"],
  ["ELOOP", "too many symbolic links encountered"],
  ["ENAMETOOLONG", "name too long"],
];

/** EISDIR's own index (1-based) in `CODES` — op 1's read-stage override
 * and op 14's rm-on-directory special case both key on it. */
const EISDIR_CODE = 5;

/** The per-op DEFAULT (syscall, shape) pair, and op 1's own EISDIR
 * exception — EXPORTED for the SAME cross-check P-3 asks for (this table
 * IS the compile-time data every `build*Op` call site below passes
 * inline; restated here as ONE named structure so a test can diff it
 * against fs-errno-rows.json's rows AND rev-26's own independent probe
 * without parsing wasm bytecode). Op 14's rm-on-directory SPECIAL CASE
 * (S073's second sentence) is NOT representable as an (op,code) row at
 * all — a SEPARATE error class and message shape entirely, checked on
 * its own in the forced-host file, never folded into this table. */
export interface FsOpTableEntry {
  op: number;
  /** One (of possibly several) frontend-facing key names reaching this
   * op — informational, never load-bearing for the cross-check (several
   * keys share one op number: mkdirSync/mkdirRecursiveSync both use op
   * 11, rmSync/rmOptsSync both use op 14). */
  keys: readonly string[];
  syscall: string;
  shape: "one" | "no";
  eisdirOverride: { syscall: string; shape: "one" | "no" } | null;
}
export const OP_TABLE: readonly FsOpTableEntry[] = [
  { op: 1, keys: ["readFileSync"], syscall: "open", shape: "one", eisdirOverride: { syscall: "read", shape: "no" } },
  { op: 2, keys: ["readdirSync"], syscall: "scandir", shape: "one", eisdirOverride: null },
  { op: 3, keys: ["mkdtempSync"], syscall: "mkdtemp", shape: "one", eisdirOverride: null },
  { op: 9, keys: ["writeFileSync"], syscall: "open", shape: "one", eisdirOverride: null },
  { op: 10, keys: ["appendFileSync"], syscall: "open", shape: "one", eisdirOverride: null },
  { op: 11, keys: ["mkdirSync", "mkdirRecursiveSync"], syscall: "mkdir", shape: "one", eisdirOverride: null },
  { op: 12, keys: ["rmdirSync"], syscall: "rmdir", shape: "one", eisdirOverride: null },
  { op: 13, keys: ["unlinkSync"], syscall: "unlink", shape: "one", eisdirOverride: null },
  { op: 14, keys: ["rmSync", "rmOptsSync"], syscall: "lstat", shape: "one", eisdirOverride: null },
  { op: 20, keys: ["accessSync"], syscall: "access", shape: "one", eisdirOverride: null },
];

export class FsBuilder {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: FsDeps,
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
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.fs.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── the two-slot staging primitive ───────────────────────────────────
   * `%w.fs.stageStrUtf16At(str, basePtr) -> len` — process.ts's/emitter's
   * own `stageStrUtf16Helper`, generalized: writes AT an EXPLICIT base
   * pointer parameter instead of unconditionally reading the cursor
   * global, so ONE function serves both slot A and slot B. Does NOT call
   * `ensureCapacity` itself — the CALLER computes the COMBINED size for
   * both slots and calls it ONCE, before either slot is written. Does NOT
   * advance the cursor. */
  private stageStrUtf16AtHelper(): number {
    return this.cached("stageStrUtf16At", [this.strRef(), I32], [I32], (idx) => {
      const c = new Code();
      const S = 0;
      const BASE = 1;
      const LEN = 2;
      const I = 3;
      c.localGet(S);
      c.arrayLen();
      c.localSet(LEN);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeU();
      c.brIf(1);
      c.localGet(BASE);
      c.localGet(I);
      c.i32Const(2);
      c.i32Mul();
      c.i32Add();
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType());
      c.i32Store8();
      c.localGet(BASE);
      c.localGet(I);
      c.i32Const(2);
      c.i32Mul();
      c.i32Add();
      c.i32Const(1);
      c.i32Add();
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType());
      c.i32Const(8);
      c.i32ShrU();
      c.i32Store8();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(LEN);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }

  /** `(n + 1) & -2` — rounds a byte count UP to the nearest even number
   * (a no-op when `n` is already even, which every P4 slot-A byte length
   * always is — codeUnits*2 — but P5's byte-payload slot B will not
   * always be; the general formula is written once, here). */
  private emitRoundUp2(c: Code): void {
    c.i32Const(1);
    c.i32Add();
    c.i32Const(-2);
    c.i32And();
  }

  /** Reads a NEW `(array i16)` string of `lenLocal` code units starting
   * at `basePtrLocal`, via `i32Load16U` — process.ts's `readHostStr`
   * tail, generalized to an explicit base pointer. */
  private emitReadStrAt(c: Code, basePtrLocal: number, lenLocal: number, resultLocal: number, iLocal: number): void {
    c.localGet(lenLocal);
    c.arrayNewDefault(this.strType());
    c.localSet(resultLocal);
    c.i32Const(0);
    c.localSet(iLocal);
    c.block();
    c.loop();
    c.localGet(iLocal);
    c.localGet(lenLocal);
    c.i32GeS();
    c.brIf(1);
    c.localGet(resultLocal);
    c.localGet(iLocal);
    c.localGet(basePtrLocal);
    c.localGet(iLocal);
    c.i32Const(2);
    c.i32Mul();
    c.i32Add();
    c.i32Load16U();
    c.arraySet(this.strType());
    c.localGet(iLocal);
    c.i32Const(1);
    c.i32Add();
    c.localSet(iLocal);
    c.br(0);
    c.end();
    c.end();
  }

  /* ── the error table, rendered at runtime from a numeric status ─────────
   * `emitThrowFromStatus`: a TS-level CODE GENERATOR (not itself one wasm
   * function) — called once per op-specific wrapper's own construction,
   * with `defaultSyscall`/`defaultShape`/`eisdirOverride` as COMPILE-TIME
   * parameters, so every one of the twelve branches it emits is a SINGLE
   * compile-time-known string literal up to the path. Twelve independent
   * (never chained) `ifVoid` checks — safe because the twelve codes are
   * mutually exclusive by construction. Requires TWO scratch locals from
   * the caller: `matchedLocal` (the fallback flag) and `nLocal` (the
   * UNKNOWN arm's numeral). NEVER branches out of its own `ifVoid`
   * bodies — every exit is a plain fallthrough, so callers may embed this
   * anywhere without block-depth bookkeeping. */
  private emitThrowFromStatus(
    c: Code,
    statusLocal: number,
    pathALocal: number,
    matchedLocal: number,
    nLocal: number,
    defaultSyscall: string,
    defaultShape: "one" | "no",
    eisdirOverride: { syscall: string; shape: "one" | "no" } | null,
  ): void {
    c.i32Const(0);
    c.localSet(matchedLocal);
    for (let i = 0; i < CODES.length; i++) {
      const codeNum = i + 1;
      const [name, text] = CODES[i]!;
      const useOverride = eisdirOverride !== null && codeNum === EISDIR_CODE;
      const syscall = useOverride ? eisdirOverride.syscall : defaultSyscall;
      const shape = useOverride ? eisdirOverride.shape : defaultShape;
      c.localGet(statusLocal);
      c.i32Const(-codeNum);
      c.i32Eq();
      c.ifVoid();
      this.deps.throwCoded(
        c,
        "%Error",
        "Error",
        (cc) => {
          if (shape === "one") {
            this.deps.pushStrLit(cc, `${name}: ${text}, ${syscall} '`);
            cc.localGet(pathALocal);
            cc.call(this.deps.concat());
            this.deps.pushStrLit(cc, `'`);
            cc.call(this.deps.concat());
          } else {
            this.deps.pushStrLit(cc, `${name}: ${text}, ${syscall}`);
          }
        },
        (cc) => this.deps.pushStrLit(cc, name),
      );
      c.i32Const(1);
      c.localSet(matchedLocal);
      c.end();
    }
    // THE UNKNOWN ARM (A-11): status <= -256 is the carrier's own band —
    // n = -status-256, code = "E<n>", text = the MODULE CONSTANT
    // "Unknown system error -<n>".
    c.localGet(matchedLocal);
    c.i32Eqz();
    c.ifVoid();
    c.i32Const(-256);
    c.localGet(statusLocal);
    c.i32Sub();
    c.localSet(nLocal); // n = -256 - status = -(status+256) = -status-256
    this.deps.throwCoded(
      c,
      "%Error",
      "Error",
      (cc) => {
        this.deps.pushStrLit(cc, "Unknown system error -");
        cc.localGet(nLocal);
        cc.f64ConvertI32S();
        cc.call(this.deps.f64ToStr());
        cc.call(this.deps.concat());
      },
      (cc) => {
        this.deps.pushStrLit(cc, "E");
        cc.localGet(nLocal);
        cc.f64ConvertI32S();
        cc.call(this.deps.f64ToStr());
        cc.call(this.deps.concat());
      },
    );
    c.end();
  }

  /* ── read-length ops: readFileSync (op 1), readdirSync (op 2, raw JSON
   * string — the emitter's OWN arm parses it), mkdtempSync (op 3) ────── */

  /** `%w.fs.<name>(path) -> str` for a LENGTH-RETURNING op. `needsXXXXXX`
   * builds mkdtemp's own TEMPLATE (prefix + "XXXXXX") BEFORE staging —
   * the SAME string is then what appears in a failure message, for free
   * (trap (c)'s own fix). Stages the (possibly templated) path at the
   * cursor, offers a modest initial output capacity at slot B (design
   * §2.6's "modest stack buffer, pay a second call only on long values"),
   * retries with the host's own reported length on an under-sized answer
   * (hostStr's retry contract, reused verbatim), and on failure renders
   * the error and returns a null placeholder (never read — the caller's
   * `emitPendingCheck()` branches away first).
   *
   * BLOCK STRUCTURE (verified by hand, no branch ever crosses an `if`):
   * B_OUTER { B_MIDDLE { L_RETRY { ...; brIf(2) on failure (skips BOTH
   * B_MIDDLE and B_OUTER's bodies, landing right after B_OUTER's own
   * `end`); brIf(1) on a sized fit (skips the loop only, landing right
   * after B_MIDDLE's `end`, BEFORE the result-building code); else set
   * CAP and br(0) to retry } } ; <build RESULT — success path only,
   * reached by falling through after brIf(1)> } ; <STATUS check again,
   * decides RESULT vs throw — reached by EITHER convergence>. */
  private buildReadLengthOp(name: string, op: number, defaultSyscall: string, eisdirOverride: { syscall: string; shape: "one" | "no" } | null, needsXXXXXX: boolean): number {
    return this.cached(name, [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const STAGE_STR = 1;
      const A_LEN = 2;
      const A_BASE = 3;
      const B_BASE = 4;
      const CAP = 5;
      const STATUS = 6;
      const RESULT = 7;
      const I = 8;
      const MATCHED = 9;
      const N = 10;

      if (needsXXXXXX) {
        c.localGet(PATH);
        this.deps.pushStrLit(c, "XXXXXX");
        c.call(this.deps.concat());
        c.localSet(STAGE_STR);
      } else {
        c.localGet(PATH);
        c.localSet(STAGE_STR);
      }
      c.localGet(STAGE_STR);
      c.arrayLen();
      c.localSet(A_LEN);
      c.i32Const(64);
      c.localSet(CAP);

      c.block(); // B_OUTER
      c.block(); // B_MIDDLE
      c.loop(); // L_RETRY
      this.deps.ensureCapacity(c, () => {
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
        c.localGet(CAP);
        c.i32Const(2);
        c.i32Mul();
        c.i32Add();
      });
      c.globalGet(this.deps.stageCursor());
      c.localSet(A_BASE);
      c.localGet(STAGE_STR);
      c.localGet(A_BASE);
      c.call(this.stageStrUtf16AtHelper());
      c.drop();
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.i32Const(2);
      c.i32Mul();
      this.emitRoundUp2(c);
      c.i32Add();
      c.localSet(B_BASE);
      c.i32Const(op);
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.localGet(B_BASE);
      c.localGet(CAP);
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(op));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(2); // failure -> past B_MIDDLE and B_OUTER
      c.localGet(STATUS);
      c.localGet(CAP);
      c.i32LeS();
      c.brIf(1); // fits -> past the loop only
      c.localGet(STATUS);
      c.localSet(CAP);
      c.br(0); // retry
      c.end(); // L_RETRY
      c.end(); // B_MIDDLE (reached via brIf(1))
      // success-only: build RESULT from slot B
      this.emitReadStrAt(c, B_BASE, STATUS, RESULT, I);
      c.end(); // B_OUTER (reached by falling through above, OR via brIf(2))

      c.localGet(STATUS);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(this.strRef());
      c.localGet(RESULT);
      c.else_();
      this.emitThrowFromStatus(c, STATUS, STAGE_STR, MATCHED, N, defaultSyscall, "one", eisdirOverride);
      c.refNull(this.strType());
      c.end();

      this.mb.setBody(idx, [this.strRef(), I32, I32, I32, I32, I32, this.strRef(), I32, I32, I32], c.bytes());
    });
  }

  /** `%w.fs.readFileSync(path) -> str` (op 1). EISDIR is `read`/NO-PATH,
   * the ONE exception in the whole table (op 1's own read-stage). */
  readFileSyncHelper(): number {
    return this.buildReadLengthOp("readFileSync", 1, "open", { syscall: "read", shape: "no" }, false);
  }

  /** `%w.fs.readdirSyncRaw(path) -> str` (op 2) — the RAW JSON document;
   * the emitter's own dispatch arm parses it via `json.parse()` and walks
   * the result into a `string[]` vec (verify NO json/dyn surface widens —
   * A-9's own rule; the parser is FORBID here, used as-is). */
  readdirSyncRawHelper(): number {
    return this.buildReadLengthOp("readdirSyncRaw", 2, "scandir", null, false);
  }

  /** `%w.fs.mkdtempSync(prefix) -> str` (op 3) — the template rule (A-10):
   * the string STAGED and the string SHOWN ON FAILURE are both
   * `prefix + "XXXXXX"`, never the bare prefix. */
  mkdtempSyncHelper(): number {
    return this.buildReadLengthOp("mkdtempSync", 3, "mkdtemp", null, true);
  }

  /* ── write-shaped ops: writeFileSync (op 9), appendFileSync (op 10) ──── */

  /** `%w.fs.<name>(path, content) -> void` — the TWO-SLOT staging: slot A
   * (path) at the cursor, slot B (content) at
   * `cursor + roundUp(aLenBytes, 2)`, ONE `ensureCapacity` for the
   * combined size, neither slot moves the cursor. */
  private buildWriteOp(name: string, op: number, defaultSyscall: string): number {
    return this.cached(name, [this.strRef(), this.strRef()], [], (idx) => {
      const c = new Code();
      const PATH = 0;
      const CONTENT = 1;
      const A_LEN = 2;
      const A_BASE = 3;
      const B_LEN = 4;
      const B_BASE = 5;
      const STATUS = 6;
      const MATCHED = 7;
      const N = 8;

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(A_LEN);
      c.localGet(CONTENT);
      c.arrayLen();
      c.localSet(B_LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
        c.localGet(B_LEN);
        c.i32Const(2);
        c.i32Mul();
        c.i32Add();
      });
      c.globalGet(this.deps.stageCursor());
      c.localSet(A_BASE);
      c.localGet(PATH);
      c.localGet(A_BASE);
      c.call(this.stageStrUtf16AtHelper());
      c.drop();
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.i32Const(2);
      c.i32Mul();
      this.emitRoundUp2(c);
      c.i32Add();
      c.localSet(B_BASE);
      c.localGet(CONTENT);
      c.localGet(B_BASE);
      c.call(this.stageStrUtf16AtHelper());
      c.drop();
      c.i32Const(op);
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.localGet(B_BASE);
      c.localGet(B_LEN);
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(op));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, defaultSyscall, "one", null);
      c.end();

      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32], c.bytes());
    });
  }

  writeFileSyncHelper(): number {
    return this.buildWriteOp("writeFileSync", 9, "open");
  }
  appendFileSyncHelper(): number {
    return this.buildWriteOp("appendFileSync", 10, "open");
  }

  /* ── simple ops: single path (+ up to two i32 options), VOID result ──── */

  /** `%w.fs.<name>(path[, x[, y]]) -> void`. `pushXY` pushes the op's own
   * `x`/`y` arguments (constants for the fixed-arity keys, forwarded
   * params for rmOptsSync/accessSync). `rmEisdirSpecial` is op 14's own
   * pre-check (S073's second sentence) — tested BEFORE the ordinary
   * table, never inside it. */
  private buildSimpleOp(name: string, op: number, extraParams: ValType[], pushXY: (c: Code, path: number, extras: number[]) => void, defaultSyscall: string, rmEisdirSpecial: boolean): number {
    return this.cached(name, [this.strRef(), ...extraParams], [], (idx) => {
      const c = new Code();
      const PATH = 0;
      const extras = extraParams.map((_, i) => 1 + i);
      const base = 1 + extraParams.length;
      const A_LEN = base;
      const A_BASE = base + 1;
      const STATUS = base + 2;
      const MATCHED = base + 3;
      const N = base + 4;

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(A_LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
      });
      c.globalGet(this.deps.stageCursor());
      c.localSet(A_BASE);
      c.localGet(PATH);
      c.localGet(A_BASE);
      c.call(this.stageStrUtf16AtHelper());
      c.drop();
      c.i32Const(op);
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.i32Const(0); // bPtr unused
      c.i32Const(0); // bLen unused
      pushXY(c, PATH, extras);
      c.call(this.deps.fsCallFunc(op));
      c.localSet(STATUS);

      if (rmEisdirSpecial) {
        // S073's second sentence: op 14 + EISDIR is the special
        // SystemError shape, checked FIRST, never inside the ordinary
        // twelve-way table below.
        c.localGet(STATUS);
        c.i32Const(-EISDIR_CODE);
        c.i32Eq();
        c.ifVoid();
        this.deps.throwCoded(
          c,
          "%Error",
          "Error",
          (cc) => {
            this.deps.pushStrLit(cc, "Path is a directory: rm returned EISDIR (is a directory) ");
            cc.localGet(PATH);
            cc.call(this.deps.concat());
          },
          (cc) => this.deps.pushStrLit(cc, "ERR_FS_EISDIR"),
        );
        c.end();
        c.localGet(STATUS);
        c.i32Const(-EISDIR_CODE);
        c.i32Ne();
        c.ifVoid();
      }
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, defaultSyscall, "one", null);
      c.end();
      if (rmEisdirSpecial) {
        c.end();
      }

      this.mb.setBody(idx, [...extraParams, I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /** mkdirSync (op 11, recursive=0). */
  mkdirSyncHelper(): number {
    return this.buildSimpleOp(
      "mkdirSync",
      11,
      [],
      (c) => {
        c.i32Const(0); // x: mode (unsupported at this tier's own signature — 0 is inert)
        c.i32Const(0); // y: recursive=0
      },
      "mkdir",
      false,
    );
  }

  /** mkdirRecursiveSync (op 11, recursive=1) — the SAME op number, VOID
   * result (K-3/S073's second sentence: the first-created-path return is
   * frontend-fenced to statement position). */
  mkdirRecursiveSyncHelper(): number {
    return this.buildSimpleOp(
      "mkdirRecursiveSync",
      11,
      [],
      (c) => {
        c.i32Const(0); // x: mode
        c.i32Const(1); // y: recursive=1
      },
      "mkdir",
      false,
    );
  }

  rmdirSyncHelper(): number {
    return this.buildSimpleOp("rmdirSync", 12, [], (c) => {
      c.i32Const(0);
      c.i32Const(0);
    }, "rmdir", false);
  }

  unlinkSyncHelper(): number {
    return this.buildSimpleOp("unlinkSync", 13, [], (c) => {
      c.i32Const(0);
      c.i32Const(0);
    }, "unlink", false);
  }

  /** rmSync (op 14, recursive=0 force=0) — the S-1 key (D10-shaped: BUILT,
   * reached by no P4 program; its forced row is mandatory). */
  rmSyncHelper(): number {
    return this.buildSimpleOp(
      "rmSync",
      14,
      [],
      (c) => {
        c.i32Const(0); // x: recursive=0
        c.i32Const(0); // y: force=0
      },
      "lstat",
      true,
    );
  }

  /** rmOptsSync (op 14, [STRING, BOOL, BOOL] = recursive, force) — the
   * SAME op as rmSync, forwarding the program's own bool args as x/y. */
  rmOptsSyncHelper(): number {
    return this.buildSimpleOp(
      "rmOptsSync",
      14,
      [I32, I32],
      (c, _path, extras) => {
        c.localGet(extras[0]!); // x: recursive
        c.localGet(extras[1]!); // y: force
      },
      "lstat",
      true,
    );
  }

  /** accessSync (op 20, [STRING, F64] mode — converted to i32 at the
   * CALL SITE, kill's own PID-conversion precedent, never inside this
   * file). */
  accessSyncHelper(): number {
    return this.buildSimpleOp(
      "accessSync",
      20,
      [I32],
      (c, _path, extras) => {
        c.localGet(extras[0]!); // x: mode
        c.i32Const(0); // y unused
      },
      "access",
      false,
    );
  }

  /* ── existsSync (op 19) — PROBE-SHAPED, NEVER builds an error ────────── */

  /** `%w.fs.existsSync(path) -> i32` (bool): 0 = the path exists ->
   * `true`; any -code -> `false`. There is no error path here at all —
   * design §6.2's own rule, and A-9's own trap (d): a generated table
   * must EXCLUDE this key, never emit an empty row for it. */
  existsSyncHelper(): number {
    return this.cached("existsSync", [this.strRef()], [I32], (idx) => {
      const c = new Code();
      const PATH = 0;
      const A_LEN = 1;
      const A_BASE = 2;
      const STATUS = 3;

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(A_LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
      });
      c.globalGet(this.deps.stageCursor());
      c.localSet(A_BASE);
      c.localGet(PATH);
      c.localGet(A_BASE);
      c.call(this.stageStrUtf16AtHelper());
      c.drop();
      c.i32Const(19);
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(19));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32GeS();

      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }
}
