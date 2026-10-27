/* The regex engine as one standalone module (follow-up units E and D).
 *
 * A module holding only the ONE regex compiler (regex-compiler.ts,
 * `%w.rec.compile`), the matcher (regex-interpreter.ts, `%w.re.exec`) and
 * the regex value they build (regex-value.ts), emitted by the same
 * builders the output module uses, plus a few accessor exports for a host
 * that cannot read GC objects itself. Two hosts run it:
 *
 *   - the build time (regex-buildtime.ts) instantiates it through the
 *     host's WebAssembly and compiles every constant pattern with it;
 *   - the native lanes compile the SAME module translated to C
 *     (backend/wasm2c.ts → packages/runtime/src/scr_regex_engine.h, held
 *     equal by native-regex-engine-drift.test.ts), so a native program's
 *     `new RegExp` and its matching are this compiler and this matcher.
 *
 * So the wasm tier's run-time compiler, its build time and the native
 * lanes all decide a pattern with one code base. */
import { A, Fn, I32, type X } from "./asm.js";
import { ModuleBuilder, type ValType } from "./module.js";
import { RegexCompilerBuilder } from "./regex-compiler.js";
import { RegexInterpreterBuilder } from "./regex-interpreter.js";
import { RegexBuilder } from "./regex-value.js";

export interface RegexEngineModule {
  bytes: Uint8Array;
  /** type indices of the GC types a host builds or reads */
  types: { str: number; bc: number; cap: number; regex: number; strArr: number };
}

let memo: RegexEngineModule | null = null;

export function regexEngineModule(): RegexEngineModule {
  if (memo !== null) return memo;
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
  // the matcher, for the native lanes (the build time never matches) and
  // the tests that hold the two hosts equal
  mb.exportFunc("exec", interp.exec());
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  const CAP = ref(interp.capType);
  d("reBc", [R], [ref(re.bcType)], ($, p) => $.get(re.regexType, 2, p(0)));
  d("capGet", [CAP, I32], [I32], ($, p) => $.aget(interp.capType, p(0), p(1)));
  d("capLen", [CAP], [I32], ($, p) => $.alen(p(0)));
  memo = {
    bytes: mb.emit(),
    types: { str: strT, bc: re.bcType, cap: interp.capType, regex: re.regexType, strArr: re.strArrType },
  };
  return memo;
}
