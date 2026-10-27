/* scr_jsmath.h — the Math members V8 computes in its builtins rather than
 * in ieee754.cc, ported once (SEMANTICS.md S100) and compiled into BOTH
 * engines' hosts: the native runtime (scr_lib.c includes this file where
 * the definitions used to be, so the compiled program and the native
 * island's engine call them) and the WasmGC tier's engine module
 * (packages/runtime/src/wasm/isl_core.c, built into engine.wasm by
 * scripts/build-engine-wasm.mjs — rebuild it after editing this file).
 * External definitions, in two parts a translation unit selects by
 * defining SCR_JSMATH_NAN (scr_math_minmax_nan, which scr_array.c's folds
 * call — scr_array.c includes this part) and/or SCR_JSMATH_LIB (the rest —
 * scr_lib.c); the engine's isl_core.c defines both. Each part belongs to
 * exactly one translation unit per link. The wasm tier's static code computes the same arms in emitted wasm
 * (emitter.ts: emitMath, emitHypot, f16roundHelper, jsPowHelper).
 *
 * SCR_JSMATH_POW(x, y) is the C library pow behind scr_js_pow's general
 * case: the platform's (glibc on Linux, as Node's own — S079) natively; the
 * wasm engine binds it to the module's own %w.jsPow, the tier's port of
 * that glibc build, since wasi-libc's pow is musl's. */

#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifndef SCR_JSMATH_POW
#define SCR_JSMATH_POW(x, y) pow(x, y)
#endif

#if defined(SCR_JSMATH_NAN) && !defined(SCR_JSMATH_NAN_DONE)
#define SCR_JSMATH_NAN_DONE
/* The NaN V8's Float64Min/Float64Max answer for any NaN operand: the one
 * the machine's invalid operation produces (0xfff8000000000000 on x86-64,
 * measured -- whatever the operands' payloads), computed at run time so it
 * is the machine's, not a folded constant. */
double scr_math_minmax_nan(void) {
  volatile double z = 0.0;
  return z / z;
}

#endif

#if defined(SCR_JSMATH_LIB) && !defined(SCR_JSMATH_LIB_DONE)
#define SCR_JSMATH_LIB_DONE
double scr_math_min(double a, double b) {
  if (isnan(a) || isnan(b)) return scr_math_minmax_nan();
  if (a == 0.0 && b == 0.0) return signbit(a) ? a : b; /* -0 wins */
  return a < b ? a : b;
}

double scr_math_max(double a, double b) {
  if (isnan(a) || isnan(b)) return scr_math_minmax_nan();
  if (a == 0.0 && b == 0.0) return signbit(a) ? b : a; /* +0 wins */
  return a > b ? a : b;
}

/* Math.round: ECMA half-toward-+Infinity. NOT C round() (half away from
 * zero: round(-1.5) is -2 where JS answers -1) and NOT floor(x + 0.5)
 * (the float ADD drifts at the epsilon boundary: 0.49999999999999994 +
 * 0.5 == 1.0 in doubles where the exact sum is below one — JS answers
 * 0). x - floor(x) is exact for doubles EXCEPT on (-0.5, 0), where
 * Sterbenz does not apply (floor is -1, |x| < 0.5): there the exact
 * fraction is in (0.5, 1) and the rounded one in [0.5, 1] (it is exactly
 * 1 for most of the doubles in the interval — every x in [-2^-54, 0),
 * e.g. -5e-324), so both take the same `< 0.5` else-arm and the
 * comparison still decides correctly (at -0.49999999999999994 the stored
 * fraction is exactly 0.5); results
 * in (-0.5, 0] keep the sign (JS: Math.round(-0.3) is -0). */
double scr_math_round(double x) {
  if (isnan(x)) return x + x; /* quieted, as V8 answers a signaling NaN in every tier (S100) */
  if (isinf(x) || x == 0.0) return x;
  double f = floor(x);
  double diff = x - f;
  double r = diff < 0.5 ? f : f + 1.0;
  return (r == 0.0 && x < 0.0) ? -0.0 : r;
}

/* `x ** y` and Math.pow: V8 13.6's v8::internal::math::pow
 * (src/numbers/ieee754.cc, use_std_math_pow on -- Node's default), arm for
 * arm: the two NaN answers ECMA-262 has where IEEE pow does not (a NaN
 * exponent; |x| = 1 with an infinite exponent) are quiet_NaN(); a NaN base
 * is quieted; the optimizing compilers' two pre-cases (y = 2 is x * x, y =
 * 0.5 is sqrt(x + 0), -Infinity ** 0.5 being +Infinity); and everything else
 * is the C library's pow -- which is Node's own on the same machine (glibc's
 * on Linux, SEMANTICS.md S079). */
double scr_js_pow(double x, double y) {
  if (isnan(y)) return __builtin_nan("");
  if (isinf(y) && (x == 1 || x == -1)) return __builtin_nan("");
  if (isnan(x)) x = __builtin_nan("");
  if (y == 2) return x * x;
  if (y == 0.5) {
    if (isinf(x)) return INFINITY;
    return sqrt(x + 0);
  }
  return SCR_JSMATH_POW(x, y);
}

/* Math.hypot over n already-ToNumber'd arguments: V8 13.6's math.tq
 * MathHypot. Up to three arguments take the fast path (an infinite argument
 * answers Infinity before NaN is looked at; the maximum of the absolute
 * values -- NaN if any is -- answers NaN, then 0; two squares summed, or
 * three with the compensation term); more take the slow path (NaN arguments
 * stay out of the maximum, then Infinity, NaN, 0, and a Kahan sum of
 * (v / max)^2 in argument order). The NaN answered is kNaN, the quiet one. */
double scr_math_hypot(const double *xs, size_t n) {
  if (n == 0) return 0;
  if (n == 1) return fabs(xs[0]);
  double a[3];
  if (n <= 3) {
    for (size_t i = 0; i < n; i++) a[i] = fabs(xs[i]);
    for (size_t i = 0; i < n; i++) {
      if (a[i] == INFINITY) return INFINITY;
    }
    double max = 0;
    for (size_t i = 0; i < n; i++) {
      if (isnan(a[i])) return __builtin_nan("");
      if (i == 0 || a[i] > max) max = a[i];
    }
    if (max == 0) return 0;
    double p0 = (a[0] / max) * (a[0] / max);
    double p1 = (a[1] / max) * (a[1] / max);
    if (n == 2) return sqrt(p0 + p1) * max;
    double comp = (p0 + p1) - p0 - p1;
    double p2 = (a[2] / max) * (a[2] / max);
    return sqrt((p0 + p1) + (p2 - comp)) * max;
  }
  bool nan = false;
  double max = 0;
  for (size_t i = 0; i < n; i++) {
    double v = fabs(xs[i]);
    if (isnan(v)) nan = true;
    else if (v > max) max = v;
  }
  if (max == INFINITY) return INFINITY;
  if (nan) return __builtin_nan("");
  if (max == 0) return 0;
  double sum = 0, comp = 0;
  for (size_t i = 0; i < n; i++) {
    double v = fabs(xs[i]) / max;
    double summand = v * v - comp;
    double prelim = sum + summand;
    comp = (prelim - sum) - summand;
    sum = prelim;
  }
  return sqrt(sum) * max;
}

/* Math.sign: V8's MathSign, x < 0 ? -1 : x > 0 ? 1 : x (±0 and NaN are
 * themselves, payload included). */
double scr_math_sign(double x) { return x < 0 ? -1.0 : x > 0 ? 1.0 : x; }

/* Math.f16round: x rounded to the nearest binary16 value (ties to even) in
 * ONE rounding from the double, back as a double. With a = |x|: a NaN is the
 * quiet NaN with x's sign (Node's answer whatever the payload); a >= 65520
 * (65504 plus half its ulp) is Infinity; otherwise q = 2^(max(e, -14) - 10)
 * is the binary16 quantum at a's binade e, a / q and the product back are
 * exact, and rint rounds ties to even. The sign is copied back. */
double scr_math_f16round(double x) {
  if (isnan(x)) return copysign(__builtin_nan(""), x);
  double a = fabs(x);
  if (a >= 65520) return copysign(INFINITY, x);
  uint64_t bits;
  memcpy(&bits, &a, sizeof bits);
  int e = (int)(bits >> 52) - 1023;
  if (e < -14) e = -14;
  uint64_t qbits = (uint64_t)(e - 10 + 1023) << 52;
  double q;
  memcpy(&q, &qbits, sizeof q);
  return copysign(rint(a / q) * q, x);
}

#endif /* SCR_JSMATH_LIB */
