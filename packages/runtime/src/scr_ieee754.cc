/* Math's transcendental functions on the native lanes, as Node computes them
 * (SEMANTICS.md S100): V8 13.6's src/base/ieee754.cc -- the vendored file
 * itself, packages/runtime/vendor/v8-ieee754/src/base/ieee754.cc, unmodified
 * -- compiled as C++ and exported to the C runtime and the emitted programs
 * under C names. The WasmGC tier compiles the SAME file (its text is
 * generated from the vendored copy into backend/wasm/ieee754-src.ts and
 * compiled by backend/wasm/csubset.ts), so every lane runs one
 * implementation.
 *
 * Build contract (cc.ts, ensureIeee754Object): C++17, -ffp-contract=off (no
 * fused multiply-add may contract an expression -- Node's x86-64 build has
 * none, and arm64 compilers contract by default), no exceptions, no RTTI,
 * include path = the vendor directory plus its shim/ directory (four small
 * stand-ins for the V8 headers ieee754.cc includes). The object references
 * only libm (sqrt, scalbn, fabs) -- no C++ runtime. */

#include "src/base/ieee754.cc"

#define SCR_IEEE754_1(name) \
  extern "C" double scr_ieee754_##name(double x) { return v8::base::ieee754::name(x); }

SCR_IEEE754_1(acos)
SCR_IEEE754_1(acosh)
SCR_IEEE754_1(asin)
SCR_IEEE754_1(asinh)
SCR_IEEE754_1(atan)
SCR_IEEE754_1(atanh)
SCR_IEEE754_1(cbrt)
SCR_IEEE754_1(cos)
SCR_IEEE754_1(cosh)
SCR_IEEE754_1(exp)
SCR_IEEE754_1(expm1)
SCR_IEEE754_1(log)
SCR_IEEE754_1(log1p)
SCR_IEEE754_1(log2)
SCR_IEEE754_1(log10)
SCR_IEEE754_1(sin)
SCR_IEEE754_1(sinh)
SCR_IEEE754_1(tan)
SCR_IEEE754_1(tanh)

/* atan2's NaN arm is `return x + y;`. With BOTH operands NaN, which payload
 * an IEEE addition returns is the instruction's operand order, which the C++
 * compiler is free to swap (addition commutes): Node's build returns x's
 * (quieted) -- measured over every pair of 0x7ff8..., 0xfff8..., 0x7ff4...
 * and 0xfff8dead0000beef -- where clang -O2 emits y + x. So an x NaN is
 * answered here, in the order Node's binary has it; every other input,
 * a lone NaN y included, is ieee754.cc's own arm. */
extern "C" double scr_ieee754_atan2(double y, double x) {
  if (x != x) return x + x; /* x's payload, quieted (x + y in Node's operand order) */
  return v8::base::ieee754::atan2(y, x);
}
