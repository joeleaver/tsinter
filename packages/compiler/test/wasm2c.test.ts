/* backend/wasm2c.ts, shape by shape (follow-up unit D review S1): every
 * control construct that carries values — br / br_if / br_table to a
 * block, a loop and the function frame, if/else with results, a loop with
 * a result, multi-value blocks and calls, return from inside nested
 * blocks, dead code after a branch — plus traps and the local.tee
 * ordering hazard. Each function is hand-assembled, translated to C,
 * compiled with clang and run beside the same module in Node's
 * WebAssembly over a set of arguments: every result (or trap) must agree.
 * And the subset's edge: an instruction outside it throws in the
 * translator, never yields C. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { wasmToC } from "../src/backend/wasm2c.js";
import { I32, ModuleBuilder } from "../src/backend/wasm/module.js";

const sleb = (n: number): number[] => {
  const out: number[] = [];
  let v = BigInt(n);
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
const c = (n: number): number[] => [0x41, ...sleb(n)];
const lg = (k: number): number[] => [0x20, k];
const ls = (k: number): number[] => [0x21, k];
const lt = (k: number): number[] => [0x22, k];
const br = (d: number): number[] => [0x0c, d];
const brIf = (d: number): number[] => [0x0d, d];
const brTable = (labels: number[], d: number): number[] => [0x0e, labels.length, ...labels, d];
const VOID = 0x40;
const RI32 = 0x7f;
const block = (bt: number[]): number[] => [0x02, ...bt];
const loop = (bt: number[]): number[] => [0x03, ...bt];
const if_ = (bt: number[]): number[] => [0x04, ...bt];
const ELSE = 0x05;
const END = 0x0b;
const ADD = 0x6a;
const SUB = 0x6b;
const LT_S = 0x48;
const DIV_S = 0x6d;
const DROP = 0x1a;
const RET = 0x0f;
const UNREACHABLE = 0x00;

interface Fn {
  name: string;
  results: number; // i32 results
  locals?: number; // extra i32 locals
  body: (env: { pairType: number; callIdx: (name: string) => number }) => number[];
}

const FNS: Fn[] = [
  // br_if to the function frame: taken returns 7, not taken falls through with 7 still there
  { name: "brIfFunc", results: 1, body: () => [...c(7), ...lg(0), ...brIf(0), ...c(1), ADD] },
  // the same with two values
  { name: "brIfFunc2", results: 2, body: () => [...c(3), ...c(4), ...lg(0), ...brIf(0), DROP, DROP, ...c(5), ...c(6)] },
  // the reviewer's row: br_if 0 then return
  { name: "brIfThenReturn", results: 1, body: () => [...c(1), ...c(7), ...lg(0), ...brIf(0), RET] },
  // br_if to a block with a value, the value kept on fall-through
  { name: "brIfBlock", results: 1, body: () => [...block([RI32]), ...c(5), ...lg(0), ...brIf(0), ...c(1), ADD, END, ...c(100), ADD] },
  // br_if two levels out
  { name: "brIfNested", results: 1, body: () => [...block([RI32]), ...block([RI32]), ...c(1), ...lg(0), ...brIf(1), DROP, ...c(2), END, ...c(10), ADD, END] },
  // br (unconditional) out of a block with a value, dead code after it
  {
    name: "brDead",
    results: 1,
    body: () => [...block([RI32]), ...c(3), ...br(0), ...block([VOID]), ...c(1), DROP, ...loop([VOID]), ...br(0), END, END, ADD, UNREACHABLE, END, ...c(1), ADD],
  },
  // br_table to blocks with values
  { name: "brTableBlocks", results: 1, body: () => [...block([RI32]), ...block([RI32]), ...c(10), ...lg(0), ...brTable([0, 1], 1), END, ...c(1), ADD, END] },
  // br_table to the function frame (index 0) or a block
  { name: "brTableFunc", results: 1, body: () => [...block([RI32]), ...c(42), ...lg(0), ...brTable([1], 0), END, ...c(1), ADD] },
  // br_table to a loop (continue) or out of a block (exit): counts to p
  {
    name: "brTableLoop",
    results: 1,
    locals: 1,
    body: () => [...block([VOID]), ...loop([VOID]), ...lg(1), ...c(1), ADD, ...ls(1), ...lg(1), ...lg(0), LT_S, ...brTable([1], 0), END, END, ...lg(1)],
  },
  // if/else with a result
  { name: "ifElse", results: 1, body: () => [...lg(0), ...if_([RI32]), ...c(1), ELSE, ...c(2), END] },
  // if with a result whose then-arm branches out of the if with its value
  { name: "ifBr", results: 1, body: () => [...lg(0), ...if_([RI32]), ...c(7), ...br(0), ELSE, ...c(8), END, ...c(100), ADD] },
  // if with a result whose then-arm returns from the function
  { name: "ifReturn", results: 1, body: () => [...lg(0), ...if_([RI32]), ...c(55), RET, ELSE, ...c(8), END, ...c(100), ADD] },
  // a loop with a result (falls through once)
  { name: "loopResult", results: 1, body: () => [...loop([RI32]), ...c(9), END, ...c(1), ADD] },
  // a multi-value block (type index) left by br_if with both values
  { name: "multiBlock", results: 1, body: ({ pairType }) => [...block(sleb(pairType)), ...c(1), ...c(5), ...lg(0), ...brIf(0), DROP, DROP, ...c(3), ...c(4), END, SUB] },
  // a multi-value call
  { name: "callMulti", results: 1, body: ({ callIdx }) => [...lg(0), 0x10, callIdx("brIfFunc2"), ADD] },
  // return from inside nested blocks
  { name: "nestedReturn", results: 1, body: () => [...block([VOID]), ...block([VOID]), ...lg(0), ...if_([VOID]), ...c(77), RET, END, END, END, ...c(1)] },
  // local.tee after a pending read of the same local: the read is the old value
  { name: "teeOrder", results: 1, body: () => [...lg(0), ...c(5), ...lt(0), ADD, ...lg(0), ADD] },
  // traps: division by zero (always); unreachable on a true argument
  { name: "divZero", results: 1, body: () => [...lg(0), ...c(0), DIV_S] },
  { name: "unreachableIf", results: 1, body: () => [...lg(0), ...if_([VOID]), UNREACHABLE, END, ...c(5)] },
  // INT32_MIN / -1 traps; other quotients wrap nothing
  { name: "divOverflow", results: 1, body: () => [...c(-2147483648), ...lg(0), DIV_S] },
];

const ARGS = [-1, 0, 1, 2, 3, 5];

function buildModule(): Uint8Array {
  const mb = new ModuleBuilder();
  const pairType = mb.funcType([], [I32, I32]);
  const idx = new Map<string, number>();
  for (const f of FNS) idx.set(f.name, mb.declareFunc(mb.funcType([I32], Array(f.results).fill(I32)), f.name));
  for (const f of FNS) {
    const body = f.body({ pairType, callIdx: (n) => idx.get(n)! });
    mb.setBody(idx.get(f.name)!, Array(f.locals ?? 0).fill(I32), Uint8Array.from(body));
    mb.exportFunc(f.name, idx.get(f.name)!);
  }
  return mb.emit();
}

describe("wasm2c: control shapes with values, traps, and the subset's edge", () => {
  test("every function, every argument: the C translation answers what the wasm does", () => {
    const bytes = buildModule();
    const WA = (globalThis as unknown as { WebAssembly: { Module: new (b: Uint8Array) => object; Instance: new (m: object, i: object) => { exports: Record<string, (p: number) => number | number[]> } } }).WebAssembly;
    const x = new WA.Instance(new WA.Module(bytes), {}).exports;
    const expected: string[] = [];
    for (const f of FNS)
      for (const p of ARGS) {
        let r: string;
        try {
          const v = x[f.name]!(p);
          r = Array.isArray(v) ? v.join(",") : String(v);
        } catch {
          r = "TRAP";
        }
        expected.push(`${f.name} ${p} ${r}`);
      }
    const { c: tr } = wasmToC(bytes, { prefix: "t_", exportName: (n) => `t_x_${n}` });
    const calls: string[] = [];
    for (const f of FNS)
      for (const p of ARGS) {
        const call = `t_x_${f.name}(${p})`;
        const print = f.results === 1 ? `printf("${f.name} ${p} %d\\n", ${call});` : `{ t_res_ii r = ${call}; printf("${f.name} ${p} %d,%d\\n", r.v0, r.v1); }`;
        calls.push(`  if (setjmp(jb)) printf("${f.name} ${p} TRAP\\n"); else ${print}`);
      }
    const src = `#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static jmp_buf jb;
${tr}
static _Noreturn void t_trap(void) { longjmp(jb, 1); }
static _Noreturn void t_oom(void) { abort(); }
int main(void) {
${calls.join("\n")}
  return 0;
}
`;
    const dir = mkdtempSync(join(tmpdir(), "tsinter-wasm2c-"));
    try {
      writeFileSync(join(dir, "t.c"), src);
      execFileSync("clang", ["-std=c11", "-O2", "-fno-strict-aliasing", "-Wno-unused-function", join(dir, "t.c"), "-o", join(dir, "t")]);
      const got = execFileSync(join(dir, "t")).toString().trimEnd().split("\n");
      expect(got).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an instruction outside the subset throws, naming it", () => {
    const mb = new ModuleBuilder();
    const f = mb.declareFunc(mb.funcType([I32], [I32]), "f");
    mb.setBody(f, [], Uint8Array.from([...lg(0), 0x67])); // i32.clz
    mb.exportFunc("f", f);
    expect(() => wasmToC(mb.emit(), { prefix: "t_", exportName: (n) => n })).toThrow(/instruction 0x67 is outside the subset/);
  });
});
