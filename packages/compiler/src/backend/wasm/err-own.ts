/* Which of an error's `name`, `message` and `code` are OWN ENUMERABLE
 * properties, as Node would list them (GH #193; SEMANTICS.md S080, S138).
 *
 * The error encoding (dyn.ts fromError) stores `name`, `message` and a
 * stamped `code` as ordinary entries, and a program's key listing or
 * Object.assign walks it as its user view (dyn.ts errUserView), which
 * hides them: in Node `name` lives on the prototype, a constructor-given
 * `message` and V8's `stack` are own but non-enumerable, and the runtime's
 * stamped `code` is the runtime's. What a PROGRAM does to them changes
 * that, and this module records it:
 *
 *  - a write of `name` from outside a class that owns it makes it own and
 *    enumerable where it is first written: a marker entry (ERR_OWN_NAME)
 *    in the encoding records the place, and the user view lists `name`
 *    there with the slot's current value (nameWritten);
 *  - a write of `message` keeps it non-enumerable when the error already
 *    had one, and makes an own enumerable one when it had none. The slot
 *    holds "" for both an absent message and a present empty one, so a
 *    write over a non-empty slot changes nothing listed, and a write over
 *    "" leaves a marker (ERR_MSG_UNSURE) where the user view stops by name
 *    (messageWriting);
 *  - a `code` the program writes is an ordinary entry, listed in its
 *    place; only the stamped one (and a DOMException's derived one, a
 *    prototype getter in Node) stays hidden (codeHidden).
 *
 * An error that has not crossed yet keeps no encoding for a marker: the
 * write leaves a PENDING sentinel in the error's encoding slot instead (a
 * shared immutable struct per marker set, never an allocation per error),
 * and the first crossing (dyn.ts fromError) places the pending markers
 * last, which is where a marker built then would have stood: nothing else
 * is in the encoding until it exists. An error whose class the encoding
 * mirrors (GH #191) still builds at the write, since its view's keys are
 * placed when the encoding is built. An instance the crossing would stop
 * on (S138 errStopTest), or whose class sets its own name (errNameTest:
 * its listings stop by name), needs none.
 *
 * JSON.stringify of an encoding walks its entries itself (json.ts
 * putDyn): jsonEntry turns the own-name marker into the `name` member in
 * its place and stops by name at the message marker. */
import type { DynBuilder } from "./dyn.js";
import { DYN_REF, ENTRY_KEY } from "./dyn.js";
import { Code } from "./code.js";
import { emitFlatCast } from "./strings.js";
import { I32, type ValType } from "./module.js";
import { ERR_MSG_UNSURE, ERR_OWN_NAME, ERRV_PROBE } from "../../ir/nodes.js";

/** The pending-marker bits a sentinel carries (ErrOwnKeys.pendingT). */
const PEND_NAME = 1;
const PEND_MSG = 2;

/** An eqref local: the error's encoding slot as read (EQ_HEAP is the
 * abstract `eq` heap type's code). */
const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/** The stop for a `message` written over "" (ERR_MSG_UNSURE), named for
 * the walk that reached it. */
function msgUnsureText(what: string): string {
  return `${what} of an error held in a dynamic value whose 'message' was written while it was empty (whether Node lists it depends on whether the error was constructed with a message, which this build does not record) is not supported yet (SEMANTICS.md S080)`;
}

export class ErrOwnKeys {
  constructor(private readonly d: DynBuilder) {}

  private pendingType: number | null = null;
  private readonly pendingGlobals = new Map<number, number>();

  private get k() {
    return this.d.omKit();
  }

  private errRef() {
    return { kind: "ref" as const, nullable: true, typeIndex: this.k.deps.errT() };
  }

  /** Returns from the helper being built (local 0: the error) when the
   * error needs no marker: an S138-stopped instance never lists. */
  private returnIfStopped(c: Code): void {
    const stop = this.k.deps.errStopTest;
    if (stop === undefined) return;
    stop(c, (x) => x.localGet(0));
    c.ifVoid();
    c.return_();
    c.end();
  }

  /** `kind(err, key)` of GH #191's mirror (f64) against `want`, leaving
   * the i32 `kind != want`; only called where the mirror exists. */
  private viewKindNe(c: Code, key: string, want: number): void {
    const view = this.k.deps.errView!;
    view(c, "kind", (x) => {
      x.localGet(0);
      this.k.deps.lit(x, key);
    });
    c.f64Const(want);
    c.f64Ne();
  }

  /** The pending sentinel's type: `{ bits: i32 }`, the markers the
   * error's first crossing places (PEND_NAME, PEND_MSG). Never a dyn
   * value, so the slot's readers tell it from an encoding by type. */
  pendingT(): number {
    this.pendingType ??= this.k.mb.openStructType("err:pending", [{ storage: I32, mutable: false }]);
    return this.pendingType;
  }

  private pendingRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.pendingT() };
  }

  /** %w.dyn.errPending(bits) → the one shared sentinel for marker set
   * `bits` (1..3), built on its first use. */
  private pendingOf(): number {
    return this.k.cached("errPending", [I32], [this.pendingRef()], (idx) => {
      const T = this.pendingT();
      const c = new Code();
      for (const bits of [PEND_NAME, PEND_MSG, PEND_NAME | PEND_MSG]) {
        let g = this.pendingGlobals.get(bits);
        if (g === undefined) {
          g = this.k.mb.addGlobal(this.pendingRef(), true, (w) => {
            w.u8(0xd0);
            w.sleb(T);
          });
          this.pendingGlobals.set(bits, g);
        }
        c.localGet(0);
        c.i32Const(bits);
        c.i32Eq();
        c.ifVoid();
        c.globalGet(g);
        c.refIsNull();
        c.ifVoid();
        c.i32Const(bits);
        c.structNew(T);
        c.globalSet(g);
        c.end();
        c.globalGet(g);
        c.return_();
        c.end();
      }
      c.unreachable();
      this.k.mb.setBody(idx, [], c.bytes());
    });
  }

  /** Puts marker `key` (the value `true`) into the error's encoding,
   * building the encoding if the error has not crossed yet. An existing
   * marker keeps its place, as an own property does in Node. */
  private markNow(c: Code, key: string): void {
    const d = this.d;
    d.objPayload(c, (x) => {
      x.localGet(0);
      x.call(d.fromError());
    });
    this.k.deps.lit(c, key);
    c.globalGet(d.boolGlobal(true));
    c.call(d.objPut());
  }

  /** Records marker `key` (pending bit `bit`) for the error in local 0,
   * `B` an eqref scratch local: into its encoding when it has one (or its
   * class is mirrored, GH #191), else as a pending bit its first crossing
   * places (dyn.ts fromError, placePending) — no encoding is built for
   * an error that may never cross. */
  private mark(c: Code, key: string, bit: number, B: number): void {
    const deps = this.k.deps;
    const lazy = (): void => {
      c.localGet(0);
      c.structGet(deps.errT(), deps.errBox());
      c.localTee(B);
      c.refTest(this.d.dynT());
      c.ifVoid();
      this.markNow(c, key);
      c.else_();
      c.localGet(0);
      c.localGet(B);
      c.refIsNull();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(B);
      c.refCast(this.pendingT());
      c.structGet(this.pendingT(), 0);
      c.end();
      c.i32Const(bit);
      c.i32Or();
      c.call(this.pendingOf());
      c.structSet(deps.errT(), deps.errBox());
      c.end();
    };
    if (deps.errView === undefined) {
      lazy();
      return;
    }
    this.viewKindNe(c, ERRV_PROBE, 9);
    c.ifVoid();
    lazy();
    c.else_();
    this.markNow(c, key);
    c.end();
  }

  /** In dyn.ts fromError, once the encoding (OBJ in local `O`) is built
   * and published: the markers pending in the slot's old value (local
   * `B`, an eqref), in their places — after everything the build put,
   * which is where a write before the crossing would have put them. */
  placePending(c: Code, B: number, O: number): void {
    const T = this.pendingT();
    c.localGet(B);
    c.refTest(T);
    c.ifVoid();
    for (const [bit, key] of [[PEND_NAME, ERR_OWN_NAME], [PEND_MSG, ERR_MSG_UNSURE]] as const) {
      c.localGet(B);
      c.refCast(T);
      c.structGet(T, 0);
      c.i32Const(bit);
      c.i32And();
      c.ifVoid();
      c.localGet(O);
      this.k.deps.lit(c, key);
      c.globalGet(this.d.boolGlobal(true));
      c.call(this.d.objPut());
      c.end();
    }
    c.end();
  }

  /** Pushes the error's encoding (ref null dyn) from its slot value on
   * the stack (an eqref; `T` an eqref scratch local), or null for none
   * yet — a pending sentinel is not an encoding. */
  boxOrNull(c: Code, T: number): void {
    const D = this.d.dynT();
    c.localTee(T);
    c.refTestNull(D);
    c.ifResult({ kind: "ref", nullable: true, typeIndex: D });
    c.localGet(T);
    c.refCastNull(D);
    c.else_();
    c.refNull(D);
    c.end();
  }

  /** %w.dyn.errNameOwned(err): after a write of `name` from outside the
   * class (typed or dynamic) to an error whose class does not own `name`:
   * the property is own and enumerable from now on in Node, listed in the
   * place this write gives it. */
  nameWritten(): number {
    return this.k.cached("errNameOwned", [this.errRef()], [], (idx) => {
      const deps = this.k.deps;
      const c = new Code();
      if (deps.errView !== undefined) {
        // GH #191: a mirrored instance whose class makes `name` own lists
        // it from the class's place already.
        c.block();
        this.viewKindNe(c, ERRV_PROBE, 9);
        c.brIf(0);
        this.viewKindNe(c, "name", 0);
        c.ifVoid();
        c.return_();
        c.end();
        this.markNow(c, ERR_OWN_NAME);
        c.return_();
        c.end();
      }
      this.returnIfStopped(c);
      if (deps.errNameTest !== undefined) {
        deps.errNameTest(c, (x) => x.localGet(0));
        c.ifVoid();
        c.return_();
        c.end();
      }
      this.mark(c, ERR_OWN_NAME, PEND_NAME, 1);
      this.k.mb.setBody(idx, [EQ_REF], c.bytes());
    });
  }

  /** %w.dyn.errMessageWriting(err): BEFORE a write of `message` (typed or
   * dynamic) to the error. A non-empty slot is a message the error owns
   * (non-enumerable, and a write keeps it so); "" is either that or no
   * message at all, which the write would make own and enumerable: the
   * place is marked for the listing to stop at. */
  messageWriting(): number {
    return this.k.cached("errMessageWriting", [this.errRef()], [], (idx) => {
      const deps = this.k.deps;
      const c = new Code();
      const S = 1;
      if (deps.errView !== undefined) {
        // GH #191: a mirrored class that places `message` itself (kind
        // other than 0) answers for it in the listing (or stops there).
        c.block();
        this.viewKindNe(c, ERRV_PROBE, 9);
        c.brIf(0);
        this.viewKindNe(c, "message", 0);
        c.ifVoid();
        c.return_();
        c.end();
        c.end();
      }
      this.returnIfStopped(c);
      c.localGet(0);
      c.structGet(deps.errT(), deps.errMessage());
      c.localTee(S);
      c.refIsNull();
      c.ifVoid();
      this.mark(c, ERR_MSG_UNSURE, PEND_MSG, 2);
      c.return_();
      c.end();
      c.localGet(S);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      this.mark(c, ERR_MSG_UNSURE, PEND_MSG, 2);
      c.end();
      this.k.mb.setBody(idx, [deps.strRef(), EQ_REF], c.bytes());
    });
  }

  /** JSON.stringify's member walk over the encoding (OBJ in local `OP`)
   * of an error, at the entry pair in vec local `P` (json.ts putDyn): the
   * own-name marker becomes the pair ("name", the slot's value) in its
   * place — Node serializes an own enumerable `name` — and the message
   * marker stops by name, as a listing does. Any other pair is left as
   * it is. The pair is the walk's own fresh copy (objWalk's entries). */
  jsonEntry(c: Code, P: number, OP: number): void {
    const d = this.d;
    const deps = this.k.deps;
    const key = (x: Code): void => {
      d.arrAt(x, (y) => y.localGet(P), (y) => y.i32Const(0));
      x.structGet(d.dynT(), DYN_REF);
      emitFlatCast(x, deps.strType());
    };
    key(c);
    deps.lit(c, ERR_MSG_UNSURE);
    c.call(deps.strEq());
    c.ifVoid();
    deps.fence(c, (x) => deps.lit(x, msgUnsureText("JSON.stringify")));
    c.end();
    key(c);
    deps.lit(c, ERR_OWN_NAME);
    c.call(deps.strEq());
    c.ifVoid();
    d.arrSet(c, (x) => x.localGet(P), (x) => x.i32Const(0), (x) => d.boxStr(x, (y) => deps.lit(y, "name")));
    d.arrSet(c, (x) => x.localGet(P), (x) => x.i32Const(1), (x) =>
      d.boxStr(x, (y) => {
        y.localGet(OP);
        y.call(d.errLinkOf());
        y.structGet(deps.errT(), deps.errName());
      }));
    c.end();
  }

  /** Pushes i32: is the error in local `err` (non-null) one whose `code`
   * entry the runtime placed — a stamped code slot, or a DOMException's
   * derived code — rather than one a program wrote? */
  codeHidden(c: Code, err: number): void {
    const deps = this.k.deps;
    c.localGet(err);
    c.structGet(deps.errT(), deps.errCode());
    c.refIsNull();
    c.i32Eqz();
    if (deps.errIsDomex !== undefined) {
      deps.errIsDomex(c, (x) => x.localGet(err));
      c.i32Or();
    }
  }

  /** The user view's answer for marker entry `E` (an entry local) of the
   * error in local `ERR`, appended to the copy in local `CP`: the own
   * `name` in its place; the stop for a `message` whose enumerability the
   * slot cannot tell. Branches to `skip` (a label depth, counted from
   * inside the emitted code) once it has answered; falls through for any
   * other entry. */
  markerArm(c: Code, E: number, ERR: number, CP: number, skip: number): void {
    const d = this.d;
    const deps = this.k.deps;
    const entryT = d.entryT();
    c.localGet(E);
    c.structGet(entryT, ENTRY_KEY);
    deps.lit(c, ERR_OWN_NAME);
    c.call(deps.strEq());
    c.ifVoid();
    c.localGet(CP);
    deps.lit(c, "name");
    d.boxStr(c, (x) => {
      x.localGet(ERR);
      x.structGet(deps.errT(), deps.errName());
    });
    c.call(d.objPut());
    c.br(skip + 1);
    c.end();
    c.localGet(E);
    c.structGet(entryT, ENTRY_KEY);
    deps.lit(c, ERR_MSG_UNSURE);
    c.call(deps.strEq());
    c.ifVoid();
    deps.fence(c, (x) => deps.lit(x, msgUnsureText("a key listing, spread or Object.assign")));
    c.end();
  }
}
