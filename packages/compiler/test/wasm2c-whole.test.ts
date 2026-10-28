/* backend/wasm2c.ts's WHOLE-PROGRAM profile against Node's own
 * WebAssembly (native-runner phase N0): the C a module translates to must
 * compute what the engine computes, trap where the engine traps, and keep
 * every bit the engine keeps.
 *
 *  - numbers: every i32/i64/f32/f64 unary, binary and comparison operator
 *    and every conversion (trapping and saturating truncation included),
 *    over operand sets full of edges (0, -0, ±1, MIN/MAX, ±Inf, NaNs with
 *    payloads, values just inside and outside every truncation range).
 *    Operands and results cross as BIT PATTERNS (reinterpret inside the
 *    module), so a sign of zero or a NaN's payload is compared exactly —
 *    the place C's and wasm's rules differ: C's fabs/-x/copysign may be
 *    library calls, fmin/fmax pick the other operand for a NaN and either
 *    zero, a float→int cast past the range is undefined. The translation
 *    calls its own helpers for each (wn_rt.h) and this row holds them to
 *    the engine.
 *  - linear memory: every load and store width at addresses up to and past
 *    the end of memory (the guard-page trap), memory.grow/size, fill/copy
 *    bounds.
 *  - GC: structs and arrays of every storage type, packed get_s/get_u,
 *    subtype tests and casts (the canonical-id display), br_on_null,
 *    call_ref and call_indirect (a signature mismatch traps), and a long
 *    linked structure built while the collector runs every few allocations
 *    (WN_GC_STRESS) — the conservative stack scan must keep it alive.
 * And the subset's edge: an instruction outside it throws, naming it. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { wasmNativeCflags } from "../src/backend/wasm-native.js";
import { wasmModuleToC } from "../src/backend/wasm2c.js";

const RT = join(import.meta.dirname, "..", "..", "runtime", "src", "wasmnative");

/* ── a tiny module assembler ─────────────────────────────────────────── */
const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};
const sleb = (n: number | bigint): number[] => {
  let v = BigInt(n);
  const out: number[] = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const str = (s: string): number[] => [...uleb(s.length), ...Buffer.from(s)];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c } as const;
type NT = keyof typeof T;

interface Fn {
  type: number;
  locals?: number[][]; // [count, valtype bytes...]
  body: number[];
}
interface Mod {
  types: number[][]; // each entry: the encoded type (or rec group)
  funcs: Fn[];
  memory?: [number, number];
  tables?: number[][];
  globals?: number[][];
  elems?: number[][];
  datas?: number[][];
  /** emit a data count section (array.new_data / memory.init need it) */
  dataCount?: boolean;
  exportAll: boolean;
}
function assemble(m: Mod): Uint8Array {
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  out.push(...section(1, vec(m.types)));
  out.push(...section(3, vec(m.funcs.map((f) => uleb(f.type)))));
  if (m.tables) out.push(...section(4, vec(m.tables)));
  if (m.memory) out.push(...section(5, vec([[0x01, ...uleb(m.memory[0]), ...uleb(m.memory[1])]])));
  if (m.globals) out.push(...section(6, vec(m.globals)));
  if (m.exportAll) out.push(...section(7, vec(m.funcs.map((_, k) => [...str(`e${k}`), 0x00, ...uleb(k)]))));
  if (m.elems) out.push(...section(9, vec(m.elems)));
  if (m.dataCount) out.push(...section(12, uleb(m.datas?.length ?? 0)));
  out.push(
    ...section(
      10,
      vec(
        m.funcs.map((f) => {
          const body = [...vec(f.locals ?? []), ...f.body, 0x0b];
          return [...uleb(body.length), ...body];
        }),
      ),
    ),
  );
  if (m.datas) out.push(...section(11, vec(m.datas)));
  return Uint8Array.from(out);
}

/* ── compile a translation with a C test driver and run it ───────────── */
function runC(module: Uint8Array, driver: string, env: Record<string, string> = {}, withGc = false): string {
  const c = wasmModuleToC(module, { hostImports: new Map() });
  const dir = mkdtempSync(join(tmpdir(), "tsinter-wasm2c-whole-"));
  try {
    writeFileSync(join(dir, "mod.c"), c);
    writeFileSync(
      join(dir, "t.c"),
      `#define _GNU_SOURCE
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <signal.h>
#include "mod.c"
uint8_t *w_hostmem;
static jmp_buf jb;
static int trapped_kind;
_Noreturn void w_trap(int kind) { trapped_kind = kind; longjmp(jb, 1); }
#define MEMRES ((size_t)8 << 30)
uint8_t *w_mem_reserve(uint32_t pages) {
  uint8_t *p = mmap(NULL, MEMRES, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (pages) mprotect(p, (size_t)pages << 16, PROT_READ | PROT_WRITE);
  return p;
}
int32_t w_mem_grow(uint8_t **base, uint32_t *pages, int32_t delta, uint32_t max) {
  uint32_t old = *pages, d = (uint32_t)delta;
  if ((uint64_t)old + d > max || (uint64_t)old + d > 65536) return -1;
  if (d) mprotect(*base + ((size_t)old << 16), (size_t)d << 16, PROT_READ | PROT_WRITE);
  *pages = old + d;
  return (int32_t)old;
}
void w_gc_set_stack_top(void *top);
int main(void) {
  volatile char top = 0;
  ${withGc ? "w_gc_set_stack_top((void *)(&top + 64));" : "(void)top;"}
  w_init();
${driver}
  return 0;
}
`,
    );
    execFileSync("clang", [
      ...wasmNativeCflags(false),
      `-I${RT}`,
      join(dir, "t.c"),
      ...(withGc ? [join(RT, "wn_gc.c")] : []),
      "-o",
      join(dir, "t"),
      "-lm",
    ]);
    return execFileSync(join(dir, "t"), { env: { ...process.env, ...env }, maxBuffer: 64 << 20 }).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WA = (globalThis as unknown as { WebAssembly: { Module: new (b: Uint8Array) => object; Instance: new (m: object, i: object) => { exports: Record<string, (...a: unknown[]) => unknown> } } }).WebAssembly;
function instantiate(bytes: Uint8Array): Record<string, (...a: unknown[]) => unknown> {
  return new WA.Instance(new WA.Module(bytes), {}).exports;
}

/* ── numbers ─────────────────────────────────────────────────────────── */
const f64bits = (x: number): bigint => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x, true);
  return b.getBigInt64(0, true);
};
const f32bits = (x: number): number => {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, x, true);
  return b.getInt32(0, true);
};
const I32V = [0, 1, -1, 2, 31, 32, 33, -2147483648, 2147483647, 0x55555555, -0x55555556, 7, -7, 100, -2147483647];
const I64V = [0n, 1n, -1n, 2n, 63n, 64n, 65n, -(2n ** 63n), 2n ** 63n - 1n, 0x5555555555555555n, 7n, -7n, 0x100000000n, -0x100000001n, -(2n ** 63n) + 1n];
const FV = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, 2.5, -2.5, 3.5, 1e300, -1e300, Infinity, -Infinity, 2 ** 31, -(2 ** 31), 2 ** 31 - 0.5, -(2 ** 31) - 1, 2 ** 32, 2 ** 32 - 1, 4294967295.5, 2 ** 63, -(2 ** 63), 2 ** 64, 5e-324,
  -5e-324, 0.1, 123456789.75, 9007199254740993, 1.7976931348623157e308, 16777217, -1.0000001,
];
const F64V: bigint[] = [...FV.map(f64bits), f64bits(NaN), BigInt.asIntN(64, 0xfff8000000000000n), BigInt.asIntN(64, 0x7ff4000000000001n), BigInt.asIntN(64, 0xfff0000000000123n)];
const F32V: number[] = [...FV.map((x) => f32bits(Math.fround(x))), f32bits(NaN), 0xffc00000 | 0, 0x7fa00000, 0xff800123 | 0];
const VALS: Record<NT, (number | bigint)[]> = { i32: I32V, i64: I64V, f32: F32V, f64: F64V };
const BITS: Record<NT, NT> = { i32: "i32", i64: "i64", f32: "i32", f64: "i64" };

interface Op {
  name: string;
  /** pushed before the operands */
  pre?: number[];
  code: number[];
  args: NT[];
  res: NT;
}
const ops: Op[] = [];
const un = (name: string, code: number[], a: NT, res: NT): void => void ops.push({ name, code, args: [a], res });
const bi = (name: string, code: number[], a: NT, res: NT): void => void ops.push({ name, code, args: [a, a], res });
// i32
un("i32.eqz", [0x45], "i32", "i32");
for (const [n, c] of [["eq", 0x46], ["ne", 0x47], ["lt_s", 0x48], ["lt_u", 0x49], ["gt_s", 0x4a], ["gt_u", 0x4b], ["le_s", 0x4c], ["le_u", 0x4d], ["ge_s", 0x4e], ["ge_u", 0x4f]] as const) bi(`i32.${n}`, [c], "i32", "i32");
for (const [n, c] of [["clz", 0x67], ["ctz", 0x68], ["popcnt", 0x69], ["extend8_s", 0xc0], ["extend16_s", 0xc1]] as const) un(`i32.${n}`, [c], "i32", "i32");
for (let c = 0x6a; c <= 0x78; c++) bi(`i32.op${c.toString(16)}`, [c], "i32", "i32");
// i64
un("i64.eqz", [0x50], "i64", "i32");
for (let c = 0x51; c <= 0x5a; c++) bi(`i64.cmp${c.toString(16)}`, [c], "i64", "i32");
for (const c of [0x79, 0x7a, 0x7b, 0xc2, 0xc3, 0xc4]) un(`i64.op${c.toString(16)}`, [c], "i64", "i64");
for (let c = 0x7c; c <= 0x8a; c++) bi(`i64.op${c.toString(16)}`, [c], "i64", "i64");
// f32
for (let c = 0x5b; c <= 0x60; c++) bi(`f32.cmp${c.toString(16)}`, [c], "f32", "i32");
for (let c = 0x8b; c <= 0x91; c++) un(`f32.op${c.toString(16)}`, [c], "f32", "f32");
for (let c = 0x92; c <= 0x98; c++) bi(`f32.op${c.toString(16)}`, [c], "f32", "f32");
// f64
for (let c = 0x61; c <= 0x66; c++) bi(`f64.cmp${c.toString(16)}`, [c], "f64", "i32");
for (let c = 0x99; c <= 0x9f; c++) un(`f64.op${c.toString(16)}`, [c], "f64", "f64");
for (let c = 0xa0; c <= 0xa6; c++) bi(`f64.op${c.toString(16)}`, [c], "f64", "f64");
// an operation with an identity constant still runs (clang's default FP
// model folds these into a sign flip or the operand itself, which changes a
// NaN operand's bits; V8 executes the instruction)
const f64c = (x: number): number[] => [0x44, ...new Uint8Array(new Float64Array([x]).buffer)];
const f32c = (x: number): number[] => [0x43, ...new Uint8Array(new Float32Array([x]).buffer)];
for (const [n, k, op] of [["mul-1", -1, 0xa2], ["div-1", -1, 0xa3], ["mul1", 1, 0xa2], ["div1", 1, 0xa3], ["sub0", 0, 0xa1], ["add-0", -0, 0xa0], ["sub-0", -0, 0xa1], ["add0", 0, 0xa0]] as const) {
  un(`f64.${n}`, [...f64c(k), op], "f64", "f64");
  un(`f32.${n}`, [...f32c(k), op - 0x0e], "f32", "f32");
}
// -0.0 - x (the constant goes first)
ops.push({ name: "f64.negzero-sub", pre: f64c(-0), code: [0xa1], args: ["f64"], res: "f64" });
ops.push({ name: "f32.negzero-sub", pre: f32c(-0), code: [0x93], args: ["f32"], res: "f32" });
// conversions
un("i32.wrap_i64", [0xa7], "i64", "i32");
un("i32.trunc_f32_s", [0xa8], "f32", "i32");
un("i32.trunc_f32_u", [0xa9], "f32", "i32");
un("i32.trunc_f64_s", [0xaa], "f64", "i32");
un("i32.trunc_f64_u", [0xab], "f64", "i32");
un("i64.extend_i32_s", [0xac], "i32", "i64");
un("i64.extend_i32_u", [0xad], "i32", "i64");
un("i64.trunc_f32_s", [0xae], "f32", "i64");
un("i64.trunc_f32_u", [0xaf], "f32", "i64");
un("i64.trunc_f64_s", [0xb0], "f64", "i64");
un("i64.trunc_f64_u", [0xb1], "f64", "i64");
un("f32.convert_i32_s", [0xb2], "i32", "f32");
un("f32.convert_i32_u", [0xb3], "i32", "f32");
un("f32.convert_i64_s", [0xb4], "i64", "f32");
un("f32.convert_i64_u", [0xb5], "i64", "f32");
un("f32.demote_f64", [0xb6], "f64", "f32");
un("f64.convert_i32_s", [0xb7], "i32", "f64");
un("f64.convert_i32_u", [0xb8], "i32", "f64");
un("f64.convert_i64_s", [0xb9], "i64", "f64");
un("f64.convert_i64_u", [0xba], "i64", "f64");
un("f64.promote_f32", [0xbb], "f32", "f64");
const satArgs: NT[] = ["f32", "f32", "f64", "f64", "f32", "f32", "f64", "f64"];
for (let s = 0; s < 8; s++) un(`trunc_sat${s}`, [0xfc, s], satArgs[s]!, s < 4 ? "i32" : "i64");

function numericModule(): { bytes: Uint8Array; typeOf: Map<string, number> } {
  const typeOf = new Map<string, number>();
  const types: number[][] = [];
  const fnType = (args: NT[], res: NT): number => {
    const key = `${args.map((a) => BITS[a]).join(",")}->${BITS[res]}`;
    let t = typeOf.get(key);
    if (t === undefined) {
      t = types.length;
      types.push([0x60, ...vec(args.map((a) => [T[BITS[a]]])), ...vec([[T[BITS[res]]]])]);
      typeOf.set(key, t);
    }
    return t;
  };
  const funcs: Fn[] = ops.map((op) => {
    const body: number[] = [...(op.pre ?? [])];
    op.args.forEach((a, k) => {
      body.push(0x20, k);
      if (a === "f32") body.push(0xbe);
      if (a === "f64") body.push(0xbf);
    });
    body.push(...op.code);
    if (op.res === "f32") body.push(0xbc);
    if (op.res === "f64") body.push(0xbd);
    return { type: fnType(op.args, op.res), body };
  });
  return { bytes: assemble({ types, funcs, exportAll: true }), typeOf };
}

const hex = (v: number | bigint, t: NT): string => (BITS[t] === "i32" ? (Number(v) >>> 0).toString(16) : BigInt.asUintN(64, BigInt(v)).toString(16));
const cLit = (v: number | bigint, t: NT): string => (BITS[t] === "i32" ? `(int32_t)${Number(v) >>> 0}u` : `(int64_t)${BigInt.asUintN(64, BigInt(v))}ull`);

describe("wasm2c whole-program profile: semantics against Node's WebAssembly", () => {
  test("numbers: every operator and conversion over edge operands, bit for bit (traps included)", () => {
    const { bytes } = numericModule();
    const x = instantiate(bytes);
    const expected: string[] = [];
    const drive: string[] = [];
    ops.forEach((op, k) => {
      const lists = op.args.map((a) => VALS[a]);
      const combos: (number | bigint)[][] = op.args.length === 1 ? lists[0]!.map((v) => [v]) : lists[0]!.flatMap((a) => lists[1]!.map((b) => [a, b]));
      // the C side: one array per argument, then the loop
      op.args.forEach((a, j) => drive.push(`  static const ${BITS[a] === "i32" ? "int32_t" : "int64_t"} a${k}_${j}[] = {${combos.map((cmb) => cLit(cmb[j]!, a)).join(",")}};`));
      const call = `f${k}(${op.args.map((_, j) => `a${k}_${j}[q]`).join(", ")})`;
      const fmt = BITS[op.res] === "i32" ? `printf("${k} %x\\n", (uint32_t)${call})` : `printf("${k} %llx\\n", (unsigned long long)(uint64_t)${call})`;
      drive.push(`  for (int q = 0; q < ${combos.length}; q++) { if (setjmp(jb)) printf("${k} TRAP\\n"); else ${fmt}; }`);
      for (const cmb of combos) {
        let r: string;
        try {
          r = hex(x[`e${k}`]!(...cmb.map((v, j) => (BITS[op.args[j]!] === "i64" ? BigInt(v) : Number(v)))) as number | bigint, op.res);
        } catch {
          r = "TRAP";
        }
        expected.push(`${k} ${r}`);
      }
    });
    const got = runC(bytes, drive.join("\n")).trimEnd().split("\n");
    const name = (line: string): string => ops[Number(line.split(" ")[0])]!.name;
    const diffs = got.map((g, i) => (g !== expected[i] ? `${name(g)}: got ${g}, want ${expected[i]}` : null)).filter((d) => d !== null);
    // by operator: how many operand sets differ, and the first of them
    const byOp = new Map<string, string[]>();
    for (const d of diffs) {
      const op = d.slice(0, d.indexOf(":"));
      byOp.set(op, [...(byOp.get(op) ?? []), d]);
    }
    expect([...byOp].map(([op, ds]) => `${ds.length}× ${ds[0]}`)).toEqual([]);
    expect(got.length).toBe(expected.length);
  });

  test("linear memory: every load and store width, the end of memory, grow/size, fill/copy bounds", () => {
    // memory 1 page (max 2); data: bytes 0..255 repeated over the first 512
    const loads: [number, NT][] = [
      [0x28, "i32"], [0x29, "i64"], [0x2a, "f32"], [0x2b, "f64"], [0x2c, "i32"], [0x2d, "i32"], [0x2e, "i32"], [0x2f, "i32"],
      [0x30, "i64"], [0x31, "i64"], [0x32, "i64"], [0x33, "i64"], [0x34, "i64"], [0x35, "i64"],
    ];
    const stores: [number, NT][] = [[0x36, "i32"], [0x37, "i64"], [0x38, "f32"], [0x39, "f64"], [0x3a, "i32"], [0x3b, "i32"], [0x3c, "i64"], [0x3d, "i64"], [0x3e, "i64"]];
    const types = [
      [0x60, ...vec([[0x7f]]), ...vec([[0x7f]])], // 0: i32 -> i32
      [0x60, ...vec([[0x7f]]), ...vec([[0x7e]])], // 1: i32 -> i64
      [0x60, ...vec([[0x7f], [0x7f], [0x7f]]), ...vec([[0x7f]])], // 2: i32 i32 i32 -> i32
    ];
    const funcs: Fn[] = [];
    for (const [c, t] of loads) {
      const body = [0x20, 0, c, 0x00, 0x03];
      if (t === "f32") body.push(0xbc);
      if (t === "f64") body.push(0xbd);
      funcs.push({ type: BITS[t] === "i32" ? 0 : 1, body });
    }
    for (const [c, t] of stores) {
      // store a fixed pattern at addr, then read back 8 bytes at addr (i64)
      const val = t === "i32" ? [0x41, ...sleb(-0x12345679)] : t === "i64" ? [0x42, ...sleb(-0x123456789abcdefn)] : t === "f32" ? [0x43, 0x00, 0x00, 0xc0, 0x7f] : [0x44, 0, 0, 0, 0, 0, 0, 0xf8, 0xff];
      funcs.push({ type: 1, body: [0x20, 0, ...val, c, 0x00, 0x00, 0x20, 0, 0x29, 0x00, 0x00] });
    }
    // grow by n, answer the old size * 1000 + the new size
    funcs.push({ type: 0, body: [0x20, 0, 0x40, 0x00, 0x41, ...sleb(1000), 0x6c, 0x3f, 0x00, 0x6a] });
    // fill(d, v, n) then read 4 bytes at d
    funcs.push({ type: 2, body: [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 0x00, 0x20, 0, 0x28, 0x00, 0x00] });
    // copy(d, s, n) then read 4 bytes at d
    funcs.push({ type: 2, body: [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 0x00, 0x00, 0x20, 0, 0x28, 0x00, 0x00] });
    // a load whose value is dropped still traps where wasm's does (C would
    // let the compiler delete an unused out-of-bounds read)
    funcs.push({ type: 0, body: [0x20, 0, 0x28, 0x02, 0x00, 0x1a, 0x20, 0, 0x29, 0x03, 0x05, 0x1a, 0x41, 7] });
    const pattern = Array.from({ length: 512 }, (_, i) => i & 0xff);
    const bytes = assemble({ types, funcs, memory: [1, 2], datas: [[0x00, 0x41, 0x00, 0x0b, ...uleb(512), ...pattern]], exportAll: true });
    const x = instantiate(bytes);
    const addrs = [0, 1, 7, 250, 65520, 65527, 65528, 65531, 65532, 65533, 65535, 65536, -1, -8];
    const expected: string[] = [];
    const drive: string[] = [];
    const nl = loads.length;
    const ns = stores.length;
    for (let k = 0; k < nl + ns; k++) {
      for (const a of addrs) {
        const res: NT = k < nl ? (BITS[loads[k]![1]] === "i32" ? "i32" : "i64") : "i64";
        let r: string;
        try {
          r = hex(x[`e${k}`]!(a) as number | bigint, res);
        } catch {
          r = "TRAP";
        }
        expected.push(`${k} ${a} ${r}`);
        const fmt = res === "i32" ? `printf("${k} ${a} %x\\n", (uint32_t)f${k}(${a}))` : `printf("${k} ${a} %llx\\n", (unsigned long long)(uint64_t)f${k}(${a}))`;
        drive.push(`  if (setjmp(jb)) printf("${k} ${a} TRAP\\n"); else ${fmt};`);
      }
    }
    const g = nl + ns;
    for (const d of [0, 1, 1, 5]) {
      let r: string;
      try {
        r = hex(x[`e${g}`]!(d) as number, "i32");
      } catch {
        r = "TRAP";
      }
      expected.push(`${g} ${d} ${r}`);
      drive.push(`  if (setjmp(jb)) printf("${g} ${d} TRAP\\n"); else printf("${g} ${d} %x\\n", (uint32_t)f${g}(${d}));`);
    }
    for (const k of [g + 1, g + 2]) {
      for (const [d, v, n] of [[0, 300, 4], [100, 7, 10], [65530, 1, 6], [65530, 1, 7], [131066, 1, 6], [131066, 1, 7], [10, 0, 0], [131072, 0, 0], [131073, 0, 0]]) {
        let r: string;
        try {
          r = hex(x[`e${k}`]!(d, v, n) as number, "i32");
        } catch {
          r = "TRAP";
        }
        expected.push(`${k} ${d} ${r}`);
        drive.push(`  if (setjmp(jb)) printf("${k} ${d} TRAP\\n"); else printf("${k} ${d} %x\\n", (uint32_t)f${k}(${d}, ${v}, ${n}));`);
      }
    }
    for (const a of [0, 131060, 131064, 131065, 131068, -1]) {
      const k = g + 3;
      let r: string;
      try {
        r = hex(x[`e${k}`]!(a) as number, "i32");
      } catch {
        r = "TRAP";
      }
      expected.push(`${k} ${a} ${r}`);
      drive.push(`  if (setjmp(jb)) printf("${k} ${a} TRAP\\n"); else printf("${k} ${a} %x\\n", (uint32_t)f${k}(${a}));`);
    }
    const got = runC(bytes, drive.join("\n")).trimEnd().split("\n");
    expect(got).toEqual(expected);
  });

  test("GC: structs, arrays, packed reads, casts across subtypes, br_on_null, call_ref, call_indirect — and a long structure built under a collector that runs every few allocations", () => {
    // types
    //  0: $A (sub (struct (field (mut i32))))            open
    //  1: $B (sub $A (struct (field (mut i32)) (field (mut i64))))
    //  2: $N (struct (field (mut i32)) (field (mut f64)) (field (mut (ref null 2))) (field (mut i8)))  — a list node (self-ref: own rec group)
    //  3: $S (array (mut i16))
    //  4: $R (array (mut (ref null 2)))
    //  5: func i32 -> i32
    //  6: func i32 -> i64
    //  7: func -> i32
    const types = [
      [0x50, 0x00, 0x5f, ...vec([[0x7f, 0x01]])],
      [0x50, 0x01, 0x00, 0x5f, ...vec([[0x7f, 0x01], [0x7e, 0x01]])],
      [0x5f, ...vec([[0x7f, 0x01], [0x7c, 0x01], [0x63, 0x02, 0x01], [0x78, 0x01]])],
      [0x5e, 0x77, 0x01],
      [0x5e, 0x63, 0x02, 0x01],
      [0x60, ...vec([[0x7f]]), ...vec([[0x7f]])],
      [0x60, ...vec([[0x7f]]), ...vec([[0x7e]])],
      [0x60, ...vec([]), ...vec([[0x7f]])],
    ];
    const funcs: Fn[] = [];
    // f0(n): build a list of n nodes (node k: i=k, f=k/2, i8 = k*37), plus
    // an array of 16 node refs per node kept only through the list's
    // head on the stack; walk it: sum i + trunc(f*2) + (i8 get_s); answer
    // the sum. The collector runs during the build (stress).
    funcs.push({ type: 5, locals: [[1, 0x63, 0x02], [1, 0x7f], [1, 0x7f]], body: [] });
    funcs[0]!.body = [
      0x02, 0x40, // block
      0x03, 0x40, // loop
      0x20, 2, 0x20, 0, 0x4e, 0x0d, 1, // if k >= n break
      // l1 = struct.new N(k, k/2, l1, k*37)
      0x20, 2, // i
      0x20, 2, 0xb7, 0x44, 0, 0, 0, 0, 0, 0, 0xe0, 0x3f, 0xa2, // f = k * 0.5
      0x20, 1, // next
      0x20, 2, 0x41, 37, 0x6c, // i8
      0xfb, 0x00, 0x02, 0x21, 1,
      // a garbage array each step (16 refs to the head), dropped
      0x20, 1, 0x41, 16, 0xfb, 0x06, 0x04, 0x1a,
      0x20, 2, 0x41, 1, 0x6a, 0x21, 2,
      0x0c, 0, // br loop
      0x0b, 0x0b,
      // walk: l2 = 0 (sum)
      0x41, 0, 0x21, 2,
      0x02, 0x40, 0x03, 0x40,
      0x20, 1, 0xd1, 0x0d, 1, // if l1 == null break
      0x20, 2, 0x20, 1, 0xfb, 0x02, 0x02, 0x00, 0x6a, // + i
      0x20, 1, 0xfb, 0x02, 0x02, 0x01, 0x44, 0, 0, 0, 0, 0, 0, 0, 0x40, 0xa2, 0xaa, 0x6a, // + trunc(f*2)
      0x20, 1, 0xfb, 0x03, 0x02, 0x03, 0x6a, // + get_s i8
      0x21, 2,
      0x20, 1, 0xfb, 0x02, 0x02, 0x02, 0x21, 1, // l1 = next
      0x0c, 0, 0x0b, 0x0b,
      0x20, 2,
    ];
    // f1(k): an i16 array of 5 filled with -2+k...; answer get_s(k) * 65536 + get_u(k) (k out of range traps)
    funcs.push({
      type: 5,
      locals: [[1, 0x63, 0x03]],
      body: [
        0x41, ...sleb(-2), 0x41, 5, 0xfb, 0x06, 0x03, 0x21, 1,
        0x20, 1, 0x41, 1, 0x41, ...sleb(-30000), 0xfb, 0x0e, 0x03,
        0x20, 1, 0x20, 0, 0xfb, 0x0c, 0x03, 0x41, ...sleb(65536), 0x6c,
        0x20, 1, 0x20, 0, 0xfb, 0x0d, 0x03, 0x6a,
        0x20, 1, 0xfb, 0x0f, 0x6a, // + len
      ],
    });
    // f2(k): k=0 makes an $A, k=1 a $B, else null; answer test-as-$A*100 + test-as-$B*10 + test-null-as-$B
    const mk = [0x20, 0, 0x45, 0x04, 0x63, 0x00, 0x41, 1, 0xfb, 0x00, 0x00, 0x05, 0x20, 0, 0x41, 1, 0x46, 0x04, 0x63, 0x00, 0x41, 2, 0x42, 3, 0xfb, 0x00, 0x01, 0x05, 0xd0, 0x00, 0x0b, 0x0b];
    funcs.push({
      type: 5,
      locals: [[1, 0x63, 0x00]],
      body: [...mk, 0x21, 1, 0x20, 1, 0xfb, 0x14, 0x00, 0x41, 100, 0x6c, 0x20, 1, 0xfb, 0x14, 0x01, 0x41, 10, 0x6c, 0x6a, 0x20, 1, 0xfb, 0x15, 0x01, 0x6a],
    });
    // f3(k): cast the same value to $B (non-null) and read field 1: traps unless k = 1
    funcs.push({ type: 6, locals: [[1, 0x63, 0x00]], body: [...mk, 0xfb, 0x16, 0x01, 0xfb, 0x02, 0x01, 0x01] });
    // f4(k): br_on_null: null (k=2) answers 7, else field 0 of the value
    funcs.push({ type: 5, body: [0x02, 0x7f, 0x41, 7, ...mk, 0xd5, 0x00, 0xfb, 0x02, 0x00, 0x00, 0x6a, 0x41, 7, 0x6b, 0x0b] });
    // f5(k): call_ref of f6 through ref.func; f6(k) = k * 3
    funcs.push({ type: 5, body: [0x20, 0, 0xd2, 6, 0x14, 5] });
    funcs.push({ type: 5, body: [0x20, 0, 0x41, 3, 0x6c] });
    // f7(k): call_indirect table[k] as i32->i32 (table: [f6, f8, null]); f8 has type -> i32 (mismatch)
    funcs.push({ type: 5, body: [0x20, 0, 0x20, 0, 0x11, 5, 0x00] });
    funcs.push({ type: 7, body: [0x41, 9] });
    const bytes = assemble({
      types,
      funcs,
      tables: [[0x70, 0x00, 0x03]],
      elems: [[0x00, 0x41, 0x00, 0x0b, ...vec([[6], [8]])], [0x03, 0x00, ...vec([[6]])]],
      exportAll: true,
    });
    const x = instantiate(bytes);
    const expected: string[] = [];
    const drive: string[] = [];
    const cases: [number, number[]][] = [
      [0, [0, 1, 2, 100, 30000]],
      [1, [0, 1, 4, 5, -1]],
      [2, [0, 1, 2]],
      [3, [0, 1, 2]],
      [4, [0, 1, 2]],
      [5, [0, 5, -4]],
      [7, [0, 1, 2, 3]],
    ];
    for (const [k, args] of cases) {
      for (const a of args) {
        let r: string;
        try {
          const v = x[`e${k}`]!(a);
          r = typeof v === "bigint" ? BigInt.asUintN(64, v).toString(16) : (Number(v) >>> 0).toString(16);
        } catch {
          r = "TRAP";
        }
        expected.push(`${k} ${a} ${r}`);
        const fmt = k === 3 ? `printf("${k} ${a} %llx\\n", (unsigned long long)(uint64_t)f${k}(${a}))` : `printf("${k} ${a} %x\\n", (uint32_t)f${k}(${a}))`;
        drive.push(`  if (setjmp(jb)) printf("${k} ${a} TRAP\\n"); else ${fmt};`);
      }
    }
    for (const stress of ["", "3", "1"]) {
      const got = runC(bytes, drive.join("\n"), stress === "" ? {} : { WN_GC_STRESS: stress }, true).trimEnd().split("\n");
      expect(got).toEqual(expected);
    }
  });

  test("the runner: every trap kind prints V8's own text and exits 1 (array size limits included)", () => {
    // 0 $s (struct (mut i32))  1 $a (array (mut i8))  2 $ft func -> i32
    // 3 $ft2 func i32 -> i32   4 func -> ()           5 $r (array (mut (ref null $s)))
    const types = [
      [0x5f, ...vec([[0x7f, 0x01]])],
      [0x5e, 0x78, 0x01],
      [0x60, ...vec([]), ...vec([[0x7f]])],
      [0x60, ...vec([[0x7f]]), ...vec([[0x7f]])],
      [0x60, ...vec([]), ...vec([])],
      [0x5e, 0x63, 0x00, 0x01],
    ];
    const i32 = (n: number): number[] => [0x41, ...sleb(n)];
    const newA = (n: number): number[] => [...i32(n), 0xfb, 0x07, 0x01];
    const bodies: [string, number[]][] = [
      ["div_s overflow", [...i32(-2147483648), ...i32(-1), 0x6d, 0x1a]],
      ["div_u by zero", [...i32(1), ...i32(0), 0x6e, 0x1a]],
      ["rem_s by zero", [0x42, 1, 0x42, 0, 0x81, 0x1a]],
      ["rem_u by zero", [...i32(1), ...i32(0), 0x70, 0x1a]],
      ["trunc f32 range", [...f32c(2147483648), 0xa8, 0x1a]],
      ["trunc f64 range", [...f64c(-2147483649), 0xaa, 0x1a]],
      ["trunc_u negative", [...f64c(-1), 0xab, 0x1a]],
      ["trunc NaN", [...f64c(NaN), 0xb0, 0x1a]],
      ["load past the end", [...i32(65533), 0x28, 0x02, 0x00, 0x1a]],
      ["load offset overflow", [...i32(1), 0x28, 0x02, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x1a]],
      ["store past the end", [...i32(65536), ...i32(1), 0x3a, 0x00, 0x00]],
      ["fill past the end", [...i32(65536), ...i32(0), ...i32(1), 0xfc, 0x0b, 0x00]],
      ["copy past the end", [...i32(0), ...i32(65530), ...i32(7), 0xfc, 0x0a, 0x00, 0x00]],
      ["memory.init past the segment", [...i32(0), ...i32(3), ...i32(2), 0xfc, 0x08, 0x00, 0x00]],
      ["call_indirect null entry", [...i32(0), 0x11, 0x02, 0x00, 0x1a]],
      ["call_indirect past the table", [...i32(3), 0x11, 0x02, 0x00, 0x1a]],
      ["call_indirect signature", [...i32(1), ...i32(1), 0x11, 0x03, 0x00, 0x1a]],
      ["struct.get null", [0xd0, 0x00, 0xfb, 0x02, 0x00, 0x00, 0x1a]],
      ["array.get past the end", [...newA(3), ...i32(3), 0xfb, 0x0d, 0x01, 0x1a]],
      ["array.fill past the end", [...newA(3), ...i32(2), ...i32(0), ...i32(2), 0xfb, 0x10, 0x01]],
      ["array.copy past the end", [...newA(3), ...i32(1), ...newA(3), ...i32(0), ...i32(3), 0xfb, 0x11, 0x01, 0x01]],
      ["array.new_data past the segment", [...i32(2), ...i32(3), 0xfb, 0x09, 0x01, 0x00, 0x1a]],
      ["array.new length -1", [...newA(-1), 0x1a]],
      ["array.new 2e9", [...newA(2000000000), 0x1a]],
      ["array.new i8 at V8's limit", [...newA(1073741800), 0x1a]],
      ["array.new ref at V8's limit", [0xd0, 0x00, ...i32(134217725), 0xfb, 0x06, 0x05, 0x1a]],
      ["array.len null", [0xd0, 0x01, 0xfb, 0x0f, 0x1a]],
      ["ref.cast null", [0xd0, 0x00, 0xfb, 0x16, 0x00, 0x1a]],
      ["ref.cast wrong type", [...i32(0), 0xfb, 0x00, 0x00, 0xfb, 0x16, 0x01, 0x1a]],
      ["ref.as_non_null null", [0xd0, 0x00, 0xd4, 0x1a]],
      ["call_ref null", [0xd0, 0x02, 0x14, 0x02, 0x1a]],
    ];
    const funcs: Fn[] = [{ type: 2, body: [...i32(7)] }, ...bodies.map(([, body]) => ({ type: 4, body }))];
    const bytes = assemble({
      types,
      funcs,
      memory: [1, 1],
      tables: [[0x70, 0x00, 0x03]],
      elems: [[0x00, 0x41, 0x01, 0x0b, ...vec([[0]])]],
      datas: [[0x01, ...uleb(4), ...Buffer.from("abcd")]],
      dataCount: true,
      exportAll: true,
    });
    const x = instantiate(bytes);
    const want = bodies.map((_, j) => {
      try {
        x[`e${j + 1}`]!();
        return "returned";
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
    });
    // the translation linked with the real runner (its w_trap, its
    // collector, its host); main is replaced by a driver calling f<k>
    const c = wasmModuleToC(bytes, { hostImports: new Map() });
    const dir = mkdtempSync(join(tmpdir(), "tsinter-wasm2c-runner-"));
    try {
      writeFileSync(join(dir, "mod.c"), c);
      writeFileSync(
        join(dir, "drv.c"),
        `#include <stdlib.h>
#include "mod.c"
void w_gc_set_stack_top(void *top);
int main(int argc, char **argv) {
  volatile char top = 0;
  w_gc_set_stack_top((void *)(&top + 64));
  w_init();
  switch (atoi(argv[1])) {
${bodies.map((_, j) => `    case ${j + 1}: f${j + 1}(); break;`).join("\n")}
  }
  return 0;
}
`,
      );
      execFileSync("clang", [
        ...wasmNativeCflags(false),
        `-I${RT}`,
        "-Dmain=wn_runner_main",
        "-c",
        join(RT, "wn_main.c"),
        "-o",
        join(dir, "wn_main.o"),
      ]);
      execFileSync("clang", [...wasmNativeCflags(false), `-I${RT}`, join(dir, "drv.c"), join(dir, "wn_main.o"), join(RT, "wn_gc.c"), join(RT, "wn_host.c"), join(RT, "wn_ev.c"), "-o", join(dir, "t"), "-lpthread", "-lm"]);
      const got = bodies.map((_, j) => {
        try {
          execFileSync(join(dir, "t"), [String(j + 1)], { stdio: ["ignore", "pipe", "pipe"] });
          return "returned";
        } catch (e) {
          const err = e as { status: number; stderr: Buffer };
          return err.status === 1 ? err.stderr.toString().split("\n")[0]! : `exit ${err.status}: ${err.stderr.toString()}`;
        }
      });
      expect(bodies.map(([name], j) => `${name}: ${got[j]}`)).toEqual(bodies.map(([name], j) => `${name}: ${want[j]}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("function type identity includes reference heap types: call_indirect through a signature that differs only in a parameter's heap type traps", () => {
    // 0: $X (struct i32)  1: $Y (struct i64)  2: func (ref null $X) -> i32
    // 3: func (ref null $Y) -> i32  4: func i32 -> i32
    const types = [
      [0x5f, ...vec([[0x7f, 0x01]])],
      [0x5f, ...vec([[0x7e, 0x01]])],
      [0x60, ...vec([[0x63, 0x00]]), ...vec([[0x7f]])],
      [0x60, ...vec([[0x63, 0x01]]), ...vec([[0x7f]])],
      [0x60, ...vec([[0x7f]]), ...vec([[0x7f]])],
    ];
    const funcs: Fn[] = [
      { type: 2, body: [0x41, 5] }, // f0: the table's only entry, type (ref null $X) -> i32
      { type: 4, body: [0xd0, 0x00, 0x41, 0x00, 0x11, 0x02, 0x00] }, // f1: called as (ref null $X) -> i32: 5
      { type: 4, body: [0xd0, 0x01, 0x41, 0x00, 0x11, 0x03, 0x00] }, // f2: called as (ref null $Y) -> i32: a trap
    ];
    const bytes = assemble({ types, funcs, tables: [[0x70, 0x00, 0x01]], elems: [[0x00, 0x41, 0x00, 0x0b, ...vec([[0]])]], exportAll: true });
    const x = instantiate(bytes);
    const want = [1, 2].map((k) => {
      try {
        return `${k} ${String(x[`e${k}`]!(0))}`;
      } catch {
        return `${k} TRAP`;
      }
    });
    expect(want).toEqual(["1 5", "2 TRAP"]);
    const drive = [1, 2].map((k) => `  if (setjmp(jb)) printf("${k} TRAP\\n"); else printf("${k} %d\\n", f${k}(0));`).join("\n");
    expect(runC(bytes, drive).trimEnd().split("\n")).toEqual(want);
  });

  test("the stack-depth limit (SEMANTICS.md S117 (b)): a calling function counts its frame, 20,000 frames run, the next one traps W_TRAP_STACK; a leaf is not counted", () => {
    const types = [[0x60, ...vec([[0x7f]]), ...vec([[0x7f]])]];
    const funcs: Fn[] = [
      // f0(n) = n == 0 ? 0 : f0(n - 1) + 1
      { type: 0, body: [0x20, 0x00, 0x45, 0x04, 0x7f, 0x41, 0x00, 0x05, 0x20, 0x00, 0x41, 0x01, 0x6b, 0x10, 0x00, 0x41, 0x01, 0x6a, 0x0b] },
      // f1(n) = n + 1: a leaf
      { type: 0, body: [0x20, 0x00, 0x41, 0x01, 0x6a] },
    ];
    const bytes = assemble({ types, funcs, exportAll: true });
    const c = wasmModuleToC(bytes, { hostImports: new Map() });
    const f1 = c.slice(c.indexOf("static int32_t f1(int32_t p0) {"));
    expect(f1.slice(0, f1.indexOf("\n}"))).not.toContain("w_depth");
    const drive = [19999, 20000, 19999]
      .map((n) => `  w_depth = 0;\n  if (setjmp(jb)) printf("${n} TRAP %d\\n", trapped_kind == W_TRAP_STACK); else printf("${n} %d %u\\n", f0(${n}), w_depth);`)
      .join("\n");
    expect(runC(bytes, drive).trimEnd().split("\n")).toEqual(["19999 19999 0", "20000 TRAP 1", "19999 19999 0"]);
  });

  test("an instruction outside the whole-program subset throws, naming it", () => {
    const types = [[0x60, ...vec([[0x7f]]), ...vec([[0x7f]])]];
    // i32.atomic.load (0xfe 0x10) is outside
    const bytes = assemble({ types, funcs: [{ type: 0, body: [0x20, 0, 0xfe, 0x10, 0x02, 0x00] }], memory: [1, 1], exportAll: false });
    expect(() => wasmModuleToC(bytes, { hostImports: new Map() })).toThrow(/instruction 0xfe is outside the subset/);
  });
});
