/* Array and typed-array sorting on the WasmGC tier (wasm and wasm-native, one
 * routine): V8's TimSort and typed-array merge sort, compiled from timsort-src.ts by
 * the C-subset compiler, so a comparator sees exactly the calls Node makes. One
 * instance per element representation and comparator kind (the same way vectors are
 * per element type); an instance pulls in only the functions it reaches.
 *
 * This file is the seam between that text and the module: the instances, and the
 * drivers that take a vector or a typed array's elements into a work array and back.
 * The element-specific pieces — the compare and classify functions — come from the
 * emitter (static arrays) and dyn.ts (dynamic ones). */

import { Code } from "./code.js";
import { CCompiler, parseC, type CUnit } from "./csubset.js";
import { F64, I32, type ModuleBuilder, type ValType } from "./module.js";
import { BUF, LEN, type VecInfo } from "./arrays.js";
import { TIMSORT_C } from "./timsort-src.js";

/** What one instance is built over. */
export interface SortInstance {
  /** names the wasm functions; one instance per key */
  key: string;
  elem: ValType;
  arrayType: number;
  packed: boolean;
  ctx: ValType;
  /** (ctx, x, y) → f64, the comparison's Number; an exception stays pending */
  compare: number;
  /** (x) → i32: 0 an element, 1 undefined, 2 a hole. Typed arrays' instances have
   * nothing to classify and never reach it. */
  classify: number;
}

let parsed: CUnit | null = null;

function unit(): CUnit {
  parsed ??= parseC(TIMSORT_C, {});
  return parsed;
}

export class ArraySort {
  private readonly instances = new Map<string, CCompiler>();
  private readonly drivers = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly excKindGlobal: () => number,
  ) {}

  /** The instance for `s`. compare and classify may be declared but not yet given
   * bodies, so a compare function can itself call into its instance. */
  instance(s: SortInstance): CCompiler {
    let cc = this.instances.get(s.key);
    if (cc === undefined) {
      cc = new CCompiler(this.mb, unit(), `%w.sort.${s.key}.`, {
        elem: s.elem.kind === "ref" ? { ...s.elem, nullable: true } : s.elem,
        arrayType: s.arrayType,
        packed: s.packed,
        ctx: s.ctx,
        externs: {
          sort_compare: { params: ["ctx", "el", "el"], ret: "double", index: s.compare },
          elem_class: { params: ["el"], ret: "int", index: s.classify },
        },
        excKindGlobal: this.excKindGlobal(),
      });
      this.instances.set(s.key, cc);
    }
    return cc;
  }

  private plain: CCompiler | null = null;

  /** The (x, y) → i32 SmiLexicographicCompare, which no instance's types touch. */
  smiCompare(): number {
    this.plain ??= new CCompiler(this.mb, unit(), "%w.sort.");
    return this.plain.fn("SmiLexicographicCompare");
  }

  private driver(name: string, build: () => number): number {
    const got = this.drivers.get(name);
    if (got !== undefined) return got;
    const idx = build();
    this.drivers.set(name, idx);
    return idx;
  }

  /** %w.sort.<key>.vecSort(vec, ctx) → i32: Array.prototype.sort. 0 when a comparison
   * threw (the exception pending, the vector untouched: V8 sorts a work array and
   * writes back only when it finished), else 1. The write-back is
   * CopyWorkArrayToReceiver's over whatever the receiver has become: it STORES the
   * sorted elements and the undefineds, so what a comparator removed comes back and
   * what it added past n stays, and DELETES the holes' indices, which never extends
   * the array. */
  vecSort(s: SortInstance, v: VecInfo, pushUndef: (c: Code) => void, pushHole: (c: Code) => void): number {
    return this.driver(`${s.key}:vecSort`, () => {
      const cc = this.instance(s);
      const vecRef: ValType = { kind: "ref", nullable: true, typeIndex: v.struct };
      const bufRef: ValType = { kind: "ref", nullable: true, typeIndex: v.bufType };
      const iaRef: ValType = { kind: "ref", nullable: true, typeIndex: cc.ia };
      const idx = this.mb.declareFunc(this.mb.funcType([vecRef, s.ctx], [I32]), `%w.sort.${s.key}.vecSort`);
      const sortFn = cc.fn("ArrayTimSort");
      const c = new Code();
      const VEC = 0;
      const CTX = 1;
      const N = 2;
      const WORK = 3;
      const COUNTS = 4;
      const K = 5;
      const B = 6;
      const NB = 7;
      const I = 8;
      const END = 9;
      const HOLES_END = 10;
      c.localGet(VEC);
      c.structGet(v.struct, LEN);
      c.localTee(N);
      c.i32Const(2);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(N);
      c.arrayNewDefault(v.bufType);
      c.localSet(WORK);
      c.i32Const(2);
      c.arrayNewDefault(cc.ia);
      c.localSet(COUNTS);
      c.localGet(CTX);
      c.localGet(VEC);
      c.structGet(v.struct, BUF);
      c.localGet(N);
      c.localGet(WORK);
      c.localGet(COUNTS);
      c.call(sortFn);
      c.localTee(K);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      // The receiver may have shrunk, and its buffer with it.
      c.localGet(VEC);
      c.structGet(v.struct, BUF);
      c.localTee(B);
      c.arrayLen();
      c.localGet(N);
      c.i32LtS();
      c.ifVoid();
      c.localGet(N);
      c.arrayNewDefault(v.bufType);
      c.localTee(NB);
      c.i32Const(0);
      c.localGet(B);
      c.i32Const(0);
      c.localGet(VEC);
      c.structGet(v.struct, LEN);
      c.arrayCopy(v.bufType, v.bufType);
      c.localGet(VEC);
      c.localGet(NB);
      c.refAsNonNull();
      c.structSet(v.struct, BUF);
      c.localGet(NB);
      c.localSet(B);
      c.end();
      c.localGet(B);
      c.i32Const(0);
      c.localGet(WORK);
      c.i32Const(0);
      c.localGet(K);
      c.arrayCopy(v.bufType, v.bufType);
      // i = k; end = k + undefineds
      c.localGet(K);
      c.localSet(I);
      c.localGet(K);
      c.localGet(COUNTS);
      c.i32Const(0);
      c.arrayGet(cc.ia);
      c.i32Add();
      c.localSet(END);
      const fill = (limit: number, push: (c: Code) => void): void => {
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(limit);
        c.i32GeS();
        c.brIf(1);
        c.localGet(B);
        c.localGet(I);
        push(c);
        c.arraySet(v.bufType);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
      };
      fill(END, pushUndef);
      // The stores reach END; a shorter receiver grows to exactly there.
      c.localGet(VEC);
      c.structGet(v.struct, LEN);
      c.localGet(END);
      c.i32LtS();
      c.ifVoid();
      c.localGet(VEC);
      c.localGet(END);
      c.structSet(v.struct, LEN);
      c.end();
      // Holes within [END, min(n, length)).
      c.localGet(N);
      c.localGet(VEC);
      c.structGet(v.struct, LEN);
      c.localGet(N);
      c.localGet(VEC);
      c.structGet(v.struct, LEN);
      c.i32LtS();
      c.select();
      c.localSet(HOLES_END);
      fill(HOLES_END, pushHole);
      c.i32Const(1);
      this.mb.setBody(idx, [I32, bufRef, iaRef, I32, bufRef, bufRef, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.sort.<key>.vecToSorted(vec, ctx) → a fresh vec, null when a comparison threw:
   * ArrayTimSortIntoCopy. A hole reads as undefined here, as there. */
  vecToSorted(s: SortInstance, v: VecInfo, pushUndef: (c: Code) => void): number {
    return this.driver(`${s.key}:vecToSorted`, () => {
      const cc = this.instance(s);
      const vecRef: ValType = { kind: "ref", nullable: true, typeIndex: v.struct };
      const bufRef: ValType = { kind: "ref", nullable: true, typeIndex: v.bufType };
      const iaRef: ValType = { kind: "ref", nullable: true, typeIndex: cc.ia };
      const idx = this.mb.declareFunc(this.mb.funcType([vecRef, s.ctx], [vecRef]), `%w.sort.${s.key}.vecToSorted`);
      const sortFn = cc.fn("ArrayTimSort");
      const c = new Code();
      const VEC = 0;
      const CTX = 1;
      const N = 2;
      const WORK = 3;
      const COUNTS = 4;
      const I = 5;
      c.localGet(VEC);
      c.structGet(v.struct, LEN);
      c.localTee(N);
      c.arrayNewDefault(v.bufType);
      c.localSet(WORK);
      c.i32Const(2);
      c.arrayNewDefault(cc.ia);
      c.localSet(COUNTS);
      c.localGet(CTX);
      c.localGet(VEC);
      c.structGet(v.struct, BUF);
      c.localGet(N);
      c.localGet(WORK);
      c.localGet(COUNTS);
      c.call(sortFn);
      c.localTee(I);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.refNull(v.struct);
      c.return_();
      c.end();
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(WORK);
      c.localGet(I);
      pushUndef(c);
      c.arraySet(v.bufType);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(N);
      c.localGet(WORK);
      c.refAsNonNull();
      c.structNew(v.struct);
      this.mb.setBody(idx, [I32, bufRef, iaRef, I32], c.bytes());
      return idx;
    });
  }

  /** %w.sort.<key>.vecTypedSort(vec, ctx) → i32 over a typed array's elements as
   * numbers, in place (0 when a comparison threw, the vector untouched). With a
   * comparator, TypedArraySortCommon's two work arrays and merge sort; without, any
   * sort answers the one order the default has (nothing observes the comparisons),
   * and this is the instance's TimSort. */
  vecTypedSort(s: SortInstance, v: VecInfo, hasComparator: boolean): number {
    return this.driver(`${s.key}:vecTypedSort`, () => {
      const cc = this.instance(s);
      const vecRef: ValType = { kind: "ref", nullable: true, typeIndex: v.struct };
      const bufRef: ValType = { kind: "ref", nullable: true, typeIndex: v.bufType };
      const idx = this.mb.declareFunc(this.mb.funcType([vecRef, s.ctx], [I32]), `%w.sort.${s.key}.vecTypedSort`);
      const mergeSort = hasComparator ? cc.fn("TypedArrayMergeSort") : cc.fn("ArrayTimSortImpl");
      const c = new Code();
      const VEC = 0;
      const CTX = 1;
      const N = 2;
      const WORK1 = 3;
      const WORK2 = 4;
      c.localGet(VEC);
      c.structGet(v.struct, LEN);
      c.localTee(N);
      c.i32Const(2);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      const copyOf = (into: number): void => {
        c.localGet(N);
        c.arrayNewDefault(v.bufType);
        c.localTee(into);
        c.i32Const(0);
        c.localGet(VEC);
        c.structGet(v.struct, BUF);
        c.i32Const(0);
        c.localGet(N);
        c.arrayCopy(v.bufType, v.bufType);
      };
      copyOf(WORK1);
      if (hasComparator) {
        copyOf(WORK2);
        c.localGet(CTX);
        c.localGet(WORK2);
        c.i32Const(0);
        c.localGet(N);
        c.localGet(WORK1);
        c.call(mergeSort);
      } else {
        c.localGet(CTX);
        c.localGet(WORK1);
        c.localGet(N);
        c.call(mergeSort);
      }
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(VEC);
      c.structGet(v.struct, BUF);
      c.i32Const(0);
      c.localGet(WORK1);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(v.bufType, v.bufType);
      c.i32Const(1);
      this.mb.setBody(idx, [I32, bufRef, bufRef], c.bytes());
      return idx;
    });
  }
}

/** Pushes f64: the default order of the two numbers in f64 locals X and Y (XI and YI
 * are i32 scratch). SortCompareDefault: two integers compare through their digits
 * without being spelled, anything else as the strings ToString makes of them. */
export function emitNumberCompareDefault(
  c: Code,
  X: number,
  Y: number,
  XI: number,
  YI: number,
  smiCompare: number,
  f64ToStr: () => number,
  strCmpU16: () => number,
): void {
  c.localGet(X);
  c.i32TruncSatF64S();
  c.localTee(XI);
  c.f64ConvertI32S();
  c.localGet(X);
  c.f64Eq();
  c.localGet(Y);
  c.i32TruncSatF64S();
  c.localTee(YI);
  c.f64ConvertI32S();
  c.localGet(Y);
  c.f64Eq();
  c.i32And();
  // both within (-2^30, 2^30)
  c.localGet(XI);
  c.i32Const(0x3fffffff);
  c.i32Add();
  c.i32Const(0x7fffffff);
  c.i32LtU();
  c.i32And();
  c.localGet(YI);
  c.i32Const(0x3fffffff);
  c.i32Add();
  c.i32Const(0x7fffffff);
  c.i32LtU();
  c.i32And();
  c.ifResult(F64);
  c.localGet(XI);
  c.localGet(YI);
  c.call(smiCompare);
  c.f64ConvertI32S();
  c.else_();
  c.localGet(X);
  c.call(f64ToStr());
  c.localGet(Y);
  c.call(f64ToStr());
  c.call(strCmpU16());
  c.f64ConvertI32S();
  c.end();
}
