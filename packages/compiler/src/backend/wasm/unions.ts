/* Tagged unions over WasmGC: ONE shared open base struct { tag: i32 }
 * every payload-carrying arm subtypes with { tag, payload } — the GC-native
 * translation of the C runtime's generic ScrUnion (rc + tag + one 8-byte
 * slot). The base is shared across ALL unions deliberately: a union VALUE
 * is (ref null $base) everywhere (locals, fields, array elements — one
 * vector type serves every union-element array), the tag reads off the
 * base, and only payload access casts down to the per-(union, arm)
 * subtype. C's three stored RC/trace function pointers vanish — the GC
 * traces payloads itself.
 *
 * The tag is the arm's index in the union's CANONICAL (typeKey-sorted)
 * arm list — IrUnionDef's contract, shared with both native backends.
 * Unit arms (undefined/null) carry NO payload: every wrap yields THE
 * interned immortal instance for the tag (a constant-initialized global
 * of the bare base type — payload-less instances are fully determined by
 * their tag, so the intern is per TAG, not per union). Unions are
 * immutable once constructed; both struct fields are const.
 *
 * The dispatch helpers (ToBoolean / strict-and-SameValue equality /
 * ToString) intern per union, mirroring the C backend's sc_ut_/sc_ue_/
 * sc_us_ family: a switch over the tag with one arm-kind-appropriate
 * answer per case and a trap default (a corrupted tag is loud, never
 * silent). The EMITTER resolves each arm's representation before asking
 * for a helper — arms whose payload a helper never reads (ref arms under
 * ToBoolean: objects are always truthy) need no representation at all,
 * so `MyClass | undefined` still truth-tests in-tier while its wrap
 * refuses; refusals for arms a helper genuinely must read stay at the
 * emitter where the census lives. */
import { Code } from "./code.js";
import { F64, I32, type FieldType, ModuleBuilder, type ValType } from "./module.js";

/** One arm as a helper needs it: the KIND decides the dispatch answer,
 * `struct` is the payload subtype when (and only when) that helper reads
 * the payload. */
export interface UnionArmRep {
  kind: "undefined" | "null" | "f64" | "bool" | "string" | "ref";
  struct: number | null;
}

export interface UnionDeps {
  /** %w.strEq's index (string-arm equality). */
  strEq: () => number;
  /** %w.f64ToStr's index (f64-arm ToString). */
  f64ToStr: () => number;
  /** The string valtype (helpers returning strings). */
  strRef: () => ValType;
  /** Push an interned string literal onto `c`'s stack. */
  lit: (c: Code, s: string) => void;
}

const TAG = 0; // struct field indices
const PAYLOAD = 1;

export class UnionBuilder {
  private baseType: number | null = null;
  private readonly unitGlobals = new Map<number, number>();
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: UnionDeps,
  ) {}

  /** The shared open base — { tag: i32 } — every arm subtype extends. */
  base(): number {
    this.baseType ??= this.mb.openStructType("union:base", [{ storage: I32, mutable: false }]);
    return this.baseType;
  }

  baseRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.base() };
  }

  /** The immortal payload-less instance for a unit arm's tag: an immutable
   * global, constant-initialized (i32.const tag; struct.new base). */
  unitGlobal(tag: number): number {
    const existing = this.unitGlobals.get(tag);
    if (existing !== undefined) return existing;
    const base = this.base();
    const index = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: base }, false, (w) => {
      w.u8(0x41); // i32.const tag
      w.sleb(tag);
      w.u8(0xfb); // struct.new base
      w.uleb(0x00);
      w.uleb(base);
    });
    this.unitGlobals.set(tag, index);
    return index;
  }

  /** The payload-carrying subtype for one (union, arm): { tag, payload },
   * keyed by meaning — two unions' arms never intern the SAME type-section
   * ENTRY even when their layouts agree (ModuleBuilder's own `typeIndex`
   * cache — not this builder's, `armStruct` only calls into it — is keyed
   * by the literal `union:<unionId>:<tag>` string via `subStructType`, so
   * two different keys always get two different declarations). That is
   * NOT the same claim as "a cast can only succeed on the arm it names":
   * it cannot be, because WasmGC struct types canonicalize STRUCTURALLY
   * at the engine level (isorecursive equivalence, GC MVP) — but ONLY
   * PER RECURSION GROUP: two entries with identical shape are ONE runtime
   * type when EACH is its own singleton group (module.ts's own rule: a
   * plain entry with no explicit `rec` is its own singleton), which is
   * what every `armStruct` call produces TODAY — it is never invoked
   * while a `beginRecGroup`/`endRecGroup` span is open (the only span in
   * this codebase, `resolveRecGroup`'s record/class SCC resolution,
   * calls `mapTypeSoft` for field types, never `unionWrap`/`armStruct` —
   * confirmed by reading that span's body). Two structs that were each
   * declared as a singleton with identical field layout and supertype ARE
   * the same runtime type regardless of which entry declared them, so a
   * `ref.cast` against one CAN succeed on a value built under the other
   * whenever their payload types agree (confirmed: emitter.ts's map
   * `get` case relies on exactly this to reuse a stored union value
   * across two distinct `unionId`s — see its doc for the measurement).
   * An arm struct interned INSIDE an open span would compare as a member
   * of its whole multi-entry group instead, and the reuse would very
   * likely break — this equivalence is conditional on staying a
   * singleton, not a blanket "any two structurally-identical structs
   * unify" rule. Never rely on a cast FAILING to distinguish two arms
   * this way; only the TAG value (read off the shared base, never
   * cast-dependent) does that safely. */
  armStruct(unionId: string, tag: number, payload: ValType): number {
    const fields: FieldType[] = [
      { storage: I32, mutable: false },
      { storage: payload, mutable: false },
    ];
    return this.mb.subStructType(`union:${unionId}:${tag}`, fields, this.base());
  }

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** Emits the per-arm dispatch skeleton shared by every helper: tag into
   * a local, one `if (tag == i) { ...; return }` per arm, and the
   * corrupted-tag trap after the last (C's scr_trap default). */
  private dispatch(c: Code, tagLocal: number, arms: UnionArmRep[], arm: (rep: UnionArmRep, i: number) => void): void {
    c.localGet(0);
    c.structGet(this.base(), TAG);
    c.localSet(tagLocal);
    arms.forEach((rep, i) => {
      c.localGet(tagLocal);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      arm(rep, i);
      c.return_();
      c.end();
    });
    c.unreachable();
  }

  /** Pushes param `p`'s payload for arm `rep` (cast + read). */
  private payload(c: Code, rep: UnionArmRep, p: number): void {
    if (rep.struct === null) throw new Error("payload read on an arm resolved without a struct");
    c.localGet(p);
    c.refCast(rep.struct);
    c.structGet(rep.struct, PAYLOAD);
  }

  /** %w.u.truthy:<id> — JS ToBoolean of the ARM value: unit arms false,
   * f64 false iff 0/-0/NaN, "" false, bool itself, every object arm true. */
  truthy(unionId: string, arms: UnionArmRep[]): number {
    return this.cached(`truthy:${unionId}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.baseRef()], [I32]), `%w.u.truthy:${unionId}`);
      const c = new Code();
      const TAGL = 1;
      const X = 2;
      this.dispatch(c, TAGL, arms, (rep) => {
        switch (rep.kind) {
          case "undefined":
          case "null":
            c.i32Const(0);
            return;
          case "f64":
            // (x != 0) & (x == x) — false for 0, -0, NaN.
            this.payload(c, rep, 0);
            c.localSet(X);
            c.localGet(X);
            c.f64Const(0);
            c.f64Ne();
            c.localGet(X);
            c.localGet(X);
            c.f64Eq();
            c.i32And();
            return;
          case "bool":
            this.payload(c, rep, 0);
            return;
          case "string":
            this.payload(c, rep, 0);
            c.arrayLen();
            c.i32Const(0);
            c.i32Ne();
            return;
          case "ref":
            c.i32Const(1);
            return;
        }
      });
      this.mb.setBody(idx, [I32, F64], c.bytes());
      return idx;
    });
  }

  /** %w.u.eq:<id> (and the eqsv SameValue variant) — JS-exact strict
   * equality of the ARM values: differing tags never equal, unit arms of
   * one tag equal, f64 by `==` (SameValue: NaN equals NaN, +0 differs
   * from -0), strings by content, bools by value, ref arms by POINTER
   * identity. `negated` stays at the call site. */
  eq(unionId: string, arms: UnionArmRep[], sameValue: boolean): number {
    return this.cached(`${sameValue ? "eqsv" : "eq"}:${unionId}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.baseRef(), this.baseRef()], [I32]),
        `%w.u.${sameValue ? "eqsv" : "eq"}:${unionId}`,
      );
      const c = new Code();
      const TAGL = 2;
      const X = 3;
      const Y = 4;
      // Tags first: differing tags are never equal (null !== undefined
      // included), and every later case may assume both operands sit on
      // the SAME arm.
      c.localGet(0);
      c.structGet(this.base(), TAG);
      c.localTee(TAGL);
      c.localGet(1);
      c.structGet(this.base(), TAG);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      arms.forEach((rep, i) => {
        c.localGet(TAGL);
        c.i32Const(i);
        c.i32Eq();
        c.ifVoid();
        switch (rep.kind) {
          case "undefined":
          case "null":
            c.i32Const(1);
            break;
          case "f64":
            if (sameValue) {
              // (both NaN) | (identical bits) — NaN payload bits differ,
              // so the NaN clause comes first; bits alone split +0/-0.
              this.payload(c, rep, 0);
              c.localSet(X);
              this.payload(c, rep, 1);
              c.localSet(Y);
              c.localGet(X);
              c.localGet(X);
              c.f64Ne();
              c.localGet(Y);
              c.localGet(Y);
              c.f64Ne();
              c.i32And();
              c.localGet(X);
              c.i64ReinterpretF64();
              c.localGet(Y);
              c.i64ReinterpretF64();
              c.i64Eq();
              c.i32Or();
            } else {
              this.payload(c, rep, 0);
              this.payload(c, rep, 1);
              c.f64Eq();
            }
            break;
          case "bool":
            this.payload(c, rep, 0);
            this.payload(c, rep, 1);
            c.i32Eq();
            break;
          case "string":
            this.payload(c, rep, 0);
            this.payload(c, rep, 1);
            c.call(this.deps.strEq());
            break;
          case "ref":
            this.payload(c, rep, 0);
            this.payload(c, rep, 1);
            c.refEq();
            break;
        }
        c.return_();
        c.end();
      });
      c.unreachable();
      this.mb.setBody(idx, [I32, F64, F64], c.bytes());
      return idx;
    });
  }

  /** %w.u.toStr:<id> — the ARM value's ToString. The frontend fences
   * union-operand string conversion to unit/string/f64/bool arms (plus
   * bytes, which the emitter refuses before asking), so `ref` never
   * arrives here. */
  toStr(unionId: string, arms: UnionArmRep[]): number {
    return this.cached(`toStr:${unionId}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.baseRef()], [this.deps.strRef()]),
        `%w.u.toStr:${unionId}`,
      );
      const c = new Code();
      const TAGL = 1;
      this.dispatch(c, TAGL, arms, (rep) => {
        switch (rep.kind) {
          case "undefined":
            this.deps.lit(c, "undefined");
            return;
          case "null":
            this.deps.lit(c, "null");
            return;
          case "string":
            this.payload(c, rep, 0);
            return;
          case "f64":
            this.payload(c, rep, 0);
            c.call(this.deps.f64ToStr());
            return;
          case "bool":
            this.payload(c, rep, 0);
            c.ifResult(this.deps.strRef());
            this.deps.lit(c, "true");
            c.else_();
            this.deps.lit(c, "false");
            c.end();
            return;
          case "ref":
            throw new Error("ToString over a ref union arm (frontend fence breached)");
        }
      });
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }
}
