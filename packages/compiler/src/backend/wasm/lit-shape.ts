/* U8c: object literals built on their final shape
 * (docs/design/u8-dynamic-speed.md §4, "Object literals").
 *
 * A dynamic object literal whose keys are all compile-time strings
 * (`{ a: x, b: y }`, the IR's dynObjLit with string-literal keys) gets a
 * site: the FINAL shape its key sequence reaches from the root, and each
 * key's canonical string (the very string the shape node holds), in
 * globals that start null.
 *
 * The values evaluate first, in source order, into locals (the object is
 * unreachable until the literal completes, so building it after its values
 * is the same object). Then:
 *
 *   - with the site filled, the payload is built whole: one entries array
 *     of exactly the literal's entries, each keyed by its canonical
 *     string, its length, and the final shape. No scan for duplicates and
 *     no transition walk;
 *   - otherwise the literal builds as before, one objPut per key in source
 *     order (later duplicates win), and the site fills when the object
 *     came out shaped with exactly one entry per key: then the key
 *     sequence is distinct, admissible for a shape and under the caps, and
 *     since a transition tree only grows, every later build reaches the
 *     same final shape by the same appends. A duplicate key, a reserved
 *     key, a `__proto__` that set the prototype, or a cap leaves the site
 *     unfilled for good, building as before.
 *
 * A value that is an accessor cell (where accessors are live; no literal
 * value is one, but the in-place writers guard it too) builds as before.
 * Getters of a literal (`get g() {}`) are defined after it builds, through
 * the object model's writers, which drop the shape (shapes.ts).
 *
 * SCRIPTC_WASM_SHAPE_CHECK=1 checks the promise of every object built on
 * the cached shape (ic-check.ts). */
import type { DynBuilder } from "./dyn.js";
import { DK, DYN_KIND, OBJ_ENTRIES, OBJ_LEN } from "./dyn.js";
import { Code } from "./code.js";
import { IcCheck, shapeCheckOn } from "./ic-check.js";
import { countLitHit } from "./ic-stats.js";
import type { IcLocals } from "./ic-read.js";
import { I32 } from "./module.js";
import { SHAPE_COUNT, SHAPE_KEY, SHAPE_MAX_KEYS, SHAPE_PARENT } from "./shapes.js";

export interface LitShapeDeps {
  /** Push the pooled literal `value` onto `c`. */
  pushStrLit: (c: Code, value: string) => void;
}

/** May a literal with these keys take a site? At least one key, and no
 * more than a shape holds. (Duplicates and reserved keys are found when
 * the site would fill: the first build's shape tells.) */
export function litShapeable(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.length <= SHAPE_MAX_KEYS;
}

export class LitShape {
  private readonly check = shapeCheckOn();
  private readonly checks: IcCheck;

  constructor(
    private readonly d: DynBuilder,
    private readonly deps: LitShapeDeps,
  ) {
    this.checks = new IcCheck(d);
  }

  private get k() {
    return this.d.shapesKit();
  }

  /** The literal `{ keys[0]: value 0, ... }`: `pushValue(c, i)` pushes the
   * i-th value box, in source order. Leaves the new payload in local `o`
   * (objRef()). */
  emit(c: Code, keys: readonly string[], pushValue: (c: Code, i: number) => void, o: number, locals: IcLocals): void {
    const mb = this.k.mb;
    const S = this.d.shapes.shapeT();
    const objT = this.d.objT();
    const n = keys.length;
    const finalG = mb.addGlobal(this.d.shapes.shapeRef(), true, (w) => {
      w.u8(0xd0); // ref.null $shape
      w.sleb(S);
    });
    const strT = this.k.deps.strType();
    const keyG = keys.map(() =>
      mb.addGlobal(this.k.deps.strRef(), true, (w) => {
        w.u8(0xd0); // ref.null $str
        w.sleb(strT);
      }),
    );
    const dynRef = this.d.dynRef();
    const v = keys.map(() => locals.get(dynRef));
    keys.forEach((_, i) => {
      pushValue(c, i);
      c.localSet(v[i]!);
    });
    c.globalGet(finalG);
    c.refIsNull();
    if (this.d.accessorsLive) {
      for (const x of v) {
        c.localGet(x);
        c.structGet(this.d.dynT(), DYN_KIND);
        c.i32Const(DK.JSVAL);
        c.i32Eq();
        c.i32Or();
      }
    }
    c.ifVoid();
    // as before: one objPut per key, then the fill
    this.d.pushNewObj(c, false);
    c.localSet(o);
    keys.forEach((key, i) => {
      c.localGet(o);
      this.deps.pushStrLit(c, key);
      c.localGet(v[i]!);
      c.call(this.d.objPut());
    });
    const node = locals.get(this.d.shapes.shapeRef());
    c.localGet(o);
    c.structGet(objT, this.d.objShapeField());
    c.localTee(node);
    c.refIsNull();
    c.ifResult(I32);
    c.i32Const(0);
    c.else_();
    c.localGet(node);
    c.structGet(S, SHAPE_COUNT);
    c.i32Const(n);
    c.i32Eq();
    c.localGet(o);
    c.structGet(objT, OBJ_LEN);
    c.i32Const(n);
    c.i32Eq();
    c.i32And();
    c.end();
    c.ifVoid();
    c.localGet(node);
    c.globalSet(finalG);
    for (let i = n - 1; i >= 0; i--) {
      c.localGet(node);
      c.structGet(S, SHAPE_KEY);
      c.globalSet(keyG[i]!);
      if (i > 0) {
        c.localGet(node);
        c.structGet(S, SHAPE_PARENT);
        c.localSet(node);
      }
    }
    c.end();
    c.else_();
    // on the final shape: the whole table at once
    this.d.pushNewObj(c, false);
    c.localTee(o);
    keys.forEach((_, i) => {
      c.globalGet(keyG[i]!);
      c.localGet(v[i]!);
      c.structNew(this.d.entryT());
    });
    c.arrayNewFixed(this.d.entriesArrayType(), n);
    c.structSet(objT, OBJ_ENTRIES);
    c.localGet(o);
    c.i32Const(n);
    c.structSet(objT, OBJ_LEN);
    c.localGet(o);
    c.globalGet(finalG);
    c.structSet(objT, this.d.objShapeField());
    if (this.check) {
      c.localGet(o);
      c.call(this.checks.promiseFn());
    }
    countLitHit(c);
    c.end();
    locals.put?.(this.d.shapes.shapeRef(), node);
    for (let i = n - 1; i >= 0; i--) locals.put?.(dynRef, v[i]!);
  }
}
