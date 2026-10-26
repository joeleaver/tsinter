/* The ONE RegExp compiler, run at build time (follow-up unit E, "P2").
 *
 * The run-time compiler (regex-compiler.ts, `%w.rec.compile`) is the only
 * regex compiler this backend has. A regex literal, the sticky clone a
 * literal `.split()` receiver needs, and a `new RegExp(p, f)` whose texts
 * fold at build time all get their bytecode (or their SyntaxError, or
 * their named fence) by RUNNING that same emitted function here, in the
 * compiler's own process: a standalone module holding only the compiler
 * and the regex value it builds is emitted by the same builders the
 * output module uses, instantiated once per process through the host's
 * WebAssembly (WasmGC), and called per pattern. What a program embeds for
 * a constant pattern is therefore exactly what it would compute for the
 * same texts at run time; there is no second code base to drift.
 *
 * The outcome is data: the regex value's fields (source, canonical flags,
 * bytecode, capture count, group names), a V8 SyntaxError message (the
 * compiler's own errMessage text), or a fence key (SEMANTICS.md S102).
 * Results are memoized per (pattern, flags). */
import { A, Fn, I32, type X } from "./asm.js";
import { ModuleBuilder, type ValType } from "./module.js";
import { RegexCompilerBuilder } from "./regex-compiler.js";
import { RX, RX_FENCE_KEY } from "./regex-compiler-tables.js";
import { RegexInterpreterBuilder } from "./regex-interpreter.js";
import { RegexBuilder } from "./regex-value.js";

export type RegexCompileOutcome =
  | { kind: "ok"; source: string; flags: string; bytes: Uint8Array; captureCount: number; groupNames: string[] | null }
  | { kind: "syntax"; message: string }
  | { kind: "fence"; key: string; message: string; code: string };

interface Exports {
  strNew(n: number): unknown;
  strSet(s: unknown, i: number, u: number): void;
  strLen(s: unknown): number;
  strAt(s: unknown, i: number): number;
  compile(p: unknown, f: unknown): unknown;
  errId(): number;
  errKind(): number;
  errMessage(): unknown;
  errCode(): unknown;
  isNull(r: unknown): number;
  reSource(r: unknown): unknown;
  reFlags(r: unknown): unknown;
  reBcLen(r: unknown): number;
  reBcAt(r: unknown, i: number): number;
  reCap(r: unknown): number;
  reNamesLen(r: unknown): number;
  reName(r: unknown, k: number): unknown;
}

let instance: Exports | null = null;
const memo = new Map<string, RegexCompileOutcome>();

/** The standalone compiler module's size in bytes (0 until first use). */
export let regexCompilerModuleBytes = 0;

function build(): Exports {
  const mb = new ModuleBuilder();
  const strT = mb.arrayType("i16", true);
  const re = new RegexBuilder(mb, strT);
  const interp = new RegexInterpreterBuilder(mb, strT, undefined, re.bcType);
  const rc = new RegexCompilerBuilder(mb, strT, re, () => interp.regexCanonicalize());
  const ref = (t: number): ValType => ({ kind: "ref", nullable: true, typeIndex: t });
  const d = (name: string, params: ValType[], results: ValType[], body: ($: A, p: (i: number) => X) => X | void): void => {
    const idx = mb.declareFunc(mb.funcType(params, results), name);
    const f = new Fn(params.length);
    const $ = new A(f);
    const v = body($, (i) => $.l(i));
    if (v) v();
    mb.setBody(idx, f.locals, f.c.bytes());
    mb.exportFunc(name, idx);
  };
  d("strNew", [I32], [ref(strT)], ($, p) => $.anew(strT, p(0)));
  d("strSet", [ref(strT), I32, I32], [], ($, p) => $.aset(strT, p(0), p(1), p(2)));
  d("strLen", [ref(strT)], [I32], ($, p) => $.alen(p(0)));
  d("strAt", [ref(strT), I32], [I32], ($, p) => $.agetU(strT, p(0), p(1)));
  mb.exportFunc("compile", rc.compileFn());
  mb.exportFunc("errId", rc.errIdFn());
  mb.exportFunc("errKind", rc.errKindFn());
  mb.exportFunc("errMessage", rc.errMessageFn());
  mb.exportFunc("errCode", rc.errCodeFn());
  const R = ref(re.regexType);
  d("isNull", [R], [I32], ($, p) => $.isNull(p(0)));
  d("reSource", [R], [ref(strT)], ($, p) => $.get(re.regexType, 0, p(0)));
  d("reFlags", [R], [ref(strT)], ($, p) => $.get(re.regexType, 1, p(0)));
  d("reBcLen", [R], [I32], ($, p) => $.alen($.get(re.regexType, 2, p(0))));
  d("reBcAt", [R, I32], [I32], ($, p) => $.agetU(re.bcType, $.get(re.regexType, 2, p(0)), p(1)));
  d("reCap", [R], [I32], ($, p) => $.get(re.regexType, 3, p(0)));
  d("reNamesLen", [R], [I32], ($, p) => $.sel(I32, $.isNull($.get(re.regexType, 4, p(0))), $.i(-1), $.alen($.get(re.regexType, 4, p(0)))));
  d("reName", [R, I32], [ref(strT)], ($, p) => $.aget(re.strArrType, $.get(re.regexType, 4, p(0)), p(1)));
  const bytes = mb.emit();
  regexCompilerModuleBytes = bytes.length;
  // The host's WebAssembly (this package's lib is ES-only, so its shape is
  // spelled out here rather than taken from DOM typings).
  const WA = (globalThis as unknown as { WebAssembly: { Module: new (b: Uint8Array) => object; Instance: new (m: object, i: object) => { exports: unknown } } }).WebAssembly;
  return new WA.Instance(new WA.Module(bytes), {}).exports as Exports;
}

function toWasm(x: Exports, s: string): unknown {
  const w = x.strNew(s.length);
  for (let i = 0; i < s.length; i++) x.strSet(w, i, s.charCodeAt(i));
  return w;
}

function fromWasm(x: Exports, w: unknown): string {
  const n = x.strLen(w);
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(x.strAt(w, i));
  return out;
}

/** A host without WasmGC (or any other failure to build the module) is
 * remembered, so every later call fails fast; callers turn the throw into
 * a named refusal (regex-fold.ts). */
let buildError: unknown = null;

function run(pattern: string, flags: string): RegexCompileOutcome {
  if (buildError !== null) throw buildError;
  if (instance === null) {
    try {
      instance = build();
    } catch (e) {
      buildError = e;
      throw e;
    }
  }
  const x = instance;
  const r = x.compile(toWasm(x, pattern), toWasm(x, flags));
  if (!x.isNull(r)) {
    const n = x.reBcLen(r);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = x.reBcAt(r, i);
    const nl = x.reNamesLen(r);
    const groupNames = nl < 0 ? null : Array.from({ length: nl }, (_, k) => fromWasm(x, x.reName(r, k)));
    return { kind: "ok", source: fromWasm(x, x.reSource(r)), flags: fromWasm(x, x.reFlags(r)), bytes, captureCount: x.reCap(r), groupNames };
  }
  const id = x.errId();
  const message = fromWasm(x, x.errMessage());
  if (x.errKind() === 1) return { kind: "syntax", message };
  if (id < RX.FENCE_BASE) throw new Error(`regex-buildtime: outcome id ${id} is neither a SyntaxError nor a fence`);
  return { kind: "fence", key: RX_FENCE_KEY[id - RX.FENCE_BASE]!, message, code: fromWasm(x, x.errCode()) };
}

/** The run-time compiler's outcome over (pattern, flags), as data. */
export function compileRegex(pattern: string, flags: string): RegexCompileOutcome {
  const key = JSON.stringify([pattern, flags]);
  let hit = memo.get(key);
  if (hit === undefined) {
    hit = run(pattern, flags);
    memo.set(key, hit);
  }
  return hit;
}
