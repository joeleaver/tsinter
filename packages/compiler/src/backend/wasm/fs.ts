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
 * carried as `codeOverrides` below (INC-26 P5, CP1 delta 29286fa4 B-4/
 * M-21: GENERALIZED from a single EISDIR-only `eisdirOverride` to a
 * per-CODE-NAME map once realpathSync needed a SECOND override, `ELOOP`
 * ->`stat` — never a code-keyed table for the ORDINARY case, design §6.3:
 * the row is keyed on (op,code), NOT on code alone — codeOverrides is the
 * NAMED EXCEPTION mechanism, not the rule); (b) the syscall literal is the
 * INTERNAL op (rm->`lstat`, readdir->
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

/* INC-26 pass P5 (brief-p5-v3.md a8dc6daa/303; design-host-v7.txt cccf7d6e
 * §2.6, §3.3-§3.6, §6.2-§6.6, §8, §9 P5, §10(v), §11; ERRATA-design-v7-p3.txt
 * 9bc1bd26 E-P5-1..3) — SCOPE HEADER ONLY at CP1: this pass extends the P4
 * fs core with the fs tail, the fsp promise twins, the os tail, the stats
 * surface (mapType's `case "stats"`), and the #143 native rider. No
 * builder/generator/adapter code is added by this edit; it exists solely
 * to mark the pass boundary in this file ahead of the CP1 plan. */
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
  /** INC-26 P5 (readFileSyncBytes/writeFileSyncBytes) — the SAME bytes-
   * array surface StreamBuilder's own deps already inject
   * (typedarrays.ts's BytesBuilder via emitter.ts's `this.bytesB`), never
   * a second bytes representation. */
  bytesRef: () => ValType;
  bytesType: () => number;
  /** `%w.bytes.new:u8(f64 len) -> bytesRef` — a fresh zero-filled array. */
  bytesNewLen: () => number;
  /** `%w.bytes.set:u8(bytesRef, f64 index, f64 value) -> void`. */
  bytesSetElem: () => number;
  /** `%w.bytes.get:u8(bytesRef, f64 index) -> f64`. */
  bytesGetElem: () => number;
  /** `%w.bytes.length(bytesRef) -> f64`. */
  bytesLength: () => number;
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
/** A per-code override of `syscall`/`shape` — keyed by the CODE's own
 * NAME (`CODES`'s own `[name, text]` tuples), never a numeric index,
 * since `CODES`'s array order is not part of this table's contract.
 * `shape` is optional per override: an override may change only the
 * syscall (op 4's `{ELOOP:{syscall:"stat"}}` keeps realpath's own
 * default "one" shape). */
export type FsCodeOverrides = Partial<Record<string, { syscall: string; shape?: "one" | "no" }>>;

export interface FsOpTableEntry {
  op: number;
  /** One (of possibly several) frontend-facing key names reaching this
   * op — informational, never load-bearing for the cross-check (several
   * keys share one op number: mkdirSync/mkdirRecursiveSync both use op
   * 11, rmSync/rmOptsSync/rmRetrySync all use op 14, readdirSync/
   * readdirTypesSync both use op 2 — INC-26 P5 CP1 delta 29286fa4 C-2/
   * D-8/ruling(3): a shared op gains a KEY, never a new row). */
  keys: readonly string[];
  syscall: string;
  /** "one" = ordinary single-path message (`CODE: text, syscall 'path'`);
   * "no" = no path at all (`CODE: text, syscall`, fd-shaped ops); "two" =
   * copyFile's own two-path message (`CODE: text, syscall 'src' -> 'dst'`)
   * — NOT rendered by `emitThrowFromStatus` (which only knows "one"/"no"),
   * built by its own dedicated wrapper (design §6.2/§6.3, brief §6c/3C). */
  shape: "one" | "no" | "two";
  codeOverrides: FsCodeOverrides;
}
export const OP_TABLE: readonly FsOpTableEntry[] = [
  { op: 1, keys: ["readFileSync", "readFileSyncBytes"], syscall: "open", shape: "one", codeOverrides: { EISDIR: { syscall: "read", shape: "no" } } },
  { op: 2, keys: ["readdirSync", "readdirTypesSync"], syscall: "scandir", shape: "one", codeOverrides: {} },
  { op: 3, keys: ["mkdtempSync"], syscall: "mkdtemp", shape: "one", codeOverrides: {} },
  { op: 9, keys: ["writeFileSync", "writeFileSyncBytes", "writeFileModeSync"], syscall: "open", shape: "one", codeOverrides: {} },
  { op: 10, keys: ["appendFileSync"], syscall: "open", shape: "one", codeOverrides: {} },
  { op: 11, keys: ["mkdirSync", "mkdirRecursiveSync", "mkdirModeSync", "mkdirRecursiveModeSync"], syscall: "mkdir", shape: "one", codeOverrides: {} },
  { op: 12, keys: ["rmdirSync"], syscall: "rmdir", shape: "one", codeOverrides: {} },
  { op: 13, keys: ["unlinkSync"], syscall: "unlink", shape: "one", codeOverrides: {} },
  { op: 14, keys: ["rmSync", "rmOptsSync", "rmRetrySync"], syscall: "lstat", shape: "one", codeOverrides: {} },
  { op: 20, keys: ["accessSync"], syscall: "access", shape: "one", codeOverrides: {} },
  // INC-26 P5 (brief-p5-v3.md §3B/§6, CP1 delta 29286fa4) — the twelve new
  // ops. Op numbers, syscalls and shapes measured against rev's
  // p5-ops-node.out/p5-ops-node2.out (753539fe/b6ba5601) and this session's
  // own re-read of both (cp1-plan-p5.txt §2). Op 4's syscall is PER-CODE
  // (B-4/M-21: `lstat` under ENOENT/ENOTDIR, `stat` under ELOOP — realpath
  // alone; every other op below keeps its own literal under ELOOP, the
  // ordinary default). Op 4's `shape:"one"` is METADATA for the generator's
  // template only — its ACTUAL error path is a host fact written into slot
  // B, never `pathALocal` (§6c; the op-4 wrapper is 3C's own work, not
  // built by this table's generic helpers).
  { op: 4, keys: ["realpathSync"], syscall: "lstat", shape: "one", codeOverrides: { ELOOP: { syscall: "stat" } } },
  { op: 5, keys: ["readFdSync"], syscall: "read", shape: "no", codeOverrides: {} },
  { op: 6, keys: ["readSync"], syscall: "read", shape: "no", codeOverrides: {} },
  { op: 7, keys: ["statSync"], syscall: "stat", shape: "one", codeOverrides: {} },
  { op: 8, keys: ["lstatSync"], syscall: "lstat", shape: "one", codeOverrides: {} },
  { op: 15, keys: ["copyFileSync"], syscall: "copyfile", shape: "two", codeOverrides: {} },
  { op: 16, keys: ["chmodSync"], syscall: "chmod", shape: "one", codeOverrides: {} },
  { op: 17, keys: ["chownSync"], syscall: "chown", shape: "one", codeOverrides: {} },
  { op: 18, keys: ["closeSync"], syscall: "close", shape: "no", codeOverrides: {} },
  { op: 21, keys: ["openSync"], syscall: "open", shape: "one", codeOverrides: {} },
  { op: 22, keys: ["readFdSyncBytes"], syscall: "fstat", shape: "no", codeOverrides: {} },
  { op: 23, keys: ["readFdSyncBytes"], syscall: "read", shape: "no", codeOverrides: {} },
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

  /** Reads a NEW bytes(u8) array of `lenLocal` RAW BYTES starting at
   * `basePtrLocal`, via `emitI32Load8U` — `emitReadStrAt`'s own loop
   * idiom, ONE byte at a time instead of ONE UTF-16 code unit (no ×2
   * stride, no wide load). `bytesNewLen`/`bytesSetElem` take F64
   * index/value (typedarrays.ts's own convention), so each iteration
   * converts the loop counter and the loaded byte through `f64ConvertI32
   * S` — the FIRST byte payload in slot B (P4's own R-3 axis). ERRATUM
   * E-P5-4 (des/ERRATA-design-v7-p3.txt): this payload does NOT exercise
   * `emitRoundUp2` — that rounding only ever sees slot A's own byte
   * length (a UTF-16 code-unit count × 2, unconditionally even), never
   * slot B's; it is an identity on every input it receives. */
  private emitReadBytesAt(c: Code, basePtrLocal: number, lenLocal: number, resultLocal: number, iLocal: number): void {
    c.localGet(lenLocal);
    c.f64ConvertI32S();
    c.call(this.deps.bytesNewLen());
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
    c.f64ConvertI32S();
    c.localGet(basePtrLocal);
    c.localGet(iLocal);
    c.i32Add();
    c.i32Load8U();
    c.f64ConvertI32S();
    c.call(this.deps.bytesSetElem());
    c.localGet(iLocal);
    c.i32Const(1);
    c.i32Add();
    c.localSet(iLocal);
    c.br(0);
    c.end();
    c.end();
  }

  /** The INVERSE of `emitReadBytesAt`: writes `srcLocal`'s (a bytes(u8)
   * array) own content, one raw byte at a time, into linear memory
   * starting at `basePtrLocal` — via plain `i32Store8` (already a Code
   * method; no new opcode needed here, only the READ side does). Used by
   * writeFileSyncBytesHelper to stage a BYTES_U8 payload into slot B. */
  private emitWriteBytesAt(c: Code, srcLocal: number, basePtrLocal: number, lenLocal: number, iLocal: number): void {
    c.i32Const(0);
    c.localSet(iLocal);
    c.block();
    c.loop();
    c.localGet(iLocal);
    c.localGet(lenLocal);
    c.i32GeS();
    c.brIf(1);
    c.localGet(basePtrLocal);
    c.localGet(iLocal);
    c.i32Add();
    c.localGet(srcLocal);
    c.localGet(iLocal);
    c.f64ConvertI32S();
    c.call(this.deps.bytesGetElem());
    c.i32TruncF64U();
    c.i32Store8();
    c.localGet(iLocal);
    c.i32Const(1);
    c.i32Add();
    c.localSet(iLocal);
    c.br(0);
    c.end();
    c.end();
  }

  /** op 4 (realpathSync) ONLY: the error path's own LENGTH is not
   * available from `fsCall`'s single i32 return (see realpathSyncHelper's
   * own header comment on why "length in `y`" cannot be literal) — the
   * host's own contract for THIS op, both ends built in this pass, RULED
   * (INC-26 P5 3C-2, brief-p5-delta-3c.txt 0c29d591, over an earlier
   * NUL-terminated draft): the host writes the error path's own u16
   * CODE-UNIT COUNT as a length PREFIX at `basePtrLocal`, then the UTF-16
   * payload starting at `basePtrLocal + 2` — no scan loop, no assumption
   * about content, and slot B's own 2-byte alignment already makes
   * `i32.load16_u` safe for the count (no DataView needed, no 4- or
   * 8-byte field here). Reads the prefix, then delegates to
   * `emitReadStrAt` for the payload at the shifted base. */
  private emitReadLengthPrefixedStrAt(c: Code, basePtrLocal: number, resultLocal: number, lenLocal: number, payloadBaseLocal: number, iLocal: number): void {
    c.localGet(basePtrLocal);
    c.i32Load16U();
    c.localSet(lenLocal);
    c.localGet(basePtrLocal);
    c.i32Const(2);
    c.i32Add();
    c.localSet(payloadBaseLocal);
    this.emitReadStrAt(c, payloadBaseLocal, lenLocal, resultLocal, iLocal);
  }

  /* ── the error table, rendered at runtime from a numeric status ─────────
   * `emitThrowFromStatus`: a TS-level CODE GENERATOR (not itself one wasm
   * function) — called once per op-specific wrapper's own construction,
   * with `defaultSyscall`/`defaultShape`/`codeOverrides` as COMPILE-TIME
   * parameters, so every one of the fourteen branches it emits is a SINGLE
   * compile-time-known string literal up to the path. Fourteen independent
   * (never chained) `ifVoid` checks — safe because the fourteen codes are
   * mutually exclusive by construction. Requires TWO scratch locals from
   * the caller: `matchedLocal` (the fallback flag) and `nLocal` (the
   * UNKNOWN arm's numeral). NEVER branches out of its own `ifVoid`
   * bodies — every exit is a plain fallthrough, so callers may embed this
   * anywhere without block-depth bookkeeping. `codeOverrides` (INC-26 P5,
   * generalized from the single-purpose `eisdirOverride`, CP1 delta
   * 29286fa4 B-4) is looked up by the CODE's own NAME, never a numeric
   * index — `OP_TABLE`'s own contract.
   *
   * `defaultShape`'s OWN TYPE IS DELIBERATELY NARROWER THAN
   * `FsOpTableEntry["shape"]` (rev-26's 3B read, findings-rev26-3b-p5.txt
   * bdbc0b6d/256, R-2/RECORD (c)): this function's shape arm is a binary
   * `if (shape === "one") … else …`, so over the THREE-valued domain
   * `FsOpTableEntry["shape"]` actually has ("one"|"no"|"two", op 15's
   * copyFileSync), an "else" would silently render op 15's error as a
   * NO-PATH message — wrong, and with no test between it and the output.
   * `"one" | "no"` here is what makes that IMPOSSIBLE rather than merely
   * avoided: "two" is structurally unpassable, so the `else` branch can
   * only ever be "no". DO NOT WIDEN THIS PARAMETER'S TYPE to reuse this
   * helper for op 15 (copyFileSync has its own dedicated
   * `emitThrowFromStatusTwoPath` below, by design) — widening it turns
   * the `else` into a live wrong-message path this file's own tests do
   * not exercise. If a future op ever needs "two" through THIS helper,
   * the fix is a THIRD branch here, never a widened parameter type. */
  private emitThrowFromStatus(
    c: Code,
    statusLocal: number,
    pathALocal: number,
    matchedLocal: number,
    nLocal: number,
    defaultSyscall: string,
    defaultShape: "one" | "no",
    codeOverrides: FsCodeOverrides,
  ): void {
    c.i32Const(0);
    c.localSet(matchedLocal);
    for (let i = 0; i < CODES.length; i++) {
      const codeNum = i + 1;
      const [name, text] = CODES[i]!;
      const override = codeOverrides[name];
      const syscall = override?.syscall ?? defaultSyscall;
      const shape = override?.shape ?? defaultShape;
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
  private buildReadLengthOp(name: string, op: number, defaultSyscall: string, codeOverrides: FsCodeOverrides, needsXXXXXX: boolean, xFlag = 0): number {
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
      c.i32Const(xFlag); // x: 0 for readFileSync/mkdtempSync/readdirSync; 1 for readdirTypesSync (D-6/D-8, ruling 3) — readdirTypesSync is a SECOND key on THIS SAME op-2 row, never a new op; the default stays 0 so it is a DELIBERATE literal here, not an uninitialized one (a forced-host row asserts ops 1/3 still send x=0, §9)
      c.i32Const(0); // y unused by every op that reaches this helper
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
      this.emitThrowFromStatus(c, STATUS, STAGE_STR, MATCHED, N, defaultSyscall, "one", codeOverrides);
      c.refNull(this.strType());
      c.end();

      this.mb.setBody(idx, [this.strRef(), I32, I32, I32, I32, I32, this.strRef(), I32, I32, I32], c.bytes());
    });
  }

  /** `%w.fs.readFileSync(path) -> str` (op 1). EISDIR is `read`/NO-PATH,
   * the ONE exception in the whole table (op 1's own read-stage). */
  readFileSyncHelper(): number {
    return this.buildReadLengthOp("readFileSync", 1, "open", { EISDIR: { syscall: "read", shape: "no" } }, false);
  }

  /** `%w.fs.readFileSyncBytes(path) -> bytes(u8)` (op 1, SAME row as
   * readFileSync — a byte-for-byte read, never UTF-16 decoded). Mirrors
   * `buildReadLengthOp`'s own retry-loop shape exactly (op 1's own
   * EISDIR/read/no-path override applies here too — measured: the errno
   * TEXT does not depend on which key reads the bytes), swapping
   * `emitReadStrAt` for `emitReadBytesAt` at the one result-building
   * site. */
  readFileSyncBytesHelper(): number {
    return this.cached("readFileSyncBytes", [this.strRef()], [this.deps.bytesRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const A_LEN = 1;
      const A_BASE = 2;
      const B_BASE = 3;
      const CAP = 4;
      const STATUS = 5;
      const RESULT = 6;
      const I = 7;
      const MATCHED = 8;
      const N = 9;

      c.localGet(PATH);
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
        c.localGet(CAP); // bytes, not code units — no ×2 (a byte-payload
        c.i32Add(); // slot needs no stricter alignment than 1, abi.ts)
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
      c.i32Const(1); // op
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.localGet(B_BASE);
      c.localGet(CAP);
      c.i32Const(1); // x: 1 = the BYTES flag (delta-3d a3c02af9 — op 1's x
      // is free, readFileSync's own text-key row keeps it at 0; the SAME
      // flag serves readFileSyncBytes and fsp.readFileBytes, since the
      // latter calls THIS SAME helper) — the host's op-1 case branches on
      // x to pick RAW BYTES (bLen in bytes, no ×2, Uint8Array) over
      // UTF-16 CODE UNITS (bLen in units, Uint16Array); the shared wire
      // shape before this flag existed was genuinely ambiguous (this
      // pass's own STOP-AND-REPORT + rev-26's delta-3d ruling).
      c.i32Const(0); // y unused
      c.call(this.deps.fsCallFunc(1));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(2);
      c.localGet(STATUS);
      c.localGet(CAP);
      c.i32LeS();
      c.brIf(1);
      c.localGet(STATUS);
      c.localSet(CAP);
      c.br(0);
      c.end(); // L_RETRY
      c.end(); // B_MIDDLE
      this.emitReadBytesAt(c, B_BASE, STATUS, RESULT, I);
      c.end(); // B_OUTER

      c.localGet(STATUS);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(this.deps.bytesRef());
      c.localGet(RESULT);
      c.else_();
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, "open", "one", { EISDIR: { syscall: "read", shape: "no" } });
      c.refNull(this.deps.bytesType());
      c.end();

      this.mb.setBody(idx, [I32, I32, I32, I32, I32, this.deps.bytesRef(), I32, I32, I32], c.bytes());
    });
  }

  /** `%w.fs.readdirSyncRaw(path) -> str` (op 2) — the RAW JSON document;
   * the emitter's own dispatch arm parses it via `json.parse()` and walks
   * the result into a `string[]` vec (verify NO json/dyn surface widens —
   * A-9's own rule; the parser is FORBID here, used as-is). */
  readdirSyncRawHelper(): number {
    return this.buildReadLengthOp("readdirSyncRaw", 2, "scandir", {}, false, 0);
  }

  /** `%w.fs.readdirTypesSyncRaw(path) -> str` (op 2, x=1) — D-6/D-8/ruling
   * (3): the SAME op-2 row and errno rows readdirSync shares (measured
   * byte-identical text across both), distinguished by `x` ONLY — the
   * host answers a Dirent-shaped JSON document (names + file-type bits)
   * instead of a plain name array. The call site's own `json.parse()`
   * walk differs (parses into the {%dtype,name,parentPath} record array,
   * never the plain string[] vec) — this file stays agnostic to that
   * shape, exactly like readdirSyncRawHelper's own raw-JSON stance. */
  readdirTypesSyncRawHelper(): number {
    return this.buildReadLengthOp("readdirTypesSyncRaw", 2, "scandir", {}, false, 1);
  }

  /** `%w.fs.mkdtempSync(prefix) -> str` (op 3) — the template rule (A-10):
   * the string STAGED and the string SHOWN ON FAILURE are both
   * `prefix + "XXXXXX"`, never the bare prefix. */
  mkdtempSyncHelper(): number {
    return this.buildReadLengthOp("mkdtempSync", 3, "mkdtemp", {}, true);
  }

  /* ── write-shaped ops: writeFileSync (op 9), appendFileSync (op 10) ──── */

  /** `%w.fs.<name>(path, content) -> void` — the TWO-SLOT staging: slot A
   * (path) at the cursor, slot B (content) at
   * `cursor + roundUp(aLenBytes, 2)`, ONE `ensureCapacity` for the
   * combined size, neither slot moves the cursor. */
  /** `hasMode` (P5, writeFileModeSync only): a THIRD, real I32 param
   * (mode), forwarded as `x` instead of P4's hardcoded inert 0 — abi.ts's
   * own op-9 doc already names `mode=x`; P4's writeFileSync just never
   * had a caller needing a real value. */
  private buildWriteOp(name: string, op: number, defaultSyscall: string, hasMode = false): number {
    return this.cached(name, hasMode ? [this.strRef(), this.strRef(), I32] : [this.strRef(), this.strRef()], [], (idx) => {
      const c = new Code();
      const PATH = 0;
      const CONTENT = 1;
      const MODE = 2; // only meaningful when hasMode
      const base = hasMode ? 3 : 2;
      const A_LEN = base;
      const A_BASE = base + 1;
      const B_LEN = base + 2;
      const B_BASE = base + 3;
      const STATUS = base + 4;
      const MATCHED = base + 5;
      const N = base + 6;

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
      if (hasMode) {
        // delta-3db d7e1c3db, B-1 (rev-26 3D read, BLOCKING): x rides
        // mode+1, NEVER the raw mode — x===0 already means "absent" for
        // every mode-less key sharing this op row, so an UNBIASED x
        // would make an explicit, representable mode 0 indistinguishable
        // from "no mode" (board #142's collision rebuilt on x; measured
        // before choosing the unbiased form: Node's own {mode:0} is a
        // REAL, different mode — EACCES on the SAME process's own
        // immediate re-read). x=0 stays "absent" (the mode-less keys'
        // own unchanged literal); x=1 is mode 0; x=N+1 is mode N.
        c.localGet(MODE);
        c.i32Const(1);
        c.i32Add(); // x: mode + 1
      } else {
        c.i32Const(0);
      }
      c.i32Const(0); // y unused
      c.call(this.deps.fsCallFunc(op));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, defaultSyscall, "one", {});
      c.end();

      // Seven locals beyond the params either way (A_LEN..N) — hasMode
      // only shifts WHERE they start (base=3 vs base=2), never the count.
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32], c.bytes());
    });
  }

  writeFileSyncHelper(): number {
    return this.buildWriteOp("writeFileSync", 9, "open");
  }
  /** writeFileModeSync (op 9, a real mode) — P5's own key. */
  writeFileModeSyncHelper(): number {
    return this.buildWriteOp("writeFileModeSync", 9, "open", true);
  }

  /** `%w.fs.writeFileSyncBytes(path, bytes) -> void` (op 9, SAME row as
   * writeFileSync — the content slot carries RAW BYTES, never UTF-16).
   * `buildWriteOp`'s own two-slot staging, with `emitWriteBytesAt`
   * replacing the content's `stageStrUtf16AtHelper` call — THE FIRST BYTE
   * PAYLOAD IN SLOT B (P4's own R-3 axis). ERRATUM E-P5-4
   * (des/ERRATA-design-v7-p3.txt): `emitRoundUp2` is NOT exercised by
   * this payload — it only ever rounds slot A's own byte length (code
   * units × 2, unconditionally even), an identity on every input. */
  writeFileSyncBytesHelper(): number {
    return this.cached("writeFileSyncBytes", [this.strRef(), this.deps.bytesRef()], [], (idx) => {
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
      const I = 9;

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(A_LEN);
      c.localGet(CONTENT);
      c.call(this.deps.bytesLength());
      c.i32TruncF64U();
      c.localSet(B_LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
        c.localGet(B_LEN); // bytes, no ×2 (a byte-payload slot needs no
        c.i32Add(); // stricter alignment than 1, abi.ts)
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
      this.emitWriteBytesAt(c, CONTENT, B_BASE, B_LEN, I);
      c.i32Const(9); // op
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.localGet(B_BASE);
      c.localGet(B_LEN);
      c.i32Const(0); // x: mode — NOT free on op 9 (writeFileModeSync
      // already spends it), so the bytes flag CANNOT ride x here
      // (delta-3d a3c02af9's correction to this pass's own proposal).
      c.i32Const(1); // y: 1 = the BYTES flag (op 9's own y is the inert
      // 0 everywhere else) — the host's op-9 case branches on y to read
      // slot B as RAW BYTES (bLen in bytes, no ×2) instead of UTF-16 CODE
      // UNITS; writeFileSync/writeFileModeSync/fsp.writeFile all keep
      // y=0 (their own text-key row asserts it, ruling (3)).
      c.call(this.deps.fsCallFunc(9));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, "open", "one", {});
      c.end();

      // locals 2..9: A_LEN,A_BASE,B_LEN,B_BASE,STATUS,MATCHED,N,I (I32×8).
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32, I32], c.bytes());
    });
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
  /** `retryExtras`, when given, names the [maxRetries, retryDelay] indices
   * into `extras` (rmRetrySync ONLY — CP1 delta cp1b/C-2): slot B carries
   * them as a two-i32 LE record (bLen=8), written through `emitI32Store`
   * — NEVER an Int32Array on the host side (N-1's rule at 4-byte
   * granularity, M-24: slot B sits at 2 mod 4 on every odd-code-unit
   * path). x/y keep P4's own meanings byte for byte (recursive, force);
   * `fsCall`'s two integer slots were already full, so the retry pair
   * rides the slot every OTHER write-shaped op leaves free (`bPtr=bLen=0`
   * below is exactly what rmSync/rmOptsSync still send). */
  private buildSimpleOp(name: string, op: number, extraParams: ValType[], pushXY: (c: Code, path: number, extras: number[]) => void, defaultSyscall: string, rmEisdirSpecial: boolean, retryExtras: readonly [number, number] | null = null): number {
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
      const B_BASE = base + 5;

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(A_LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
        if (retryExtras !== null) {
          c.i32Const(8); // the retry record's own fixed byte width
          c.i32Add();
        }
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
      if (retryExtras !== null) {
        c.localGet(A_BASE);
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
        c.i32Add();
        c.localSet(B_BASE);
        c.localGet(B_BASE); // maxRetries @ +0
        c.localGet(extras[retryExtras[0]]!);
        c.i32Store();
        c.localGet(B_BASE);
        c.i32Const(4);
        c.i32Add(); // retryDelay @ +4
        c.localGet(extras[retryExtras[1]]!);
        c.i32Store();
        c.localGet(B_BASE); // bPtr
        c.i32Const(8); // bLen
      } else {
        c.i32Const(0); // bPtr unused
        c.i32Const(0); // bLen unused
      }
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
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, defaultSyscall, "one", {});
      c.end();
      if (rmEisdirSpecial) {
        c.end();
      }

      this.mb.setBody(idx, [...extraParams, I32, I32, I32, I32, I32, I32], c.bytes());
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

  /** mkdirModeSync (op 11, recursive=0, a REAL mode forwarded as x+1 —
   * delta-3db d7e1c3db B-1: biased by one, same reasoning as
   * writeFileModeSync's own — x===0 already means "absent" for
   * mkdirSync/mkdirRecursiveSync above, so an unbiased x would collapse
   * an explicit mode 0 into "no mode"). */
  mkdirModeSyncHelper(): number {
    return this.buildSimpleOp(
      "mkdirModeSync",
      11,
      [I32],
      (c, _path, extras) => {
        c.localGet(extras[0]!);
        c.i32Const(1);
        c.i32Add(); // x: mode + 1
        c.i32Const(0); // y: recursive=0
      },
      "mkdir",
      false,
    );
  }

  /** mkdirRecursiveModeSync (op 11, recursive=1, a REAL mode forwarded as
   * x+1 — delta-3db d7e1c3db B-1, same bias as mkdirModeSync's own) —
   * VOID result, same K-3/S073 fencing as mkdirRecursiveSync. */
  mkdirRecursiveModeSyncHelper(): number {
    return this.buildSimpleOp(
      "mkdirRecursiveModeSync",
      11,
      [I32],
      (c, _path, extras) => {
        c.localGet(extras[0]!);
        c.i32Const(1);
        c.i32Add(); // x: mode + 1
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

  /** rmRetrySync (op 14, a THIRD key — CP1 delta cp1b/C-2, D-3): [STRING,
   * BOOL, BOOL, F64, F64] = recursive, force, maxRetries, retryDelay.
   * recursive/force keep x/y exactly as rmOptsSync; maxRetries/retryDelay
   * ride the slot-B retry record (`retryExtras`, indices 2/3 into
   * `extras`) — measured byte-identical ENOENT text to rmSync/rmOptsSync
   * (rev's p5-rmretry-row.out), so this key adds NO new errno row, only
   * itself to op 14's `keys` array (already done in OP_TABLE). */
  rmRetrySyncHelper(): number {
    return this.buildSimpleOp(
      "rmRetrySync",
      14,
      [I32, I32, I32, I32],
      (c, _path, extras) => {
        c.localGet(extras[0]!); // x: recursive
        c.localGet(extras[1]!); // y: force
      },
      "lstat",
      true,
      [2, 3],
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

  /** chmodSync (op 16, [STRING, F64] mode — converted to i32 at the CALL
   * SITE, accessSync's own precedent, never inside this file). */
  chmodSyncHelper(): number {
    return this.buildSimpleOp(
      "chmodSync",
      16,
      [I32],
      (c, _path, extras) => {
        c.localGet(extras[0]!); // x: mode
        c.i32Const(0); // y unused
      },
      "chmod",
      false,
    );
  }

  /** chownSync (op 17, [STRING, F64, F64] uid,gid — both converted to i32
   * at the CALL SITE). */
  chownSyncHelper(): number {
    return this.buildSimpleOp(
      "chownSync",
      17,
      [I32, I32],
      (c, _path, extras) => {
        c.localGet(extras[0]!); // x: uid
        c.localGet(extras[1]!); // y: gid
      },
      "chown",
      false,
    );
  }

  /* ── copyFileSync (op 15) — the ONE two-path op ──────────────────────── */

  /** The two-path error message (`CODE: text, syscall 'src' -> 'dst'`) —
   * `emitThrowFromStatus` only knows "one"/"no" shapes; this is its
   * dedicated sibling for op 15 alone (OP_TABLE's own `shape:"two"` marks
   * it as NOT rendered by the ordinary helper). WHICH code fires (ENOENT
   * vs EISDIR) is entirely a HOST FACT (the missing-dest-parent-wins trap,
   * rev's own measured gotcha) — this function has no special-case logic
   * of its own, only the two-path TEMPLATE. */
  private emitThrowFromStatusTwoPath(c: Code, statusLocal: number, srcLocal: number, dstLocal: number, matchedLocal: number, nLocal: number, defaultSyscall: string): void {
    c.i32Const(0);
    c.localSet(matchedLocal);
    for (let i = 0; i < CODES.length; i++) {
      const codeNum = i + 1;
      const [name, text] = CODES[i]!;
      c.localGet(statusLocal);
      c.i32Const(-codeNum);
      c.i32Eq();
      c.ifVoid();
      this.deps.throwCoded(
        c,
        "%Error",
        "Error",
        (cc) => {
          this.deps.pushStrLit(cc, `${name}: ${text}, ${defaultSyscall} '`);
          cc.localGet(srcLocal);
          cc.call(this.deps.concat());
          this.deps.pushStrLit(cc, `' -> '`);
          cc.call(this.deps.concat());
          cc.localGet(dstLocal);
          cc.call(this.deps.concat());
          this.deps.pushStrLit(cc, `'`);
          cc.call(this.deps.concat());
        },
        (cc) => this.deps.pushStrLit(cc, name),
      );
      c.i32Const(1);
      c.localSet(matchedLocal);
      c.end();
    }
    c.localGet(matchedLocal);
    c.i32Eqz();
    c.ifVoid();
    c.i32Const(-256);
    c.localGet(statusLocal);
    c.i32Sub();
    c.localSet(nLocal);
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

  /** `%w.fs.copyFileSync(src, dst) -> void` (op 15) — the SAME two-slot
   * staging `buildWriteOp` uses (slot A=src, slot B=dst), but neither
   * slot is "content": both are paths, and failure renders the two-path
   * message above, never `emitThrowFromStatus`. */
  copyFileSyncHelper(): number {
    return this.cached("copyFileSync", [this.strRef(), this.strRef()], [], (idx) => {
      const c = new Code();
      const SRC = 0;
      const DST = 1;
      const A_LEN = 2;
      const A_BASE = 3;
      const B_LEN = 4;
      const B_BASE = 5;
      const STATUS = 6;
      const MATCHED = 7;
      const N = 8;

      c.localGet(SRC);
      c.arrayLen();
      c.localSet(A_LEN);
      c.localGet(DST);
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
      c.localGet(SRC);
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
      c.localGet(DST);
      c.localGet(B_BASE);
      c.call(this.stageStrUtf16AtHelper());
      c.drop();
      c.i32Const(15);
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.localGet(B_BASE);
      c.localGet(B_LEN);
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(15));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitThrowFromStatusTwoPath(c, STATUS, SRC, DST, MATCHED, N, "copyfile");
      c.end();

      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /* ── HANDLE-SHAPED / fd-based ops (P5): open (21), close (18), read (6),
   * readFd ENCODED (5), readFdSyncBytes's two internal stages (22, 23) ─── */

  /** `%w.fs.openSync(path, flagsInt) -> f64` (op 21). `flagsInt` is
   * CONVERTED FROM THE FLAGS STRING AT THE CALL SITE (accessSync's own
   * "never inside this file" precedent) — Node's own flag strings ('r',
   * 'w', 'wx', 'a', ...) map to a small fixed POSIX-flags integer set,
   * looked up at COMPILE TIME since every corpus use is a literal (an
   * unrecognized literal, e.g. "zz", is the call site's own compile-time-
   * known ERR_INVALID_ARG_VALUE throw, 1640's own row). `y` (mode) is
   * ALWAYS the compile-time constant 0o666 — validate.ts's own [STRING,
   * STRING] signature carries no mode argument, so this tier's openSync
   * never takes one, matching Node's own default. On success, STATUS
   * (>=0) IS the fd, returned as f64 directly — no retry loop (open never
   * "retries for more room", it either gets an fd or an errno). */
  openSyncHelper(): number {
    return this.cached("openSync", [this.strRef(), I32], [{ kind: "f64" }], (idx) => {
      const c = new Code();
      const PATH = 0;
      const FLAGS = 1;
      const A_LEN = 2;
      const A_BASE = 3;
      const STATUS = 4;
      const MATCHED = 5;
      const N = 6;

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
      c.i32Const(21);
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.i32Const(0); // bPtr unused
      c.i32Const(0); // bLen unused
      c.localGet(FLAGS); // x: flags
      c.i32Const(0o666); // y: mode (this tier's own fixed default)
      c.call(this.deps.fsCallFunc(21));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifResult({ kind: "f64" });
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, "open", "one", {});
      c.f64Const(0); // placeholder, never read (emitPendingCheck branches first)
      c.else_();
      c.localGet(STATUS);
      c.f64ConvertI32S();
      c.end();

      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /** `%w.fs.closeSync(fd) -> void` (op 18) — fd-only, no path, shape
   * "no" (EBADF carries no path, measured). */
  closeSyncHelper(): number {
    return this.cached("closeSync", [I32], [], (idx) => {
      const c = new Code();
      const FD = 0;
      const STATUS = 1;
      const MATCHED = 2;
      const N = 3;

      c.i32Const(18);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(FD); // x: fd
      c.i32Const(0); // y unused
      c.call(this.deps.fsCallFunc(18));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitThrowFromStatus(c, STATUS, FD /* unused, shape "no" never reads it */, MATCHED, N, "close", "no", {});
      c.end();

      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }

  /** `%w.fs.readSync(fd, offset, length) -> f64` (op 6) — reads INTO the
   * shared staging region at slot B (aPtr/aLen unused — no path), NOT
   * into the caller's own BYTES_U8 buffer: copying the staged bytes into
   * the program's buffer at `offset` needs `this.bytesB` (emitter.ts's
   * own dependency, unavailable inside fs.ts — FsDeps carries no bytes-
   * array surface, by design, matching the "code.ts is not PERMIT" split:
   * this file stays the fsCall/errno-table specialist). The CALL SITE
   * (emitter.ts's own dispatch arm) does the copy, using `stageCursor()`
   * directly (the SAME global this helper reads B_BASE from — see the
   * dispatch arm's own comment for why the value is still valid there:
   * nothing re-stages between this call returning and the copy loop
   * running). Returns the byte COUNT on success (`status`, f64), throws
   * internally on failure (shape "no" — EBADF carries no path). */
  readSyncHelper(): number {
    return this.cached("readSync", [I32, I32], [{ kind: "f64" }], (idx) => {
      const c = new Code();
      const FD = 0;
      const LENGTH = 1;
      const B_BASE = 2;
      const STATUS = 3;
      const MATCHED = 4;
      const N = 5;

      this.deps.ensureCapacity(c, () => {
        c.localGet(LENGTH);
      });
      c.globalGet(this.deps.stageCursor());
      c.localSet(B_BASE);
      c.i32Const(6);
      c.i32Const(0); // aPtr unused
      c.i32Const(0); // aLen unused
      c.localGet(B_BASE);
      c.localGet(LENGTH); // bLen: capacity offered
      c.localGet(FD); // x: fd
      c.i32Const(0); // y unused
      c.call(this.deps.fsCallFunc(6));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifResult({ kind: "f64" });
      this.emitThrowFromStatus(c, STATUS, FD, MATCHED, N, "read", "no", {});
      c.f64Const(0);
      c.else_();
      c.localGet(STATUS);
      c.f64ConvertI32S();
      c.end();

      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
    });
  }

  /** `%w.fs.readFdSync(fd, enc) -> str` (op 5, ENCODED form only — design
   * §2: syscall is ALWAYS `read`). `enc` is evaluated at the call site
   * for JS-exact side-effect order and otherwise ignored here (this
   * tier's own single-encoding stance, `readFileSync`'s own args[1]
   * precedent) — the DECODE itself is `emitReadStrAt`'s ordinary UTF-16
   * path (P5's own scope: the corpus's own readFdSync use is UTF-16-
   * compatible content; a non-UTF-16-safe encoding is out of tier). Uses
   * `buildReadLengthOp`'s own retry contract (aPtr/aLen unused — no path;
   * `x`=fd). */
  readFdSyncHelper(): number {
    return this.cached("readFdSync", [I32], [this.strRef()], (idx) => {
      const c = new Code();
      const FD = 0;
      const B_BASE = 1;
      const CAP = 2;
      const STATUS = 3;
      const RESULT = 4;
      const I = 5;
      const MATCHED = 6;
      const N = 7;

      c.i32Const(64);
      c.localSet(CAP);
      c.block(); // B_OUTER
      c.block(); // B_MIDDLE
      c.loop(); // L_RETRY
      this.deps.ensureCapacity(c, () => {
        c.localGet(CAP);
        c.i32Const(2);
        c.i32Mul();
      });
      c.globalGet(this.deps.stageCursor());
      c.localSet(B_BASE);
      c.i32Const(5);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(B_BASE);
      c.localGet(CAP);
      c.localGet(FD); // x: fd
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(5));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(2);
      c.localGet(STATUS);
      c.localGet(CAP);
      c.i32LeS();
      c.brIf(1);
      c.localGet(STATUS);
      c.localSet(CAP);
      c.br(0);
      c.end(); // L_RETRY
      c.end(); // B_MIDDLE
      this.emitReadStrAt(c, B_BASE, STATUS, RESULT, I);
      c.end(); // B_OUTER

      c.localGet(STATUS);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(this.strRef());
      c.localGet(RESULT);
      c.else_();
      this.emitThrowFromStatus(c, STATUS, FD, MATCHED, N, "read", "no", {});
      c.refNull(this.strType());
      c.end();

      // locals 1..7: B_BASE,CAP,STATUS (I32×3), RESULT (strRef),
      // I,MATCHED,N (I32×3).
      this.mb.setBody(idx, [I32, I32, I32, this.strRef(), I32, I32, I32], c.bytes());
    });
  }

  /** `%w.fs.readFdSyncBytes(fd) -> bytes(u8)` — readFdSyncBytes's TWO
   * INTERNAL STAGES, ONE combined wasm function (design: "22 then 23,
   * reporting the FAILING stage's own literal"): op 22 (`fstatFd`)
   * answers the byte SIZE to allocate; op 23 (`readFdInto`) does the
   * actual read into the shared staging region, then `emitReadBytesAt`
   * builds the final array — matching every other op's own "one fs.ts
   * helper, one call site" shape (a SEPARATE stage-1-then-stage-2 split
   * across TWO named wasm functions would need the call site to
   * distinguish "genuine failure" from "a real size of 0" from stage 1's
   * OWN f64 return alone, which it cannot: `emitThrowFromStatus` writes
   * the pending cell but still returns a PLACEHOLDER value indistinguish-
   * able from a legitimate 0 — so BOTH stages' `STATUS` checks must
   * happen HERE, before either placeholder substitution, never at a
   * caller working from a return value only). Each stage throws citing
   * its OWN syscall literal (`fstat`/`read`) if IT fails; stage 2 never
   * runs if stage 1 already failed. */
  readFdSyncBytesHelper(): number {
    return this.cached("readFdSyncBytes", [I32], [this.deps.bytesRef()], (idx) => {
      const c = new Code();
      const FD = 0;
      const SIZE = 1;
      const B_BASE = 2;
      const STATUS = 3;
      const MATCHED = 4;
      const N = 5;
      const RESULT = 6;
      const I = 7;

      // Stage 1: op 22 (fstatFd) -> SIZE, or failure (reports `fstat`).
      c.i32Const(22);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(FD);
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(22));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifResult(this.deps.bytesRef());
      this.emitThrowFromStatus(c, STATUS, FD, MATCHED, N, "fstat", "no", {});
      c.refNull(this.deps.bytesType());
      c.else_();
      // Stage 2: op 23 (readFdInto), capacity = stage 1's own SIZE.
      c.localGet(STATUS);
      c.localSet(SIZE);
      this.deps.ensureCapacity(c, () => {
        c.localGet(SIZE);
      });
      c.globalGet(this.deps.stageCursor());
      c.localSet(B_BASE);
      c.i32Const(23);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(B_BASE);
      c.localGet(SIZE);
      c.localGet(FD);
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(23));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifResult(this.deps.bytesRef());
      this.emitThrowFromStatus(c, STATUS, FD, MATCHED, N, "read", "no", {});
      c.refNull(this.deps.bytesType());
      c.else_();
      this.emitReadBytesAt(c, B_BASE, STATUS, RESULT, I);
      c.localGet(RESULT);
      c.end();
      c.end();

      this.mb.setBody(idx, [I32, I32, I32, I32, I32, this.deps.bytesRef(), I32], c.bytes());
    });
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

  /* ── INC-26 P5 (brief-p5-v3.md §0.5/§4, CP1 delta 29286fa4 A-2/E-P5-1) —
   * the stats struct: a WasmGC struct of five fields (isFile/isDirectory/
   * isSymbolicLink as I32 booleans — mapType's OWN "bool" convention,
   * emitter.ts:9051 — size/mtimeMs as F64), populated from the FIXED
   * 20-byte slot-B record ops 7/8 write (abi.ts's E-P5-1 layout: three
   * boolean bytes + one pad byte at offsets 0-3, size f64 at offset 4,
   * mtimeMs f64 at offset 12). THE HOST WRITES THE TWO f64 FIELDS THROUGH
   * A DataView (N-1) — the MODULE's own read side is UNCONSTRAINED (wasm
   * loads carry an alignment HINT, never a requirement), so a plain
   * `f64.load`/`i32.load8_u` at the field's own byte offset is correct
   * regardless of slot B's 2-byte-only alignment.
   *
   * `i32Load8U()`/`f64Load()`/`i32Store()` are `Code`'s own methods
   * (code.ts, INC-26 P5 3C-1, brief-p5-delta-3c.txt 0c29d591,
   * PERMIT-HUNK — one hunk, beside the existing `i32Load16U`): a first
   * draft hand-encoded these as raw bytes through `Code.w` (its own
   * public `ByteWriter` field) because code.ts was absent from the
   * brief's §4 at the time; the lead's ruling corrected this — the
   * instruction surface belongs in code.ts as named methods, not as a
   * hand-encoded opcode no type check can see. Alignment hint 0
   * throughout (no alignment claimed), matching `i32Store8`/`i32Load16U`'s
   * own convention; the dynamic address (base + field offset) is
   * computed and pushed by the CALLER before each call, exactly like
   * those two methods. */

  private statsTypeCache: number | undefined;
  /** The stats struct's own type index — field order is the ABI (append-
   * only, abi.ts's E-P5-1 layout): 0 isFile, 1 isDirectory, 2
   * isSymbolicLink (I32 each), 3 size, 4 mtimeMs (F64 each). Interned by
   * SHAPE (`structType`, never a keyed variant) — nothing else in this
   * tier needs nominal distinction from a five-field (i32,i32,i32,f64,f64)
   * struct, and sharing a type index with an incidental shape match would
   * be harmless (GC structs are structurally validated either way). */
  statsType(): number {
    if (this.statsTypeCache !== undefined) return this.statsTypeCache;
    const idx = this.mb.structType([
      { storage: I32, mutable: false },
      { storage: I32, mutable: false },
      { storage: I32, mutable: false },
      { storage: { kind: "f64" }, mutable: false },
      { storage: { kind: "f64" }, mutable: false },
    ]);
    this.statsTypeCache = idx;
    return idx;
  }
  statsRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.statsType() };
  }

  /** `%w.fs.<name>(path) -> stats` for op 7 (statSync) / op 8 (lstatSync).
   * NOT `buildReadLengthOp`-shaped: the slot-B record is FIXED SIZE (no
   * retry-on-undersized loop — abi.ts's E-P5-1), so status is 0 on
   * success (write-shaped's own contract), never a length. On failure,
   * renders the ORDINARY fourteen-way table (no codeOverrides — stat/
   * lstat's own literal syscall never varies by code, unlike realpath's). */
  private buildStatOp(name: string, op: number, defaultSyscall: string): number {
    return this.cached(name, [this.strRef()], [this.statsRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const A_LEN = 1;
      const A_BASE = 2;
      const B_BASE = 3;
      const STATUS = 4;
      const MATCHED = 5;
      const N = 6;
      const RESULT = 7;

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(A_LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(A_LEN);
        c.i32Const(2);
        c.i32Mul();
        this.emitRoundUp2(c);
        c.i32Const(20); // the fixed stats record's own byte width
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
      c.i32Const(op);
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.localGet(B_BASE);
      c.i32Const(20); // bLen: the record's own fixed capacity
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.deps.fsCallFunc(op));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.ifResult(this.statsRef());
      this.emitThrowFromStatus(c, STATUS, PATH, MATCHED, N, defaultSyscall, "one", {});
      c.refNull(this.statsType());
      c.else_();
      // success: read the fixed record from slot B into a NEW stats struct.
      c.localGet(B_BASE);
      c.i32Load8U(); // isFile @ +0
      c.localGet(B_BASE);
      c.i32Const(1);
      c.i32Add();
      c.i32Load8U(); // isDirectory @ +1
      c.localGet(B_BASE);
      c.i32Const(2);
      c.i32Add();
      c.i32Load8U(); // isSymbolicLink @ +2
      c.localGet(B_BASE);
      c.i32Const(4);
      c.i32Add();
      c.f64Load(); // size @ +4
      c.localGet(B_BASE);
      c.i32Const(12);
      c.i32Add();
      c.f64Load(); // mtimeMs @ +12
      c.structNew(this.statsType());
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.end();

      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, this.statsRef()], c.bytes());
    });
  }
  statSyncHelper(): number {
    return this.buildStatOp("statSync", 7, "stat");
  }
  lstatSyncHelper(): number {
    return this.buildStatOp("lstatSync", 8, "lstat");
  }

  /** `%w.fs.realpathSync(path) -> str` (op 4) — B-3/B-4/E-P5-2: the ONE op
   * whose error path is a HOST FACT (the argument resolved — symlinks
   * replaced, `.` dropped, `..` applied, relative absolutized — then
   * truncated at the first failing component under ENOENT, or reported
   * WHOLE under ENOTDIR), never `pathALocal`. THE WIRE PROTOCOL: the
   * brief's own abi.ts line originally read "ON FAILURE returns -errno
   * AND WRITES THE ERROR PATH INTO SLOT B (length in `y`)" — but `y` is
   * an INPUT-only fsCall parameter (a host import cannot mutate a
   * module-owned local through it), so a length literally riding `y`
   * back to the module was not mechanically possible; `fsCall` returns
   * exactly one i32. RULED (INC-26 P5 3C-2, brief-p5-delta-3c.txt
   * 0c29d591, over this file's own first NUL-terminated draft): a u16
   * LENGTH PREFIX — the OVERSHOOT-RETRY mechanism stays exactly what
   * `buildReadLengthOp` already has ("the answer exceeds capacity,
   * nothing is written, the true length comes back positive, retry"),
   * covering the FAILURE case too (the host returns the NEEDED size —
   * prefix unit included — as a positive overshoot signal, indistinguish-
   * able at that moment from an oversized SUCCESS answer, until CAP is
   * sufficient); but ONCE THE HOST COMMITS to failure (status<0), slot B
   * holds the error path's own u16 CODE-UNIT COUNT at its base, then the
   * UTF-16 payload at base+2 — read via `emitReadLengthPrefixedStrAt`
   * below (no scan loop, no content assumption), never `pathALocal` the
   * way every other op's message does. */
  realpathSyncHelper(): number {
    return this.cached("realpathSync", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const PATH = 0;
      const A_LEN = 1;
      const A_BASE = 2;
      const B_BASE = 3;
      const CAP = 4;
      const STATUS = 5;
      const RESULT = 6;
      const I = 7;
      const MATCHED = 8;
      const N = 9;
      const ELEN = 10;
      const PBASE = 11;

      c.localGet(PATH);
      c.arrayLen();
      c.localSet(A_LEN);
      c.i32Const(64);
      c.localSet(CAP);

      // B_OUTER { B_MIDDLE { L_RETRY { ...; brIf(2) on a COMMITTED failure
      // (status<0 — the host only returns this once CAP already covered
      // the error path's own u16 length prefix PLUS its payload, so slot
      // B is ready to read); brIf(1) on a committed success (0<=status<=
      // CAP); else status was an OVERSHOOT SIGNAL (status>CAP, success OR
      // failure alike, the host has written NOTHING yet) — retry with
      // that much room } } — EXACTLY buildReadLengthOp's own shape; only
      // the FAILURE payload source differs (slot B's length-prefixed
      // form, never `pathALocal`). */
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
      c.i32Const(4); // op
      c.localGet(A_BASE);
      c.localGet(A_LEN);
      c.localGet(B_BASE);
      c.localGet(CAP);
      c.i32Const(0); // x unused
      c.i32Const(0); // y unused (see the wire-protocol note above)
      c.call(this.deps.fsCallFunc(4));
      c.localSet(STATUS);
      c.localGet(STATUS);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(2); // committed failure -> past B_MIDDLE and B_OUTER
      c.localGet(STATUS);
      c.localGet(CAP);
      c.i32LeS();
      c.brIf(1); // committed success (fits) -> past the loop only
      c.localGet(STATUS);
      c.localSet(CAP); // overshoot signal (either eventual outcome) -> retry
      c.br(0);
      c.end(); // L_RETRY
      c.end(); // B_MIDDLE (reached via brIf(1), success)
      this.emitReadStrAt(c, B_BASE, STATUS, RESULT, I);
      c.end(); // B_OUTER (fallthrough from success, OR via brIf(2) failure)

      c.localGet(STATUS);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(this.strRef());
      c.localGet(RESULT);
      c.else_();
      // FAILURE: slot B holds a u16 code-unit COUNT at its base, then the
      // error path's own UTF-16 payload at base+2 (3C-2's ruling) — read
      // it back instead of PATH.
      this.emitReadLengthPrefixedStrAt(c, B_BASE, RESULT, ELEN, PBASE, I);
      const op4Entry = OP_TABLE.find((e) => e.op === 4)!; // never a duplicated literal — OP_TABLE is the ONE source fs-errno-rows.test.ts's own cross-check reads
      this.emitThrowFromStatus(c, STATUS, RESULT, MATCHED, N, op4Entry.syscall, "one", op4Entry.codeOverrides);
      c.refNull(this.strType());
      c.end();

      // locals 1..11: A_LEN,A_BASE,B_BASE,CAP,STATUS (I32×5), RESULT
      // (strRef), I,MATCHED,N,ELEN,PBASE (I32×5) — PATH (local 0) is the
      // param.
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, this.strRef(), I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /** The five stats.* accessors (validate.ts:290-294) — pure `structGet`
   * reads, no error path (a null stats ref never reaches here: every
   * caller already holds a non-null result from a successful stat/lstat,
   * or the pending-exception check already branched away). */
  statsIsFileHelper(): number {
    return this.cached("statsIsFile", [this.statsRef()], [I32], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.structGet(this.statsType(), 0);
      this.mb.setBody(idx, [], c.bytes());
    });
  }
  statsIsDirectoryHelper(): number {
    return this.cached("statsIsDirectory", [this.statsRef()], [I32], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.structGet(this.statsType(), 1);
      this.mb.setBody(idx, [], c.bytes());
    });
  }
  statsIsSymbolicLinkHelper(): number {
    return this.cached("statsIsSymbolicLink", [this.statsRef()], [I32], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.structGet(this.statsType(), 2);
      this.mb.setBody(idx, [], c.bytes());
    });
  }
  statsSizeHelper(): number {
    return this.cached("statsSize", [this.statsRef()], [{ kind: "f64" }], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.structGet(this.statsType(), 3);
      this.mb.setBody(idx, [], c.bytes());
    });
  }
  statsMtimeMsHelper(): number {
    return this.cached("statsMtimeMs", [this.statsRef()], [{ kind: "f64" }], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.structGet(this.statsType(), 4);
      this.mb.setBody(idx, [], c.bytes());
    });
  }
}
