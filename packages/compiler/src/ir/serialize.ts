/* IR ↔ JSON. The IR is plain JSON-safe data by construction; the value of
 * this module is the version fence and the non-finite sentinels (numLit
 * holds a JS number — NaN, ±Infinity and -0 must not silently become
 * `null` or `0` in JSON).
 */
import type { IrModule } from "./nodes.js";

export const IR_VERSION = 3 as const;

export function serializeModule(mod: IrModule): string {
  return JSON.stringify(mod, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      // ±Infinity and NaN numLits are real (the globals `Infinity` and
      // `NaN`, the lowerer's own NaN answers — GH #136); JSON cannot spell
      // them, so they ride a sentinel object no other IR value can be
      // (numbers never serialize as objects).
      if (Number.isNaN(value)) return { $nonfinite: "nan" };
      return { $nonfinite: value > 0 ? "inf" : "-inf" };
    }
    // JSON.stringify(-0) prints "0", silently losing the sign a numLit's
    // f64 semantics depend on (String(-0) is "0" but 1/-0 is -Infinity) —
    // the same sentinel mechanism carries it.
    if (typeof value === "number" && Object.is(value, -0)) {
      return { $nonfinite: "-0" };
    }
    return value;
  }, 2);
}

export function deserializeModule(json: string): IrModule {
  const mod = JSON.parse(json, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "$nonfinite" in value) {
      const tag = (value as { $nonfinite: string }).$nonfinite;
      return tag === "inf" ? Infinity : tag === "-0" ? -0 : tag === "nan" ? NaN : -Infinity;
    }
    return value;
  }) as IrModule;
  if (mod.irVersion !== IR_VERSION) {
    throw new Error(
      `IR version mismatch: file has ${String(mod.irVersion)}, compiler expects ${IR_VERSION}`,
    );
  }
  return mod;
}
