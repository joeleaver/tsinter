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
 * The markers are built into the encoding early when the error has not
 * crossed yet, as GH #191's own-name marker always was. An instance the
 * crossing would stop on (S138 errStopTest), or whose class sets its own
 * name (errNameTest: its listings stop by name), needs none. */
import type { DynBuilder } from "./dyn.js";
import { ENTRY_KEY } from "./dyn.js";
import { Code } from "./code.js";
import { ERR_MSG_UNSURE, ERR_OWN_NAME, ERRV_PROBE } from "../../ir/nodes.js";

export class ErrOwnKeys {
  constructor(private readonly d: DynBuilder) {}

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

  /** Puts marker `key` (the value `true`) into the error's encoding,
   * building the encoding if the error has not crossed yet. An existing
   * marker keeps its place, as an own property does in Node. */
  private mark(c: Code, key: string): void {
    const d = this.d;
    d.objPayload(c, (x) => {
      x.localGet(0);
      x.call(d.fromError());
    });
    this.k.deps.lit(c, key);
    c.globalGet(d.boolGlobal(true));
    c.call(d.objPut());
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
        this.mark(c, ERR_OWN_NAME);
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
      this.mark(c, ERR_OWN_NAME);
      this.k.mb.setBody(idx, [], c.bytes());
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
      this.mark(c, ERR_MSG_UNSURE);
      c.return_();
      c.end();
      c.localGet(S);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      this.mark(c, ERR_MSG_UNSURE);
      c.end();
      this.k.mb.setBody(idx, [deps.strRef()], c.bytes());
    });
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
    deps.fence(c, (x) =>
      deps.lit(x, "a key listing, spread or Object.assign of an error held in a dynamic value whose 'message' was written while it was empty (whether Node lists it depends on whether the error was constructed with a message, which this build does not record) is not supported yet (SEMANTICS.md S080)"));
    c.end();
  }
}
