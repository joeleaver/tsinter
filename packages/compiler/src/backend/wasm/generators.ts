/* The generator runtime the resumable lowering (statemachine.ts, once it
 * grows a generator arm) suspends over: one struct PER CHANNEL TRIPLE
 * (typeKey of the generator IrType), unlike promises.ts's promT — a
 * promise's payload rides a tagged (kind, f64, ref) triple so ONE struct
 * serves every instantiation, but a generator's `out`/`sent`/`retPark`
 * slots are STATICALLY TYPED to the triple (no tag, no runtime dispatch on
 * read), so two generators with different channels genuinely need
 * different structs. The INTERNING PATTERN — lazy, cached by key, built
 * once per module — is the part this mirrors from promises.ts; the
 * "one struct for everything" trick does not carry over.
 *
 * A generator involves NO event loop: `.next()`/`.return()`/`.throw()`
 * drive `resume` synchronously and read the answer synchronously off the
 * struct's own slots. There is no subscribe/settle/waiter/microtask
 * machinery here — see promises.ts for that; generators need none of it.
 *
 * FIELD LAYOUT (design doc's Representation section):
 *   state:   mut i32                     UNSTARTED/SUSPENDED/RUNNING/DONE
 *   out:     mut <V>                     the IteratorResult value channel
 *   sent:    mut <nextT>                 .next(arg)'s in-channel — OMITTED
 *                                         when nextT is the undefined unit
 *                                         (a valueless .next() channel has
 *                                         nothing to store)
 *   inject:  mut i32                     NEXT/THROW/GENRET — what this
 *                                         resume delivers on re-entry
 *   retPark: mut <retT>                  .return(v)'s parked value until
 *                                         the unwind completes
 *   frame:   mut (ref null %frameBase)
 *   resume:  mut (ref null $clos)        (frameBase) -> void, set once
 *
 * V's WASM REPRESENTATION NEVER NEEDS THE UNION'S ARMS. `out` holds the
 * genResultRecord's `value` field type verbatim (mapType's "union" arm
 * answers ONE shared base ref for every union — dispatch lives at the
 * arm-wrap/narrow sites, never at the value's storage type — so V's own
 * arm set is irrelevant here); genResultRecord's OWN value-type rule is
 * "dyn if either channel is dyn, otherwise a union (possibly the
 * synthesized unit-only one for a no-value generator)" — this builder
 * reproduces exactly that TWO-WAY branch (dyn vs. union-base), never the
 * frontend's full arm-collection logic, and needs no ShapeRegistry/
 * UnionRegistry access to get it right: this backend has neither, and
 * does not need either.
 *
 * SENT/RETPARK NEVER REFUSE, THE SAME WAY A RECORD FIELD NEVER DOES.
 * `recordInfo` maps every field through `mapTypeSoft` unconditionally and
 * decides refusal from OTHER signals (SCC membership, an unrepresentable
 * overflow value) — never from a field itself failing to map, because
 * `mapTypeSoft` has no failure mode, only a placeholder one. This builder
 * follows the identical shape: `sent`/`retPark` map through the emitter's
 * OWN `mapTypeSoft`, so — like promise/dyn/union/caught/bytes — a
 * generator's struct NEVER fails to build. Nothing about a generator
 * TYPE can be more restrictive than a record field can be; if that
 * assumption ever breaks (some channel type mapTypeSoft cannot place at
 * all), it breaks as a wrong-answer bug to fix in mapTypeSoft itself, not
 * as a refusal this builder should grow a null path for. */
import type { IrType } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

/** `state` values. */
export const GEN_UNSTARTED = 0;
export const GEN_SUSPENDED = 1;
export const GEN_RUNNING = 2;
export const GEN_DONE = 3;

/** `inject` values — what a re-entry into `resume` is delivering. */
export const INJECT_NEXT = 0;
export const INJECT_THROW = 1;
/** The GENRET sentinel (increment 10's exception-cell kind grows one tag
 * for this — see the design doc's GENRET section). Carries no payload;
 * `retPark` holds the value. Never observable outside a generator resume:
 * it originates only at an injection re-entry, and a verbatim-kept try
 * region cannot contain a yield. */
export const INJECT_GENRET = 2;

/** What the emitter owns that this builder needs. Resolved lazily (the
 * first triple that needs it interns it) — mirrors PromiseDeps. */
export interface GeneratorDeps {
  /** The open struct every `%frame.<fn>` subtypes. */
  frameBase: () => number;
  /** The ONE resume signature's (closure struct, func type) pair —
   * shared with async's, since both are `(frameBase) -> void`. */
  resumeClos: () => { clos: number; fn: number };
  /** The checked-dynamic box's ref type. */
  dynRef: () => ValType;
  /** The ONE shared ref every union value carries, whichever union it
   * statically is (unions.ts's `baseRef`). */
  unionBaseRef: () => ValType;
  /** The never-refusing type mapper (the emitter's own `mapTypeSoft`),
   * for `sent`/`retPark` — nextT/retT are arbitrary channel types, never
   * V, and (see the header) never fail to place here. */
  mapTypeSoft: (t: IrType) => ValType;
}

export interface GenInfo {
  /** The $gen<triple> struct's type index. */
  struct: number;
  /** Field indices into that struct. `sent` is -1 when nextT is the
   * undefined unit (the field does not exist — never read or written). */
  idx: {
    state: number;
    out: number;
    sent: number;
    inject: number;
    retPark: number;
    frame: number;
    resume: number;
  };
}

export class GeneratorBuilder {
  private readonly byKey = new Map<string, GenInfo>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: GeneratorDeps,
  ) {}

  /** The $gen<triple> struct for a generator IrType, building it on first
   * request and caching by the full triple (typeKey) thereafter — the
   * BUG-CLASS WARNING's "keyed by the full triple" requirement, satisfied
   * by reusing the same key `mapType`'s own generator arm and `vecKeyFor`
   * must use, so the three never drift apart (increments 6/7/10's lesson,
   * paid forward here rather than re-learned). Never fails (see header). */
  info(genT: IrType & { kind: "generator" }): GenInfo {
    const key = typeKey(genT);
    const cached = this.byKey.get(key);
    if (cached !== undefined) return cached;

    // V: dyn if EITHER channel is dyn, otherwise the one shared union
    // base ref — genResultRecord's own first branch, reproduced exactly
    // (see the header note: V's arm set is never needed here).
    const outVal: ValType =
      genT.yieldT.kind === "dyn" || genT.retT.kind === "dyn" ? this.deps.dynRef() : this.deps.unionBaseRef();

    const hasSent = genT.nextT.kind !== "undefinedT";
    const sentVal = hasSent ? this.deps.mapTypeSoft(genT.nextT) : null;
    const retParkVal = this.deps.mapTypeSoft(genT.retT);

    const frameRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.frameBase() };
    const resumeRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.resumeClos().clos };

    // Field order matches the design doc's Representation section; `sent`
    // is spliced out entirely (not merely left unused) when absent, so
    // the struct never carries a dead slot for a channel that cannot
    // hold a value.
    const fields = [
      { storage: I32, mutable: true }, // state
      { storage: outVal, mutable: true }, // out
      ...(hasSent ? [{ storage: sentVal!, mutable: true }] : []), // sent?
      { storage: I32, mutable: true }, // inject
      { storage: retParkVal, mutable: true }, // retPark
      { storage: frameRef, mutable: true }, // frame
      { storage: resumeRef, mutable: true }, // resume
    ];
    const struct = this.mb.structType(fields);

    let i = 0;
    const state = i++;
    const out = i++;
    const sent = hasSent ? i++ : -1;
    const inject = i++;
    const retPark = i++;
    const frame = i++;
    const resume = i++;

    const info: GenInfo = { struct, idx: { state, out, sent, inject, retPark, frame, resume } };
    this.byKey.set(key, info);
    return info;
  }

  /** `(ref null $gen<triple>)` — what `mapType`'s generator arm answers. */
  genRef(info: GenInfo): ValType {
    return { kind: "ref", nullable: true, typeIndex: info.struct };
  }
}
