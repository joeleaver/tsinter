/* JS Map<K,V> and Set<T> over WasmGC: ONE compact-dict design (scr_map.c's
 * shape, ported) backs both surfaces — a Set is a Map whose value slot is
 * pinned to a constant f64 0, never read. Unlike scr_map.c's array-of-
 * ScrMapEntry (an allocation per entry), this backend uses PARALLEL DENSE
 * ARRAYS (keys/vals/live), the natural WasmGC translation of arrays.ts's
 * own len+buf vector shape: f64 keys/values sit UNPACKED in their arrays
 * (no boxing at all), and there is no per-entry heap object. Dense index i
 * denotes "entry i" across all three arrays identically — behaviorally
 * identical to the C layout, just Struct-of-Arrays instead of Array-of-
 * Structs. The bucket table (open addressing, i32 entry indices, -1 =
 * empty, linear probe `(i+1)&mask`, power-of-two size) is its own fourth
 * array, of ONE globally-shared element type (i32) regardless of key/value
 * representation.
 *
 * Struct layout (8 fields, no rc/trace/retain/release — WasmGC's real GC
 * deletes ALL of scr_map.c's C-side memory-management machinery; a map of
 * cycle-capable values needs no val_trace analog, the collector traces the
 * backing arrays like any other field):
 *   0 nentries  1 nlive  2 nbuckets  3 iterDepth
 *   4 keys (array<keyVal>)     5 vals (array<valStorage>)
 *   6 live (array<i8>)         7 buckets (array<i32>, globally-shared type)
 * Every array field is NON-NULLABLE — `new` allocates all four at
 * zero-length rather than leaving them null, so no read site ever needs a
 * null guard beyond the `nbuckets == 0` short-circuit find() already needs
 * for an empty map (mirrors arrays.ts's non-nullable BUF field + nullable
 * LOCAL-only scratch typing for the two-phase grow).
 *
 * SameValueZero key handling (measured against Node directly — see the
 * increment-17 report, not assumed from scr_map.c):
 *   - -0 normalizes to +0 IN STORAGE (Node: `m.set(-0,1); [...m.keys()]`
 *     reads back `[0]`) — canonicalized once, at set()'s write site.
 *   - NaN does NOT canonicalize in storage — Node PRESERVES whichever
 *     exact NaN bit pattern was first inserted (measured: a NaN built via
 *     DataView with a custom payload round-trips its own bits through
 *     `keys()`, and overwriting via set() with a DIFFERENT NaN payload
 *     keeps the ORIGINAL stored bits, matching the "overwrite touches the
 *     value only" invariant). scr_map.c's `scr_map_f64_bits` collapses
 *     every NaN to ONE canonical bit pattern before storing — a genuine
 *     C-lane-vs-Node divergence (undetected: no corpus program inspects
 *     NaN payload bits after a Map round-trip). This backend does NOT
 *     replicate that collapse: storage keeps the caller's NaN bits as-is,
 *     only -0 is normalized. See the increment-17 report for the full
 *     writeup — flagged for the C lane, not fixed there (out of scope).
 *   - Equality (used by find()'s probe) is therefore NOT bit equality: it
 *     is `f64Eq(a,b) | (isNaN(a) & isNaN(b))` — f64Eq alone already
 *     treats -0 == +0 (IEEE), and the OR-clause makes any two NaNs equal
 *     regardless of payload, matching SameValueZero exactly.
 *   - HASH must be consistent with that equality (equal keys MUST hash
 *     identically, or probing from a different bucket would never find an
 *     existing entry) — so hashing canonicalizes NaN to a fixed sentinel
 *     (unlike storage) purely for bucket placement; this canonicalization
 *     is internal-only and never observable, so its exact bit choice is
 *     free (unlike storage, which Node's behavior pins).
 *   - String keys: a simple polynomial rolling hash over UTF-16 code
 *     units (h = h*31 + unit) — NOT scr_map.c's FNV-1a-over-UTF-8; hash
 *     values are never observable (iteration order is insertion order,
 *     never hash order), only bucket-consistency matters. Equality is
 *     exact code-unit content compare (strEq, borrowed dep) — the S005
 *     collation order is a DIFFERENT predicate, not used here.
 *
 * Growth/compaction ports scr_map.c's policy whole (increment-17 brief
 * §0): entries capacity doubles from 8 (tracked via keysBuf's own
 * arrayLen(), no separate ecap field — arrays.ts's own precedent for
 * deriving capacity from the buffer rather than storing it twice);
 * buckets rebuild whenever nbuckets < 2*(nentries+1), starting at 16,
 * doubling; reserveAppend PREFERS compaction over growth when
 * `iterDepth==0 && nlive <= nentries/2 && nentries>0`. iterExit ALSO
 * opportunistically compacts on depth->0, but through a DIFFERENT gate,
 * not "the same way" (review P5) — it adds `nentries>=16` (skip
 * compacting a small map even when tombstone-heavy — not worth a
 * rebuild) and drops the `nentries>0` check (redundant once >=16 holds).
 * Compaction NEVER runs while iterDepth>0 — live-iteration (forEach)
 * desugars hold dense indices across user callbacks, and append-only
 * growth during iteration is what makes Node's mutate-during-forEach
 * semantics (measured: clear() mid-iteration tombstones in place,
 * appends after the clear are still visited) fall out for free.
 *
 * Every op below is interned per the FULL (key type, value type)
 * representation — a string built from emitter.ts's `mapInfoFor`
 * (`map(${vecKeyFor(keyType)},${vecKeyFor(valueType)})`), NOT the
 * coarser (keyKind, valKind) PAIR an earlier draft of this comment
 * claimed: two maps sharing a (keyKind, valKind) but differing in the
 * CONCRETE key/value type (e.g. `Map<string, Record1>` vs
 * `Map<string, Record2>`, both keyKind "str" / valKind "ref") must NOT
 * collapse onto one struct — that coarser collapse is exactly the bug
 * class review MAJOR-1 found and fixed (vecKeyFor's recursive map/set
 * arms). The brief's `%w.map.*:<kk>:<vk>` naming is a MNEMONIC for the
 * axes this file is generic over, not the literal cache key. Only
 * `find` and `rebuildBuckets` genuinely depend on keyKind alone (neither
 * ever touches vals); `compact` and `reserveAppend` copy/allocate the
 * vals array too and so depend on BOTH axes like everything else. The
 * val-kind axis (f64 | bool | ref) is generic on purpose: overflow maps
 * (stage B) will instantiate val kinds this file's own Map/Set surface
 * never does (dyn refs, func closures, nested map/set refs) — nothing
 * here assumes val is scalar or non-recursive. */
import { BUF, LEN } from "./arrays.js";
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type FieldType, type StorageType, type ValType } from "./module.js";

export type MapKeyKind = "f64" | "str";
/** How the VALUE is represented — f64/bool unpacked, everything else
 * (string, record, array, union, object, promise, classval, map, set,
 * dyn — anything mapType hands back as a ref) is one "ref" bucket: unlike
 * array elements, map values never need content equality or ToString
 * inside this runtime (no join/indexOf here), so string needs no separate
 * kind the way arrays.ts's ElemKind gives it one. */
export type MapValKind = "f64" | "bool" | "ref";

export interface MapInfo {
  key: string;
  keyKind: MapKeyKind;
  valKind: MapValKind;
  keyVal: ValType;
  valVal: ValType;
  valStorage: StorageType;
  struct: number;
  keysBufType: number;
  valsBufType: number;
  liveBufType: number;
  bucketsBufType: number;
}

export interface MapDeps {
  /** %w.strEq's index (content equality for string keys). */
  strEq: () => number;
  /** The interned string array type's index — needed to read code units
   * (arrayGetU) while hashing a string key; string EQUALITY goes through
   * strEq instead, which already knows its own type. */
  strType: () => number;
  /** %w.dyn.idxKey's index (str) -> f64: the canonical array-index a key
   * spells, or -1 — dyn.ts's own predicate, injected rather than
   * reimplemented (increment-17 stage B's house rule: ONE own-key-order
   * classification helper in the whole tier, shared by objWalk mode 2
   * and this file's keysJsOrder, never a second slightly-different one). */
  idxKey: () => number;
}

// Struct field indices.
const NENTRIES = 0;
const NLIVE = 1;
const NBUCKETS = 2;
const ITERDEPTH = 3;
const KEYS = 4;
const VALS = 5;
const LIVE = 6;
const BUCKETS = 7;

const EMPTY = -1;
/** An odd 64-bit multiplicative-hash constant (splitmix64/Fibonacci-hashing
 * family) — mixes an f64's bit pattern into well-distributed high bits,
 * taken via a 32-bit right shift. The exact constant is unobservable (see
 * the file header): only bucket-consistency with equality matters. Written
 * in i64's SIGNED two's-complement form (0x9e3779b97f4a7c15's top bit is
 * set, so the unsigned hex literal is out of sleb128's signed i64 range —
 * `i64.const` only ever encodes a signed value; the BIT PATTERN is
 * identical either way, which is all i64Mul/i64ShrU care about). */
const HASH_MIX = -7046029254386353131n;

export class MapBuilder {
  private readonly infos = new Map<string, MapInfo>();
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: MapDeps,
  ) {}

  /** The map types for one (key, value) representation, interned. Callers
   * (emitter.ts) key by meaning — mapKeyFor/vecKeyFor-style strings — the
   * SAME key for `Set<T>` and `Map<T, number>` intentionally collapses
   * them onto one struct + one helper family (the "ONE representation"
   * thesis, one layer tighter than scr_map.c: C still has a distinct
   * `scr_set_new_ref` entry point, but nothing here needs one). */
  info(
    key: string,
    keyKind: MapKeyKind,
    keyVal: ValType,
    valKind: MapValKind,
    valVal: ValType,
    valStorage: StorageType,
  ): MapInfo {
    const existing = this.infos.get(key);
    if (existing !== undefined) return existing;
    const keysBufType = this.mb.arrayType(keyVal, true);
    const valsBufType = this.mb.arrayType(valStorage, true);
    const liveBufType = this.mb.arrayType("i8", true);
    const bucketsBufType = this.mb.arrayType(I32, true);
    const fields: FieldType[] = [
      { storage: I32, mutable: true },
      { storage: I32, mutable: true },
      { storage: I32, mutable: true },
      { storage: I32, mutable: true },
      { storage: { kind: "ref", nullable: false, typeIndex: keysBufType }, mutable: true },
      { storage: { kind: "ref", nullable: false, typeIndex: valsBufType }, mutable: true },
      { storage: { kind: "ref", nullable: false, typeIndex: liveBufType }, mutable: true },
      { storage: { kind: "ref", nullable: false, typeIndex: bucketsBufType }, mutable: true },
    ];
    const struct = this.mb.structType(fields);
    const made: MapInfo = {
      key,
      keyKind,
      valKind,
      keyVal,
      valVal,
      valStorage,
      struct,
      keysBufType,
      valsBufType,
      liveBufType,
      bucketsBufType,
    };
    this.infos.set(key, made);
    return made;
  }

  mapRef(m: MapInfo): ValType {
    return { kind: "ref", nullable: true, typeIndex: m.struct };
  }

  /** valsBuf[i] with the storage-appropriate get — bool values pack into
   * i8 (arrays.ts's own convention), which `array.get` REJECTS outright
   * (packed storage requires the signed/unsigned form); f64/ref values
   * are unpacked and take plain `array.get`. Expects (valsBuf, i) already
   * pushed on the stack. */
  private emitValRead(c: Code, m: MapInfo): void {
    if (m.valKind === "bool") c.arrayGetU(m.valsBufType);
    else c.arrayGet(m.valsBufType);
  }

  private nullableBuf(typeIndex: number): ValType {
    return { kind: "ref", nullable: true, typeIndex };
  }

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** Pushes the i32 hash of the key value in local KL — NEVER mutates KL
   * (unlike an earlier draft: KL may be `set`'s about-to-be-STORED key,
   * whose exact NaN payload bits Node preserves — see the file header —
   * so hashing must canonicalize into its OWN scratch, not the caller's
   * value). f64 kind: NaN collapses to a fixed sentinel and -0 to +0 in
   * TMP (hash-consistency requires this: equal keys — any two NaNs, or
   * -0/+0 — must hash identically, or a probe from the "wrong" bucket
   * would never find an existing entry), then a multiplicative mix of the
   * bit pattern's upper 32 bits. String kind: a polynomial rolling hash
   * over code units, using L/SI/ACC as scratch (TMP/L/SI/ACC are each
   * unused, and safe to pass as any allocated placeholder, on the arm
   * that doesn't need them). */
  private emitHashKey(c: Code, m: MapInfo, KL: number, TMP: number, L: number, SI: number, ACC: number): void {
    if (m.keyKind === "f64") {
      c.localGet(KL);
      c.localSet(TMP);
      c.localGet(TMP);
      c.localGet(TMP);
      c.f64Ne();
      c.ifVoid();
      c.f64Const(NaN);
      c.localSet(TMP);
      c.end();
      c.localGet(TMP);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.f64Const(0);
      c.localSet(TMP);
      c.end();
      c.localGet(TMP);
      c.i64ReinterpretF64();
      c.i64Const(HASH_MIX);
      c.i64Mul();
      c.i64Const(32n);
      c.i64ShrU();
      c.i32WrapI64();
      return;
    }
    c.localGet(KL);
    c.arrayLen();
    c.localSet(L);
    c.i32Const(0);
    c.localSet(ACC);
    c.i32Const(0);
    c.localSet(SI);
    c.block();
    c.loop();
    c.localGet(SI);
    c.localGet(L);
    c.i32GeS();
    c.brIf(1);
    c.localGet(ACC);
    c.i32Const(31);
    c.i32Mul();
    c.localGet(KL);
    c.localGet(SI);
    c.arrayGetU(this.deps.strType());
    c.i32Add();
    c.localSet(ACC);
    c.localGet(SI);
    c.i32Const(1);
    c.i32Add();
    c.localSet(SI);
    c.br(0);
    c.end();
    c.end();
    c.localGet(ACC);
  }

  /** Pushes an i32 SameValueZero comparison of locals A and B (both
   * `m.keyVal`-typed). f64: `f64Eq(a,b) | (isNaN(a) & isNaN(b))` — f64Eq
   * alone already treats -0 == +0 (IEEE), the OR-clause makes any two
   * NaNs equal regardless of payload. String: exact content equality
   * (strEq) — S005's collation order is a different predicate. */
  private emitKeyEq(c: Code, m: MapInfo, A: number, B: number): void {
    if (m.keyKind === "f64") {
      c.localGet(A);
      c.localGet(B);
      c.f64Eq();
      c.localGet(A);
      c.localGet(A);
      c.f64Ne();
      c.localGet(B);
      c.localGet(B);
      c.f64Ne();
      c.i32And();
      c.i32Or();
      return;
    }
    c.localGet(A);
    c.localGet(B);
    c.call(this.deps.strEq());
  }

  /** %w.map.new — () -> map, all four arrays allocated at zero length (no
   * null fields anywhere, arrays.ts's own precedent). */
  new_(m: MapInfo): number {
    return this.cached(`${m.key}:new`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], [this.mapRef(m)]), `%w.map.new:${m.key}`);
      const c = new Code();
      c.i32Const(0); // nentries
      c.i32Const(0); // nlive
      c.i32Const(0); // nbuckets
      c.i32Const(0); // iterDepth
      c.i32Const(0);
      c.arrayNewDefault(m.keysBufType);
      c.i32Const(0);
      c.arrayNewDefault(m.valsBufType);
      c.i32Const(0);
      c.arrayNewDefault(m.liveBufType);
      c.i32Const(0);
      c.arrayNewDefault(m.bucketsBufType);
      c.structNew(m.struct);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.map.find — (map, key) -> i32 entry index or -1. The one shared
   * probe every other op composes from (scr_map_find's role). Never
   * touches K itself — hashing canonicalizes into emitHashKey's own
   * scratch, and equality (`emitKeyEq`) already handles -0/+0 (IEEE
   * f64Eq) and any-NaN-equals-any-NaN without needing K pre-normalized,
   * so K's exact input bits pass through untouched (irrelevant here since
   * find() never stores anything, but keeps this function's contract
   * simple: read-only in every local it did not itself allocate).
   * Probing never stops at a tombstone (only an EMPTY bucket slot ends
   * the chain) and always terminates: the growth policy keeps
   * nbuckets > nentries, so an empty slot always exists — an
   * unconditional `loop`/`br 0` is safe with no outer `block`, every exit
   * is a `return_`. */
  private find(m: MapInfo): number {
    return this.cached(`${m.key}:find`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), m.keyVal], [I32]), `%w.map.find:${m.key}`);
      const c = new Code();
      const M = 0;
      const K = 1;
      let n = 2;
      const HASH = n++;
      const MASK = n++;
      const IDX = n++;
      const B = n++;
      const locals: ValType[] = [I32, I32, I32, I32];
      let TMP = -1;
      let L = -1;
      let SI = -1;
      let ACC = -1;
      if (m.keyKind === "f64") {
        TMP = n++;
        locals.push(F64);
      } else {
        L = n++;
        SI = n++;
        ACC = n++;
        locals.push(I32, I32, I32);
      }
      const S = n++; // scratch for the stored key at the candidate bucket
      locals.push(m.keyVal);

      // Empty map: never touch bucketsBuf (nbuckets == 0 is the guard the
      // C reference also gates find() on).
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(EMPTY);
      c.return_();
      c.end();

      this.emitHashKey(c, m, K, TMP, L, SI, ACC);
      c.localSet(HASH);

      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(MASK);
      c.localGet(HASH);
      c.localGet(MASK);
      c.i32And();
      c.localSet(IDX);

      c.loop();
      c.localGet(M);
      c.structGet(m.struct, BUCKETS);
      c.localGet(IDX);
      c.arrayGet(m.bucketsBufType);
      c.localSet(B);
      c.localGet(B);
      c.i32Const(EMPTY);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(EMPTY);
      c.return_();
      c.end();
      // live[B] && keyEq(keys[B], K) — explicit control flow (i32.and does
      // not short-circuit): only read keys[B] once B is confirmed live.
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(B);
      c.arrayGetU(m.liveBufType);
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(B);
      c.arrayGet(m.keysBufType);
      c.localSet(S);
      this.emitKeyEq(c, m, S, K);
      c.ifVoid();
      c.localGet(B);
      c.return_();
      c.end();
      c.end();
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localGet(MASK);
      c.i32And();
      c.localSet(IDX);
      c.br(0);
      c.end();
      // Every reachable path inside the loop exits via `return_` — the
      // loop's own (VOID) blocktype is what governs its contribution to
      // the surrounding stack at validation time, not a deeper analysis
      // of whether it truly falls through, so the function's declared
      // I32 result still needs satisfying right here. Same idiom as
      // unions.ts's dispatch() trailer.
      c.unreachable();

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.rebuildBuckets — (map, i32 newNbuckets) -> (). Fresh bucket
   * array, EMPTY-filled, every LIVE entry reinserted by its STORED key's
   * hash. The stored key is -0-normalized already (storage's own job) but
   * may still hold an arbitrary NaN payload (Node preserves it — file
   * header), so this still routes through emitHashKey's own NaN-sentinel
   * canonicalization rather than assuming the stored bits are hash-ready. */
  private rebuildBuckets(m: MapInfo): number {
    return this.cached(`${m.key}:rebuildBuckets`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), I32], []), `%w.map.rebuildBuckets:${m.key}`);
      const c = new Code();
      const M = 0;
      const NB = 1;
      let n = 2;
      const NEWBUF = n++;
      const I = n++;
      const MASK = n++;
      const R = n++;
      const HASH = n++;
      const KL = n++;
      const locals: ValType[] = [this.nullableBuf(m.bucketsBufType), I32, I32, I32, I32, m.keyVal];
      let TMP = -1;
      let L = -1;
      let SI = -1;
      let ACC = -1;
      if (m.keyKind === "f64") {
        TMP = n++;
        locals.push(F64);
      } else {
        L = n++;
        SI = n++;
        ACC = n++;
        locals.push(I32, I32, I32);
      }

      c.localGet(NB);
      c.arrayNewDefault(m.bucketsBufType);
      c.localSet(NEWBUF);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(NB);
      c.i32GeS();
      c.brIf(1);
      c.localGet(NEWBUF);
      c.refAsNonNull();
      c.localGet(I);
      c.i32Const(EMPTY);
      c.arraySet(m.bucketsBufType);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(NB);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(MASK);
      c.i32Const(0);
      c.localSet(R);
      c.block();
      c.loop();
      c.localGet(R);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(R);
      c.arrayGetU(m.liveBufType);
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(R);
      c.arrayGet(m.keysBufType);
      c.localSet(KL);
      this.emitHashKey(c, m, KL, TMP, L, SI, ACC);
      c.localSet(HASH);
      c.localGet(HASH);
      c.localGet(MASK);
      c.i32And();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(NEWBUF);
      c.refAsNonNull();
      c.localGet(I);
      c.arrayGet(m.bucketsBufType);
      c.i32Const(EMPTY);
      c.i32Eq();
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(MASK);
      c.i32And();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(NEWBUF);
      c.refAsNonNull();
      c.localGet(I);
      c.localGet(R);
      c.arraySet(m.bucketsBufType);
      c.end();
      c.localGet(R);
      c.i32Const(1);
      c.i32Add();
      c.localSet(R);
      c.br(0);
      c.end();
      c.end();

      c.localGet(M);
      c.localGet(NEWBUF);
      c.refAsNonNull();
      c.structSet(m.struct, BUCKETS);
      c.localGet(M);
      c.localGet(NB);
      c.structSet(m.struct, NBUCKETS);

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.compact — (map) -> (). Drops tombstones, preserving insertion
   * order among survivors; only legal (and only ever called) when
   * iterDepth == 0. Rebuilds buckets at the CURRENT nbuckets afterward
   * (scr_map_compact's own contract) when one exists. */
  private compact(m: MapInfo): number {
    return this.cached(`${m.key}:compact`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], []), `%w.map.compact:${m.key}`);
      const c = new Code();
      const M = 0;
      let n = 1;
      const R = n++;
      const W = n++;
      const N = n++;
      const locals: ValType[] = [I32, I32, I32];

      c.i32Const(0);
      c.localSet(W);
      c.i32Const(0);
      c.localSet(R);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.localSet(N);
      c.block();
      c.loop();
      c.localGet(R);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(R);
      c.arrayGetU(m.liveBufType);
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(W);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(R);
      c.arrayGet(m.keysBufType);
      c.arraySet(m.keysBufType);
      c.localGet(M);
      c.structGet(m.struct, VALS);
      c.localGet(W);
      c.localGet(M);
      c.structGet(m.struct, VALS);
      c.localGet(R);
      this.emitValRead(c, m);
      c.arraySet(m.valsBufType);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(W);
      c.i32Const(1);
      c.arraySet(m.liveBufType);
      c.localGet(W);
      c.i32Const(1);
      c.i32Add();
      c.localSet(W);
      c.end();
      c.localGet(R);
      c.i32Const(1);
      c.i32Add();
      c.localSet(R);
      c.br(0);
      c.end();
      c.end();

      c.localGet(M);
      c.localGet(W);
      c.structSet(m.struct, NENTRIES);

      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(M);
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.call(this.rebuildBuckets(m));
      c.end();

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.reserveAppend — (map) -> (). scr_map_reserve_append ported
   * whole: prefer compaction to growth when idle and tombstone-heavy,
   * otherwise grow the entry arrays (doubling from 8) and/or rebuild
   * buckets (doubling from 16, keeping load <= 50% incl. tombstones). */
  private reserveAppend(m: MapInfo): number {
    return this.cached(`${m.key}:reserveAppend`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], []), `%w.map.reserveAppend:${m.key}`);
      const c = new Code();
      const M = 0;
      let n = 1;
      const ECAP = n++;
      const CAP = n++;
      const NEWKEYS = n++;
      const NEWVALS = n++;
      const NEWLIVE = n++;
      const locals: ValType[] = [
        I32,
        I32,
        this.nullableBuf(m.keysBufType),
        this.nullableBuf(m.valsBufType),
        this.nullableBuf(m.liveBufType),
      ];

      // Fast path: room in the entries arrays AND the bucket load is fine.
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.arrayLen();
      c.i32LtS();
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(1);
      c.i32Shl();
      c.i32GeS();
      c.i32And();
      c.ifVoid();
      c.return_();
      c.end();

      // Prefer compaction when idle and at most half the dense span is live.
      c.localGet(M);
      c.structGet(m.struct, ITERDEPTH);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(2);
      c.i32DivS();
      c.i32LeS();
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(M);
      c.call(this.compact(m));
      c.end();
      c.end();
      c.end();

      // Grow the entry arrays if the (possibly just-compacted) nentries
      // reached capacity.
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.arrayLen();
      c.localSet(ECAP);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.localGet(ECAP);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ECAP);
      c.ifResult(I32);
      c.localGet(ECAP);
      c.else_();
      c.i32Const(8);
      c.end();
      c.localSet(CAP);
      c.block();
      c.loop();
      c.localGet(CAP);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(1);
      c.i32Add();
      c.i32GeS();
      c.brIf(1);
      c.localGet(CAP);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(CAP);
      c.br(0);
      c.end();
      c.end();
      c.localGet(CAP);
      c.arrayNewDefault(m.keysBufType);
      c.localSet(NEWKEYS);
      c.localGet(NEWKEYS);
      c.refAsNonNull();
      c.i32Const(0);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.i32Const(0);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.arrayCopy(m.keysBufType, m.keysBufType);
      c.localGet(CAP);
      c.arrayNewDefault(m.valsBufType);
      c.localSet(NEWVALS);
      c.localGet(NEWVALS);
      c.refAsNonNull();
      c.i32Const(0);
      c.localGet(M);
      c.structGet(m.struct, VALS);
      c.i32Const(0);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.arrayCopy(m.valsBufType, m.valsBufType);
      c.localGet(CAP);
      c.arrayNewDefault(m.liveBufType);
      c.localSet(NEWLIVE);
      c.localGet(NEWLIVE);
      c.refAsNonNull();
      c.i32Const(0);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.i32Const(0);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.arrayCopy(m.liveBufType, m.liveBufType);
      c.localGet(M);
      c.localGet(NEWKEYS);
      c.refAsNonNull();
      c.structSet(m.struct, KEYS);
      c.localGet(M);
      c.localGet(NEWVALS);
      c.refAsNonNull();
      c.structSet(m.struct, VALS);
      c.localGet(M);
      c.localGet(NEWLIVE);
      c.refAsNonNull();
      c.structSet(m.struct, LIVE);
      c.end();

      // Rebuild buckets if the load factor now demands more of them.
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(1);
      c.i32Shl();
      c.i32LtS();
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.ifResult(I32);
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.else_();
      c.i32Const(16);
      c.end();
      c.localSet(CAP);
      c.block();
      c.loop();
      c.localGet(CAP);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(1);
      c.i32Shl();
      c.i32GeS();
      c.brIf(1);
      c.localGet(CAP);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(CAP);
      c.br(0);
      c.end();
      c.end();
      c.localGet(M);
      c.localGet(CAP);
      c.call(this.rebuildBuckets(m));
      c.end();

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.set — (map, key, val) -> (). Overwrite keeps the entry's
   * position (only the value replaces); a new key reserves room FIRST
   * (compaction/growth may rebuild buckets) then appends and probes for
   * its bucket slot. Canonicalizes an f64 key's -0 -> +0 BEFORE find (so
   * the stored bits — and hence a later `keys()` readback — are already
   * +0), but never touches a NaN payload (Node preserves it; see the
   * header). */
  set(m: MapInfo): number {
    return this.cached(`${m.key}:set`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), m.keyVal, m.valVal], []), `%w.map.set:${m.key}`);
      const c = new Code();
      const M = 0;
      const K = 1;
      const V = 2;
      let n = 3;
      const E = n++;
      const locals: ValType[] = [I32];

      if (m.keyKind === "f64") {
        c.localGet(K);
        c.f64Const(0);
        c.f64Eq();
        c.ifVoid();
        c.f64Const(0);
        c.localSet(K);
        c.end();
      }

      c.localGet(M);
      c.localGet(K);
      c.call(this.find(m));
      c.localSet(E);
      c.localGet(E);
      c.i32Const(EMPTY);
      c.i32Ne();
      c.ifVoid();
      // Overwrite: value only, position and stored key untouched.
      c.localGet(M);
      c.structGet(m.struct, VALS);
      c.localGet(E);
      c.localGet(V);
      c.arraySet(m.valsBufType);
      c.return_();
      c.end();

      c.localGet(M);
      c.call(this.reserveAppend(m));
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.localSet(E);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(E);
      c.localGet(K);
      c.arraySet(m.keysBufType);
      c.localGet(M);
      c.structGet(m.struct, VALS);
      c.localGet(E);
      c.localGet(V);
      c.arraySet(m.valsBufType);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(E);
      c.i32Const(1);
      c.arraySet(m.liveBufType);
      c.localGet(M);
      c.localGet(E);
      c.i32Const(1);
      c.i32Add();
      c.structSet(m.struct, NENTRIES);
      c.localGet(M);
      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.i32Const(1);
      c.i32Add();
      c.structSet(m.struct, NLIVE);

      // Probe from the (already-rebuilt-if-needed) hash for an empty slot.
      let TMP = -1;
      let L = -1;
      let SI = -1;
      let ACC = -1;
      if (m.keyKind === "f64") {
        TMP = n++;
        locals.push(F64);
      } else {
        L = n++;
        SI = n++;
        ACC = n++;
        locals.push(I32, I32, I32);
      }
      const HASH = n++;
      const MASK = n++;
      const IDX = n++;
      locals.push(I32, I32, I32);
      this.emitHashKey(c, m, K, TMP, L, SI, ACC);
      c.localSet(HASH);
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(MASK);
      c.localGet(HASH);
      c.localGet(MASK);
      c.i32And();
      c.localSet(IDX);
      c.block();
      c.loop();
      c.localGet(M);
      c.structGet(m.struct, BUCKETS);
      c.localGet(IDX);
      c.arrayGet(m.bucketsBufType);
      c.i32Const(EMPTY);
      c.i32Eq();
      c.brIf(1);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localGet(MASK);
      c.i32And();
      c.localSet(IDX);
      c.br(0);
      c.end();
      c.end();
      c.localGet(M);
      c.structGet(m.struct, BUCKETS);
      c.localGet(IDX);
      c.localGet(E);
      c.arraySet(m.bucketsBufType);

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.has — (map, key) -> i32 bool. */
  has(m: MapInfo): number {
    return this.cached(`${m.key}:has`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), m.keyVal], [I32]), `%w.map.has:${m.key}`);
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.call(this.find(m));
      c.i32Const(EMPTY);
      c.i32Ne();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.map.get — (map, key) -> (i32 found, val). The union construction
   * (wrapping into `V | undefined`) is type-directed and lives in
   * emitter.ts (needs UnionBuilder and a case split on whether V is
   * itself already union-typed — see emitMapIntrinsic's `get` case doc
   * for why that split is required, not optional); this just answers the
   * raw found+value pair, matching a bare `if (found) ... else ...`
   * rather than scr_map.c's ref/scalar representation split — WasmGC's
   * multi-value returns plus real GC (no retain to skip on a miss) make
   * that particular split unnecessary here. */
  get(m: MapInfo): number {
    return this.cached(`${m.key}:get`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.mapRef(m), m.keyVal], [I32, m.valVal]),
        `%w.map.get:${m.key}`,
      );
      const c = new Code();
      const M = 0;
      const K = 1;
      let n = 2;
      const E = n++;
      const FOUND = n++;
      const VAL = n++;
      const locals: ValType[] = [I32, I32, m.valVal];

      c.localGet(M);
      c.localGet(K);
      c.call(this.find(m));
      c.localSet(E);
      c.localGet(E);
      c.i32Const(EMPTY);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(FOUND);
      c.localGet(M);
      c.structGet(m.struct, VALS);
      c.localGet(E);
      this.emitValRead(c, m);
      c.localSet(VAL);
      c.else_();
      c.i32Const(0);
      c.localSet(FOUND);
      this.pushZero(c, m.valVal);
      c.localSet(VAL);
      c.end();
      c.localGet(FOUND);
      c.localGet(VAL);

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  private pushZero(c: Code, t: ValType): void {
    switch (t.kind) {
      case "f64":
        c.f64Const(0);
        return;
      case "i32":
        c.i32Const(0);
        return;
      case "ref":
        c.refNull(t.typeIndex);
        return;
      case "i64":
        throw new Error("map value never represented as i64");
    }
  }

  /** %w.map.delete — (map, key) -> i32 bool (was it found+removed). The
   * bucket slot stays pointing at the dead entry (probe chains intact);
   * key/value slots of a REF kind are nulled so the delete releases the
   * reference for GC the same instant scr_map.c's release calls would
   * (not RC bookkeeping — just not leaking a stale ref until the next
   * compact/grow happens to overwrite the slot). */
  deleteM(m: MapInfo): number {
    return this.cached(`${m.key}:delete`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), m.keyVal], [I32]), `%w.map.delete:${m.key}`);
      const c = new Code();
      const M = 0;
      const K = 1;
      let n = 2;
      const E = n++;
      const locals: ValType[] = [I32];

      c.localGet(M);
      c.localGet(K);
      c.call(this.find(m));
      c.localSet(E);
      c.localGet(E);
      c.i32Const(EMPTY);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(E);
      c.i32Const(0);
      c.arraySet(m.liveBufType);
      c.localGet(M);
      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.i32Const(1);
      c.i32Sub();
      c.structSet(m.struct, NLIVE);
      if (m.keyKind === "str") {
        c.localGet(M);
        c.structGet(m.struct, KEYS);
        c.localGet(E);
        c.refNull((m.keyVal as ValType & { kind: "ref" }).typeIndex);
        c.arraySet(m.keysBufType);
      }
      if (m.valKind === "ref") {
        c.localGet(M);
        c.structGet(m.struct, VALS);
        c.localGet(E);
        c.refNull((m.valVal as ValType & { kind: "ref" }).typeIndex);
        c.arraySet(m.valsBufType);
      }
      c.i32Const(1);
      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.size — (map) -> f64 (nlive). */
  size(m: MapInfo): number {
    return this.cached(`${m.key}:size`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], [F64]), `%w.map.size:${m.key}`);
      const c = new Code();
      c.localGet(0);
      c.structGet(m.struct, NLIVE);
      c.f64ConvertI32S();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.map.clear — (map) -> (). Every live row tombstoned; if
   * iterDepth == 0 the dense span itself resets to 0 (a full reset — the
   * next append starts overwriting from position 0), otherwise the
   * entries array STAYS at its current length so an active iteration's
   * indices survive (measured against Node: entries appended by a
   * forEach callback AFTER a mid-iteration clear() are still visited).
   * Every bucket slot resets to EMPTY either way. */
  clear(m: MapInfo): number {
    return this.cached(`${m.key}:clear`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], []), `%w.map.clear:${m.key}`);
      const c = new Code();
      const M = 0;
      let n = 1;
      const I = n++;
      const N = n++;
      const locals: ValType[] = [I32, I32];

      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(I);
      c.arrayGetU(m.liveBufType);
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(I);
      c.i32Const(0);
      c.arraySet(m.liveBufType);
      if (m.keyKind === "str") {
        c.localGet(M);
        c.structGet(m.struct, KEYS);
        c.localGet(I);
        c.refNull((m.keyVal as ValType & { kind: "ref" }).typeIndex);
        c.arraySet(m.keysBufType);
      }
      if (m.valKind === "ref") {
        c.localGet(M);
        c.structGet(m.struct, VALS);
        c.localGet(I);
        c.refNull((m.valVal as ValType & { kind: "ref" }).typeIndex);
        c.arraySet(m.valsBufType);
      }
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(M);
      c.i32Const(0);
      c.structSet(m.struct, NLIVE);
      c.localGet(M);
      c.structGet(m.struct, ITERDEPTH);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(M);
      c.i32Const(0);
      c.structSet(m.struct, NENTRIES);
      c.end();

      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(M);
      c.structGet(m.struct, NBUCKETS);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.structGet(m.struct, BUCKETS);
      c.localGet(I);
      c.i32Const(EMPTY);
      c.arraySet(m.bucketsBufType);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.iterCount — (map) -> f64 (dense count INCLUDING tombstones;
   * re-read each pass by the caller so callback-appended entries are
   * visited — the desugar's contract, not this helper's). */
  iterCount(m: MapInfo): number {
    return this.cached(`${m.key}:iterCount`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], [F64]), `%w.map.iterCount:${m.key}`);
      const c = new Code();
      c.localGet(0);
      c.structGet(m.struct, NENTRIES);
      c.f64ConvertI32S();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.map.iterLive — (map, f64 i) -> i32 bool. OOB answers false —
   * unlike iterKey/iterValue, this NEVER traps (scr_map_iter_live's own
   * contract: the desugar polls it before deciding whether to read). A
   * NaN index must ALSO answer false, matching scr_map_iter_live's own
   * `!(i >= 0)` idiom (NOT `i < 0` — an earlier draft used `f64Lt`, which
   * IEEE-754 makes false for a NaN operand exactly like `f64Ge` is, so a
   * NaN slipped past BOTH guards into `i32TruncF64S`, which traps on NaN
   * — review MINOR-4). Testing `!(i >= 0)` via `f64Ge` + `i32Eqz` instead
   * catches negative AND NaN in one guard, matching the C reference. */
  iterLive(m: MapInfo): number {
    return this.cached(`${m.key}:iterLive`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), F64], [I32]), `%w.map.iterLive:${m.key}`);
      const c = new Code();
      const M = 0;
      const IF = 1;
      c.localGet(IF);
      c.f64Const(0);
      c.f64Ge();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(IF);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.f64ConvertI32S();
      c.f64Ge();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(IF);
      c.i32TruncF64S();
      c.arrayGetU(m.liveBufType);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** Bounds+liveness check shared by iterKey/iterValue: traps (internal
   * error — the desugar is expected to have already polled iterLive) on
   * an out-of-range or dead index, else leaves the truncated i32 index in
   * local I2. */
  private emitIterIndexCheck(c: Code, m: MapInfo, M: number, IF: number, I2: number): void {
    c.localGet(IF);
    c.f64Const(0);
    c.f64Lt();
    c.ifVoid();
    c.unreachable();
    c.end();
    c.localGet(IF);
    c.localGet(M);
    c.structGet(m.struct, NENTRIES);
    c.f64ConvertI32S();
    c.f64Ge();
    c.ifVoid();
    c.unreachable();
    c.end();
    c.localGet(IF);
    c.i32TruncF64S();
    c.localSet(I2);
    c.localGet(M);
    c.structGet(m.struct, LIVE);
    c.localGet(I2);
    c.arrayGetU(m.liveBufType);
    c.i32Eqz();
    c.ifVoid();
    c.unreachable();
    c.end();
  }

  /** %w.map.iterKey — (map, f64 i) -> key (also Set's element read: a Set
   * has no separate elem accessor, iterKey doubles as it). */
  iterKey(m: MapInfo): number {
    return this.cached(`${m.key}:iterKey`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), F64], [m.keyVal]), `%w.map.iterKey:${m.key}`);
      const c = new Code();
      const M = 0;
      const IF = 1;
      const I2 = 2;
      this.emitIterIndexCheck(c, m, M, IF, I2);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(I2);
      c.arrayGet(m.keysBufType);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.map.iterValue — (map, f64 i) -> val (Map only; Set never calls
   * this — no iterValue in IrSetIntrinsicMethod — but nothing stops the
   * struct/helper from existing when a Set and a Map happen to share one
   * MapInfo, per the "ONE representation" collapse). */
  iterValue(m: MapInfo): number {
    return this.cached(`${m.key}:iterValue`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.mapRef(m), F64], [m.valVal]),
        `%w.map.iterValue:${m.key}`,
      );
      const c = new Code();
      const M = 0;
      const IF = 1;
      const I2 = 2;
      this.emitIterIndexCheck(c, m, M, IF, I2);
      c.localGet(M);
      c.structGet(m.struct, VALS);
      c.localGet(I2);
      this.emitValRead(c, m);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.map.iterEnter — (map) -> (). iterDepth++. */
  iterEnter(m: MapInfo): number {
    return this.cached(`${m.key}:iterEnter`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], []), `%w.map.iterEnter:${m.key}`);
      const c = new Code();
      c.localGet(0);
      c.localGet(0);
      c.structGet(m.struct, ITERDEPTH);
      c.i32Const(1);
      c.i32Add();
      c.structSet(m.struct, ITERDEPTH);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.map.iterExit — (map) -> (). iterDepth-- (guarded at 0), then an
   * opportunistic compact when the depth returns to 0 and the map is
   * mostly tombstones — bounds memory under forEach-heavy add/delete
   * workloads without disturbing any indices an ACTIVE iteration needs. */
  iterExit(m: MapInfo): number {
    return this.cached(`${m.key}:iterExit`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], []), `%w.map.iterExit:${m.key}`);
      const c = new Code();
      const M = 0;
      c.localGet(M);
      c.structGet(m.struct, ITERDEPTH);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(M);
      c.localGet(M);
      c.structGet(m.struct, ITERDEPTH);
      c.i32Const(1);
      c.i32Sub();
      c.structSet(m.struct, ITERDEPTH);
      c.end();

      c.localGet(M);
      c.structGet(m.struct, ITERDEPTH);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(2);
      c.i32DivS();
      c.i32LeS();
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.i32Const(16);
      c.i32GeS();
      c.ifVoid();
      c.localGet(M);
      c.call(this.compact(m));
      c.end();
      c.end();
      c.end();

      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.map.addAll — (map, srcVec) -> (). `new Set(values)`: add() every
   * element of one borrowed T[] in order — duplicates collapse (first
   * insertion position wins, SameValueZero), matching a plain source-
   * order loop of `set(map, elem, 0)` calls. `vecStruct`/`vecBufType` are
   * the seed array's OWN vector type (arrays.ts's VecInfo shape, threaded
   * in by the caller rather than imported as a full VecInfo — maps.ts
   * stays decoupled from arrays.ts's BUILDER the way it stays decoupled
   * from IrType, but the vec struct's (LEN, BUF) FIELD LAYOUT is imported
   * directly from arrays.ts rather than assumed as bare 0/1 (review
   * MINOR-2 — a silent layout drift there would corrupt every read/write
   * here with no type error to catch it). The cache key folds in
   * `vecStruct`'s own type index (review MINOR-1): this function's BODY
   * bakes that index in via `structGet(vecStruct, ...)`, so two calls for
   * the same map-key with a DIFFERENT vec type must not share one cached
   * function — nothing distinguishes them today (a Set's seed element
   * kind always equals its own key kind), but the cache must not rely on
   * that staying true. The seed's element kind being exactly the map's
   * own key kind is also why no bool/i8-packed case exists here the way
   * arrays.ts's general element-kind switch needs one — a plain
   * `arrayGet` always reads the right storage, and a str-kind element
   * gets the same defensive `refAsNonNull` arrays.ts's own
   * `emitElemRead` uses for ref-typed reads. */
  addAll(m: MapInfo, vecStruct: number, vecBufType: number): number {
    return this.cached(`${m.key}:addAll:${vecStruct}`, () => {
      const vecRefT: ValType = { kind: "ref", nullable: true, typeIndex: vecStruct };
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m), vecRefT], []), `%w.map.addAll:${m.key}`);
      const c = new Code();
      const M = 0;
      const SRC = 1;
      let n = 2;
      const L = n++;
      const I = n++;
      const locals: ValType[] = [I32, I32];

      c.localGet(SRC);
      c.structGet(vecStruct, LEN);
      c.localSet(L);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.localGet(SRC);
      c.structGet(vecStruct, BUF);
      c.localGet(I);
      c.arrayGet(vecBufType);
      if (m.keyKind === "str") c.refAsNonNull();
      c.f64Const(0);
      c.call(this.set(m));
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.toArray — (map) -> fresh elem vec, live entries in insertion
   * order. `[...set]`'s one runtime call. `vecStruct`/`vecBufType` are the
   * target array's OWN vector type (arrays.ts's VecInfo shape, threaded in
   * by the caller — see `addAll`'s note on the imported (LEN, BUF) layout
   * and the vecStruct-qualified cache key, both apply here too). Sized to
   * nlive up front (arrays.ts's newLen shape: push the length twice, once
   * for the struct field and once consumed by arrayNewDefault) — nlive is
   * exactly the number of live rows the walk below writes, so the buffer
   * is never over- or under-sized. */
  toArray(m: MapInfo, vecStruct: number, vecBufType: number): number {
    return this.cached(`${m.key}:toArray:${vecStruct}`, () => {
      const vecRefT: ValType = { kind: "ref", nullable: true, typeIndex: vecStruct };
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], [vecRefT]), `%w.map.toArray:${m.key}`);
      const c = new Code();
      const M = 0;
      let n = 1;
      const OUT = n++;
      const R = n++;
      const N = n++;
      const W = n++;
      const locals: ValType[] = [this.nullableBuf(vecStruct), I32, I32, I32];

      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.arrayNewDefault(vecBufType);
      c.structNew(vecStruct);
      c.localSet(OUT);

      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(W);
      c.i32Const(0);
      c.localSet(R);
      c.block();
      c.loop();
      c.localGet(R);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(R);
      c.arrayGetU(m.liveBufType);
      c.ifVoid();
      c.localGet(OUT);
      c.refAsNonNull();
      c.structGet(vecStruct, BUF);
      c.localGet(W);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(R);
      c.arrayGet(m.keysBufType);
      c.arraySet(vecBufType);
      c.localGet(W);
      c.i32Const(1);
      c.i32Add();
      c.localSet(W);
      c.end();
      c.localGet(R);
      c.i32Const(1);
      c.i32Add();
      c.localSet(R);
      c.br(0);
      c.end();
      c.end();

      c.localGet(OUT);
      c.refAsNonNull();

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }

  /** %w.map.keysJsOrder — (map) -> fresh string[] of the LIVE keys in JS
   * OWN-KEY order: canonical array-index keys ("0".."4294967294", the
   * idxKey predicate — dyn.ts's own, shared rather than reimplemented per
   * the increment-17 stage B house rule: ONE own-key-order classification
   * in the whole tier) ascending numerically FIRST, then the rest in
   * insertion order (scr_map_keys_js_order ported). Str-keyed maps only
   * — the record overflow store; a plain user Map never needs this (Map
   * iteration is always insertion order, JS never reorders it).
   *
   * Structurally an O(n^2) SELECTION scan — "repeatedly find the
   * smallest index-key strictly greater than the last one emitted" —
   * rather than an auxiliary sorted buffer, mirroring dyn.ts's own
   * objWalk OBJ arm exactly (which this shares idxKey with); the ONE
   * addition objWalk's dense/tombstone-free entries array never needed is
   * the LIVE gate on every candidate read here, since this map's dense
   * span can hold tombstones objWalk's never does. */
  keysJsOrder(m: MapInfo, vecStruct: number, vecBufType: number): number {
    if (m.keyKind !== "str") throw new Error(`wasm emitter bug: keysJsOrder on a non-string-keyed map ${m.key}`);
    return this.cached(`${m.key}:keysJsOrder:${vecStruct}`, () => {
      const vecRefT: ValType = { kind: "ref", nullable: true, typeIndex: vecStruct };
      const idx = this.mb.declareFunc(this.mb.funcType([this.mapRef(m)], [vecRefT]), `%w.map.keysJsOrder:${m.key}`);
      const c = new Code();
      const M = 0;
      const OUT = 1;
      const N = 2; // i32 dense entry count (NENTRIES)
      const W = 3; // i32 output write cursor
      const I = 4; // i32 scan cursor
      const BEST = 5; // i32 best candidate's dense index, -1 = none yet
      const BESTV = 6; // f64 best candidate's idxKey() value
      const LAST = 7; // f64 last-emitted idxKey() value
      const IV = 8; // f64 scratch: idxKey() of the current candidate
      const locals: ValType[] = [this.nullableBuf(vecStruct), I32, I32, I32, I32, F64, F64, F64];

      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.localGet(M);
      c.structGet(m.struct, NLIVE);
      c.arrayNewDefault(vecBufType);
      c.structNew(vecStruct);
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(W);
      c.localGet(M);
      c.structGet(m.struct, NENTRIES);
      c.localSet(N);

      // Pass 1: canonical-index keys, ascending.
      c.f64Const(-1);
      c.localSet(LAST);
      c.block();
      c.loop();
      c.i32Const(-1);
      c.localSet(BEST);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(I);
      c.arrayGetU(m.liveBufType);
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(I);
      c.arrayGet(m.keysBufType);
      c.call(this.deps.idxKey());
      c.localTee(IV);
      c.localGet(LAST);
      c.f64Gt();
      c.ifVoid();
      // `BEST < 0 || IV < BESTV` — BESTV is only meaningful once BEST is
      // set, so the two tests nest rather than combine via i32Or (no
      // memory read on either side here, but nesting mirrors objWalk's
      // own structure exactly, which this is a direct port of).
      c.localGet(BEST);
      c.i32Const(0);
      c.i32LtS();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(IV);
      c.localGet(BESTV);
      c.f64Lt();
      c.end();
      c.ifVoid();
      c.localGet(I);
      c.localSet(BEST);
      c.localGet(IV);
      c.localSet(BESTV);
      c.end();
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(BEST);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(BESTV);
      c.localSet(LAST);
      c.localGet(OUT);
      c.refAsNonNull();
      c.structGet(vecStruct, BUF);
      c.localGet(W);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(BEST);
      c.arrayGet(m.keysBufType);
      c.arraySet(vecBufType);
      c.localGet(W);
      c.i32Const(1);
      c.i32Add();
      c.localSet(W);
      c.br(0);
      c.end();
      c.end();

      // Pass 2: everything else, insertion order.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.structGet(m.struct, LIVE);
      c.localGet(I);
      c.arrayGetU(m.liveBufType);
      c.ifVoid();
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(I);
      c.arrayGet(m.keysBufType);
      c.call(this.deps.idxKey());
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.localGet(OUT);
      c.refAsNonNull();
      c.structGet(vecStruct, BUF);
      c.localGet(W);
      c.localGet(M);
      c.structGet(m.struct, KEYS);
      c.localGet(I);
      c.arrayGet(m.keysBufType);
      c.arraySet(vecBufType);
      c.localGet(W);
      c.i32Const(1);
      c.i32Add();
      c.localSet(W);
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(OUT);
      c.refAsNonNull();

      this.mb.setBody(idx, locals, c.bytes());
      return idx;
    });
  }
}
