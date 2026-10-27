/* scr_island_math.h — the engine's Math members, replaced by Node's, ONE
 * source for both engines: the native island (scr_island.c) and the WasmGC
 * tier's engine module (packages/runtime/src/wasm/isl_core.c, built into
 * engine.wasm by scripts/build-engine-wasm.mjs — rebuild it after editing
 * this file). The includer has quickjs.h and the functions below in scope:
 * scr_ieee754_* (scr_ieee754.cc over the vendored V8 ieee754.cc, compiled
 * into both) and scr_jsmath.h's ports. Static functions: include it from
 * one translation unit. */
#ifndef SCR_ISLAND_MATH_H
#define SCR_ISLAND_MATH_H

#include <math.h>
#include <stddef.h>

double scr_ieee754_acos(double x);
double scr_ieee754_acosh(double x);
double scr_ieee754_asin(double x);
double scr_ieee754_asinh(double x);
double scr_ieee754_atan(double x);
double scr_ieee754_atanh(double x);
double scr_ieee754_atan2(double y, double x);
double scr_ieee754_cbrt(double x);
double scr_ieee754_cos(double x);
double scr_ieee754_cosh(double x);
double scr_ieee754_exp(double x);
double scr_ieee754_expm1(double x);
double scr_ieee754_log(double x);
double scr_ieee754_log1p(double x);
double scr_ieee754_log2(double x);
double scr_ieee754_log10(double x);
double scr_ieee754_sin(double x);
double scr_ieee754_sinh(double x);
double scr_ieee754_tan(double x);
double scr_ieee754_tanh(double x);
double scr_math_minmax_nan(void);
double scr_math_min(double a, double b);
double scr_math_max(double a, double b);
double scr_math_round(double x);
double scr_js_pow(double x, double y);
double scr_math_hypot(const double *xs, size_t n);
double scr_math_sign(double x);
double scr_math_f16round(double x);

/* ── the engine's Math, computed as Node computes it (SEMANTICS.md S100) ──
 * Code the engine itself evaluates (embedded packages, a Math object
 * reached as a value) calls the engine's Math members, which quickjs-ng
 * computes with the C library (sin, cbrt, hypot, ...) where Node runs V8's
 * ieee754.cc and builtins. The vendored engine stays unmodified: at context
 * creation the members that can differ are replaced, as ordinary writable
 * properties of Math, by functions over the SAME code the compiled program
 * calls -- scr_ieee754_* (vendor/v8-ieee754's ieee754.cc) and scr_lib.c's
 * pow/hypot/sign/f16round/round/min/max. Each keeps its name and length;
 * the unary and binary ones use the engine's own f_f / f_f_f calling
 * convention, so the arguments convert exactly as the originals' did.
 * Members whose engine answer already is Node's, NaN bits included (abs,
 * floor, ceil, trunc, sqrt, fround, clz32, imul, random), keep the
 * engine's functions. What this cannot
 * reach is the engine's `**` OPERATOR (QuickJS's js_math_pow: libm pow
 * without V8's y = 2 / y = 0.5 pre-cases) -- S100 registers it. */
static JSValue isl_math_hypot(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  double small[8];
  double *xs = argc <= 8 ? small : js_malloc(ctx, sizeof(double) * (size_t)argc);
  if (!xs) return JS_EXCEPTION;
  for (int i = 0; i < argc; i++) {
    if (JS_ToFloat64(ctx, &xs[i], argv[i])) {
      if (xs != small) js_free(ctx, xs);
      return JS_EXCEPTION;
    }
  }
  double r = scr_math_hypot(xs, (size_t)argc);
  if (xs != small) js_free(ctx, xs);
  return JS_NewFloat64(ctx, r);
}

/* Math.max / Math.min: every argument ToNumber'd first (in order, a throw
 * propagating), then the fold from the seed over scr_lib.c's two-argument
 * compare -- the compiled program's own path, so a NaN answer is V8's
 * (scr_math_minmax_nan) rather than an operand's payload. */
static JSValue isl_math_minmax(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
  (void)this_val;
  double acc = magic ? -INFINITY : INFINITY;
  double small[8];
  double *xs = argc <= 8 ? small : js_malloc(ctx, sizeof(double) * (size_t)argc);
  if (!xs) return JS_EXCEPTION;
  for (int i = 0; i < argc; i++) {
    if (JS_ToFloat64(ctx, &xs[i], argv[i])) {
      if (xs != small) js_free(ctx, xs);
      return JS_EXCEPTION;
    }
  }
  for (int i = 0; i < argc; i++) acc = magic ? scr_math_max(acc, xs[i]) : scr_math_min(acc, xs[i]);
  if (xs != small) js_free(ctx, xs);
  return JS_NewFloat64(ctx, acc);
}

static void isl_install_math(JSContext *ctx) {
  static const struct { const char *name; double (*f)(double); } unary[] = {
    { "acos", scr_ieee754_acos }, { "acosh", scr_ieee754_acosh }, { "asin", scr_ieee754_asin },
    { "asinh", scr_ieee754_asinh }, { "atan", scr_ieee754_atan }, { "atanh", scr_ieee754_atanh },
    { "cbrt", scr_ieee754_cbrt }, { "cos", scr_ieee754_cos }, { "cosh", scr_ieee754_cosh },
    { "exp", scr_ieee754_exp }, { "expm1", scr_ieee754_expm1 }, { "log", scr_ieee754_log },
    { "log1p", scr_ieee754_log1p }, { "log2", scr_ieee754_log2 }, { "log10", scr_ieee754_log10 },
    { "sin", scr_ieee754_sin }, { "sinh", scr_ieee754_sinh }, { "tan", scr_ieee754_tan },
    { "tanh", scr_ieee754_tanh }, { "sign", scr_math_sign }, { "f16round", scr_math_f16round },
    { "round", scr_math_round },
  };
  static const struct { const char *name; double (*f)(double, double); } binary[] = {
    { "atan2", scr_ieee754_atan2 }, { "pow", scr_js_pow },
  };
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue math = JS_GetPropertyStr(ctx, global, "Math");
  for (size_t i = 0; i < sizeof unary / sizeof unary[0]; i++) {
    JSCFunctionType ft;
    ft.f_f = unary[i].f;
    JS_SetPropertyStr(ctx, math, unary[i].name,
                      JS_NewCFunction2(ctx, ft.generic, unary[i].name, 1, JS_CFUNC_f_f, 0));
  }
  for (size_t i = 0; i < sizeof binary / sizeof binary[0]; i++) {
    JSCFunctionType ft;
    ft.f_f_f = binary[i].f;
    JS_SetPropertyStr(ctx, math, binary[i].name,
                      JS_NewCFunction2(ctx, ft.generic, binary[i].name, 2, JS_CFUNC_f_f_f, 0));
  }
  JS_SetPropertyStr(ctx, math, "hypot", JS_NewCFunction(ctx, isl_math_hypot, "hypot", 2));
  JS_SetPropertyStr(ctx, math, "max", JS_NewCFunctionMagic(ctx, isl_math_minmax, "max", 2, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(ctx, math, "min", JS_NewCFunctionMagic(ctx, isl_math_minmax, "min", 2, JS_CFUNC_generic_magic, 0));
  JS_FreeValue(ctx, math);
  JS_FreeValue(ctx, global);
}

#endif /* SCR_ISLAND_MATH_H */
