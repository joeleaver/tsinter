/* IR → WebAssembly (WasmGC). The wasm backend consumes the SAME in-memory
 * IrModule the C and LLVM backends do (never the JSON dump) and produces a
 * binary module — bytes, not text, and not a translation unit: nothing on
 * this lane reaches clang. A .wasm has no scr_* runtime linked beside it
 * and no C ABI to conform to; the runtime surface the other two backends
 * call into becomes, over time, either emitted GC code or a host import
 * (abi.ts is the import contract — one `write` for console output today).
 *
 * ONE WALK, two sinks. `emitWasmModule` and `surveyWasmModule` run the
 * SAME emitting walk; they differ only in what `refuse` does with a
 * construct outside the tier. The emit sink THROWS at the first one —
 * the compiler contract: never partial, never guessed code. The survey
 * sink RECORDS and returns, and the walk keeps going so it can name every
 * construct the program needs: a refused expression stands in as one
 * `unreachable` (stack-polymorphic, so surrounding emission stays
 * type-consistent) with its operands unwalked — an expression's operands
 * stay unreachable work until the expression's own kind lands — and a
 * refused statement emits nothing but still descends into nested BODIES.
 * The bytes a survey walk produces are garbage by construction and are
 * never assembled; only the emit sink's walk reaches `ModuleBuilder.emit`.
 * Sharing the dispatch is what keeps the two honest: a kind the emit path
 * refuses is definitionally in the survey, which the harness asserts on
 * every refused corpus program.
 *
 * REFUSAL AT USE, NOT AT DECLARATION. The IR's declaration sections
 * (records, unions, classes, globals, FFI imports) are deliberately NOT
 * gated: every module carries the five synthesized runtime error classes
 * (%Error, %TypeError, %RangeError, %SyntaxError, %DOMException) and a
 * per-file `%loaded` global whether the program mentions them or not, so
 * gating on their PRESENCE refuses every program for something it never
 * uses. Declarations become wasm artifacts lazily, at first use: a module
 * global gets its wasm slot when a varRef/assign first names it (and its
 * TYPE is gated right there); a declaration nothing reaches emits nothing
 * and is not work. Function signatures are the one exception with a
 * twist: every function must land in the type section, so its signature
 * and locals ARE gated — but only AFTER its body walk, so the census
 * stays dominated by the body constructs that are the real work items,
 * and the placeholder types the pre-pass uses for unmappable signatures
 * can never survive into emitted bytes (the post-body gate refuses before
 * `emit()` can run). The two whole-module emission modes have no use site
 * to refuse at and so are still gated up front.
 *
 * The switches over IrStmt/IrExpr list EVERY member with an exhaustive
 * `never` default (docs/ir.md's rule): a new IR kind breaks this build
 * loudly instead of silently falling into a generic refusal. As kinds are
 * implemented they move out of the grouped refusal arms into their own
 * case — the diff for one increment stays local, and the grouped arms
 * shrink to exactly the work that remains. */
import type {
  IrExpr,
  IrFunction,
  IrGlobal,
  IrLocal,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  SrcLoc,
} from "../../ir/nodes.js";
import { EXPORT_ENTRY, EXPORT_MEMORY, FD_STDERR, FD_STDOUT, IMPORT_MODULE, IMPORT_WRITE } from "./abi.js";
import { VecBuilder, type VecInfo } from "./arrays.js";
import { Code } from "./code.js";
import { buildF64ToStr } from "./numfmt.js";
import { F64, I32, I64, ModuleBuilder, type ValType } from "./module.js";
import { WasmUnsupportedError } from "./unsupported.js";

export { WasmUnsupportedError } from "./unsupported.js";

/** What the walk does with a construct outside the tier. The emit sink
 * throws (so everything after a refusal is unreachable on that path); the
 * survey sink records and lets the walk continue over placeholders. */
type Refuse = (kind: string, loc?: SrcLoc) => void;

function valKey(t: ValType): string {
  return t.kind === "ref" ? `r${t.nullable ? "?" : ""}${t.typeIndex}` : t.kind;
}

export function emitWasmModule(mod: IrModule): Uint8Array {
  const asm = new Assembler(mod, (kind, loc) => {
    throw new WasmUnsupportedError(kind, loc);
  });
  asm.run();
  return asm.finish();
}

/** Every distinct construct this module needs from the wasm backend, in
 * first-encountered order — the work queue behind one program. Nothing
 * throws and nothing is assembled: this answers "what would it take to
 * compile this?", not "does it compile?". */
export function surveyWasmModule(mod: IrModule): string[] {
  const seen = new Set<string>();
  new Assembler(mod, (kind) => {
    seen.add(kind);
  }).run();
  return [...seen];
}


/* ── per-function state ────────────────────────────────────────────────── */

interface FnState {
  fn: IrFunction;
  code: Code;
  /** IR local id → wasm local index (params first, then the rest in
   * locals[] order — wasm's required layout). */
  localIndex: Map<string, number>;
  /** IR local id → its IrLocal entry, for the boxed/tdz use-site gates. */
  localById: Map<string, IrLocal>;
  /** Non-param locals' wasm types, extended by scratch allocation. */
  localsOut: ValType[];
  /** Scratch locals, pooled per type so heavy functions don't grow a
   * local per use site. */
  scratchFree: Map<string, number[]>;
  /** Structured-control nesting: every OPEN block/loop/if inside the body
   * is one label, so a br's relative immediate is (depth - 1 - targetPos).
   * All structured instructions must go through the open/close helpers or
   * this count (and every enclosed br) silently skews. */
  depth: number;
  /** Enclosing break/continue targets, innermost last. Positions are the
   * `depth` at which the target's label was opened. `continuePos` is null
   * for the targets `continue` skips (switch, labeled blocks). */
  control: { kind: "loop" | "switch" | "block"; labels: string[]; breakPos: number; continuePos: number | null }[];
}

/* ── the assembler: one walk, both sinks ───────────────────────────────── */

class Assembler {
  private readonly mb = new ModuleBuilder();
  private readonly globalById = new Map<string, IrGlobal>();
  private readonly globalWasmIndex = new Map<string, number>();
  private readonly funcIndexByName = new Map<string, number>();
  private readonly funcByName = new Map<string, IrFunction>();
  private readonly strType: number;
  private readonly cursorGlobal: number;
  private readonly writeFunc: number;
  private helpers: { stage: number; putc: number; flush: number } | null = null;
  private fn!: FnState;

  constructor(
    private readonly mod: IrModule,
    private readonly refuse: Refuse,
  ) {
    // The uniform artifact contract (abi.ts): every module imports write,
    // owns a memory, and exports it — even a pure-compute program. Hosts
    // stay one shape; the cost is one page and one trivial import.
    //
    // Strings are arrays of UTF-16 CODE UNITS — the register's stance
    // (SEMANTICS.md S002): length/indexing/identity are JS-exact,
    // lone surrogates survive storage, and UTF-8 exists only at the write
    // boundary (the stage helper transcodes, replacing lone surrogates
    // with U+FFFD exactly as Node's stdout write does). Storage is
    // MUTABLE because array.new_default/array.copy (the concat path)
    // require it — strings stay immutable by discipline: nothing outside
    // the concat builder may write an element.
    this.strType = this.mb.arrayType("i16", true);
    this.writeFunc = this.mb.importFunc(
      IMPORT_MODULE,
      IMPORT_WRITE,
      this.mb.funcType([I32, I32, I32], []),
    );
    this.mb.ensureMemory(1);
    this.cursorGlobal = this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    for (const g of mod.globals ?? []) this.globalById.set(g.id, g);
    for (const r of mod.records ?? []) this.recordShapes.set(r.id, r);
  }

  run(): void {
    // The two whole-module emission modes: library mode replaces main with
    // the profile's exported symbols, and the island's embedded npm graph
    // is an engine embedding. Neither has a use-site construct to refuse
    // at, so both are gated here.
    if (this.mod.lib !== undefined) this.refuse("module:lib");
    if (this.mod.embedded !== undefined) this.refuse("module:embedded");

    // Only REACHABLE functions exist for this backend — declaration-side
    // refusal-at-use taken to functions. The frontend synthesizes helpers
    // eagerly (%unit.strand traps, retag helpers) whether or not a call
    // survives into the IR, and an unreached function is not work: it is
    // neither declared, walked (so its constructs stay out of the census),
    // nor emitted — dead-strip for free.
    const reachable = this.reachableFunctions();
    // Pass 1: indices for every reachable function, so bodies can call
    // forward. Signatures use the SOFT type map here (placeholder i32 for
    // what the tier can't represent); the honest gate runs after each
    // body walk.
    for (const fn of this.mod.functions) {
      if (!reachable.has(fn.name)) continue;
      // Uniform ABI: arg0 is the closure (see the closures block) — the
      // function type IS the signature's closure-pair fn type.
      this.funcIndexByName.set(fn.name, this.mb.declareFunc(this.fnClosPair(fn).fn, fn.name));
      this.funcByName.set(fn.name, fn);
    }

    for (const fn of this.mod.functions) {
      if (reachable.has(fn.name)) this.walkFunction(fn);
    }

    const entry = this.funcIndexByName.get(this.mod.entry);
    const entryFn = this.funcByName.get(this.mod.entry);
    if (entry === undefined || entryFn === undefined) {
      throw new Error(`entry function "${this.mod.entry}" not in module`);
    }
    // _start is ()→() while %main carries the closure arg — a 2-instruction
    // wrapper bridges.
    const start = this.mb.declareFunc(this.mb.funcType([], []), "%w.start");
    {
      const c = new Code();
      c.refNull(this.fnClosPair(entryFn).clos);
      c.call(entry);
      this.mb.setBody(start, [], c.bytes());
    }
    this.mb.exportFunc(EXPORT_ENTRY, start);
    this.mb.exportMemory(EXPORT_MEMORY);
  }

  finish(): Uint8Array {
    return this.mb.emit();
  }

  /** The entry's transitive closure over function-name references, found
   * by a GENERIC deep scan of each reached function's IR: any string
   * value that names a module function is an edge. Deliberately blunt —
   * per-kind field enumeration would silently miss the edge a new expr
   * kind carries, while the scan can only OVER-approximate (a strLit
   * spelling a function's exact "%"-name — no real program), which merely
   * keeps a function alive. Class-method edges (virtualCall composes
   * "%Class.method" from two fields) are the known gap; classes refuse at
   * use today, and their edge enumeration joins with their emission. */
  private reachableFunctions(): Set<string> {
    const names = new Set(this.mod.functions.map((f) => f.name));
    const byName = new Map(this.mod.functions.map((f) => [f.name, f]));
    const reachable = new Set<string>([this.mod.entry]);
    const queue = [this.mod.entry];
    const scan = (node: unknown): void => {
      if (typeof node === "string") {
        if (names.has(node) && !reachable.has(node)) {
          reachable.add(node);
          queue.push(node);
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) scan(item);
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const value of Object.values(node)) scan(value);
      }
    };
    while (queue.length > 0) {
      const fn = byName.get(queue.pop()!);
      if (fn !== undefined) scan(fn.body);
    }
    return reachable;
  }

  /** The string valtype — nullable in every binding position (a local is
   * NULL until its first assign; definite assignment keeps reads off it). */
  private get strRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strType };
  }

  /* ── closures ───────────────────────────────────────────────────────────
   *
   * A function VALUE is a closure struct; per IR SIGNATURE one mutually
   * recursive pair exists:
   *
   *   rec $clos = sub open (struct (field code (ref $fn)))
   *       $fn   = func (param (ref null $clos) ...params) → results
   *
   * Every module function takes the closure as arg0 (direct calls pass
   * ref.null — one dead argument buys one uniform ABI, so a function can
   * be called directly AND flow as a value). A function with captures
   * gets an ENV subtype of $clos adding one box-ref field per capture in
   * captures[] order; its prologue ref.casts arg0 down and unpacks the
   * boxes into locals. Captured variables live in one-field mutable BOX
   * structs shared by reference — a boxed local's slot holds the box,
   * and every read/write goes through it, in the declaring function too.
   * Zero-capture closures intern per function (f === f, JS identity). */

  private readonly closSigs = new Map<string, { clos: number; fn: number }>();
  private readonly closInternGlobals = new Map<string, number>();

  /** The (closure struct, function type) pair for a wasm-level signature. */
  private closPairFor(params: ValType[], results: ValType[]): { clos: number; fn: number } {
    const key = `${params.map(valKey).join(",")}=>${results.map(valKey).join(",")}`;
    const cached = this.closSigs.get(key);
    if (cached !== undefined) return cached;
    const base = this.mb.recGroup2(`closrec:${key}`, (b) => [
      {
        kind: "struct",
        fields: [{ storage: { kind: "ref", nullable: false, typeIndex: b + 1 }, mutable: false }],
        sub: { supers: [], final: false },
      },
      {
        kind: "func",
        params: [{ kind: "ref", nullable: true, typeIndex: b }, ...params],
        results,
      },
    ]);
    const made = { clos: base, fn: base + 1 };
    this.closSigs.set(key, made);
    return made;
  }

  /** The pair for an IR func TYPE — honest refusals for unmappable
   * components; rest-marked values live behind the dyn boundary. */
  private closSigFor(t: IrType & { kind: "func" }, loc: SrcLoc | undefined): { clos: number; fn: number } | null {
    if (t.rest === true) {
      this.refuse("type:func-rest", loc);
      return null;
    }
    const params: ValType[] = [];
    for (const p of t.params) {
      const v = this.mapType(p, loc);
      if (v === null) return null;
      params.push(v);
    }
    let results: ValType[] = [];
    if (t.ret.kind !== "void") {
      const r = this.mapType(t.ret, loc);
      if (r === null) return null;
      results = [r];
    }
    return this.closPairFor(params, results);
  }

  /** The pair for a declared FUNCTION's own signature (soft — pass 1). */
  private fnClosPair(fn: IrFunction): { clos: number; fn: number } {
    const params = fn.params.map((p) => this.mapTypeSoft(p.type));
    const results = fn.returnType.kind === "void" ? [] : [this.mapTypeSoft(fn.returnType)];
    return this.closPairFor(params, results);
  }

  /* ── records ────────────────────────────────────────────────────────────
   * One mutable GC struct per shape, fields in CANONICAL (sorted) order —
   * the shape's identity. recordLit allocates with defaults and fills in
   * SOURCE order (JS evaluation order), so canonical layout never
   * reorders effects. Index-signature (overflow) shapes wait on the map
   * runtime; shapes recursive through their own fields wait on multi-type
   * rec-group emission. */

  private readonly recordInfos = new Map<string, { struct: number; fieldIndex: Map<string, number> } | null>();
  private readonly recordShapes = new Map<string, IrRecordShape>();
  private readonly recordInFlight = new Set<string>();

  private recordInfo(shapeId: string, loc: SrcLoc | undefined, soft: boolean): { struct: number; fieldIndex: Map<string, number> } | null {
    const cached = this.recordInfos.get(shapeId);
    if (cached !== undefined) {
      if (cached === null && !soft) this.refuseRecord(shapeId, loc);
      return cached;
    }
    const shape = this.recordShapes.get(shapeId);
    if (shape === undefined) throw new Error(`unknown record shape ${shapeId}`);
    if (shape.indexValue !== undefined || this.recordInFlight.has(shapeId)) {
      this.recordInfos.set(shapeId, null);
      if (!soft) this.refuseRecord(shapeId, loc);
      return null;
    }
    this.recordInFlight.add(shapeId);
    const fields = shape.fields.map((f) => ({ storage: this.mapTypeSoft(f.type), mutable: true }));
    this.recordInFlight.delete(shapeId);
    // A self-recursive shape poisoned its own cache entry while its
    // fields mapped — keep the refusal, never the placeholder struct.
    if (this.recordInfos.get(shapeId) === null) {
      if (!soft) this.refuseRecord(shapeId, loc);
      return null;
    }
    const struct = this.mb.structType(fields);
    const made = { struct, fieldIndex: new Map(shape.fields.map((f, i) => [f.name, i])) };
    this.recordInfos.set(shapeId, made);
    return made;
  }

  private refuseRecord(shapeId: string, loc: SrcLoc | undefined): void {
    const shape = this.recordShapes.get(shapeId);
    this.refuse(
      shape?.indexValue !== undefined ? "record:index-signature" : "record:recursive",
      loc,
    );
  }

  /** One-field mutable box per captured-value representation; ref-typed
   * payloads store nullable (the TDZ-empty state). */
  private boxTypeFor(v: ValType): number {
    const storage: ValType = v.kind === "ref" ? { ...v, nullable: true } : v;
    return this.mb.structType([{ storage, mutable: true }]);
  }

  private boxRefFor(v: ValType): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.boxTypeFor(v) };
  }

  /** The env struct for a function with captures: code + one box ref per
   * capture, a subtype of the signature's closure struct. */
  private envTypeFor(fn: IrFunction): number {
    const pair = this.fnClosPair(fn);
    return this.mb.subStructType(
      `env:${fn.name}`,
      [
        { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
        ...(fn.captures ?? []).map((c) => ({ storage: this.boxRefFor(this.mapTypeSoft(c.type)), mutable: false })),
      ],
      pair.clos,
    );
  }

  /* ── types ──────────────────────────────────────────────────────────── */

  /** The tier's value representations: f64 as itself, bool as i32, string
   * as an array of UTF-16 code units (S002; nullable in binding positions
   * — a refcounted local is NULL until its first assign, and the
   * frontend's definite-assignment guarantee means no read observes it).
   * Everything else is unrepresented work. */
  private mapType(t: IrType, loc: SrcLoc | undefined): ValType | null {
    switch (t.kind) {
      case "f64":
        return F64;
      case "bool":
        return I32;
      case "string":
        return { kind: "ref", nullable: true, typeIndex: this.strType };
      case "array": {
        // Recursive: the ELEMENT representation is what can refuse.
        const info = this.vecInfoFor(t, loc);
        return info === null ? null : this.vecs.vecRef(info);
      }
      case "func": {
        const pair = this.closSigFor(t, loc);
        return pair === null ? null : { kind: "ref", nullable: true, typeIndex: pair.clos };
      }
      case "record": {
        const info = this.recordInfo(t.shapeId, loc, false);
        return info === null ? null : { kind: "ref", nullable: true, typeIndex: info.struct };
      }
      default:
        this.refuse(`type:${t.kind}`, loc);
        return null;
    }
  }

  /** The pre-pass variant: a placeholder for unmappable types, NO refusal.
   * Only reachable bytes matter, and a placeholder can never become one:
   * the honest gate re-maps the same types before any module is emitted. */
  private mapTypeSoft(t: IrType): ValType {
    switch (t.kind) {
      case "f64":
        return F64;
      case "bool":
        return I32;
      case "string":
        return { kind: "ref", nullable: true, typeIndex: this.strType };
      case "array": {
        // Must produce the SAME type mapType would wherever mapType
        // succeeds — a placeholder there makes two views of one
        // signature disagree, which validation catches as a call-site
        // type clash. Placeholder-elem vectors stay distinct via the key.
        const elem = this.mapTypeSoft(t.elem);
        const mappable =
          t.elem.kind === "f64" ||
          t.elem.kind === "bool" ||
          t.elem.kind === "string" ||
          t.elem.kind === "array" ||
          t.elem.kind === "func" ||
          t.elem.kind === "record";
        if (!mappable) return I32;
        const kind =
          t.elem.kind === "f64" ? "f64"
          : t.elem.kind === "bool" ? "bool"
          : t.elem.kind === "string" ? "string"
          : "ref";
        const storage = t.elem.kind === "bool" ? "i8" : elem;
        return this.vecs.vecRef(this.vecs.info(this.vecKeyFor(t), elem, storage, kind));
      }
      case "func": {
        if (t.rest === true) return I32;
        const pair = this.closPairFor(
          t.params.map((p) => this.mapTypeSoft(p)),
          t.ret.kind === "void" ? [] : [this.mapTypeSoft(t.ret)],
        );
        return { kind: "ref", nullable: true, typeIndex: pair.clos };
      }
      case "record": {
        const info = this.recordInfo(t.shapeId, undefined, true);
        return info === null ? I32 : { kind: "ref", nullable: true, typeIndex: info.struct };
      }
      default:
        return I32;
    }
  }

  /* ── functions ──────────────────────────────────────────────────────── */

  private walkFunction(fn: IrFunction): void {
    // Whole-function shapes, tested BEFORE the body: async and generators
    // need the fiber/state-machine lowering, so the constructs inside
    // their bodies are not what blocks the function and must not be
    // reported as though they were.
    if (fn.async === true) this.refuse("fn:async", fn.loc);
    if (fn.generator !== undefined) this.refuse("fn:generator", fn.loc);

    // Wasm layout: arg0 = the closure, declared params from 1. A BOXED
    // local's slot holds its box ref (all access goes through the box);
    // everything else holds its value. A boxed PARAM arrives as a raw
    // argument and is re-boxed into its own slot by the prologue — the
    // argument slot itself is never referenced again.
    const localIndex = new Map<string, number>();
    const localById = new Map<string, IrLocal>();
    for (const l of fn.locals) localById.set(l.id, l);
    const localsOut: ValType[] = [];
    const boxedParamInits: { argIndex: number; slot: number; box: number }[] = [];
    fn.params.forEach((p, i) => {
      if (localById.get(p.localId)?.boxed === true) {
        const soft = this.mapTypeSoft(p.type);
        const slot = fn.params.length + 1 + localsOut.length;
        localsOut.push(this.boxRefFor(soft));
        localIndex.set(p.localId, slot);
        boxedParamInits.push({ argIndex: i + 1, slot, box: this.boxTypeFor(soft) });
      } else {
        localIndex.set(p.localId, i + 1);
      }
    });
    for (const l of fn.locals) {
      if (localIndex.has(l.id)) continue; // a param — already indexed
      localIndex.set(l.id, fn.params.length + 1 + localsOut.length);
      const soft = this.mapTypeSoft(l.type);
      localsOut.push(l.boxed === true ? this.boxRefFor(soft) : soft);
    }
    this.fn = {
      fn,
      code: new Code(),
      localIndex,
      localById,
      localsOut,
      scratchFree: new Map(),
      depth: 0,
      control: [],
    };

    // Prologue 1: re-box captured params.
    for (const init of boxedParamInits) {
      this.fn.code.localGet(init.argIndex);
      this.fn.code.structNew(init.box);
      this.fn.code.localSet(init.slot);
    }

    // Captures prologue: downcast arg0 to this function's env and unpack
    // each capture's BOX into its slot.
    const captures = fn.captures ?? [];
    if (captures.length > 0) {
      const env = this.envTypeFor(fn);
      const code = this.fn.code;
      const envScratch = this.acquireScratch({ kind: "ref", nullable: true, typeIndex: env });
      code.localGet(0);
      code.refCast(env);
      code.localSet(envScratch);
      captures.forEach((c, i) => {
        code.localGet(envScratch);
        code.structGet(env, 1 + i);
        code.localSet(this.localIndex(c.localId));
      });
      this.releaseScratch({ kind: "ref", nullable: true, typeIndex: env }, envScratch);
    }

    this.walkBody(fn.body);
    // Non-void functions never fall off the end (the frontend appends the
    // implicit return on every path — see appendImplicitUndefinedReturn),
    // but wasm validation can't see that guarantee. A trailing unreachable
    // IS the fall-through point: validation passes on the guarantee's
    // strength, and a frontend that ever breaks it traps loudly here.
    if (fn.returnType.kind !== "void") this.fn.code.unreachable();

    // The signature gate, AFTER the body: the census should surface the
    // body's constructs (the real work items), not the types they imply —
    // a type: refusal here means a function whose body is fully in-tier
    // still binds a representation the tier lacks.
    for (const p of fn.params) this.mapType(p.type, fn.loc);
    if (fn.returnType.kind !== "void") this.mapType(fn.returnType, fn.loc);
    for (const l of fn.locals) {
      if (!fn.params.some((p) => p.localId === l.id)) this.mapType(l.type, fn.loc);
    }

    const index = this.funcIndexByName.get(fn.name);
    if (index === undefined) throw new Error(`walked undeclared function "${fn.name}"`);
    this.mb.setBody(index, this.fn.localsOut, this.fn.code.bytes());
  }

  private walkBody(body: IrStmt[]): void {
    for (const s of body) this.walkStmt(s);
  }

  /* ── structured control ─────────────────────────────────────────────── */

  /* Every structured instruction in FUNCTION BODIES goes through these so
   * fn.depth stays exact — a raw code.block()/ifVoid() here would skew the
   * relative immediate of every br crossing it. (The self-contained runtime
   * helpers below emit their own Code with hand-counted depths and never
   * touch fn state.) Each open* returns the new label's position for brTo. */

  private openBlock(): number {
    this.fn.code.block();
    return this.fn.depth++;
  }

  private openLoop(): number {
    this.fn.code.loop();
    return this.fn.depth++;
  }

  private openIf(): void {
    this.fn.code.ifVoid();
    this.fn.depth++;
  }

  private openIfResult(t: ValType): void {
    this.fn.code.ifResult(t);
    this.fn.depth++;
  }

  private close(): void {
    this.fn.code.end();
    this.fn.depth--;
  }

  private brTo(pos: number, conditional: boolean): void {
    const rel = this.fn.depth - 1 - pos;
    if (rel < 0) throw new Error("br target outside the current nesting");
    if (conditional) this.fn.code.brIf(rel);
    else this.fn.code.br(rel);
  }

  /** break/continue → the innermost matching control entry (the IR
   * validator guarantees one exists). Unlabeled break binds to loop or
   * switch (labeled blocks are skipped); continue only ever binds to a
   * loop, skipping switches in between. */
  private resolveJump(kind: "break" | "continue", label: string | undefined): number | null {
    for (let i = this.fn.control.length - 1; i >= 0; i--) {
      const c = this.fn.control[i]!;
      if (label !== undefined) {
        if (!c.labels.includes(label)) continue;
        if (kind === "break") return c.breakPos;
        if (c.continuePos !== null) return c.continuePos;
        continue;
      }
      if (kind === "break" && (c.kind === "loop" || c.kind === "switch")) return c.breakPos;
      if (kind === "continue" && c.kind === "loop") return c.continuePos!;
    }
    // Unresolved ⇒ the target is a REFUSED container (it never pushed an
    // entry), which only the survey path walks into — the emit sink threw
    // at the container itself. The validator guarantees source jumps
    // resolve, so no other path reaches null.
    return null;
  }

  /* ── statements ─────────────────────────────────────────────────────── */

  private walkStmt(s: IrStmt): void {
    const code = this.fn.code;
    switch (s.kind) {
      case "exprStmt":
        this.walkExpr(s.expr);
        // A refused expression's `unreachable` placeholder is
        // stack-polymorphic, so the drop stays valid on the survey path.
        if (s.expr.type.kind !== "void") code.drop();
        return;
      case "varDecl": {
        const local = this.fn.localById.get(s.localId);
        if (local?.boxed === true) {
          // A FRESH box per execution — a loop's `let` binds per
          // iteration, so closures made in iteration k must not see
          // iteration k+1's writes. init:null is the TDZ-empty box.
          const box = this.boxTypeFor(this.mapTypeSoft(local.type));
          if (s.init !== null) {
            this.walkExpr(s.init);
            code.structNew(box);
          } else {
            code.structNewDefault(box);
          }
          code.localSet(this.localIndex(s.localId));
          return;
        }
        // Declared-uninitialized needs nothing: wasm locals are zeroed and
        // the frontend's definite-assignment guarantee (see IrStmt varDecl)
        // means no read precedes the first assign.
        if (s.init !== null) this.storeVar(s.localId, s.init, s.loc);
        return;
      }
      case "assign":
        this.storeVar(s.localId, s.value, s.loc);
        return;
      case "return":
        if (s.value !== null) this.walkExpr(s.value);
        code.return_();
        return;
      case "if":
        this.walkExpr(s.cond);
        this.openIf();
        this.walkBody(s.then);
        if (s.else_ !== null) {
          code.else_();
          this.walkBody(s.else_);
        }
        this.close();
        return;

      case "while": {
        // block B { loop C { cond eqz br_if→B; body; br→C } } — the loop
        // head IS the condition, which is exactly where JS continue lands.
        const breakPos = this.openBlock();
        const continuePos = this.openLoop();
        this.fn.control.push({ kind: "loop", labels: s.labels ?? [], breakPos, continuePos });
        this.walkExpr(s.cond);
        code.i32Eqz();
        this.brTo(breakPos, true);
        this.walkBody(s.body);
        this.brTo(continuePos, false);
        this.fn.control.pop();
        this.close();
        this.close();
        return;
      }

      case "doWhile": {
        // block B { loop L { block C { body } cond br_if→L } } — continue
        // exits the body block and lands at the condition, JS-exact.
        const breakPos = this.openBlock();
        const loopPos = this.openLoop();
        const continuePos = this.openBlock();
        this.fn.control.push({ kind: "loop", labels: s.labels ?? [], breakPos, continuePos });
        this.walkBody(s.body);
        this.fn.control.pop();
        this.close();
        this.walkExpr(s.cond);
        this.brTo(loopPos, true);
        this.close();
        this.close();
        return;
      }

      case "for": {
        // init; block B { loop L { cond? eqz br_if→B; block C { body }
        // update; br→L } } — continue exits to the UPDATE, JS-exact.
        if (s.init !== null) this.walkStmt(s.init);
        const breakPos = this.openBlock();
        const loopPos = this.openLoop();
        if (s.cond !== null) {
          this.walkExpr(s.cond);
          code.i32Eqz();
          this.brTo(breakPos, true);
        }
        const continuePos = this.openBlock();
        this.fn.control.push({ kind: "loop", labels: s.labels ?? [], breakPos, continuePos });
        this.walkBody(s.body);
        this.fn.control.pop();
        this.close();
        // JS `for (let i ...)`: each iteration gets a FRESH binding
        // holding a copy of the previous one, and the UPDATE mutates the
        // fresh binding — that's why closures made in iteration k keep
        // seeing iteration k's value. Only observable (and only emitted)
        // when the loop variable is captured; continue lands here too.
        if (s.init?.kind === "varDecl") {
          const initLocal = this.fn.localById.get(s.init.localId);
          if (initLocal?.boxed === true) {
            const box = this.boxTypeFor(this.mapTypeSoft(initLocal.type));
            const slot = this.localIndex(s.init.localId);
            code.localGet(slot);
            code.structGet(box, 0);
            code.structNew(box);
            code.localSet(slot);
          }
        }
        if (s.update !== null) this.walkStmt(s.update);
        this.brTo(loopPos, false);
        this.close();
        this.close();
        return;
      }

      case "block": {
        const breakPos = this.openBlock();
        this.fn.control.push({ kind: "block", labels: s.labels ?? [], breakPos, continuePos: null });
        this.walkBody(s.body);
        this.fn.control.pop();
        this.close();
        return;
      }

      case "break":
      case "continue": {
        const pos = this.resolveJump(s.kind, s.label);
        if (pos === null) {
          // Survey path, jump into a refused container: unreachable is
          // terminal exactly like the br would have been, keeping the
          // discarded bytes' stack shape.
          code.unreachable();
          return;
        }
        this.brTo(pos, false);
        return;
      }

      case "switch":
        this.emitSwitch(s);
        return;

      case "arraySet": {
        const at = s.arr.type;
        if (at.kind !== "array") throw new Error("arraySet on a non-array receiver");
        const info = this.vecInfoFor(at, s.loc);
        if (info === null) return; // elem-type refusal already recorded
        this.walkExpr(s.arr);
        this.walkExpr(s.index);
        this.walkExpr(s.value);
        code.call(this.vecs.set(info));
        return;
      }

      case "forOf": {
        const it = s.iterable.type;
        if (it.kind !== "array") {
          // for-of over a string iterates CODE POINTS — its own lowering.
          this.refuse(`forOf:${it.kind}`, s.loc);
          this.walkBody(s.body);
          return;
        }
        const info = this.vecInfoFor(it, s.loc);
        if (info === null) {
          this.walkBody(s.body);
          return;
        }
        // Ascending index, LENGTH RE-READ each pass (JS-exact for arrays:
        // a body that pushes extends the loop, one that pops shortens
        // it). Direct buffer reads — the guard keeps the index in bounds.
        const vec = this.acquireScratch(this.vecs.vecRef(info));
        const i = this.acquireScratch(I32);
        this.walkExpr(s.iterable);
        code.localSet(vec);
        code.i32Const(0);
        code.localSet(i);
        const breakPos = this.openBlock();
        const loopPos = this.openLoop();
        code.localGet(i);
        code.localGet(vec);
        code.structGet(info.struct, 0);
        code.i32GeS();
        this.brTo(breakPos, true);
        code.localGet(vec);
        code.structGet(info.struct, 1);
        code.localGet(i);
        this.vecs.emitElemRead(code, info);
        {
          // A captured loop binding gets a FRESH box per iteration —
          // closures made in pass k keep pass k's element.
          const bindingLocal = this.fn.localById.get(s.localId);
          if (bindingLocal?.boxed === true) {
            code.structNew(this.boxTypeFor(this.mapTypeSoft(bindingLocal.type)));
          }
        }
        code.localSet(this.localIndex(s.localId));
        const continuePos = this.openBlock();
        this.fn.control.push({ kind: "loop", labels: s.labels ?? [], breakPos, continuePos });
        this.walkBody(s.body);
        this.fn.control.pop();
        this.close();
        code.localGet(i);
        code.i32Const(1);
        code.i32Add();
        code.localSet(i);
        this.brTo(loopPos, false);
        this.close();
        this.close();
        this.releaseScratch(I32, i);
        this.releaseScratch(this.vecs.vecRef(info), vec);
        return;
      }

      case "recordSet": {
        const info = this.recordInfo(s.shapeId, s.loc, false);
        if (info === null) return; // shape refusal already recorded
        const idx = info.fieldIndex.get(s.field);
        if (idx === undefined) throw new Error(`recordSet field ${s.field} not on shape ${s.shapeId}`);
        this.walkExpr(s.obj);
        this.walkExpr(s.value);
        code.structSet(info.struct, idx);
        return;
      }

      /* Stores into composites — each waits on the GC shape of the thing
       * being written (bytes on the typed-array runtime, fieldSet on
       * classes, the recordKey pair on the overflow map). */
      case "bytesSet":
      case "fieldSet":
      case "recordKeySet":
      case "recordKeyDelete":
        this.refuse(`stmt:${s.kind}`, s.loc);
        break;

      case "runtimeFence":
        // SC9002 is the checker-proved-unreachable fallthrough trap
        // (appendImplicitUndefinedReturn): wasm's own `unreachable` IS
        // that trap — reached only if the checker's proof is wrong, and
        // then it fails loudly. Every other code is a JS deferred fence:
        // a REACHABLE catchable throw, which waits on the exception
        // protocol with the rest below.
        if (s.code === "SC9002") {
          code.unreachable();
          return;
        }
        this.refuse(`stmt:${s.kind}`, s.loc);
        break;

      /* The exception protocol (wasm exception handling, or a lowered
       * pending-flag unwind like the other two backends run). */
      case "throw":
      case "rethrow":
      case "tryCatch":
        this.refuse(`stmt:${s.kind}`, s.loc);
        break;

      default: {
        const rest: never = s;
        this.refuse(`stmt:${(rest as IrStmt).kind}`, (rest as IrStmt).loc);
        return;
      }
    }
    this.walkNested(s);
  }

  /** A local or global write — `assign` and non-boxed varDecl share it.
   * Globals live in the "%g." namespace (IrGlobal docs) and get their wasm
   * slot lazily, right here at first use; a boxed local writes THROUGH
   * its box (the shared binding every capture sees). */
  private storeVar(localId: string, value: IrExpr, loc: SrcLoc): void {
    const global = this.globalById.get(localId);
    if (global !== undefined) {
      this.walkExpr(value);
      this.fn.code.globalSet(this.globalIndex(global, loc));
      return;
    }
    const local = this.fn.localById.get(localId);
    if (local?.boxed === true) {
      const box = this.boxTypeFor(this.mapTypeSoft(local.type));
      this.fn.code.localGet(this.localIndex(localId));
      this.walkExpr(value);
      this.fn.code.structSet(box, 0);
      return;
    }
    this.walkExpr(value);
    this.fn.code.localSet(this.localIndex(localId));
  }

  /** Nested statement bodies of REFUSED statements. Only the survey path
   * reaches this — the emit sink threw above. Exhaustive like the dispatch
   * it follows, so a new container kind cannot silently hide its body from
   * the survey. (Implemented containers walk their bodies inline in
   * walkStmt and return before this.) */
  private walkNested(s: IrStmt): void {
    switch (s.kind) {
      case "tryCatch":
        this.walkBody(s.tryBody);
        if (s.catchBody !== null) this.walkBody(s.catchBody);
        if (s.finallyBody !== null) this.walkBody(s.finallyBody);
        break;
      /* Leaf statements: nothing nested to descend into. */
      case "varDecl":
      case "assign":
      case "exprStmt":
      case "return":
      case "if":
      case "while":
      case "doWhile":
      case "for":
      case "switch":
      case "block":
      case "forOf":
      case "arraySet":
      case "bytesSet":
      case "fieldSet":
      case "recordSet":
      case "recordKeySet":
      case "recordKeyDelete":
      case "break":
      case "continue":
      case "throw":
      case "rethrow":
      case "runtimeFence":
        break;
      default: {
        const rest: never = s;
        void rest;
      }
    }
  }

  /* ── expressions ────────────────────────────────────────────────────── */

  /** Emits the expression's value onto the wasm stack. On refusal (survey
   * path) the value is one `unreachable` and the operands stay unwalked. */
  private walkExpr(e: IrExpr): void {
    const code = this.fn.code;
    switch (e.kind) {
      case "boolLit":
        code.i32Const(e.value ? 1 : 0);
        return;
      case "numLit":
        code.f64Const(e.value);
        return;
      case "strLit":
        this.pushStrLit(e.value);
        return;
      case "varRef": {
        const global = this.globalById.get(e.localId);
        if (global !== undefined) {
          code.globalGet(this.globalIndex(global, e.loc));
          return;
        }
        const local = this.fn.localById.get(e.localId);
        if (local?.boxed === true) {
          const box = this.boxTypeFor(this.mapTypeSoft(local.type));
          code.localGet(this.localIndex(e.localId));
          code.structGet(box, 0);
          // A TDZ box reads null until its source-position assign runs;
          // the trap stands in for the catchable ReferenceError until the
          // exception protocol lands.
          if (local.tdz === true) code.refAsNonNull();
          return;
        }
        code.localGet(this.localIndex(e.localId));
        return;
      }
      case "call": {
        const callee = this.funcByName.get(e.callee);
        const index = this.funcIndexByName.get(e.callee);
        if (callee === undefined || index === undefined) {
          throw new Error(`call to unknown function "${e.callee}"`);
        }
        // Direct calls pass a null closure — the uniform-ABI dead arg.
        code.refNull(this.fnClosPair(callee).clos);
        for (const a of e.args) this.walkExpr(a);
        code.call(index);
        return;
      }

      case "closure": {
        const callee = this.funcByName.get(e.fnName);
        const index = this.funcIndexByName.get(e.fnName);
        if (callee === undefined || index === undefined) {
          throw new Error(`closure over unknown function "${e.fnName}"`);
        }
        this.mb.declareFuncRef(index);
        if (e.captures.length === 0) {
          // Interned: `f === f` is true for a top-level function value.
          const pair = this.fnClosPair(callee);
          let g = this.closInternGlobals.get(e.fnName);
          if (g === undefined) {
            g = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: pair.clos }, true, (w) => {
              w.u8(0xd0);
              w.sleb(pair.clos);
            });
            this.closInternGlobals.set(e.fnName, g);
          }
          code.globalGet(g);
          code.refIsNull();
          this.openIf();
          code.refFunc(index);
          code.structNew(pair.clos);
          code.globalSet(g);
          this.close();
          code.globalGet(g);
          return;
        }
        // captures[] is in the CALLEE's captures order; each is a boxed
        // local of the creating function, whose slot IS the box ref.
        const env = this.envTypeFor(callee);
        code.refFunc(index);
        for (const capturedId of e.captures) code.localGet(this.localIndex(capturedId));
        code.structNew(env);
        return;
      }

      case "callValue": {
        const ct = e.callee.type;
        if (ct.kind !== "func") throw new Error("callValue on a non-func callee");
        const pair = this.closSigFor(ct, e.loc);
        if (pair === null) {
          code.unreachable();
          return;
        }
        const closRef: ValType = { kind: "ref", nullable: true, typeIndex: pair.clos };
        const c = this.acquireScratch(closRef);
        this.walkExpr(e.callee);
        code.localSet(c);
        code.localGet(c); // arg0: the closure itself (selfRef, env)
        for (const a of e.args) this.walkExpr(a);
        code.localGet(c);
        code.structGet(pair.clos, 0);
        code.callRef(pair.fn);
        this.releaseScratch(closRef, c);
        return;
      }

      case "selfRef":
        // The running closure — arg0, exactly.
        code.localGet(0);
        return;

      case "bin":
        this.emitBin(e);
        return;

      case "unary":
        switch (e.op) {
          case "-":
            this.walkExpr(e.operand);
            code.f64Neg();
            return;
          case "!":
            this.walkExpr(e.operand);
            code.i32Eqz();
            return;
          case "~":
            this.walkExpr(e.operand);
            code.call(this.toInt32Helper());
            code.i32Const(-1);
            code.i32Xor();
            code.f64ConvertI32S();
            return;
        }
        return;

      case "incDec": {
        // Read, write ±1, yield old (postfix) or new (prefix). Locals use
        // tee / a stacked pre-read; globals re-read after the set (nothing
        // else can write between — single-threaded).
        const add = (): void => {
          code.f64Const(1);
          if (e.op === "+") code.f64Add();
          else code.f64Sub();
        };
        const global = this.globalById.get(e.localId);
        if (global !== undefined) {
          const idx = this.globalIndex(global, e.loc);
          if (e.prefix) {
            code.globalGet(idx);
            add();
            code.globalSet(idx);
            code.globalGet(idx);
          } else {
            code.globalGet(idx); // the result: the old value
            code.globalGet(idx);
            add();
            code.globalSet(idx);
          }
          return;
        }
        const local = this.fn.localById.get(e.localId);
        const idx = this.localIndex(e.localId);
        if (local?.boxed === true) {
          const box = this.boxTypeFor(F64);
          const n = this.acquireScratch(F64);
          if (e.prefix) {
            code.localGet(idx);
            code.localGet(idx);
            code.structGet(box, 0);
            add();
            code.localSet(n);
            code.localGet(n);
            code.structSet(box, 0);
            code.localGet(n); // the result: the new value
          } else {
            code.localGet(idx);
            code.structGet(box, 0);
            code.localSet(n); // the old value
            code.localGet(idx);
            code.localGet(n);
            add();
            code.structSet(box, 0);
            code.localGet(n); // the result: the old value
          }
          this.releaseScratch(F64, n);
          return;
        }
        if (e.prefix) {
          code.localGet(idx);
          add();
          code.localTee(idx);
        } else {
          code.localGet(idx); // the result: the old value
          code.localGet(idx);
          add();
          code.localSet(idx);
        }
        return;
      }

      case "assignExpr": {
        this.walkExpr(e.value);
        const global = this.globalById.get(e.localId);
        if (global !== undefined) {
          const idx = this.globalIndex(global, e.loc);
          code.globalSet(idx);
          code.globalGet(idx);
          return;
        }
        const local = this.fn.localById.get(e.localId);
        if (local?.boxed === true) {
          const soft = this.mapTypeSoft(local.type);
          const box = this.boxTypeFor(soft);
          const v = this.acquireScratch(soft);
          code.localSet(v);
          code.localGet(this.localIndex(e.localId));
          code.localGet(v);
          code.structSet(box, 0);
          code.localGet(v); // the assigned value is the result
          this.releaseScratch(soft, v);
          return;
        }
        code.localTee(this.localIndex(e.localId));
        return;
      }

      case "toBool": {
        const k = e.operand.type.kind;
        if (k === "bool") {
          this.walkExpr(e.operand);
          return;
        }
        if (k === "array" || k === "func" || k === "record") {
          // Every object is truthy; evaluate for effects, answer true.
          this.walkExpr(e.operand);
          code.drop();
          code.i32Const(1);
          return;
        }
        if (k === "f64" || k === "string") {
          this.walkExpr(e.operand);
          const t = k === "f64" ? F64 : this.strRef;
          const s = this.acquireScratch(t);
          code.localSet(s);
          this.emitTruthiness(k, s);
          this.releaseScratch(t, s);
          return;
        }
        // Union operands wait on the union representation (the per-arm
        // ToBoolean helper comes with it).
        this.refuse(`toBool:${k}`, e.loc);
        code.unreachable();
        return;
      }

      case "logical": {
        const k = e.type.kind;
        if (k !== "f64" && k !== "string" && k !== "bool") {
          this.refuse(`logical:${k}`, e.loc);
          code.unreachable();
          return;
        }
        // JS value semantics: the result is the deciding operand itself,
        // so the left lands in a scratch its truthiness test reads and the
        // untaken side republishes.
        const t = k === "f64" ? F64 : k === "bool" ? I32 : this.strRef;
        this.walkExpr(e.left);
        const s = this.acquireScratch(t);
        code.localSet(s);
        this.emitTruthiness(k, s);
        this.openIfResult(t);
        if (e.op === "&&") this.walkExpr(e.right);
        else code.localGet(s);
        code.else_();
        if (e.op === "&&") code.localGet(s);
        else this.walkExpr(e.right);
        this.close();
        this.releaseScratch(t, s);
        return;
      }

      case "ternary": {
        if (e.type.kind === "void") {
          // Both arms are void calls (`c ? f() : g()` in statement
          // position) — a plain if.
          this.walkExpr(e.cond);
          this.openIf();
          this.walkExpr(e.then);
          code.else_();
          this.walkExpr(e.else_);
          this.close();
          return;
        }
        const t = this.mapType(e.type, e.loc); // refusal names the missing representation
        if (t === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.cond);
        this.openIfResult(t);
        this.walkExpr(e.then);
        code.else_();
        this.walkExpr(e.else_);
        this.close();
        return;
      }

      case "seqExpr":
        this.walkBody(e.stmts);
        this.walkExpr(e.result);
        return;

      case "strEq":
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        code.call(this.strEqHelper());
        if (e.negated) code.i32Eqz();
        return;

      case "strCmp": {
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        code.call(this.strCmpHelper(e.utf16 === true));
        code.i32Const(0);
        if (e.op === "<") code.i32LtS();
        else if (e.op === "<=") code.i32LeS();
        else if (e.op === ">") code.i32GtS();
        else code.i32GeS();
        return;
      }

      case "strConcat":
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        code.call(this.concatHelper());
        return;

      case "arrayLit": {
        if (e.type.kind !== "array") throw new Error("arrayLit with a non-array type");
        const info = this.vecInfoFor(e.type, e.loc);
        if (info === null) {
          code.unreachable();
          return;
        }
        const spreads = new Set(e.spreads ?? []);
        // Fast path — plain literals build the exact-size buffer straight
        // off the stack (array.new_fixed caps at 10000 operands).
        if (spreads.size === 0 && e.elems.length <= 10000) {
          code.i32Const(e.elems.length);
          for (const el of e.elems) this.walkExpr(el);
          code.arrayNewFixed(info.bufType, e.elems.length);
          code.structNew(info.struct);
          return;
        }
        // Spread path: build incrementally IN SOURCE ORDER — a spread
        // copies its source's elements at ITS position, before later
        // element expressions run (JS-exact: [...xs, xs.push(9)] must not
        // see the push in the spread's copy).
        const vec = this.acquireScratch(this.vecs.vecRef(info));
        code.i32Const(0);
        code.i32Const(0);
        code.arrayNewDefault(info.bufType);
        code.structNew(info.struct);
        code.localSet(vec);
        e.elems.forEach((el, i) => {
          code.localGet(vec);
          this.walkExpr(el);
          code.call(spreads.has(i) ? this.vecs.pushSpread(info) : this.vecs.pushOne(info));
        });
        code.localGet(vec);
        this.releaseScratch(this.vecs.vecRef(info), vec);
        return;
      }

      case "arrayNewLen": {
        if (e.type.kind !== "array") throw new Error("arrayNewLen with a non-array type");
        const info = this.vecInfoFor(e.type, e.loc);
        if (info === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.length);
        code.call(this.vecs.newLen(info));
        return;
      }

      case "arrayGet": {
        const at = e.arr.type;
        if (at.kind !== "array") throw new Error("arrayGet on a non-array receiver");
        const info = this.vecInfoFor(at, e.loc);
        if (info === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.arr);
        this.walkExpr(e.index);
        code.call(this.vecs.get(info));
        return;
      }

      case "arrIntrinsic":
        this.emitArrIntrinsic(e);
        return;

      case "recordLit": {
        if (e.type.kind !== "record") throw new Error("recordLit with a non-record type");
        const info = this.recordInfo(e.type.shapeId, e.loc, false);
        if (info === null) {
          code.unreachable();
          return;
        }
        // Allocate with defaults, fill in SOURCE order (JS evaluation
        // order) — canonical struct layout never reorders effects.
        const recRef: ValType = { kind: "ref", nullable: true, typeIndex: info.struct };
        const rec = this.acquireScratch(recRef);
        code.structNewDefault(info.struct);
        code.localSet(rec);
        for (const f of e.fields) {
          if (f.drop === true) {
            // The mapping dropped this field: the expression still runs
            // in its source-order slot; nothing stores.
            this.walkExpr(f.value);
            if (f.value.type.kind !== "void") code.drop();
            continue;
          }
          const idx = info.fieldIndex.get(f.name);
          if (idx === undefined) throw new Error(`recordLit field ${f.name} not on shape ${e.type.shapeId}`);
          code.localGet(rec);
          this.walkExpr(f.value);
          code.structSet(info.struct, idx);
        }
        code.localGet(rec);
        this.releaseScratch(recRef, rec);
        return;
      }

      case "recordGet": {
        const info = this.recordInfo(e.shapeId, e.loc, false);
        if (info === null) {
          code.unreachable();
          return;
        }
        const idx = info.fieldIndex.get(e.field);
        if (idx === undefined) throw new Error(`recordGet field ${e.field} not on shape ${e.shapeId}`);
        this.walkExpr(e.obj);
        code.structGet(info.struct, idx);
        return;
      }

      case "toString": {
        const k = e.operand.type.kind;
        if (k === "f64") {
          this.walkExpr(e.operand);
          code.call(this.f64ToStrHelper());
          return;
        }
        if (k === "bool") {
          this.walkExpr(e.operand);
          this.openIfResult(this.strRef);
          this.pushStrLit("true");
          code.else_();
          this.pushStrLit("false");
          this.close();
          return;
        }
        // Union operands dispatch per-arm, caught operands snapshot —
        // both wait on their representations.
        this.refuse(`toString:${k}`, e.loc);
        code.unreachable();
        return;
      }

      case "intrinsic":
        switch (e.name) {
          case "console.log":
            this.emitConsole(e.name, FD_STDOUT, e.args);
            return;
          case "console.error":
            this.emitConsole(e.name, FD_STDERR, e.args);
            return;
          /* The promise surface waits on the async story (IR-level
           * state-machine lowering); module.await on the async-module
           * machinery above it. */
          case "promise.race":
          case "promise.all":
          case "promise.reject":
          case "promise.resolve":
          case "module.await":
            this.refuse(`intrinsic:${e.name}`, e.loc);
            code.unreachable();
            return;
          default: {
            const rest: never = e;
            const node = rest as { name: string; loc?: SrcLoc };
            this.refuse(`intrinsic:${node.name}`, node.loc);
            code.unreachable();
            return;
          }
        }

      /* The broad libCall namespace names its member: "expr:libCall" would
       * collapse the entire runtime surface into one histogram bucket, and
       * that bucket would top the queue forever while saying nothing about
       * what to implement; the member name IS the work item. */
      case "libCall":
        this.refuse(`libCall:${e.fn}`, e.loc);
        code.unreachable();
        return;

      /* Unit values exist only inside unions; fieldIncDec with class
       * fields; nullish/orDefault are union-shaped (their tests read the
       * arm tag). */
      case "unitLit":
      case "fieldIncDec":
      case "nullish":
      case "orDefault":
      /* templateStrings is the tagged-template strings OBJECT (string[]);
       * strIntrinsic is the UTF-16-exact method surface. */
      case "templateStrings":
      case "strIntrinsic":
      /* Optional chaining's two halves (the receiver stash and the guard). */
      case "optChain":
      case "chainRecv":
      /* Regex — a whole engine, host-imported or compiled. */
      case "regexLit":
      case "regexIntrinsic":
      /* Typed arrays and the keyed collections. */
      case "bytesNew":
      case "bytesIntrinsic":
      case "mapNew":
      case "mapIntrinsic":
      case "setNew":
      case "setIntrinsic":
      /* Native FFI — a link-time C ABI, nothing to link against here. */
      case "ffiCall":
      /* Async, generators, promises. */
      case "yieldExpr":
      case "genResume":
      case "awaitExpr":
      case "awaitUnionExpr":
      case "newPromise":
      case "promiseWithResolvers":
      case "promiseVoidWiden":
      case "jsBridgePromise":
      /* Classes: GC structs, vtables for the virtual slice. */
      case "new":
      case "classRef":
      case "newValue":
      case "instanceOfValue":
      case "instanceOf":
      case "virtualCall":
      case "fieldGet":
      case "upcast":
      case "downcast":
      /* Record shapes. */
      /* The dynamic-keyed record surface rides the overflow map. */
      case "recordKeyGet":
      case "recordOvfKeys":
      /* Tagged unions. */
      case "unionWrap":
      case "unionNarrow":
      case "unionDisc":
      case "unionKeyGet":
      case "unionIsTag":
      case "unionEq":
      /* Caught-exception snapshots. */
      case "caughtTest":
      case "caughtNarrow":
      case "caughtCheck":
      case "caughtToDyn":
      /* The dyn surface. */
      case "dynFrom":
      case "dynFromJsval":
      case "dynCall":
      case "dynInvoke":
      case "dynArrLit":
      case "dynObjLit":
      case "dynTest":
      case "dynKeyGet":
      case "dynHasKey":
      case "dynScalarEq":
      case "dynDestrCheck":
      case "dynIterN":
      case "dynCheck":
      case "jsonStringify":
      /* The island bridge — an engine embedding, so likely never on this
       * backend at all. */
      case "jsMarshal":
      case "jsOp":
      case "jsExit":
        this.refuse(`expr:${e.kind}`, e.loc);
        code.unreachable();
        return;

      default: {
        const rest: never = e;
        this.refuse(`expr:${(rest as IrExpr).kind}`, (rest as IrExpr).loc);
        code.unreachable();
      }
    }
  }

  private localIndex(localId: string): number {
    const index = this.fn.localIndex.get(localId);
    if (index === undefined) {
      throw new Error(`local "${localId}" not in function "${this.fn.fn.name}"`);
    }
    return index;
  }

  private globalIndex(g: IrGlobal, loc: SrcLoc): number {
    const existing = this.globalWasmIndex.get(g.id);
    if (existing !== undefined) return existing;
    // Zero-value init per representation; the frontend's %init functions
    // perform the real initialization, exactly like the native backends.
    const type = this.mapType(g.type, loc) ?? I32; // placeholder en route to the refusal
    const index = this.mb.addGlobal(type, true, (w) => {
      switch (type.kind) {
        case "i32":
        case "i64":
          w.u8(type.kind === "i32" ? 0x41 : 0x42);
          w.sleb(0);
          break;
        case "f64":
          w.u8(0x44);
          w.f64(0);
          break;
        case "ref":
          // ref.null of the global's OWN heap type — anything else fails
          // validation the moment a non-string ref global exists.
          w.u8(0xd0);
          w.sleb(type.typeIndex);
          break;
      }
    });
    this.globalWasmIndex.set(g.id, index);
    return index;
  }

  private vecsField: VecBuilder | null = null;

  /** The per-element-type array machinery (arrays.ts), deps injected. */
  private get vecs(): VecBuilder {
    this.vecsField ??= new VecBuilder(this.mb, {
      strEq: () => this.strEqHelper(),
      f64ToStr: () => this.f64ToStrHelper(),
      concat: () => this.concatHelper(),
      lit: (c, s) => this.pushStrLitInto(c, s),
    });
    return this.vecsField;
  }

  /** The vector types for an IR array type; null (with the honest type
   * refusal already recorded) when the ELEMENT representation is out of
   * tier. The recursive key mirrors nesting: vec(vec(f64)) etc. */
  private vecInfoFor(t: IrType & { kind: "array" }, loc: SrcLoc | undefined): VecInfo | null {
    const elemVal = this.mapType(t.elem, loc);
    if (elemVal === null) return null;
    const kind =
      t.elem.kind === "f64" ? "f64"
      : t.elem.kind === "bool" ? "bool"
      : t.elem.kind === "string" ? "string"
      : "ref";
    const storage = t.elem.kind === "bool" ? "i8" : elemVal;
    return this.vecs.info(this.vecKeyFor(t), elemVal, storage, kind);
  }

  /** A DISTINCT key per element representation — `func` keys by the
   * signature's closure type index and `record` by shape id, or two
   * different func-element arrays would intern one (wrong) vector type. */
  private vecKeyFor(t: IrType): string {
    switch (t.kind) {
      case "array":
        return `vec(${this.vecKeyFor(t.elem)})`;
      case "string":
        return "str";
      case "record":
        return `rec:${t.shapeId}`;
      case "func": {
        const soft = this.mapTypeSoft(t);
        return `fn:${valKey(soft)}`;
      }
      default:
        return t.kind;
    }
  }

  private pushStrLit(value: string): void {
    this.pushStrLitInto(this.fn.code, value);
  }

  private pushStrLitInto(c: Code, value: string): void {
    // UTF-16LE code units, raw — charCodeAt preserves lone surrogates
    // (TextEncoder would replace them and break identity, S002). The
    // array.new_data offset is in BYTES into the segment, the size in
    // ELEMENTS; every interned string is even-length so offsets stay
    // element-aligned.
    const units = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
      const u = value.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    const offset = this.mb.internData(units);
    c.i32Const(offset);
    c.i32Const(value.length);
    c.arrayNewData(this.strType, 0);
  }

  /* ── operators ──────────────────────────────────────────────────────── */

  private emitBin(e: Extract<IrExpr, { kind: "bin" }>): void {
    const code = this.fn.code;
    switch (e.op) {
      case "+":
      case "-":
      case "*":
      case "/":
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        if (e.op === "+") code.f64Add();
        else if (e.op === "-") code.f64Sub();
        else if (e.op === "*") code.f64Mul();
        else code.f64Div();
        return;
      case "%":
        // No f64 remainder instruction exists; the helper is a bit-exact
        // musl fmod port (JS % IS C fmod).
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        code.call(this.fmodHelper());
        return;
      case "**":
        // Math.pow's transcendental core plus the spec's corner table —
        // its own work item.
        this.refuse("bin:**", e.loc);
        code.unreachable();
        return;
      case "<":
      case "<=":
      case ">":
      case ">=":
        // IEEE compares are already JS-exact: NaN answers false everywhere.
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        if (e.op === "<") code.f64Lt();
        else if (e.op === "<=") code.f64Le();
        else if (e.op === ">") code.f64Gt();
        else code.f64Ge();
        return;
      case "===":
      case "!==": {
        const k = e.left.type.kind;
        if (k === "f64") {
          this.walkExpr(e.left);
          this.walkExpr(e.right);
          if (e.op === "===") code.f64Eq();
          else code.f64Ne();
          return;
        }
        if (k === "bool") {
          this.walkExpr(e.left);
          this.walkExpr(e.right);
          if (e.op === "===") code.i32Eq();
          else code.i32Ne();
          return;
        }
        if (k === "array" || k === "func") {
          // Reference identity — JS object/function equality exactly
          // (zero-capture closures intern, so `f === f` holds).
          this.walkExpr(e.left);
          this.walkExpr(e.right);
          code.refEq();
          if (e.op === "!==") code.i32Eqz();
          return;
        }
        // Class values: one immortal object per class — waits on classes.
        this.refuse("bin:ref-eq", e.loc);
        code.unreachable();
        return;
      }
      case "&":
      case "|":
      case "^":
      case "<<":
      case ">>":
      case ">>>": {
        // JS ToInt32/ToUint32 share one modular truncation (the helper);
        // only the result's signedness differs. Shift counts self-mask to
        // 5 bits in wasm, which IS the JS `& 31`. The interleaved
        // evaluate-left/coerce-left order is unobservable: operands are
        // statically f64 and ToInt32 on f64 has no effects.
        this.walkExpr(e.left);
        code.call(this.toInt32Helper());
        this.walkExpr(e.right);
        code.call(this.toInt32Helper());
        if (e.op === "&") code.i32And();
        else if (e.op === "|") code.i32Or();
        else if (e.op === "^") code.i32Xor();
        else if (e.op === "<<") code.i32Shl();
        else if (e.op === ">>") code.i32ShrS();
        else code.i32ShrU();
        if (e.op === ">>>") code.f64ConvertI32U();
        else code.f64ConvertI32S();
        return;
      }
      default: {
        const rest: never = e.op;
        void rest;
      }
    }
  }

  /** Array method/property dispatch. Receiver first, then arguments in
   * source order; push evaluates every argument BEFORE appending (an
   * argument reading .length must not see earlier appends). */
  private emitArrIntrinsic(e: Extract<IrExpr, { kind: "arrIntrinsic" }>): void {
    const code = this.fn.code;
    const rt = e.receiver.type;
    if (rt.kind !== "array") throw new Error("arrIntrinsic on a non-array receiver");
    const info = this.vecInfoFor(rt, e.loc);
    if (info === null) {
      code.unreachable();
      return;
    }
    const vecLen = (): void => {
      code.structGet(info.struct, 0);
      code.f64ConvertI32S();
    };
    switch (e.method) {
      case "length":
        this.walkExpr(e.receiver);
        vecLen();
        return;
      case "push": {
        const vec = this.acquireScratch(this.vecs.vecRef(info));
        this.walkExpr(e.receiver);
        code.localSet(vec);
        const staged = e.args.map((a) => {
          this.walkExpr(a);
          const s = this.acquireScratch(info.elemVal);
          code.localSet(s);
          return s;
        });
        for (const s of staged) {
          code.localGet(vec);
          code.localGet(s);
          code.call(this.vecs.pushOne(info));
          this.releaseScratch(info.elemVal, s);
        }
        code.localGet(vec);
        vecLen();
        this.releaseScratch(this.vecs.vecRef(info), vec);
        return;
      }
      case "pushSpread": {
        const vec = this.acquireScratch(this.vecs.vecRef(info));
        this.walkExpr(e.receiver);
        code.localSet(vec);
        code.localGet(vec);
        this.walkExpr(e.args[0]!);
        code.call(this.vecs.pushSpread(info));
        code.localGet(vec);
        vecLen();
        this.releaseScratch(this.vecs.vecRef(info), vec);
        return;
      }
      case "indexOf":
      case "includes":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        if (e.args[1] !== undefined) this.walkExpr(e.args[1]);
        else code.f64Const(0);
        code.call(this.vecs.search(info, e.method === "includes"));
        return;
      case "join":
        if (info.elemKind === "ref") {
          // ToString of an array element is its own recursive join —
          // later work, its own tag.
          this.refuse("arrIntrinsic:join:ref-elem", e.loc);
          code.unreachable();
          return;
        }
        this.walkExpr(e.receiver);
        if (e.args[0] !== undefined) this.walkExpr(e.args[0]);
        else this.pushStrLit(",");
        code.call(this.vecs.join(info, this.strRef));
        return;
      case "slice":
        this.walkExpr(e.receiver);
        if (e.args[0] !== undefined) this.walkExpr(e.args[0]);
        else code.f64Const(0);
        if (e.args[1] !== undefined) this.walkExpr(e.args[1]);
        else code.f64Const(Infinity);
        code.call(this.vecs.slice(info));
        return;
      case "splice":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        if (e.args[1] !== undefined) this.walkExpr(e.args[1]);
        else code.f64Const(Infinity);
        code.call(this.vecs.splice(info));
        return;
      /* pop and shift yield `elem | undefined` unions — they join with
       * the union representation; `with` throws a catchable RangeError —
       * it joins with the exception protocol; the ES2023 copiers are
       * tail work. */
      case "pop":
      case "shift":
      case "toReversed":
      case "toSpliced":
      case "with":
        this.refuse(`arrIntrinsic:${e.method}`, e.loc);
        code.unreachable();
        return;
      default: {
        const rest: never = e.method;
        this.refuse(`arrIntrinsic:${rest as string}`, e.loc);
        code.unreachable();
      }
    }
  }

  /** Pushes the JS ToBoolean of the value in scratch local `s`. f64 is
   * false iff 0, -0, or NaN — (x != 0) & (x == x); string iff empty. */
  private emitTruthiness(k: "f64" | "string" | "bool", s: number): void {
    const code = this.fn.code;
    switch (k) {
      case "f64":
        code.localGet(s);
        code.f64Const(0);
        code.f64Ne();
        code.localGet(s);
        code.localGet(s);
        code.f64Eq();
        code.i32And();
        return;
      case "string":
        code.localGet(s);
        code.arrayLen();
        code.i32Const(0);
        code.i32Ne();
        return;
      case "bool":
        code.localGet(s);
        return;
    }
  }

  /** JS-exact switch: the discriminant evaluates once into a scratch; the
   * dispatch chain evaluates case tests lazily in SOURCE order and
   * branches to the matching body's entry; bodies sit between the nested
   * blocks' ends so execution FALLS THROUGH in source order until a break
   * (which binds to the exit block via the control stack). A default in
   * any position is the dispatch chain's fallback target only — its body
   * keeps its source position. */
  private emitSwitch(s: Extract<IrStmt, { kind: "switch" }>): void {
    const code = this.fn.code;
    this.walkExpr(s.disc);
    const k = s.disc.type.kind;
    let discType: ValType;
    if (k === "f64") discType = F64;
    else if (k === "bool") discType = I32;
    else if (k === "string") discType = this.strRef;
    else {
      // The discriminant's representation is the gap, not the machinery.
      this.refuse(`switch:disc:${k}`, s.loc);
      code.drop();
      for (const c of s.cases) this.walkBody(c.body);
      return;
    }
    const disc = this.acquireScratch(discType);
    code.localSet(disc);
    const exitPos = this.openBlock();
    this.fn.control.push({ kind: "switch", labels: s.labels ?? [], breakPos: exitPos, continuePos: null });
    const casePos: number[] = [];
    for (let i = s.cases.length - 1; i >= 0; i--) casePos[i] = this.openBlock();
    let defaultIndex: number | null = null;
    s.cases.forEach((c, i) => {
      if (c.test === null) {
        defaultIndex = i;
        return;
      }
      code.localGet(disc);
      this.walkExpr(c.test);
      if (k === "f64") code.f64Eq();
      else if (k === "bool") code.i32Eq();
      else code.call(this.strEqHelper());
      this.brTo(casePos[i]!, true);
    });
    this.brTo(defaultIndex !== null ? casePos[defaultIndex]! : exitPos, false);
    for (const c of s.cases) {
      this.close();
      this.walkBody(c.body);
    }
    this.fn.control.pop();
    this.close();
    this.releaseScratch(discType, disc);
  }

  /* ── console ────────────────────────────────────────────────────────── */

  /** console.log / console.error: args evaluate left-to-right into scratch
   * locals FIRST, then the staged bytes flush as ONE write. The split
   * matters because an argument can itself print (a `call` arg whose body
   * logs): staging while evaluating would flush the half-built line into
   * the callee's output. Formatting is Node's: args joined with one space,
   * newline, booleans as true/false. f64 args wait on number→string
   * (Ryū shortest-roundtrip) and refuse with their own tag. */
  private emitConsole(name: string, fd: number, args: IrExpr[]): void {
    const code = this.fn.code;
    const staged: ({ kind: "str" | "bool"; local: number } | null)[] = [];
    for (const a of args) {
      this.walkExpr(a);
      const t = a.type.kind;
      if (t === "string" || t === "f64") {
        // Numbers format eagerly and stage as strings — via inspect's one
        // number-ism, exactly scr_console.c: console.log distinguishes -0
        // (String(-0) is "0", console.log(-0) prints "-0").
        if (t === "f64") {
          const xs = this.acquireScratch(F64);
          code.localSet(xs);
          code.localGet(xs);
          code.i64ReinterpretF64();
          code.i64Const(BigInt.asIntN(64, 1n << 63n));
          code.i64Eq();
          this.openIfResult(this.strRef);
          this.pushStrLit("-0");
          code.else_();
          code.localGet(xs);
          code.call(this.f64ToStrHelper());
          this.close();
          this.releaseScratch(F64, xs);
        }
        const local = this.acquireScratch({ kind: "ref", nullable: true, typeIndex: this.strType });
        code.localSet(local);
        staged.push({ kind: "str", local });
      } else if (t === "bool") {
        const local = this.acquireScratch(I32);
        code.localSet(local);
        staged.push({ kind: "bool", local });
      } else {
        // The argument's own constructs are already in the census (walked
        // above); what's missing is the FORMATTING of this type.
        this.refuse(`intrinsic:${name}:${t}`, a.loc);
        code.drop();
        staged.push(null);
      }
    }
    const helpers = this.ensureHelpers();
    staged.forEach((s, i) => {
      if (i > 0) {
        code.i32Const(0x20);
        code.call(helpers.putc);
      }
      if (s === null) return; // refused arg — survey path only
      if (s.kind === "str") {
        code.localGet(s.local);
        code.call(helpers.stage);
      } else {
        code.localGet(s.local);
        this.openIf();
        this.pushStrLit("true");
        code.call(helpers.stage);
        code.else_();
        this.pushStrLit("false");
        code.call(helpers.stage);
        this.close();
      }
    });
    code.i32Const(0x0a);
    code.call(helpers.putc);
    code.i32Const(fd);
    code.call(helpers.flush);
    for (const s of staged) {
      if (s !== null) this.releaseScratch(s.kind === "str" ? { kind: "ref", nullable: true, typeIndex: this.strType } : I32, s.local);
    }
  }

  private scratchKey(t: ValType): string {
    return t.kind === "ref" ? `ref:${t.typeIndex}` : t.kind;
  }

  private acquireScratch(t: ValType): number {
    const pool = this.fn.scratchFree.get(this.scratchKey(t));
    const free = pool?.pop();
    if (free !== undefined) return free;
    // +1: arg0 is the closure, declared params start at 1.
    const index = this.fn.fn.params.length + 1 + this.fn.localsOut.length;
    this.fn.localsOut.push(t);
    return index;
  }

  private releaseScratch(t: ValType, index: number): void {
    const key = this.scratchKey(t);
    const pool = this.fn.scratchFree.get(key);
    if (pool === undefined) this.fn.scratchFree.set(key, [index]);
    else pool.push(index);
  }

  /** The output runtime, emitted once per module on first console use:
   * a bump cursor into linear memory plus stage (copy a GC byte array to
   * the cursor), putc (one byte), and flush (hand [0, cursor) to the
   * host's write and reset). Memory below the cursor is only ever staging
   * space — nothing else allocates in it, so offset 0 is always the line
   * start. */
  private ensureHelpers(): { stage: number; putc: number; flush: number } {
    if (this.helpers !== null) return this.helpers;
    const bytesRef: ValType = { kind: "ref", nullable: true, typeIndex: this.strType };

    // stage: UTF-16 code units → UTF-8 bytes at the cursor. THE write-
    // boundary transcode (S002): surrogate pairs become one 4-byte
    // sequence, lone surrogates become U+FFFD — bit-for-bit what Node's
    // stdout write does to a JS string. Capacity is reserved up front at
    // the 3-bytes-per-unit worst case (a pair's 4 bytes span 2 units).
    const stage = this.mb.declareFunc(this.mb.funcType([bytesRef], []), "%w.stage");
    {
      const c = new Code();
      const LEN = 1;
      const I = 2;
      const U = 3; // the unit, then reused as the pair's code point
      const NEXT = 4;
      const CUR = 5;
      const PAIRED = 6;
      // mem[cur + off] = <push>; the caller advances CUR separately.
      const store8 = (off: number, push: () => void): void => {
        c.localGet(CUR);
        if (off > 0) {
          c.i32Const(off);
          c.i32Add();
        }
        push();
        c.i32Store8();
      };
      const advance = (n: number): void => {
        c.localGet(CUR);
        c.i32Const(n);
        c.i32Add();
        c.localSet(CUR);
      };
      c.localGet(0);
      c.arrayLen();
      c.localSet(LEN);
      this.emitEnsureCapacity(c, () => {
        c.localGet(LEN);
        c.i32Const(3);
        c.i32Mul();
      });
      c.globalGet(this.cursorGlobal);
      c.localSet(CUR);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.localGet(I);
      c.arrayGetU(this.strType);
      c.localSet(U);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      // ASCII
      c.localGet(U);
      c.i32Const(0x80);
      c.i32LtU();
      c.ifVoid();
      {
        store8(0, () => c.localGet(U));
        advance(1);
      }
      c.else_();
      {
        // 2-byte
        c.localGet(U);
        c.i32Const(0x800);
        c.i32LtU();
        c.ifVoid();
        {
          store8(0, () => {
            c.i32Const(0xc0);
            c.localGet(U);
            c.i32Const(6);
            c.i32ShrU();
            c.i32Or();
          });
          store8(1, () => {
            c.i32Const(0x80);
            c.localGet(U);
            c.i32Const(0x3f);
            c.i32And();
            c.i32Or();
          });
          advance(2);
        }
        c.else_();
        {
          // surrogate area?
          c.localGet(U);
          c.i32Const(0xf800);
          c.i32And();
          c.i32Const(0xd800);
          c.i32Eq();
          c.ifVoid();
          {
            // paired ⟺ high surrogate + a low surrogate follows
            c.i32Const(0);
            c.localSet(PAIRED);
            c.localGet(U);
            c.i32Const(0xdc00);
            c.i32LtU();
            c.ifVoid();
            c.localGet(I);
            c.localGet(LEN);
            c.i32LtU();
            c.ifVoid();
            c.localGet(0);
            c.localGet(I);
            c.arrayGetU(this.strType);
            c.localSet(NEXT);
            c.localGet(NEXT);
            c.i32Const(0xfc00);
            c.i32And();
            c.i32Const(0xdc00);
            c.i32Eq();
            c.ifVoid();
            c.i32Const(1);
            c.localSet(PAIRED);
            c.end();
            c.end();
            c.end();
            c.localGet(PAIRED);
            c.ifVoid();
            {
              // cp = 0x10000 + ((u - 0xD800) << 10) + (next - 0xDC00)
              c.localGet(U);
              c.i32Const(0xd800);
              c.i32Sub();
              c.i32Const(10);
              c.i32Shl();
              c.localGet(NEXT);
              c.i32Const(0xdc00);
              c.i32Sub();
              c.i32Add();
              c.i32Const(0x10000);
              c.i32Add();
              c.localSet(U);
              store8(0, () => {
                c.i32Const(0xf0);
                c.localGet(U);
                c.i32Const(18);
                c.i32ShrU();
                c.i32Or();
              });
              store8(1, () => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(12);
                c.i32ShrU();
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
              store8(2, () => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(6);
                c.i32ShrU();
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
              store8(3, () => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
              advance(4);
              c.localGet(I);
              c.i32Const(1);
              c.i32Add();
              c.localSet(I);
            }
            c.else_();
            {
              // lone surrogate → U+FFFD (EF BF BD)
              store8(0, () => c.i32Const(0xef));
              store8(1, () => c.i32Const(0xbf));
              store8(2, () => c.i32Const(0xbd));
              advance(3);
            }
            c.end();
          }
          c.else_();
          {
            // 3-byte BMP
            store8(0, () => {
              c.i32Const(0xe0);
              c.localGet(U);
              c.i32Const(12);
              c.i32ShrU();
              c.i32Or();
            });
            store8(1, () => {
              c.i32Const(0x80);
              c.localGet(U);
              c.i32Const(6);
              c.i32ShrU();
              c.i32Const(0x3f);
              c.i32And();
              c.i32Or();
            });
            store8(2, () => {
              c.i32Const(0x80);
              c.localGet(U);
              c.i32Const(0x3f);
              c.i32And();
              c.i32Or();
            });
            advance(3);
          }
          c.end();
        }
        c.end();
      }
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(CUR);
      c.globalSet(this.cursorGlobal);
      this.mb.setBody(stage, [I32, I32, I32, I32, I32, I32], c.bytes());
    }

    const putc = this.mb.declareFunc(this.mb.funcType([I32], []), "%w.putc");
    {
      const c = new Code();
      this.emitEnsureCapacity(c, () => c.i32Const(1));
      c.globalGet(this.cursorGlobal);
      c.localGet(0);
      c.i32Store8();
      c.globalGet(this.cursorGlobal);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.cursorGlobal);
      this.mb.setBody(putc, [], c.bytes());
    }

    const flush = this.mb.declareFunc(this.mb.funcType([I32], []), "%w.flush");
    {
      const c = new Code();
      c.localGet(0);
      c.i32Const(0);
      c.globalGet(this.cursorGlobal);
      c.call(this.writeFunc);
      c.i32Const(0);
      c.globalSet(this.cursorGlobal);
      this.mb.setBody(flush, [], c.bytes());
    }

    this.helpers = { stage, putc, flush };
    return this.helpers;
  }

  /* ── the scalar runtime, emitted on first use ───────────────────────────
   *
   * Self-contained bodies over their own Code (hand-counted br depths —
   * they never touch fn state). Each is the bit-exact port of the
   * semantics the native lanes get from C: toInt32 is ECMA ToInt32 via
   * exponent/mantissa surgery (i64.trunc_sat saturates instead of
   * wrapping, so it cannot be used), fmod is musl's shift-subtract
   * fmod (JS % IS C fmod), and the string trio works over the UTF-16
   * unit arrays (S002) — equality unit-wise, ordering per S005's
   * code-point stance or the utf16 flag's raw unit order. */

  private f64ToStrFunc: number | null = null;

  /** %w.f64ToStr — the Ryū digit core + ECMA placement, built in
   * numfmt.ts (its own module: ~the largest single helper family). */
  private f64ToStrHelper(): number {
    this.f64ToStrFunc ??= buildF64ToStr(this.mb, this.strType, this.strRef);
    return this.f64ToStrFunc;
  }

  private toInt32Func: number | null = null;

  /** %w.toInt32(f64) → i32 — ECMA ToInt32/ToUint32's shared modular
   * truncation (the caller picks the signedness of the f64 it converts
   * the result back with). */
  private toInt32Helper(): number {
    if (this.toInt32Func !== null) return this.toInt32Func;
    const idx = this.mb.declareFunc(this.mb.funcType([F64], [I32]), "%w.toInt32");
    this.toInt32Func = idx;
    const c = new Code();
    const BITS = 1; // i64
    const EXPB = 2; // i32 biased exponent
    const MANT = 3; // i64
    const E = 4; // i32 exponent of the mantissa's LSB
    const LOW = 5; // i32
    c.localGet(0);
    c.i64ReinterpretF64();
    c.localSet(BITS);
    c.localGet(BITS);
    c.i64Const(52n);
    c.i64ShrU();
    c.i64Const(0x7ffn);
    c.i64And();
    c.i32WrapI64();
    c.localSet(EXPB);
    // NaN and ±Infinity → 0.
    c.localGet(EXPB);
    c.i32Const(0x7ff);
    c.i32Eq();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    // |x| < 1 truncates to 0 (subnormals and ±0 included).
    c.localGet(EXPB);
    c.i32Const(1023);
    c.i32LtS();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    // e = exponent of the mantissa's LSB; e ≥ 32 puts every set bit above
    // 2^32, so the modular result is 0.
    c.localGet(EXPB);
    c.i32Const(1075);
    c.i32Sub();
    c.localSet(E);
    c.localGet(E);
    c.i32Const(32);
    c.i32GeS();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    // The 53-bit significand (normals only — subnormals returned above).
    c.localGet(BITS);
    c.i64Const(0xf_ffff_ffff_ffffn);
    c.i64And();
    c.i64Const(1n << 52n);
    c.i64Or();
    c.localSet(MANT);
    // low = wrap(e >= 0 ? mant << e : mant >> -e), e ∈ [-52, 31].
    c.localGet(E);
    c.i32Const(0);
    c.i32GeS();
    c.ifResult(I32);
    c.localGet(MANT);
    c.localGet(E);
    c.i64ExtendI32S();
    c.i64Shl();
    c.i32WrapI64();
    c.else_();
    c.localGet(MANT);
    c.i32Const(0);
    c.localGet(E);
    c.i32Sub();
    c.i64ExtendI32S();
    c.i64ShrU();
    c.i32WrapI64();
    c.end();
    c.localSet(LOW);
    // The sign negates modularly (truncation is magnitude-symmetric).
    c.localGet(BITS);
    c.i64Const(0n);
    c.i64LtS();
    c.ifResult(I32);
    c.i32Const(0);
    c.localGet(LOW);
    c.i32Sub();
    c.else_();
    c.localGet(LOW);
    c.end();
    this.mb.setBody(idx, [I64, I32, I64, I32, I32], c.bytes());
    return idx;
  }

  private fmodFunc: number | null = null;

  /** %w.fmod(f64, f64) → f64 — musl's fmod, bit-exact: normalize both
   * significands, shift-subtract until the exponents meet, renormalize,
   * reattach x's sign. JS's % is exactly this. */
  private fmodHelper(): number {
    if (this.fmodFunc !== null) return this.fmodFunc;
    const idx = this.mb.declareFunc(this.mb.funcType([F64, F64], [F64]), "%w.fmod");
    this.fmodFunc = idx;
    const c = new Code();
    const UX = 2; // i64
    const UY = 3; // i64
    const EX = 4; // i32
    const EY = 5; // i32
    const SX = 6; // i64 (x's sign bit, already in place)
    const I = 7; // i64 scratch
    const P = 8; // f64 (the NaN product)
    const signMask = BigInt.asIntN(64, 1n << 63n);
    const infShifted = BigInt.asIntN(64, 0x7ffn << 53n); // Inf's bits, sign shifted out
    c.localGet(0);
    c.i64ReinterpretF64();
    c.localSet(UX);
    c.localGet(1);
    c.i64ReinterpretF64();
    c.localSet(UY);
    const loadExp = (src: number, dst: number): void => {
      c.localGet(src);
      c.i64Const(52n);
      c.i64ShrU();
      c.i64Const(0x7ffn);
      c.i64And();
      c.i32WrapI64();
      c.localSet(dst);
    };
    loadExp(UX, EX);
    loadExp(UY, EY);
    c.localGet(UX);
    c.i64Const(signMask);
    c.i64And();
    c.localSet(SX);
    // Domain errors — y = ±0, x = ±Inf/NaN, y = NaN — answer NaN as
    // (x*y)/(x*y), which also propagates a payloadful NaN like musl.
    c.localGet(UY);
    c.i64Const(1n);
    c.i64Shl();
    c.i64Eqz();
    c.localGet(EX);
    c.i32Const(0x7ff);
    c.i32Eq();
    c.i32Or();
    c.localGet(UY);
    c.i64Const(1n);
    c.i64Shl();
    c.i64Const(infShifted);
    c.i64GtU();
    c.i32Or();
    c.ifVoid();
    c.localGet(0);
    c.localGet(1);
    c.f64Mul();
    c.localSet(P);
    c.localGet(P);
    c.localGet(P);
    c.f64Div();
    c.return_();
    c.end();
    // |x| <= |y|: equal magnitudes answer ±0 with x's sign, else x itself.
    c.localGet(UX);
    c.i64Const(1n);
    c.i64Shl();
    c.localGet(UY);
    c.i64Const(1n);
    c.i64Shl();
    c.i64LeU();
    c.ifVoid();
    {
      c.localGet(UX);
      c.i64Const(1n);
      c.i64Shl();
      c.localGet(UY);
      c.i64Const(1n);
      c.i64Shl();
      c.i64Eq();
      c.ifVoid();
      c.localGet(SX);
      c.f64ReinterpretI64();
      c.return_();
      c.end();
      c.localGet(0);
      c.return_();
    }
    c.end();
    // Normalize a significand into bit 52: subnormals count leading
    // zeros the musl way, normals reveal the implicit bit.
    const normalize = (u: number, exp: number): void => {
      c.localGet(exp);
      c.i32Eqz();
      c.ifVoid();
      {
        c.localGet(u);
        c.i64Const(12n);
        c.i64Shl();
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.i64Const(0n);
        c.i64LtS();
        c.brIf(1);
        c.localGet(exp);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(exp);
        c.localGet(I);
        c.i64Const(1n);
        c.i64Shl();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(u);
        c.i32Const(1);
        c.localGet(exp);
        c.i32Sub();
        c.i64ExtendI32S();
        c.i64Shl();
        c.localSet(u);
      }
      c.else_();
      {
        c.localGet(u);
        c.i64Const(0xf_ffff_ffff_ffffn);
        c.i64And();
        c.i64Const(1n << 52n);
        c.i64Or();
        c.localSet(u);
      }
      c.end();
    };
    normalize(UX, EX);
    normalize(UY, EY);
    // The shift-subtract core; a zero difference is an exact multiple and
    // answers ±0 with x's sign.
    const subtractStep = (): void => {
      c.localGet(UX);
      c.localGet(UY);
      c.i64Sub();
      c.localSet(I);
      c.localGet(I);
      c.i64Const(0n);
      c.i64GeS();
      c.ifVoid();
      c.localGet(I);
      c.i64Eqz();
      c.ifVoid();
      c.localGet(SX);
      c.f64ReinterpretI64();
      c.return_();
      c.end();
      c.localGet(I);
      c.localSet(UX);
      c.end();
    };
    c.block();
    c.loop();
    c.localGet(EX);
    c.localGet(EY);
    c.i32LeS();
    c.brIf(1);
    subtractStep();
    c.localGet(UX);
    c.i64Const(1n);
    c.i64Shl();
    c.localSet(UX);
    c.localGet(EX);
    c.i32Const(1);
    c.i32Sub();
    c.localSet(EX);
    c.br(0);
    c.end();
    c.end();
    subtractStep();
    // Renormalize the remainder.
    c.block();
    c.loop();
    c.localGet(UX);
    c.i64Const(52n);
    c.i64ShrU();
    c.i64Eqz();
    c.i32Eqz();
    c.brIf(1);
    c.localGet(UX);
    c.i64Const(1n);
    c.i64Shl();
    c.localSet(UX);
    c.localGet(EX);
    c.i32Const(1);
    c.i32Sub();
    c.localSet(EX);
    c.br(0);
    c.end();
    c.end();
    // Scale back: positive exponents re-bias, non-positive go subnormal.
    c.localGet(EX);
    c.i32Const(0);
    c.i32GtS();
    c.ifVoid();
    {
      c.localGet(UX);
      c.i64Const(1n << 52n);
      c.i64Sub();
      c.localGet(EX);
      c.i64ExtendI32S();
      c.i64Const(52n);
      c.i64Shl();
      c.i64Or();
      c.localSet(UX);
    }
    c.else_();
    {
      c.localGet(UX);
      c.i32Const(1);
      c.localGet(EX);
      c.i32Sub();
      c.i64ExtendI32S();
      c.i64ShrU();
      c.localSet(UX);
    }
    c.end();
    c.localGet(UX);
    c.localGet(SX);
    c.i64Or();
    c.f64ReinterpretI64();
    this.mb.setBody(idx, [I64, I64, I32, I32, I64, I64, F64], c.bytes());
    return idx;
  }

  private strEqFunc: number | null = null;

  /** %w.strEq(ref, ref) → i32 — content equality: identical refs fast-path,
   * then length, then bytes. */
  private strEqHelper(): number {
    if (this.strEqFunc !== null) return this.strEqFunc;
    const idx = this.mb.declareFunc(this.mb.funcType([this.strRef, this.strRef], [I32]), "%w.strEq");
    this.strEqFunc = idx;
    const c = new Code();
    const LEN = 2;
    const IDX = 3;
    c.localGet(0);
    c.localGet(1);
    c.refEq();
    c.ifVoid();
    c.i32Const(1);
    c.return_();
    c.end();
    c.localGet(0);
    c.arrayLen();
    c.localTee(LEN);
    c.localGet(1);
    c.arrayLen();
    c.i32Ne();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    c.i32Const(0);
    c.localSet(IDX);
    c.block();
    c.loop();
    c.localGet(IDX);
    c.localGet(LEN);
    c.i32GeU();
    c.brIf(1);
    c.localGet(0);
    c.localGet(IDX);
    c.arrayGetU(this.strType);
    c.localGet(1);
    c.localGet(IDX);
    c.arrayGetU(this.strType);
    c.i32Ne();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    c.localGet(IDX);
    c.i32Const(1);
    c.i32Add();
    c.localSet(IDX);
    c.br(0);
    c.end();
    c.end();
    c.i32Const(1);
    this.mb.setBody(idx, [I32, I32], c.bytes());
    return idx;
  }

  private strCmpFunc: number | null = null;
  private strCmpU16Func: number | null = null;

  /** %w.strCmp(ref, ref) → i32 in {-1, 0, 1}, in the order the IR asks
   * for. Plain source comparisons use CODE-POINT order (SEMANTICS.md
   * S005): each UTF-16 unit is order-transformed so supplementary pairs
   * (whose high unit is 0xD800-0xDBFF) sort above every BMP unit —
   * u < 0xD800 stays, u ≥ 0xE000 drops by 0x800, surrogates rise by
   * 0x2000. The utf16 variant (the default sort comparator) compares raw
   * units — ECMAScript's own order. */
  private strCmpHelper(utf16: boolean): number {
    const cached = utf16 ? this.strCmpU16Func : this.strCmpFunc;
    if (cached !== null) return cached;
    const idx = this.mb.declareFunc(
      this.mb.funcType([this.strRef, this.strRef], [I32]),
      utf16 ? "%w.strCmpU16" : "%w.strCmp",
    );
    if (utf16) this.strCmpU16Func = idx;
    else this.strCmpFunc = idx;
    const c = new Code();
    /** Order-transform the unit on the stack top (code-point order only). */
    const transform = (local: number): void => {
      if (utf16) return;
      c.localGet(local);
      c.i32Const(0xd800);
      c.i32LtU();
      c.ifResult(I32);
      c.localGet(local);
      c.else_();
      c.localGet(local);
      c.i32Const(0xe000);
      c.i32GeU();
      c.ifResult(I32);
      c.localGet(local);
      c.i32Const(0x800);
      c.i32Sub();
      c.else_();
      c.localGet(local);
      c.i32Const(0x2000);
      c.i32Add();
      c.end();
      c.end();
      c.localSet(local);
    };
    const LA = 2;
    const LB = 3;
    const MIN = 4;
    const IDX = 5;
    const CA = 6;
    const CB = 7;
    c.localGet(0);
    c.arrayLen();
    c.localSet(LA);
    c.localGet(1);
    c.arrayLen();
    c.localSet(LB);
    c.localGet(LA);
    c.localGet(LB);
    c.i32LtS();
    c.ifResult(I32);
    c.localGet(LA);
    c.else_();
    c.localGet(LB);
    c.end();
    c.localSet(MIN);
    c.i32Const(0);
    c.localSet(IDX);
    c.block();
    c.loop();
    c.localGet(IDX);
    c.localGet(MIN);
    c.i32GeU();
    c.brIf(1);
    c.localGet(0);
    c.localGet(IDX);
    c.arrayGetU(this.strType);
    c.localSet(CA);
    c.localGet(1);
    c.localGet(IDX);
    c.arrayGetU(this.strType);
    c.localSet(CB);
    transform(CA);
    transform(CB);
    c.localGet(CA);
    c.localGet(CB);
    c.i32Ne();
    c.ifVoid();
    c.localGet(CA);
    c.localGet(CB);
    c.i32GtU();
    c.ifResult(I32);
    c.i32Const(1);
    c.else_();
    c.i32Const(-1);
    c.end();
    c.return_();
    c.end();
    c.localGet(IDX);
    c.i32Const(1);
    c.i32Add();
    c.localSet(IDX);
    c.br(0);
    c.end();
    c.end();
    // Shared prefix: the shorter string sorts first.
    c.localGet(LA);
    c.localGet(LB);
    c.i32LtS();
    c.ifResult(I32);
    c.i32Const(-1);
    c.else_();
    c.localGet(LA);
    c.localGet(LB);
    c.i32GtS();
    c.end();
    this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32], c.bytes());
    return idx;
  }

  private concatFunc: number | null = null;

  /** %w.concat(ref, ref) → ref — the one place string storage is written:
   * a fresh array filled by two array.copys, immutable from then on. */
  private concatHelper(): number {
    if (this.concatFunc !== null) return this.concatFunc;
    const idx = this.mb.declareFunc(
      this.mb.funcType([this.strRef, this.strRef], [this.strRef]),
      "%w.concat",
    );
    this.concatFunc = idx;
    const c = new Code();
    const LA = 2; // i32
    const DEST = 3; // ref
    c.localGet(0);
    c.arrayLen();
    c.localTee(LA);
    c.localGet(1);
    c.arrayLen();
    c.i32Add();
    c.arrayNewDefault(this.strType);
    c.localSet(DEST);
    c.localGet(DEST);
    c.i32Const(0);
    c.localGet(0);
    c.i32Const(0);
    c.localGet(LA);
    c.arrayCopy(this.strType, this.strType);
    c.localGet(DEST);
    c.localGet(LA);
    c.localGet(1);
    c.i32Const(0);
    c.localGet(1);
    c.arrayLen();
    c.arrayCopy(this.strType, this.strType);
    c.localGet(DEST);
    this.mb.setBody(idx, [I32, this.strRef], c.bytes());
    return idx;
  }

  /** if (cursor + need > memory.size * 64Ki) grow by the shortfall in
   * pages, trapping on allocation failure (grow answers -1). `need` must
   * push one i32 and is emitted twice. */
  private emitEnsureCapacity(c: Code, need: () => void): void {
    const bytesInPages = () => {
      c.memorySize();
      c.i32Const(16);
      c.i32Shl();
    };
    c.globalGet(this.cursorGlobal);
    need();
    c.i32Add();
    bytesInPages();
    c.i32GtU();
    c.ifVoid();
    {
      c.globalGet(this.cursorGlobal);
      need();
      c.i32Add();
      bytesInPages();
      c.i32Sub();
      c.i32Const(0xffff);
      c.i32Add();
      c.i32Const(16);
      c.i32ShrU();
      c.memoryGrow();
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.unreachable(); // out of memory: trap, never truncate output
      c.end();
    }
    c.end();
  }
}
