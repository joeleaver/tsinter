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
import { buildClassGraph, type LlClassMeta } from "../llvm/classes.js";
import { type FieldType, I32, ModuleBuilder, type ValType } from "./module.js";

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
}

export class ClassBuilder {
  private readonly metaMap: Map<string, LlClassMeta>;
  private readonly infos = new Map<string, ClassInfo | null>();
  private readonly ciGlobals = new Map<string, number>();
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
    this.ciType ??= this.mb.openStructType("class:ci", [
      { storage: I32, mutable: false },
      { storage: I32, mutable: false },
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

  /** The emitted shape for a class, or null when the class is out of tier
   * (refusal recorded unless `soft`). */
  info(className: string, loc: SrcLoc | undefined, soft: boolean): ClassInfo | null {
    const cached = this.infos.get(className);
    if (cached !== undefined) {
      if (cached === null && !soft) this.refuseClass(className, loc);
      return cached;
    }
    const meta = this.metaMap.get(className);
    if (meta === undefined || this.rootKind(meta) !== "user") {
      this.infos.set(className, null);
      if (!soft) this.refuseClass(className, loc);
      return null;
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
    this.deps.refuse(this.rootKind(meta) === "error" ? "class:extends-error" : "class:extends-runtime", loc);
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
    const fields: FieldType[] = [];
    if (meta.hierarchy) fields.push({ storage: this.ciRef(), mutable: false });
    for (const f of meta.def.fields) fields.push({ storage: this.deps.softType(f.type), mutable: true });
    this.mb.defineType(struct, {
      kind: "struct",
      fields,
      sub: { supers: base === null ? [] : [base.struct], final: meta.children.length === 0 },
    });
    if (opened) this.closeSpan();
    return info;
  }

  /** A base's shape, planning it if it is new. Goes through the cache so
   * a base already in flight (a field that cycles back up) answers with
   * its reserved index instead of being planned twice. */
  private classOf(meta: LlClassMeta): ClassInfo {
    const cached = this.infos.get(meta.def.name);
    if (cached != null) return cached;
    if (cached === null) {
      throw new Error(`wasm emitter bug: ${meta.def.name} is an emitted class's base but has no shape`);
    }
    return this.plan(meta);
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
