/* Classes over WasmGC: ONE struct per emitted class, wasm-SUBTYPED along
 * the source hierarchy, plus preorder intervals carried as DATA. The
 * increment's design doc, distilled — read this before changing layout.
 *
 * THE STRUCT. `mapType(object:C)` is `(ref null $C)`. `$C`'s members are
 * the class's FLATTENED field list (IrClassDef.fields — the base chain's
 * fields first, an exact validator-enforced prefix) mapped one for one,
 * preceded on HIERARCHY members (a class with a base or with children) by
 * one immutable `vt` field. `$C` declares `$Base` as its supertype and is
 * final iff it has no children, so an upcast is plain subsumption and a
 * downcast is `ref.cast`. The prefix rule is what makes the subtype
 * declaration legal, and it survives the type map because field storage
 * comes from the emitter's SOFT map, a pure function of the IR type: two
 * typeEquals-identical prefixes cannot spell different valtypes.
 *
 * IDENTITY IS DATA, NOT WASM TYPES. `ref.test` would answer for the
 * canonicalized STRUCTURE, and two unrelated hierarchies with matching
 * layouts canonicalize together — it would lie. So instanceof is the C and
 * LLVM lanes' O(1) preorder-interval test, ported: `vt` points at the ONE
 * shared open struct `$ci = { pre: i32, post: i32 }`, and a class's
 * interval is a whole-program constant, so C's runtime vtable-stamping
 * protocol collapses into one immortal const global per class
 * (`struct.new $ci` is a constant expression, the interned union unit-arm
 * trick). Standalone classes — no base, no children — carry NO vt, exactly
 * C's layout: their instanceof is statically decided and never reaches IR.
 * The numbering itself is IMPORTED (buildClassGraph / vtEntriesFor from
 * ../llvm/classes.js, pure IR functions) and never re-derived: the wasm
 * lane's intervals must be the same integers the other two lanes compute.
 *
 * THE REC-GROUP SPAN. Class structs reference each other through fields,
 * and through vectors and records that reference back (`children: Node[]`
 * puts `(ref null $Node)` inside the vec's element array). Wasm allows
 * forward references only inside one `rec` group, so planning brackets
 * itself in a ModuleBuilder SPAN: reserve the class's index, publish it,
 * then map the fields — every vec/record/union/closure type that mapping
 * touches lands inside the span too, which is exactly what makes the
 * back-references legal. Planning is LAZY (first touch) with the
 * publish-before-map guard standing in for recordInfo's in-flight set: a
 * cycle re-entering a class in flight gets its reserved index instead of
 * recursing forever. The span opens on the outermost plan and closes when
 * it returns, so one cycle of mutually recursive classes is one group.
 *
 * UNMAPPABLE FIELDS DO NOT POISON THE LAYOUT — the recordInfo convention,
 * deliberately. A record shape whose field type is out of tier still gets
 * its struct (the field takes the soft map's i32 placeholder) and refuses
 * at the ACCESS site; classes do the same. Nothing can observe the
 * placeholder: every fieldGet/fieldSet/fieldIncDec maps the field's
 * DECLARED type and refuses first, and `new`'s seed writes the same
 * placeholder zero it reads back. The alternative — refusing the class and
 * propagating poison down the subtree, since a poisoned prefix poisons
 * every descendant's layout — buys nothing here and would have to
 * re-implement prefix propagation that soft mapping already gives for free.
 *
 * WHAT STAYS OUT. Classes rooted in the RUNTIME hierarchies emit no struct:
 * the %Error family because errT is still its own representation until the
 * error unification lands (`class:extends-error`), %EventEmitter and the
 * stream classes because their C prefix embeds registry and stream-state
 * slots this tier has no runtime for (`class:extends-runtime`). Both
 * families are still NUMBERED — they are in `mod.classes`, so leaving them
 * out of the graph would shift every other class's interval away from the
 * native lanes'. mapType intercepts RUNTIME_ERROR_CLASSES before it ever
 * asks here, so the errT path is untouched; a runtime error class reaching
 * `info` means a USER class mixed with one, which is the same rock and
 * wears the same name. */
import type { IrFunction, IrModule, IrType, SrcLoc } from "../../ir/nodes.js";
import {
  RUNTIME_EMITTER_CLASS,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_STREAM_CLASSES,
} from "../../ir/nodes.js";
import { buildClassGraph, vtEntriesFor, type LlClassMeta, type LlVtSlot } from "../llvm/classes.js";
import { type FieldType, I32, ModuleBuilder, type ValType } from "./module.js";

/** `vt`'s slot on a HIERARCHY class: field 0, ahead of the flattened
 * field list (standalone classes have no vt and start at 0 — ClassInfo's
 * fieldIndex has the shift already applied). */
export const CLASS_VT = 0;

/** $ci's field indices. `pre` is what an instanceof reads off the
 * instance; `post` completes the interval the native lanes' ScrVt head
 * carries — nothing reads it from an INSTANCE today, because a target's
 * interval is always a compile-time constant (a dynamic target is a class
 * VALUE, which carries its own interval). */
export const CI_PRE = 0;
export const CI_POST = 1;

/** Where $vtt_<root>'s slot fields start — after the repeated $ci head. */
export const VTT_SLOT0 = 2;

/** One emitted class's wasm shape. */
export interface ClassInfo {
  meta: LlClassMeta;
  /** The class's struct type index. */
  struct: number;
  /** Field name → struct field index — the flattened position, shifted
   * one past `vt` on hierarchy members. */
  fieldIndex: Map<string, number>;
  /** Field name → its IR type, the honest gate at every access site. */
  fieldType: Map<string, IrType>;
}

export interface ClassDeps {
  /** The emitter's SOFT type map — a field's storage, spelled exactly as
   * the same IR type is spelled everywhere else in the module. */
  softType: (t: IrType) => ValType;
  /** The census sink. */
  refuse: (kind: string, loc: SrcLoc | undefined) => void;
  /** A slot's wasm func type: the DECLARER's `this` plus the rest of the
   * signature. The emitter owns it because it must be the SAME interned
   * index a method function is declared with, or a directly-stored
   * funcref would not call_ref. */
  slotFnType: (slot: LlVtSlot) => number;
  /** The function index to store in `slot` for `impl` — the method itself
   * when its `this` already IS the slot's, an adapter when the override
   * narrowed it. Null when no implementation function exists (see
   * vtGlobal's comment on unreachable slots). */
  slotEntry: (slot: LlVtSlot, impl: LlClassMeta) => number | null;
  /** The shared builtin-error struct and its field declaration. The five
   * builtins ARE this struct (their class id became their vt, so one
   * declaration still covers the whole builtin hierarchy), and a user
   * class rooted in it SUBTYPES it — which is why the prefix is taken
   * verbatim rather than re-mapped: a subtype's fields must match the
   * supertype's exactly, and `%code` is immutable there while a mapped
   * field is not. */
  errStruct: () => { struct: number; fields: FieldType[] };
}

export class ClassBuilder {
  private readonly metaMap: Map<string, LlClassMeta>;
  private readonly infos = new Map<string, ClassInfo | null>();
  private readonly ciGlobals = new Map<string, number>();
  private readonly vtGlobals = new Map<string, number>();
  private ciType: number | null = null;
  private spanOpen = false;

  constructor(
    private readonly mb: ModuleBuilder,
    mod: IrModule,
    fnByName: Map<string, IrFunction>,
    private readonly deps: ClassDeps,
  ) {
    this.metaMap = buildClassGraph(mod, fnByName);
  }

  /** The one shared open interval struct every hierarchy instance's `vt`
   * points at: `{ pre: i32, post: i32 }`, in that field order — the
   * whole-program preorder interval, immutable. Interned outside any span
   * (it references nothing). */
  ci(): number {
    // Field order IS the contract CI_PRE/CI_POST name, and $vtt_<root>
    // repeats this head verbatim as its first two fields — written out in
    // order rather than indexed, so the two declarations stay legible side
    // by side.
    this.ciType ??= this.mb.openStructType("class:ci", [
      { storage: I32, mutable: false }, // CI_PRE
      { storage: I32, mutable: false }, // CI_POST
    ]);
    return this.ciType;
  }

  ciRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.ci() };
  }

  /** The class's immortal interval global — `struct.new $ci (pre) (post)`
   * as a constant expression. Hierarchy members only: a standalone class
   * has no vt field to seed. */
  ciGlobal(className: string): number {
    const existing = this.ciGlobals.get(className);
    if (existing !== undefined) return existing;
    const meta = this.metaMap.get(className);
    if (meta === undefined) throw new Error(`wasm emitter bug: interval global for unknown class ${className}`);
    if (!meta.hierarchy) {
      throw new Error(`wasm emitter bug: interval global for standalone class ${className}`);
    }
    const ci = this.ci();
    const index = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: ci }, false, (w) => {
      // Operands in field order: CI_PRE then CI_POST.
      w.u8(0x41); // i32.const pre
      w.sleb(meta.pre);
      w.u8(0x41); // i32.const post
      w.sleb(meta.post);
      w.u8(0xfb); // struct.new $ci
      w.uleb(0x00);
      w.uleb(ci);
    });
    this.ciGlobals.set(className, index);
    return index;
  }

  ref(info: ClassInfo): ValType {
    return { kind: "ref", nullable: true, typeIndex: info.struct };
  }

  /** The class graph node — the SHARED numbering, and the slot lists a
   * virtual dispatch resolves against. */
  meta(className: string): LlClassMeta | undefined {
    return this.metaMap.get(className);
  }

  /** Is this class errT-shaped — a builtin error or a user class rooted
   * in one? Those are exactly the instances that may ride the exception
   * cell's OBJ payload and a promise's rejection slot, because those two
   * places read a name and message back out of a bare reference. */
  errorRooted(className: string): boolean {
    const meta = this.metaMap.get(className);
    return meta !== undefined && this.rootKind(meta) === "error";
  }

  /** The vtable struct for one hierarchy ROOT: $ci's {pre, post} head
   * repeated (so an instance's vt still reads as a plain interval — see
   * `vtGlobal`), then one nullable funcref per slot in `root.slots`
   * order. Final: nothing subtypes a vtable. */
  vttType(root: LlClassMeta): number {
    const fields: FieldType[] = [
      { storage: I32, mutable: false }, // CI_PRE
      { storage: I32, mutable: false }, // CI_POST
      ...root.slots.map((slot) => ({
        storage: { kind: "ref", nullable: true, typeIndex: this.deps.slotFnType(slot) } as ValType,
        mutable: false,
      })),
    ];
    return this.mb.subStructType(`class:vtt:${root.def.name}`, fields, this.ci());
  }

  /** The immortal global an instance's `vt` is stamped with. A hierarchy
   * with virtual slots gets its class's VTABLE instance; one with none
   * gets the bare interval. Either way the field stays (ref null $ci), so
   * instanceof reads `pre` through the subtype without knowing which.
   *
   * A slot with no implementation FUNCTION stores ref.null, and that is
   * sound rather than a hole: a slot exists as soon as some descendant
   * redeclares the method, but the method's function only exists if
   * something calls it, and the only reader of a slot is a virtualCall —
   * whose reachability edge (root-down over every declaring class) is
   * exactly what makes the function exist. So a null slot is a slot no
   * dispatch can reach. vtEntriesFor answers null for the other case:
   * outside the declaring subtree, or a fully-abstract chain. */
  vtGlobal(className: string): number {
    const existing = this.vtGlobals.get(className);
    if (existing !== undefined) return existing;
    const meta = this.metaMap.get(className);
    if (meta === undefined) throw new Error(`wasm emitter bug: vtable for unknown class ${className}`);
    if (!meta.hierarchy) throw new Error(`wasm emitter bug: vtable for standalone class ${className}`);
    if (meta.root.slots.length === 0) return this.ciGlobal(className);
    const vtt = this.vttType(meta.root);
    const entries = vtEntriesFor(meta).map(({ slot, impl }) => ({
      fn: impl === null ? null : this.deps.slotEntry(slot, impl),
      type: this.deps.slotFnType(slot),
    }));
    const index = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: vtt }, false, (w) => {
      // Operands in field order: the interval head, then one per slot.
      w.u8(0x41); // i32.const pre
      w.sleb(meta.pre);
      w.u8(0x41); // i32.const post
      w.sleb(meta.post);
      for (const e of entries) {
        if (e.fn === null) {
          w.u8(0xd0); // ref.null $slotFnT
          w.sleb(e.type);
        } else {
          w.u8(0xd2); // ref.func
          w.uleb(e.fn);
        }
      }
      w.u8(0xfb); // struct.new $vtt
      w.uleb(0x00);
      w.uleb(vtt);
    });
    this.vtGlobals.set(className, index);
    return index;
  }

  /** The emitted shape for a class, or null when the class is out of tier
   * (refusal recorded unless `soft`). */
  info(className: string, loc: SrcLoc | undefined, soft: boolean): ClassInfo | null {
    const cached = this.infos.get(className);
    if (cached !== undefined) {
      if (cached === null && !soft) this.refuseClass(className, loc);
      return cached;
    }
    const meta = this.metaMap.get(className);
    if (meta === undefined || this.rootKind(meta) === "runtime") {
      this.infos.set(className, null);
      if (!soft) this.refuseClass(className, loc);
      return null;
    }
    // The five builtin errors don't get planned — they ARE errT, which
    // the exception cell owns. Everything above this line treats them
    // like any other class: same interval, same field indices, same
    // subsumption rules, so instanceof and casts need no special case.
    if (RUNTIME_ERROR_CLASSES.has(className)) {
      const made: ClassInfo = {
        meta,
        struct: this.deps.errStruct().struct,
        fieldIndex: new Map(meta.def.fields.map((f, i) => [f.name, 1 + i])),
        fieldType: new Map(meta.def.fields.map((f) => [f.name, f.type])),
      };
      this.infos.set(className, made);
      return made;
    }
    return this.plan(meta);
  }

  /** Which family a class's base chain ends in — what decides whether a
   * struct is emitted at all. */
  private rootKind(meta: LlClassMeta): "user" | "error" | "runtime" {
    for (let m: LlClassMeta | null = meta; m !== null; m = m.base) {
      if (RUNTIME_ERROR_CLASSES.has(m.def.name)) return "error";
      if (m.def.name === RUNTIME_EMITTER_CLASS) return "runtime";
      if (RUNTIME_STREAM_CLASSES.has(m.def.name)) return "runtime";
      if (m.def.runtime === true) return "runtime";
    }
    return "user";
  }

  private refuseClass(className: string, loc: SrcLoc | undefined): void {
    const meta = this.metaMap.get(className);
    if (meta === undefined) {
      // Not a class this module declares — the generic type refusal.
      this.deps.refuse("type:object", loc);
      return;
    }
    this.deps.refuse("class:extends-runtime", loc);
  }

  /** Reserve, publish, map, define — in that order, so a field that
   * cycles back into this class (directly or through a vec/record) finds
   * a reserved index instead of recursing. */
  private plan(meta: LlClassMeta): ClassInfo {
    const name = meta.def.name;
    // Nothing inside a plan may refuse (field storage comes from the SOFT
    // map), so the span is closed on the normal path only: an exception
    // escaping here is an emitter bug, and a `finally` would replace it
    // with the span's own undefined-reservation complaint.
    const opened = this.openSpan();
    // The BASE CHAIN reserves first. A rec group lets members reference
    // each other in either direction, but a declared SUPERTYPE is the one
    // exception: its index must precede the subtype's, inside a group as
    // much as outside it. Base-first ordering is what guarantees that.
    const base = meta.base === null ? null : this.classOf(meta.base);
    // Planning the base may have planned US on the way — a base field
    // typed by this class closes the cycle from above.
    const settled = this.infos.get(name);
    if (settled != null) {
      if (opened) this.closeSpan();
      return settled;
    }
    const struct = this.mb.reserveType(`class:${name}`);
    const fieldBase = meta.hierarchy ? 1 : 0;
    const info: ClassInfo = {
      meta,
      struct,
      fieldIndex: new Map(meta.def.fields.map((f, i) => [f.name, fieldBase + i])),
      fieldType: new Map(meta.def.fields.map((f) => [f.name, f.type])),
    };
    this.infos.set(name, info);
    // An error-rooted class SUBTYPES errT, so its first three flattened
    // fields — %Error's name/message/%code — are errT's own declarations
    // verbatim. Re-mapping them would spell `%code` mutable and break the
    // subtype match; past the prefix the ordinary map takes over.
    const errPrefix = this.rootKind(meta) === "error" ? this.deps.errStruct().fields : null;
    const fields: FieldType[] = [];
    if (meta.hierarchy) fields.push({ storage: this.ciRef(), mutable: false });
    meta.def.fields.forEach((f, i) => {
      fields.push(errPrefix?.[i + 1] ?? { storage: this.deps.softType(f.type), mutable: true });
    });
    this.mb.defineType(struct, {
      kind: "struct",
      fields,
      sub: { supers: base === null ? [] : [base.struct], final: meta.children.length === 0 },
    });
    if (opened) this.closeSpan();
    return info;
  }

  /** A base's shape. Goes through `info` rather than straight to `plan`
   * so it answers with the cache when the base is already in flight (a
   * field that cycles back up) AND takes the builtin-error path when the
   * base is one — planning %Error would mint a SECOND struct beside errT,
   * and the two would then disagree at every cast. */
  private classOf(meta: LlClassMeta): ClassInfo {
    const got = this.info(meta.def.name, undefined, true);
    if (got === null) {
      throw new Error(`wasm emitter bug: ${meta.def.name} is an emitted class's base but has no shape`);
    }
    return got;
  }

  private openSpan(): boolean {
    if (this.spanOpen) return false;
    this.ci(); // interned OUTSIDE the span: it references nothing
    this.mb.beginRecGroup();
    this.spanOpen = true;
    return true;
  }

  private closeSpan(): void {
    this.spanOpen = false;
    this.mb.endRecGroup();
  }
}
