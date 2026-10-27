/* Strings unit S2 — concatenation nodes (V8's ConsString) on the wasm
 * tier.
 *
 * A string VALUE (strings unit S1: typed `(ref null eq)`) is now either a
 * flat `$chars` array or a `$rope` node `{len, l, r}`: `a + b`, `+=` and
 * template literals whose result is 13 code units or longer (V8's
 * ConsString::kMinLength) build a node instead of copying both operands,
 * so an accumulation loop is linear instead of quadratic. Everything that
 * reads code units still takes flat `$chars`: the one crossing, strings.ts
 * emitFlat/emitFlatCast, calls %w.str.flat here, which answers a flat
 * array as itself and flattens a rope. A module with no concatenation at
 * all (emitter.ts hasStrConcat) can hold no node: it keeps S1's plain
 * cast and is byte-identical to a build before this unit.
 *
 *   - Flattening caches IN PLACE, as V8 does (the ConsString becomes
 *     "first = flat, second = empty"): the node's `l` becomes the flat
 *     array and `r` null, so a second read is O(1) and the children are
 *     released to the collector.
 *   - The copy is ITERATIVE with an explicit stack: at each node it walks
 *     into the SHORTER child and pushes the longer one as the
 *     continuation, so the stack never holds more than log2(len) + 1
 *     entries — a 4M-node left-deep (`+=`) or right-deep (prepend) chain
 *     uses one or two. No recursion, so a deep rope cannot overflow the
 *     wasm (or, translated, the C) stack.
 *   - Length is O(1): stored in the node.
 *   - Short-tail merging: appending a short flat piece to a node whose
 *     right child is short and flat rebuilds that tail as one flat array
 *     (≤ 32 units) under a new node instead of stacking a node per piece —
 *     `s += "a"` then allocates one node per step, not a node per unit
 *     on the live heap. The mirror image (a short flat piece PREPENDED to
 *     a node whose left child is short and flat) merges the head the same
 *     way, so `s = x + s` loops stay as compact.
 *   - Flattening a node whose two children are both flat (the
 *     append-then-read step) is two copies with no stack.
 *
 * The node type sits in a two-entry recursive group with a private brand
 * struct, so iso-recursive canonicalisation can never make it the same
 * type as some program struct of the same shape (a `ref.test` against
 * such a struct must not answer yes for a rope).
 *
 * Nothing here is observable: strings stay immutable values with the same
 * contents, and identity is not observable for JS primitives. */
import { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

/** V8's ConsString::kMinLength: a concatenation shorter than this is a
 * flat copy. */
export const CONS_MIN_LENGTH = 13;
/** Short-tail merging: a node's right child is rebuilt as one flat array
 * while the merged tail stays at or under this many code units. */
const TAIL_MERGE_MAX = 32;
/** V8's String::kMaxLength (0x1fffffe8 on 64-bit): a concatenation
 * longer than this throws Node's catchable RangeError "Invalid string
 * length" (the `tooLong` dependency fills the exception cell; the caller's
 * pending check unwinds). Two lengths at most this sum within an i32. */
export const MAX_STRING_LENGTH = 0x1fff_ffe8;
/** The flatten stack: walking into the shorter child bounds the depth by
 * log2(2^30) + 1 entries; this is twice that. */
const STACK_SLOTS = 64;

const EQ_HEAP = -0x13;
const ANY_HEAP = -0x12;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };
const ANY_REF: ValType = { kind: "ref", nullable: true, typeIndex: ANY_HEAP };

/** Rope field indices. */
const LEN = 0;
const L = 1;
const R = 2;

export class Ropes {
  /** The `$rope` struct: (len i32, l (mut eqref), r (mut eqref)). */
  private ropeTypeField: number | null = null;
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly strType: number,
    /** The flat concat helper (%w.concat: two `$chars` → a fresh one). */
    private readonly flatConcat: () => number,
    /** Fills the exception cell with RangeError "Invalid string length". */
    private readonly tooLong: () => number,
  ) {}

  /** The `$rope` struct: (len i32, l (mut eqref), r (mut eqref)) —
   * declared on first use, so a module that never flattens or
   * concatenates a string value is byte-identical to one built before
   * this unit. */
  get ropeType(): number {
    this.ropeTypeField ??= this.mb.recGroup2("%w.rope", () => [
      {
        kind: "struct",
        fields: [
          { storage: I32, mutable: false },
          { storage: EQ_REF, mutable: true },
          { storage: EQ_REF, mutable: true },
        ],
      },
      // The brand: never instantiated, it only makes the group unique.
      { kind: "struct", fields: [{ storage: "i8", mutable: false }, { storage: "i16", mutable: false }, { storage: "i8", mutable: false }] },
    ]);
    return this.ropeTypeField;
  }

  private strRef(nullable: boolean): ValType {
    return { kind: "ref", nullable, typeIndex: this.strType };
  }

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** %w.str.len (ref null eq) → i32 — a string value's length, O(1) for
   * both shapes. Null traps (as the array.len it replaces did). */
  len(): number {
    return this.cached("len", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([EQ_REF], [I32]), "%w.str.len");
      const c = new Code();
      c.localGet(0);
      c.refTest(this.strType);
      c.ifResult(I32);
      c.localGet(0);
      c.castChars(this.strType, false);
      c.arrayLen();
      c.else_();
      c.localGet(0);
      c.refCast(this.ropeType);
      c.structGet(this.ropeType, LEN);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.flat (anyref) → (ref null $chars) — emitFlat's crossing: a
   * flat array (or null) answers itself, a rope flattens (cached). */
  flat(): number {
    return this.cached("flat", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([ANY_REF], [this.strRef(true)]), "%w.str.flat");
      const c = new Code();
      c.localGet(0);
      c.refTestNull(this.strType);
      c.ifResult(this.strRef(true));
      c.localGet(0);
      c.castChars(this.strType, true);
      c.else_();
      c.localGet(0);
      c.refCast(this.ropeType);
      c.call(this.flatten());
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.flatCast (anyref) → (ref $chars) — emitFlatCast's crossing:
   * flat or flattened, trapping on null (and on anything that is not a
   * string) as the `ref.cast $chars` it replaces did. */
  flatCast(): number {
    return this.cached("flatCast", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([ANY_REF], [this.strRef(false)]), "%w.str.flatCast");
      const c = new Code();
      c.localGet(0);
      c.refTest(this.strType);
      c.ifResult(this.strRef(false));
      c.localGet(0);
      c.castChars(this.strType, false);
      c.else_();
      c.localGet(0);
      c.refCast(this.ropeType);
      c.call(this.flatten());
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.flatten (ref $rope) → (ref $chars) — the slow path: the
   * cached flat form, or a fresh array written leaf by leaf (iteratively,
   * see the file comment) and cached in the node. */
  flatten(): number {
    return this.cached("flatten", () => {
      const ropeRef: ValType = { kind: "ref", nullable: false, typeIndex: this.ropeType };
      const idx = this.mb.declareFunc(this.mb.funcType([ropeRef], [this.strRef(false)]), "%w.str.flatten");
      const nodesT = this.mb.arrayType(EQ_REF, true);
      const offsT = this.mb.arrayType(I32, true);
      const P = 0;
      const D = 1; // (ref null $chars) the result
      const NODES = 2;
      const OFFS = 3;
      const SP = 4;
      const CUR = 5; // eqref
      const OFF = 6;
      const N = 7; // (ref null $rope)
      const LL = 8;
      const CH = 9; // (ref null $chars)
      const locals: ValType[] = [
        this.strRef(true),
        { kind: "ref", nullable: true, typeIndex: nodesT },
        { kind: "ref", nullable: true, typeIndex: offsT },
        I32,
        EQ_REF,
        I32,
        { kind: "ref", nullable: true, typeIndex: this.ropeType },
        I32,
        this.strRef(true),
      ];
      const c = new Code();
      // Already flattened: the cached array.
      c.localGet(P);
      c.structGet(this.ropeType, R);
      c.refIsNull();
      c.ifVoid();
      c.localGet(P);
      c.structGet(this.ropeType, L);
      c.castChars(this.strType, false);
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(this.ropeType, LEN);
      c.arrayNewDefault(this.strType);
      c.localSet(D);
      c.block(); // $cache: both paths leave the filled array in D
      // Two flat children (the append-then-read step): two copies, no walk.
      c.localGet(P);
      c.structGet(this.ropeType, L);
      c.refTest(this.strType);
      c.localGet(P);
      c.structGet(this.ropeType, R);
      c.refTest(this.strType);
      c.i32And();
      c.ifVoid();
      {
        c.localGet(P);
        c.structGet(this.ropeType, L);
        c.castChars(this.strType, false);
        c.localSet(CH);
        c.localGet(D);
        c.i32Const(0);
        c.localGet(CH);
        c.i32Const(0);
        c.localGet(CH);
        c.arrayLen();
        c.localTee(LL);
        c.arrayCopy(this.strType, this.strType);
        c.localGet(P);
        c.structGet(this.ropeType, R);
        c.castChars(this.strType, false);
        c.localSet(CH);
        c.localGet(D);
        c.localGet(LL);
        c.localGet(CH);
        c.i32Const(0);
        c.localGet(CH);
        c.arrayLen();
        c.arrayCopy(this.strType, this.strType);
        c.br(1); // $cache
      }
      c.end();
      // The walk's stack: two module-level arrays made on first use
      // (flattening never re-enters: no callback runs inside it).
      const gNodes = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: nodesT }, true, (w) => {
        w.u8(0xd0);
        w.sleb(nodesT);
      });
      const gOffs = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: offsT }, true, (w) => {
        w.u8(0xd0);
        w.sleb(offsT);
      });
      c.globalGet(gNodes);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(STACK_SLOTS);
      c.arrayNewDefault(nodesT);
      c.globalSet(gNodes);
      c.i32Const(STACK_SLOTS);
      c.arrayNewDefault(offsT);
      c.globalSet(gOffs);
      c.end();
      c.globalGet(gNodes);
      c.localSet(NODES);
      c.globalGet(gOffs);
      c.localSet(OFFS);
      c.localGet(P);
      c.localSet(CUR);
      c.block(); // $done
      c.loop(); // $walk
      {
        // A flat leaf: copy it at OFF, then resume the newest continuation.
        c.localGet(CUR);
        c.refTest(this.strType);
        c.ifVoid();
        {
          c.localGet(D);
          c.localGet(OFF);
          c.localGet(CUR);
          c.castChars(this.strType, false);
          c.localTee(CH);
          c.i32Const(0);
          c.localGet(CH);
          c.arrayLen();
          c.arrayCopy(this.strType, this.strType);
          c.localGet(SP);
          c.i32Eqz();
          c.brIf(2); // $done
          c.localGet(SP);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(SP);
          c.localGet(NODES);
          c.localGet(SP);
          c.arrayGet(nodesT);
          c.localSet(CUR);
          // A popped slot keeps nothing alive.
          c.localGet(NODES);
          c.localGet(SP);
          c.refNull(EQ_HEAP);
          c.arraySet(nodesT);
          c.localGet(OFFS);
          c.localGet(SP);
          c.arrayGet(offsT);
          c.localSet(OFF);
          c.br(1); // $walk
        }
        c.end();
        c.localGet(CUR);
        c.refCast(this.ropeType);
        c.localSet(N);
        // A flattened node is its cached array.
        c.localGet(N);
        c.structGet(this.ropeType, R);
        c.refIsNull();
        c.ifVoid();
        c.localGet(N);
        c.structGet(this.ropeType, L);
        c.localSet(CUR);
        c.br(1); // $walk
        c.end();
        c.localGet(N);
        c.structGet(this.ropeType, L);
        c.call(this.len());
        c.localSet(LL);
        // Walk into the SHORTER child; push the other as the continuation.
        c.localGet(LL);
        c.localGet(N);
        c.structGet(this.ropeType, LEN);
        c.localGet(LL);
        c.i32Sub();
        c.i32LeU();
        c.ifVoid();
        {
          c.localGet(NODES);
          c.localGet(SP);
          c.localGet(N);
          c.structGet(this.ropeType, R);
          c.arraySet(nodesT);
          c.localGet(OFFS);
          c.localGet(SP);
          c.localGet(OFF);
          c.localGet(LL);
          c.i32Add();
          c.arraySet(offsT);
          c.localGet(N);
          c.structGet(this.ropeType, L);
          c.localSet(CUR);
        }
        c.else_();
        {
          c.localGet(NODES);
          c.localGet(SP);
          c.localGet(N);
          c.structGet(this.ropeType, L);
          c.arraySet(nodesT);
          c.localGet(OFFS);
          c.localGet(SP);
          c.localGet(OFF);
          c.arraySet(offsT);
          c.localGet(N);
          c.structGet(this.ropeType, R);
          c.localSet(CUR);
          c.localGet(OFF);
          c.localGet(LL);
          c.i32Add();
          c.localSet(OFF);
        }
        c.end();
        c.localGet(SP);
        c.i32Const(1);
        c.i32Add();
        c.localSet(SP);
        c.br(0); // $walk
      }
      c.end();
      c.end();
      c.end(); // $cache
      // Cache in place: first = flat, second = empty.
      c.localGet(P);
      c.localGet(D);
      c.structSet(this.ropeType, L);
      c.localGet(P);
      c.refNull(EQ_HEAP);
      c.structSet(this.ropeType, R);
      c.localGet(D);
      c.refAsNonNull();
      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.str.flatCat ($chars, $chars) → $chars — a concatenation read
   * flat on the spot (one copy, no node), with cat's length limit: one
   * past MAX_STRING_LENGTH sets the pending RangeError and answers a
   * dummy (the caller checks). */
  flatCat(): number {
    return this.cached("flatCat", () => {
      const sr = this.strRef(true);
      const idx = this.mb.declareFunc(this.mb.funcType([sr, sr], [sr]), "%w.str.flatCat");
      const c = new Code();
      c.localGet(0);
      c.arrayLen();
      c.localGet(1);
      c.arrayLen();
      c.i32Add();
      c.i32Const(MAX_STRING_LENGTH);
      c.i32GtU();
      c.ifVoid();
      c.call(this.tooLong());
      c.localGet(0);
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(1);
      c.call(this.flatConcat());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.cat (ref null eq, ref null eq) → (ref null eq) — the VALUE
   * concatenation `a + b`: an empty operand answers the other; a result
   * under CONS_MIN_LENGTH is a flat copy; one past MAX_STRING_LENGTH
   * sets the pending RangeError and answers a dummy (the caller checks);
   * otherwise a node, with short-tail merging. A null operand traps, as
   * the flat concat's array.len did. */
  cat(): number {
    return this.cached("cat", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([EQ_REF, EQ_REF], [EQ_REF]), "%w.str.cat");
      const A = 0;
      const B = 1;
      const LA = 2;
      const LB = 3;
      const N = 4;
      const AR = 5; // (ref null $rope)
      const T = 6; // eqref: the left node's right child
      const locals: ValType[] = [I32, I32, I32, { kind: "ref", nullable: true, typeIndex: this.ropeType }, EQ_REF];
      const c = new Code();
      // Fast path, two flat operands with a short result (most template
      // and message pieces): the flat copy, no calls but the copy's.
      c.localGet(A);
      c.refTest(this.strType);
      c.localGet(B);
      c.refTest(this.strType);
      c.i32And();
      c.ifVoid();
      c.localGet(A);
      c.castChars(this.strType, false);
      c.arrayLen();
      c.localGet(B);
      c.castChars(this.strType, false);
      c.arrayLen();
      c.i32Add();
      c.i32Const(CONS_MIN_LENGTH);
      c.i32LtU();
      c.ifVoid();
      c.localGet(A);
      c.castChars(this.strType, false);
      c.localGet(B);
      c.castChars(this.strType, false);
      c.call(this.flatConcat());
      c.return_();
      c.end();
      c.end();
      c.localGet(A);
      c.call(this.len());
      c.localSet(LA);
      c.localGet(B);
      c.call(this.len());
      c.localTee(LB);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(A);
      c.return_();
      c.end();
      c.localGet(LA);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(B);
      c.return_();
      c.end();
      c.localGet(LA);
      c.localGet(LB);
      c.i32Add();
      c.localTee(N);
      c.i32Const(MAX_STRING_LENGTH);
      c.i32GtU();
      c.ifVoid();
      c.call(this.tooLong());
      c.localGet(A);
      c.return_();
      c.end();
      c.localGet(N);
      c.i32Const(CONS_MIN_LENGTH);
      c.i32LtU();
      c.ifVoid();
      c.localGet(A);
      c.call(this.flat());
      c.localGet(B);
      c.call(this.flat());
      c.call(this.flatConcat());
      c.return_();
      c.end();
      // A flattened node stands for its cached array.
      const unwrap = (x: number): void => {
        c.localGet(x);
        c.refTest(this.ropeType);
        c.ifVoid();
        c.localGet(x);
        c.refCast(this.ropeType);
        c.structGet(this.ropeType, R);
        c.refIsNull();
        c.ifVoid();
        c.localGet(x);
        c.refCast(this.ropeType);
        c.structGet(this.ropeType, L);
        c.localSet(x);
        c.end();
        c.end();
      };
      unwrap(A);
      unwrap(B);
      // Short-tail merging: B flat and short, A a node whose right child
      // is flat and short together with B.
      c.localGet(B);
      c.refTest(this.strType);
      c.localGet(LB);
      c.i32Const(TAIL_MERGE_MAX);
      c.i32LeU();
      c.i32And();
      c.localGet(A);
      c.refTest(this.ropeType);
      c.i32And();
      c.ifVoid();
      {
        c.localGet(A);
        c.refCast(this.ropeType);
        c.localTee(AR);
        c.structGet(this.ropeType, R);
        c.localTee(T);
        c.refTest(this.strType);
        c.ifVoid();
        {
          c.localGet(T);
          c.castChars(this.strType, false);
          c.arrayLen();
          c.localGet(LB);
          c.i32Add();
          c.i32Const(TAIL_MERGE_MAX);
          c.i32LeU();
          c.ifVoid();
          c.localGet(N);
          c.localGet(AR);
          c.structGet(this.ropeType, L);
          c.localGet(T);
          c.castChars(this.strType, false);
          c.localGet(B);
          c.castChars(this.strType, false);
          c.call(this.flatConcat());
          c.structNew(this.ropeType);
          c.return_();
          c.end();
        }
        c.end();
      }
      c.end();
      // Short-head merging, the mirror image (prepends: `s = x + s`).
      c.localGet(A);
      c.refTest(this.strType);
      c.localGet(LA);
      c.i32Const(TAIL_MERGE_MAX);
      c.i32LeU();
      c.i32And();
      c.localGet(B);
      c.refTest(this.ropeType);
      c.i32And();
      c.ifVoid();
      {
        c.localGet(B);
        c.refCast(this.ropeType);
        c.localTee(AR);
        c.structGet(this.ropeType, L);
        c.localTee(T);
        c.refTest(this.strType);
        c.ifVoid();
        {
          c.localGet(T);
          c.castChars(this.strType, false);
          c.arrayLen();
          c.localGet(LA);
          c.i32Add();
          c.i32Const(TAIL_MERGE_MAX);
          c.i32LeU();
          c.ifVoid();
          c.localGet(N);
          c.localGet(A);
          c.castChars(this.strType, false);
          c.localGet(T);
          c.castChars(this.strType, false);
          c.call(this.flatConcat());
          c.localGet(AR);
          c.structGet(this.ropeType, R);
          c.structNew(this.ropeType);
          c.return_();
          c.end();
        }
        c.end();
      }
      c.end();
      c.localGet(N);
      c.localGet(A);
      c.localGet(B);
      c.structNew(this.ropeType);
      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }
}
