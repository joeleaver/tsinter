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
  IrStmt,
  IrType,
  SrcLoc,
} from "../../ir/nodes.js";
import { EXPORT_ENTRY, EXPORT_MEMORY, FD_STDERR, FD_STDOUT, IMPORT_MODULE, IMPORT_WRITE } from "./abi.js";
import { ByteWriter } from "./bytes.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";
import { WasmUnsupportedError } from "./unsupported.js";

export { WasmUnsupportedError } from "./unsupported.js";

/** What the walk does with a construct outside the tier. The emit sink
 * throws (so everything after a refusal is unreachable on that path); the
 * survey sink records and lets the walk continue over placeholders. */
type Refuse = (kind: string, loc?: SrcLoc) => void;

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

/* ── instruction bytes ─────────────────────────────────────────────────── */

/** The instruction-level opcode knowledge, one method per instruction the
 * tier emits. Declaration-level bytes live in ModuleBuilder; integer
 * encodings in ByteWriter. */
class Code {
  readonly w = new ByteWriter();

  bytes(): Uint8Array {
    return this.w.bytes();
  }

  unreachable(): void {
    this.w.u8(0x00);
  }
  loop(): void {
    this.w.u8(0x03);
    this.w.u8(0x40); // void block type
  }
  ifVoid(): void {
    this.w.u8(0x04);
    this.w.u8(0x40);
  }
  else_(): void {
    this.w.u8(0x05);
  }
  end(): void {
    this.w.u8(0x0b);
  }
  br(depth: number): void {
    this.w.u8(0x0c);
    this.w.uleb(depth);
  }
  brIf(depth: number): void {
    this.w.u8(0x0d);
    this.w.uleb(depth);
  }
  return_(): void {
    this.w.u8(0x0f);
  }
  call(funcIndex: number): void {
    this.w.u8(0x10);
    this.w.uleb(funcIndex);
  }
  drop(): void {
    this.w.u8(0x1a);
  }
  localGet(i: number): void {
    this.w.u8(0x20);
    this.w.uleb(i);
  }
  localSet(i: number): void {
    this.w.u8(0x21);
    this.w.uleb(i);
  }
  globalGet(i: number): void {
    this.w.u8(0x23);
    this.w.uleb(i);
  }
  globalSet(i: number): void {
    this.w.u8(0x24);
    this.w.uleb(i);
  }
  i32Store8(): void {
    this.w.u8(0x3a);
    this.w.uleb(0); // alignment (2^0 — byte access)
    this.w.uleb(0); // offset
  }
  memorySize(): void {
    this.w.u8(0x3f);
    this.w.uleb(0);
  }
  memoryGrow(): void {
    this.w.u8(0x40);
    this.w.uleb(0);
  }
  i32Const(n: number): void {
    this.w.u8(0x41);
    this.w.sleb(n);
  }
  f64Const(v: number): void {
    this.w.u8(0x44);
    this.w.f64(v);
  }
  i32Eq(): void {
    this.w.u8(0x46);
  }
  i32GtU(): void {
    this.w.u8(0x4b);
  }
  i32GeU(): void {
    this.w.u8(0x4f);
  }
  i32Add(): void {
    this.w.u8(0x6a);
  }
  i32Sub(): void {
    this.w.u8(0x6b);
  }
  i32Shl(): void {
    this.w.u8(0x74);
  }
  i32ShrU(): void {
    this.w.u8(0x76);
  }
  refNull(typeIndex: number): void {
    this.w.u8(0xd0);
    this.w.sleb(typeIndex);
  }
  arrayNewData(typeIndex: number, dataIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x09);
    this.w.uleb(typeIndex);
    this.w.uleb(dataIndex);
  }
  arrayGetU(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x0d);
    this.w.uleb(typeIndex);
  }
  arrayLen(): void {
    this.w.u8(0xfb);
    this.w.uleb(0x0f);
  }
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
  /** Scratch locals for console staging, pooled per type so log-heavy
   * functions don't grow a local per call site. */
  scratchFree: Map<string, number[]>;
}

const utf8 = new TextEncoder();

/* ── the assembler: one walk, both sinks ───────────────────────────────── */

class Assembler {
  private readonly mb = new ModuleBuilder();
  private readonly globalById = new Map<string, IrGlobal>();
  private readonly globalWasmIndex = new Map<string, number>();
  private readonly funcIndexByName = new Map<string, number>();
  private readonly funcByName = new Map<string, IrFunction>();
  private readonly bytesType: number;
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
    this.bytesType = this.mb.arrayType("i8", false);
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
  }

  run(): void {
    // The two whole-module emission modes: library mode replaces main with
    // the profile's exported symbols, and the island's embedded npm graph
    // is an engine embedding. Neither has a use-site construct to refuse
    // at, so both are gated here.
    if (this.mod.lib !== undefined) this.refuse("module:lib");
    if (this.mod.embedded !== undefined) this.refuse("module:embedded");

    // Pass 1: indices for every function, so bodies can call forward.
    // Signatures use the SOFT type map here (placeholder i32 for what the
    // tier can't represent); the honest gate runs after each body walk.
    for (const fn of this.mod.functions) {
      const params = fn.params.map((p) => this.mapTypeSoft(p.type));
      const results = fn.returnType.kind === "void" ? [] : [this.mapTypeSoft(fn.returnType)];
      this.funcIndexByName.set(fn.name, this.mb.declareFunc(this.mb.funcType(params, results), fn.name));
      this.funcByName.set(fn.name, fn);
    }

    for (const fn of this.mod.functions) this.walkFunction(fn);

    const entry = this.funcIndexByName.get(this.mod.entry);
    if (entry === undefined) throw new Error(`entry function "${this.mod.entry}" not in module`);
    this.mb.exportFunc(EXPORT_ENTRY, entry);
    this.mb.exportMemory(EXPORT_MEMORY);
  }

  finish(): Uint8Array {
    return this.mb.emit();
  }

  /* ── types ──────────────────────────────────────────────────────────── */

  /** The tier's value representations: f64 as itself, bool as i32, string
   * as an immutable (array i8) of UTF-8 bytes (nullable in binding
   * positions — a refcounted local is NULL until its first assign, and
   * the frontend's definite-assignment guarantee means no read observes
   * it). Everything else is unrepresented work. */
  private mapType(t: IrType, loc: SrcLoc | undefined): ValType | null {
    switch (t.kind) {
      case "f64":
        return F64;
      case "bool":
        return I32;
      case "string":
        return { kind: "ref", nullable: true, typeIndex: this.bytesType };
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
        return { kind: "ref", nullable: true, typeIndex: this.bytesType };
      default:
        return I32;
    }
  }

  /* ── functions ──────────────────────────────────────────────────────── */

  private walkFunction(fn: IrFunction): void {
    // Whole-function shapes, tested BEFORE the body: each needs machinery
    // the module has no answer for yet (a fiber/state-machine lowering for
    // async and generators, a closure environment for captures), so the
    // constructs inside the body are not what blocks the function and must
    // not be reported as though they were.
    if (fn.async === true) this.refuse("fn:async", fn.loc);
    if (fn.generator !== undefined) this.refuse("fn:generator", fn.loc);
    if (fn.captures !== undefined && fn.captures.length > 0) this.refuse("fn:captures", fn.loc);

    const localIndex = new Map<string, number>();
    const localById = new Map<string, IrLocal>();
    for (const l of fn.locals) localById.set(l.id, l);
    fn.params.forEach((p, i) => localIndex.set(p.localId, i));
    const localsOut: ValType[] = [];
    for (const l of fn.locals) {
      if (localIndex.has(l.id)) continue; // a param — already indexed
      localIndex.set(l.id, fn.params.length + localsOut.length);
      localsOut.push(this.mapTypeSoft(l.type));
    }
    this.fn = { fn, code: new Code(), localIndex, localById, localsOut, scratchFree: new Map() };

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
      case "varDecl":
        // Declared-uninitialized needs nothing: wasm locals are zeroed and
        // the frontend's definite-assignment guarantee (see IrStmt varDecl)
        // means no read precedes the first assign.
        if (s.init !== null) this.storeVar(s.localId, s.init, s.loc);
        return;
      case "assign":
        this.storeVar(s.localId, s.value, s.loc);
        return;
      case "return":
        if (s.value !== null) this.walkExpr(s.value);
        code.return_();
        return;
      case "if":
        this.walkExpr(s.cond);
        code.ifVoid();
        this.walkBody(s.then);
        if (s.else_ !== null) {
          code.else_();
          this.walkBody(s.else_);
        }
        code.end();
        return;

      /* Structured control flow: wasm's own block/loop/br_if nesting covers
       * much of it, but each form still needs its own lowering (switch a
       * br_table, the labeled forms a depth-indexed break target). */
      case "while":
      case "doWhile":
      case "switch":
      case "for":
      case "forOf":
      case "break":
      case "continue":
      case "block":
      /* Stores into composites — each waits on the GC representation of the
       * thing being written. */
      case "arraySet":
      case "bytesSet":
      case "fieldSet":
      case "recordSet":
      case "recordKeySet":
      case "recordKeyDelete":
      /* The exception protocol (wasm exception handling, or a lowered
       * pending-flag unwind like the other two backends run). */
      case "throw":
      case "rethrow":
      case "tryCatch":
      case "runtimeFence":
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

  /** A local or global write — assign and initializing varDecl share it.
   * Globals live in the "%g." namespace (IrGlobal docs) and get their wasm
   * slot lazily, right here at first use. */
  private storeVar(localId: string, value: IrExpr, loc: SrcLoc): void {
    this.walkExpr(value);
    const global = this.globalById.get(localId);
    if (global !== undefined) {
      this.fn.code.globalSet(this.globalIndex(global, loc));
      return;
    }
    if (this.gateBoxed(localId, loc)) {
      this.fn.code.drop(); // survey path: the value was already pushed
      return;
    }
    this.fn.code.localSet(this.localIndex(localId));
  }

  /** Nested statement bodies of REFUSED statements. Only the survey path
   * reaches this — the emit sink threw above. Exhaustive like the dispatch
   * it follows, so a new container kind cannot silently hide its body from
   * the survey. (Implemented containers walk their bodies inline in
   * walkStmt and return before this.) */
  private walkNested(s: IrStmt): void {
    switch (s.kind) {
      case "while":
      case "doWhile":
      case "forOf":
      case "block":
        this.walkBody(s.body);
        break;
      case "for":
        if (s.init !== null) this.walkStmt(s.init);
        if (s.update !== null) this.walkStmt(s.update);
        this.walkBody(s.body);
        break;
      case "switch":
        for (const c of s.cases) this.walkBody(c.body);
        break;
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
      case "strLit":
        this.pushStrLit(e.value);
        return;
      case "varRef": {
        const global = this.globalById.get(e.localId);
        if (global !== undefined) {
          code.globalGet(this.globalIndex(global, e.loc));
          return;
        }
        if (this.gateBoxed(e.localId, e.loc)) {
          code.unreachable(); // survey path: stand in for the unread box
          return;
        }
        code.localGet(this.localIndex(e.localId));
        return;
      }
      case "call": {
        for (const a of e.args) this.walkExpr(a);
        const index = this.funcIndexByName.get(e.callee);
        if (index === undefined) throw new Error(`call to unknown function "${e.callee}"`);
        code.call(index);
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

      /* Scalars and operators. */
      case "numLit":
      case "unitLit":
      case "selfRef":
      case "bin":
      case "unary":
      case "incDec":
      case "fieldIncDec":
      case "assignExpr":
      case "toBool":
      case "logical":
      case "ternary":
      case "nullish":
      case "orDefault":
      case "seqExpr":
      /* Strings: the intrinsic surface over the GC byte array. */
      case "strConcat":
      case "strEq":
      case "strCmp":
      case "toString":
      case "templateStrings":
      case "strIntrinsic":
      /* Optional chaining's two halves (the receiver stash and the guard). */
      case "optChain":
      case "chainRecv":
      /* Regex — a whole engine, host-imported or compiled. */
      case "regexLit":
      case "regexIntrinsic":
      /* Arrays, typed arrays, and the keyed collections. */
      case "arrayLit":
      case "arrayNewLen":
      case "arrayGet":
      case "arrIntrinsic":
      case "bytesNew":
      case "bytesIntrinsic":
      case "mapNew":
      case "mapIntrinsic":
      case "setNew":
      case "setIntrinsic":
      /* Function values. */
      case "ffiCall":
      case "closure":
      case "callValue":
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
      case "recordLit":
      case "recordGet":
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

  /** Boxed (captured/TDZ) locals live in shared heap boxes the tier has no
   * representation for yet — the use-site twin of fn:captures, for the
   * DECLARING side. Returns true when the access was refused; the caller
   * keeps the survey path's stack shape (storeVar drops the value it
   * already pushed, varRef pushes the placeholder instead). */
  private gateBoxed(localId: string, loc: SrcLoc): boolean {
    const local = this.fn.localById.get(localId);
    if (local?.boxed !== true) return false;
    this.refuse("local:boxed", loc);
    return true;
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
    const bytesType = this.bytesType;
    const index = this.mb.addGlobal(type, true, (w) => {
      switch (type.kind) {
        case "i32":
          w.u8(0x41);
          w.sleb(0);
          break;
        case "f64":
          w.u8(0x44);
          w.f64(0);
          break;
        case "ref":
          w.u8(0xd0);
          w.sleb(bytesType);
          break;
      }
    });
    this.globalWasmIndex.set(g.id, index);
    return index;
  }

  private pushStrLit(value: string): void {
    const bytes = utf8.encode(value);
    const offset = this.mb.internData(bytes);
    const code = this.fn.code;
    code.i32Const(offset);
    code.i32Const(bytes.length);
    code.arrayNewData(this.bytesType, 0);
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
      if (t === "string") {
        const local = this.acquireScratch({ kind: "ref", nullable: true, typeIndex: this.bytesType });
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
        code.ifVoid();
        this.pushStrLit("true");
        code.call(helpers.stage);
        code.else_();
        this.pushStrLit("false");
        code.call(helpers.stage);
        code.end();
      }
    });
    code.i32Const(0x0a);
    code.call(helpers.putc);
    code.i32Const(fd);
    code.call(helpers.flush);
    for (const s of staged) {
      if (s !== null) this.releaseScratch(s.kind === "str" ? { kind: "ref", nullable: true, typeIndex: this.bytesType } : I32, s.local);
    }
  }

  private scratchKey(t: ValType): string {
    return t.kind === "ref" ? `ref:${t.typeIndex}` : t.kind;
  }

  private acquireScratch(t: ValType): number {
    const pool = this.fn.scratchFree.get(this.scratchKey(t));
    const free = pool?.pop();
    if (free !== undefined) return free;
    const index = this.fn.fn.params.length + this.fn.localsOut.length;
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
    const bytesRef: ValType = { kind: "ref", nullable: true, typeIndex: this.bytesType };

    const stage = this.mb.declareFunc(this.mb.funcType([bytesRef], []), "%w.stage");
    {
      const c = new Code();
      const LEN = 1; // locals after the 1 param
      const I = 2;
      c.localGet(0);
      c.arrayLen();
      c.localSet(LEN);
      this.emitEnsureCapacity(c, () => c.localGet(LEN));
      // for (i = 0; i < len; i++) mem[cursor + i] = arr[i]
      c.i32Const(0);
      c.localSet(I);
      c.loop();
      {
        c.localGet(I);
        c.localGet(LEN);
        c.i32GeU();
        c.ifVoid();
        c.else_(); // continue below the guard: if (i >= len) fall through
        c.globalGet(this.cursorGlobal);
        c.localGet(I);
        c.i32Add();
        c.localGet(0);
        c.localGet(I);
        c.arrayGetU(this.bytesType);
        c.i32Store8();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(1); // back to the loop head
        c.end();
      }
      c.end();
      c.globalGet(this.cursorGlobal);
      c.localGet(LEN);
      c.i32Add();
      c.globalSet(this.cursorGlobal);
      this.mb.setBody(stage, [I32, I32], c.bytes());
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
