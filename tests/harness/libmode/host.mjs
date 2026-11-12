/* The library-mode test host (docs/design/wasm-library-mode.md §8.1): a fake
 * engine with a tiny ECS, a command log, a scripted random stream and a set of
 * probe imports. ONE definition drives all three columns of the harness:
 *
 *   - node: the row's TypeScript runs under Node; the host module ("pw") is
 *     this table, reached through driver.mjs's loader hook, and the boundary
 *     classes are applied in JS exactly as the module applies them;
 *   - v8:   the compiled module is instantiated with this table as imports;
 *   - wasmtime: host.c is a line-for-line port of this file.
 *
 * Keep host.c in step with every change here: the harness compares the three
 * columns byte for byte, so a drift shows up as a mismatch row, never silently.
 *
 * Values cross as "classes" (the profile vocabulary, WIT spelling): f64 f32
 * s32 u32 s64 u64 bool string list<u8> list<u32> list<f32> list<f64>. A row
 * without a profile has only f64 (TS number), s64 (TS bigint) and bool. */

/** The engine's own numbers, as the probe imports `give_*` hand them out. */
const GIVE = {
  f64: [0, -0, 1.5, NaN, Infinity, -Infinity, 2 ** 53 + 2, 5e-324, -123.25],
  f32: [0, -0, Math.fround(1.1), NaN, Infinity, Math.fround(3.4e38), Math.fround(1e-45)],
  s32: [0, -1, 2147483647, -2147483648, 42],
  u32: [0, 1, 4294967295, 2147483648, 42],
  s64: [0n, -1n, 9223372036854775807n, -9223372036854775808n, 9007199254740993n],
  u64: [0n, 1n, 18446744073709551615n, 9223372036854775808n, 9007199254740993n],
  bool: [false, true],
};

/** The scripted random stream: splitmix64 from a fixed seed. */
const RAND_SEED = 0x2545f4914f6cdd1dn;

/** The canonical text of one value of a class (host.c's render()). */
export function render(cls, v) {
  switch (cls) {
    case "bool":
      return v ? "true" : "false";
    case "u8":
    case "s32":
    case "u32":
    case "s64":
    case "u64":
      return String(v);
    case "string":
      return JSON.stringify(v);
    case "f32":
    case "f64": {
      if (Object.is(v, -0)) return "-0";
      if (Number.isInteger(v) && Math.abs(v) <= 2 ** 53) return String(v);
      const b = new DataView(new ArrayBuffer(8));
      b.setFloat64(0, v, true);
      return "0x" + b.getBigUint64(0, true).toString(16).padStart(16, "0");
    }
    default:
      if (cls.startsWith("list<")) return "[" + Array.from(v, (x) => render(cls.slice(5, -1), x)).join(",") + "]";
      throw new Error(`render: unknown class ${cls}`);
  }
}

/** What a value of `cls` becomes after a round trip through its wasm type
 * (the host's natural value in, the module's view out): the conversions V8
 * and wasmtime apply at an import's result. */
export function roundTrip(cls, v) {
  switch (cls) {
    case "f64":
      return Number.isNaN(Number(v)) ? NaN : Number(v);
    case "f32":
      return Number.isNaN(Number(v)) ? NaN : Math.fround(Number(v));
    case "s32":
      return Number(v) | 0;
    case "u32":
      return Number(v) >>> 0;
    case "s64":
      return BigInt.asIntN(64, BigInt(v));
    case "u64":
      return BigInt.asUintN(64, BigInt(v));
    case "bool":
      return Number(v) !== 0;
    case "string":
      return v.toWellFormed();
    default:
      return v;
  }
}

/** The host. `out(line)` receives every observable line; `mem()` answers the
 * guest's linear memory as a Uint8Array (null where the guest has none). */
export function createHost(out, mem) {
  const ents = []; // { id: bigint, kind: number, fields: Map<string, number> }
  let nextId = 1n;
  const cursors = [];
  let rand = RAND_SEED;
  const names = [];
  const find = (id) => ents.find((e) => e.id === id);
  const enc = new TextEncoder();
  const give = (cls) => (k) => GIVE[cls][k % GIVE[cls].length];
  const note = (name) => ({ params: ["*"], result: null, fn: (cls, x) => out(`${name} ${render(cls, x)}`) });

  /** name → { params: natural kinds, result, fn }. A "*" param takes the
   * class the boundary actually used and is printed in it. */
  const table = {
    spawn: { params: ["u32"], result: "u64", fn: (kind) => {
      const id = nextId++;
      ents.push({ id, kind: Number(kind), fields: new Map() });
      return id;
    } },
    despawn: { params: ["u64"], result: "bool", fn: (id) => {
      const i = ents.findIndex((e) => e.id === BigInt(id));
      if (i < 0) return false;
      ents.splice(i, 1);
      return true;
    } },
    query_begin: { params: ["u32"], result: "u32", fn: (mask) => {
      const m = Number(mask) >>> 0;
      cursors.push({ list: ents.filter((e) => ((e.kind & m) >>> 0) === m).map((e) => e.id), i: 0 });
      return cursors.length;
    } },
    query_next: { params: ["u32"], result: "u64", fn: (c) => {
      const cur = cursors[Number(c) - 1];
      if (cur === undefined || cur.i >= cur.list.length) return 0n;
      return cur.list[cur.i++];
    } },
    get_f32: { params: ["u64", "u32", "u32"], result: "f32", fn: (e, comp, field) => {
      const ent = find(BigInt(e));
      return ent?.fields.get(`${Number(comp)}.${Number(field)}`) ?? 0;
    } },
    set_f32: { params: ["u64", "u32", "u32", "f32"], result: null, fn: (e, comp, field, v) => {
      const ent = find(BigInt(e));
      if (ent !== undefined) ent.fields.set(`${Number(comp)}.${Number(field)}`, Math.fround(Number(v)));
    } },
    rand_u64: { params: [], result: "u64", fn: () => {
      rand = BigInt.asUintN(64, rand + 0x9e3779b97f4a7c15n);
      let z = rand;
      z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
      z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
      return z ^ (z >> 31n);
    } },
    note_f64: note("note_f64"),
    note_f32: note("note_f32"),
    note_s32: note("note_s32"),
    note_u32: note("note_u32"),
    note_s64: note("note_s64"),
    note_u64: note("note_u64"),
    note_bool: note("note_bool"),
    give_f64: { params: ["u32"], result: "f64", fn: give("f64") },
    give_f32: { params: ["u32"], result: "f32", fn: give("f32") },
    give_s32: { params: ["u32"], result: "s32", fn: give("s32") },
    give_u32: { params: ["u32"], result: "u32", fn: give("u32") },
    give_s64: { params: ["u32"], result: "s64", fn: give("s64") },
    give_u64: { params: ["u32"], result: "u64", fn: give("u64") },
    give_bool: { params: ["u32"], result: "bool", fn: give("bool") },
    // ── the pointer classes (P2) ──────────────────────────────────────────
    log: { params: ["string"], result: null, fn: (s) => out(`log ${render("string", s)}`) },
    report: { params: ["u32", "string"], result: null, fn: (code, s) => out(`report ${Number(code)} ${render("string", s)}`) },
    emit_command: { params: ["string"], result: null, fn: (s) => out(`command ${render("string", s)}`) },
    register_component: { params: ["string"], result: "u32", fn: (s) => {
      let i = names.indexOf(s);
      if (i < 0) i = names.push(s) - 1;
      return i + 1;
    } },
    put_bytes: { params: ["list<u8>"], result: null, fn: (b) => out(`put_bytes ${render("list<u8>", b)}`) },
    put_u32s: { params: ["list<u32>"], result: null, fn: (b) => out(`put_u32s ${render("list<u32>", b)}`) },
    put_f32s: { params: ["list<f32>"], result: null, fn: (b) => out(`put_f32s ${render("list<f32>", b)}`) },
    put_f64s: { params: ["list<f64>"], result: null, fn: (b) => out(`put_f64s ${render("list<f64>", b)}`) },
    /** hostStr's retry shape (design §3.3): the host's text into the
     * guest's (ptr, cap); the true length comes back, and nothing is
     * written when it does not fit. */
    read_text: { params: ["u32", "u32"], result: "u32", fn: (ptr, cap) => {
      const b = enc.encode("héllo wörld ☃ \u{1d11e}");
      if (b.length <= Number(cap)) mem().set(b, Number(ptr));
      return b.length;
    } },
    /** An out-buffer (get_vec3's shape): three little-endian f32 at ptr. */
    get_vec3: { params: ["u64", "u32", "u32", "u32"], result: null, fn: (e, comp, field, ptr) => {
      const ent = find(BigInt(e));
      const dv = new DataView(mem().buffer, mem().byteOffset);
      for (let k = 0; k < 3; k++) dv.setFloat32(Number(ptr) + 4 * k, ent?.fields.get(`${Number(comp)}.${Number(field) + k}`) ?? 0, true);
    } },
  };

  const dump = () => {
    out(`entities ${ents.length}`);
    for (const e of ents) {
      const keys = [...e.fields.keys()].sort((a, b) => {
        const [ac, af] = a.split(".").map(Number);
        const [bc, bf] = b.split(".").map(Number);
        return ac - bc || af - bf;
      });
      out(`  ${e.id} kind ${e.kind}` + keys.map((k) => ` ${k}=${render("f32", e.fields.get(k))}`).join(""));
    }
    out(`components ${names.map((n) => JSON.stringify(n)).join(" ")}`);
  };
  return { table, dump };
}

/** The classes are the module's view: what the profile says, or (without a
 * profile) what the TypeScript type says, read off the value. */
export function defaultClass(v) {
  if (typeof v === "bigint") return "s64";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "string";
  if (v instanceof Uint8Array) return "list<u8>";
  if (v instanceof Int32Array) return "list<s32>";
  if (v instanceof Uint32Array) return "list<u32>";
  if (v instanceof Float32Array) return "list<f32>";
  if (v instanceof Float64Array) return "list<f64>";
  return "f64";
}
