/* The width-copy pass's shared types and state (SEMANTICS.md S125; the
 * pass's entry and its overview are width-copies.ts). WidthCx is the one
 * context every phase takes as its first argument: what used to be the
 * pass's closure state, its mutable cursors included. */
import type { IrExpr, IrFunction, IrType, SrcLoc } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

export type Mode = "t" | "r" | "w";

/** How a binding's one use treats the value: a plain read (a field or
 * element read, a length, a loop over it, a truth or null test), a key
 * observer, a print observer, a copy taken from it, or anything else. */
export type Use = "read" | "keys" | "print" | "copy" | "other";

export interface Site {
  callee: string;
  arg: IrExpr | undefined;
  loc: SrcLoc;
  where: string;
  /** The index of the function body's top-level statement holding it. */
  top: number;
  /** Where the copy lands: a binding (and whether it is a parameter, which
   * no statement assigns), or null. */
  dest: { key: string; param: boolean } | null;
}

/** A dynamic crossing (S125 (c)): "in" copies typed `t` into a dynamic
 * value, "out" copies a dynamic value into typed `t`. `consumed`: the
 * crossing's result is only read at once (nothing holds it). */
export interface DynSite extends Site {
  dir: "in" | "out";
  t: IrType;
  consumed: boolean;
  /** An out-crossing that builds (part of) a `return` statement's value. */
  atReturn?: boolean;
  /** An out-crossing into a sequence expression's own temporary: the
   * sequence node, outside which the copy is never read. */
  scope?: unknown;
  /** An out-crossing whose copy (or a part read straight off it)
   * initializes a local: that local, and the statement list holding its
   * declaration with the declaration's index. */
  holder?: { key: string; list: unknown[]; index: number } | undefined;
  /** The crossing's own IR node (the dynamic copy, for an in-crossing). */
  node: IrExpr;
  /** GH #222: an out-crossing printed, serialized or key-listed right where
   * it is made. */
  observedAt?: boolean;
}

/** While an out-crossing's copy is alive: the functions that can run,
 * and (when the copy lives inside one node of its own function) that node. */
export interface DynWindow {
  fns: Set<string>;
  inside: unknown[] | null;
}

/** Where one use of a binding sits: its function, the kinded parent that uses it (past
 * any pass-through check), the parent's key holding it, and the parent's
 * direct child on that path (the varRef itself, or the check wrapping it). */
export interface UseSite {
  /** The function the use is in. */
  fn: string;
  up: Record<string, unknown>;
  key: string;
  child: unknown;
}

export interface Binding {
  uses: Use[];
  /** Each use's site, in step with `uses` (S125-J's readonly-copy
   * judgement, readonly-copies.ts, follows them one by one). */
  useAt: UseSite[];
  /** For each use that READS a part of the value (`b.f`, `b.f.g`,
   * `b[i]`): the part's type and how that part is used. */
  parts: { t: IrType; use: Use; via?: string }[];
  assigns: IrExpr[];
  captured: boolean;
  /** How many of the "other" uses are a field write ON the value
   * (`b.f = v`: the receiver of a recordSet), which neither prints it nor
   * lists its keys (GH #148's spread judgement). */
  fieldWrites?: number;
}

/** Which dynamic values may be the same object (dynAliasClasses). */
export interface DynAliasClasses {
  same: (a: IrExpr, fa: string, b: IrExpr, fb: string) => boolean;
  holders: (e: IrExpr, fn: string) => string[];
  callees: (e: IrExpr, fn: string) => string[] | null;
}

/** The pass's shared state, one per widthCopyPass run. The collection walk
 * (width-collect.ts) fills the site lists, the write and identity notes
 * and the per-binding uses; the reach phases (width-reach.ts) fill the
 * reach, ctor-leak and value-function sets; the judgements read them all.
 * The memo maps fill lazily as the judgements ask. */
export interface WidthCx {
  readonly L: Lowerer;
  /** The finished function list the pass runs over. */
  readonly functions: IrFunction[];
  readonly byName: Map<string, IrFunction>;
  /** `%<class>.`: the name prefix of each class's methods. */
  readonly classPrefixes: string[];
  /** The ids of the program's globals (bkey keys them program-wide). */
  readonly globals: Set<string>;
  readonly sites: Site[];
  /** `record:<shape>:<field>` / `record:<shape>:*`, `object:<root class>:<field>`,
   * and array type keys (the spine or its elements written in place). */
  readonly written: Map<string, { fn: string; top: number }[]>;
  readonly ctorWritten: Set<string>;
  readonly identity: Set<string>;
  readonly escaped: { t: IrType; w: boolean; view: boolean; spec: boolean }[];
  readonly escapedKeys: Set<string>;
  /** Dynamic crossings (S125 (c)): every dynFrom of a value that holds a
   * reference, every dynCheck into one, and every typed function boxed
   * into a dynamic value. */
  readonly dynSites: DynSite[];
  /** GH #148 (review): island spread literals (`{ ...x }` over a dynamic
   * source) checked into a declared record shape that may lack some of
   * their keys — the record keeps only its own fields. */
  readonly spreadExits: { t: IrType; arms: IrType[]; loc: SrcLoc; dest: Site["dest"] }[];
  /** Writes to dynamic values: where, and the receiver when one is known. */
  readonly dynWrites: { fn: string; top: number; recv: IrExpr | null; anc: unknown[]; method?: string; key?: string }[];
  /** The program compares dynamic values by identity somewhere. */
  dynIdentity: boolean;
  /** Typed composites that entered the island as a view or a marshal
   * (U1a): with any dynamic identity operation in the program, each is
   * identity-observed — an island `===`, `includes`, `indexOf`, a Set or
   * Map key may compare it against a copy. Conservative by design. */
  readonly islandEntered: Set<string>;
  /** The dynamic operands of those comparisons (null: a comparison whose
   * operands are not followed — a Map/Set keyed by dynamic values). */
  readonly dynIdentityOps: ({ e: IrExpr; fn: string } | null)[];
  /** The functions handed to each function-value adapter (`%fn.adapt.N`). */
  readonly adapterArgs: Map<string, { e: IrExpr; fn: string }[]>;
  /** Can a dynamic call reach code this pass does not read? Without
   * `--dynamic` every dynamic function is a boxed program function (whose
   * body's writes are noted where they are) or a runtime method that only
   * reads its arguments; with it, an island function may be anything, so
   * handing it a dynamic value counts as a write. */
  readonly opaqueCalls: boolean;
  /** Per dynamic binding: how each use treats the value ("ro": read at
   * once, a scalar or a test taken from it; "other": anything else). */
  readonly dynUses: Map<string, ("ro" | "other")[]>;
  /** Per dynamic binding: each use as OWNERSHIP sees it — read at once,
   * the receiver of a write or a key/element search (with the values the
   * write stores), an out-crossing, or anything else. */
  readonly ownUses: Map<string, { use: "ro" | "recv" | "exit" | "other"; stored?: IrExpr[] }[]>;
  /** Where each dynamic binding is used (its function and top-level statement). */
  readonly useTops: Map<string, { fn: string; top: number }[]>;
  /** Per typed reference-holding binding: each use as ownership sees it —
   * a scalar read, a write in place (with the values it stores), a loop or
   * print or key listing that hands no reference on, a crossing, or
   * anything else. */
  readonly typedOwnUses: Map<string, { ok: boolean; stored?: IrExpr[] }[]>;
  /** Every closure: where it is made, what it captures, and whether it is
   * handed straight to an array callback loop (which runs it before
   * returning and keeps no hold of it). */
  readonly closureCaptures: { fnName: string; fn: string; captures: string[]; transient: boolean }[];
  /** refsOf's memo, by type key. */
  readonly refsMemo: Map<string, { refs: IrType[]; fns: (IrType & { kind: "func" })[] }>;
  readonly bindings: Map<string, Binding>;
  /** The function being visited. */
  curFn: string;
  /** In a constructor: its `this` parameter. */
  curThis: string | null;
  /** The top-level statement of the function being visited. */
  curTop: number;
  /** The function being visited builds a fresh value (BUILDER) or is an
   * array helper whose write is noted at its call (ARG_MUTATOR): its own
   * writes are not noted. */
  building: boolean;
  /** The kinded ancestors of the node being visited, with the key each
   * holds it under. */
  readonly stack: [Record<string, unknown>, string][];
  /** Key questions a lowering answered statically (a folded `in`) leave no
   * reference to the value in the IR: they count for every value of the
   * type, the copy's binding included. */
  readonly foldedKeys: Set<string>;
  /** `instanceof` likewise, asking for the class (printDiffer's question). */
  readonly foldedClass: Set<string>;
  /** Everything an escaped value can reach counts as observed; as written
   * too when the observer may write. */
  readonly reach: Set<string>;
  readonly reachW: Set<string>;
  /** The reach set reachType is filling. */
  into: Set<string>;
  /** GH #148's judgement by type, without U2b's own views (see escape). */
  readonly reachNoSpec: Set<string>;
  /** Do a view's stores into its typed value run? Only for a dynamic
   * store made through it, so only in a program with a dynamic write
   * (U1b). Settled by buildReachSets once collection is done. */
  viewWritesLive: boolean;
  /** The same as reachW, without view-factory escapes (S125 (c)'s
   * judgment: see escape). */
  readonly reachWDyn: Set<string>;
  /** A constructor that hands `this` to anything other than its own field
   * accesses (or its base constructor) lets the instance escape before
   * construction finishes: its writes count, and `new` is not fresh. */
  readonly ctorLeaks: Set<string>;
  /** The root classes whose constructors hold a copy site. */
  readonly siteInCtor: Set<string>;
  /** judgeDynSites is judging: isWritten applies S125 (c)'s view rule. */
  judgingDyn: boolean;
  /** retagArgsFresh's memo, by helper name. */
  readonly retagMemo: Map<string, boolean>;
  /** returnsFresh's memo, by function name. */
  readonly freshMemo: Map<string, boolean>;
  /** contains' memo: the type keys each type key contains. */
  readonly containsMemo: Map<string, Set<string>>;
  /** The functions the program makes a value of (a closure). */
  readonly valueFns: Set<string>;
  /** callReach's memo, by function name. */
  readonly reachMemo: Map<string, { fns: Set<string>; suspends: boolean }>;
}

/** The pass's state while judgeDynSites runs: the width state, the dynamic
 * alias classes, and the dynamic judgement's own memos. */
export interface DynJudgeCx extends WidthCx {
  /** returnsOwned's memo, by function name. */
  readonly returnsOwnedMemo: Map<string, boolean>;
  readonly alias: DynAliasClasses;
  /** accessorsDefined's memo. */
  accessorsMemo: boolean | null;
}

/** A fresh state for one run of the pass over `functions` (`byName`
 * indexes them). */
export function newWidthCx(L: Lowerer, functions: IrFunction[], byName: Map<string, IrFunction>): WidthCx {
  const reach = new Set<string>();
  return {
    L,
    functions,
    byName,
    classPrefixes: [...L.classes.keys()].map((c) => `%${c}.`),
    globals: new Set(L.globalsList.map((g) => g.id)),
    sites: [],
    written: new Map<string, { fn: string; top: number }[]>(),
    ctorWritten: new Set<string>(),
    identity: new Set<string>(),
    escaped: [],
    escapedKeys: new Set<string>(),
    dynSites: [],
    spreadExits: [],
    dynWrites: [],
    dynIdentity: false,
    islandEntered: new Set<string>(),
    dynIdentityOps: [],
    adapterArgs: new Map<string, { e: IrExpr; fn: string }[]>(),
    opaqueCalls: L.engine,
    dynUses: new Map<string, ("ro" | "other")[]>(),
    ownUses: new Map<string, { use: "ro" | "recv" | "exit" | "other"; stored?: IrExpr[] }[]>(),
    useTops: new Map<string, { fn: string; top: number }[]>(),
    typedOwnUses: new Map<string, { ok: boolean; stored?: IrExpr[] }[]>(),
    closureCaptures: [],
    refsMemo: new Map<string, { refs: IrType[]; fns: (IrType & { kind: "func" })[] }>(),
    bindings: new Map<string, Binding>(),
    curFn: "",
    curThis: null,
    curTop: 0,
    building: false,
    stack: [],
    foldedKeys: new Set<string>(),
    foldedClass: new Set<string>(),
    reach,
    reachW: new Set<string>(),
    into: reach,
    reachNoSpec: new Set<string>(),
    viewWritesLive: false,
    reachWDyn: new Set<string>(),
    ctorLeaks: new Set<string>(),
    siteInCtor: new Set<string>(),
    judgingDyn: false,
    retagMemo: new Map<string, boolean>(),
    freshMemo: new Map<string, boolean>(),
    containsMemo: new Map<string, Set<string>>(),
    valueFns: new Set<string>(),
    reachMemo: new Map<string, { fns: Set<string>; suspends: boolean }>(),
  };
}
