/* Math's transcendental functions on the WasmGC tier, as Node computes them
 * (SEMANTICS.md S100): V8 13.6's src/base/ieee754.cc -- fdlibm with V8's and
 * FreeBSD msun's changes -- compiled from its own text (ieee754-src.ts) by the
 * C-subset compiler (csubset.ts), in binary64 with no fused multiply-add, which
 * is what Node v24's x86-64 build of that file computes. Each function is
 * declared in a module on first use and pulls in what it calls (sin ->
 * __kernel_sin, __kernel_cos, __ieee754_rem_pio2 -> __kernel_rem_pio2 -> scalbn),
 * so a program pays only for the members it reaches. */

import { CCompiler, parseC, type CUnit } from "./csubset.js";
import { IEEE754_CC } from "./ieee754-src.js";
import type { ModuleBuilder } from "./module.js";

/* ieee754.cc calls the C library's scalbn in exactly one place
 * (__kernel_rem_pio2, with results in the normal range, where every correct
 * scalbn is exact). This is musl's src/math/scalbn.c (MIT licence,
 * https://git.musl-libc.org/cgit/musl/tree/src/math/scalbn.c, Copyright
 * 2005-2020 Rich Felker et al.), with its union spelled as V8's base::bit_cast
 * and double_t as double (FLT_EVAL_METHOD 0 on x86-64). It is exact everywhere,
 * subnormal results included. */
const SCALBN_C = String.raw`
double scalbn(double x, int n) {
  double y = x;

  if (n > 1023) {
    y *= 0x1p1023;
    n -= 1023;
    if (n > 1023) {
      y *= 0x1p1023;
      n -= 1023;
      if (n > 1023)
        n = 1023;
    }
  } else if (n < -1022) {
    /* make sure final n < -53 to avoid double
       rounding in the subnormal range */
    y *= 0x1p-1022 * 0x1p53;
    n += 1022 - 53;
    if (n < -1022) {
      y *= 0x1p-1022 * 0x1p53;
      n += 1022 - 53;
      if (n < -1022)
        n = -1022;
    }
  }
  x = y * base::bit_cast<double>(static_cast<uint64_t>(0x3ff + n) << 52);
  return x;
}
`;

/** The Math members ieee754.cc implements, by their C names (all `double f(double)`
 * except atan2, `double atan2(double y, double x)`). */
export const IEEE754_MEMBERS: ReadonlySet<string> = new Set([
  "acos", "acosh", "asin", "asinh", "atan", "atanh", "atan2", "cbrt", "cos", "cosh",
  "exp", "expm1", "log", "log1p", "log2", "log10", "sin", "sinh", "tan", "tanh",
]);

/** The parsed translation unit (pure data), built once per process. */
const parsed: { unit: CUnit | null } = { unit: null };

function unit(): CUnit {
  if (parsed.unit === null) {
    parsed.unit = parseC(IEEE754_CC + "\n" + SCALBN_C, {
      // V8's attribute macros (src/base/compiler-specific.h); neither changes a value
      V8_INLINE: "inline",
      V8_WARN_UNUSED_RESULT: "",
    });
  }
  return parsed.unit;
}

/** One module's view of ieee754.cc: fn("sin") is the index of %w.ieee754.sin. */
export class Ieee754 {
  private cc: CCompiler | null = null;
  constructor(private readonly mb: ModuleBuilder) {}

  fn(name: string): number {
    if (!IEEE754_MEMBERS.has(name)) throw new Error(`ieee754: ${name} is not a Math member it implements`);
    this.cc ??= new CCompiler(this.mb, unit(), "%w.ieee754.");
    return this.cc.fn(name);
  }
}
