/* Unit P1: a standalone module holding ONLY the run-time RegExp compiler
 * (regex-compiler.ts) and the regex value it builds, instantiated in this
 * process, so a test can call `compileViaWasm(pattern, flags)` with the
 * same signature the build-time pipeline's foldRegexNew has and compare
 * the two outcome for outcome. Built once per process. */
import { A, Fn, I32, type X } from "../src/backend/wasm/asm.js";
import { ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { RegexCompilerBuilder } from "../src/backend/wasm/regex-compiler.js";
import { RX, RX_FENCE_KEY } from "../src/backend/wasm/regex-compiler-tables.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";
import { RegexBuilder } from "../src/backend/wasm/regex-value.js";

export type RuntimeOutcome =
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

/** The module's size in bytes, for the size note. */
export let runtimeModuleBytes = 0;

function build(): Exports {
  const mb = new ModuleBuilder();
  const strT = mb.arrayType("i16", true);
  const re = new RegexBuilder(mb, strT);
  const interp = new RegexInterpreterBuilder(mb, strT, undefined, re.bcType);
  const rc = new RegexCompilerBuilder(mb, strT, re, () => interp.regexCanonicalize());
  const ref = (t: number): ValType => ({ kind: "ref", nullable: true, typeIndex: t });
  const def = (name: string, params: ValType[], results: ValType[], body: ($: A) => void): void => {
    const idx = mb.declareFunc(mb.funcType(params, results), name);
    const f = new Fn(params.length);
    const $ = new A(f);
    body($);
    mb.setBody(idx, f.locals, f.c.bytes());
    mb.exportFunc(name, idx);
  };
  const d = (name: string, params: ValType[], results: ValType[], body: ($: A, p: (i: number) => X) => X | void): void =>
    def(name, params, results, ($) => {
      const v = body($, (i) => $.l(i));
      if (v) v();
    });
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
  runtimeModuleBytes = bytes.length;
  const mod = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(mod, {}).exports as unknown as Exports;
}

function exportsOf(): Exports {
  instance ??= build();
  return instance;
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

/** The run-time compiler over (pattern, flags), as data. */
export function compileViaWasm(pattern: string, flags: string): RuntimeOutcome {
  const x = exportsOf();
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
  if (id < RX.FENCE_BASE) throw new Error(`regex-runtime-harness: unexpected kind for id ${id}`);
  return { kind: "fence", key: RX_FENCE_KEY[id - RX.FENCE_BASE]!, message, code: fromWasm(x, x.errCode()) };
}
