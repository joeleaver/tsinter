/* U8c: interned small-integer boxes (docs/design/u8-dynamic-speed.md §4,
 * "Where the boxing goes away": writes).
 *
 * A typed number written into a dynamic object (`p.a = i`, a literal's
 * `{ n: i }`) needs a `$dyn` box, because entries hold boxes. The integers
 * 0..INTERN_MAX - 1 share one box each, made the first time it is needed
 * and kept in a table for the program's lifetime, as `true` and `false`
 * already are. A value is interned only when its bits are exactly those of
 * that integer, so -0 (whose bits differ from 0's) and every non-integer
 * get a fresh box.
 *
 * In a module whose number slots can hold undefined (SEMANTICS.md S119,
 * Unit U), a value that may be a slot's undefined boxes through the
 * caller's fallback helper (dynFrom's, which tests for it) whenever it is
 * not an interned integer; the sentinel's bits are no integer's.
 *
 * A number LITERAL written so (`p.d = 1`, `{ k: 2.5 }`) takes a box made
 * by its own immutable global's constant initializer, one per distinct
 * value (by bits) in the module: no call and no allocation at run time.
 *
 * Not observable: strict equality, Object.is, SameValueZero and every
 * reader compare a NUM box by its value, never by identity (dyn.ts
 * header), and a box is immutable. */
import type { DynBuilder } from "./dyn.js";
import { DK } from "./dyn.js";
import { Code } from "./code.js";
import { F64, I32 } from "./module.js";

/** The `eq` heap type (a box's null `ref`), as dyn.ts spells it. */
const EQ_HEAP = -0x13;

/** The integers that share a box: 0 .. INTERN_MAX - 1. */
export const INTERN_MAX = 1024;

export class BoxIntern {
  private tableG: number | null = null;
  private readonly consts = new Map<bigint, number>();
  private tableType: number | null = null;

  constructor(private readonly d: DynBuilder) {}

  private get k() {
    return this.d.shapesKit();
  }

  /** The table type: a mutable array of nullable boxes. */
  private tableT(): number {
    this.tableType ??= this.k.mb.arrayType(this.d.dynRef(), true);
    return this.tableType;
  }

  /** The table: INTERN_MAX empty slots, made by the global's constant
   * initializer (nothing runs at start-up). */
  private table(): number {
    if (this.tableG !== null) return this.tableG;
    const t = this.tableT();
    this.tableG = this.k.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: t }, false, (w) => {
      w.u8(0x41); // i32.const INTERN_MAX
      w.sleb(INTERN_MAX);
      w.u8(0xfb); // array.new_default $table
      w.uleb(0x07);
      w.uleb(t);
    });
    return this.tableG;
  }

  /** Push the box of the number literal `v`: its constant global. */
  boxConst(c: Code, v: number): void {
    const bits = new BigUint64Array(new Float64Array([v]).buffer)[0]!;
    let g = this.consts.get(bits);
    if (g === undefined) {
      const dynT = this.d.dynT();
      g = this.k.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: dynT }, false, (w) => {
        w.u8(0x41); // i32.const NUM
        w.sleb(DK.NUM);
        w.u8(0x44); // f64.const v
        w.f64(v);
        w.u8(0xd0); // ref.null eq
        w.sleb(EQ_HEAP);
        w.u8(0xfb); // struct.new $dyn
        w.uleb(0x00);
        w.uleb(dynT);
      });
      this.consts.set(bits, g);
    }
    c.globalGet(g);
  }

  /** Box the f64 the caller pushes, sharing the box of a small integer.
   * `fallback`, when given, is the helper (f64) → box that boxes every
   * other value (a slot-undefined-aware one); else a plain NUM box. */
  boxNum(c: Code, pushValue: (c: Code) => void, fallback: number | null = null): void {
    pushValue(c);
    c.call(this.fn(fallback));
  }

  /** %w.dyn.boxNumI[:fallback](v) → the box of v: the table's for an
   * integer in 0..INTERN_MAX - 1 (made on first use), else the fallback's
   * (or a fresh NUM box). */
  private fn(fallback: number | null): number {
    const dynRef = this.d.dynRef();
    const name = fallback === null ? "boxNumI" : `boxNumI:${fallback}`;
    return this.k.cached(name, [F64], [dynRef], (idx) => {
      const c = new Code();
      const I = 1;
      const B = 2;
      const t = this.tableT();
      // a negative value truncates below 0, which the unsigned compare
      // puts past the table; NaN truncates to 0, whose bits differ
      c.localGet(0);
      c.i32TruncSatF64S();
      c.localTee(I);
      c.i32Const(INTERN_MAX);
      c.i32LtU();
      c.ifVoid();
      c.localGet(I);
      c.f64ConvertI32U();
      c.i64ReinterpretF64();
      c.localGet(0);
      c.i64ReinterpretF64();
      c.i64Eq();
      c.ifVoid();
      c.globalGet(this.table());
      c.localGet(I);
      c.arrayGet(t);
      c.localTee(B);
      c.refIsNull();
      c.ifVoid();
      this.d.boxNum(c, (x) => x.localGet(0));
      c.localSet(B);
      c.globalGet(this.table());
      c.localGet(I);
      c.localGet(B);
      c.arraySet(t);
      c.end();
      c.localGet(B);
      c.return_();
      c.end();
      c.end();
      if (fallback === null) this.d.boxNum(c, (x) => x.localGet(0));
      else {
        c.localGet(0);
        c.call(fallback);
      }
      this.k.mb.setBody(idx, [I32, dynRef], c.bytes());
    });
  }
}
