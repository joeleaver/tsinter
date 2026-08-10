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
import {
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrLocal,
  type IrModule,
  type IrRecordShape,
  type IrType,
  type IrUnionDef,
  type SrcLoc,
  isUnitType,
  typeEquals,
  typeKey,
  RUNTIME_ERROR_CLASSES,
} from "../../ir/nodes.js";
import { computeMayThrow } from "../emission/may-throw.js";
import { buildClassGraph, type LlClassMeta, type LlVtSlot } from "../llvm/classes.js";
import {
  CI_POST,
  CI_PRE,
  CLASSOBJ_CTOR,
  CLASSOBJ_NAME,
  CLASS_VT,
  VTT_SLOT0,
  ClassBuilder,
  type ClassInfo,
} from "./classes.js";
import {
  EXPORT_ENTRY,
  EXPORT_MEMORY,
  EXPORT_STATUS,
  EXPORT_TICK,
  FD_STDERR,
  FD_STDOUT,
  IMPORT_MODULE,
  IMPORT_NOW,
  IMPORT_WRITE,
} from "./abi.js";
import { VecBuilder, type VecInfo } from "./arrays.js";
import { DK, DYN_KIND, DYN_NUM, DYN_REF, DynBuilder, FN_CLOS, FN_SIG } from "./dyn.js";
import { InspectBuilder } from "./inspect.js";
import { MapBuilder, type MapInfo, type MapKeyKind, type MapValKind } from "./maps.js";
import { JsonBuilder, jsonQuote } from "./json.js";
import {
  PromiseBuilder,
  ALL_REMAINING,
  ALL_RESULT,
  ALL_VALUES,
  ALLE_INDEX,
  ALLE_SRC,
  ALLE_STATE,
  PROM_F64,
  PROM_KIND,
  PROM_OBSERVED,
  PROM_PRE,
  PROM_REF,
  PROM_STATE,
  RACEE_DST,
  RACEE_SRC,
} from "./promises.js";
import { StrBuilder } from "./strings.js";
import { TimerBuilder } from "./timers.js";
import { UnionBuilder, type UnionArmRep } from "./unions.js";
import { Code } from "./code.js";
import { buildF64ToStr } from "./numfmt.js";
import { F64, I32, I64, ModuleBuilder, type FieldType, type StorageType, type ValType } from "./module.js";
import {
  asIrModule,
  lowerResumableFunctions,
  type Refuse,
  type WExpr,
  type WFunction,
  type WModule,
  type WStmt,
  type WType,
} from "./statemachine.js";
import { WasmUnsupportedError } from "./unsupported.js";

export { WasmUnsupportedError } from "./unsupported.js";

function valKey(t: ValType): string {
  return t.kind === "ref" ? `r${t.nullable ? "?" : ""}${t.typeIndex}` : t.kind;
}

/** The entry's transitive closure over function-name references — the
 * same GENERIC deep scan `Assembler.reachableFunctions` does, hoisted out
 * because the timer prescan needs it BEFORE the assembler exists (imports
 * precede declared functions in the index space, so `tsinter.now` has to
 * be decided in the constructor). See that method for why the scan is
 * blunt on purpose.
 *
 * The scan sees literal function-name STRINGS, and the class surface has
 * none: `new`/`classRef` name a class and leave `.constructor` implied,
 * and `virtualCall` composes `%Class.method` from two fields whose callee
 * set is the whole subtree. Those edges are spelled out below, off the
 * shared class graph — miss one and a constructor or an override body
 * silently never lands. */
function reachableFunctionNames(mod: WModule): Set<string> {
  const names = new Set(mod.functions.map((f) => f.name));
  const byName = new Map(mod.functions.map((f) => [f.name, f]));
  const graph = buildClassGraph(asIrModule(mod), byName as unknown as Map<string, IrFunction>);
  /** Every class in the static receiver's WHOLE HIERARCHY that declares
   * `method` — the possible targets of one virtual dispatch. The walk
   * starts at the hierarchy ROOT, not at `className`: the declaration a
   * dispatch lands on may sit ABOVE the static receiver (validate.ts
   * resolves it by walking the base chain upward, so `virtualCall{Dog,
   * speak}` reaches `%Animal.speak` when Dog only inherits it), and the
   * overrides sit below. One root-down walk covers both directions —
   * may-throw.ts's virtualCall arm takes the same wide cover. */
  const overridesOf = (className: string, method: string): string[] => {
    const meta = graph.get(className);
    if (meta === undefined) return [];
    const out: string[] = [];
    const walk = (m: typeof meta): void => {
      if (m.def.methods?.includes(method) === true) out.push(m.def.name);
      for (const c of m.children) walk(c);
    };
    walk(meta.root);
    return out;
  };
  /** A class and every strict descendant — `newValue`'s callee could be
   * any of them (may-throw.ts takes the same wide cover). */
  const subtree = (className: string): string[] => {
    const root = graph.get(className);
    if (root === undefined) return [];
    const out: string[] = [];
    const walk = (m: typeof root): void => {
      out.push(m.def.name);
      for (const c of m.children) walk(c);
    };
    walk(root);
    return out;
  };
  const reachable = new Set<string>([mod.entry]);
  const queue = [mod.entry];
  const edge = (name: string): void => {
    if (names.has(name) && !reachable.has(name)) {
      reachable.add(name);
      queue.push(name);
    }
  };
  const scan = (node: unknown): void => {
    if (typeof node === "string") {
      edge(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) scan(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      switch (rec["kind"]) {
        case "new":
        case "classRef":
          edge(`%${rec["className"] as string}.constructor`);
          break;
        case "newValue": {
          // The callee is classval-typed and the result names the class;
          // any descendant's constructor may be the one that runs.
          const t = rec["type"] as { kind?: string; className?: string } | undefined;
          if (t?.kind === "object" && t.className !== undefined) {
            for (const c of subtree(t.className)) edge(`%${c}.constructor`);
          }
          break;
        }
        case "virtualCall":
          for (const c of overridesOf(rec["className"] as string, rec["method"] as string)) {
            edge(`%${c}.${rec["method"] as string}`);
          }
          break;
        default:
          break;
      }
      for (const value of Object.values(node)) scan(value);
    }
  };
  while (queue.length > 0) {
    const fn = byName.get(queue.pop()!);
    if (fn !== undefined) scan(fn.body);
  }
  return reachable;
}

/** Does any reachable function name a `timers.*` libCall? Deliberately a
 * string scan over the IR rather than a per-kind walk: over-approximating
 * (a string literal spelling one of these names) costs an unused import,
 * while missing one would be a miscompile the emitter cannot recover
 * from. */
function timerSurfaceReachable(mod: WModule): boolean {
  const reachable = reachableFunctionNames(mod);
  let found = false;
  const scan = (node: unknown): void => {
    if (found) return;
    if (typeof node === "string") {
      if (node.startsWith("timers.")) found = true;
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
  for (const fn of mod.functions) {
    if (reachable.has(fn.name)) scan(fn.body);
  }
  return found;
}

export function emitWasmModule(mod: IrModule): Uint8Array {
  // The resumable lowering shares the sink: a function it declines names
  // itself in the same census the walk feeds, and on this path throws out
  // of the pass exactly like a construct the walk refuses would.
  const refuse: Refuse = (kind, loc) => {
    throw new WasmUnsupportedError(kind, loc);
  };
  const asm = new Assembler(lowerResumableFunctions(mod, refuse), refuse);
  asm.run();
  return asm.finish();
}

/** Every distinct construct this module needs from the wasm backend, in
 * first-encountered order — the work queue behind one program. Nothing
 * throws and nothing is assembled: this answers "what would it take to
 * compile this?", not "does it compile?". */
export function surveyWasmModule(mod: IrModule): string[] {
  const seen = new Set<string>();
  const refuse: Refuse = (kind) => {
    seen.add(kind);
  };
  new Assembler(lowerResumableFunctions(mod, refuse), refuse).run();
  return [...seen];
}


/* ── per-function state ────────────────────────────────────────────────── */

interface FnState {
  fn: WFunction;
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
  /** Active optional chains: chain id → the local holding the narrowed
   * receiver, read by chainRecv inside the chain's body. */
  chainBinds: Map<string, number>;
  /** Enclosing exception handlers, innermost last: the block position an
   * unwind branches to (a catch block, or a finally's exception entry).
   * Empty ⇒ the unwind returns a dummy out of the function. */
  tryStack: number[];
  /** Enclosing finally regions' PENDING-RETURN entries, innermost last: a
   * `return` inside try/catch parks its value in pretLocal and branches
   * to the innermost entry instead of returning (emit-stmts.ts's
   * finallyStack, ported). `used` gates the third finally copy — an
   * entry nothing branched to emits `unreachable` in its place. */
  finallyStack: { pos: number; used: boolean }[];
  /** The parked return value's local (lazily allocated; null until a
   * return actually crosses a finally, and never for void returns). */
  pretLocal: number | null;
}

/* Exception-cell kind tags (the wasm tier's ScrExcKind): 0 = nothing
 * pending; the rest tag what the payload globals hold. */
const EXC_F64 = 1;
const EXC_BOOL = 2;
const EXC_STR = 3;
const EXC_REF = 4;
const EXC_OBJ = 5;

/* `errT`'s field indices (see `exc()`): the vt, then %Error's three IR
 * fields. Named because the dyn surface reads them from outside this
 * file — the `%error` encoding is built out of these three slots. */
const ERR_NAME = 1;
const ERR_MESSAGE = 2;
const ERR_CODE = 3;

/** The three `dynInvoke` names whose real receiver is a PROMISE. They
 * refuse rather than dispatch: a promise box is constructible here, and
 * its reactions belong to the fiber machinery, not the dyn surface. */
const PROMISE_REACTION_METHODS = new Set(["then", "catch", "finally"]);

/** The abstract `any` heap type's s33 encoding — every struct/array ref
 * in the module is a subtype, so (ref null ANY_HEAP) is the one payload
 * slot every thrown ref shares. */
const ANY_HEAP = -0x12;
const ANY_REF: ValType = { kind: "ref", nullable: true, typeIndex: ANY_HEAP };

/** Record shapes the resumable lowering owns (statemachine.ts names them
 * `%frame.<fn>`): the ONLY shapes that declare a supertype. */
const FRAME_SHAPE_PREFIX = "%frame.";

/** One dyn walker body under construction — see `newWalker`. */
interface WalkerCtx {
  c: Code;
  locals: ValType[];
  /** The function's parameter count: local slots start here. */
  base: number;
}

type DynTestKind = Extract<IrExpr, { kind: "dynTest" }>["test"];

/** dynTest's kind sets, one for one with the C emitter's lowering
 * (emit-exprs.ts). `typeof x === "object"` admits NULL — JS's oldest
 * wart — alongside every object-shaped kind. The two tests that are not
 * kind compares (`truthy` runs the ToBoolean ladder, `error` reads the
 * dyn tree's "%error" encoding) are excluded by the type. */
const DYN_TEST_KINDS: Record<Exclude<DynTestKind, "truthy" | "error">, readonly number[]> = {
  string: [DK.STR],
  number: [DK.NUM],
  boolean: [DK.BOOL],
  undefined: [DK.UNDEF],
  null: [DK.NULL],
  nullish: [DK.UNDEF, DK.NULL],
  bytes: [DK.BYTES],
  array: [DK.ARR],
  function: [DK.FUNC],
  object: [DK.OBJ, DK.ARR, DK.BYTES, DK.HANDLE, DK.PROMISE, DK.NULL],
};

/* ── the assembler: one walk, both sinks ───────────────────────────────── */

class Assembler {
  private readonly mb = new ModuleBuilder();
  private readonly globalById = new Map<string, IrGlobal>();
  private readonly unionsById = new Map<string, IrUnionDef>();
  private readonly globalWasmIndex = new Map<string, number>();
  private readonly funcIndexByName = new Map<string, number>();
  private readonly funcByName = new Map<string, WFunction>();
  private readonly strType: number;
  private readonly cursorGlobal: number;
  private readonly writeFunc: number;
  /** `tsinter.now`'s index, or null in a module that cannot arm a timer
   * (see the prescan in the constructor). */
  private readonly nowFunc: number | null;
  private helpers: { stage: number; putc: number; flush: number } | null = null;
  private fn!: FnState;

  constructor(
    private readonly mod: WModule,
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
    // The timer runtime's clock (abi.ts). Imports occupy the FRONT of the
    // function index space, so this decision cannot wait for the walk to
    // discover a `timers.*` libCall — it is made by prescanning the
    // REACHABLE functions the same generic way reachability itself is
    // found. Over-approximating costs one unused import in a module that
    // then refuses anyway; under-approximating would be an emitter bug,
    // and the runtime says so by name if it ever happens.
    this.nowFunc = timerSurfaceReachable(mod)
      ? this.mb.importFunc(IMPORT_MODULE, IMPORT_NOW, this.mb.funcType([], [F64]))
      : null;
    this.mb.ensureMemory(1);
    this.cursorGlobal = this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    for (const g of mod.globals ?? []) this.globalById.set(g.id, g);
    for (const r of mod.records ?? []) this.recordShapes.set(r.id, r);
    for (const u of mod.unions ?? []) this.unionsById.set(u.id, u);
    // The native backends' may-throw analysis is a pure function of the
    // IR — reused verbatim to place the pending-exception checks. It runs
    // on the LOWERED module and walks it generically, so the `%async.*`
    // kinds recurse through it like any node it has no case for.
    const mt = computeMayThrow(asIrModule(mod));
    this.mayThrow = mt.fns;
    this.mayThrowIndirect = mt.indirect;
    for (const cls of mod.classes ?? []) {
      for (const m of cls.methods ?? []) {
        if (this.mayThrow.has(`%${cls.name}.${m}`)) this.mayThrowMethods.add(m);
      }
    }
    // Top-level await: the lowering turned the entry into a spawn wrapper,
    // so its promise-typed return IS the "this program has a module
    // evaluation promise" flag (an entry the pass declined stays void and
    // refuses at its own gate). Read here so the checkpoint — which the
    // timer runtime may build before `_start` — and `_start` itself always
    // agree about whether the root global exists.
    this.asyncEntry =
      mod.functions.find((fn) => fn.name === mod.entry)?.returnType.kind === "promise";
  }

  private readonly mayThrow: Set<string>;
  private readonly mayThrowIndirect: boolean;
  /** Method names with at least one may-throw implementation — a virtual
   * dispatch cannot name its callee, so the pending check keys on the
   * METHOD (the native lanes' mayThrowMethods, ported). */
  private readonly mayThrowMethods = new Set<string>();
  private readonly asyncEntry: boolean;

  /* ── the exception protocol (pending-flag unwind, the native model) ────
   * One cell of three mutable globals: a kind tag (0 = nothing pending)
   * plus the payload in the f64 or the any-ref slot. `throw` fills the
   * cell and unwinds; after every call that can throw, the caller tests
   * the tag and unwinds too — to the innermost handler block of the
   * CURRENT function, or out through a dummy return the caller never
   * reads (its own check fires first). catch TAKES the cell into an
   * immutable snapshot struct (the ScrCaught port) and clears it. */

  private excField: {
    kindG: number;
    f64G: number;
    refG: number;
    /** The thrown object's DYNAMIC class interval position — the whole
     * catch-side class test. See emitThrowValue. */
    preG: number;
    caughtT: number;
    errT: number;
    errFields: FieldType[];
  } | null = null;

  private exc(): NonNullable<typeof this.excField> {
    if (this.excField === null) {
      const strRef: ValType = { kind: "ref", nullable: true, typeIndex: this.strType };
      // The snapshot a catch TAKES from the cell: the kind tag, the two
      // payload slots, and the thrown class's preorder position — copied
      // in because the cell is cleared on entry and a later throw inside
      // the handler would otherwise move the answer under a class test.
      const caughtT = this.mb.structType([
        { storage: I32, mutable: false },
        { storage: F64, mutable: false },
        { storage: ANY_REF, mutable: false },
        { storage: I32, mutable: false },
      ]);
      // The builtin error instance: vt, name, message, and the %code slot
      // (null = absent). Slot 0 used to be a class ID out of
      // RUNTIME_ERROR_CLASSES — it is now the same `vt` every hierarchy
      // class carries, so a builtin error and a user class answer
      // instanceof through ONE mechanism and a user `extends Error` class
      // can simply SUBTYPE this struct (its IR field prefix is exactly
      // name/message/%code). Hence OPEN rather than final. `name` and
      // `message` are MUTABLE — Node's are plain writable fields and the
      // IR's class def declares them so; vt and %code are stamped once.
      const errFields: FieldType[] = [
        { storage: this.classes.ciRef(), mutable: false },
        { storage: strRef, mutable: true },
        { storage: strRef, mutable: true },
        { storage: strRef, mutable: false },
      ];
      const errT = this.mb.openStructType("class:err", errFields);
      const kindG = this.mb.addGlobal(I32, true, (w) => {
        w.u8(0x41);
        w.sleb(0);
      });
      const f64G = this.mb.addGlobal(F64, true, (w) => {
        w.u8(0x44);
        w.f64(0);
      });
      const refG = this.mb.addGlobal(ANY_REF, true, (w) => {
        w.u8(0xd0);
        w.sleb(ANY_HEAP);
      });
      const preG = this.mb.addGlobal(I32, true, (w) => {
        w.u8(0x41);
        w.sleb(-1); // no object pending
      });
      this.excField = { kindG, f64G, refG, preG, caughtT, errT, errFields };
    }
    return this.excField;
  }

  /** An already-evaluated instance's DYNAMIC preorder position, from
   * local `slot`, pushed as an i32. A hierarchy class reads it off the
   * vt — an Error-typed binding really can hold a subclass — while a
   * standalone class has exactly one possible runtime class and no vt to
   * read, so its position is a compile-time constant. */
  private emitDynamicPre(slot: number, info: ClassInfo): void {
    const code = this.fn.code;
    if (!info.meta.hierarchy) {
      code.i32Const(info.meta.pre);
      return;
    }
    code.localGet(slot);
    code.structGet(info.struct, CLASS_VT);
    code.structGet(this.classes.ci(), CI_PRE);
  }

  /** The unwind at a point where an exception is pending: branch to the
   * innermost handler of THIS function, or return a dummy value the
   * caller never reads (its pending check fires before any use). The
   * caller owns the surrounding condition; `throw` unwinds directly. */
  private emitUnwind(): void {
    const target = this.fn.tryStack[this.fn.tryStack.length - 1];
    if (target !== undefined) {
      this.brTo(target, false);
      return;
    }
    const code = this.fn.code;
    const rt = this.fn.fn.returnType;
    if (rt.kind !== "void") {
      const soft = this.mapTypeSoft(rt);
      if (soft.kind === "f64") code.f64Const(0);
      else if (soft.kind === "ref") code.refNull(soft.typeIndex);
      else if (soft.kind === "i64") code.i64Const(0n);
      else code.i32Const(0);
    }
    code.return_();
  }

  /** The emitter contract for exceptions (the native backends' rule,
   * ported): after EVERY call that can throw, test the pending tag and
   * unwind. Values already on the stack are simply abandoned by the
   * branch — wasm truncates the operand stack at a br. */
  private emitPendingCheck(): void {
    this.fn.code.globalGet(this.exc().kindG);
    this.openIf();
    this.emitUnwind();
    this.close();
  }

  private caughtRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.exc().caughtT };
  }

  /** `caught instanceof C` on a snapshot already in local `c`: the kind
   * is OBJ and the recorded interval position falls inside C's range.
   * The payload is never touched — which is the point. A cast-based test
   * would have to name a struct, and the thrown object may be a class
   * with no relation to C at all (an ordinary user class thrown into a
   * handler asking about Error); the interval simply answers false.
   * Leaves an i32. Shared by caughtTest's instanceof and caughtCheck. */
  private emitCaughtIsClass(meta: LlClassMeta, c: number): void {
    const exc = this.exc();
    const code = this.fn.code;
    code.localGet(c);
    code.structGet(exc.caughtT, 0);
    code.i32Const(EXC_OBJ);
    code.i32Eq();
    // A root with no base spans every class in its own hierarchy, but
    // NOT other hierarchies, so the range test is still needed — unlike
    // the closed builtin table this replaces, where "any OBJ" was sound.
    this.openIfResult(I32);
    const pre = this.acquireScratch(I32);
    code.localGet(c);
    code.structGet(exc.caughtT, 3);
    code.localTee(pre);
    code.i32Const(meta.pre);
    code.i32GeS();
    code.localGet(pre);
    code.i32Const(meta.post);
    code.i32LeS();
    code.i32And();
    this.releaseScratch(I32, pre);
    code.else_();
    code.i32Const(0);
    this.close();
  }

  /** Clear the cell: no kind pending, and the payload ref dropped so the
   * GC can collect it. */
  private emitCellClear(): void {
    this.emitCellClearInto(this.fn.code);
  }

  /** The same clear into ANY `Code` — the runtime builders that CATCH
   * rather than propagate need it (json.ts's `%j`, which turns the
   * circular TypeError into the text "[Circular]"). */
  private emitCellClearInto(c: Code): void {
    const exc = this.exc();
    c.refNull(ANY_HEAP);
    c.globalSet(exc.refG);
    c.i32Const(-1);
    c.globalSet(exc.preG);
    c.i32Const(0);
    c.globalSet(exc.kindG);
  }

  /** Build a builtin error instance from literals and store it into the
   * cell (kind OBJ). Fences and TDZ reads throw this shape; the caller
   * emits the unwind. */
  private emitSetCellErrorLit(className: string, name: string, message: string, codeLit: string | null): void {
    this.emitSetCellError(this.fn.code, className, name, (c) => this.pushStrLitInto(c, message), codeLit);
  }

  /** The same fill into ANY `Code`, with the MESSAGE left to the caller:
   * dynCheck's failure renders its message at runtime (dyn.ts's
   * check_fail), while fences and TDZ reads have theirs as a literal. */
  private emitSetCellError(
    c: Code,
    className: string,
    name: string,
    pushMessage: (c: Code) => void,
    codeLit: string | null,
  ): void {
    const exc = this.exc();
    c.globalGet(this.classes.vtGlobal(className));
    this.pushStrLitInto(c, name);
    pushMessage(c);
    if (codeLit !== null) this.pushStrLitInto(c, codeLit);
    else c.refNull(this.strType);
    c.structNew(exc.errT);
    c.globalSet(exc.refG);
    // The class is known exactly here, so the cell's interval position is
    // a constant — no vt read.
    const meta = this.classes.meta(className);
    if (meta === undefined) throw new Error(`wasm emitter bug: cell error literal of unknown class ${className}`);
    c.i32Const(meta.pre);
    c.globalSet(exc.preG);
    c.i32Const(EXC_OBJ);
    c.globalSet(exc.kindG);
  }

  /** A builtin error class's interval global — errT's `vt` operand. */
  private pushErrVt(className: string): void {
    this.fn.code.globalGet(this.classes.vtGlobal(className));
  }

  /** Evaluate a thrown value and fill the cell from its STATIC type —
   * emit-stmts.ts's scr_throw_* dispatch, ported. The kind tag writes
   * LAST (the commit). The caller emits the unwind. */
  private emitThrowValue(v: WExpr): void {
    const exc = this.exc();
    const code = this.fn.code;
    const t = v.type;
    switch (t.kind) {
      case "f64":
        this.walkExpr(v);
        code.globalSet(exc.f64G);
        code.i32Const(EXC_F64);
        code.globalSet(exc.kindG);
        return;
      case "bool":
        this.walkExpr(v);
        code.f64ConvertI32U();
        code.globalSet(exc.f64G);
        code.i32Const(EXC_BOOL);
        code.globalSet(exc.kindG);
        return;
      case "string":
        this.walkExpr(v);
        code.globalSet(exc.refG);
        code.i32Const(EXC_STR);
        code.globalSet(exc.kindG);
        return;
      case "object": {
        // ANY class instance. The cell records the thrown object's
        // DYNAMIC interval position beside the payload, and THAT is what
        // makes `catch (e) { e instanceof AppError }` work: an
        // Error-typed reference can hold any subclass, so the old
        // class-id compare could not tell user subclasses apart — and a
        // class unrelated to the one being tested for simply falls
        // outside the range instead of failing a cast.
        //
        const info = this.classInfo(t.className, v.loc);
        if (info === null) {
          code.unreachable();
          return;
        }
        const ref = this.classes.ref(info);
        const o = this.acquireScratch(ref);
        this.walkExpr(v);
        code.localSet(o);
        this.emitDynamicPre(o, info);
        code.globalSet(exc.preG);
        code.localGet(o);
        code.globalSet(exc.refG);
        code.i32Const(EXC_OBJ);
        code.globalSet(exc.kindG);
        this.releaseScratch(ref, o);
        return;
      }
      default: {
        // Any other representation rides the generic ref slot (union,
        // record, array, closure — the scr_throw_ref family). mapType
        // refusing is the honest gate for out-of-tier value kinds.
        const soft = this.mapType(t, v.loc);
        if (soft === null || soft.kind !== "ref") {
          this.refuse(`throw:${t.kind}`, v.loc);
          code.unreachable();
          return;
        }
        this.walkExpr(v);
        code.globalSet(exc.refG);
        code.i32Const(EXC_REF);
        code.globalSet(exc.kindG);
        return;
      }
    }
  }

  /** Push a settled promise's (kind, f64, ref) payload triple from a
   * value's STATIC type — emitThrowValue's dispatch, answering the same
   * three slots because a promise payload and a thrown payload share one
   * encoding. `null` is a VOID fulfilment (kind 0, no payload). The
   * unused slots still push their zero: the runtime takes all three.
   * The 4th slot is the OBJ payload's class interval, -1 otherwise —
   * the exception cell's encoding exactly, so a rejection re-entering as
   * an exception restores the class it was thrown with. */
  private emitPayload(v: WExpr | null, what: string, loc: SrcLoc): void {
    const code = this.fn.code;
    if (v === null) {
      code.i32Const(0);
      code.f64Const(0);
      code.refNull(ANY_HEAP);
      code.i32Const(-1);
      return;
    }
    const t = v.type;
    switch (t.kind) {
      case "void":
        // A void-typed call in value position: run it, carry nothing.
        this.walkExpr(v);
        code.i32Const(0);
        code.f64Const(0);
        code.refNull(ANY_HEAP);
        code.i32Const(-1);
        return;
      case "f64":
        code.i32Const(EXC_F64);
        this.walkExpr(v);
        code.refNull(ANY_HEAP);
        code.i32Const(-1);
        return;
      case "bool":
        code.i32Const(EXC_BOOL);
        this.walkExpr(v);
        code.f64ConvertI32U();
        code.refNull(ANY_HEAP);
        code.i32Const(-1);
        return;
      case "string":
        code.i32Const(EXC_STR);
        code.f64Const(0);
        this.walkExpr(v);
        code.i32Const(-1);
        return;
      case "object": {
        // ANY class. The payload now carries the DYNAMIC interval beside
        // the reference, exactly as the exception cell does, so a
        // rejection that re-enters as an exception restores the class it
        // was thrown with — which is what used to force error-rooted
        // reasons and is why `rejecting` no longer gates anything here.
        const info = this.classInfo(t.className, v.loc);
        if (info === null) {
          code.unreachable();
          return;
        }
        const ref = this.classes.ref(info);
        const o = this.acquireScratch(ref);
        this.walkExpr(v);
        code.localSet(o);
        code.i32Const(EXC_OBJ);
        code.f64Const(0);
        code.localGet(o);
        this.emitDynamicPre(o, info);
        this.releaseScratch(ref, o);
        return;
      }
      case "promise":
        // Settling WITH a promise is adoption (see promises.ts): the
        // payload would have to be subscribed to, not stored. The
        // lowering refuses these functions up front; this is the
        // backstop for any other route to the same shape.
        this.refuse(`${what}:adopt`, loc);
        code.unreachable();
        return;
      default: {
        const soft = this.mapType(t, v.loc);
        if (soft === null || soft.kind !== "ref") {
          this.refuse(`${what}:${t.kind}`, loc);
          code.unreachable();
          return;
        }
        code.i32Const(EXC_REF);
        code.f64Const(0);
        this.walkExpr(v);
        code.i32Const(-1);
        return;
      }
    }
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
      const root = this.rootGlobal();
      if (root !== null) {
        // Top-level await: the entry answered with its module evaluation
        // promise. Park it — the checkpoint and `_status` read it from
        // here — and mark it HANDLED, because the loader owns it: its
        // rejection is the program's own stop (rootReport), never an
        // unhandled rejection the ledger walk should answer for.
        c.globalSet(root);
        c.globalGet(root);
        c.i32Const(1);
        c.structSet(this.proms.promT, PROM_OBSERVED);
      } else if (entryFn.returnType.kind === "promise") {
        throw new Error("emitter bug: a promise-returning entry with no root global");
      }
      if (this.mayThrow.has(this.mod.entry)) {
        // An exception that unwound out of %main is UNCAUGHT: Node's
        // observables are exit 1 plus a stderr report, and the trap
        // bridge reports exactly that exit (stderr skipped on nonzero
        // exits — SEMANTICS.md S007's surviving half). BEFORE the drain,
        // deliberately: a synchronous uncaught throw exits without
        // running a single microtask, which is Node's order.
        c.globalGet(this.exc().kindG);
        c.ifVoid();
        c.unreachable();
        c.end();
      }
      // The first checkpoint: run microtasks to quiescence, then answer
      // for any rejection nobody ever looked at. Frames still parked on a
      // promise that never settles are simply dropped — an empty queue IS
      // exit 0, which is what Node does with a suspended await nothing
      // will resolve (a suspended MODULE root is the one exception: that
      // is exit 13, and `_status` is where the host reads it). Nothing is
      // emitted at all when the module has no promise surface (the
      // runtime interns on first use, so a null builder means nothing
      // ever needed it).
      //
      // Where the program can still have macrotasks left, that is only
      // the FIRST checkpoint: `_tick` carries the loop from here, and the
      // host does the waiting (abi.ts).
      this.emitCheckpoint(c);
      this.mb.setBody(start, [], c.bytes());
    }
    this.mb.exportFunc(EXPORT_ENTRY, start);
    if (this.timersField !== null) this.mb.exportFunc(EXPORT_TICK, this.timersField.tick());
    this.emitStatus();
    this.mb.exportMemory(EXPORT_MEMORY);
  }

  /** `_status` (abi.ts): the module evaluation promise's verdict, read at
   * quiescence. 13 — Node's dedicated unsettled-top-level-await status,
   * minus its stderr warning (SEMANTICS.md S012) — while the root is
   * still pending, 0 once it settled. A REJECTED root never reaches here:
   * it trapped at the checkpoint that observed it. Emitted only for a
   * top-level-await program, so nothing else grows an export. */
  private emitStatus(): void {
    const root = this.rootGlobal();
    if (root === null) return;
    const status = this.mb.declareFunc(this.mb.funcType([], [I32]), "%w.status");
    const c = new Code();
    c.globalGet(root);
    c.refIsNull();
    c.ifResult(I32);
    // `_start` never ran: nothing to report on.
    c.i32Const(0);
    c.else_();
    c.globalGet(root);
    c.structGet(this.proms.promT, PROM_STATE);
    c.i32Eqz();
    c.ifResult(I32);
    c.i32Const(13);
    c.else_();
    c.i32Const(0);
    c.end();
    c.end();
    this.mb.setBody(status, [], c.bytes());
    this.mb.exportFunc(EXPORT_STATUS, status);
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
   * keeps a function alive. The edges the scan CANNOT see — a class
   * surface names classes and methods, never function names — are spelled
   * out beside it in `reachableFunctionNames`. */
  private reachableFunctions(): Set<string> {
    return reachableFunctionNames(this.mod);
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
  private fnClosPair(fn: WFunction): { clos: number; fn: number } {
    const params = fn.params.map((p) => this.mapTypeSoft(p.type));
    const results = fn.returnType.kind === "void" ? [] : [this.mapTypeSoft(fn.returnType)];
    return this.closPairFor(params, results);
  }

  /* ── records ────────────────────────────────────────────────────────────
   * One mutable GC struct per shape, fields in CANONICAL (sorted) order —
   * the shape's identity. recordLit allocates with defaults and fills in
   * SOURCE order (JS evaluation order), so canonical layout never
   * reorders effects. Index-signature (overflow) shapes wait on the map
   * runtime.
   *
   * A shape RECURSIVE through its own fields cannot be one type-section
   * entry, because a struct's fields may only name types that already
   * exist — so the whole strongly-connected component becomes one
   * REC GROUP: reserve an index per member, define every member (their
   * fields may now name each other in either direction), close. The group
   * is exactly the SCC and nothing else, because group membership is part
   * of a type's canonical identity in wasm — bracketing an unrelated type
   * in would give it an identity no unbracketed twin could match.
   *
   * WHAT COUNTS AS A STRUCT-LEVEL EDGE is narrower than "mentions": only
   * a record field, or an array whose element chain reaches one, embeds
   * another shape's struct. A UNION field does not — every union value is
   * a ref to the one shared base struct, and the per-arm payload subtypes
   * are separate entries interned at their use sites — so `{ next: N |
   * null }` is not recursive at this level at all and needs no group. */

  private readonly recordInfos = new Map<string, { struct: number; fieldIndex: Map<string, number> } | null>();
  private readonly recordShapes = new Map<string, IrRecordShape>();
  private readonly recordInFlight = new Set<string>();
  /** Shapes whose struct is a reserved index inside the open span. */
  private readonly recordReserved = new Map<string, number>();
  /** A rec-group span is open — spans do not nest (see resolveRecGroup). */
  private recGroupOpen = false;
  /** SCC membership, memoized per shape: the set a shape shares a rec
   * group with, empty when it is not recursive at the struct level. */
  private readonly recordSccs = new Map<string, ReadonlySet<string>>();

  /** The shapes a type embeds STRUCTURALLY — through record fields and
   * array elements only. Unions, promises, closures and dyn all route
   * through a shared struct, so they end the walk. */
  private structRefs(t: IrType, out: Set<string>): void {
    if (t.kind === "record") {
      out.add(t.shapeId);
      return;
    }
    if (t.kind === "array") this.structRefs(t.elem, out);
  }

  /** Every shape reachable from `shapeId` along those edges. */
  private structReach(shapeId: string): Set<string> {
    const seen = new Set<string>();
    const stack = [shapeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const shape = this.recordShapes.get(id);
      if (shape === undefined) continue;
      const next = new Set<string>();
      for (const f of shape.fields) this.structRefs(f.type, next);
      if (shape.indexValue !== undefined) this.structRefs(shape.indexValue, next);
      for (const n of next) {
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    return seen;
  }

  /** `shapeId`'s strongly-connected component, or an EMPTY set when the
   * shape is not on a struct-level cycle. Memoized for every member at
   * once — they all share one answer. */
  private recordScc(shapeId: string): ReadonlySet<string> {
    const hit = this.recordSccs.get(shapeId);
    if (hit !== undefined) return hit;
    const forward = this.structReach(shapeId);
    const scc = new Set<string>();
    if (forward.has(shapeId)) {
      scc.add(shapeId);
      for (const id of forward) {
        if (id !== shapeId && this.structReach(id).has(shapeId)) scc.add(id);
      }
    }
    for (const id of scc) this.recordSccs.set(id, scc);
    if (scc.size === 0) this.recordSccs.set(shapeId, scc);
    return scc;
  }

  /** Resolve a whole SCC as one rec group. Every member ends up in
   * `recordInfos` — with a struct on success, null on refusal, and never
   * a half-built mixture. */
  private resolveRecGroup(scc: ReadonlySet<string>, loc: SrcLoc | undefined, soft: boolean): void {
    // Spans do not nest, and a second group opening inside one would
    // silently merge into it — every entry between begin and end joins
    // whoever opened first, so the group would stop being the SCC and
    // two shapes would acquire an identity no unbracketed twin can
    // match. Nothing reaches here re-entrantly today (`structRefs` stops
    // at unions, and mapTypeSoft answers a union with the shared base
    // rather than mapping arms), which is precisely why this is an
    // assert: the property should fail loudly if it stops holding rather
    // than survive on the accident that identical groups canonicalize.
    if (this.recGroupOpen) {
      throw new Error(`wasm emitter bug: rec group for ${[...scc].sort().join(",")} opened inside another`);
    }
    const members = [...scc].sort();
    // An index-signature member sinks the whole group: its struct needs
    // the map runtime, and the others cannot be defined without it.
    for (const id of members) {
      const shape = this.recordShapes.get(id);
      if (shape === undefined || shape.indexValue !== undefined) {
        for (const m of members) this.recordInfos.set(m, null);
        if (!soft) this.refuseRecord(id, loc);
        return;
      }
    }
    // PRE-RESOLVE everything the members need that is NOT in the SCC,
    // OUTSIDE the span — otherwise it would be interned inside and join
    // the group. A field type that reaches the SCC at all is itself on a
    // cycle through this member and so is already a member, which is why
    // this test is exactly "touches the SCC".
    for (const id of members) {
      for (const f of this.recordShapes.get(id)!.fields) {
        const refs = new Set<string>();
        this.structRefs(f.type, refs);
        const reachesScc = [...refs].some((r) => scc.has(r) || [...this.structReach(r)].some((s) => scc.has(s)));
        if (!reachesScc) this.mapTypeSoft(f.type);
      }
    }
    this.recGroupOpen = true;
    this.mb.beginRecGroup();
    for (const id of members) {
      // A frame shape subtypes frameBase, and a reservation cannot carry
      // a supertype — no corpus program puts a frame on a cycle, so this
      // asserts rather than handles.
      if (id.startsWith(FRAME_SHAPE_PREFIX)) {
        throw new Error(`wasm emitter bug: resumable frame shape ${id} on a struct-level cycle`);
      }
      this.recordReserved.set(id, this.mb.reserveType(`record:${id}`));
    }
    const built: { id: string; fields: { storage: ValType; mutable: boolean }[] }[] = [];
    for (const id of members) {
      const shape = this.recordShapes.get(id)!;
      // The in-SCC members now resolve to their reservations, and the
      // vector types an array field needs intern HERE — inside the span,
      // which is where they belong: a vec of an SCC member is on the
      // cycle too (vec struct -> buffer array -> member struct).
      built.push({ id, fields: shape.fields.map((f) => ({ storage: this.mapTypeSoft(f.type), mutable: true })) });
    }
    for (const { id, fields } of built) {
      this.mb.defineType(this.recordReserved.get(id)!, { kind: "struct", fields });
    }
    this.mb.endRecGroup();
    this.recGroupOpen = false;
    for (const id of members) {
      const shape = this.recordShapes.get(id)!;
      this.recordInfos.set(id, {
        struct: this.recordReserved.get(id)!,
        fieldIndex: new Map(shape.fields.map((f, i) => [f.name, i])),
      });
      this.recordReserved.delete(id);
    }
  }

  private recordInfo(shapeId: string, loc: SrcLoc | undefined, soft: boolean): { struct: number; fieldIndex: Map<string, number> } | null {
    const cached = this.recordInfos.get(shapeId);
    if (cached !== undefined) {
      if (cached === null && !soft) this.refuseRecord(shapeId, loc);
      return cached;
    }
    // Mid-group: the reservation IS the answer, which is what lets a
    // member's fields name the others.
    const reserved = this.recordReserved.get(shapeId);
    if (reserved !== undefined) {
      const shape = this.recordShapes.get(shapeId);
      if (shape === undefined) throw new Error(`unknown record shape ${shapeId}`);
      return { struct: reserved, fieldIndex: new Map(shape.fields.map((f, i) => [f.name, i])) };
    }
    const shape = this.recordShapes.get(shapeId);
    if (shape === undefined) throw new Error(`unknown record shape ${shapeId}`);
    const scc = this.recordScc(shapeId);
    if (scc.size > 0) {
      this.resolveRecGroup(scc, loc, soft);
      const made = this.recordInfos.get(shapeId) ?? null;
      if (made === null && !soft) this.refuseRecord(shapeId, loc);
      return made;
    }
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
    // A resumable function's frame is a SUBTYPE of the shared frame base,
    // which is the whole reason one waiter queue can hold every async
    // function's parked frames (statemachine.ts's ONE RESUME SIGNATURE).
    // Keyed by shape id — two frames with identical layouts are still
    // distinct declarations, exactly like closure envs.
    const struct = shapeId.startsWith(FRAME_SHAPE_PREFIX)
      ? this.mb.subStructType(`frame:${shapeId}`, fields, this.frameBaseType())
      : this.mb.structType(fields);
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

  /** The IR's TDZ contract: the NULL slot IS the sentinel — so a TDZ box
   * over a NON-ref payload rides one extra indirection (a one-field inner
   * struct, the C runtime's pointer-slot shape for tdz scalars). Null
   * when the payload is already a ref (its own nullability serves). */
  private tdzInnerFor(v: ValType): number | null {
    return v.kind === "ref" ? null : this.mb.structType([{ storage: v, mutable: false }]);
  }

  /** The box type for a LOCAL — tdz-aware where the plain valtype box is
   * not. Every box site must go through this (a plain boxTypeFor on a
   * tdz scalar would make the read's null test type-invalid). */
  private boxTypeForLocal(local: IrLocal): number {
    const soft = this.mapTypeSoft(local.type);
    if (local.tdz !== true) return this.boxTypeFor(soft);
    const inner = this.tdzInnerFor(soft);
    return inner === null
      ? this.boxTypeFor(soft)
      : this.boxTypeFor({ kind: "ref", nullable: true, typeIndex: inner });
  }

  private boxRefForLocal(local: IrLocal): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.boxTypeForLocal(local) };
  }

  /** The env struct for a function with captures: code + one box ref per
   * capture, a subtype of the signature's closure struct. */
  private envTypeFor(fn: WFunction): number {
    const pair = this.fnClosPair(fn);
    return this.mb.subStructType(
      `env:${fn.name}`,
      [
        { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
        ...(fn.captures ?? []).map((c) => {
          // Capture entries inherit tdz from their LOCAL twin (the IR
          // lists every capture in locals too) — a tdz scalar's box type
          // differs, and env fields must agree with the local slots.
          const local = fn.locals.find((l) => l.id === c.localId);
          const storage =
            local !== undefined ? this.boxRefForLocal(local) : this.boxRefFor(this.mapTypeSoft(c.type));
          return { storage, mutable: false };
        }),
      ],
      pair.clos,
    );
  }

  /* ── the resumable lowering's runtime ───────────────────────────────────
   *
   * One promise struct, one waiter queue, one rejection ledger
   * (promises.ts) — plus the empty OPEN struct every frame shape subtypes,
   * which is what gives every `%<fn>.resume` the same wasm signature and
   * so lets the queue be typed at all. Both are interned on first use, so
   * a module with no promise surface emits neither. */

  private frameBaseField: number | null = null;

  private frameBaseType(): number {
    this.frameBaseField ??= this.mb.openStructType("%frameBase", []);
    return this.frameBaseField;
  }

  private promsField: PromiseBuilder | null = null;

  private get proms(): PromiseBuilder {
    this.promsField ??= new PromiseBuilder(this.mb, this.strType, {
      frameBase: () => this.frameBaseType(),
      resumeClos: () => this.resumeClosPair(),
      tags: { f64: EXC_F64, bool: EXC_BOOL, str: EXC_STR, obj: EXC_OBJ },
      errInterval: (c) => this.emitErrIntervalTest(c),
      anyRef: ANY_REF,
      errT: () => this.exc().errT,
      f64ToStr: () => this.f64ToStrHelper(),
      errToStr: () => this.errToStrHelper(),
      out: () => this.ensureHelpers(),
      lit: (c, s) => this.pushStrLitInto(c, s),
    });
    return this.promsField;
  }

  /** The signature EVERY resume has: (frame base) → void. The waiter
   * queue's call_ref goes through this pair, and so does every `closure`
   * node over a resume (the lowering types them the same way). */
  private resumeClosPair(): { clos: number; fn: number } {
    return this.closPairFor([{ kind: "ref", nullable: true, typeIndex: this.frameBaseType() }], []);
  }

  /* ── the top-level-await root (abi.ts's `_status`, SEMANTICS.md S010) ──
   * A program whose ENTRY is an async module has a module evaluation
   * promise, and Node reports on it: rejected is exit 1 at the checkpoint
   * that saw it (before any later timer), still pending at quiescence is
   * exit 13. `_start` parks it in this global; the checkpoint and
   * `_status` are its two readers. Interned only for such a program, so
   * every other module is byte-identical to what it compiled to before. */

  private rootField: number | null = null;

  private rootGlobal(): number | null {
    if (!this.asyncEntry) return null;
    this.rootField ??= this.mb.addGlobal(this.proms.promRef(), true, (w) => {
      w.u8(0xd0); // ref.null $promise
      w.sleb(this.proms.promT);
    });
    return this.rootField;
  }

  /** One microtask checkpoint: drain to quiescence, answer for a rejection
   * nobody looked at, and — in a top-level-await program — stop the world
   * on a rejected module root. `_start` runs it once after the entry
   * returns and `_tick` after every macrotask callback, which is where
   * Node decides all three (timers.ts's checkpoint dep).
   *
   * The root check comes AFTER the ledger report, where scr_loop_run puts
   * it FIRST. Both orders reach the same observable: the two verdicts are
   * the same exit 1 at the same point in the same checkpoint, over the
   * same stdout, and the stderr line they disagree about is not compared
   * on a nonzero exit (S007's surviving half, S010's root paragraph). A
   * program with no module root emits exactly what it did before this
   * existed — the check is three instructions that only appear with one. */
  private emitCheckpoint(c: Code): void {
    if (this.promsField === null) return;
    c.call(this.proms.drain());
    c.call(this.proms.report());
    const root = this.rootGlobal();
    if (root === null) return;
    c.globalGet(root);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.globalGet(root);
    c.structGet(this.proms.promT, PROM_STATE);
    c.i32Const(2);
    c.i32Eq();
    c.ifVoid();
    c.globalGet(root);
    c.call(this.proms.rootReport()); // renders, then traps
    c.end();
    c.end();
  }

  /* ── the timer runtime and the loop the host pumps (timers.ts) ────────
   * Interned by the first `timers.*` libCall, so a module with no timer
   * surface emits neither the runtime nor the `_tick` export — and stays
   * byte-identical to what it compiled to before this existed. */

  private timersField: TimerBuilder | null = null;

  private get timers(): TimerBuilder {
    this.timersField ??= new TimerBuilder(this.mb, {
      voidClos: () => this.closPairFor([], []),
      now: () => {
        if (this.nowFunc === null) {
          // The constructor's prescan and the walk disagreed, which can
          // only mean the scan stopped seeing an IR shape it must see.
          throw new Error("emitter bug: a timer was armed but tsinter.now was never imported");
        }
        return this.nowFunc;
      },
      excKind: () => this.exc().kindG,
      checkpoint: (c) => this.emitCheckpoint(c),
    });
    return this.timersField;
  }

  /* ── unions ─────────────────────────────────────────────────────────────
   * One shared open base struct { tag } every payload arm subtypes with
   * { tag, payload } (unions.ts). A union value is (ref null base)
   * EVERYWHERE — mapType never refuses a union type; arms gate at the
   * sites that read or build their payloads. The dispatch helpers
   * (ToBoolean / equality / ToString) intern per union, and the emitter
   * resolves each arm's representation first so refusals for arms a
   * helper genuinely needs stay in the census with honest names. */

  private unionsField: UnionBuilder | null = null;

  private get unions(): UnionBuilder {
    this.unionsField ??= new UnionBuilder(this.mb, {
      strEq: () => this.strEqHelper(),
      f64ToStr: () => this.f64ToStrHelper(),
      strRef: () => this.strRef,
      lit: (c, s) => this.pushStrLitInto(c, s),
    });
    return this.unionsField;
  }

  /* ── the checked-dynamic surface (dyn.ts) ───────────────────────────────
   * One `$dyn` struct with an explicit kind tag, four interned constant
   * boxes, and the dispatch helpers the C runtime spells as scr_dyn_*.
   * Interned by first use, so a module with no `unknown` in it emits
   * neither the type nor a single helper. */

  private dynField: DynBuilder | null = null;

  private get dyn(): DynBuilder {
    this.dynField ??= new DynBuilder(this.mb, {
      strRef: () => this.strRef,
      strType: () => this.strType,
      strEq: () => this.strEqHelper(),
      concat: () => this.concatHelper(),
      f64ToStr: () => this.f64ToStrHelper(),
      lit: (c, s) => this.pushStrLitInto(c, s),
      throwTypeError: (c, pushMessage) =>
        this.emitSetCellError(c, "%TypeError", "TypeError", pushMessage, null),
      arrVec: () => this.dynVecInfo(),
      arrPush: () => this.vecs.pushOne(this.dynVecInfo()),
      arrNewLen: () => this.vecs.newLen(this.dynVecInfo()),
      strCpAt: () => this.strs.cpAt(),
      errT: () => this.exc().errT,
      errName: () => ERR_NAME,
      errMessage: () => ERR_MESSAGE,
      errCode: () => ERR_CODE,
      throwError: (c, className, name, pushMessage) =>
        this.emitSetCellError(c, className, name, pushMessage, null),
      excKind: () => this.exc().kindG,
      strCmpU16: () => this.strCmpHelper(true),
      strSlice: () => this.strs.slice(),
      strIndexOf: () => this.strs.indexOf(),
      strMatchAt: () => this.strs.matchAt(),
    });
    return this.dynField;
  }

  /* ── JSON.parse (json.ts) ──────────────────────────────────────────────
   * A recursive-descent parser over the tier's UTF-16 string, emitted
   * once per module that calls `JSON.parse` and interned by first use. */

  private jsonField: JsonBuilder | null = null;

  private get json(): JsonBuilder {
    this.jsonField ??= new JsonBuilder(this.mb, {
      strRef: () => this.strRef,
      strType: () => this.strType,
      concat: () => this.concatHelper(),
      f64ToStr: () => this.f64ToStrHelper(),
      lit: (c, s) => this.pushStrLitInto(c, s),
      throwError: (c, className, name, pushMessage) =>
        this.emitSetCellError(c, className, name, pushMessage, null),
      excKind: () => this.exc().kindG,
      clearExc: (c) => this.emitCellClearInto(c),
      newDynVec: (c) => {
        c.f64Const(0);
        c.call(this.vecs.newLen(this.dynVecInfo()));
      },
      dyn: () => this.dyn,
    });
    return this.jsonField;
  }

  /* ── util.inspect (inspect.ts) ─────────────────────────────────────────
   * The append buffer, the UTF-16 measures, the quoting ladder and the
   * leaf renderings; the frontend's synthesized per-type traversals
   * (lower-inspect.ts) drive them through `insp.*` libCalls. Interned by
   * first use, so a module that never inspects anything is byte-identical
   * to what it compiled to before. */

  private inspField: InspectBuilder | null = null;

  private get insp(): InspectBuilder {
    this.inspField ??= new InspectBuilder(this.mb, {
      strRef: () => this.strRef,
      strType: () => this.strType,
      lit: (c, s) => this.pushStrLitInto(c, s),
      f64ToStr: () => this.f64ToStrHelper(),
      errT: () => this.exc().errT,
      errName: () => ERR_NAME,
      errMessage: () => ERR_MESSAGE,
      errCode: () => ERR_CODE,
      dyn: () => this.dyn,
      inspF64: () => this.inspF64Helper(),
      throwError: (c, className, name, pushMessage) =>
        this.emitSetCellError(c, className, name, pushMessage, null),
      excKind: () => this.exc().kindG,
    });
    return this.inspField;
  }

  /** The ARR payload's vector info — the SAME interning a static
   * `dyn[]` would get (`vecKeyFor` answers "dyn" for a dyn element), so
   * the two can never become distinct types by accident. */
  private dynVecInfo(): VecInfo {
    const elem = this.dyn.dynRef();
    return this.vecs.info("dyn", elem, elem, "ref");
  }

  /* ── the type-directed dyn walkers ─────────────────────────────────────
   * The C emitter GENERATES these as C functions (emit-walkers.ts's
   * sc_td_N / sc_dc_N / sc_dm_N families); here they are emitted wasm
   * functions with the same interning discipline — one per typeKey, the
   * index published BEFORE the body is built so a self-referential shape
   * terminates instead of recursing forever.
   *
   * They live at the emitter rather than in dyn.ts because building the
   * STATIC side of a conversion is emitter knowledge: record structs,
   * vectors, union arm subtypes and their canonical tags. dyn.ts owns the
   * representation and the primitives; these own the type direction.
   *
   * A walker body is emitted OUTSIDE any IR function, so there is no
   * `fn` state and no handler stack: a nested check that throws leaves
   * the cell set, and `emitWalkerPending` returns the result type's zero
   * so the CALLER's own pending check fires. That is exactly the
   * discipline the generated C follows (`if (scr_exc_pending()) return
   * NULL;`) minus the release calls the GC makes unnecessary. */

  private readonly dynFromFns = new Map<string, number>();
  private readonly dynCheckFns = new Map<string, number>();
  private readonly dynMatchFns = new Map<string, number>();

  /** The zero of a representation — a walker's dummy return. */
  private pushZeroInto(c: Code, t: ValType | null): void {
    if (t === null) return;
    switch (t.kind) {
      case "f64":
        c.f64Const(0);
        return;
      case "i64":
        c.i64Const(0n);
        return;
      case "ref":
        c.refNull(t.typeIndex);
        return;
      default:
        c.i32Const(0);
        return;
    }
  }

  /** After a nested call that may throw: bail with the dummy. */
  private emitWalkerPending(c: Code, result: ValType | null): void {
    c.globalGet(this.exc().kindG);
    c.ifVoid();
    this.pushZeroInto(c, result);
    c.return_();
    c.end();
  }

  /** The C emitter's `dynDesc` — the short noun a failure reports for a
   * target type. Records read as "object" (the path already says where;
   * the full shape would bloat the message) and tuples as "array",
   * because that IS the JSON they require. The trailing fallback covers
   * kinds C throws on: they are all unmappable, so the only messages that
   * could carry one belong to programs that refuse anyway. */
  private dynDescOf(t: IrType): string {
    switch (t.kind) {
      case "f64":
        return "number";
      case "string":
        return "string";
      case "bool":
        return "boolean";
      case "record":
        return this.recordShapes.get(t.shapeId)?.tuple === true ? "array" : "object";
      case "array":
        return "array";
      case "nullT":
        return "null";
      case "undefinedT":
        return "undefined";
      case "dyn":
        return "unknown";
      case "bytes":
        return "Uint8Array";
      case "object":
        return t.className.replace(/^%/, "");
      case "func":
        return "function";
      case "map":
        return "Map";
      case "set":
        return "Set";
      case "union":
        return this.unionDef(t.unionId).arms.map((a) => this.dynDescOf(a)).join(" | ");
      default:
        return t.kind;
    }
  }

  /** A record shape's fields in the order a dyn OBJECT must carry them —
   * the FROM direction only: DECLARED order first (a dyn object's
   * insertion order is observable through Object.keys, for-in and JSON),
   * then any field the declared list omits — the internal '%' members,
   * which round-trip after the visible keys. toDynHelper's rule, ported.
   *
   * THE TWO DIRECTIONS USE DIFFERENT ORDERS, deliberately. Going OUT
   * (here) the order is what the reader will observe, so it must be JS's
   * insertion order. Coming IN (check/match, `tupleOrCanonical`) the
   * order is CANONICAL — the sorted list that IS the shape's identity —
   * because it decides which field a failure names first, and that has to
   * be the same field on every lane. The C and LLVM walkers iterate
   * `shape.fields` there for exactly this reason; iterating declared
   * order instead made a record with two bad fields report a different
   * one here than natively. */
  private dynFieldOrder(shape: IrRecordShape): typeof shape.fields {
    const byName = new Map(shape.fields.map((f) => [f.name, f]));
    const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
    const inOrder = new Set(order);
    return [
      ...order.map((n) => byName.get(n)).filter((f): f is (typeof shape.fields)[number] => f !== undefined),
      ...shape.fields.filter((f) => !inOrder.has(f.name)),
    ];
  }

  /** Tuple fields positionally ("0".."n-1"). */
  private tupleFieldOrder(shape: IrRecordShape): typeof shape.fields {
    return [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
  }

  /** One walker body under construction. Explicit state rather than a
   * field on the emitter: generating a walker RECURSES into the walkers
   * its parts need, and each of those builds its own body — a shared
   * `locals` array would interleave them. */
  private newWalker(params: number): WalkerCtx {
    return { c: new Code(), locals: [], base: params };
  }

  /** Claim a local in `w`. Walkers take no closure argument (they are
   * runtime helpers, not IR functions), so slots start at `base`. */
  private wlocal(w: WalkerCtx, t: ValType): number {
    const index = w.base + w.locals.length;
    w.locals.push(t);
    return index;
  }

  /** Publish a declared walker whose body construction FAILED: the census
   * already carries the refusal name, the emit sink has thrown, and the
   * survey sink assembles nothing — so an honest trap stands in for a
   * body that must never run. */
  private walkerDead(idx: number): null {
    const dead = new Code();
    dead.unreachable();
    this.mb.setBody(idx, [], dead.bytes());
    return null;
  }

  /** %w.dyn.from:<typeKey> — the static→dyn walker (C's sc_td_N), which
   * DEEP-COPIES composites: a dyn value never aliases static storage, so
   * a later mutation of the source cannot be observed through the dyn
   * tree. Never throws. Null (refusal recorded) when a part is out of
   * tier — the refusal names the SHAPE, not just "dynFrom". */
  private dynFromHelper(t: IrType, loc: SrcLoc | undefined): number | null {
    const key = typeKey(t);
    const hit = this.dynFromFns.get(key);
    if (hit !== undefined) return hit;
    const val = this.mapType(t, loc);
    if (val === null) return null;
    const idx = this.mb.declareFunc(this.mb.funcType([val], [this.dyn.dynRef()]), `%w.dyn.from:${key}`);
    this.dynFromFns.set(key, idx);
    const w = this.newWalker(1);
    if (!this.emitDynFromBody(w, t, loc)) return this.walkerDead(idx);
    this.mb.setBody(idx, w.locals, w.c.bytes());
    return idx;
  }

  private emitDynFromBody(w: WalkerCtx, t: IrType, loc: SrcLoc | undefined): boolean {
    const c = w.c;
    const dyn = this.dyn;
    switch (t.kind) {
      case "f64":
        dyn.boxNum(c, (x) => x.localGet(0));
        return true;
      case "bool":
        dyn.boxBool(c, (x) => x.localGet(0));
        return true;
      case "string":
        dyn.boxStr(c, (x) => x.localGet(0));
        return true;
      case "undefinedT":
        c.globalGet(dyn.undefinedGlobal());
        return true;
      case "nullT":
        c.globalGet(dyn.nullGlobal());
        return true;
      case "dyn":
        // Already dyn — C's retain, which the GC makes a no-op.
        c.localGet(0);
        return true;
      case "object": {
        // The only class the boundary admits is an ERROR (the frontend's
        // canConvertToDyn gate), and it converts to the reserved-key
        // encoding through the identity cache — a class rooted anywhere
        // else has no dyn shape at all and refuses by NAME.
        if (!this.isErrorRooted(t.className)) {
          this.refuse(`dynFrom:object:${t.className}`, loc);
          return false;
        }
        c.localGet(0);
        c.call(dyn.fromError());
        return true;
      }
      case "record": {
        const shape = this.recordShapes.get(t.shapeId);
        const info = this.recordInfo(t.shapeId, loc, false);
        if (shape === undefined || info === null) return false;
        if (shape.tuple) {
          // A tuple converts as the JSON ARRAY it is everywhere else.
          const a = this.wlocal(w, dyn.arrRef());
          c.f64Const(0);
          c.call(this.vecs.newLen(this.dynVecInfo()));
          c.localSet(a);
          for (const f of this.tupleFieldOrder(shape)) {
            const inner = this.dynFromHelper(f.type, loc);
            const slot = info.fieldIndex.get(f.name);
            if (inner === null || slot === undefined) return false;
            c.localGet(a);
            c.localGet(0);
            c.structGet(info.struct, slot);
            c.call(inner);
            c.call(dyn.arrPush());
          }
          dyn.boxArr(c, (x) => x.localGet(a));
          return true;
        }
        const o = this.wlocal(w, dyn.objRef());
        dyn.pushNewObj(c, false);
        c.localSet(o);
        // Keys insert in DECLARED order: a dyn object's insertion order is
        // observable (Object.keys, for-in, JSON), so it must be JS's.
        for (const f of this.dynFieldOrder(shape)) {
          const inner = this.dynFromHelper(f.type, loc);
          const slot = info.fieldIndex.get(f.name);
          if (inner === null || slot === undefined) return false;
          c.localGet(o);
          this.pushStrLitInto(c, f.name);
          c.localGet(0);
          c.structGet(info.struct, slot);
          c.call(inner);
          c.call(dyn.objPut());
        }
        dyn.boxObj(c, (x) => x.localGet(o));
        return true;
      }
      case "array": {
        const src = this.vecInfoFor(t, loc);
        const inner = this.dynFromHelper(t.elem, loc);
        if (src === null || inner === null) return false;
        const a = this.wlocal(w, dyn.arrRef());
        const i = this.wlocal(w, I32);
        const n = this.wlocal(w, I32);
        c.f64Const(0);
        c.call(this.vecs.newLen(this.dynVecInfo()));
        c.localSet(a);
        c.localGet(0);
        c.structGet(src.struct, 0);
        c.localSet(n);
        c.i32Const(0);
        c.localSet(i);
        c.block();
        c.loop();
        c.localGet(i);
        c.localGet(n);
        c.i32GeU();
        c.brIf(1);
        c.localGet(a);
        c.localGet(0);
        c.structGet(src.struct, 1);
        c.localGet(i);
        this.vecs.emitElemRead(c, src);
        c.call(inner);
        c.call(dyn.arrPush());
        c.localGet(i);
        c.i32Const(1);
        c.i32Add();
        c.localSet(i);
        c.br(0);
        c.end();
        c.end();
        dyn.boxArr(c, (x) => x.localGet(a));
        return true;
      }
      case "union": {
        const def = this.unionDef(t.unionId);
        const tag = this.wlocal(w, I32);
        c.localGet(0);
        c.structGet(this.unions.base(), 0);
        c.localSet(tag);
        for (let i = 0; i < def.arms.length; i++) {
          const arm = def.arms[i]!;
          c.localGet(tag);
          c.i32Const(i);
          c.i32Eq();
          c.ifVoid();
          if (arm.kind === "undefinedT") {
            c.globalGet(dyn.undefinedGlobal());
          } else if (arm.kind === "nullT") {
            c.globalGet(dyn.nullGlobal());
          } else {
            const struct = this.unionArmStruct(t.unionId, i, loc);
            const inner = this.dynFromHelper(arm, loc);
            if (struct === null || inner === null) return false;
            c.localGet(0);
            c.refCast(struct);
            c.structGet(struct, 1);
            c.call(inner);
          }
          c.return_();
          c.end();
        }
        // A corrupted tag is loud, never silent (the union helpers' rule).
        c.unreachable();
        return true;
      }
      case "promise": {
        // Promises box BY REFERENCE — identity is the promise, so one
        // promise crossing twice stays one JS value. C boxes the
        // ScrPromise directly when the inner type is ALREADY dyn, and
        // otherwise builds an adapter promise whose settle callback
        // converts the payload; only the direct form lands here.
        if (t.inner.kind !== "dyn") {
          this.refuse("dynFrom:promise:adapt", loc);
          return false;
        }
        c.i32Const(DK.PROMISE);
        c.f64Const(0);
        c.localGet(0);
        c.structNew(dyn.dynT());
        return true;
      }
      case "func": {
        // A closure inside a converting composite (a union arm, a
        // thunk's result, an adapter's argument) boxes ANONYMOUSLY: by
        // the time a value reaches one of those positions its static
        // name is gone, so FN_NAME is null and `f.name` reads "".
        // C's `toDynExprC` func arm exactly. The NAMED spelling belongs
        // to the dynFrom EXPRESSION, which has `fnName` at hand.
        const box = this.dynFnBox(t, loc);
        if (box === null) return false;
        c.localGet(0);
        c.refNull(this.strType);
        c.call(box);
        return true;
      }
      default:
        this.refuse(`dynFrom:${t.kind}`, loc);
        return false;
    }
  }

  /* ── the type-directed JSON serializers ────────────────────────────────
   * `JSON.stringify(v)` compiles to a walker chosen by v's STATIC type —
   * C's sc_jw_* family (emit-walkers.ts jsonWriteHelper), ported with the
   * same interning discipline as the dyn walkers above. Each writes into
   * the module's one output buffer (json.ts's jb globals) and returns
   * nothing; the SITE brackets the call with the buffer's begin/finish.
   *
   * Nothing here can throw in this increment. Every static JSON-safe type
   * the tier admits today is ACYCLIC (recordInfo refuses shapes recursive
   * through their own fields, which is exactly the cycle-capable set), and
   * no user code runs mid-walk — so there is no circular-structure check
   * to pay for and no pending check at the site. Recursive shapes and
   * their circular detection are their own stage. */

  private readonly jsonWriteFns = new Map<string, number>();
  private readonly jsonCyclicShapes = new Map<string, boolean>();

  /** Can a VALUE of this type take part in a reference cycle the
   * stringify walk would traverse?
   *
   * THIS IS NOT THE REC-GROUP SCC, and the difference is load-bearing. A
   * rec group asks which structs embed each other, so a union field ends
   * the walk — every union value is a ref to one shared base. A CYCLE
   * asks which values can point back, and a union arm carries a payload
   * like any other reference: `interface L { next: L | null }` needs no
   * rec group at all and still builds cycles (`a.next = b; b.next = a`),
   * which Node reports as a circular structure. C draws the same line —
   * its `traceAdapterC` answers non-null for a traced UNION — and the
   * corpus program's chain-with-ellipsis case is exactly this shape. */
  private jsonCyclic(t: IrType): boolean {
    switch (t.kind) {
      case "record":
        return this.jsonCyclicShape(t.shapeId);
      case "array":
        return this.jsonCyclic(t.elem);
      case "union":
        return this.unionDef(t.unionId).arms.some((a) => this.jsonCyclic(a));
      default:
        return false;
    }
  }

  /** Is this shape reachable from itself through fields, array elements
   * and union arms? Memoized; the walk carries its own visited set, so a
   * shape that merely CONTAINS a recursive one answers honestly. */
  private jsonCyclicShape(shapeId: string): boolean {
    const hit = this.jsonCyclicShapes.get(shapeId);
    if (hit !== undefined) return hit;
    // Provisional false: a shape re-entered during its own walk is not
    // itself the answer, the shape that closed the loop is.
    this.jsonCyclicShapes.set(shapeId, false);
    const seen = new Set<string>();
    const reaches = (t: IrType): boolean => {
      switch (t.kind) {
        case "record": {
          if (t.shapeId === shapeId) return true;
          if (seen.has(t.shapeId)) return false;
          seen.add(t.shapeId);
          const s = this.recordShapes.get(t.shapeId);
          if (s === undefined) return false;
          return s.fields.some((f) => reaches(f.type)) || (s.indexValue !== undefined && reaches(s.indexValue));
        }
        case "array":
          return reaches(t.elem);
        case "union":
          return this.unionDef(t.unionId).arms.some((a) => reaches(a));
        default:
          return false;
      }
    };
    const shape = this.recordShapes.get(shapeId);
    const answer =
      shape !== undefined &&
      (shape.fields.some((f) => reaches(f.type)) ||
        (shape.indexValue !== undefined && reaches(shape.indexValue)));
    this.jsonCyclicShapes.set(shapeId, answer);
    return answer;
  }

  /** %w.json.write:<typeKey> — the serializer for one static type. Null
   * (refusal recorded by whichever part failed) when a constituent is out
   * of tier: a recursive record shape names itself `record:recursive`
   * through recordInfo, which is the census signal for the stage that
   * lands it. */
  private jsonWriteHelper(t: IrType, loc: SrcLoc | undefined): number | null {
    const key = typeKey(t);
    const hit = this.jsonWriteFns.get(key);
    if (hit !== undefined) return hit;
    const val = this.mapType(t, loc);
    if (val === null) return null;
    const idx = this.mb.declareFunc(this.mb.funcType([val], []), `%w.json.write:${key}`);
    this.jsonWriteFns.set(key, idx);
    const w = this.newWalker(1);
    if (!this.emitJsonWriteBody(w, t, loc)) return this.walkerDead(idx);
    this.mb.setBody(idx, w.locals, w.c.bytes());
    return idx;
  }

  private emitJsonWriteBody(w: WalkerCtx, t: IrType, loc: SrcLoc | undefined): boolean {
    const c = w.c;
    const json = this.json;
    switch (t.kind) {
      case "f64":
        c.localGet(0);
        c.call(json.jbPutF64());
        return true;
      case "bool":
        c.localGet(0);
        c.ifResult(this.strRef);
        this.pushStrLitInto(c, "true");
        c.else_();
        this.pushStrLitInto(c, "false");
        c.end();
        c.call(json.jbPuts());
        return true;
      case "string":
        c.localGet(0);
        c.call(json.jbPutStr());
        return true;
      case "record": {
        const shape = this.recordShapes.get(t.shapeId);
        const info = this.recordInfo(t.shapeId, loc, false);
        if (shape === undefined || info === null) return false;
        // A cycle-capable container brackets its body with the detection
        // stack, and stamps the edge before every member whose own walk
        // could re-enter. Acyclic shapes emit none of this.
        const cyclic = this.jsonCyclic(t);
        const edgeable = (ft: IrType): boolean => cyclic && this.jsonCyclic(ft);
        if (cyclic) {
          c.localGet(0);
          c.i32Const(shape.tuple === true ? 1 : 0);
          c.call(json.jbEnter());
          c.i32Eqz();
          c.ifVoid();
          c.return_(); // circular: the TypeError is pending
          c.end();
        }
        // A TUPLE serializes as the JSON array it is, in index order —
        // JS-exact (`JSON.stringify(["a", 1])` is `["a",1]`). Every
        // position is required (an undefined-armed position takes the
        // ARRAY rule, so the frontend fences it), which keeps the commas
        // static.
        if (shape.tuple) {
          this.pushStrLitInto(c, "[");
          c.call(json.jbPuts());
          const byIndex = this.tupleFieldOrder(shape);
          for (let i = 0; i < byIndex.length; i++) {
            const f = byIndex[i]!;
            const inner = this.jsonWriteHelper(f.type, loc);
            const slot = info.fieldIndex.get(f.name);
            if (inner === null || slot === undefined) return false;
            if (i > 0) {
              c.i32Const(0x2c);
              c.call(json.jbPutc());
            }
            if (edgeable(f.type)) {
              c.i32Const(i);
              c.call(json.jbEdgeIdx());
            }
            c.localGet(0);
            c.structGet(info.struct, slot);
            c.call(inner);
          }
          this.pushStrLitInto(c, "]");
          c.call(json.jbPuts());
          if (cyclic) c.call(json.jbLeave());
          return true;
        }
        // Fields serialize in DECLARED order — JS insertion order, which
        // is what a reader observes — never the canonical (sorted) struct
        // order.
        //
        // WHAT HIDES A COMPILER-SYNTHESIZED FIELD IS declaredOrder
        // OMISSION, NOT ITS NAME. Internals like Dirent's `%dtype` are
        // absent from declaredOrder, so mapping over `order` already
        // leaves them out — while a key a PROGRAM spelled `"%x"` is
        // present in declaredOrder and must serialize, because Node
        // prints it and so do the native lanes. Filtering on the '%'
        // prefix here instead would drop that key silently, which is a
        // miscompile rather than a refusal; the unit tests pin it.
        // A declaredOrder omitting a VISIBLE field is an emitter bug.
        const byName = new Map(shape.fields.map((f) => [f.name, f]));
        const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
        const inOrder = new Set(order);
        if (shape.fields.some((f) => !inOrder.has(f.name) && !f.name.startsWith("%"))) {
          throw new Error(`wasm emitter bug: declaredOrder of shape ${t.shapeId} omits a non-internal field`);
        }
        const fields = order
          .map((n) => byName.get(n))
          .filter((f): f is (typeof shape.fields)[number] => f !== undefined);
        // An optional-flavored field (an undefined-armed union — the
        // `a?: T` spelling) DROPS from the output while it holds the
        // undefined arm, exactly like Node. One such field anywhere makes
        // comma placement runtime state (a `first` flag); an all-required
        // shape keeps its separators baked into the label literals.
        const droppable = fields.some((f) => this.undefinedArmTag2(f.type) >= 0);
        if (!droppable) {
          for (let i = 0; i < fields.length; i++) {
            const f = fields[i]!;
            const inner = this.jsonWriteHelper(f.type, loc);
            const slot = info.fieldIndex.get(f.name);
            if (inner === null || slot === undefined) return false;
            this.pushStrLitInto(c, `${i === 0 ? "{" : ","}${jsonQuote(f.name)}:`);
            c.call(json.jbPuts());
            if (edgeable(f.type)) {
              this.pushStrLitInto(c, f.name);
              c.call(json.jbEdgeProp());
            }
            c.localGet(0);
            c.structGet(info.struct, slot);
            c.call(inner);
          }
          this.pushStrLitInto(c, fields.length === 0 ? "{}" : "}");
          c.call(json.jbPuts());
          if (cyclic) c.call(json.jbLeave());
          return true;
        }
        const first = this.wlocal(w, I32);
        this.pushStrLitInto(c, "{");
        c.call(json.jbPuts());
        c.i32Const(1);
        c.localSet(first);
        for (const f of fields) {
          const inner = this.jsonWriteHelper(f.type, loc);
          const slot = info.fieldIndex.get(f.name);
          if (inner === null || slot === undefined) return false;
          const utag = this.undefinedArmTag2(f.type);
          if (utag >= 0) {
            c.localGet(0);
            c.structGet(info.struct, slot);
            c.structGet(this.unions.base(), 0);
            c.i32Const(utag);
            c.i32Ne();
            c.ifVoid();
          }
          c.localGet(first);
          c.i32Eqz();
          c.ifVoid();
          c.i32Const(0x2c);
          c.call(json.jbPutc());
          c.end();
          c.i32Const(0);
          c.localSet(first);
          this.pushStrLitInto(c, `${jsonQuote(f.name)}:`);
          c.call(json.jbPuts());
          if (edgeable(f.type)) {
            this.pushStrLitInto(c, f.name);
            c.call(json.jbEdgeProp());
          }
          c.localGet(0);
          c.structGet(info.struct, slot);
          c.call(inner);
          if (utag >= 0) c.end();
        }
        this.pushStrLitInto(c, "}");
        c.call(json.jbPuts());
        if (cyclic) c.call(json.jbLeave());
        return true;
      }
      case "array": {
        const src = this.vecInfoFor(t, loc);
        const inner = this.jsonWriteHelper(t.elem, loc);
        if (src === null || inner === null) return false;
        const i = this.wlocal(w, I32);
        const n = this.wlocal(w, I32);
        // An array whose ELEMENTS can point back at it joins the stack
        // exactly like a cycle-capable record.
        const cyclic = this.jsonCyclic(t);
        if (cyclic) {
          c.localGet(0);
          c.i32Const(1);
          c.call(json.jbEnter());
          c.i32Eqz();
          c.ifVoid();
          c.return_();
          c.end();
        }
        this.pushStrLitInto(c, "[");
        c.call(json.jbPuts());
        c.localGet(0);
        c.structGet(src.struct, 0);
        c.localSet(n);
        c.i32Const(0);
        c.localSet(i);
        c.block();
        c.loop();
        c.localGet(i);
        c.localGet(n);
        c.i32GeU();
        c.brIf(1);
        c.localGet(i);
        c.ifVoid();
        c.i32Const(0x2c);
        c.call(json.jbPutc());
        c.end();
        if (cyclic) {
          c.localGet(i);
          c.call(json.jbEdgeIdx());
        }
        c.localGet(0);
        c.structGet(src.struct, 1);
        c.localGet(i);
        this.vecs.emitElemRead(c, src);
        c.call(inner);
        c.localGet(i);
        c.i32Const(1);
        c.i32Add();
        c.localSet(i);
        c.br(0);
        c.end();
        c.end();
        this.pushStrLitInto(c, "]");
        c.call(json.jbPuts());
        if (cyclic) c.call(json.jbLeave());
        return true;
      }
      case "union": {
        const def = this.unionDef(t.unionId);
        const tag = this.wlocal(w, I32);
        c.localGet(0);
        c.structGet(this.unions.base(), 0);
        c.localSet(tag);
        for (let i = 0; i < def.arms.length; i++) {
          const arm = def.arms[i]!;
          c.localGet(tag);
          c.i32Const(i);
          c.i32Eq();
          c.ifVoid();
          if (arm.kind === "nullT") {
            this.pushStrLitInto(c, "null");
            c.call(json.jbPuts());
          } else if (arm.kind === "undefinedT") {
            // Reachable only as a record FIELD's serializer (a bare
            // undefined-armed union is frontend-fenced), and the record
            // walker drops the field while it holds this tag before ever
            // calling — so arriving here is an emitter bug, and loud.
            c.unreachable();
          } else {
            const struct = this.unionArmStruct(t.unionId, i, loc);
            const inner = this.jsonWriteHelper(arm, loc);
            if (struct === null || inner === null) return false;
            c.localGet(0);
            c.refCast(struct);
            c.structGet(struct, 1);
            c.call(inner);
          }
          c.return_();
          c.end();
        }
        // A corrupted tag is loud, never silent (the union helpers' rule).
        c.unreachable();
        return true;
      }
      default:
        // Reachable only for a nested `dyn` (an index-signature shape's
        // overflow values), which recordInfo refuses one level up today.
        this.refuse(`jsonWrite:${t.kind}`, loc);
        return false;
    }
  }

  /** %w.dyn.match:<typeKey> — C's sc_dm_N predicate: does this dyn value
   * FIT the type, without building anything? Only the union check walker
   * needs it (arms try in canonical order and the first FULL match wins),
   * which is why a partial match must be detectable before any
   * construction happens. Never throws, never allocates. */
  private dynMatchHelper(t: IrType, loc: SrcLoc | undefined): number | null {
    const key = typeKey(t);
    const hit = this.dynMatchFns.get(key);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(
      this.mb.funcType([this.dyn.dynRef()], [I32]),
      `%w.dyn.match:${key}`,
    );
    this.dynMatchFns.set(key, idx);
    const w = this.newWalker(1);
    if (!this.emitDynMatchBody(w, t, loc)) return this.walkerDead(idx);
    this.mb.setBody(idx, w.locals, w.c.bytes());
    return idx;
  }

  /** `kind == K` on parameter 0. */
  private emitKindIs(c: Code, kind: number): void {
    c.localGet(0);
    c.structGet(this.dyn.dynT(), DYN_KIND);
    c.i32Const(kind);
    c.i32Eq();
  }

  private emitDynMatchBody(w: WalkerCtx, t: IrType, loc: SrcLoc | undefined): boolean {
    const c = w.c;
    const dyn = this.dyn;
    switch (t.kind) {
      case "f64":
        this.emitKindIs(c, DK.NUM);
        return true;
      case "string":
        this.emitKindIs(c, DK.STR);
        return true;
      case "bool":
        this.emitKindIs(c, DK.BOOL);
        return true;
      case "nullT":
        this.emitKindIs(c, DK.NULL);
        return true;
      case "undefinedT":
        // JSON text never parses to undefined, but the tree can HOLD it
        // (a missing record key builds this arm), and it matches exactly.
        this.emitKindIs(c, DK.UNDEF);
        return true;
      case "dyn":
        // An `unknown` arm: every dyn value fits, undefined included.
        c.i32Const(1);
        return true;
      case "record": {
        const shape = this.recordShapes.get(t.shapeId);
        if (shape === undefined) return false;
        if (shape.indexValue !== undefined) {
          // Width CAPTURE needs the overflow map's runtime, a separate
          // rock (recordInfo refuses the shape for the same reason).
          this.refuse("dynMatch:record:index-signature", loc);
          return false;
        }
        const fields = this.tupleOrCanonical(shape);
        if (shape.tuple) {
          // Arity is part of a tuple's type: width tolerance is an
          // object-key concept and does not apply here.
          this.emitKindIs(c, DK.ARR);
          c.ifVoid();
          const a = this.wlocal(w, dyn.arrRef());
          dyn.arrPayload(c, (x) => x.localGet(0));
          c.localSet(a);
          dyn.arrLen(c, (x) => x.localGet(a));
          c.i32Const(fields.length);
          c.i32Ne();
          c.ifVoid();
          c.i32Const(0);
          c.return_();
          c.end();
          for (let i = 0; i < fields.length; i++) {
            const inner = this.dynMatchHelper(fields[i]!.type, loc);
            if (inner === null) return false;
            dyn.arrAt(c, (x) => x.localGet(a), (x) => x.i32Const(i));
            c.call(inner);
            c.i32Eqz();
            c.ifVoid();
            c.i32Const(0);
            c.return_();
            c.end();
          }
          c.i32Const(1);
          c.return_();
          c.end();
          c.i32Const(0);
          return true;
        }
        this.emitKindIs(c, DK.OBJ);
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        {
          const o = this.wlocal(w, dyn.objRef());
          const m = this.wlocal(w, dyn.dynRef());
          dyn.objPayload(c, (x) => x.localGet(0));
          c.localSet(o);
          for (const f of fields) {
            // A dyn ('unknown') field matches ANY value, present or
            // missing — no test to emit at all.
            if (f.type.kind === "dyn") continue;
            const inner = this.dynMatchHelper(f.type, loc);
            if (inner === null) return false;
            c.localGet(o);
            this.pushStrLitInto(c, f.name);
            c.call(dyn.objGet());
            c.localTee(m);
            c.refIsNull();
            c.ifVoid();
            // Missing. An optional-flavored field (an undefined-armed
            // union) still MATCHES — the absent key is that arm.
            if (this.undefinedArmTag2(f.type) < 0) {
              c.i32Const(0);
              c.return_();
            }
            c.else_();
            c.localGet(m);
            c.call(inner);
            c.i32Eqz();
            c.ifVoid();
            c.i32Const(0);
            c.return_();
            c.end();
            c.end();
          }
        }
        c.i32Const(1);
        return true;
      }
      case "array": {
        const inner = this.dynMatchHelper(t.elem, loc);
        if (inner === null) return false;
        this.emitKindIs(c, DK.ARR);
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        const a = this.wlocal(w, dyn.arrRef());
        const i = this.wlocal(w, I32);
        const n = this.wlocal(w, I32);
        dyn.arrPayload(c, (x) => x.localGet(0));
        c.localSet(a);
        dyn.arrLen(c, (x) => x.localGet(a));
        c.localSet(n);
        c.i32Const(0);
        c.localSet(i);
        c.block();
        c.loop();
        c.localGet(i);
        c.localGet(n);
        c.i32GeU();
        c.brIf(1);
        dyn.arrAt(c, (x) => x.localGet(a), (x) => x.localGet(i));
        c.call(inner);
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(i);
        c.i32Const(1);
        c.i32Add();
        c.localSet(i);
        c.br(0);
        c.end();
        c.end();
        c.i32Const(1);
        return true;
      }
      case "union": {
        const def = this.unionDef(t.unionId);
        for (let i = 0; i < def.arms.length; i++) {
          const inner = this.dynMatchHelper(def.arms[i]!, loc);
          if (inner === null) return false;
          c.localGet(0);
          c.call(inner);
          if (i > 0) c.i32Or();
        }
        return true;
      }
      default:
        this.refuse(`dynMatch:${t.kind}`, loc);
        return false;
    }
  }

  /** A shape's fields in the order the CHECK and MATCH walkers visit
   * them: positional for a tuple, CANONICAL (the sorted list that IS the
   * shape's identity) otherwise. See `dynFieldOrder` for why the two
   * directions deliberately disagree. */
  private tupleOrCanonical(shape: IrRecordShape): typeof shape.fields {
    return shape.tuple ? this.tupleFieldOrder(shape) : shape.fields;
  }

  /** The undefined arm's tag for a union-typed field, or -1. The
   * optional-field rule everywhere in the walkers: an ABSENT key IS that
   * arm rather than a failure. */
  private undefinedArmTag2(t: IrType): number {
    return t.kind === "union" ? this.undefinedArmTag(t.unionId) : -1;
  }

  /** %w.dyn.check:<typeKey> — the validating extractor (C's sc_dc_N):
   * validate the dyn tree against T and BUILD the typed value, or throw
   * the catchable path-annotated TypeError. Records are WIDTH-TOLERANT
   * (only declared fields are looked up; extras are never examined —
   * this is check-and-extract, not shape equality). */
  private dynCheckHelper(t: IrType, loc: SrcLoc | undefined): number | null {
    const key = typeKey(t);
    const hit = this.dynCheckFns.get(key);
    if (hit !== undefined) return hit;
    const val = this.mapType(t, loc);
    if (val === null) return null;
    const idx = this.mb.declareFunc(
      this.mb.funcType([this.dyn.dynRef(), this.dyn.pathRef()], [val]),
      `%w.dyn.check:${key}`,
    );
    this.dynCheckFns.set(key, idx);
    const w = this.newWalker(2);
    if (!this.emitDynCheckBody(w, t, loc, val)) return this.walkerDead(idx);
    this.mb.setBody(idx, w.locals, w.c.bytes());
    return idx;
  }

  /** `check_fail(path, "<want>", got)` then the dummy return — the walker
   * form of the failure the scalar dynCheck emits inline. */
  private emitWalkerFail(
    w: WalkerCtx,
    want: string,
    result: ValType | null,
    pushPath: (c: Code) => void,
    pushGot: (c: Code) => void,
  ): void {
    const c = w.c;
    pushPath(c);
    this.pushStrLitInto(c, want);
    pushGot(c);
    c.call(this.dyn.checkFail());
    this.pushZeroInto(c, result);
    c.return_();
  }

  private emitDynCheckBody(w: WalkerCtx, t: IrType, loc: SrcLoc | undefined, val: ValType): boolean {
    const c = w.c;
    const dyn = this.dyn;
    const want = this.dynDescOf(t);
    const kindGuard = (k: number): void => {
      this.emitKindIs(c, k);
      c.i32Eqz();
      c.ifVoid();
      this.emitWalkerFail(w, want, val, (x) => x.localGet(1), (x) => x.localGet(0));
      c.end();
    };
    switch (t.kind) {
      case "f64":
        kindGuard(DK.NUM);
        c.localGet(0);
        c.structGet(dyn.dynT(), DYN_NUM);
        return true;
      case "bool":
        kindGuard(DK.BOOL);
        c.localGet(0);
        c.structGet(dyn.dynT(), DYN_NUM);
        c.f64Const(0);
        c.f64Ne();
        return true;
      case "string":
        kindGuard(DK.STR);
        c.localGet(0);
        c.structGet(dyn.dynT(), DYN_REF);
        c.refCast(this.strType);
        return true;
      case "dyn":
        // An `unknown` slot: the subtree passes through as-is — nothing
        // to validate, nothing to build.
        c.localGet(0);
        return true;
      case "record": {
        const shape = this.recordShapes.get(t.shapeId);
        const info = this.recordInfo(t.shapeId, loc, false);
        if (shape === undefined || info === null) return false;
        if (shape.tuple) {
          const fields = this.tupleFieldOrder(shape);
          kindGuard(DK.ARR);
          const a = this.wlocal(w, dyn.arrRef());
          dyn.arrPayload(c, (x) => x.localGet(0));
          c.localSet(a);
          dyn.arrLen(c, (x) => x.localGet(a));
          c.i32Const(fields.length);
          c.i32Ne();
          c.ifVoid();
          // Arity failures carry their OWN message — the element type is
          // not what went wrong.
          this.emitWalkerFail(
            w,
            `array of length ${fields.length}`,
            val,
            (x) => x.localGet(1),
            (x) => x.localGet(0),
          );
          c.end();
          const r = this.wlocal(w, val);
          c.structNewDefault(info.struct);
          c.localSet(r);
          for (let i = 0; i < fields.length; i++) {
            const f = fields[i]!;
            const inner = this.dynCheckHelper(f.type, loc);
            const slot = info.fieldIndex.get(f.name);
            if (inner === null || slot === undefined) return false;
            c.localGet(r);
            dyn.arrAt(c, (x) => x.localGet(a), (x) => x.i32Const(i));
            dyn.pushPathIndex(c, (x) => x.localGet(1), (x) => x.i32Const(i));
            c.call(inner);
            c.structSet(info.struct, slot);
            this.emitWalkerPending(c, val);
          }
          c.localGet(r);
          return true;
        }
        kindGuard(DK.OBJ);
        {
          const o = this.wlocal(w, dyn.objRef());
          const m = this.wlocal(w, dyn.dynRef());
          const r = this.wlocal(w, val);
          dyn.objPayload(c, (x) => x.localGet(0));
          c.localSet(o);
          c.structNewDefault(info.struct);
          c.localSet(r);
          // CANONICAL order, matching the C and LLVM walkers: this is the
          // order that decides WHICH bad field a record with several
          // reports first, so it has to be the shape's identity rather
          // than its source spelling (see dynFieldOrder).
          for (const f of this.tupleOrCanonical(shape)) {
            const slot = info.fieldIndex.get(f.name);
            if (slot === undefined) return false;
            const utag = this.undefinedArmTag2(f.type);
            c.localGet(o);
            this.pushStrLitInto(c, f.name);
            c.call(dyn.objGet());
            c.localSet(m);
            if (f.type.kind === "dyn") {
              // An `unknown` field: a present key passes through, a
              // missing one IS the undefined value (JS's missing-property
              // read), never a failure.
              c.localGet(r);
              c.localGet(m);
              c.refIsNull();
              c.ifResult(dyn.dynRef());
              c.globalGet(dyn.undefinedGlobal());
              c.else_();
              c.localGet(m);
              c.end();
              c.structSet(info.struct, slot);
              continue;
            }
            const inner = this.dynCheckHelper(f.type, loc);
            if (inner === null) return false;
            c.localGet(m);
            c.refIsNull();
            c.ifVoid();
            if (utag >= 0) {
              // Optional-flavored field: the ABSENT key builds the
              // undefined arm's interned immortal instance.
              c.localGet(r);
              c.globalGet(this.unions.unitGlobal(utag));
              c.structSet(info.struct, slot);
            } else {
              // Missing and required: the failure names the FIELD's path
              // and a null `got`, which kindName renders "undefined" —
              // so an absent key reports exactly like a present one
              // holding undefined.
              this.emitWalkerFail(
                w,
                this.dynDescOf(f.type),
                val,
                (x) => dyn.pushPathKey(x, (y) => y.localGet(1), (y) => this.pushStrLitInto(y, f.name)),
                (x) => x.refNull(dyn.dynT()),
              );
            }
            c.else_();
            c.localGet(r);
            c.localGet(m);
            dyn.pushPathKey(c, (x) => x.localGet(1), (x) => this.pushStrLitInto(x, f.name));
            c.call(inner);
            c.structSet(info.struct, slot);
            this.emitWalkerPending(c, val);
            c.end();
          }
          c.localGet(r);
        }
        return true;
      }
      case "array": {
        const inner = this.dynCheckHelper(t.elem, loc);
        const out = this.vecInfoFor(t, loc);
        if (inner === null || out === null) return false;
        kindGuard(DK.ARR);
        const a = this.wlocal(w, dyn.arrRef());
        const r = this.wlocal(w, val);
        const i = this.wlocal(w, I32);
        const n = this.wlocal(w, I32);
        dyn.arrPayload(c, (x) => x.localGet(0));
        c.localSet(a);
        dyn.arrLen(c, (x) => x.localGet(a));
        c.localSet(n);
        c.f64Const(0);
        c.call(this.vecs.newLen(out));
        c.localSet(r);
        c.i32Const(0);
        c.localSet(i);
        c.block();
        c.loop();
        c.localGet(i);
        c.localGet(n);
        c.i32GeU();
        c.brIf(1);
        c.localGet(r);
        dyn.arrAt(c, (x) => x.localGet(a), (x) => x.localGet(i));
        dyn.pushPathIndex(c, (x) => x.localGet(1), (x) => x.localGet(i));
        c.call(inner);
        c.call(this.vecs.pushOne(out));
        this.emitWalkerPending(c, val);
        c.localGet(i);
        c.i32Const(1);
        c.i32Add();
        c.localSet(i);
        c.br(0);
        c.end();
        c.end();
        c.localGet(r);
        return true;
      }
      case "union": {
        const def = this.unionDef(t.unionId);
        // Arms in CANONICAL order, first FULL match wins — which is how
        // discriminated unions disambiguate: the arm whose declared
        // fields all fit. Matching is what makes that decidable BEFORE
        // any construction, so the chosen arm's builder cannot fail.
        //
        // THAT is why no pending check follows the inner check call
        // below, unlike every other nested call in these walkers: the
        // matcher and the checker agree arm by arm (`match(d)` true ⇒
        // `check(d)` reaches its return without touching the cell), so
        // the only way a check could throw here is a matcher that
        // accepted something its checker rejects — an emitter bug, not a
        // runtime condition. Add one if the two ever stop being generated
        // from the same type.
        for (let i = 0; i < def.arms.length; i++) {
          const arm = def.arms[i]!;
          const match = this.dynMatchHelper(arm, loc);
          if (match === null) return false;
          c.localGet(0);
          c.call(match);
          c.ifVoid();
          if (arm.kind === "undefinedT" || arm.kind === "nullT") {
            // A matched unit arm builds nothing: the answer is THE
            // interned immortal instance for the tag.
            c.globalGet(this.unions.unitGlobal(i));
          } else {
            const struct = this.unionArmStruct(t.unionId, i, loc);
            const inner = this.dynCheckHelper(arm, loc);
            if (struct === null || inner === null) return false;
            c.i32Const(i);
            c.localGet(0);
            c.localGet(1);
            c.call(inner);
            c.structNew(struct);
          }
          c.return_();
          c.end();
        }
        this.emitWalkerFail(w, want, val, (x) => x.localGet(1), (x) => x.localGet(0));
        c.unreachable();
        return true;
      }
      case "func": {
        // The function boundary, OUT direction. A non-function kind fails
        // like any dynCheck; an IDENTICAL boxed signature hands back the
        // VERY SAME closure, which is what preserves identity across the
        // round trip (`u as typeof add` is `add`, so `=== add` is true);
        // anything else wraps in the per-target adapter, whose env owns
        // the box. C's arm one for one, with the i32 SIG compare standing
        // in for its `strcmp`.
        const pair = this.closSigFor(t, loc);
        const adapter = this.dynFnAdapter(t, loc);
        if (pair === null || adapter === null) return false;
        kindGuard(DK.FUNC);
        dyn.fnPayload(c, (x) => x.localGet(0));
        c.structGet(dyn.fnT(), FN_SIG);
        c.i32Const(this.dynFnSigId(typeKey(t)));
        c.i32Eq();
        c.ifVoid();
        dyn.fnPayload(c, (x) => x.localGet(0));
        c.structGet(dyn.fnT(), FN_CLOS);
        c.refCast(pair.clos);
        c.return_();
        c.end();
        c.refFunc(adapter.fn);
        c.localGet(0);
        c.structNew(adapter.env);
        return true;
      }
      default:
        this.refuse(`dynCheck:${t.kind}`, loc);
        return false;
    }
  }

  /* ── the checked-dynamic FUNCTION boundary ─────────────────────────────
   * Three interned per-SIGNATURE helpers, the C emitter's sc_dfk_ /
   * sc_dfb_ / sc_dfa_ families one for one:
   *
   *   %w.dyn.fnThunk:<key> — the CALL GLUE a boxed closure carries.
   *   Uniform shape for every signature (dyn.ts's `thunkSig`), so the box
   *   can hold it without naming the closure's own type: validate each
   *   dyn argument into the declared parameter type, call through the
   *   closure, convert the result back to dyn.
   *
   *   %w.dyn.fnBox:<key> — what `dynFrom` on a func-typed value calls:
   *   the closure, the thunk's funcref, the interned SIG id, the
   *   best-effort name and the declared arity, in one `struct.new`.
   *
   *   %w.dyn.fnAdapter:<key> — the shim a func-targeted `dynCheck` wraps
   *   a NON-identical boxed signature in: a closure of the TARGET type
   *   whose env captures the dyn box, converts its typed arguments into
   *   dyn, calls through the box, and validates the result back.
   *
   * THE SIG IS AN INTERNED i32, not a string: C `strcmp`s a literal and
   * LLVM interns, and an i32 compare asks the same question once at
   * compile time. Same id ⇔ same typeKey ⇔ same IR type ⇔ same ABI, which
   * is what makes both the exact-unwrap fast path and the thunk's
   * closure downcast sound.
   *
   * FN_CLOS IS SOURCED FROM THE VALUE, NEVER FROM THE ABI. Every module
   * function takes a closure as arg0 and DIRECT calls pass `ref.null`
   * (the uniform-ABI dead argument) — but that null must never reach a
   * box: FN_CLOS is `eq`, `ref.eq(null, null)` is TRUE, and two distinct
   * functions boxed over it would answer `f === g` true with nothing to
   * see. Every producer here takes the closure from the IR value's own
   * emission — the interned per-function global for a capture-free
   * function, the env `struct.new` for a capturing one — which is what
   * `closure` already pushes. C is immune for free (a ScrClosure is
   * always a real pointer); this lane is immune by discipline. */

  private readonly dynFnSigIds = new Map<string, number>();
  private readonly dynFnThunks = new Map<string, number>();
  private readonly dynFnBoxes = new Map<string, number>();
  private readonly dynFnAdapters = new Map<string, { fn: number; env: number }>();

  /** The signature's interned id — dense, assigned on first sight. */
  private dynFnSigId(key: string): number {
    const hit = this.dynFnSigIds.get(key);
    if (hit !== undefined) return hit;
    const id = this.dynFnSigIds.size;
    this.dynFnSigIds.set(key, id);
    return id;
  }

  /** The per-signature call thunk (C's sc_dfk_N). */
  private dynFnThunk(t: IrType & { kind: "func" }, loc: SrcLoc | undefined): number | null {
    const key = typeKey(t);
    const hit = this.dynFnThunks.get(key);
    if (hit !== undefined) return hit;
    const pair = this.closSigFor(t, loc);
    if (pair === null) return null;
    const idx = this.mb.declareFunc(this.dyn.thunkSig(), `%w.dyn.fnThunk:${key}`);
    this.dynFnThunks.set(key, idx);
    const w = this.newWalker(2);
    if (!this.emitDynFnThunkBody(w, t, pair, loc)) return this.walkerDead(idx);
    this.mb.setBody(idx, w.locals, w.c.bytes());
    return idx;
  }

  private emitDynFnThunkBody(
    w: WalkerCtx,
    t: IrType & { kind: "func" },
    pair: { clos: number; fn: number },
    loc: SrcLoc | undefined,
  ): boolean {
    const c = w.c;
    const dyn = this.dyn;
    const dynRef = dyn.dynRef();
    const n = this.wlocal(w, I32);
    const ad = this.wlocal(w, dynRef);
    const cl = this.wlocal(w, { kind: "ref", nullable: true, typeIndex: pair.clos });
    // JS ARITY lives in this loop: an argument the caller did not supply
    // IS the undefined immortal, and the parameter's own check decides
    // whether that flies (a dyn parameter takes it; a number parameter
    // throws the path-annotated TypeError). Arguments PAST the declared
    // list were evaluated by the caller and are simply never read —
    // `argc` is the vector's length, exactly C's (args, argc) pair.
    dyn.arrLen(c, (x) => x.localGet(1));
    c.localSet(n);
    const slots: number[] = [];
    for (let i = 0; i < t.params.length; i++) {
      const p = t.params[i]!;
      const val = this.mapType(p, loc);
      if (val === null) return false;
      const slot = this.wlocal(w, val);
      slots.push(slot);
      c.i32Const(i);
      c.localGet(n);
      c.i32LtU();
      c.ifResult(dynRef);
      dyn.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(i));
      c.else_();
      c.globalGet(dyn.undefinedGlobal());
      c.end();
      c.localSet(ad);
      if (p.kind === "dyn") {
        // An `unknown` parameter takes the argument as it stands.
        c.localGet(ad);
        c.localSet(slot);
        continue;
      }
      const check = this.dynCheckHelper(p, loc);
      if (check === null) return false;
      c.localGet(ad);
      // C's `ScrDynPath pp = { NULL, NULL, i }` — a root ARRAY step, so
      // a failing argument reports at `$[i]`.
      dyn.pushPathIndex(c, (x) => x.refNull(dyn.pathT()), (x) => x.i32Const(i));
      c.call(check);
      c.localSet(slot);
      this.emitWalkerPending(c, dynRef);
    }
    // The closure the box carries, cast back to this signature's own
    // struct. Sound because a thunk is only ever reached through the box
    // its own builder filled — see the section header on SIG.
    c.localGet(0);
    c.refCast(pair.clos);
    c.localSet(cl);
    c.localGet(cl); // arg0: the closure itself (selfRef, env)
    for (const slot of slots) c.localGet(slot);
    c.localGet(cl);
    c.structGet(pair.clos, 0);
    c.callRef(pair.fn);
    if (t.ret.kind === "void") {
      this.emitWalkerPending(c, dynRef);
      c.globalGet(dyn.undefinedGlobal());
      return true;
    }
    const retVal = this.mapType(t.ret, loc);
    if (retVal === null) return false;
    const r = this.wlocal(w, retVal);
    c.localSet(r);
    this.emitWalkerPending(c, dynRef);
    if (t.ret.kind === "dyn") {
      c.localGet(r);
      return true;
    }
    const from = this.dynFromHelper(t.ret, loc);
    if (from === null) return false;
    c.localGet(r);
    c.call(from);
    return true;
  }

  /** The per-signature box builder (C's sc_dfb_N): `(closure, name) →
   * the FUNC box`. The NAME parameter is null for an anonymous value —
   * never the empty string, which keyGet substitutes at read time. */
  private dynFnBox(t: IrType & { kind: "func" }, loc: SrcLoc | undefined): number | null {
    const key = typeKey(t);
    const hit = this.dynFnBoxes.get(key);
    if (hit !== undefined) return hit;
    const pair = this.closSigFor(t, loc);
    if (pair === null) return null;
    const closRef: ValType = { kind: "ref", nullable: true, typeIndex: pair.clos };
    const idx = this.mb.declareFunc(
      this.mb.funcType([closRef, this.strRef], [this.dyn.dynRef()]),
      `%w.dyn.fnBox:${key}`,
    );
    this.dynFnBoxes.set(key, idx);
    const thunk = this.dynFnThunk(t, loc);
    if (thunk === null) return this.walkerDead(idx);
    this.mb.declareFuncRef(thunk);
    const c = new Code();
    this.dyn.boxFn(
      c,
      (x) => x.localGet(0),
      (x) => x.refFunc(thunk),
      this.dynFnSigId(key),
      (x) => x.localGet(1),
      // ARITY is the DECLARED parameter count. SEMANTICS.md S020: that
      // is an APPROXIMATION of `f.length`, which JS stops counting at the
      // first parameter with a DEFAULT — `(a, b = 1)` answers 1 in Node
      // and 2 here. A rest parameter is excluded from both, and
      // TypeScript's `?` erases, so those two agree. Only the reported
      // number is affected: the thunk's checks still admit a missing
      // defaulted argument (its type carries an undefined arm), so the
      // body applies its own default exactly like Node.
      t.params.length,
    );
    this.mb.setBody(idx, [], c.bytes());
    return idx;
  }

  /** The per-TARGET adapter (C's sc_dfa_N) plus the env struct that owns
   * the captured box: a closure of the target signature whose body calls
   * through a box of some OTHER signature. */
  private dynFnAdapter(
    t: IrType & { kind: "func" },
    loc: SrcLoc | undefined,
  ): { fn: number; env: number } | null {
    const key = typeKey(t);
    const hit = this.dynFnAdapters.get(key);
    if (hit !== undefined) return hit;
    const pair = this.closSigFor(t, loc);
    if (pair === null) return null;
    // The env is a width subtype of the target's closure struct — the
    // same shape `envTypeFor` builds for a capturing function, with the
    // dyn box standing in for the capture boxes. C's caps[0] obj-box.
    const env = this.mb.subStructType(
      `dynfnenv:${key}`,
      [
        { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
        { storage: this.dyn.dynRef(), mutable: false },
      ],
      pair.clos,
    );
    const idx = this.mb.declareFunc(pair.fn, `%w.dyn.fnAdapter:${key}`);
    const made = { fn: idx, env };
    this.dynFnAdapters.set(key, made);
    const w = this.newWalker(1 + t.params.length);
    if (!this.emitDynFnAdapterBody(w, t, env, loc)) {
      this.walkerDead(idx);
      return null;
    }
    this.mb.setBody(idx, w.locals, w.c.bytes());
    this.mb.declareFuncRef(idx);
    return made;
  }

  private emitDynFnAdapterBody(
    w: WalkerCtx,
    t: IrType & { kind: "func" },
    env: number,
    loc: SrcLoc | undefined,
  ): boolean {
    const c = w.c;
    const dyn = this.dyn;
    const retVal = t.ret.kind === "void" ? null : this.mapType(t.ret, loc);
    if (t.ret.kind !== "void" && retVal === null) return false;
    const d = this.wlocal(w, dyn.dynRef());
    const a = this.wlocal(w, dyn.arrRef());
    const r = this.wlocal(w, dyn.dynRef());
    c.localGet(0);
    c.refCast(env);
    c.structGet(env, 1);
    c.localSet(d);
    c.f64Const(0);
    c.call(this.vecs.newLen(this.dynVecInfo()));
    c.localSet(a);
    for (let i = 0; i < t.params.length; i++) {
      const from = this.dynFromHelper(t.params[i]!, loc);
      if (from === null) return false;
      c.localGet(a);
      c.localGet(1 + i);
      c.call(from);
      c.call(dyn.arrPush());
    }
    // The box's kind is FUNC by construction (the dynCheck that minted
    // this adapter tested it), so the not-a-function arm below is
    // unreachable — C spells its `what` "value" for the same reason.
    c.localGet(d);
    c.localGet(a);
    this.pushStrLitInto(c, "value");
    c.call(dyn.callFn());
    c.localSet(r);
    this.emitWalkerPending(c, retVal);
    if (t.ret.kind === "void") return true;
    if (t.ret.kind === "dyn") {
      c.localGet(r);
      return true;
    }
    // A lying wrapper is caught HERE: the dyn result validates into the
    // target's return type at the ROOT path, exactly the dynCheck stance.
    const check = this.dynCheckHelper(t.ret, loc);
    if (check === null) return false;
    c.localGet(r);
    c.refNull(dyn.pathT());
    c.call(check);
    const out = this.wlocal(w, retVal!);
    c.localSet(out);
    this.emitWalkerPending(c, retVal);
    c.localGet(out);
    return true;
  }

  private unionDef(unionId: string): IrUnionDef {
    const def = this.unionsById.get(unionId);
    if (def === undefined) throw new Error(`unknown union ${unionId}`);
    return def;
  }

  /** The payload subtype for one (union, arm) — null (refusal recorded)
   * when the ARM's representation is out of tier. */
  private unionArmStruct(unionId: string, tag: number, loc: SrcLoc | undefined): number | null {
    const def = this.unionDef(unionId);
    const arm = def.arms[tag];
    if (arm === undefined) throw new Error(`union ${unionId} has no arm ${tag}`);
    const val = this.mapType(arm, loc);
    if (val === null) return null;
    return this.unions.armStruct(unionId, tag, val);
  }

  /** Resolves every arm for one dispatch helper, gating exactly the arms
   * whose PAYLOAD that helper reads: truthiness reads scalar/string
   * payloads only (object arms are just true — a class-armed union still
   * truth-tests in-tier), equality reads every non-unit payload (ref-arm
   * identity), ToString is frontend-fenced to unit/string/f64/bool arms
   * (bytes, which the C runtime formats, refuses with its own tag). */
  private unionArmReps(unionId: string, need: "truthy" | "eq" | "toStr", loc: SrcLoc | undefined): UnionArmRep[] | null {
    const def = this.unionDef(unionId);
    const reps: UnionArmRep[] = [];
    for (let i = 0; i < def.arms.length; i++) {
      const arm = def.arms[i]!;
      if (arm.kind === "undefinedT" || arm.kind === "nullT") {
        reps.push({ kind: arm.kind === "undefinedT" ? "undefined" : "null", struct: null });
        continue;
      }
      if (arm.kind === "f64" || arm.kind === "bool" || arm.kind === "string") {
        // Scalar/string arms always map; the struct is never null here.
        reps.push({ kind: arm.kind, struct: this.unionArmStruct(unionId, i, loc) });
        continue;
      }
      if (need === "toStr") {
        // The frontend fences union ToString to unit/string/f64/bool
        // arms plus bytes (scr_bytes_to_str's surface — not in tier).
        if (arm.kind === "bytes") {
          this.refuse("toString:union-arm:bytes", loc);
          return null;
        }
        // Class arms MAP now, so a breach here would build a helper with
        // no rendering for the arm instead of failing the fence. Object
        // rendering is the inspect surface's work; refuse by name.
        if (arm.kind === "object") {
          this.refuse("union:toStr:object", loc);
          return null;
        }
        throw new Error(`ToString over a union ${arm.kind} arm (frontend fence breached)`);
      }
      if (need === "truthy") {
        // Every object arm is truthy without a payload read — except
        // jsval, whose truthiness asks the engine.
        if (arm.kind === "jsval") {
          this.refuse("type:jsval", loc);
          return null;
        }
        reps.push({ kind: "ref", struct: null });
        continue;
      }
      // eq: ref-arm pointer identity needs the payload representation.
      const struct = this.unionArmStruct(unionId, i, loc);
      if (struct === null) return null;
      reps.push({ kind: "ref", struct });
    }
    return reps;
  }

  private unionTruthyHelper(unionId: string, loc: SrcLoc | undefined): number | null {
    const reps = this.unionArmReps(unionId, "truthy", loc);
    return reps === null ? null : this.unions.truthy(unionId, reps);
  }

  private unionEqHelper(unionId: string, sameValue: boolean, loc: SrcLoc | undefined): number | null {
    const reps = this.unionArmReps(unionId, "eq", loc);
    return reps === null ? null : this.unions.eq(unionId, reps, sameValue);
  }

  private unionToStrHelper(unionId: string, loc: SrcLoc | undefined): number | null {
    const reps = this.unionArmReps(unionId, "toStr", loc);
    return reps === null ? null : this.unions.toStr(unionId, reps);
  }

  /** The tag of `t` among a union's canonical arms (typeEquals — ids for
   * records/unions, structure for the rest), or -1. */
  private unionArmTag(unionId: string, t: IrType): number {
    return this.unionDef(unionId).arms.findIndex((a) => typeEquals(a, t));
  }

  /** The undefined arm's tag — the optional-chain short-circuit value and
   * the pop/shift empty answer both need it. */
  private undefinedArmTag(unionId: string): number {
    return this.unionDef(unionId).arms.findIndex((a) => a.kind === "undefinedT");
  }

  /* ── classes ────────────────────────────────────────────────────────────
   * One wasm struct per emitted class, subtyped along the source
   * hierarchy, with preorder intervals carried as data (classes.ts is the
   * design doc). Built lazily like every other family here — a module
   * that never touches a user class pays nothing, and the builder's
   * constructor runs the shared class-graph numbering. */

  private classesField: ClassBuilder | null = null;

  private get classes(): ClassBuilder {
    // The graph is numbered over the WHOLE module, never the reachable
    // subset: intervals must agree with the native lanes', and this
    // builder is first touched during pass 1 (a class-typed parameter),
    // when the reachable declaration table is still filling.
    this.classesField ??= new ClassBuilder(
      this.mb,
      asIrModule(this.mod),
      new Map(this.mod.functions.map((f) => [f.name, f])) as unknown as Map<string, IrFunction>,
      {
        softType: (t) => this.mapTypeSoft(t),
        refuse: (kind, loc) => this.refuse(kind, loc),
        slotFnType: (slot) => this.vtSlotPair(slot).fn,
        slotEntry: (slot, impl) => this.vtSlotEntry(slot, impl),
        errStruct: () => {
          const exc = this.exc();
          return { struct: exc.errT, fields: exc.errFields };
        },
      },
    );
    return this.classesField;
  }

  /* ── classes as VALUES ──────────────────────────────────────────────────
   * One immortal class object per class, holding the interval, a
   * construct thunk and the JS-visible name. Its struct subtypes $ci
   * (classes.ts) so instanceOfValue reads the target's interval through
   * the same head an instance's vt exposes.
   *
   * The global is filled LAZILY on first evaluation rather than by a
   * constant initializer, for one hard reason: the name is a string, and
   * `array.new_data` is not a constant expression in WasmGC (verified
   * against V8, not assumed). The zero-capture closure interning right
   * above does the same dance for the same shape of reason, and it buys
   * the identity JS requires — `C === C` — because the fill happens once. */

  private readonly classObjGlobals = new Map<string, number>();
  private readonly ctorThunks = new Map<string, number>();

  /** A classval's wasm shape: the (closure, thunk) pair its construct
   * call goes through, the classobj struct, and the ABI key both are
   * interned under. Null (refusal recorded) when the class has no
   * representation. */
  private classValInfo(
    className: string,
    loc: SrcLoc | undefined,
    soft: boolean,
  ): { info: ClassInfo; objT: number; thunk: { clos: number; fn: number } } | null {
    const info = this.classes.info(className, loc, soft);
    if (info === null) return null;
    const ctorName = `%${className}.constructor`;
    const ctorFn = this.funcByName.get(ctorName) ?? this.mod.functions.find((f) => f.name === ctorName);
    if (ctorFn === undefined) {
      if (!soft) this.refuse("classval:no-ctor", loc);
      return null;
    }
    // The thunk's RESULT is the hierarchy root's struct, not the class's:
    // the classobj type is shared by every class a classval can hold, so
    // its thunk field has one type, and the root is the type they all
    // agree on. newValue casts back down to its own static class.
    const rootInfo = this.classes.info(info.meta.root.def.name, loc, soft);
    if (rootInfo === null) return null;
    const params = ctorFn.params.slice(1).map((p) => this.mapTypeSoft(p.type));
    const thunk = this.closPairFor(params, [this.classes.ref(rootInfo)]);
    const abiKey = params.map(valKey).join(",");
    const objT = this.classes.classObjType(info.meta, abiKey, thunk.fn, this.strRef);
    return { info, objT, thunk };
  }

  /** `%w.ctor.<C>` — allocate, run the constructor, hand the instance
   * back. The construct half of `new` behind the thunk ABI, so a class
   * VALUE builds exactly what `new C(...)` builds. No pending check: the
   * newValue site owns that, and an unwinding constructor simply leaves
   * the instance for the caller's check to discard. */
  private ctorThunk(className: string, info: ClassInfo, thunk: { clos: number; fn: number }): number {
    const cached = this.ctorThunks.get(className);
    if (cached !== undefined) return cached;
    const ctor = this.ctorOf(className);
    const idx = this.mb.declareFunc(thunk.fn, `%w.ctor.${className}`);
    this.ctorThunks.set(className, idx);
    const c = new Code();
    const argc = ctor.fn.params.length - 1; // params after `this`
    const self = 1 + argc; // one local past the declared parameters
    this.emitAlloc(c, className, info);
    c.localSet(self);
    c.refNull(this.fnClosPair(ctor.fn).clos);
    c.localGet(self);
    for (let i = 1; i <= argc; i++) c.localGet(i);
    c.call(ctor.index);
    c.localGet(self);
    this.mb.setBody(idx, [this.classes.ref(info)], c.bytes());
    this.mb.declareFuncRef(idx);
    return idx;
  }

  /** Can constructing through a class value throw? The dynamic class is
   * any descendant of the static one, so the answer covers the whole
   * subtree — may-throw.ts's newValue arm takes the same wide cover. */
  private newValueMayThrow(className: string): boolean {
    // The STATIC class's meta, not meta.root: a classval holds that class
    // or a descendant, so its own subtree is exactly the cover needed.
    const staticMeta = this.classes.meta(className);
    if (staticMeta === undefined) return true;
    const walk = (m: typeof staticMeta): boolean =>
      this.mayThrow.has(`%${m.def.name}.constructor`) || m.children.some(walk);
    return walk(staticMeta);
  }

  /** Consumes an interval position, leaves 1 when it falls inside the
   * BUILTIN error hierarchy — scr_error_is as a range check. The bounds
   * are %Error's, which spans every builtin and every user subclass, so
   * this is exactly "does this payload have a name and a message". */
  /** Is this class an ERROR — a builtin or anything rooted in one? The
   * preorder interval answers it, the same question `emitErrIntervalTest`
   * asks at runtime; a user `extends Error` class subtypes `errT`, so its
   * name/message/%code live in errT's own slots and the `%error`
   * conversion reads them the same way a builtin's are read. */
  private isErrorRooted(className: string): boolean {
    const meta = this.classes.meta(className);
    const root = this.classes.meta("%Error");
    if (meta === undefined || root === undefined) return false;
    return meta.pre >= root.pre && meta.pre <= root.post;
  }

  private emitErrIntervalTest(c: Code): void {
    const meta = this.classes.meta("%Error");
    if (meta === undefined) throw new Error("wasm emitter bug: no %Error in the class graph");
    // Written as ONE unsigned compare rather than the usual two signed
    // ones because this runs inside a runtime helper built outside any IR
    // function, where there is no scratch frame to borrow a local from.
    // Subtracting the lower bound wraps anything below it — the -1 of a
    // non-object payload included — past the span, so `<= span` unsigned
    // is exactly `pre >= lo && pre <= hi`.
    c.i32Const(meta.pre);
    c.i32Sub();
    c.i32Const(meta.post - meta.pre);
    c.i32LeU();
  }

  /** The class object global, filled on first evaluation. */
  private emitClassObj(className: string, loc: SrcLoc | undefined): boolean {
    const cv = this.classValInfo(className, loc, false);
    if (cv === null) return false;
    const code = this.fn.code;
    const objRef: ValType = { kind: "ref", nullable: true, typeIndex: cv.objT };
    let g = this.classObjGlobals.get(className);
    if (g === undefined) {
      g = this.mb.addGlobal(objRef, true, (w) => {
        w.u8(0xd0);
        w.sleb(cv.objT);
      });
      this.classObjGlobals.set(className, g);
    }
    const thunkIdx = this.ctorThunk(className, cv.info, cv.thunk);
    const interval = this.classes.classObjInterval(cv.info.meta);
    const jsName = cv.info.meta.def.jsName ?? "";
    code.globalGet(g);
    code.refIsNull();
    this.openIf();
    code.i32Const(interval.pre);
    code.i32Const(interval.post);
    code.refFunc(thunkIdx);
    this.pushStrLit(jsName);
    code.structNew(cv.objT);
    code.globalSet(g);
    this.close();
    code.globalGet(g);
    return true;
  }

  /* ── virtual dispatch ───────────────────────────────────────────────────
   * A slot's ABI is the DECLARER's: the root-most class that declares the
   * method fixes `this`, and every override is otherwise ABI-identical
   * (the frontend's override-exactness rule). Wasm function subtyping
   * cannot paper over the difference — a `(ref null $Dog)` parameter is
   * NOT usable where `(ref null $Animal)` is expected (parameters are
   * contravariant, and the subtyping runs the other way) — so an override
   * that narrowed `this` needs an ADAPTER, exactly the C backend's sc_vm_*
   * thunks. The LLVM lane needs none because every pointer is `ptr`. */

  private readonly vtAdapters = new Map<string, number>();

  /** A slot's (closure, func) type pair. The `this` parameter is the
   * DECLARER's — not `slot.fn`'s, which for an ABSTRACT declarer is some
   * concrete descendant's function and would spell a narrower receiver. */
  private vtSlotPair(slot: LlVtSlot): { clos: number; fn: number } {
    const recv: IrType = { kind: "object", className: slot.declarer.def.name };
    const params = [
      this.mapTypeSoft(recv),
      ...slot.fn.params.slice(1).map((p) => this.mapTypeSoft(p.type)),
    ];
    const results = slot.fn.returnType.kind === "void" ? [] : [this.mapTypeSoft(slot.fn.returnType)];
    return this.closPairFor(params, results);
  }

  /** What `impl` stores in `slot`: the method function itself when its
   * own func type already IS the slot's (impl declares the slot), an
   * adapter otherwise. Null when the method has no reachable function —
   * see ClassBuilder.vtGlobal for why that slot is unreachable too. */
  private vtSlotEntry(slot: LlVtSlot, impl: LlClassMeta): number | null {
    const name = `%${impl.def.name}.${slot.method}`;
    const fn = this.funcByName.get(name);
    const index = this.funcIndexByName.get(name);
    if (fn === undefined || index === undefined) return null;
    const slotPair = this.vtSlotPair(slot);
    if (this.fnClosPair(fn).fn === slotPair.fn) {
      this.mb.declareFuncRef(index);
      return index;
    }
    const key = `${name}@${slot.declarer.def.name}`;
    const cached = this.vtAdapters.get(key);
    if (cached !== undefined) return cached;
    const implInfo = this.classInfo(impl.def.name, fn.loc);
    if (implInfo === null) return null;
    // The adapter wears the SLOT's type, narrows `this`, and calls the
    // implementation directly. The incoming closure is dead either way —
    // a method is never a closure value, so a direct call's null closure
    // is what the callee expects (the `call` arm passes the same).
    const adapter = this.mb.declareFunc(slotPair.fn, `%w.vadapt.${impl.def.name}.${slot.method}`);
    this.vtAdapters.set(key, adapter);
    const c = new Code();
    c.refNull(this.fnClosPair(fn).clos);
    c.localGet(1);
    c.refCast(implInfo.struct);
    for (let i = 2; i <= fn.params.length; i++) c.localGet(i);
    c.call(index);
    this.mb.setBody(adapter, [], c.bytes());
    this.mb.declareFuncRef(adapter);
    return adapter;
  }

  /** A class's emitted shape, or null with the refusal recorded. The
   * builtin error classes never arrive: mapType answers errT for them
   * before anything here runs (classes.ts's header). */
  private classInfo(className: string, loc: SrcLoc | undefined): ClassInfo | null {
    return this.classes.info(className, loc, false);
  }

  /** One field's struct slot, with the field's DECLARED type gated. That
   * gate is load-bearing: a field the tier cannot represent still OCCUPIES
   * a slot (the soft map's placeholder — classes.ts's header), and this
   * is the only thing between that placeholder and an emitted access. */
  private classField(
    className: string,
    field: string,
    loc: SrcLoc | undefined,
  ): { info: ClassInfo; index: number; type: IrType } | null {
    const info = this.classInfo(className, loc);
    if (info === null) return null;
    const index = info.fieldIndex.get(field);
    const type = info.fieldType.get(field);
    if (index === undefined || type === undefined) {
      throw new Error(`wasm emitter bug: unknown field ${field} on class ${className}`);
    }
    if (this.mapType(type, loc) === null) return null;
    return { info, index, type };
  }

  /** One field's value inside `struct.new`: the zero of its
   * representation, EXCEPT a field whose union admits undefined, which
   * starts at the interned undefined arm. `undefined` is what JS reads
   * back from a field no constructor has assigned yet — and a base
   * constructor's virtual call really can observe a derived field that
   * early — while a null there would trap the first union helper to
   * touch it. (The native lanes seed the same slots in their allocator;
   * llvm/classes.ts's undefFieldInits.) */
  /** The allocation half of `new C(...)`, onto an explicit buffer: the
   * class's vtable global into `vt` on a hierarchy member, then one seed
   * per flattened field, then struct.new. Shared with the construct
   * THUNK, which is built outside any IR function and so cannot reach
   * `this.fn.code` — the two must allocate identically or a class built
   * through a class value would differ from one built with `new`. */
  private emitAlloc(c: Code, className: string, info: ClassInfo): void {
    if (info.meta.hierarchy) c.globalGet(this.classes.vtGlobal(className));
    for (const f of info.meta.def.fields) this.emitFieldSeed(c, f.type);
    c.structNew(info.struct);
  }

  /** A class's constructor function. Every class reaches the IR with one
   * — the frontend desugars default constructors, field initializers and
   * parameter properties into it — so both ways of not finding it are
   * bugs, and they are DIFFERENT bugs: absent from the module means the
   * frontend stopped desugaring, present but undeclared means a
   * reachability edge went missing. Neither may fall through, which
   * would hand back an instance no initializer ever ran over. */
  private ctorOf(className: string): { name: string; fn: WFunction; index: number } {
    const name = `%${className}.constructor`;
    const fn = this.funcByName.get(name);
    const index = this.funcIndexByName.get(name);
    if (fn === undefined || index === undefined) {
      throw new Error(
        this.mod.functions.some((f) => f.name === name)
          ? `wasm emitter bug: ${name} is in the module but was never declared reachable`
          : `wasm emitter bug: new ${className} with no ${name} in the module`,
      );
    }
    return { name, fn, index };
  }

  private emitFieldSeed(c: Code, t: IrType): void {
    const code = c;
    if (t.kind === "dyn") {
      // Same reasoning as the undefined-armed union below, one layer
      // down: `undefined` is what JS reads from an unassigned field, and
      // a null box would trap the first kind read to touch it.
      code.globalGet(this.dyn.undefinedGlobal());
      return;
    }
    if (t.kind === "union") {
      const tag = this.undefinedArmTag(t.unionId);
      if (tag >= 0) {
        code.globalGet(this.unions.unitGlobal(tag));
        return;
      }
    }
    const soft = this.mapTypeSoft(t);
    switch (soft.kind) {
      case "f64":
        code.f64Const(0);
        return;
      case "i64":
        code.i64Const(0n);
        return;
      case "ref":
        code.refNull(soft.typeIndex);
        return;
      default:
        code.i32Const(0);
        return;
    }
  }

  /* ── types ──────────────────────────────────────────────────────────── */

  /** The tier's value representations: f64 as itself, bool as i32, string
   * as an array of UTF-16 code units (S002; nullable in binding positions
   * — a refcounted local is NULL until its first assign, and the
   * frontend's definite-assignment guarantee means no read observes it).
   * Everything else is unrepresented work.
   *
   * Takes the lowering's WType, not IrType: the resumable pass types
   * resume's parameter with its private `%frameBase`, which is a real
   * representation here (the promise runtime's frame handle) even though
   * no frontend IR spells it. */
  private mapType(t: WType, loc: SrcLoc | undefined): ValType | null {
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
      case "union":
        // Every union VALUE is a ref to the one shared base — refusal at
        // use taken to arms: holding/passing a union never needs an arm's
        // representation, so the gate sits on wrap/narrow/dispatch sites.
        return this.unions.baseRef();
      case "caught":
        // A catch binding: the immutable exception snapshot.
        return { kind: "ref", nullable: true, typeIndex: this.exc().caughtT };
      case "promise":
        // Every promise is the ONE runtime struct whatever its inner type
        // (promises.ts's header): the payload rides a tagged triple, so
        // the inner type is the READING side's business, never the
        // representation's.
        return this.proms.promRef();
      case "%frameBase":
        // The lowering's frame handle — resume's uniform parameter.
        return { kind: "ref", nullable: true, typeIndex: this.frameBaseType() };
      case "object": {
        // ONE door for every class. The five builtin errors resolve to
        // the shared errT and a user class rooted in one resolves to its
        // subtype of errT, so nothing above here distinguishes them.
        const info = this.classInfo(t.className, loc);
        return info === null ? null : this.classes.ref(info);
      }
      case "classval": {
        const cv = this.classValInfo(t.className, loc, false);
        return cv === null ? null : { kind: "ref", nullable: true, typeIndex: cv.objT };
      }
      case "dyn":
        // The checked-dynamic box (dyn.ts). Like unions and promises this
        // arm never fails — a dyn value is one struct whatever it holds,
        // so refusal moves to the sites that BUILD or READ a payload.
        return this.dyn.dynRef();
      case "map":
      case "set": {
        // The KEY/VALUE representation is what can refuse (mapInfoFor).
        // A map/set never needs an SCC/rec-group span the way a self-
        // referential record does: it has no shapeId-keyed struct that
        // could point back at ITSELF the way a recursive record can.
        // Nothing here asserts what a genuinely nested map VALUE
        // (`Map<K, Map<K,V>>`) does, because that stays frontend-fenced
        // today (isSupportedMapValue has no map/set arm — measured, it
        // fails to type-check, never reaches this backend). An ARRAY of
        // maps/sets (`Map<K,V>[]`) is fenced too, THE SAME WAY — measured
        // directly (`Map<string, number>[]` hits SC2009: "elements have
        // no array representation yet"), despite mapTypeSoft's array-elem
        // list admitting map/set as element kinds; that admission is
        // dormant until the frontend fence lifts, not evidence of a live
        // path today. vecKeyFor's own map/set arms (review MAJOR-1) exist
        // for the case that DOES become reachable first — stage B's
        // overflow maps (`Record<string, Map<K,V>>` / `Record<string,
        // Set<T>>`, corpus 2559), which instantiate map/set as a VALUE
        // kind of the overflow store's own map, not of a user Map/Set —
        // so two differently-shaped such records don't collide.
        const info = this.mapInfoFor(t, loc, false);
        return info === null ? null : this.maps.mapRef(info);
      }
      default:
        this.refuse(`type:${t.kind}`, loc);
        return null;
    }
  }

  /** Does `object:<className>` have a representation? The one condition
   * mapType's and mapTypeSoft's object arms — and the vector-element
   * mappability list — must share, or one signature gets two views. */
  private objectMappable(className: string): boolean {
    return this.classes.info(className, undefined, true) !== null;
  }

  /** The pre-pass variant: a placeholder for unmappable types, NO refusal.
   * Only reachable bytes matter, and a placeholder can never become one:
   * the honest gate re-maps the same types before any module is emitted. */
  private mapTypeSoft(t: WType): ValType {
    switch (t.kind) {
      case "f64":
        return F64;
      case "bool":
        // I32 out of this whole switch means EITHER this arm (a genuine
        // bool) OR the unmappable placeholder (every failing sub-check
        // below — array/func/record/object/classval/map/set — falls to
        // I32 too, as does the unhandled default). mapValRepFor's soft
        // path (emitter.ts) leans on that being the ONLY two ways I32
        // comes out: it treats `val.kind === "i32" && t.kind !== "bool"`
        // as "did not resolve." Adding a new case that legitimately
        // answers I32 for something other than bool breaks that guard —
        // update it there too.
        return I32;
      case "string":
        return { kind: "ref", nullable: true, typeIndex: this.strType };
      case "array": {
        // Must produce the SAME type mapType would wherever mapType
        // succeeds — a placeholder there makes two views of one
        // signature disagree, which validation catches as a call-site
        // type clash. Placeholder-elem vectors stay distinct via the key.
        const elem = this.mapTypeSoft(t.elem);
        // Grows with EVERY new mappable kind (the increment-6/7 lesson:
        // a lagging arm here is a call-site vs global type clash).
        const mappable =
          t.elem.kind === "f64" ||
          t.elem.kind === "bool" ||
          t.elem.kind === "string" ||
          t.elem.kind === "array" ||
          t.elem.kind === "func" ||
          t.elem.kind === "record" ||
          t.elem.kind === "union" ||
          t.elem.kind === "promise" ||
          t.elem.kind === "dyn" ||
          t.elem.kind === "map" ||
          t.elem.kind === "set" ||
          (t.elem.kind === "object" && this.objectMappable(t.elem.className));
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
      case "union":
        // mapType never fails on unions, so the soft map must answer the
        // same base ref (the consistency rule).
        return this.unions.baseRef();
      case "caught":
        // mapType never fails on caught — same consistency rule.
        return { kind: "ref", nullable: true, typeIndex: this.exc().caughtT };
      case "promise":
        // mapType never fails on promises either (one struct for all).
        return this.proms.promRef();
      case "%frameBase":
        return { kind: "ref", nullable: true, typeIndex: this.frameBaseType() };
      case "object": {
        // Same arm as mapType, in lockstep: an emitted class (errT and
        // its subtypes included) is its own struct, a runtime-rooted one
        // is the placeholder. Answering a placeholder where mapType
        // succeeds is the recurring increment-6/7/10 bug — one signature,
        // two views.
        const info = this.classes.info(t.className, undefined, true);
        return info === null ? I32 : this.classes.ref(info);
      }
      case "classval": {
        const cv = this.classValInfo(t.className, undefined, true);
        return cv === null ? I32 : { kind: "ref", nullable: true, typeIndex: cv.objT };
      }
      case "dyn":
        // mapType never fails on dyn either — the consistency rule.
        return this.dyn.dynRef();
      case "map":
      case "set": {
        const info = this.mapInfoFor(t, undefined, true);
        return info === null ? I32 : this.maps.mapRef(info);
      }
      default:
        return I32;
    }
  }

  /* ── functions ──────────────────────────────────────────────────────── */

  private walkFunction(fn: WFunction): void {
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
      localsOut.push(l.boxed === true ? this.boxRefForLocal(l) : this.mapTypeSoft(l.type));
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
      chainBinds: new Map(),
      tryStack: [],
      finallyStack: [],
      pretLocal: null,
    };

    // Prologue 1: re-box captured params.
    for (const init of boxedParamInits) {
      this.fn.code.localGet(init.argIndex);
      this.fn.code.structNew(init.box);
      this.fn.code.localSet(init.slot);
    }

    // Prologue 2: dyn slots open at THE undefined box, never a null ref.
    // An implicit-any `let` with no initializer IS `undefined` in JS, and
    // a null box would trap the first kind read instead of answering it —
    // the same reasoning emitFieldSeed applies to undefined-armed fields.
    // The frontend spells most of these out as `dynFrom(undefined)`
    // initializers, so this is the FLOOR rather than the usual path; a
    // BOXED local is skipped because its box is minted at its varDecl and
    // because a tdz slot's null IS the before-initialization sentinel.
    for (const l of fn.locals) {
      if (l.type.kind !== "dyn" || l.boxed === true) continue;
      if (fn.params.some((p) => p.localId === l.id)) continue;
      this.fn.code.globalGet(this.dyn.undefinedGlobal());
      this.fn.code.localSet(localIndex.get(l.id)!);
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

  private walkBody(body: WStmt[]): void {
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

  private walkStmt(s: WStmt): void {
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
          // iteration k+1's writes. init:null is the TDZ-empty box
          // (structNewDefault leaves the nullable slot null — the
          // sentinel; the initializing assign fills it).
          const box = this.boxTypeForLocal(local);
          if (s.init !== null) {
            this.walkExpr(s.init);
            if (local.tdz === true) {
              const inner = this.tdzInnerFor(this.mapTypeSoft(local.type));
              if (inner !== null) code.structNew(inner);
            }
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
      case "return": {
        // Through a finally: the PENDING-RETURN path — snapshot the value
        // FIRST (finally mutations of returned locals are invisible,
        // Node-exact), then branch to the innermost finally's return
        // entry; the copies chain outward from there.
        const fin = this.fn.finallyStack[this.fn.finallyStack.length - 1];
        if (fin !== undefined) {
          if (s.value !== null) {
            this.walkExpr(s.value);
            if (this.fn.pretLocal === null) {
              this.fn.pretLocal = this.acquireScratch(this.mapTypeSoft(this.fn.fn.returnType));
              // Never released: the slot is live until the function ends.
            }
            code.localSet(this.fn.pretLocal);
          }
          fin.used = true;
          this.brTo(fin.pos, false);
          return;
        }
        if (s.value !== null) this.walkExpr(s.value);
        code.return_();
        return;
      }
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
            const box = this.boxTypeForLocal(initLocal);
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
            code.structNew(this.boxTypeForLocal(bindingLocal));
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

      /* Field writes, the fieldGet twin: the builtin errors' writable
       * members (`e.name = "Custom"`) are errT's own slots, an emitted
       * class's are its struct's. */
      case "fieldSet": {
        if (RUNTIME_ERROR_CLASSES.has(s.className)) {
          const slot = s.field === "name" ? 1 : s.field === "message" ? 2 : 0;
          if (slot === 0) {
            this.refuse(`fieldSet:error:${s.field}`, s.loc);
            return;
          }
          this.walkExpr(s.obj);
          this.walkExpr(s.value);
          code.structSet(this.exc().errT, slot);
          return;
        }
        const field = this.classField(s.className, s.field, s.loc);
        if (field === null) return;
        this.walkExpr(s.obj);
        this.walkExpr(s.value);
        code.structSet(field.info.struct, field.index);
        return;
      }

      /* Stores into composites — each waits on the GC shape of the thing
       * being written (bytes on the typed-array runtime, the recordKey
       * pair on the overflow map). */
      case "bytesSet":
      case "recordKeySet":
      case "recordKeyDelete":
        this.refuse(`stmt:${s.kind}`, s.loc);
        break;

      case "runtimeFence":
        // SC9002 is the checker-proved-unreachable fallthrough trap
        // (appendImplicitUndefinedReturn): wasm's own `unreachable` IS
        // that trap — reached only if the checker's proof is wrong, and
        // then it fails loudly. Every other code is a JS deferred fence:
        // a REACHABLE catchable Error (message pre-rendered by the
        // lowerer, the SC code in the %code slot), unwinding exactly
        // like a throw — scr_throw_lowering_fence, ported.
        if (s.code === "SC9002") {
          code.unreachable();
          return;
        }
        this.emitSetCellErrorLit("%Error", "Error", s.message, s.code);
        this.emitUnwind();
        return;

      case "throw":
        this.emitThrowValue(s.value);
        this.emitUnwind();
        return;

      case "rethrow": {
        // Re-raise the SAVED snapshot exactly: copy it back into the
        // cell (kind last — the commit) and unwind. The binding read
        // rides walkExpr so boxed (captured) bindings unpack correctly.
        const exc = this.exc();
        const caughtRef: ValType = { kind: "ref", nullable: true, typeIndex: exc.caughtT };
        const c = this.acquireScratch(caughtRef);
        this.walkExpr({ kind: "varRef", localId: s.localId, type: { kind: "caught" }, loc: s.loc });
        code.localSet(c);
        code.localGet(c);
        code.structGet(exc.caughtT, 1);
        code.globalSet(exc.f64G);
        code.localGet(c);
        code.structGet(exc.caughtT, 2);
        code.globalSet(exc.refG);
        code.localGet(c);
        code.structGet(exc.caughtT, 3);
        code.globalSet(exc.preG);
        code.localGet(c);
        code.structGet(exc.caughtT, 0);
        code.globalSet(exc.kindG);
        this.releaseScratch(caughtRef, c);
        this.emitUnwind();
        return;
      }

      case "tryCatch": {
        /* emit-stmts.ts's emitTryCatch, in forward-only blocks: arrival
         * at each path = falling out of its block's end. Innermost out:
         * $catch (exception in try), $finnorm (normal completion),
         * $finexc (exception path finally), $finret (pending-return
         * finally), $end. The finally body emits up to THREE copies —
         * the C backend's shape exactly. */
        const exc = this.exc();
        const hasCatch = s.catchBody !== null;
        const hasFinally = s.finallyBody !== null;
        const endPos = this.openBlock();
        let retPos = -1;
        let excPos = -1;
        let normPos = -1;
        if (hasFinally) {
          retPos = this.openBlock();
          excPos = this.openBlock();
          normPos = this.openBlock();
        }
        const catchPos = hasCatch ? this.openBlock() : -1;
        // The try body's unwind target: its catch, or (catchless — the
        // validator guarantees a finally then) the exception-path
        // finally, pending still set.
        this.fn.tryStack.push(hasCatch ? catchPos : excPos);
        const retEntry = { pos: retPos, used: false };
        if (hasFinally) this.fn.finallyStack.push(retEntry);
        this.walkBody(s.tryBody);
        this.fn.tryStack.pop();
        this.brTo(hasFinally ? normPos : endPos, false);

        if (hasCatch) {
          this.close(); // end $catch — an exception is pending here
          if (s.catchLocalId !== null) {
            // catch (e): the cell MOVES into an immutable snapshot.
            code.globalGet(exc.kindG);
            code.globalGet(exc.f64G);
            code.globalGet(exc.refG);
            code.globalGet(exc.preG);
            code.structNew(exc.caughtT);
            const local = this.fn.localById.get(s.catchLocalId);
            if (local?.boxed === true) {
              code.structNew(this.boxTypeForLocal(local));
            }
            code.localSet(this.localIndex(s.catchLocalId));
          }
          this.emitCellClear();
          // Exceptions from the CATCH body unwind to the exception-path
          // finally when one exists, else to the enclosing context.
          if (hasFinally) this.fn.tryStack.push(excPos);
          this.walkBody(s.catchBody!);
          if (hasFinally) this.fn.tryStack.pop();
          this.brTo(hasFinally ? normPos : endPos, false);
        }

        if (hasFinally) {
          // The finally copies run in the OUTER context: their own
          // may-throw calls unwind outward (a throw inside a finally
          // REPLACES whatever was in flight), and returns inside them
          // are frontend-rejected.
          this.fn.finallyStack.pop();

          this.close(); // end $finnorm — the normal-path copy
          this.walkBody(s.finallyBody!);
          this.brTo(endPos, false);

          this.close(); // end $finexc — exception path: stash, run, re-raise
          // The in-flight exception STASHES across the body so the
          // body's own pending checks answer for themselves; normal
          // completion re-raises it and keeps propagating.
          const kS = this.acquireScratch(I32);
          const fS = this.acquireScratch(F64);
          const rS = this.acquireScratch(ANY_REF);
          const pS = this.acquireScratch(I32);
          code.globalGet(exc.kindG);
          code.localSet(kS);
          code.globalGet(exc.f64G);
          code.localSet(fS);
          code.globalGet(exc.refG);
          code.localSet(rS);
          code.globalGet(exc.preG);
          code.localSet(pS);
          this.emitCellClear();
          this.walkBody(s.finallyBody!);
          code.localGet(fS);
          code.globalSet(exc.f64G);
          code.localGet(rS);
          code.globalSet(exc.refG);
          code.localGet(pS);
          code.globalSet(exc.preG);
          code.localGet(kS);
          code.globalSet(exc.kindG);
          this.releaseScratch(I32, kS);
          this.releaseScratch(F64, fS);
          this.releaseScratch(ANY_REF, rS);
          this.releaseScratch(I32, pS);
          this.emitUnwind();

          this.close(); // end $finret — the pending-return copy
          if (retEntry.used) {
            this.walkBody(s.finallyBody!);
            const outer = this.fn.finallyStack[this.fn.finallyStack.length - 1];
            if (outer !== undefined) {
              outer.used = true;
              this.brTo(outer.pos, false);
            } else if (this.fn.fn.returnType.kind === "void") {
              code.return_();
            } else {
              code.localGet(this.fn.pretLocal!);
              code.return_();
            }
          } else {
            // Nothing branched here (no return crossed this finally);
            // the region is unreachable but must still validate.
            code.unreachable();
          }
        }
        this.close(); // end $end
        return;
      }

      /* ── the resumable lowering's runtime seam (statemachine.ts) ──── */

      /** Park (resume, frame) on the awaited promise — or, when it has
       * already settled, spend the one microtask turn anyway. */
      case "%async.subscribe":
        this.walkExpr(s.promise);
        this.walkExpr(s.resume);
        this.walkExpr(s.frame);
        code.call(this.proms.subscribe());
        return;

      /** `await <non-thenable>`: no promise, just the turn. */
      case "%async.hop":
        this.walkExpr(s.resume);
        this.walkExpr(s.frame);
        code.call(this.proms.hop());
        return;

      /** The loader's dependency wait (`module.await`): park ONLY on a
       * pending dependency. A settled one falls through and the state
       * machine drops into its resume state through the dispatch loop, so
       * the importer continues in the same turn — ECMAScript's internal
       * module wait costs no promise job (statemachine.ts's header). */
      case "%async.subscribeIfPending": {
        const p = this.acquireScratch(this.proms.promRef());
        this.walkExpr(s.promise);
        code.localSet(p);
        code.localGet(p);
        code.structGet(this.proms.promT, PROM_STATE);
        code.i32Eqz();
        this.openIf();
        code.localGet(p);
        this.walkExpr(s.resume);
        this.walkExpr(s.frame);
        code.call(this.proms.subscribe());
        code.return_();
        this.close();
        this.releaseScratch(this.proms.promRef(), p);
        return;
      }

      /** A module initializer's cache guard — the first statement of its
       * wrapper. A non-null global is this module's own evaluation
       * promise (already evaluating, or evaluated): hand it back instead
       * of running the body a second time. */
      case "%async.cacheCheck": {
        const g = this.globalById.get(s.globalId);
        if (g === undefined) throw new Error(`async cache global "${s.globalId}" not in module`);
        const index = this.globalIndex(g, s.loc);
        code.globalGet(index);
        code.refIsNull();
        code.i32Eqz();
        this.openIf();
        code.globalGet(index);
        code.return_();
        this.close();
        return;
      }

      /** A body-boxed local's box, made in the SPAWN WRAPPER so resume can
       * capture it (statemachine.ts's BOXES THE BODY OWNS). Bit for bit
       * the initializer-free `varDecl` above — struct.new_default leaves a
       * ref payload null, which is also the TDZ sentinel — and the body's
       * declaration is the `assign` that fills it through the box. */
      case "%async.boxInit": {
        const local = this.fn.localById.get(s.localId);
        if (local?.boxed !== true) throw new Error(`%async.boxInit on non-boxed local "${s.localId}"`);
        code.structNewDefault(this.boxTypeForLocal(local));
        code.localSet(this.localIndex(s.localId));
        return;
      }

      /** The loader owns a module evaluation promise: its rejection is the
       * program's root-rejection exit, never an unhandled rejection, so it
       * is observed the moment it exists. */
      case "%async.markHandled":
        this.walkExpr(s.promise);
        code.i32Const(1);
        code.structSet(this.proms.promT, PROM_OBSERVED);
        return;

      /** Fulfil my own promise. The value's STATIC type picks the payload
       * slot, emitThrowValue's dispatch exactly — the two share the cell's
       * encoding, which is what lets a rejection copy across field-wise. */
      case "%async.settle":
        this.walkExpr(s.promise);
        this.emitPayload(s.value, "settle", s.loc);
        code.i32Const(1);
        code.call(this.proms.settle());
        return;

      /** Reject my own promise with a caught snapshot: the three slots
       * move over unread — a rejection payload IS a thrown payload. */
      case "%async.reject": {
        const exc = this.exc();
        const c = this.acquireScratch(this.caughtRef());
        this.walkExpr(s.caught);
        code.localSet(c);
        this.walkExpr(s.promise);
        code.localGet(c);
        code.structGet(exc.caughtT, 0);
        code.localGet(c);
        code.structGet(exc.caughtT, 1);
        code.localGet(c);
        code.structGet(exc.caughtT, 2);
        code.localGet(c);
        code.structGet(exc.caughtT, 3);
        code.i32Const(2);
        code.call(this.proms.settle());
        this.releaseScratch(this.caughtRef(), c);
        return;
      }

      /** Re-entry after an await: a REJECTED promise re-throws here —
       * observe it (it is handled, by this frame), copy the payload into
       * the exception cell (kind LAST, the commit) and unwind, which lands
       * in resume's own catch and becomes this frame's rejection. */
      case "%async.rejectCheck": {
        const pr = this.acquireScratch(this.proms.promRef());
        this.walkExpr(s.promise);
        code.localSet(pr);
        this.emitRejectCheckOn(pr);
        this.releaseScratch(this.proms.promRef(), pr);
        return;
      }

      /** awaitUnionExpr's suspend over `Promise<T> | units`: the promise
       * arm parks on its promise, every other arm is a unit and takes the
       * plain `await <non-thenable>` hop. One tag read decides. */
      case "%async.subscribeUnion": {
        const arm = this.awaitUnionArm(s.value, s.promiseTag, s.loc);
        if (arm === null) return;
        const u = this.acquireScratch(this.unions.baseRef());
        this.walkExpr(s.value);
        code.localSet(u);
        code.localGet(u);
        code.structGet(this.unions.base(), 0);
        code.i32Const(s.promiseTag);
        code.i32Eq();
        this.openIf();
        code.localGet(u);
        code.refCast(arm);
        code.structGet(arm, 1);
        this.walkExpr(s.resume);
        this.walkExpr(s.frame);
        code.call(this.proms.subscribe());
        code.else_();
        this.walkExpr(s.resume);
        this.walkExpr(s.frame);
        code.call(this.proms.hop());
        this.close();
        this.releaseScratch(this.unions.baseRef(), u);
        return;
      }

      /** The same re-entry check for a union-armed await. Only the promise
       * arm can carry a rejection; a unit arm resumed through the hop and
       * has nothing to check. */
      case "%async.rejectCheckUnion": {
        const arm = this.awaitUnionArm(s.value, s.promiseTag, s.loc);
        if (arm === null) return;
        const u = this.acquireScratch(this.unions.baseRef());
        this.walkExpr(s.value);
        code.localSet(u);
        code.localGet(u);
        code.structGet(this.unions.base(), 0);
        code.i32Const(s.promiseTag);
        code.i32Eq();
        this.openIf();
        const pr = this.acquireScratch(this.proms.promRef());
        code.localGet(u);
        code.refCast(arm);
        code.structGet(arm, 1);
        code.localSet(pr);
        this.emitRejectCheckOn(pr);
        this.releaseScratch(this.proms.promRef(), pr);
        this.close();
        this.releaseScratch(this.unions.baseRef(), u);
        return;
      }

      default: {
        const rest: never = s;
        this.refuse(`stmt:${(rest as WStmt).kind}`, (rest as WStmt).loc);
        return;
      }
    }
    this.walkNested(s);
  }

  /** A local or global write — `assign` and non-boxed varDecl share it.
   * Globals live in the "%g." namespace (IrGlobal docs) and get their wasm
   * slot lazily, right here at first use; a boxed local writes THROUGH
   * its box (the shared binding every capture sees). */
  private storeVar(localId: string, value: WExpr, loc: SrcLoc): void {
    const global = this.globalById.get(localId);
    if (global !== undefined) {
      this.walkExpr(value);
      this.fn.code.globalSet(this.globalIndex(global, loc));
      return;
    }
    const local = this.fn.localById.get(localId);
    if (local?.boxed === true) {
      const box = this.boxTypeForLocal(local);
      this.fn.code.localGet(this.localIndex(localId));
      this.walkExpr(value);
      if (local.tdz === true) {
        // The initializing assign fills the tdz slot: scalars wrap in
        // their indirection struct (the non-null ref IS "initialized").
        const inner = this.tdzInnerFor(this.mapTypeSoft(local.type));
        if (inner !== null) this.fn.code.structNew(inner);
      }
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
  private walkNested(s: WStmt): void {
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
      /* The async seam's statements carry EXPRESSIONS only — no nested
       * statement bodies for the survey to descend into. */
      case "%async.subscribe":
      case "%async.hop":
      case "%async.subscribeIfPending":
      case "%async.subscribeUnion":
      case "%async.settle":
      case "%async.reject":
      case "%async.rejectCheck":
      case "%async.rejectCheckUnion":
      case "%async.cacheCheck":
      case "%async.markHandled":
      case "%async.boxInit":
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
  private walkExpr(e: WExpr): void {
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
          const box = this.boxTypeForLocal(local);
          code.localGet(this.localIndex(e.localId));
          code.structGet(box, 0);
          if (local.tdz === true) {
            // A TDZ slot reads null until its source-position assign
            // runs: Node's exact catchable ReferenceError (the C
            // emitter's scr_throw_error_named site, ported — name
            // overrides on the %Error base; the builtin table has no
            // %ReferenceError). Scalar payloads unwrap their tdz
            // indirection after the test.
            code.refIsNull();
            this.openIf();
            this.emitSetCellErrorLit("%Error", "ReferenceError", `Cannot access '${local.name}' before initialization`, null);
            this.emitUnwind();
            this.close();
            code.localGet(this.localIndex(e.localId));
            code.structGet(box, 0);
            code.refAsNonNull();
            const inner = this.tdzInnerFor(this.mapTypeSoft(local.type));
            if (inner !== null) code.structGet(inner, 0);
            return;
          }
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
        if (this.mayThrow.has(e.callee)) this.emitPendingCheck();
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
        // The indirect callee is unknown; one closure target that may
        // throw makes every callValue a check site (may-throw.ts's
        // `indirect` answer, the native rule).
        if (this.mayThrowIndirect) this.emitPendingCheck();
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
        if (k === "array" || k === "func" || k === "record" || k === "object" || k === "classval") {
          // Every object is truthy; evaluate for effects, answer true.
          // (A class-typed value is never null — null and undefined ride
          // unions, whose own helper answers for them.)
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
        if (k === "union") {
          // The ARM value's ToBoolean via the per-union interned helper.
          const h = this.unionTruthyHelper(e.operand.type.unionId, e.loc);
          if (h === null) {
            code.unreachable();
            return;
          }
          this.walkExpr(e.operand);
          code.call(h);
          return;
        }
        this.refuse(`toBool:${k}`, e.loc);
        code.unreachable();
        return;
      }

      case "logical": {
        const k = e.type.kind;
        if (k === "union") {
          // Same value semantics with the per-union truthy helper as the
          // test; both operands carry the union type.
          const h = this.unionTruthyHelper(e.type.unionId, e.loc);
          if (h === null) {
            code.unreachable();
            return;
          }
          const t = this.unions.baseRef();
          this.walkExpr(e.left);
          const s = this.acquireScratch(t);
          code.localSet(s);
          code.localGet(s);
          code.call(h);
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
        if (k === "dyn") {
          // Same value semantics over the checked-dynamic tree, with the
          // runtime ToBoolean (scr_dyn_truthy) as the test: the deciding
          // operand IS the result, and the untaken side never runs.
          const t = this.dyn.dynRef();
          this.walkExpr(e.left);
          const s = this.acquireScratch(t);
          code.localSet(s);
          code.localGet(s);
          code.call(this.dyn.truthy());
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

      case "mapNew": {
        if (e.type.kind !== "map") throw new Error("mapNew with a non-map type");
        const info = this.mapInfoFor(e.type, e.loc, false);
        if (info === null) {
          code.unreachable();
          return;
        }
        if (e.seed === undefined || e.seed.length === 0) {
          code.call(this.maps.new_(info));
          return;
        }
        // Construct empty + set() each pair in SOURCE order (a repeated
        // key overwrites — set()'s own contract already gives "first
        // position wins, last write wins" for free, matching Node).
        const mapRef = this.maps.mapRef(info);
        const mp = this.acquireScratch(mapRef);
        code.call(this.maps.new_(info));
        code.localSet(mp);
        for (const pair of e.seed) {
          code.localGet(mp);
          this.walkExpr(pair.key);
          this.walkExpr(pair.value);
          code.call(this.maps.set(info));
        }
        code.localGet(mp);
        this.releaseScratch(mapRef, mp);
        return;
      }

      case "mapIntrinsic":
        this.emitMapIntrinsic(e);
        return;

      case "setNew": {
        if (e.type.kind !== "set") throw new Error("setNew with a non-set type");
        const info = this.mapInfoFor(e.type, e.loc, false);
        if (info === null) {
          code.unreachable();
          return;
        }
        if (e.seed === undefined) {
          code.call(this.maps.new_(info));
          return;
        }
        const seedType = e.seed.type;
        if (seedType.kind !== "array") throw new Error("setNew seed is not an array");
        const vecInfo = this.vecInfoFor(seedType, e.loc);
        if (vecInfo === null) {
          code.unreachable();
          return;
        }
        const mapRef = this.maps.mapRef(info);
        const mp = this.acquireScratch(mapRef);
        code.call(this.maps.new_(info));
        code.localSet(mp);
        code.localGet(mp);
        this.walkExpr(e.seed);
        code.call(this.maps.addAll(info, vecInfo.struct, vecInfo.bufType));
        code.localGet(mp);
        this.releaseScratch(mapRef, mp);
        return;
      }

      case "setIntrinsic":
        this.emitSetIntrinsic(e);
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
        if (k === "union") {
          // The ARM value's ToString via the per-union interned helper
          // (arms frontend-fenced to unit/string/f64/bool).
          const h = this.unionToStrHelper(e.operand.type.unionId, e.loc);
          if (h === null) {
            code.unreachable();
            return;
          }
          this.walkExpr(e.operand);
          code.call(h);
          return;
        }
        if (k === "dyn") {
          // String(u) over a checked-dynamic value — the C emitter's sc_ds
          // walker, which is NOT typeof's table and not the `u.toString()`
          // method spelling (see dyn.ts's toStr).
          this.walkExpr(e.operand);
          code.call(this.dyn.toStr());
          return;
        }
        // Caught operands snapshot — waits on the exception protocol.
        this.refuse(`toString:${k}`, e.loc);
        code.unreachable();
        return;
      }

      /* ── tagged unions (see the unions block above walkFunction) ─────── */

      case "unionWrap": {
        const vt = e.value.type;
        if (isUnitType(vt)) {
          // No payload and no evaluation: a unit-typed value is a pure
          // unitLit (the frontend's slot contract) — every wrap yields
          // THE interned immortal instance for the tag.
          code.globalGet(this.unions.unitGlobal(e.tag));
          return;
        }
        if (vt.kind === "void") {
          // A void call flowing into an undefined arm: effects first,
          // then the interned instance.
          this.walkExpr(e.value);
          code.globalGet(this.unions.unitGlobal(e.tag));
          return;
        }
        const st = this.unionArmStruct(e.unionId, e.tag, e.loc);
        if (st === null) {
          code.unreachable();
          return;
        }
        code.i32Const(e.tag);
        this.walkExpr(e.value);
        code.structNew(st);
        return;
      }

      case "unionNarrow": {
        // Tag-UNCHECKED extraction — the frontend emits this only under
        // tsc's proof, and the cast can only fail on a frontend bug (it
        // traps loudly rather than misreading).
        const st = this.unionArmStruct(e.unionId, e.tag, e.loc);
        if (st === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.value);
        code.refCast(st);
        code.structGet(st, 1);
        return;
      }

      case "unionIsTag": {
        this.walkExpr(e.value);
        code.structGet(this.unions.base(), 0);
        code.i32Const(e.tag);
        if (e.negated) code.i32Ne();
        else code.i32Eq();
        return;
      }

      case "unionEq": {
        const h = this.unionEqHelper(e.unionId, e.sameValue, e.loc);
        if (h === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.left);
        this.walkExpr(e.right);
        code.call(h);
        if (e.negated) code.i32Eqz();
        return;
      }

      case "unionDisc": {
        // Shared-field read: switch on the tag, read the (same-typed)
        // field from the concretely-cast payload. Every arm resolves
        // BEFORE any emission — one out-of-tier arm refuses the whole
        // read, never partial code.
        const def = this.unionDef(e.unionId);
        const rt = this.mapType(e.type, e.loc);
        if (rt === null) {
          code.unreachable();
          return;
        }
        const plan: { struct: number; rec: number; field: number }[] = [];
        for (let i = 0; i < def.arms.length; i++) {
          const armT = def.arms[i]!;
          if (armT.kind !== "record") {
            // Class (object) arms wait on class objects.
            this.refuse(`unionDisc:arm:${armT.kind}`, e.loc);
            code.unreachable();
            return;
          }
          const info = this.recordInfo(armT.shapeId, e.loc, false);
          const st = this.unionArmStruct(e.unionId, i, e.loc);
          if (info === null || st === null) {
            code.unreachable();
            return;
          }
          const field = info.fieldIndex.get(e.field);
          if (field === undefined) throw new Error(`unionDisc field ${e.field} not on shape ${armT.shapeId}`);
          plan.push({ struct: st, rec: info.struct, field });
        }
        const u = this.acquireScratch(this.unions.baseRef());
        this.walkExpr(e.value);
        code.localSet(u);
        const t = this.acquireScratch(I32);
        code.localGet(u);
        code.structGet(this.unions.base(), 0);
        code.localSet(t);
        // Nested if-chain over tags; the innermost else is the
        // corrupted-tag trap (loud, like the C backend's default case).
        for (const [i, p] of plan.entries()) {
          code.localGet(t);
          code.i32Const(i);
          code.i32Eq();
          this.openIfResult(rt);
          code.localGet(u);
          code.refCast(p.struct);
          code.structGet(p.struct, 1);
          code.structGet(p.rec, p.field);
          code.else_();
        }
        code.unreachable();
        for (let i = 0; i < plan.length; i++) this.close();
        this.releaseScratch(I32, t);
        this.releaseScratch(this.unions.baseRef(), u);
        return;
      }

      case "unionKeyGet": {
        // The unionDisc generalization: per arm, a statically-resolved
        // answer at the JOIN type — a declared literal field reads its
        // slot (wrapping an arm-typed answer into the join), a unit arm
        // answers the join's interned undefined arm. Index-signature
        // shapes refuse at recordInfo; runtime keys and array arms wait
        // on their machinery.
        const def = this.unionDef(e.unionId);
        const rt = this.mapType(e.type, e.loc);
        if (rt === null) {
          code.unreachable();
          return;
        }
        const resultUnionId = e.type.kind === "union" ? e.type.unionId : null;
        const literal = e.key.kind === "strLit" ? e.key.value : null;
        type ArmPlan =
          | { kind: "unit"; global: number }
          | { kind: "read"; struct: number; rec: number; field: number; wrap: { tag: number; struct: number } | null };
        const plan: ArmPlan[] = [];
        for (let i = 0; i < def.arms.length; i++) {
          const armT = def.arms[i]!;
          if (isUnitType(armT)) {
            // The optional-chain tail's short-circuit: undefined.
            if (resultUnionId === null) throw new Error("unionKeyGet unit arm without a union result");
            const utag = this.undefinedArmTag(resultUnionId);
            if (utag < 0) throw new Error("unionKeyGet unit arm without an undefined result arm");
            plan.push({ kind: "unit", global: this.unions.unitGlobal(utag) });
            continue;
          }
          if (armT.kind === "array") {
            // The string-key → element-index runtime path is not in tier.
            this.refuse("unionKeyGet:arm:array", e.loc);
            code.unreachable();
            return;
          }
          if (armT.kind !== "record") throw new Error(`unionKeyGet arm of kind ${armT.kind}`);
          const shape = this.recordShapes.get(armT.shapeId);
          if (shape === undefined) throw new Error(`unknown record shape ${armT.shapeId}`);
          const declared = literal !== null ? shape.fields.find((f) => f.name === literal) : undefined;
          if (declared === undefined) {
            // A runtime key (or a literal touching only the overflow
            // map) rides the keyed-read helper machinery.
            this.refuse("unionKeyGet:keyed-read", e.loc);
            code.unreachable();
            return;
          }
          const info = this.recordInfo(armT.shapeId, e.loc, false);
          const st = this.unionArmStruct(e.unionId, i, e.loc);
          if (info === null || st === null) {
            code.unreachable();
            return;
          }
          const field = info.fieldIndex.get(declared.name);
          if (field === undefined) throw new Error(`unionKeyGet field ${declared.name} not on shape ${armT.shapeId}`);
          if (typeEquals(declared.type, e.type)) {
            plan.push({ kind: "read", struct: st, rec: info.struct, field, wrap: null });
            continue;
          }
          if (resultUnionId === null || isUnitType(declared.type)) {
            throw new Error(`unionKeyGet arm answer ${declared.type.kind} outside the join`);
          }
          const wtag = this.unionArmTag(resultUnionId, declared.type);
          if (wtag < 0) throw new Error(`unionKeyGet arm answer ${declared.type.kind} outside the join`);
          const wstruct = this.unionArmStruct(resultUnionId, wtag, e.loc);
          if (wstruct === null) {
            code.unreachable();
            return;
          }
          plan.push({ kind: "read", struct: st, rec: info.struct, field, wrap: { tag: wtag, struct: wstruct } });
        }
        // The key evaluates ONCE, before the switch — its effects are
        // owed even though every in-tier answer resolves statically.
        this.walkExpr(e.key);
        code.drop();
        const u = this.acquireScratch(this.unions.baseRef());
        this.walkExpr(e.value);
        code.localSet(u);
        const t = this.acquireScratch(I32);
        code.localGet(u);
        code.structGet(this.unions.base(), 0);
        code.localSet(t);
        for (const [i, p] of plan.entries()) {
          code.localGet(t);
          code.i32Const(i);
          code.i32Eq();
          this.openIfResult(rt);
          if (p.kind === "unit") {
            code.globalGet(p.global);
          } else {
            if (p.wrap !== null) code.i32Const(p.wrap.tag);
            code.localGet(u);
            code.refCast(p.struct);
            code.structGet(p.struct, 1);
            code.structGet(p.rec, p.field);
            if (p.wrap !== null) code.structNew(p.wrap.struct);
          }
          code.else_();
        }
        code.unreachable();
        for (let i = 0; i < plan.length; i++) this.close();
        this.releaseScratch(I32, t);
        this.releaseScratch(this.unions.baseRef(), u);
        return;
      }

      case "nullish": {
        // `a ?? b`: the left's runtime TAG against its unit arms as the
        // test (JS-exact — 0/""/false do NOT take the right side); the
        // right runs lazily. Pass-through answers the left box itself;
        // the narrowed shape extracts the single non-unit arm's payload
        // under the checker's proof.
        const lt = e.left.type;
        if (lt.kind === "dyn") {
          // A checked-dynamic left: the RUNTIME KIND decides (only
          // undefined and null take the default — 0, "" and false do
          // not), and both sides are already dyn, so there is no
          // narrowing to do and the box passes through.
          const t = this.dyn.dynRef();
          this.walkExpr(e.left);
          const s = this.acquireScratch(t);
          code.localSet(s);
          this.emitDynNullish(s);
          this.openIfResult(t);
          this.walkExpr(e.right);
          code.else_();
          code.localGet(s);
          this.close();
          this.releaseScratch(t, s);
          return;
        }
        if (lt.kind !== "union") {
          // jsval lefts wait on the island representation.
          this.refuse(`nullish:${lt.kind}`, e.loc);
          code.unreachable();
          return;
        }
        const def = this.unionDef(lt.unionId);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        if (unitTags.length === 0) throw new Error("nullish union lacks unit arms");
        const rt = this.mapType(e.type, e.loc);
        if (rt === null) {
          code.unreachable();
          return;
        }
        const passThrough = typeEquals(e.type, lt);
        let narrow: number | null = null;
        if (!passThrough) {
          const tag = this.unionArmTag(lt.unionId, e.type);
          if (tag < 0) throw new Error("nullish narrowed outside the union");
          narrow = this.unionArmStruct(lt.unionId, tag, e.loc);
          if (narrow === null) {
            code.unreachable();
            return;
          }
        }
        const u = this.acquireScratch(this.unions.baseRef());
        this.walkExpr(e.left);
        code.localSet(u);
        const t = this.acquireScratch(I32);
        code.localGet(u);
        code.structGet(this.unions.base(), 0);
        code.localSet(t);
        unitTags.forEach((tag, i) => {
          code.localGet(t);
          code.i32Const(tag);
          code.i32Eq();
          if (i > 0) code.i32Or();
        });
        this.openIfResult(rt);
        this.walkExpr(e.right);
        code.else_();
        if (passThrough) {
          code.localGet(u);
        } else {
          code.localGet(u);
          code.refCast(narrow!);
          code.structGet(narrow!, 1);
        }
        this.close();
        this.releaseScratch(I32, t);
        this.releaseScratch(this.unions.baseRef(), u);
        return;
      }

      case "orDefault": {
        // `u || d` — nullish's dance with the per-union TRUTHY helper as
        // the test. The truthy side extracts the single non-unit arm, or
        // hands the whole box to the frontend's union→union retag helper
        // (an ordinary IR function; its body walks like any other).
        const lt = e.left.type;
        if (lt.kind !== "union") throw new Error("orDefault left is not a union");
        const h = this.unionTruthyHelper(lt.unionId, e.loc);
        const rt = this.mapType(e.type, e.loc);
        if (h === null || rt === null) {
          code.unreachable();
          return;
        }
        let retag: { index: number; clos: number } | null = null;
        let narrow: number | null = null;
        if (e.retag !== undefined) {
          const callee = this.funcByName.get(e.retag);
          const index = this.funcIndexByName.get(e.retag);
          if (callee === undefined || index === undefined) {
            throw new Error(`orDefault retag helper "${e.retag}" not in module`);
          }
          retag = { index, clos: this.fnClosPair(callee).clos };
        } else {
          const tag = this.unionArmTag(lt.unionId, e.type);
          if (tag < 0) throw new Error("orDefault narrowed outside the union");
          narrow = this.unionArmStruct(lt.unionId, tag, e.loc);
          if (narrow === null) {
            code.unreachable();
            return;
          }
        }
        const u = this.acquireScratch(this.unions.baseRef());
        this.walkExpr(e.left);
        code.localSet(u);
        code.localGet(u);
        code.call(h);
        this.openIfResult(rt);
        if (retag !== null) {
          code.refNull(retag.clos);
          code.localGet(u);
          code.call(retag.index);
          // The helper's stranded-arm throw is unreachable here BY
          // CONSTRUCTION (truthiness ruled unit arms out), but the
          // name-based may-throw answer doesn't know that — the check
          // keeps the contract uniform and no-ops at runtime.
          if (this.mayThrow.has(e.retag!)) this.emitPendingCheck();
        } else {
          code.localGet(u);
          code.refCast(narrow!);
          code.structGet(narrow!, 1);
        }
        code.else_();
        this.walkExpr(e.right);
        this.close();
        this.releaseScratch(this.unions.baseRef(), u);
        return;
      }

      /* ── the resumable lowering's expression seam ─────────────────── */

      /** The pending promise a spawn wrapper hands back. */
      case "%async.mint":
        code.call(this.proms.mint());
        return;

      /** Resume's prologue: the base-typed parameter narrowed to this
       * function's own frame. Cannot fail — the runtime hands back the
       * frame this resume parked. */
      case "%async.frameCast": {
        const t = e.type;
        if (t.kind !== "record") throw new Error("%async.frameCast to a non-record");
        const info = this.recordInfo(t.shapeId, e.loc, false);
        if (info === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.value);
        code.refCast(info.struct);
        return;
      }

      /** The value a resumed frame was woken with, read back by the AWAIT
       * SITE's static type (the payload triple carries no type of its
       * own). A rejected promise never reaches here — the re-entry's
       * %async.rejectCheck unwound first. */
      case "%async.settled":
        if (!this.emitSettledPayload(code, e.type, () => this.walkExpr(e.promise), "expr:%async.settled", e.loc)) {
          code.unreachable();
        }
        return;

      /** The same read for an awaited `Promise<T> | units` union, REWRAPPED
       * into the result union the await site is typed with. See
       * emitSettledUnion for the tag mapping — the two unions do not share
       * a numbering, and assuming they did would miscompile silently. */
      case "%async.settledUnion":
        this.emitSettledUnion(e);
        return;

      /** `new Promise<T>(executor)`: mint, hand the executor its resolve
       * (and reject) closure, and run it SYNCHRONOUSLY — JS-exact. An
       * executor throw REJECTS the promise instead of unwinding into the
       * creator, which is why this cannot use the ordinary pending check. */
      case "newPromise":
        this.emitNewPromise(e);
        return;

      /** `Promise.withResolvers<T>()`: exactly newPromise's pieces without
       * an executor — one mint and the SAME interned settler closures,
       * assembled into the frontend's `{ promise, resolve, reject }`
       * record instead of being passed to a callback. Handing the pair out
       * as values needs nothing extra: a settler's environment already
       * holds the promise and outlives the expression like any other GC
       * value. Never throws. */
      case "promiseWithResolvers":
        this.emitWithResolvers(e);
        return;

      case "optChain": {
        // `a?.b`: the receiver (a unit-armed union with ONE non-unit arm)
        // evaluates once; a unit tag short-circuits to the result's
        // interned undefined arm WITHOUT evaluating the body (argument
        // effects included); otherwise the narrowed receiver binds to the
        // chain id and the body produces the result.
        const recvT = e.receiver.type;
        if (recvT.kind === "dyn") {
          // A checked-dynamic receiver: the kind tag is the short-circuit
          // test, the undefined immortal is the unit answer (dyn spells
          // undefined directly — there is no union wrapper here), and the
          // body reads the receiver through chainRecv like any other
          // chain. A void body (`u.m?.()` in statement position) has no
          // result at all.
          if (e.type.kind !== "dyn" && e.type.kind !== "void") {
            this.refuse(`optChain:dyn:${e.type.kind}`, e.loc);
            code.unreachable();
            return;
          }
          const t = this.dyn.dynRef();
          const r = this.acquireScratch(t);
          this.walkExpr(e.receiver);
          code.localSet(r);
          this.emitDynNullish(r);
          const emitBody = (): void => {
            this.fn.chainBinds.set(e.id, r);
            this.walkExpr(e.body);
            this.fn.chainBinds.delete(e.id);
          };
          if (e.type.kind === "void") {
            code.i32Eqz();
            this.openIf();
            emitBody();
            this.close();
          } else {
            this.openIfResult(t);
            code.globalGet(this.dyn.undefinedGlobal());
            code.else_();
            emitBody();
            this.close();
          }
          this.releaseScratch(t, r);
          return;
        }
        if (recvT.kind !== "union") {
          // jsval receivers (the `any` chain forms) wait on the island
          // representation.
          this.refuse(`optChain:${recvT.kind}`, e.loc);
          code.unreachable();
          return;
        }
        const def = this.unionDef(recvT.unionId);
        const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
        const nonUnit = def.arms.findIndex((a) => !isUnitType(a));
        if (unitTags.length === 0 || nonUnit < 0) throw new Error("optChain receiver union shape");
        const armVal = this.mapType(def.arms[nonUnit]!, e.loc);
        const recvStruct = this.unionArmStruct(recvT.unionId, nonUnit, e.loc);
        if (armVal === null || recvStruct === null) {
          code.unreachable();
          return;
        }
        const isVoid = e.type.kind === "void";
        let resultT: ValType | null = null;
        let shortGlobal = -1;
        if (!isVoid) {
          if (e.type.kind !== "union") throw new Error("optChain result is not a union");
          const utag = this.undefinedArmTag(e.type.unionId);
          if (utag < 0) throw new Error("optChain result union lacks an undefined arm");
          resultT = this.unions.baseRef();
          shortGlobal = this.unions.unitGlobal(utag);
        }
        const u = this.acquireScratch(this.unions.baseRef());
        this.walkExpr(e.receiver);
        code.localSet(u);
        const t = this.acquireScratch(I32);
        code.localGet(u);
        code.structGet(this.unions.base(), 0);
        code.localSet(t);
        unitTags.forEach((tag, i) => {
          code.localGet(t);
          code.i32Const(tag);
          code.i32Eq();
          if (i > 0) code.i32Or();
        });
        const bind = this.acquireScratch(armVal);
        const emitBind = (): void => {
          code.localGet(u);
          code.refCast(recvStruct);
          code.structGet(recvStruct, 1);
          code.localSet(bind);
          this.fn.chainBinds.set(e.id, bind);
          this.walkExpr(e.body);
          this.fn.chainBinds.delete(e.id);
        };
        if (isVoid) {
          // The `cb?.()` statement form: run the body only off the unit
          // tags, no value.
          code.i32Eqz();
          this.openIf();
          emitBind();
          this.close();
        } else {
          this.openIfResult(resultT!);
          code.globalGet(shortGlobal);
          code.else_();
          emitBind();
          this.close();
        }
        this.releaseScratch(armVal, bind);
        this.releaseScratch(I32, t);
        this.releaseScratch(this.unions.baseRef(), u);
        return;
      }

      case "chainRecv": {
        const bind = this.fn.chainBinds.get(e.id);
        if (bind === undefined) throw new Error(`chainRecv outside its chain ("${e.id}")`);
        code.localGet(bind);
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
          /* `Promise.resolve(v)` / `Promise.reject(e)`: a fresh promise
           * settled on the spot. The validator guarantees the shapes —
           * resolve takes zero args (Promise<void>) or one NON-promise
           * value of the result's inner type, reject one %Error-rooted
           * reason — so both are a mint plus one settle, and the rejected
           * one enters the ledger like any other rejection. */
          case "promise.resolve":
          case "promise.reject": {
            const rejecting = e.name === "promise.reject";
            const p = this.acquireScratch(this.proms.promRef());
            code.call(this.proms.mint());
            code.localSet(p);
            code.localGet(p);
            this.emitPayload(e.args[0] ?? null, e.name, e.loc);
            code.i32Const(rejecting ? 2 : 1);
            code.call(this.proms.settle());
            code.localGet(p);
            this.releaseScratch(this.proms.promRef(), p);
            return;
          }
          /* The two combinators: a fresh result promise plus one REACTION
           * subscribed to every entry (see the combinator block below). */
          case "promise.all":
            this.emitPromiseAll(e);
            return;
          case "promise.race":
            this.emitPromiseRace(e);
            return;
          /* module.await waits on the async-module machinery. */
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
        if (e.fn === "insp.f64") {
          // util.inspect's one number-ism (scr_insp_f64): JS ToString
          // except -0 prints "-0" — console.log's number formatting,
          // reached through the frontend's per-union format helpers.
          this.walkExpr(e.args[0]!);
          code.call(this.inspF64Helper());
          return;
        }
        if (e.fn === "insp.str") {
          // formatPrimitive's string arm (inspect.ts): the quoting ladder,
          // the 10000-unit cap and the per-line ` +` continuation, which
          // reads the layout engine's indentation global. Never throws.
          this.walkExpr(e.args[0]!);
          code.call(this.insp.str());
          return;
        }
        if (e.fn === "insp.key") {
          // formatProperty's key arm over a RUNTIME string — bare
          // identifier, `['__proto__']`, or the quoting ladder. Never
          // throws.
          this.walkExpr(e.args[0]!);
          code.call(this.insp.key());
          return;
        }
        if (e.fn === "insp.dyn" || e.fn === "insp.dynS") {
          // The dyn walker (inspect.ts): the one runtime type whose shape
          // lives in the value, so the traversal is emitted code rather
          // than a synthesized helper. `dynS` is format's %s twin — a dyn
          // STRING passes verbatim there and quotes everywhere else.
          //
          // Both can throw: a PROMISE anywhere in the tree fences loudly
          // (S030), which is why the two are may-throw seeded and why the
          // site checks the cell.
          for (const a of e.args) this.walkExpr(a);
          code.call(e.fn === "insp.dyn" ? this.insp.dyn() : this.insp.dynS());
          this.emitPendingCheck();
          return;
        }
        if (e.fn === "insp.jsonDyn") {
          // util.format's %j over a dyn value: the stringify walk, with
          // the circular TypeError CAUGHT and answered "[Circular]" the
          // way Node's tryStringify does. A depth RangeError still
          // propagates, so the site checks the cell.
          this.walkExpr(e.args[0]!);
          code.call(this.json.formatJ());
          this.emitPendingCheck();
          return;
        }
        if (
          e.fn === "insp.begin" ||
          e.fn === "insp.entry" ||
          e.fn === "insp.end" ||
          e.fn === "insp.moreItems" ||
          e.fn === "insp.circCheck" ||
          e.fn === "insp.seenPush" ||
          e.fn === "insp.refWrap" ||
          e.fn === "insp.circular" ||
          e.fn === "insp.error"
        ) {
          // The LAYOUT engine (inspect.ts): the frame stack that
          // reduceToSingleString and groupArrayElements run over, the
          // circular quartet, and the error leaf. The frontend's
          // synthesized per-type helpers drive the whole protocol, so
          // these are plain calls with the arguments in IR order. None of
          // them throws.
          //
          // The circular trio takes an `eqref`: every GC struct and array
          // is a subtype, so a record, vector, map or class value passes
          // with no cast — identity is `ref.eq` on the value itself.
          for (const a of e.args) this.walkExpr(a);
          switch (e.fn) {
            case "insp.begin":
              code.call(this.insp.begin());
              return;
            case "insp.entry":
              code.call(this.insp.entry());
              return;
            case "insp.end":
              code.call(this.insp.end());
              return;
            case "insp.moreItems":
              code.call(this.insp.moreItems());
              return;
            case "insp.circCheck":
              code.call(this.insp.circCheck());
              return;
            case "insp.seenPush":
              code.call(this.insp.seenPush());
              return;
            case "insp.refWrap":
              code.call(this.insp.refWrap());
              return;
            case "insp.circular":
              code.call(this.insp.circular());
              return;
            default:
              code.call(this.insp.error());
              return;
          }
        }
        if (e.fn === "error.new") {
          // scr_error_new(kind, message), ported: the builtin instance —
          // class id and name off the static table, the message
          // evaluated, no %code. `new Error("...")`, the frontend's
          // lowering backstops, and throwing setters all mint this.
          const t = e.type;
          if (t.kind !== "object") throw new Error("emitter bug: error.new result is not a class");
          const rec = RUNTIME_ERROR_CLASSES.get(t.className);
          if (rec === undefined) throw new Error(`emitter bug: error.new of ${t.className}`);
          this.pushErrVt(t.className);
          this.pushStrLit(rec.lib);
          this.walkExpr(e.args[0]!);
          code.refNull(this.strType);
          code.structNew(this.exc().errT);
          return;
        }
        if (e.fn === "error.ctor") {
          // super(message) into the builtin base — scr_error_init, minus
          // the vt stamp: `new` already wrote the DERIVED class's vt, and
          // overwriting it with %Error's would erase the subclass. So
          // this is exactly the two field stores, name off the RECEIVER's
          // static builtin base (Node's rule: the class name is not the
          // name property — "Error" unless the constructor assigns one).
          const recvT = e.args[0]!.type;
          if (recvT.kind !== "object") throw new Error("emitter bug: error.ctor receiver is not a class");
          const info = this.classInfo(recvT.className, e.loc);
          if (info === null) {
            code.unreachable();
            return;
          }
          // The receiver arrives upcast to its builtin base, so that
          // base names which builtin name to stamp (the C emitter reads
          // the same field off the same static type).
          const rec = RUNTIME_ERROR_CLASSES.get(recvT.className);
          if (rec === undefined) throw new Error(`emitter bug: error.ctor on ${recvT.className}`);
          const ref = this.classes.ref(info);
          const o = this.acquireScratch(ref);
          this.walkExpr(e.args[0]!);
          code.localSet(o);
          code.localGet(o);
          this.pushStrLit(rec.lib);
          code.structSet(info.struct, 1);
          code.localGet(o);
          this.walkExpr(e.args[1]!);
          code.structSet(info.struct, 2);
          this.releaseScratch(ref, o);
          return;
        }
        if (e.fn === "class.name") {
          // `X.name` through a class value — the stored string, which is
          // NamedEvaluation's answer (the declared name, the binding name
          // for `const x = class {}`, "" for a truly anonymous one), not
          // the IR's program-qualified class name.
          const ct = e.args[0]!.type;
          if (ct.kind !== "classval") throw new Error("emitter bug: class.name on a non-classval");
          const cv = this.classValInfo(ct.className, e.loc, false);
          if (cv === null) {
            code.unreachable();
            return;
          }
          this.walkExpr(e.args[0]!);
          code.structGet(cv.objT, CLASSOBJ_NAME);
          return;
        }
        if (e.fn === "error.toString") {
          this.walkExpr(e.args[0]!);
          code.call(this.errToStrHelper());
          return;
        }
        if (e.fn === "json.parse") {
          // The parser returns normally with the cell set on a syntax
          // error (or the depth cap's RangeError), so the call site owns
          // the pending check — the walkers' discipline.
          this.walkExpr(e.args[0]!);
          code.call(this.json.parse());
          this.emitPendingCheck();
          return;
        }
        if (e.fn === "dyn.keySet") {
          // `d[k] = v` where the RECEIVER is the dynamic thing. The
          // helper throws Node's TypeErrors on the receivers that cannot
          // take a property, so the site owns a pending check.
          this.walkExpr(e.args[0]!);
          this.walkExpr(e.args[1]!);
          this.walkExpr(e.args[2]!);
          code.call(this.dyn.keySet());
          this.emitPendingCheck();
          return;
        }
        if (e.fn === "dyn.hasOwn") {
          this.walkExpr(e.args[0]!);
          this.walkExpr(e.args[1]!);
          code.call(this.dyn.hasOwn());
          this.emitPendingCheck();
          return;
        }
        if (e.fn === "dyn.objKeys" || e.fn === "dyn.objValues" || e.fn === "dyn.objEntries") {
          // One walk, three modes — the runtime's own shape
          // (scr_dyn_objwalk). Nullish receivers throw ToObject's
          // TypeError, so all three carry the pending check.
          this.walkExpr(e.args[0]!);
          code.i32Const(e.fn === "dyn.objKeys" ? 0 : e.fn === "dyn.objValues" ? 1 : 2);
          code.call(this.dyn.objWalk());
          this.emitPendingCheck();
          return;
        }
        if (e.fn === "dyn.assign") {
          this.walkExpr(e.args[0]!);
          this.walkExpr(e.args[1]!);
          code.call(this.dyn.assign());
          this.emitPendingCheck();
          return;
        }
        if (e.fn === "dyn.iterPack") {
          // The for-of / rest drain over a dyn source. The second
          // argument is the compile-time refusal text (empty where the
          // value's own kind wording is wanted instead).
          this.walkExpr(e.args[0]!);
          this.walkExpr(e.args[1]!);
          code.call(this.dyn.iterPack());
          this.emitPendingCheck();
          return;
        }
        if (e.fn === "dyn.arrLen") {
          // The pack's length and element reads: an ARR by construction
          // (the defensive arms in C cover nothing this lowering reaches).
          // Neither throws.
          this.walkExpr(e.args[0]!);
          // The box is already on the stack, so the payload cast and the
          // length read run over it in place (the no-op pusher).
          this.dyn.arrLen(code, (c) => this.dyn.arrPayload(c, () => {}));
          code.f64ConvertI32U();
          return;
        }
        if (e.fn === "dyn.arrAt") {
          const d = this.acquireScratch(this.dyn.arrRef());
          const x = this.acquireScratch(F64);
          this.walkExpr(e.args[0]!);
          this.dyn.arrPayload(code, () => {});
          code.localSet(d);
          this.walkExpr(e.args[1]!);
          code.localSet(x);
          // The RANGE test runs in f64 and the truncation only inside the
          // in-range arm: i32.trunc_f64_s TRAPS on a negative, fractional-
          // past-the-end or NaN index, where C answers the undefined
          // singleton. Both operands are pure compares on a local, so the
          // non-short-circuiting `and` is safe here.
          code.localGet(x);
          code.f64Const(0);
          code.f64Ge();
          code.localGet(x);
          this.dyn.arrLen(code, (c) => c.localGet(d));
          code.f64ConvertI32U();
          code.f64Lt();
          code.i32And();
          this.openIfResult(this.dyn.dynRef());
          this.dyn.arrAt(
            code,
            (c) => c.localGet(d),
            (c) => {
              c.localGet(x);
              c.i32TruncF64S();
            },
          );
          code.else_();
          code.globalGet(this.dyn.undefinedGlobal());
          this.close();
          this.releaseScratch(F64, x);
          this.releaseScratch(this.dyn.arrRef(), d);
          return;
        }
        if (e.fn === "dyn.typeof") {
          // Bare `typeof u` on a dyn value — scr_dyn_typeof's kind→string
          // table. (The COMPARED forms never arrive here: the frontend
          // folds `typeof u === "string"` into a dynTest.)
          this.walkExpr(e.args[0]!);
          code.call(this.dyn.typeOf());
          return;
        }
        if (this.emitTimerCall(e)) return;
        this.refuse(`libCall:${e.fn}`, e.loc);
        code.unreachable();
        return;

      /* The UTF-16-exact string method surface, direct over the faithful
       * (array i16) storage (strings.ts — scr_string.c's clamps with the
       * UTF-8 walking deleted). toLowerCase/toUpperCase refuse by MEMBER
       * (like libCall names its fn): ECMA Default Case Conversion wants
       * libunicode's tables, a separate rock. */
      case "strIntrinsic": {
        const m = e.method;
        if (m === "toLowerCase" || m === "toUpperCase") {
          this.refuse(`strIntrinsic:${m}`, e.loc);
          code.unreachable();
          return;
        }
        this.walkExpr(e.receiver);
        const argOr = (i: number, dflt: number): void => {
          const a = e.args[i];
          if (a !== undefined) this.walkExpr(a);
          else code.f64Const(dflt);
        };
        switch (m) {
          case "length":
            code.arrayLen();
            code.f64ConvertI32S();
            return;
          case "charCodeAt":
            this.walkExpr(e.args[0]!);
            code.call(this.strs.charCodeAt());
            return;
          case "charAt":
            this.walkExpr(e.args[0]!);
            code.call(this.strs.charAt());
            return;
          case "cpAt":
            this.walkExpr(e.args[0]!);
            code.call(this.strs.cpAt());
            return;
          case "indexOf":
            this.walkExpr(e.args[0]!);
            argOr(1, 0);
            code.call(this.strs.indexOf());
            return;
          case "includes":
            // The position form is indexOf's clamp exactly (the spec
            // routes both through StringIndexOf): found ⇔ index != -1.
            this.walkExpr(e.args[0]!);
            argOr(1, 0);
            code.call(this.strs.indexOf());
            code.f64Const(-1);
            code.f64Ne();
            return;
          case "startsWith":
            // The prefix match IS matchAt anchored at 0.
            this.walkExpr(e.args[0]!);
            code.i32Const(0);
            code.call(this.strs.matchAt());
            return;
          case "endsWith":
            this.walkExpr(e.args[0]!);
            code.call(this.strs.endsWith());
            return;
          case "slice":
            argOr(0, 0);
            argOr(1, Number.POSITIVE_INFINITY);
            code.call(this.strs.slice());
            return;
          case "substring":
            this.walkExpr(e.args[0]!);
            argOr(1, Number.POSITIVE_INFINITY);
            code.call(this.strs.substring());
            return;
          case "repeat":
            this.walkExpr(e.args[0]!);
            code.call(this.strs.repeat());
            return;
          case "trim":
            code.call(this.strs.trim("both"));
            return;
          case "trimStart":
            code.call(this.strs.trim("start"));
            return;
          case "trimEnd":
            code.call(this.strs.trim("end"));
            return;
          case "split":
            this.walkExpr(e.args[0]!);
            code.call(this.strs.split());
            return;
          case "padStart":
            this.walkExpr(e.args[0]!);
            this.walkExpr(e.args[1]!);
            code.i32Const(1);
            code.call(this.strs.pad());
            return;
          case "padEnd":
            this.walkExpr(e.args[0]!);
            this.walkExpr(e.args[1]!);
            code.i32Const(0);
            code.call(this.strs.pad());
            return;
          case "isWellFormed":
            code.call(this.strs.isWellFormed());
            return;
          case "toWellFormed":
            code.call(this.strs.toWellFormed());
            return;
          default: {
            const rest: never = m;
            void rest;
            this.refuse(`strIntrinsic:${String(m)}`, e.loc);
            code.unreachable();
            return;
          }
        }
      }

      /* Runtime tests on a catch binding: the primitive tests compare the
       * snapshot's kind tag (exactly what typeof observes); instanceof
       * tests an OBJ payload's class id against the BUILTIN error table —
       * the throw:class gate keeps every other class out of the cell, so
       * the id space is closed and %Error is simply "any OBJ". */
      case "caughtTest": {
        const exc = this.exc();
        if (e.test === "instanceof") {
          // ANY class: the test reads the interval the CELL recorded, so
          // it needs no struct and no vt — a standalone class answers
          // here exactly as a hierarchy member does.
          const meta = this.classes.meta(e.className ?? "");
          if (meta === undefined) {
            this.refuse(`caughtTest:instanceof:${e.className ?? "?"}`, e.loc);
            code.unreachable();
            return;
          }
          const c = this.acquireScratch(this.caughtRef());
          this.walkExpr(e.value);
          code.localSet(c);
          this.emitCaughtIsClass(meta, c);
          this.releaseScratch(this.caughtRef(), c);
          if (e.negated === true) code.i32Eqz();
          return;
        }
        this.walkExpr(e.value);
        code.structGet(exc.caughtT, 0);
        code.i32Const(e.test === "number" ? EXC_F64 : e.test === "boolean" ? EXC_BOOL : EXC_STR);
        if (e.negated === true) code.i32Ne();
        else code.i32Eq();
        return;
      }

      /* Checker-trusted payload extraction (the frontend emits it only
       * under a proven test, so the read is kind-unchecked — the caught
       * analog of unionNarrow). Any class extracts as its OWN struct: the
       * builtin errors share errT, everything else casts to its own, and
       * the guard that proved the class is what makes the cast honest. */
      case "caughtNarrow": {
        const exc = this.exc();
        const t = e.type;
        if (t.kind === "f64") {
          this.walkExpr(e.value);
          code.structGet(exc.caughtT, 1);
          return;
        }
        if (t.kind === "bool") {
          this.walkExpr(e.value);
          code.structGet(exc.caughtT, 1);
          code.f64Const(0);
          code.f64Ne();
          return;
        }
        if (t.kind === "string") {
          this.walkExpr(e.value);
          code.structGet(exc.caughtT, 2);
          code.refCast(this.strType);
          return;
        }
        if (t.kind === "object") {
          const info = this.classInfo(t.className, e.loc);
          if (info === null) {
            code.unreachable();
            return;
          }
          this.walkExpr(e.value);
          code.structGet(exc.caughtT, 2);
          code.refCast(info.struct);
          return;
        }
        // Every OBJECT narrowing is handled above, so what reaches here
        // is a payload kind with no catch-side representation at all.
        this.refuse(`caughtNarrow:${t.kind}`, e.loc);
        code.unreachable();
        return;
      }

      /* CHECKED payload extraction (`e as Error` — the `(e as Error).message`
       * idiom): the instanceof guard passes the payload through, every
       * other payload throws the catchable TypeError naming the class,
       * scr_caught_check_obj's message exactly (SEMANTICS.md S009 — Node
       * erases the cast). may-throw.ts seeds this node like a `throw`, so
       * the callers' pending checks come free. */
      case "caughtCheck": {
        const meta = this.classes.meta(e.className);
        const checked = this.classInfo(e.className, e.loc);
        if (meta === undefined || checked === null) {
          this.refuse("caughtCheck:class", e.loc);
          code.unreachable();
          return;
        }
        const exc = this.exc();
        const c = this.acquireScratch(this.caughtRef());
        this.walkExpr(e.value);
        code.localSet(c);
        this.emitCaughtIsClass(meta, c);
        this.openIfResult({ kind: "ref", nullable: true, typeIndex: checked.struct });
        // The interval guard just proved the class, so the cast is honest.
        code.localGet(c);
        code.structGet(exc.caughtT, 2);
        code.refCast(checked.struct);
        code.else_();
        this.emitSetCellErrorLit(
          "%TypeError",
          "TypeError",
          // The '%' prefix is on RUNTIME class names only — a user class
          // keeps its own spelling, and an unconditional strip ate its
          // first letter (the C emitter's conditional strip, ported).
          `caught value is not an instance of ${e.className.startsWith("%") ? e.className.slice(1) : e.className} (checked cast)`,
          null,
        );
        // The unwind leaves the arm unreachable — wasm's polymorphic
        // stack supplies the block's result type from here.
        this.emitUnwind();
        this.close();
        this.releaseScratch(this.caughtRef(), c);
        return;
      }

      /* Static → checked-dynamic conversion: the C emitter's per-type
       * to-dyn walkers (sc_td_N, emit-walkers.ts), SCALAR arms. C
       * allocates a node per conversion; here the box is a `struct.new`
       * and the two unit conversions are the interned immortals, so
       * `dynFrom(undefined)` — by far the commonest form, since every
       * uninitialized implicit-any `let` lowers to one — costs a single
       * `global.get`. Composite sources need the deep walkers and
       * function sources the per-signature call thunks; each refuses
       * under its OWN name so the census names the shape that is missing,
       * not just "dynFrom". */
      case "dynFrom": {
        const vt = e.value.type;
        switch (vt.kind) {
          case "f64":
            this.dyn.boxNum(code, () => this.walkExpr(e.value));
            return;
          case "bool":
            // A literal boxes to the interned instance: BOOL identity is
            // by VALUE (scr_dyn_strict_eq), so sharing is unobservable.
            if (e.value.kind === "boolLit") {
              code.globalGet(this.dyn.boolGlobal(e.value.value));
              return;
            }
            this.dyn.boxBool(code, () => this.walkExpr(e.value));
            return;
          case "string":
            this.dyn.boxStr(code, () => this.walkExpr(e.value));
            return;
          case "undefinedT":
          case "nullT": {
            // A unit VALUE is the literal and nothing else (nodes.ts: the
            // unit kinds live in union arms, and bare they are unitLit),
            // so there is no operand to evaluate — the conversion IS the
            // interned box. A unit-typed expression of any other shape
            // would have effects to run first, so it stays refused.
            if (e.value.kind !== "unitLit") {
              this.refuse(`dynFrom:${vt.kind}-expr`, e.loc);
              code.unreachable();
              return;
            }
            code.globalGet(vt.kind === "nullT" ? this.dyn.nullGlobal() : this.dyn.undefinedGlobal());
            return;
          }
          case "dyn":
            // Already dyn — the walkers' identity arm (a retain in C).
            this.walkExpr(e.value);
            return;
          case "object":
          case "record":
          case "array":
          case "union":
          case "promise": {
            // The composite conversion is a per-typeKey WALKER (the C
            // emitter's sc_td_N): a deep copy for the structured kinds, a
            // reference box for a promise, the `%error` encoding for an
            // error instance.
            const h = this.dynFromHelper(vt, e.loc);
            if (h === null) {
              code.unreachable();
              return;
            }
            this.walkExpr(e.value);
            code.call(h);
            return;
          }
          case "func": {
            // The function boundary, IN direction. The closure comes from
            // walking the VALUE — the interned per-function global, or a
            // capturing env's struct.new — and never from the calling
            // ABI's dead ref.null argument (the boundary section's
            // hazard: two boxes over a null closure compare EQUAL).
            const box = this.dynFnBox(vt, e.loc);
            if (box === null) {
              code.unreachable();
              return;
            }
            this.walkExpr(e.value);
            // The name for `f.name` and the error texts. SEMANTICS.md
            // S020: `fnName` is the spelling of the BINDING this box is
            // built from, not the function's defined name, so an ALIAS or
            // a factory result carries the wrong one — Node fixes a name
            // at definition and never re-infers it. An anonymous value
            // stores NULL rather than "" — keyGet is where the empty
            // string appears, at read time.
            if (e.fnName !== undefined && e.fnName !== "") this.pushStrLitInto(code, e.fnName);
            else code.refNull(this.strType);
            code.call(box);
            return;
          }
          default:
            this.refuse(`dynFrom:${vt.kind}`, e.loc);
            code.unreachable();
            return;
        }
      }

      /* CHECKED extraction from a dyn value (`u as number`): the C
       * emitter's per-type check walkers (sc_dc_N), SCALAR arms. The kind
       * must match EXACTLY — no coercions — and a mismatch renders
       * "expected <want> at <path>, got <kind>" and throws the catchable
       * TypeError (SEMANTICS.md S009: `as` erases in Node and validates on
       * every tsinter backend, so the failure texts have no oracle but the
       * C emitter's). may-throw.ts seeds this node like a `throw`, so the
       * callers' pending checks come free. */
      case "dynCheck": {
        const t = e.type;
        if (t.kind === "dyn") {
          // An `unknown` target (a dyn record field): the subtree passes
          // through unvalidated — nothing to check, nothing to build.
          this.walkExpr(e.value);
          return;
        }
        const want =
          t.kind === "f64" ? { desc: "number", kind: DK.NUM, val: F64 }
          : t.kind === "bool" ? { desc: "boolean", kind: DK.BOOL, val: I32 }
          : t.kind === "string" ? { desc: "string", kind: DK.STR, val: this.strRef }
          : null;
        if (want === null) {
          if (t.kind === "record" || t.kind === "array" || t.kind === "union" || t.kind === "func") {
            // The composite extraction is a per-typeKey WALKER (the C
            // emitter's sc_dc_N). It returns normally with the cell set on
            // failure — unlike the scalar path, which unwinds inline — so
            // the call site owns the pending check. A FUNC target rides
            // the same walker: it either unwraps the identical signature's
            // closure or mints the adapter, and only the kind guard throws.
            const h = this.dynCheckHelper(t, e.loc);
            if (h === null) {
              code.unreachable();
              return;
            }
            this.walkExpr(e.value);
            code.refNull(this.dyn.pathT()); // the ROOT path: `$`
            code.call(h);
            this.emitPendingCheck();
            return;
          }
          this.refuse(`dynCheck:${t.kind}`, e.loc);
          code.unreachable();
          return;
        }
        const dynT = this.dyn.dynT();
        const dynRef = this.dyn.dynRef();
        const d = this.acquireScratch(dynRef);
        this.walkExpr(e.value);
        code.localSet(d);
        code.localGet(d);
        code.structGet(dynT, DYN_KIND);
        code.i32Const(want.kind);
        code.i32Eq();
        this.openIfResult(want.val);
        code.localGet(d);
        if (t.kind === "string") {
          code.structGet(dynT, DYN_REF);
          code.refCast(this.strType);
        } else {
          code.structGet(dynT, DYN_NUM);
          if (t.kind === "bool") {
            code.f64Const(0);
            code.f64Ne();
          }
        }
        code.else_();
        // The ROOT path (`$`): a scalar target names the whole value.
        // Nested walkers push real path nodes (stage 2) — the type and
        // its renderer exist now so that the message grammar is settled
        // before anything builds one.
        code.refNull(this.dyn.pathT());
        this.pushStrLit(want.desc);
        code.localGet(d);
        code.call(this.dyn.checkFail());
        // The unwind leaves the arm unreachable — wasm's polymorphic
        // stack supplies the block's result type from here.
        this.emitUnwind();
        this.close();
        this.releaseScratch(dynRef, d);
        return;
      }

      /* The type-independent keyed read on a dyn value (`pkg.name`,
       * `pkg["k"]`, a `?.` chain step). A missing member answers THE
       * undefined immortal — JS's own-property answer, so prototype names
       * like `toString` read undefined too — while a nullish RECEIVER
       * throws Node's catchable TypeError naming the key, unless the step
       * is optional. may-throw.ts seeds this node, so the callers' pending
       * checks come free; the check here is for the throw inside. */
      case "dynKeyGet": {
        this.walkExpr(e.value);
        this.walkExpr(e.key);
        code.i32Const(e.optional === true ? 1 : 0);
        code.call(this.dyn.keyGet());
        this.emitPendingCheck();
        return;
      }

      /* `"k" in u`: a kind-guarded PRESENCE answer with the key known at
       * compile time, so the array arm folds to a constant or a single
       * length compare — the C emitter's inline lowering, one for one.
       * Nothing allocates and nothing throws (the `in` operator's own
       * TypeError on primitives is checker-unreachable: tsc admits `in`
       * only on object-typed operands). A member holding undefined still
       * answers true — the tree stores presence — and an INHERITED name
       * answers false, which is SEMANTICS.md S015's stance reaching the
       * presence operator. */
      case "dynHasKey": {
        const d = this.acquireScratch(this.dyn.dynRef());
        this.walkExpr(e.value);
        code.localSet(d);
        code.localGet(d);
        code.structGet(this.dyn.dynT(), DYN_KIND);
        code.i32Const(DK.OBJ);
        code.i32Eq();
        this.openIfResult(I32);
        this.dyn.objPayload(code, (c) => c.localGet(d));
        this.pushStrLit(e.key);
        code.call(this.dyn.objGet());
        code.refIsNull();
        code.i32Eqz();
        code.else_();
        // The FUNC arm, which the C emitter's inline lowering lacks: a
        // boxed function owns exactly `name` and `length` — keyGet's arm
        // and hasOwn's, asked a third way. Answering false for them would
        // contradict S015's own rule (the presence operator answers like
        // the own-member read) at the one kind whose members the runtime
        // models; `"call" in f` still answers false, because `call` is
        // INHERITED, which is what S015 actually registers.
        const pushFuncArm = (): void => {
          if (e.key !== "name" && e.key !== "length") {
            code.i32Const(0);
            return;
          }
          code.localGet(d);
          code.structGet(this.dyn.dynT(), DYN_KIND);
          code.i32Const(DK.FUNC);
          code.i32Eq();
        };
        // The ARRAY arm: "length" is always there, a canonical index is
        // there when it is in range, and no other spelling ever is.
        const arrIdx = /^(0|[1-9][0-9]*)$/.test(e.key) ? Number(e.key) : null;
        if (e.key !== "length" && (arrIdx === null || arrIdx > Number.MAX_SAFE_INTEGER)) {
          pushFuncArm();
        } else {
          code.localGet(d);
          code.structGet(this.dyn.dynT(), DYN_KIND);
          code.i32Const(DK.ARR);
          code.i32Eq();
          this.openIfResult(I32);
          if (e.key === "length") {
            code.i32Const(1);
          } else {
            this.dyn.arrLen(code, (c) => this.dyn.arrPayload(c, (x) => x.localGet(d)));
            code.f64ConvertI32U();
            code.f64Const(arrIdx!);
            code.f64Gt();
          }
          code.else_();
          pushFuncArm();
          this.close();
        }
        this.close();
        if (e.negated === true) code.i32Eqz();
        this.releaseScratch(this.dyn.dynRef(), d);
        return;
      }

      /* Strict equality where at least one side is dyn. Both operands
       * evaluate in SOURCE order (JS's), the dyn side is found by TYPE,
       * and the compare is a kind test plus a payload compare — f64.eq
       * for numbers (NaN false, ±0 equal, both JS-exact), content for
       * strings. Two dyn operands run the whole-dyn equality instead
       * (scalars by value, units by kind, the reference kinds by node
       * identity). Nothing allocates, nothing throws. */
      case "dynScalarEq": {
        const dynLeft = e.left.type.kind === "dyn";
        const scalarT = dynLeft ? e.right.type : e.left.type;
        const st = scalarT.kind === "dyn" ? "dyn" : scalarT.kind;
        const sType = st === "f64" ? F64 : st === "bool" ? I32 : st === "string" ? this.strRef : this.dyn.dynRef();
        const d = this.acquireScratch(this.dyn.dynRef());
        const s = this.acquireScratch(sType);
        // Source order: whichever side is written first is evaluated
        // first, and only then does the compare pick them apart.
        this.walkExpr(e.left);
        code.localSet(dynLeft ? d : s);
        this.walkExpr(e.right);
        code.localSet(dynLeft ? s : d);
        if (st === "dyn") {
          code.localGet(dynLeft ? d : s);
          code.localGet(dynLeft ? s : d);
          code.call(this.dyn.strictEq());
        } else {
          const kind = st === "f64" ? DK.NUM : st === "bool" ? DK.BOOL : DK.STR;
          code.localGet(d);
          code.structGet(this.dyn.dynT(), DYN_KIND);
          code.i32Const(kind);
          code.i32Eq();
          this.openIfResult(I32);
          if (st === "f64") {
            code.localGet(d);
            code.structGet(this.dyn.dynT(), DYN_NUM);
            code.localGet(s);
            code.f64Eq();
          } else if (st === "bool") {
            code.localGet(d);
            code.structGet(this.dyn.dynT(), DYN_NUM);
            code.f64Const(0);
            code.f64Ne();
            code.localGet(s);
            code.i32Eq();
          } else {
            code.localGet(d);
            code.structGet(this.dyn.dynT(), DYN_REF);
            code.refCast(this.strType);
            code.localGet(s);
            code.call(this.strEqHelper());
          }
          code.else_();
          code.i32Const(0);
          this.close();
        }
        if (e.negated === true) code.i32Eqz();
        this.releaseScratch(sType, s);
        this.releaseScratch(this.dyn.dynRef(), d);
        return;
      }

      /* RequireObjectCoercible with V8's destructuring TypeError. Both
       * halves of the message are compile-time (the SOURCE spelling of
       * the receiver, and the pattern's first property when there is
       * one); only the "undefined."/"null." tail is a runtime choice, so
       * the two whole strings intern as literals and the kind picks. The
       * value passes through unchanged. */
      case "dynDestrCheck": {
        if (e.value.type.kind !== "dyn") {
          // The island's prelude guard is engine-thrown; its value is a
          // jsval, which has no representation on this backend.
          this.refuse(`dynDestrCheck:${e.value.type.kind}`, e.loc);
          code.unreachable();
          return;
        }
        const head =
          e.firstProp === undefined
            ? `Cannot destructure '${e.spelling}' as it is `
            : `Cannot destructure property '${e.firstProp}' of '${e.spelling}' as it is `;
        const d = this.acquireScratch(this.dyn.dynRef());
        this.walkExpr(e.value);
        code.localTee(d);
        code.structGet(this.dyn.dynT(), DYN_KIND);
        const k = this.acquireScratch(I32);
        code.localTee(k);
        code.i32Const(DK.UNDEF);
        code.i32Eq();
        code.localGet(k);
        code.i32Const(DK.NULL);
        code.i32Eq();
        code.i32Or();
        this.openIf();
        code.localGet(k);
        code.i32Const(DK.UNDEF);
        code.i32Eq();
        this.openIfResult(this.strRef);
        this.pushStrLit(`${head}undefined.`);
        code.else_();
        this.pushStrLit(`${head}null.`);
        this.close();
        const msg = this.acquireScratch(this.strRef);
        code.localSet(msg);
        this.emitSetCellError(code, "%TypeError", "TypeError", (c) => c.localGet(msg), null);
        this.emitUnwind();
        this.releaseScratch(this.strRef, msg);
        this.close();
        code.localGet(d);
        this.releaseScratch(I32, k);
        this.releaseScratch(this.dyn.dynRef(), d);
        return;
      }

      /* GetIterator plus the first N steps, as array destructuring sees
       * it: a fresh dyn array of exactly `count` elements, undefined past
       * the end. The empty pattern passes 0 and keeps only the
       * validation. Non-iterables throw V8's wording. */
      case "dynIterN": {
        if (e.value.type.kind !== "dyn") {
          // An island source runs the ENGINE's iterator protocol.
          this.refuse(`dynIterN:${e.value.type.kind}`, e.loc);
          code.unreachable();
          return;
        }
        this.walkExpr(e.value);
        code.i32Const(e.count);
        code.call(this.dyn.iterN());
        this.emitPendingCheck();
        return;
      }

      /* The JS-lane dyn LITERALS: a mixed-element array and an object
       * whose keys may be runtime values. Both build the tree directly —
       * their elements and values are already dyn, so there is no
       * conversion, only construction. Neither throws. */
      case "dynArrLit": {
        const a = this.acquireScratch(this.dyn.arrRef());
        code.f64Const(0);
        code.call(this.vecs.newLen(this.dynVecInfo()));
        code.localSet(a);
        for (const el of e.elems) {
          code.localGet(a);
          this.walkExpr(el);
          code.call(this.dyn.arrPush());
        }
        this.dyn.boxArr(code, (c) => c.localGet(a));
        this.releaseScratch(this.dyn.arrRef(), a);
        return;
      }

      case "dynObjLit": {
        const o = this.acquireScratch(this.dyn.objRef());
        this.dyn.pushNewObj(code, false);
        code.localSet(o);
        // Entries evaluate KEY then VALUE in SOURCE order (JS's
        // object-literal evaluation order); later duplicate keys win,
        // which is objPut's own rule.
        for (const f of e.fields ?? []) {
          code.localGet(o);
          this.walkExpr(f.key);
          this.walkExpr(f.value);
          code.call(this.dyn.objPut());
        }
        this.dyn.boxObj(code, (c) => c.localGet(o));
        this.releaseScratch(this.dyn.objRef(), o);
        return;
      }

      /* CALLING a dyn value. The callee expression evaluates first, then
       * the arguments in source order — and only THEN is the callee
       * tested for callability, which is what puts Node's "<name> is not
       * a function" after the arguments' side effects (nodes.ts spells
       * the same order out). Arguments are already dyn (the lowering
       * boxed or converted them), so the vector is a plain push loop;
       * EXTRA arguments ride it and the thunk simply never reads them,
       * which is JS arity from the caller's side. may-throw.ts seeds this
       * node, so the pending check below is the whole family: the
       * not-a-function TypeError, the thunk's per-argument checks, and
       * whatever the called closure itself throws. */
      case "dynCall": {
        if (e.spreads !== undefined && e.spreads.length > 0) {
          // `f(...args)` applies through a runtime-built argument list,
          // and building one means FLATTENING each spread source —
          // arrays element-wise, strings by code point, bytes by byte,
          // V8's spread-call TypeError for every other kind
          // (scr_dyn_arr_push_spread). That is the iteration surface, a
          // rock of its own; refusing by name beats half of it.
          this.refuse("dynCall:spread", e.loc);
          code.unreachable();
          return;
        }
        const dynRef = this.dyn.dynRef();
        const arrRef = this.dyn.arrRef();
        const d = this.acquireScratch(dynRef);
        const a = this.acquireScratch(arrRef);
        this.walkExpr(e.callee);
        code.localSet(d);
        code.f64Const(0);
        code.call(this.vecs.newLen(this.dynVecInfo()));
        code.localSet(a);
        for (const arg of e.args) {
          code.localGet(a);
          this.walkExpr(arg);
          code.call(this.dyn.arrPush());
        }
        code.localGet(d);
        code.localGet(a);
        this.pushStrLitInto(code, e.calleeName);
        code.call(this.dyn.callFn());
        this.releaseScratch(arrRef, a);
        this.releaseScratch(dynRef, d);
        this.emitPendingCheck();
        return;
      }

      /* Prototype-method DISPATCH on a dyn receiver — the same argument
       * vector `dynCall` builds, handed to the per-METHOD helper that
       * dispatches on the receiver's runtime kind (dyn.ts's invoke
       * section holds the ladder). Evaluation order is the receiver, then
       * the arguments in source order, then the dispatch — JS's, with one
       * test hoisted out of the helper to keep it so: a NULLISH receiver
       * throws at the MEMBER GET, which happens before a single argument
       * is evaluated, so `nul.push(f())` must not run `f`. The helper
       * keeps the same rung as its own first step for any other caller.
       * may-throw.ts seeds this node, so the pending checks cover the
       * whole family — the nullish read, the is-not-a-function refusals,
       * an argument fence, a callback's own throw. */
      case "dynInvoke": {
        if (PROMISE_REACTION_METHODS.has(e.method)) {
          // `then`/`catch`/`finally` on a dyn receiver: a PROMISE box is
          // constructible here (dynFrom boxes one by reference), and its
          // reaction trio rides the fiber machinery rather than anything
          // in the dyn surface. Refusing by name beats a helper whose
          // PROMISE arm would have to lie.
          this.refuse(`dynInvoke:${e.method}`, e.loc);
          code.unreachable();
          return;
        }
        const dynRef = this.dyn.dynRef();
        const arrRef = this.dyn.arrRef();
        const d = this.acquireScratch(dynRef);
        const a = this.acquireScratch(arrRef);
        this.walkExpr(e.recv);
        code.localSet(d);
        code.localGet(d);
        code.call(this.dyn.nullishRecv(e.method));
        this.emitPendingCheck();
        code.f64Const(0);
        code.call(this.vecs.newLen(this.dynVecInfo()));
        code.localSet(a);
        for (const arg of e.args) {
          code.localGet(a);
          this.walkExpr(arg);
          code.call(this.dyn.arrPush());
        }
        code.localGet(d);
        code.localGet(a);
        this.pushStrLitInto(code, e.calleeName);
        code.call(this.dyn.invoke(e.method));
        this.releaseScratch(arrRef, a);
        this.releaseScratch(dynRef, d);
        this.emitPendingCheck();
        return;
      }

      /* A catch binding flowing into an `unknown` slot: the exception
       * snapshot's RUNTIME kind decides, `sc_cd`'s ladder ported. Scalars
       * convert exactly; an Error-family payload becomes the `%error`
       * encoding through the identity cache, so one error crossing twice
       * is one JS value; a thrown DYN value passes back BY REFERENCE (the
       * traced-throw shape — identity with every other holder); and every
       * remaining payload becomes an EMPTY object, the documented
       * approximation. Never throws. */
      case "caughtToDyn": {
        const exc = this.exc();
        const dynRef = this.dyn.dynRef();
        const c = this.acquireScratch(this.caughtRef());
        this.walkExpr(e.value);
        code.localSet(c);
        const k = this.acquireScratch(I32);
        code.localGet(c);
        code.structGet(exc.caughtT, 0);
        code.localSet(k);
        const kindIs = (tag: number): void => {
          code.localGet(k);
          code.i32Const(tag);
          code.i32Eq();
        };
        kindIs(EXC_F64);
        code.ifResult(dynRef);
        this.dyn.boxNum(code, (x) => {
          x.localGet(c);
          x.structGet(exc.caughtT, 1);
        });
        code.else_();
        kindIs(EXC_BOOL);
        code.ifResult(dynRef);
        // The cell widens a bool into the f64 slot; the box narrows it
        // back, exactly as `emitThrowValue` widened it.
        this.dyn.boxBool(code, (x) => {
          x.localGet(c);
          x.structGet(exc.caughtT, 1);
          x.f64Const(0);
          x.f64Ne();
        });
        code.else_();
        kindIs(EXC_STR);
        code.ifResult(dynRef);
        this.dyn.boxStr(code, (x) => {
          x.localGet(c);
          x.structGet(exc.caughtT, 2);
          x.refCast(this.strType);
        });
        code.else_();
        // An OBJ payload inside %Error's interval — a builtin or any
        // class rooted in one, both of which read their name/message
        // through errT's slots.
        code.localGet(k);
        code.i32Const(EXC_OBJ);
        code.i32Eq();
        code.ifResult(I32);
        code.localGet(c);
        code.structGet(exc.caughtT, 3);
        this.emitErrIntervalTest(code);
        code.else_();
        code.i32Const(0);
        code.end();
        code.ifResult(dynRef);
        code.localGet(c);
        code.structGet(exc.caughtT, 2);
        code.refCast(exc.errT);
        code.call(this.dyn.fromError());
        code.else_();
        // A thrown dyn value comes back as ITSELF. C tests the payload's
        // retain function; the GC type test asks the same question.
        code.localGet(c);
        code.structGet(exc.caughtT, 2);
        code.refTest(this.dyn.dynT());
        code.ifResult(dynRef);
        code.localGet(c);
        code.structGet(exc.caughtT, 2);
        code.refCast(this.dyn.dynT());
        code.else_();
        // Records, arrays, closures, unions and non-error classes are
        // type-erased in the cell, so there is nothing to walk: the
        // EMPTY object approximation, SEMANTICS.md S022.
        this.dyn.boxObj(code, (x) => this.dyn.pushNewObj(x, false));
        code.end();
        code.end();
        code.end();
        code.end();
        code.end();
        this.releaseScratch(I32, k);
        this.releaseScratch(this.caughtRef(), c);
        return;
      }

      /* Kind tests on a dyn value (`typeof u === "string"`,
       * `Array.isArray(u)`, `if (u)`): inline compares on the tag —
       * nothing allocates and nothing can throw. A passing test does NOT
       * license an unchecked payload read: the frontend still emits a
       * dynCheck for the narrowed read (nodes.ts's trust-but-VERIFY
       * stance, deliberately unlike unionNarrow). */
      case "dynTest": {
        if (e.test === "error") {
          // `u instanceof Error` is the dyn tree's reserved "%error"
          // object encoding and nothing else — the marker's presence IS
          // the test (nodes.ts), because only caughtToDyn and the
          // error-rooted dynFrom mint one.
          this.walkExpr(e.value);
          code.call(this.dyn.isError());
          if (e.negated === true) code.i32Eqz();
          return;
        }
        if (e.test === "truthy") {
          this.walkExpr(e.value);
          code.call(this.dyn.truthy());
          if (e.negated === true) code.i32Eqz();
          return;
        }
        const kinds = DYN_TEST_KINDS[e.test];
        this.walkExpr(e.value);
        code.structGet(this.dyn.dynT(), DYN_KIND);
        if (kinds.length === 1) {
          code.i32Const(kinds[0]!);
          if (e.negated === true) code.i32Ne();
          else code.i32Eq();
          return;
        }
        const k = this.acquireScratch(I32);
        code.localSet(k);
        kinds.forEach((want, i) => {
          code.localGet(k);
          code.i32Const(want);
          code.i32Eq();
          if (i > 0) code.i32Or();
        });
        this.releaseScratch(I32, k);
        if (e.negated === true) code.i32Eqz();
        return;
      }

      /* Field reads. On the builtin errors `name` and `message` are the
       * shared errT's own slots (`%code` never reaches a fieldGet — its
       * read is the error.code libCall's `string | undefined` lowering);
       * on an emitted class it is the flattened field's own slot, past
       * the vt word on hierarchy members. */
      case "fieldGet": {
        if (RUNTIME_ERROR_CLASSES.has(e.className)) {
          const slot = e.field === "name" ? 1 : e.field === "message" ? 2 : 0;
          if (slot === 0) {
            this.refuse(`fieldGet:error:${e.field}`, e.loc);
            code.unreachable();
            return;
          }
          this.walkExpr(e.obj);
          code.structGet(this.exc().errT, slot);
          return;
        }
        const field = this.classField(e.className, e.field, e.loc);
        if (field === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.obj);
        code.structGet(field.info.struct, field.index);
        return;
      }

      /* Widening is subsumption and narrowing is `ref.cast`: emitted
       * classes are wasm subtypes along the source hierarchy, so an
       * upcast has literally nothing to emit and a downcast — which the
       * checker has already proven, so it cannot fail on a valid program
       * — only re-types. Between builtin errors ONE struct covers the
       * whole hierarchy, so both directions are the identical value.
       * Mixing the two families is the error unification's work. */
      case "upcast":
      case "downcast": {
        const from = e.value.type;
        const to = e.type;
        if (to.kind === "classval" && from.kind === "classval") {
          // A class VALUE widens without changing: the classobj struct is
          // keyed by (hierarchy root, constructor ABI), and the
          // validator's rule for this upcast — strict descendant with an
          // equal completed ABI — is exactly what keeps both ends on one
          // key. So this is type-only in the source and a no-op here.
          const toCv = this.classValInfo(to.className, e.loc, false);
          const fromCv = this.classValInfo(from.className, e.loc, false);
          if (toCv === null || fromCv === null) {
            code.unreachable();
            return;
          }
          if (toCv.objT !== fromCv.objT) {
            // Would be a silent bad store; the keying invariant broke.
            throw new Error(
              `wasm emitter bug: classval ${e.kind} ${from.className}→${to.className} crosses class-object types`,
            );
          }
          this.walkExpr(e.value);
          return;
        }
        if (to.kind !== "object" || from.kind !== "object") {
          this.refuse(`expr:${e.kind}`, e.loc);
          code.unreachable();
          return;
        }
        if (RUNTIME_ERROR_CLASSES.has(to.className) && RUNTIME_ERROR_CLASSES.has(from.className)) {
          this.walkExpr(e.value);
          return;
        }
        const toInfo = this.classInfo(to.className, e.loc);
        const fromInfo = this.classInfo(from.className, e.loc);
        if (toInfo === null || fromInfo === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.value);
        if (e.kind === "downcast") code.refCast(toInfo.struct);
        return;
      }

      /* `obj.n++` — read, write ±1, yield old (postfix) or new (prefix),
       * the incDec discipline over a struct slot. The receiver evaluates
       * ONCE (JS's MemberExpression evaluation), so it is parked in a
       * local rather than walked twice. */
      case "fieldIncDec": {
        if (e.fieldDyn) {
          // A computed member target (`obj[k]++`) rides the dyn surface.
          this.refuse("expr:fieldIncDec:dyn", e.loc);
          code.unreachable();
          return;
        }
        if (RUNTIME_ERROR_CLASSES.has(e.className)) {
          this.refuse("expr:fieldIncDec:error", e.loc);
          code.unreachable();
          return;
        }
        const field = this.classField(e.className, e.field, e.loc);
        if (field === null) {
          code.unreachable();
          return;
        }
        if (field.type.kind !== "f64") {
          this.refuse(`expr:fieldIncDec:${field.type.kind}`, e.loc);
          code.unreachable();
          return;
        }
        const objRef = this.classes.ref(field.info);
        const o = this.acquireScratch(objRef);
        const old = this.acquireScratch(F64);
        const next = this.acquireScratch(F64);
        this.walkExpr(e.obj);
        code.localSet(o);
        code.localGet(o);
        code.structGet(field.info.struct, field.index);
        code.localSet(old);
        code.localGet(o);
        code.localGet(old);
        code.f64Const(1);
        if (e.op === "+") code.f64Add();
        else code.f64Sub();
        code.localTee(next);
        code.structSet(field.info.struct, field.index);
        code.localGet(e.prefix ? next : old);
        this.releaseScratch(F64, next);
        this.releaseScratch(F64, old);
        this.releaseScratch(objRef, o);
        return;
      }

      /* `new C(args)`: one struct.new with every operand explicit — the
       * class's interval global into `vt` on a hierarchy member, then a
       * zero per field, EXCEPT undefined-admitting union fields, which
       * start at the interned undefined arm because that is what JS reads
       * back from an uninitialized field and a base constructor can
       * observe one before the derived class assigns it. Then the
       * constructor over the fresh ref (uniform ABI: null closure,
       * `this` as the first declared param), with the standard
       * pending-check-after-call. The ref is parked in a local because
       * wasm has no way to duplicate a stack value. */
      case "new": {
        if (RUNTIME_ERROR_CLASSES.has(e.className)) {
          // `new Error(...)` reaches the emitter as an error.* libCall;
          // a raw `new` on a builtin means a shape that lowering missed.
          this.refuse("new:error", e.loc);
          code.unreachable();
          return;
        }
        const info = this.classInfo(e.className, e.loc);
        if (info === null) {
          code.unreachable();
          return;
        }
        const objRef = this.classes.ref(info);
        const o = this.acquireScratch(objRef);
        this.emitAlloc(code, e.className, info);
        code.localSet(o);
        const ctor = this.ctorOf(e.className);
        code.refNull(this.fnClosPair(ctor.fn).clos);
        code.localGet(o);
        for (const a of e.args) this.walkExpr(a);
        code.call(ctor.index);
        if (this.mayThrow.has(ctor.name)) this.emitPendingCheck();
        code.localGet(o);
        this.releaseScratch(objRef, o);
        return;
      }

      /* `x instanceof C` — the O(1) PREORDER-INTERVAL test, the C and LLVM
       * lanes' `vt->pre >= C.pre && vt->pre <= C.post` ported instruction
       * for instruction. The instance carries its class's interval in the
       * vt field every hierarchy member has at slot 0; C's interval is a
       * whole-program constant, so both bounds inline. Preorder numbering
       * is what makes one range test answer for a whole subtree — and it
       * is why the numbering is IMPORTED rather than re-derived (a family
       * class's interval spans its generic instantiations, so
       * `boxOfNumbers instanceof Box` is true here exactly as in Node).
       *
       * Deliberately NOT null-checked: `vt` is stamped by struct.new and
       * immutable, and a class-typed value is never null — null and
       * undefined ride unions, which narrow before any instanceof. A null
       * receiver would trap on the struct.get rather than answer false,
       * which is the honest failure if that invariant ever breaks.
       *
       * Builtin errors take this same path: their class id became a vt,
       * so `e instanceof TypeError` and `e instanceof AppError` are one
       * mechanism — which is the whole point of the unification, since an
       * id compare could never have recognised a user subclass.
       * Statically-decided cases are folded by the frontend, so only real
       * tests arrive; the operand still evaluates for its effects. */
      case "instanceOf": {
        const v = e.value.type;
        if (v.kind !== "object") {
          this.refuse("expr:instanceOf", e.loc);
          code.unreachable();
          return;
        }
        const info = this.classInfo(v.className, e.loc);
        const target = this.classInfo(e.className, e.loc);
        if (info === null || target === null) {
          code.unreachable();
          return;
        }
        if (!info.meta.hierarchy) {
          // A standalone class has exactly one possible runtime class, so
          // the frontend folds the test instead of emitting it — and the
          // operand has no vt to read. Reaching here means it did not.
          throw new Error(`wasm emitter bug: instanceOf on standalone class ${v.className}`);
        }
        const pre = this.acquireScratch(I32);
        this.walkExpr(e.value);
        code.structGet(info.struct, CLASS_VT);
        // Through the SUBTYPE: a slotted hierarchy stamps $vtt_<root>
        // here, whose first two fields repeat $ci's head, so the interval
        // read is the same instruction either way.
        code.structGet(this.classes.ci(), CI_PRE);
        code.localTee(pre);
        code.i32Const(target.meta.pre);
        code.i32GeS();
        code.localGet(pre);
        code.i32Const(target.meta.post);
        code.i32LeS();
        code.i32And();
        this.releaseScratch(I32, pre);
        return;
      }

      /* The class itself as a value: its immortal class object. */
      case "classRef": {
        if (!this.emitClassObj(e.className, e.loc)) code.unreachable();
        return;
      }

      /* `new X(args)` through a class VALUE: the class object's construct
       * thunk. The thunk answers with the hierarchy ROOT's struct — one
       * type for every class the value could hold — so the result casts
       * back down to this site's own static class, which is honest
       * because a classval only ever holds that class or a descendant
       * (the upcast rule the validator enforces). */
      case "newValue": {
        const ct = e.callee.type;
        const rt = e.type;
        if (ct.kind !== "classval" || rt.kind !== "object") {
          this.refuse("expr:newValue", e.loc);
          code.unreachable();
          return;
        }
        const cv = this.classValInfo(ct.className, e.loc, false);
        const resultInfo = this.classInfo(rt.className, e.loc);
        if (cv === null || resultInfo === null) {
          code.unreachable();
          return;
        }
        const objRef: ValType = { kind: "ref", nullable: true, typeIndex: cv.objT };
        const o = this.acquireScratch(objRef);
        this.walkExpr(e.callee);
        code.localSet(o);
        code.refNull(cv.thunk.clos);
        for (const a of e.args) this.walkExpr(a);
        code.localGet(o);
        code.structGet(cv.objT, CLASSOBJ_CTOR);
        code.callRef(cv.thunk.fn);
        code.refCast(resultInfo.struct);
        this.releaseScratch(objRef, o);
        // The dynamic constructor is unknown here, so may-throw.ts covers
        // the whole subtree and the check keys on any of them throwing.
        if (this.newValueMayThrow(ct.className)) this.emitPendingCheck();
        return;
      }

      /* `x instanceof X` with a class VALUE on the right: the same
       * interval containment as the static form, except the target's
       * bounds are READ off the class object instead of inlined — which
       * is what $ci's `post` exists for. */
      case "instanceOfValue": {
        const vt = e.value.type;
        const ct = e.classValue.type;
        if (vt.kind !== "object" || ct.kind !== "classval") {
          this.refuse("expr:instanceOfValue", e.loc);
          code.unreachable();
          return;
        }
        const info = this.classInfo(vt.className, e.loc);
        const cv = this.classValInfo(ct.className, e.loc, false);
        if (info === null || cv === null) {
          code.unreachable();
          return;
        }
        if (!info.meta.hierarchy) {
          throw new Error(`wasm emitter bug: instanceOfValue on standalone class ${vt.className}`);
        }
        const objRef: ValType = { kind: "ref", nullable: true, typeIndex: cv.objT };
        const t = this.acquireScratch(objRef);
        const pre = this.acquireScratch(I32);
        this.walkExpr(e.value);
        code.structGet(info.struct, CLASS_VT);
        code.structGet(this.classes.ci(), CI_PRE);
        code.localSet(pre);
        this.walkExpr(e.classValue);
        code.localSet(t);
        code.localGet(pre);
        code.localGet(t);
        code.structGet(cv.objT, CI_PRE);
        code.i32GeS();
        code.localGet(pre);
        code.localGet(t);
        code.structGet(cv.objT, CI_POST);
        code.i32LeS();
        code.i32And();
        this.releaseScratch(I32, pre);
        this.releaseScratch(objRef, t);
        return;
      }

      /* A call that must dispatch on the receiver's DYNAMIC class. The
       * slot lives on the method's root-most declaring class — an
       * ancestor of the static receiver, found by the same interval
       * containment the C emitter uses — and the vtable the instance
       * carries holds one funcref per slot of its ROOT's slot list.
       *
       * The receiver evaluates ONCE and is read twice (as the `this`
       * argument and to reach the vtable), so it parks in a local. It
       * needs no upcast: the slot's `this` is the declarer's, and wasm
       * subsumption already lets a narrower reference stand there.
       *
       * The vt is not null-checked, for instanceOf's reason: struct.new
       * stamps it and the field is immutable. The ref.cast to the root's
       * vtable would trap on a null vt rather than answer wrongly, which
       * is the honest failure. */
      case "virtualCall": {
        const info = this.classInfo(e.className, e.loc);
        if (info === null) {
          code.unreachable();
          return;
        }
        const meta = info.meta;
        const slots = meta.root.slots;
        const slotIndex = slots.findIndex(
          (s) => s.method === e.method && s.declarer.pre <= meta.pre && meta.pre <= s.declarer.post,
        );
        const slot = slots[slotIndex];
        if (slot === undefined) {
          throw new Error(`wasm emitter bug: no vtable slot for ${e.className}.${e.method}`);
        }
        const recv = e.args[0];
        if (recv === undefined) throw new Error(`wasm emitter bug: virtualCall ${e.method} without a receiver`);
        const pair = this.vtSlotPair(slot);
        const vtt = this.classes.vttType(meta.root);
        const recvRef = this.classes.ref(info);
        const r = this.acquireScratch(recvRef);
        this.walkExpr(recv);
        code.localSet(r);
        code.refNull(pair.clos); // the uniform ABI's dead closure argument
        code.localGet(r);
        for (const a of e.args.slice(1)) this.walkExpr(a);
        code.localGet(r);
        code.structGet(info.struct, CLASS_VT);
        code.refCast(vtt);
        code.structGet(vtt, VTT_SLOT0 + slotIndex);
        code.callRef(pair.fn);
        this.releaseScratch(recvRef, r);
        if (this.mayThrowMethods.has(e.method)) this.emitPendingCheck();
        return;
      }

      case "jsonStringify": {
        // Type-directed serialization: the STATIC type picks the walker,
        // interned per type — no dynamic dispatch anywhere. A dyn ROOT is
        // the one shape with no static type to direct it, and takes the
        // runtime walk instead: the tree's own kinds drive it, it can
        // throw (the depth cap, S026), and so the site checks the cell.
        if (e.value.type.kind === "dyn") {
          this.walkExpr(e.value);
          code.call(this.json.stringifyDyn());
          this.emitPendingCheck();
          this.emitJsonIndent(e);
          return;
        }
        const helper = this.jsonWriteHelper(e.value.type, e.loc);
        const val = this.mapType(e.value.type, e.loc);
        if (helper === null || val === null) {
          code.unreachable();
          return;
        }
        // The value is evaluated FIRST (JS order) and parked, so the
        // buffer prologue sits immediately before this walk — a nested
        // `JSON.stringify` inside the argument then finishes, and resets
        // the buffer, strictly before the prologue rather than after it.
        const v = this.acquireScratch(val);
        this.walkExpr(e.value);
        code.localSet(v);
        code.call(this.json.jbBegin());
        code.localGet(v);
        code.call(helper);
        this.releaseScratch(val, v);
        code.call(this.json.jbFinish());
        // Any COMPOSITE root gets the check, deliberately without asking
        // whether this particular one can throw. The finer question —
        // "can the walk reach a cycle-capable container?" — is not
        // `jsonCyclic(root)`: a root that merely CONTAINS a cyclic type
        // without being reachable from itself throws through a nested
        // walker while answering false here, and the missing check turns
        // a pending TypeError into a garbage string (then an unreachable
        // trap downstream). C asks the reachability version of the
        // question; the branch is available if it ever matters, but a
        // hand-maintained predicate is exactly what just went wrong, and
        // may-throw.ts seeds this node at KIND level for the same reason
        // — a never-taken check costs one flag read.
        const rootKind = e.value.type.kind;
        if (rootKind === "record" || rootKind === "array" || rootKind === "union") {
          this.emitPendingCheck();
        }
        this.emitJsonIndent(e);
        return;
      }

      /* Unit values exist only inside unions (unionWrap intercepts them
       * before the walk, so a reached unitLit is refused loudly). */
      case "unitLit":
      /* templateStrings is the tagged-template strings OBJECT (string[]). */
      case "templateStrings":
      /* Regex — a whole engine, host-imported or compiled. */
      case "regexLit":
      case "regexIntrinsic":
      /* Typed arrays. */
      case "bytesNew":
      case "bytesIntrinsic":
      /* Native FFI — a link-time C ABI, nothing to link against here. */
      case "ffiCall":
      /* Async, generators, promises. (awaitExpr/awaitUnionExpr never
       * reach here in a function the lowering accepted — they are what it
       * consumes; one that survives belongs to a REFUSED async function
       * and reports as `fn:async` before its body is walked.) */
      case "yieldExpr":
      case "genResume":
      case "awaitExpr":
      case "awaitUnionExpr":
      /* Widening promise<T> into promise<void> is representationally free
       * here (one struct), but the awaiting side then reads a payload it
       * has no type for — the void-await path is its own work. */
      case "promiseVoidWiden":
      case "jsBridgePromise":
      /* Classes: the class-as-a-VALUE surface (its own object type with a
       * construct thunk) and virtual dispatch (vtables). */
      /* Record shapes. */
      /* The dynamic-keyed record surface rides the overflow map. */
      case "recordKeyGet":
      case "recordOvfKeys":
      /* The dyn surface past the scalar core: the composite converters,
       * the keyed reads, and the invoke boundary. */
      case "dynFromJsval":
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
        this.refuse(`expr:${(rest as WExpr).kind}`, (rest as WExpr).loc);
        code.unreachable();
      }
    }
  }

  /** The pretty-print wrap both stringify roots share: `space` arrived
   * here as the frontend's compile-time resolution of it, and the
   * re-indenter rewrites the compact text with Node's gap algorithm. A
   * root that produced a bare scalar — or the dyn root's dropped-value
   * text "undefined" — passes through unchanged, since the state machine
   * only reacts to structural characters. */
  private emitJsonIndent(e: Extract<WExpr, { kind: "jsonStringify" }>): void {
    const indent = (e as { indent?: string }).indent;
    if (indent === undefined || indent === "") return;
    this.pushStrLit(indent);
    this.fn.code.call(this.json.indent());
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

  private mapsField: MapBuilder | null = null;

  /** The Map/Set compact-dict machinery (maps.ts), deps injected — just
   * strEq/strType for string-keyed hashing/equality (map/set intrinsics
   * never throw and never format, so nothing else is needed the way
   * dyn/json/insp pull in error/ToString helpers). */
  private get maps(): MapBuilder {
    this.mapsField ??= new MapBuilder(this.mb, {
      strEq: () => this.strEqHelper(),
      strType: () => this.strType,
    });
    return this.mapsField;
  }

  private strsField: StrBuilder | null = null;

  /** The string method surface (strings.ts). split's string[] result
   * must BE the tier's string[] — the same interned vec(str) info the
   * emitter maps `string[]` to, injected with its push helper. */
  private get strs(): StrBuilder {
    this.strsField ??= new StrBuilder(this.mb, this.strType, {
      vecStr: () => {
        const strRef: ValType = { kind: "ref", nullable: true, typeIndex: this.strType };
        const info = this.vecs.info("vec(str)", strRef, strRef, "string");
        return { info, push1: this.vecs.pushOne(info) };
      },
    });
    return this.strsField;
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
   * different func-element arrays would intern one (wrong) vector type.
   * `union` and `promise` deliberately stay ONE key each (the default
   * arm): every union value is a ref to the one shared base and every
   * promise is the one runtime struct, so one vector type and one ref.eq
   * helper family serve every such array — the C lane's pointer-identity
   * stance for union elements, shared. */
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
      case "object":
        // One key for the whole builtin error family — they genuinely
        // share errT, so `Error[]` and `TypeError[]` are one vector type
        // (and were, back when "object" meant only errT). Every emitted
        // class is its own element representation and its own key.
        //
        // Nothing else in arrays.ts needed a class-element gate: get/set/
        // push/slice/splice/newLen are representation-generic, indexOf
        // and includes go through ref.eq (JS-exact for objects), and JOIN
        // — the one helper that would have to STRINGIFY an element —
        // already refuses every ref element as `arrIntrinsic:join:ref-elem`
        // before the helper is asked for. Verified against the corpus:
        // there is no class-element hole there to plug.
        return RUNTIME_ERROR_CLASSES.has(t.className) ? "object" : `obj:${t.className}`;
      case "classval": {
        // Keyed by the classobj TYPE, which is already per (root, ABI) —
        // exactly the set of classvals that can flow into one another.
        const soft = this.mapTypeSoft(t);
        return `clsv:${valKey(soft)}`;
      }
      case "map":
        // Recursive, exactly like array/record/func above — the default
        // arm's bare `t.kind` would answer "map" for EVERY map type
        // regardless of its own key/value, colliding e.g. an array of
        // `Map<string, number>` with an array of `Map<string, string>`
        // into one (wrong) shared vector type. mapInfoFor's OWN top-level
        // key deliberately does NOT add this "map:" prefix (the Set<T>/
        // Map<T,number> collapse), but vecKeyFor is reached recursively —
        // as a map's own VALUE type, or here as an array/map element —
        // where map and set must stay distinguishable from each other and
        // from every other nested map/set shape (review finding, stage A).
        return `map(${this.vecKeyFor(t.key)},${this.vecKeyFor(t.value)})`;
      case "set":
        return `set(${this.vecKeyFor(t.elem)})`;
      default:
        return t.kind;
    }
  }

  /** The KEY representation for a map/set key type — f64 or string only
   * (isSupportedMapKey's fence). The two ref-identity cases this refuses
   * are NOT symmetric (measured, not assumed — an earlier draft claimed
   * both were unreachable, which was only half true):
   *   - Set<symbol>/Set<netServer> ARE reachable: `isSupportedSetElem`
   *     admits them at the TYPE level, so `new Set<symbol>()` alone (no
   *     Symbol() call even needed) compiles past the frontend and hits
   *     `setNew:ref-elem` here as its FIRST refusal — a live census
   *     bucket, not defensive dead code (probed directly).
   *   - Map<symbol, V> is genuinely dead: `isSupportedMapKey` has no
   *     symbol/netServer arm, so the FRONTEND rejects it outright
   *     (SC2009/SC1090, before any IR reaches this backend at all) —
   *     `mapNew:ref-key` can still fire on this path in principle, it
   *     just has no known live program to name today. */
  private mapKeyRepFor(t: IrType): { kind: MapKeyKind; val: ValType } | null {
    if (t.kind === "f64") return { kind: "f64", val: F64 };
    if (t.kind === "string") {
      return { kind: "str", val: { kind: "ref", nullable: true, typeIndex: this.strType } };
    }
    return null;
  }

  /** The VALUE representation for a map value / set element type (a Set
   * pins this to the constant f64 `{ kind: "f64" }` — its value slot is
   * never read). `soft` mirrors mapTypeSoft's own no-refusal contract —
   * but unlike `mapType`, `mapTypeSoft` never answers null on failure, it
   * answers the I32 placeholder (its whole contract: "a placeholder for
   * unmappable types, NO refusal"). I32 is never a LEGITIMATE non-bool
   * resolution anywhere in mapTypeSoft's switch (every other case answers
   * a ref, or the array/record/object/classval sub-checks that fail
   * answer I32 for the same reason) — so `val.kind === "i32"` on the soft
   * path, for a `t.kind` that ISN'T "bool", unambiguously means the
   * placeholder fired and this value type didn't actually resolve. Must
   * be treated as failure here (review MAJOR-2): the earlier draft
   * derived `kind` from `t.kind` unconditionally, so an unmappable soft
   * value type interned a MapInfo claiming `valKind: "ref"` while
   * `valVal` was the bare I32 placeholder — a struct whose declared
   * field type disagreed with the kind every reader would branch on. */
  private mapValRepFor(
    t: IrType,
    loc: SrcLoc | undefined,
    soft: boolean,
  ): { kind: MapValKind; val: ValType; storage: StorageType } | null {
    const val = soft ? this.mapTypeSoft(t) : this.mapType(t, loc);
    if (val === null) return null;
    if (soft && val.kind === "i32" && t.kind !== "bool") return null;
    const kind: MapValKind = t.kind === "f64" ? "f64" : t.kind === "bool" ? "bool" : "ref";
    const storage: StorageType = t.kind === "bool" ? "i8" : val;
    return { kind, val, storage };
  }

  /** The map/set types for one (key, value) representation, interned —
   * `t.kind` is "map" (key/value) or "set" (elem, value pinned to f64 0).
   * Deliberately does NOT prefix the interning key with "map"/"set": a
   * `Set<T>` and a `Map<T, number>` collapse onto the SAME struct + one
   * helper family when their keys agree — maps.ts's "ONE representation"
   * thesis taken one layer tighter than scr_map.c, which still keeps a
   * distinct `scr_set_new_ref` entry point C doesn't need to share. */
  private mapInfoFor(t: IrType, loc: SrcLoc | undefined, soft: boolean): MapInfo | null {
    if (t.kind !== "map" && t.kind !== "set") {
      throw new Error(`mapInfoFor on a non-map/set type ${t.kind}`);
    }
    const keyType = t.kind === "map" ? t.key : t.elem;
    const valueType: IrType = t.kind === "map" ? t.value : { kind: "f64" };
    const kr = this.mapKeyRepFor(keyType);
    if (kr === null) {
      if (!soft) this.refuse(t.kind === "map" ? "mapNew:ref-key" : "setNew:ref-elem", loc);
      return null;
    }
    const vr = this.mapValRepFor(valueType, loc, soft);
    // Hard path: mapType already recorded the honest `type:*` refusal.
    // Soft path: mapTypeSoft never refuses — vr === null here just means
    // the placeholder fired (mapValRepFor's own doc), so this call site
    // (mapTypeSoft's own map/set arm) falls back to I32 without a refuse.
    if (vr === null) return null;
    const key = `map(${this.vecKeyFor(keyType)},${this.vecKeyFor(valueType)})`;
    return this.maps.info(key, kr.kind, kr.val, vr.kind, vr.val, vr.storage);
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
        if (
          k === "array" || k === "func" || k === "record" || k === "object" || k === "promise" ||
          k === "classval"
        ) {
          // Reference identity — JS object/function equality exactly.
          // Every one of these is a GC struct or array reference and
          // `ref.eq` compares references, which is what the C lane's `l ==
          // r` on the same operands does (one pointer compare for arrays,
          // closures, records, instances and promises alike). Records
          // included: recordLit allocates a fresh struct per evaluation,
          // so two structurally equal literals are correctly unequal, and
          // two refs of DIFFERENT shapes still compare (every struct ref
          // is an eqref) and correctly answer false. Zero-capture closures
          // intern, so `f === f` holds. Promises are ONE struct whatever
          // their inner type (promises.ts), so promise identity is the
          // same single comparison — and `p.then()` mints a fresh one, so
          // `p.then() === p` is false here exactly as in Node.
          //
          // The representation has to be REAL: an operand whose type the
          // tier cannot spell holds a placeholder i32, and `ref.eq` over
          // that is a validation error rather than a wrong answer. mapType
          // is the gate, and it names the missing representation.
          if (this.mapType(e.left.type, e.loc) === null || this.mapType(e.right.type, e.loc) === null) {
            code.unreachable();
            return;
          }
          this.walkExpr(e.left);
          this.walkExpr(e.right);
          code.refEq();
          if (e.op === "!==") code.i32Eqz();
          return;
        }
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

  /** Map method/property dispatch. Receiver first, then arguments in
   * source order (arrIntrinsic's convention) — map/set intrinsics never
   * throw (confirmed against may-throw.ts: neither `mapIntrinsic` nor
   * `setIntrinsic` appears in its switch), so nothing here ever needs a
   * pending-exception check. */
  private emitMapIntrinsic(e: Extract<IrExpr, { kind: "mapIntrinsic" }>): void {
    const code = this.fn.code;
    const rt = e.receiver.type;
    if (rt.kind !== "map") throw new Error("mapIntrinsic on a non-map receiver");
    const info = this.mapInfoFor(rt, e.loc, false);
    if (info === null) {
      code.unreachable();
      return;
    }
    switch (e.method) {
      case "size":
        this.walkExpr(e.receiver);
        code.call(this.maps.size(info));
        return;
      case "clear":
        this.walkExpr(e.receiver);
        code.call(this.maps.clear(info));
        return;
      case "has":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.has(info));
        return;
      case "delete":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.deleteM(info));
        return;
      case "set":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        this.walkExpr(e.args[1]!);
        code.call(this.maps.set(info));
        return;
      case "iterCount":
        this.walkExpr(e.receiver);
        code.call(this.maps.iterCount(info));
        return;
      case "iterLive":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.iterLive(info));
        return;
      case "iterKey":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.iterKey(info));
        return;
      case "iterValue":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.iterValue(info));
        return;
      case "iterEnter":
        this.walkExpr(e.receiver);
        code.call(this.maps.iterEnter(info));
        return;
      case "iterExit":
        this.walkExpr(e.receiver);
        code.call(this.maps.iterExit(info));
        return;
      case "get": {
        // Type-directed union construction: get's result is `V |
        // undefined`. WasmGC's multi-value `get` (found, val) plus real
        // GC (no retain to skip on a miss) simplify the C reference's
        // three-way representation split (union-reuse / scalar-out-param
        // / ref-null-sentinel) down to TWO cases here, not one — an
        // earlier draft dropped the union-reuse case as an unneeded
        // optimization, which was WRONG: when V is ITSELF union-typed,
        // `unionArmTag(e.type.unionId, rt.value)` can never succeed —
        // rt.value is a WHOLE UNION, never one arm of itself — so this
        // case is REQUIRED for correctness, not merely an optimization
        // (increment-17 stage-A finding, corpus program
        // 523-map-ref-values.ts: `Map<string, string | undefined>`).
        //
        // e.type.unionId does NOT generally equal rt.value.unionId (an
        // earlier version of this comment claimed it did — measured
        // FALSE via --emit-ir on `Map<string, A | B>` with A|B carrying
        // no undefined arm of their own: two DISTINCT IrUnionDefs exist,
        // u0 = A|B and u1 = A|B|undefined). Reusing the stored box is
        // sound anyway, for two INDEPENDENT reasons that both have to
        // hold:
        //   1. Canonical arm order guarantees u0's arms are a PREFIX of
        //      u1's arms in the SAME relative order (undefined sorts
        //      LAST, nodes.ts's IrUnionDef contract) — so a given tag
        //      number means the same logical arm in both unions. Without
        //      this, reusing the box would misread the tag regardless of
        //      wasm-level type safety.
        //   2. WasmGC struct types canonicalize STRUCTURALLY at the
        //      engine level (isorecursive equivalence, GC MVP) — but ONLY
        //      PER RECURSION GROUP, so this needs one more fact to be
        //      airtight: every `armStruct`/`unionArmStruct` call is a
        //      SINGLETON group (it is only ever reached from `unionWrap`
        //      during body-walking, never from inside the one
        //      `beginRecGroup`/`endRecGroup` span this codebase opens —
        //      `resolveRecGroup`'s record/class SCC resolution, which
        //      only calls `mapTypeSoft` for field types — see unions.ts's
        //      `armStruct` doc for the full argument). Two SINGLETON
        //      entries with identical field layout and supertype are ONE
        //      runtime type no matter which type-section index or
        //      author-side key (`union:<unionId>:<tag>`) declared them.
        //      u0's tag-N arm struct and u1's tag-N arm struct are both
        //      exactly `{ tag: i32, payload: <same payload type> }`
        //      subtyping the one shared union base — so a `ref.cast`
        //      against EITHER declaration succeeds on a value built under
        //      the OTHER. Confirmed by inspecting the emitted module (a
        //      struct declared at one type-section index reads back
        //      through a `ref.cast` naming a DIFFERENT index) and by
        //      running the `A | B` case above end-to-end against Node.
        //      Were an arm struct ever interned INSIDE an open span, it
        //      would compare as a member of that whole multi-entry group
        //      instead, and this reuse would very likely break.
        //   unions.ts's own "two unions' arms never intern one type"
        //   comment predates this finding and is corrected alongside it.
        if (e.type.kind !== "union") throw new Error("map get result is not a union");
        const undefTag = this.undefinedArmTag(e.type.unionId);
        if (undefTag < 0) throw new Error("map get union lacks its undefined arm");
        if (rt.value.kind === "union") {
          this.walkExpr(e.receiver);
          this.walkExpr(e.args[0]!);
          code.call(this.maps.get(info));
          const val = this.acquireScratch(info.valVal);
          code.localSet(val);
          const found = this.acquireScratch(I32);
          code.localSet(found);
          code.localGet(found);
          this.openIfResult(this.unions.baseRef());
          code.localGet(val);
          code.else_();
          code.globalGet(this.unions.unitGlobal(undefTag));
          this.close();
          this.releaseScratch(I32, found);
          this.releaseScratch(info.valVal, val);
          return;
        }
        // V is not itself a union: e.type is V's arms plus a freshly
        // appended undefined arm — wrap the retrieved value into e.type's
        // OWN arm struct on a hit.
        const valueTag = this.unionArmTag(e.type.unionId, rt.value);
        if (valueTag < 0) throw new Error("map get union lacks its value arm");
        const armSt = this.unionArmStruct(e.type.unionId, valueTag, e.loc);
        if (armSt === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.get(info));
        const val = this.acquireScratch(info.valVal);
        code.localSet(val);
        const found = this.acquireScratch(I32);
        code.localSet(found);
        code.localGet(found);
        this.openIfResult(this.unions.baseRef());
        code.i32Const(valueTag);
        code.localGet(val);
        code.structNew(armSt);
        code.else_();
        code.globalGet(this.unions.unitGlobal(undefTag));
        this.close();
        this.releaseScratch(I32, found);
        this.releaseScratch(info.valVal, val);
        return;
      }
      default: {
        const rest: never = e.method;
        this.refuse(`mapIntrinsic:${rest as string}`, e.loc);
        code.unreachable();
      }
    }
  }

  /** Set method/property dispatch — mirrors emitMapIntrinsic's shape over
   * the OVERLAPPING method-name set (has/delete/size/clear/iterCount/
   * iterLive/iterKey/iterEnter/iterExit share MapBuilder helpers
   * directly, since a Set's underlying MapInfo IS a Map's whenever their
   * keys agree — the "ONE representation" thesis, maps.ts's header).
   * `add` is `set` with the value pinned to the constant f64 0; `toArray`
   * has no Map counterpart (Map has no bulk-drain method). */
  private emitSetIntrinsic(e: Extract<IrExpr, { kind: "setIntrinsic" }>): void {
    const code = this.fn.code;
    const rt = e.receiver.type;
    if (rt.kind !== "set") throw new Error("setIntrinsic on a non-set receiver");
    const info = this.mapInfoFor(rt, e.loc, false);
    if (info === null) {
      code.unreachable();
      return;
    }
    switch (e.method) {
      case "size":
        this.walkExpr(e.receiver);
        code.call(this.maps.size(info));
        return;
      case "clear":
        this.walkExpr(e.receiver);
        code.call(this.maps.clear(info));
        return;
      case "has":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.has(info));
        return;
      case "delete":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.deleteM(info));
        return;
      case "add":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.f64Const(0);
        code.call(this.maps.set(info));
        return;
      case "iterCount":
        this.walkExpr(e.receiver);
        code.call(this.maps.iterCount(info));
        return;
      case "iterLive":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.iterLive(info));
        return;
      case "iterKey":
        this.walkExpr(e.receiver);
        this.walkExpr(e.args[0]!);
        code.call(this.maps.iterKey(info));
        return;
      case "iterEnter":
        this.walkExpr(e.receiver);
        code.call(this.maps.iterEnter(info));
        return;
      case "iterExit":
        this.walkExpr(e.receiver);
        code.call(this.maps.iterExit(info));
        return;
      case "toArray": {
        if (e.type.kind !== "array") throw new Error("set toArray result is not an array");
        const vecInfo = this.vecInfoFor(e.type, e.loc);
        if (vecInfo === null) {
          code.unreachable();
          return;
        }
        this.walkExpr(e.receiver);
        code.call(this.maps.toArray(info, vecInfo.struct, vecInfo.bufType));
        return;
      }
      default: {
        const rest: never = e.method;
        this.refuse(`setIntrinsic:${rest as string}`, e.loc);
        code.unreachable();
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
      case "pop": {
        // The ELEMENT itself — the frontend types pop as elem, and the
        // empty pop throws RangeError instead of answering undefined
        // (SEMANTICS.md S006; the trap is S003's exit-1 bridge until the
        // exception protocol lands).
        const vec = this.acquireScratch(this.vecs.vecRef(info));
        this.walkExpr(e.receiver);
        code.localSet(vec);
        const len = this.acquireScratch(I32);
        code.localGet(vec);
        code.structGet(info.struct, 0);
        code.localSet(len);
        code.localGet(len);
        code.i32Eqz();
        this.openIf();
        code.unreachable();
        this.close();
        const es = this.acquireScratch(info.elemVal);
        code.localGet(vec);
        code.structGet(info.struct, 1);
        code.localGet(len);
        code.i32Const(1);
        code.i32Sub();
        this.vecs.emitElemRead(code, info);
        code.localSet(es);
        code.localGet(vec);
        code.localGet(len);
        code.i32Const(1);
        code.i32Sub();
        code.structSet(info.struct, 0);
        this.clearVacatedSlot(info, vec, len);
        code.localGet(es);
        this.releaseScratch(info.elemVal, es);
        this.releaseScratch(I32, len);
        this.releaseScratch(this.vecs.vecRef(info), vec);
        return;
      }
      case "shift": {
        // `elem | undefined` — undefined on an empty array (JS-exact),
        // else the first element with the tail sliding down. Union
        // elements are frontend-fenced (their shift result would collapse
        // arms), so the wrap below is always a plain arm.
        if (e.type.kind !== "union") throw new Error("shift result is not a union");
        const undefTag = this.undefinedArmTag(e.type.unionId);
        const elemTag = this.unionArmTag(e.type.unionId, rt.elem);
        if (undefTag < 0 || elemTag < 0) throw new Error("shift result union shape");
        const st = this.unionArmStruct(e.type.unionId, elemTag, e.loc);
        if (st === null) {
          code.unreachable();
          return;
        }
        const vec = this.acquireScratch(this.vecs.vecRef(info));
        this.walkExpr(e.receiver);
        code.localSet(vec);
        const len = this.acquireScratch(I32);
        code.localGet(vec);
        code.structGet(info.struct, 0);
        code.localSet(len);
        code.localGet(len);
        code.i32Eqz();
        this.openIfResult(this.unions.baseRef());
        // Empty: undefined, and NO length write (JS-exact).
        code.globalGet(this.unions.unitGlobal(undefTag));
        code.else_();
        const es = this.acquireScratch(info.elemVal);
        code.localGet(vec);
        code.structGet(info.struct, 1);
        code.i32Const(0);
        this.vecs.emitElemRead(code, info);
        code.localSet(es);
        // Slide [1, len) down one.
        code.localGet(vec);
        code.structGet(info.struct, 1);
        code.i32Const(0);
        code.localGet(vec);
        code.structGet(info.struct, 1);
        code.i32Const(1);
        code.localGet(len);
        code.i32Const(1);
        code.i32Sub();
        code.arrayCopy(info.bufType, info.bufType);
        code.localGet(vec);
        code.localGet(len);
        code.i32Const(1);
        code.i32Sub();
        code.structSet(info.struct, 0);
        this.clearVacatedSlot(info, vec, len);
        code.i32Const(elemTag);
        code.localGet(es);
        code.structNew(st);
        this.releaseScratch(info.elemVal, es);
        this.close();
        this.releaseScratch(I32, len);
        this.releaseScratch(this.vecs.vecRef(info), vec);
        return;
      }
      /* `with` throws a catchable RangeError — it joins with the
       * exception protocol; the ES2023 copiers are tail work. */
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

  /** Clears buf[len - 1] after a pop/shift (ref elements only): the
   * vacated slot would otherwise keep the removed element alive until a
   * push overwrites it. `vec` holds the vector, `len` the OLD length. */
  private clearVacatedSlot(info: VecInfo, vec: number, len: number): void {
    if (!info.refElem || info.elemVal.kind !== "ref") return;
    const code = this.fn.code;
    code.localGet(vec);
    code.structGet(info.struct, 1);
    code.localGet(len);
    code.i32Const(1);
    code.i32Sub();
    code.refNull(info.elemVal.typeIndex);
    code.arraySet(info.bufType);
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

  /** `scr_dyn_is_nullish` inline: the two unit kinds, off the tag. The
   * short-circuit test behind `??` and `?.` over a dyn value — the
   * FALSY scalars (0, "", false) are emphatically not nullish. */
  private emitDynNullish(s: number): void {
    const code = this.fn.code;
    const k = this.acquireScratch(I32);
    code.localGet(s);
    code.structGet(this.dyn.dynT(), DYN_KIND);
    code.localTee(k);
    code.i32Const(DK.UNDEF);
    code.i32Eq();
    code.localGet(k);
    code.i32Const(DK.NULL);
    code.i32Eq();
    code.i32Or();
    this.releaseScratch(I32, k);
  }

  /** JS-exact switch: the discriminant evaluates once into a scratch; the
   * dispatch chain evaluates case tests lazily in SOURCE order and
   * branches to the matching body's entry; bodies sit between the nested
   * blocks' ends so execution FALLS THROUGH in source order until a break
   * (which binds to the exit block via the control stack). A default in
   * any position is the dispatch chain's fallback target only — its body
   * keeps its source position. */
  private emitSwitch(s: Extract<WStmt, { kind: "switch" }>): void {
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
        if (t === "f64") code.call(this.inspF64Helper());
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

  /* ── the timer surface (timers.ts) ────────────────────────────────────
   *
   * Each of these is one call into the emitted runtime with the IR's own
   * arguments: callbacks arrive as `() => void` closures (the frontend
   * adapts parameterized ones through its %timer.dropret and
   * checked-dynamic wrappers BEFORE the libCall, so this side never sees
   * another shape) and handles are f64 ids. Statement-position setTimeout
   * is the one with no handle at all — nothing can clear or unref it.
   *
   * `timers.queueMicrotask` is deliberately absent: the microtask queue's
   * nodes are typed for (resume, frame) pairs, and admitting a plain
   * closure would widen that type for every async program to serve the
   * one corpus program that asks — which asks in the `dyn` spelling
   * anyway. It keeps refusing by name. */
  private emitTimerCall(e: Extract<IrExpr, { kind: "libCall" }>): boolean {
    const code = this.fn.code;
    const call1 = (idx: number): void => {
      this.walkExpr(e.args[0]!);
      code.call(idx);
    };
    const call2 = (idx: number): void => {
      this.walkExpr(e.args[0]!);
      this.walkExpr(e.args[1]!);
      code.call(idx);
    };
    switch (e.fn) {
      case "timers.clearNoop":
        // Node silently ignores a clear of anything that is not a live
        // handle; the frontend routes only SYNTACTICALLY effect-free
        // arguments here, so the whole call is nothing at all.
        return true;
      case "timers.setTimeout":
        call2(this.timers.setTimeout());
        return true;
      case "timers.setTimeoutHandle":
        call2(this.timers.setTimeoutHandle());
        return true;
      case "timers.setInterval":
        call2(this.timers.setInterval());
        return true;
      // One id space, one removal (scr_clear_interval serves both).
      case "timers.clearTimeout":
      case "timers.clearInterval":
        call1(this.timers.clear());
        return true;
      case "timers.unref":
        call1(this.timers.refOp(false));
        return true;
      case "timers.ref":
        call1(this.timers.refOp(true));
        return true;
      case "timers.hasRef":
        call1(this.timers.hasRef());
        return true;
      case "timers.refresh":
        call1(this.timers.refresh());
        return true;
      case "timers.setImmediate":
        call1(this.timers.setImmediate());
        return true;
      case "timers.clearImmediate":
        call1(this.timers.clearImmediate());
        return true;
      case "timers.immediateUnref":
        call1(this.timers.immRefOp(false));
        return true;
      case "timers.immediateRef":
        call1(this.timers.immRefOp(true));
        return true;
      case "timers.immediateHasRef":
        call1(this.timers.immHasRef());
        return true;
      default:
        return false;
    }
  }

  /* ── the awaited promise, read back ─────────────────────────────────────
   *
   * Three helpers the plain await ops and their union-armed twins share.
   * The union forms differ from the plain ones only in HOW they reach the
   * promise (one tag test and a narrow); everything after is identical, so
   * it lives here once. */

  /** The re-entry rejection check, over a local already holding the
   * awaited promise: observe it (this frame is about to re-throw, so it
   * IS handled), copy the payload into the exception cell (kind LAST, the
   * commit) and unwind — which lands in resume's own catch and becomes
   * this frame's rejection. */
  private emitRejectCheckOn(pr: number): void {
    const code = this.fn.code;
    const exc = this.exc();
    code.localGet(pr);
    code.structGet(this.proms.promT, PROM_STATE);
    code.i32Const(2);
    code.i32Eq();
    this.openIf();
    code.localGet(pr);
    code.i32Const(1);
    code.structSet(this.proms.promT, PROM_OBSERVED);
    code.localGet(pr);
    code.structGet(this.proms.promT, PROM_F64);
    code.globalSet(exc.f64G);
    code.localGet(pr);
    code.structGet(this.proms.promT, PROM_REF);
    code.globalSet(exc.refG);
    code.localGet(pr);
    code.structGet(this.proms.promT, PROM_PRE);
    code.globalSet(exc.preG);
    code.localGet(pr);
    code.structGet(this.proms.promT, PROM_KIND);
    code.globalSet(exc.kindG);
    this.emitUnwind();
    this.close();
  }

  /** A settled promise's payload, read back by a STATIC type — the
   * payload triple carries no type of its own. `push` leaves the promise
   * on `c`'s stack; false means the representation refused, under `what`.
   * Takes the buffer rather than using this.fn.code because the
   * combinators' reaction functions are built outside any IR function. */
  private emitSettledPayload(
    c: Code,
    t: IrType,
    push: () => void,
    what: string,
    loc: SrcLoc | undefined,
  ): boolean {
    const promT = this.proms.promT;
    if (t.kind === "f64") {
      push();
      c.structGet(promT, PROM_F64);
      return true;
    }
    if (t.kind === "bool") {
      push();
      c.structGet(promT, PROM_F64);
      c.f64Const(0);
      c.f64Ne();
      return true;
    }
    const val = this.mapType(t, loc);
    if (val === null || val.kind !== "ref") {
      this.refuse(`${what}:${t.kind}`, loc);
      return false;
    }
    push();
    c.structGet(promT, PROM_REF);
    c.refCast(val.typeIndex);
    return true;
  }

  /** The `promiseTag` arm's payload subtype for an awaited
   * `Promise<T> | units` union — the cast target the three union-armed
   * ops narrow through. Null (refusal recorded) when the arm's
   * representation is out of tier. */
  private awaitUnionArm(value: WExpr, promiseTag: number, loc: SrcLoc): number | null {
    const ut = value.type;
    if (ut.kind !== "union") throw new Error("await-union op over a non-union value");
    return this.unionArmStruct(ut.unionId, promiseTag, loc);
  }

  /** `await (p: Promise<T> | units)`'s value, in the RESULT union.
   *
   * THE TWO UNIONS DO NOT SHARE A NUMBERING, and that is the whole
   * difficulty. The awaited union's arms are `[Promise<T>, ...units]`; the
   * result's are `[T, ...units]` (nodes.ts's awaitUnionExpr contract) —
   * two different interned unions, each sorted by typeKey, so a unit arm's
   * tag can MOVE between them. `Promise<number> | null` is the smallest
   * witness: "null" sorts after "promise<f64>" but before "f64", so null
   * is arm 0 going in and arm 1 coming out. Passing the value through
   * unchanged would be a silent miscompile — a unit instance is interned
   * per TAG across the whole module, so the wrong tag is a well-typed lie.
   *
   * So every arm is mapped BY TYPE (typeEquals against the result's
   * canonical arms), never by position, and a lookup that fails refuses by
   * name instead of guessing. Unit arms carry no payload, which makes the
   * whole conversion the retag: one interned instance for another. */
  private emitSettledUnion(e: Extract<WExpr, { kind: "%async.settledUnion" }>): void {
    const code = this.fn.code;
    const ut = e.value.type;
    if (ut.kind !== "union") throw new Error("%async.settledUnion over a non-union value");
    const inDef = this.unionDef(ut.unionId);
    const promArm = inDef.arms[e.promiseTag];
    if (promArm?.kind !== "promise") throw new Error("%async.settledUnion promiseTag is not a promise arm");
    if (e.type.kind !== "union") {
      // A non-union result means the value had nowhere to put the unit
      // arms; the frontend only builds one when it interned the combined
      // union, so this is a contract breach, not a representation gap.
      this.refuse("expr:%async.settledUnion:non-union-result", e.loc);
      code.unreachable();
      return;
    }
    const outId = e.type.unionId;
    // Plan every arm before emitting (unionDisc's rule): one unmappable
    // arm refuses the whole read rather than leaving partial code.
    const innerTag = this.unionArmTag(outId, promArm.inner);
    if (innerTag < 0) {
      this.refuse(`expr:%async.settledUnion:inner:${promArm.inner.kind}`, e.loc);
      code.unreachable();
      return;
    }
    const units: { inTag: number; outTag: number }[] = [];
    for (const [i, arm] of inDef.arms.entries()) {
      if (i === e.promiseTag) continue;
      if (!isUnitType(arm)) throw new Error("%async.settledUnion over a non-unit sibling arm");
      const outTag = this.unionArmTag(outId, arm);
      if (outTag < 0) {
        this.refuse(`expr:%async.settledUnion:unit:${arm.kind}`, e.loc);
        code.unreachable();
        return;
      }
      units.push({ inTag: i, outTag });
    }
    const innerIsUnit = isUnitType(promArm.inner);
    const outArm = innerIsUnit ? 0 : this.unionArmStruct(outId, innerTag, e.loc);
    const inArm = this.unionArmStruct(ut.unionId, e.promiseTag, e.loc);
    if (outArm === null || inArm === null) {
      code.unreachable();
      return;
    }

    const baseRef = this.unions.baseRef();
    const u = this.acquireScratch(baseRef);
    this.walkExpr(e.value);
    code.localSet(u);
    code.localGet(u);
    code.structGet(this.unions.base(), 0);
    code.i32Const(e.promiseTag);
    code.i32Eq();
    this.openIfResult(baseRef);
    if (innerIsUnit) {
      // A unit inner (`Promise<undefined>`) has no payload to read: the
      // settled value IS the interned instance for its result tag.
      code.globalGet(this.unions.unitGlobal(innerTag));
    } else {
      code.i32Const(innerTag);
      const ok = this.emitSettledPayload(
        code,
        promArm.inner,
        () => {
          code.localGet(u);
          code.refCast(inArm);
          code.structGet(inArm, 1);
        },
        "expr:%async.settledUnion",
        e.loc,
      );
      if (!ok) code.unreachable();
      else code.structNew(outArm);
    }
    code.else_();
    for (const arm of units) {
      code.localGet(u);
      code.structGet(this.unions.base(), 0);
      code.i32Const(arm.inTag);
      code.i32Eq();
      this.openIfResult(baseRef);
      code.globalGet(this.unions.unitGlobal(arm.outTag));
      code.else_();
    }
    // No arm matched: a corrupted tag, loud like every other union
    // dispatch's default.
    code.unreachable();
    for (let i = 0; i < units.length; i++) this.close();
    this.close();
    this.releaseScratch(baseRef, u);
  }

  /* ── new Promise(executor) ──────────────────────────────────────────────
   *
   * `new Promise<T>((resolve, reject) => ...)` is a mint, one or two
   * settler CLOSURES over that promise, and a synchronous call. The
   * settlers are emitted functions (one per payload representation, since
   * the body is just "settle my captured promise with my argument"), and
   * their environment is a one-field subtype of the settler signature's
   * closure struct holding the promise — envTypeFor's shape without an IR
   * function to derive it from.
   *
   * The executor is the ONE call site with a custom pending check: a
   * throw out of it REJECTS the promise (JS-exact) and the creator keeps
   * running, so the cell is drained into the rejection rather than
   * unwound. */

  private readonly settlerFns = new Map<string, number>();

  /** The settler for one payload shape: `(v: T) => void` fulfilling (or
   * `(e) => void` rejecting) the promise in its environment. */
  private settlerFor(param: IrType | null, state: 1 | 2, loc: SrcLoc | undefined): number | null {
    const val = param === null ? null : this.mapType(param, loc);
    if (param !== null && val === null) return null;
    const params = val === null ? [] : [val];
    const pair = this.closPairFor(params, []);
    const key = `${state}:${valKey({ kind: "ref", nullable: true, typeIndex: pair.fn })}`;
    const cached = this.settlerFns.get(key);
    if (cached !== undefined) return cached;
    const env = this.mb.subStructType(
      `settlerEnv:${key}`,
      [
        { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
        { storage: this.proms.promRef(), mutable: false },
      ],
      pair.clos,
    );
    const idx = this.mb.declareFunc(pair.fn, `%w.async.${state === 1 ? "resolve" : "reject"}.${this.settlerFns.size}`);
    this.settlerFns.set(key, idx);
    const c = new Code();
    c.localGet(0);
    c.refCast(env);
    c.structGet(env, 1);
    // The payload triple, from the settler's PARAM type — the same static
    // dispatch emitPayload does, over an argument instead of an expression.
    if (param === null || param.kind === "void") {
      c.i32Const(0);
      c.f64Const(0);
      c.refNull(ANY_HEAP);
      c.i32Const(-1);
    } else if (param.kind === "f64") {
      c.i32Const(EXC_F64);
      c.localGet(1);
      c.refNull(ANY_HEAP);
      c.i32Const(-1);
    } else if (param.kind === "bool") {
      c.i32Const(EXC_BOOL);
      c.localGet(1);
      c.f64ConvertI32U();
      c.refNull(ANY_HEAP);
      c.i32Const(-1);
    } else if (param.kind === "string") {
      c.i32Const(EXC_STR);
      c.f64Const(0);
      c.localGet(1);
      c.i32Const(-1);
    } else if (param.kind === "object") {
      const settlerInfo = this.classes.info(param.className, undefined, true);
      c.i32Const(EXC_OBJ);
      c.f64Const(0);
      c.localGet(1);
      // The settler's param type is its STATIC class; a hierarchy member
      // carries the dynamic one in its vt.
      if (settlerInfo === null) c.i32Const(-1);
      else if (!settlerInfo.meta.hierarchy) c.i32Const(settlerInfo.meta.pre);
      else {
        c.localGet(1);
        c.structGet(settlerInfo.struct, CLASS_VT);
        c.structGet(this.classes.ci(), CI_PRE);
      }
    } else {
      c.i32Const(EXC_REF);
      c.f64Const(0);
      c.localGet(1);
      c.i32Const(-1);
    }
    c.i32Const(state);
    c.call(this.proms.settle());
    this.mb.setBody(idx, [], c.bytes());
    return idx;
  }

  /** The settler CLOSURE value: ref.func + the promise, in its env. */
  private pushSettler(fnIndex: number, param: IrType | null, state: 1 | 2, promLocal: number): void {
    const code = this.fn.code;
    const val = param === null ? null : this.mapTypeSoft(param);
    const pair = this.closPairFor(val === null ? [] : [val], []);
    const key = `${state}:${valKey({ kind: "ref", nullable: true, typeIndex: pair.fn })}`;
    const env = this.mb.subStructType(
      `settlerEnv:${key}`,
      [
        { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
        { storage: this.proms.promRef(), mutable: false },
      ],
      pair.clos,
    );
    this.mb.declareFuncRef(fnIndex);
    code.refFunc(fnIndex);
    code.localGet(promLocal);
    code.structNew(env);
  }

  private emitNewPromise(e: Extract<IrExpr, { kind: "newPromise" }>): void {
    const code = this.fn.code;
    const ex = e.executor.type;
    if (ex.kind !== "func") throw new Error("newPromise executor is not a function");
    if (ex.params.length > 2) {
      this.refuse("expr:newPromise:arity", e.loc);
      code.unreachable();
      return;
    }
    // resolve(p) where p is a promise is ADOPTION — the payload would have
    // to be subscribed to (promises.ts's header), not stored.
    if (ex.params.some((p) => p.kind === "func" && p.params.some((q) => q.kind === "promise"))) {
      this.refuse("expr:newPromise:adopt", e.loc);
      code.unreachable();
      return;
    }
    const settlers: { fn: number; param: IrType | null; state: 1 | 2 }[] = [];
    for (const [i, p] of ex.params.entries()) {
      if (p.kind !== "func" || p.params.length > 1) {
        this.refuse("expr:newPromise:settler", e.loc);
        code.unreachable();
        return;
      }
      const state = i === 0 ? 1 : 2;
      const param = p.params[0] ?? null;
      const fn = this.settlerFor(param, state, e.loc);
      if (fn === null) {
        // The settler's payload representation refused by name already.
        code.unreachable();
        return;
      }
      settlers.push({ fn, param, state });
    }
    const exc = this.exc();
    const pr = this.acquireScratch(this.proms.promRef());
    code.call(this.proms.mint());
    code.localSet(pr);

    const closPair = this.closSigFor(ex, e.loc);
    if (closPair === null) {
      code.unreachable();
      return;
    }
    const closRef: ValType = { kind: "ref", nullable: true, typeIndex: closPair.clos };
    const ec = this.acquireScratch(closRef);
    this.walkExpr(e.executor);
    code.localSet(ec);
    code.localGet(ec); // arg0: the executor closure itself
    for (const s of settlers) this.pushSettler(s.fn, s.param, s.state, pr);
    code.localGet(ec);
    code.structGet(closPair.clos, 0);
    code.callRef(closPair.fn);
    this.releaseScratch(closRef, ec);

    // The executor's own exception: it rejects the promise and STOPS
    // THERE. Node runs the rest of the creating function normally, so the
    // cell is drained here rather than unwound.
    code.globalGet(exc.kindG);
    this.openIf();
    code.localGet(pr);
    code.globalGet(exc.kindG);
    code.globalGet(exc.f64G);
    code.globalGet(exc.refG);
    code.globalGet(exc.preG);
    code.i32Const(2);
    code.call(this.proms.settle());
    this.emitCellClear();
    this.close();

    code.localGet(pr);
    this.releaseScratch(this.proms.promRef(), pr);
  }

  /** `Promise.withResolvers<T>()` — the record assembly. The settler
   * FUNCTIONS and their env shape come straight from newPromise's pair
   * (settlerFor/pushSettler), so a module using both interns one of each;
   * the only new thing here is the record the frontend's type mapper
   * shaped, whose field types are what pick the settler signatures. */
  private emitWithResolvers(e: Extract<IrExpr, { kind: "promiseWithResolvers" }>): void {
    const code = this.fn.code;
    if (e.type.kind !== "record") throw new Error("promiseWithResolvers with a non-record type");
    const shape = this.recordShapes.get(e.type.shapeId);
    if (shape === undefined) throw new Error(`unknown record shape ${e.type.shapeId}`);
    const fieldT = (name: string): IrType | undefined => shape.fields.find((f) => f.name === name)?.type;
    const promiseT = fieldT("promise");
    const resolveT = fieldT("resolve");
    const rejectT = fieldT("reject");
    if (promiseT?.kind !== "promise" || resolveT?.kind !== "func" || rejectT?.kind !== "func") {
      throw new Error("promiseWithResolvers record is not { promise, resolve, reject }");
    }
    // Settling WITH a promise is adoption, exactly as in newPromise.
    if (resolveT.params.some((p) => p.kind === "promise")) {
      this.refuse("expr:promiseWithResolvers:adopt", e.loc);
      code.unreachable();
      return;
    }
    if (resolveT.params.length > 1 || rejectT.params.length !== 1) {
      this.refuse("expr:promiseWithResolvers:settler", e.loc);
      code.unreachable();
      return;
    }
    const info = this.recordInfo(e.type.shapeId, e.loc, false);
    const resolveParam = resolveT.params[0] ?? null;
    const rejectParam = rejectT.params[0]!;
    const resolveFn = this.settlerFor(resolveParam, 1, e.loc);
    const rejectFn = this.settlerFor(rejectParam, 2, e.loc);
    if (info === null || resolveFn === null || rejectFn === null) {
      code.unreachable();
      return;
    }
    const slot = (name: string): number => {
      const i = info.fieldIndex.get(name);
      if (i === undefined) throw new Error(`promiseWithResolvers shape lacks ${name}`);
      return i;
    };

    const pr = this.acquireScratch(this.proms.promRef());
    code.call(this.proms.mint());
    code.localSet(pr);
    const recRef: ValType = { kind: "ref", nullable: true, typeIndex: info.struct };
    const rec = this.acquireScratch(recRef);
    code.structNewDefault(info.struct);
    code.localSet(rec);
    code.localGet(rec);
    code.localGet(pr);
    code.structSet(info.struct, slot("promise"));
    code.localGet(rec);
    this.pushSettler(resolveFn, resolveParam, 1, pr);
    code.structSet(info.struct, slot("resolve"));
    code.localGet(rec);
    this.pushSettler(rejectFn, rejectParam, 2, pr);
    code.structSet(info.struct, slot("reject"));
    code.localGet(rec);
    this.releaseScratch(recRef, rec);
    this.releaseScratch(this.proms.promRef(), pr);
  }

  /* ── Promise.all / Promise.race ─────────────────────────────────────────
   *
   * Both are the same three moves: mint a result promise, and subscribe
   * one REACTION to every entry. A reaction is an ordinary waiter whose
   * closure is one of the interned functions below and whose frame is one
   * of promises.ts's two entry nodes — so the promise runtime needs no
   * change at all, and the FIFO the reactions ride is the microtask queue
   * itself.
   *
   * WHICH IS ALSO WHERE THE TURNS COME FROM. ECMAScript builds both
   * combinators out of `.then(...)` on each entry, so an entry's
   * settlement ENQUEUES its reaction rather than running it: the result
   * settles one microtask turn after the deciding entry, and an awaiter of
   * the result resumes a turn after that. Riding the waiter queue gives
   * exactly that. (scr_async.c runs its callbacks synchronously inside
   * settle and lands the result a turn early — measured against Node with
   * a competing microtask chain, which no corpus program has; Node is the
   * oracle, so this lane queues. See promises.ts's reaction block.)
   *
   * FIRST-SETTLE-WINS IS FREE. Every reaction settles the RESULT, and
   * settle already ignores a non-pending promise, so the first reaction to
   * run decides and every later one is a no-op — no flags, no unlinking.
   *
   * AND EVERY ENTRY IS HANDLED. Both subscribe through
   * subscribeHandled(): attaching a handler is what makes a rejection
   * handled in JS, so a loser's rejection never reaches the
   * unhandled-rejection report. */

  private readonly allFns = new Map<string, number>();
  private readonly allRxFns = new Map<string, number>();
  private readonly raceRxFns = new Map<string, number>();

  /** A reaction's closure VALUE: the resume signature's closure struct
   * holding nothing but the code pointer (reactions capture nothing — all
   * their state is in the entry node they are handed as a frame). */
  private pushReactionClosure(c: Code, fnIndex: number): void {
    this.mb.declareFuncRef(fnIndex);
    c.refFunc(fnIndex);
    c.structNew(this.resumeClosPair().clos);
  }

  /** The payload a completed `all` fulfils with: the values array as a
   * REF payload, or the void shape when the entries were `Promise<void>`
   * and there is no array. Never an OBJECT, so the interval slot is
   * always absent. */
  private pushAllFulfilment(c: Code, pushValues: (() => void) | null): void {
    if (pushValues === null) {
      c.i32Const(0);
      c.f64Const(0);
      c.refNull(ANY_HEAP);
      c.i32Const(-1);
      return;
    }
    c.i32Const(EXC_REF);
    c.f64Const(0);
    pushValues();
    c.i32Const(-1);
  }

  /** One Promise.all entry settling — the spec's `resolveElement`. A
   * fulfilment stores its payload at the entry's INPUT index (input
   * order, whatever order things actually settled in) and the LAST
   * missing one fulfils the result with the array; a rejection settles the
   * result outright, so the first rejection in SETTLEMENT order wins and
   * later ones are absorbed by settle's pending guard. Interned per values
   * REPRESENTATION — which is what decides the payload read and the store
   * — so one module needs at most one per element type. */
  private allReactionFor(values: VecInfo | null): number {
    const key = values?.key ?? "void";
    const hit = this.allRxFns.get(key);
    if (hit !== undefined) return hit;
    const pair = this.resumeClosPair();
    const idx = this.mb.declareFunc(pair.fn, `%w.async.allRx:${key}`);
    this.allRxFns.set(key, idx);
    const promT = this.proms.promT;
    const stateT = this.proms.allStateT;
    const entryT = this.proms.allEntryT;
    const c = new Code();
    // params: 0 = the reaction's own closure, 1 = the entry node.
    const E = 2, ST = 3, SRC = 4;
    c.localGet(1);
    c.refCast(entryT);
    c.localSet(E);
    c.localGet(E);
    c.structGet(entryT, ALLE_STATE);
    c.localSet(ST);
    c.localGet(E);
    c.structGet(entryT, ALLE_SRC);
    c.localSet(SRC);
    c.localGet(SRC);
    c.structGet(promT, PROM_STATE);
    c.i32Const(2);
    c.i32Eq();
    c.ifVoid();
    c.localGet(ST);
    c.structGet(stateT, ALL_RESULT);
    c.localGet(SRC);
    c.call(this.proms.settleFrom());
    c.return_();
    c.end();
    if (values !== null) {
      c.localGet(ST);
      c.structGet(stateT, ALL_VALUES);
      c.refCast(values.struct);
      c.localGet(E);
      c.structGet(entryT, ALLE_INDEX);
      c.localGet(SRC);
      // The payload by the ARRAY's element representation, which is the
      // one the fulfilling side wrote (the frontend fences Promise.all to
      // a single promise type, so entry inner and element agree).
      if (values.elemKind === "f64") {
        c.structGet(promT, PROM_F64);
      } else if (values.elemKind === "bool") {
        c.structGet(promT, PROM_F64);
        c.f64Const(0);
        c.f64Ne();
      } else {
        if (values.elemVal.kind !== "ref") throw new Error("ref-kind all element without a ref valtype");
        c.structGet(promT, PROM_REF);
        c.refCast(values.elemVal.typeIndex);
      }
      c.call(this.vecs.set(values));
    }
    c.localGet(ST);
    c.localGet(ST);
    c.structGet(stateT, ALL_REMAINING);
    c.i32Const(1);
    c.i32Sub();
    c.structSet(stateT, ALL_REMAINING);
    c.localGet(ST);
    c.structGet(stateT, ALL_REMAINING);
    c.i32Eqz();
    c.ifVoid();
    c.localGet(ST);
    c.structGet(stateT, ALL_RESULT);
    this.pushAllFulfilment(
      c,
      values === null
        ? null
        : () => {
            c.localGet(ST);
            c.structGet(stateT, ALL_VALUES);
          },
    );
    c.i32Const(1);
    c.call(this.proms.settle());
    c.end();
    this.mb.setBody(
      idx,
      [
        { kind: "ref", nullable: true, typeIndex: entryT },
        this.proms.allStateRef(),
        this.proms.promRef(),
      ],
      c.bytes(),
    );
    return idx;
  }

  /** `Promise.all(ps)`'s body, interned per (entries, values) pair: mint,
   * pre-size the values array to the entry count, and subscribe one
   * reaction per entry in INPUT order (each carrying its index, which is
   * what makes the result input-ordered).
   *
   * Only an EMPTY all can be complete when the loop ends: reactions are
   * microtasks, so none has run yet, which is exactly why the spec's
   * "+1 for the iteration" needs no counterpart here. */
  private promiseAllFor(entries: VecInfo, values: VecInfo | null): number {
    const key = `${entries.key}|${values?.key ?? "void"}`;
    const hit = this.allFns.get(key);
    if (hit !== undefined) return hit;
    const promRef = this.proms.promRef();
    const idx = this.mb.declareFunc(
      this.mb.funcType([this.vecs.vecRef(entries)], [promRef]),
      `%w.async.all:${key}`,
    );
    this.allFns.set(key, idx);
    const rx = this.allReactionFor(values);
    const stateT = this.proms.allStateT;
    const entryT = this.proms.allEntryT;
    const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.resumeClosPair().clos };
    const c = new Code();
    const PS = 0, RESULT = 1, N = 2, ST = 3, I = 4, CLOS = 5, P = 6;
    c.call(this.proms.mint());
    c.localSet(RESULT);
    c.localGet(PS);
    c.structGet(entries.struct, 0); // the vector's length field
    c.localSet(N);
    c.localGet(N);
    c.localGet(RESULT);
    if (values === null) {
      c.refNull(ANY_HEAP);
    } else {
      c.localGet(N);
      c.f64ConvertI32S();
      c.call(this.vecs.newLen(values));
    }
    c.structNew(stateT);
    c.localSet(ST);
    this.pushReactionClosure(c, rx);
    c.localSet(CLOS);
    c.i32Const(0);
    c.localSet(I);
    c.loop();
    c.localGet(I);
    c.localGet(N);
    c.i32LtS();
    c.ifVoid();
    c.localGet(PS);
    c.localGet(I);
    c.f64ConvertI32S();
    c.call(this.vecs.get(entries));
    c.localSet(P);
    c.localGet(P);
    c.localGet(CLOS);
    c.localGet(ST);
    c.localGet(I);
    c.f64ConvertI32S();
    c.localGet(P);
    c.structNew(entryT);
    c.call(this.proms.subscribeHandled());
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(1);
    c.end();
    c.end();
    c.localGet(N);
    c.i32Eqz();
    c.ifVoid();
    c.localGet(RESULT);
    this.pushAllFulfilment(
      c,
      values === null
        ? null
        : () => {
            c.localGet(ST);
            c.structGet(stateT, ALL_VALUES);
          },
    );
    c.i32Const(1);
    c.call(this.proms.settle());
    c.end();
    c.localGet(RESULT);
    this.mb.setBody(idx, [promRef, I32, this.proms.allStateRef(), I32, closRef, promRef], c.bytes());
    return idx;
  }

  private emitPromiseAll(e: Extract<IrExpr, { kind: "intrinsic" }>): void {
    const code = this.fn.code;
    const arg = e.args[0]!;
    if (arg.type.kind !== "array" || e.type.kind !== "promise") {
      throw new Error("promise.all outside its validated shape");
    }
    const entries = this.vecInfoFor(arg.type, e.loc);
    let values: VecInfo | null = null;
    if (e.type.inner.kind === "array") {
      values = this.vecInfoFor(e.type.inner, e.loc);
      if (values === null) {
        code.unreachable();
        return;
      }
    } else if (e.type.inner.kind !== "void") {
      this.refuse(`intrinsic:promise.all:${e.type.inner.kind}`, e.loc);
      code.unreachable();
      return;
    }
    if (entries === null) {
      code.unreachable();
      return;
    }
    const fn = this.promiseAllFor(entries, values);
    this.walkExpr(arg);
    code.call(fn);
  }

  /** One Promise.race entry settling — the spec's pair of capability
   * callbacks. A rejection copies raw (a reason is not the inner type); a
   * fulfilment converts the payload to the RESULT's inner type first,
   * which is what `adapt` means below and the only reason a race reaction
   * is interned per (from, to) rather than once. */
  private raceReactionFor(from: IrType, to: IrType, loc: SrcLoc): number | null {
    const key = typeEquals(from, to) ? "copy" : `${typeKey(from)}=>${typeKey(to)}`;
    const hit = this.raceRxFns.get(key);
    if (hit !== undefined) return hit;
    // Plan the whole conversion before declaring anything: an entry the
    // adapter cannot express refuses by name and emits no function.
    let adapt: ((c: Code, src: number) => void) | null = null;
    if (key === "copy") {
      adapt = null; // the settleFrom path below
    } else if (to.kind !== "union") {
      // The frontend fences entries to the result type, one of its arms,
      // or a sub-union of it — all three need a union result.
      this.refuse(`intrinsic:promise.race:adapt:${to.kind}`, loc);
      return null;
    } else if (from.kind === "union") {
      const plan = this.raceRetagPlan(from.unionId, to.unionId, loc);
      if (plan === null) return null;
      adapt = (c, src) => this.emitRaceRetag(c, src, plan);
    } else {
      const tag = this.unionArmTag(to.unionId, from);
      if (tag < 0) {
        this.refuse(`intrinsic:promise.race:adapt:arm:${from.kind}`, loc);
        return null;
      }
      if (isUnitType(from)) {
        const g = this.unions.unitGlobal(tag);
        adapt = (c) => c.globalGet(g);
      } else {
        const arm = this.unionArmStruct(to.unionId, tag, loc);
        if (arm === null) return null;
        adapt = (c, src) => {
          c.i32Const(tag);
          if (!this.emitSettledPayload(c, from, () => c.localGet(src), "intrinsic:promise.race:adapt", loc)) {
            c.unreachable();
            return;
          }
          c.structNew(arm);
        };
      }
    }

    const pair = this.resumeClosPair();
    const idx = this.mb.declareFunc(pair.fn, `%w.async.raceRx:${this.raceRxFns.size}`);
    this.raceRxFns.set(key, idx);
    const promT = this.proms.promT;
    const entryT = this.proms.raceEntryT;
    const c = new Code();
    const E = 2, DST = 3, SRC = 4;
    c.localGet(1);
    c.refCast(entryT);
    c.localSet(E);
    c.localGet(E);
    c.structGet(entryT, RACEE_DST);
    c.localSet(DST);
    c.localGet(E);
    c.structGet(entryT, RACEE_SRC);
    c.localSet(SRC);
    if (adapt === null) {
      // Same inner type: the whole outcome moves across unread, state
      // included, so one call serves both fulfilment and rejection.
      c.localGet(DST);
      c.localGet(SRC);
      c.call(this.proms.settleFrom());
    } else {
      c.localGet(SRC);
      c.structGet(promT, PROM_STATE);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.localGet(DST);
      c.localGet(SRC);
      c.call(this.proms.settleFrom());
      c.return_();
      c.end();
      c.localGet(DST);
      c.i32Const(EXC_REF);
      c.f64Const(0);
      adapt(c, SRC);
      c.i32Const(-1);
      c.i32Const(1);
      c.call(this.proms.settle());
    }
    this.mb.setBody(
      idx,
      [{ kind: "ref", nullable: true, typeIndex: entryT }, this.proms.promRef(), this.proms.promRef()],
      c.bytes(),
    );
    return idx;
  }

  /** A sub-union entry's arm-by-arm re-tagging into the result union.
   * Same problem as emitSettledUnion's: two interned unions number their
   * arms independently, so every arm is looked up BY TYPE and rebuilt
   * under the result's tag. Null (refusal recorded) when an arm has no
   * counterpart or no representation. */
  private raceRetagPlan(
    fromId: string,
    toId: string,
    loc: SrcLoc,
  ): { tag: number; outTag: number; inArm: number | null; outArm: number | null }[] | null {
    const plan: { tag: number; outTag: number; inArm: number | null; outArm: number | null }[] = [];
    for (const [i, arm] of this.unionDef(fromId).arms.entries()) {
      const outTag = this.unionArmTag(toId, arm);
      if (outTag < 0) {
        this.refuse(`intrinsic:promise.race:adapt:arm:${arm.kind}`, loc);
        return null;
      }
      if (isUnitType(arm)) {
        plan.push({ tag: i, outTag, inArm: null, outArm: null });
        continue;
      }
      const inArm = this.unionArmStruct(fromId, i, loc);
      const outArm = this.unionArmStruct(toId, outTag, loc);
      if (inArm === null || outArm === null) return null;
      plan.push({ tag: i, outTag, inArm, outArm });
    }
    return plan;
  }

  private emitRaceRetag(
    c: Code,
    src: number,
    plan: { tag: number; outTag: number; inArm: number | null; outArm: number | null }[],
  ): void {
    const baseRef = this.unions.baseRef();
    const base = this.unions.base();
    // The entry's fulfilment payload IS a union value (its inner type is a
    // union), so it reads back off the ref slot.
    const read = (): void => {
      c.localGet(src);
      c.structGet(this.proms.promT, PROM_REF);
      c.refCast(base);
    };
    for (const arm of plan) {
      read();
      c.structGet(base, 0);
      c.i32Const(arm.tag);
      c.i32Eq();
      c.ifResult(baseRef);
      if (arm.inArm === null || arm.outArm === null) {
        c.globalGet(this.unions.unitGlobal(arm.outTag));
      } else {
        c.i32Const(arm.outTag);
        read();
        c.refCast(arm.inArm);
        c.structGet(arm.inArm, 1);
        c.structNew(arm.outArm);
      }
      c.else_();
    }
    c.unreachable();
    for (let i = 0; i < plan.length; i++) c.end();
  }

  private emitPromiseRace(e: Extract<IrExpr, { kind: "intrinsic" }>): void {
    const code = this.fn.code;
    if (e.type.kind !== "promise") throw new Error("promise.race outside its validated shape");
    const to = e.type.inner;
    // Every adapter resolves BEFORE any emission (unionDisc's rule): one
    // entry the tier cannot convert refuses the whole race.
    const reactions: number[] = [];
    for (const entry of e.args) {
      if (entry.type.kind !== "promise") throw new Error("promise.race entry is not a promise");
      const rx = this.raceReactionFor(entry.type.inner, to, e.loc);
      if (rx === null) {
        code.unreachable();
        return;
      }
      reactions.push(rx);
    }
    // EVERY entry evaluates before ANY of them is subscribed, because the
    // array literal is a separate expression from the call: an entry that
    // throws must leave its predecessors un-subscribed (and so NOT marked
    // handled), which interleaving the two loops would get wrong.
    const promRef = this.proms.promRef();
    const held: number[] = [];
    for (const entry of e.args) {
      const slot = this.acquireScratch(promRef);
      this.walkExpr(entry);
      code.localSet(slot);
      held.push(slot);
    }
    const result = this.acquireScratch(promRef);
    code.call(this.proms.mint());
    code.localSet(result);
    for (const [i, slot] of held.entries()) {
      code.localGet(slot);
      this.pushReactionClosure(code, reactions[i]!);
      code.localGet(result);
      code.localGet(slot);
      code.structNew(this.proms.raceEntryT);
      code.call(this.proms.subscribeHandled());
    }
    code.localGet(result);
    this.releaseScratch(promRef, result);
    for (const slot of held) this.releaseScratch(promRef, slot);
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

  private inspF64Func: number | null = null;

  /** %w.inspF64(f64) → str — util.inspect's one number-ism (scr_insp_f64):
   * JS ToString except -0 prints "-0". Console number formatting, both
   * for direct f64 args and through the per-union format helpers. */
  private inspF64Helper(): number {
    if (this.inspF64Func !== null) return this.inspF64Func;
    const idx = this.mb.declareFunc(this.mb.funcType([F64], [this.strRef]), "%w.inspF64");
    this.inspF64Func = idx;
    const c = new Code();
    c.localGet(0);
    c.i64ReinterpretF64();
    c.i64Const(BigInt.asIntN(64, 1n << 63n));
    c.i64Eq();
    c.ifResult(this.strRef);
    this.pushStrLitInto(c, "-0");
    c.else_();
    c.localGet(0);
    c.call(this.f64ToStrHelper());
    c.end();
    this.mb.setBody(idx, [], c.bytes());
    return idx;
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

  private errToStrFunc: number | null = null;

  /** %w.err.toStr(errT) → str — scr_error_to_string ported: ECMA-262
   * Error.prototype.toString over the two fields, except that a code
   * starting "ERR_" renders Node's own "name [code]: message" (the
   * AssertionError / NodeError spelling). Two arms of the C are dead on
   * this tier and transcribed anyway, so they land right when they become
   * reachable: nothing in tier mints an ERR_ code yet (the fences stamp
   * SC#### codes, and the assert surface still refuses), and the NULL
   * field tests cannot fire because the IR types name and message
   * `string` — a reached error always carries two real arrays. */
  private errToStrHelper(): number {
    if (this.errToStrFunc !== null) return this.errToStrFunc;
    const exc = this.exc();
    const errRef: ValType = { kind: "ref", nullable: true, typeIndex: exc.errT };
    const idx = this.mb.declareFunc(this.mb.funcType([errRef], [this.strRef]), "%w.err.toStr");
    this.errToStrFunc = idx;
    const c = new Code();
    const E = 0, N = 1, M = 2, K = 3, A = 4, R = 5;
    const cat = (push: () => void): void => {
      c.localGet(R);
      push();
      c.call(this.concatHelper());
      c.localSet(R);
    };
    c.localGet(E);
    c.structGet(exc.errT, 1);
    c.localSet(N);
    c.localGet(E);
    c.structGet(exc.errT, 2);
    c.localSet(M);
    c.localGet(E);
    c.structGet(exc.errT, 3);
    c.localSet(K);
    // assertion = the code slot is present and starts "ERR_".
    c.localGet(K);
    c.refIsNull();
    c.ifResult(I32);
    c.i32Const(0);
    c.else_();
    c.localGet(K);
    this.pushStrLitInto(c, "ERR_");
    c.i32Const(0);
    c.call(this.strs.matchAt());
    c.end();
    c.localSet(A);
    // An empty name answers with the message alone; an empty message (no
    // bracket to render) answers with the name alone.
    c.localGet(N);
    c.arrayLen();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(M);
    c.return_();
    c.end();
    c.localGet(A);
    c.i32Eqz();
    c.localGet(M);
    c.arrayLen();
    c.i32Eqz();
    c.i32And();
    c.ifVoid();
    c.localGet(N);
    c.return_();
    c.end();
    c.localGet(N);
    c.localSet(R);
    c.localGet(A);
    c.ifVoid();
    cat(() => this.pushStrLitInto(c, " ["));
    cat(() => c.localGet(K));
    cat(() => this.pushStrLitInto(c, "]"));
    c.end();
    cat(() => this.pushStrLitInto(c, ": "));
    cat(() => c.localGet(M));
    c.localGet(R);
    this.mb.setBody(idx, [this.strRef, this.strRef, this.strRef, I32, this.strRef], c.bytes());
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
