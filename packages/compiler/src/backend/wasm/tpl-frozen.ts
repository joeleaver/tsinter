/* SEMANTICS.md S080: the write surface of a tag call's FROZEN strings
 * array and of its frozen `raw` array (a `$dynTpl` box, dyn.ts tplT).
 * Both arrays are frozen in Node, so every [[Set]] onto them fails; strict
 * code (every module, and Object.assign whatever the caller's mode) throws
 * Node's TypeError:
 *
 *  - an existing element, `length`, or the strings array's `raw`:
 *    "Cannot assign to read only property 'k' of object '[object Array]'";
 *  - any other key, a symbol key included (rendered `Symbol(desc)`):
 *    "Cannot add property k, object is not extensible".
 *
 * Present only where the module builds such an array (DynDeps.tpl, the
 * tplLive gate), so every other module is byte-identical. */
import type { DynBuilder } from "./dyn.js";
import { DK, DYN_KIND, DYN_REF } from "./dyn.js";
import { Code } from "./code.js";
import { emitFlatCast } from "./strings.js";
import { I32, type ValType } from "./module.js";

/** `$dynTpl`'s `raw` field: the strings array's raw companion, the
 * `undefined` immortal on the raw array itself. */
const TPL_RAW = 3;

export class TplFrozen {
  constructor(private readonly d: DynBuilder) {}

  private get k() {
    return this.d.omKit();
  }

  private strRef(): ValType {
    return this.k.deps.strRef();
  }

  /** A strict-mode write `d[k] = v` (locals 0 and 1 of a void helper)
   * into either frozen array throws Node's TypeError and returns. Emitted
   * inline at the head of the keyed write helpers. */
  writeGuard(c: Code): void {
    c.localGet(0);
    c.refTest(this.d.tplT());
    c.ifVoid();
    c.localGet(0);
    c.localGet(1);
    c.call(this.writeError());
    c.return_();
    c.end();
  }

  /** %w.tpl.writeError(arr, key) — throws the TypeError a [[Set]] of
   * `key` onto the frozen array `arr` fails with (strict mode). */
  private writeError(): number {
    return this.k.cached("tpl.writeError", [this.d.dynRef(), this.strRef()], [], (idx) => {
      const deps = this.k.deps;
      const concat = deps.concat();
      const tplT = this.d.tplT();
      const c = new Code();
      deps.throwTypeError(c, (x) => {
        // read-only: `length`, an existing element, the strings array's raw
        x.localGet(1);
        deps.lit(x, "length");
        x.call(deps.strEq());
        x.localGet(1);
        x.call(this.d.canonIdx());
        this.d.arrLen(x, (y) => this.d.arrPayload(y, (z) => z.localGet(0)));
        x.i32LtU();
        x.i32Or();
        x.localGet(1);
        deps.lit(x, "raw");
        x.call(deps.strEq());
        x.localGet(0);
        x.refCast(tplT);
        x.structGet(tplT, TPL_RAW);
        x.globalGet(this.d.undefinedGlobal());
        x.refEq();
        x.i32Eqz();
        x.i32And();
        x.i32Or();
        x.ifResult(this.strRef());
        deps.lit(x, "Cannot assign to read only property '");
        x.localGet(1);
        x.call(concat);
        deps.lit(x, "' of object '[object Array]'");
        x.call(concat);
        x.else_();
        deps.lit(x, "Cannot add property ");
        this.pushKeyText(x, 1);
        x.call(concat);
        deps.lit(x, ", object is not extensible");
        x.call(concat);
        x.end();
      });
      this.k.mb.setBody(idx, [], c.bytes());
    });
  }

  /** Push key local `k` as V8's error messages spell it: a symbol's
   * reserved key as `Symbol(desc)`, any other key as itself. */
  private pushKeyText(c: Code, k: number): void {
    if (!this.d.symLive) {
      c.localGet(k);
      return;
    }
    c.localGet(k);
    c.call(this.d.reservedKey());
    c.ifResult(this.strRef());
    c.localGet(k);
    c.call(this.d.symKeyText());
    c.else_();
    c.localGet(k);
    c.end();
  }

  /** %w.tpl.assignOnto(arr, src) → arr, or null with the error pending —
   * `Object.assign(arr, src)` onto either frozen array. A nullish source
   * is skipped and a source with no own enumerable key copies nothing
   * (the target comes back); otherwise the source's FIRST own enumerable
   * key in OrdinaryOwnPropertyKeys order (the string keys, then the
   * symbol keys) is read — one [[Get]], a getter runs once — and that
   * key's [[Set]] throws. An error's encoding is listed as its user view
   * (errUserView), so only its own enumerable fields count. */
  assignOnto(): number {
    const dynRef = this.d.dynRef();
    return this.k.cached("tpl.assignOnto", [dynRef, dynRef], [dynRef], (idx) => {
      const d = this.d;
      const dynT = d.dynT();
      const c = new Code();
      const K = 2;
      const KEYS = 3;
      const KEY = 4;
      const V = 5;
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.localTee(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.localGet(0);
      c.return_();
      c.end();
      d.typedArm(c, 1, K, () => d.typedFence(c, "copying the members of", (x) => x.refNull(dynT)));
      // GH #193: an error's encoding is walked as its user view, as the
      // plain-target copy walks it (dyn.ts assignRaw) — its `%error`
      // marker and its name/message/code/stack entries are not keys Node
      // lists, so an Error source with no own enumerable key copies
      // nothing and one with an expando fails on that expando.
      c.localGet(K);
      c.i32Const(DK.OBJ);
      c.i32Eq();
      c.ifVoid();
      d.boxObj(c, (x) => {
        d.objPayload(x, (y) => y.localGet(1));
        x.call(d.errUserView());
      });
      c.localSet(1);
      c.end();
      c.localGet(1);
      c.i32Const(d.symLive ? 8 : 0); // KEYS, with the symbol keys after the string keys
      c.call(d.objWalk());
      c.localTee(KEYS);
      c.refIsNull();
      c.ifVoid();
      c.refNull(dynT);
      c.return_();
      c.end();
      d.arrLen(c, (x) => d.arrPayload(x, (y) => y.localGet(KEYS)));
      c.i32Eqz();
      c.ifVoid();
      c.localGet(0);
      c.return_();
      c.end();
      d.arrAt(c, (x) => d.arrPayload(x, (y) => y.localGet(KEYS)), (x) => x.i32Const(0));
      c.structGet(dynT, DYN_REF);
      emitFlatCast(c, this.k.deps.strType());
      c.localSet(KEY);
      c.localGet(1);
      c.localGet(KEY);
      c.i32Const(0);
      c.call(d.keyGet());
      c.localSet(V);
      c.globalGet(this.k.deps.excKind());
      c.ifVoid();
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(KEY);
      c.localGet(V);
      c.call(d.keySet());
      c.refNull(dynT);
      this.k.mb.setBody(idx, [I32, dynRef, this.strRef(), dynRef], c.bytes());
    });
  }
}
