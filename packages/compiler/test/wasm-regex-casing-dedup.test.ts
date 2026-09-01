/* INC-24 P1, CP4 back half: the CasingBuilder dedup RULING (embedding,
 * per the lead's standing constraint — "RULED at embedding with size
 * numbers in hand"). MEASURED: a module compiling RegexInterpreterBuilder's
 * exec() (which unconditionally compiles regexCanonicalize(), and so a
 * CasingBuilder, regardless of whether any pattern in that module
 * actually uses ignoreCase) PLUS a second, INDEPENDENT CasingBuilder
 * instance elsewhere in the same module (simulating emitter.ts's own
 * `this.casing`, used for ordinary String.prototype.toUpperCase/
 * toLowerCase) costs 978 bytes of DUPLICATED CODE — the two
 * instances' own null-init globals, %w.str.caseInit guard, and
 * caseConvCp function body, each built twice. The underlying TABLE
 * DATA (several KB) already dedupes via internData's exact-match
 * dedup regardless of instance count, so 978 is the FULL cost
 * sharing avoids, not an upper-bound estimate padded for the parts
 * that don't actually duplicate.
 *
 * RULED: share. regex-interpreter.ts's constructor now takes an
 * OPTIONAL third `injectedCasing?: CasingBuilder` parameter — every
 * existing two-arg call site (every test file in this pass) is
 * unaffected, and the production path (once a `get regex()` accessor
 * wires this class into emitter.ts) passes `this.casing` there,
 * matching how strs/bytes/regex would all share ONE CasingBuilder
 * the same way they already share ONE ModuleBuilder.
 *
 * THIS FILE proves the injection is REAL sharing (the SAME wasm
 * function index for caseConvCp, not two structurally-identical but
 * separately-compiled ones) — a constructor parameter that merely
 * type-checks is not evidence of anything by itself. */
import { describe, expect, test } from "vitest";
import { CasingBuilder } from "../src/backend/wasm/casing.js";
import { ModuleBuilder } from "../src/backend/wasm/module.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";

function buildAlone(): Uint8Array {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const interp = new RegexInterpreterBuilder(mb, strType);
  mb.exportFunc("exec", interp.exec());
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  return mb.emit();
}

function buildSharedInjected(): Uint8Array {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const shared = new CasingBuilder(mb, strType);
  const interp = new RegexInterpreterBuilder(mb, strType, shared);
  mb.exportFunc("exec", interp.exec());
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  mb.exportFunc("caseConvCp", shared.caseConvCp()); // the SAME instance, used a SECOND time
  return mb.emit();
}

function buildDuplicated(): Uint8Array {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const interp = new RegexInterpreterBuilder(mb, strType);
  mb.exportFunc("exec", interp.exec());
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  // a SECOND, INDEPENDENT instance — never injected, never shared.
  const second = new CasingBuilder(mb, strType);
  mb.exportFunc("caseConvCp", second.caseConvCp());
  return mb.emit();
}

describe("CasingBuilder dedup at embedding: injection is real sharing, measured against duplication", () => {
  test("an INJECTED, shared CasingBuilder costs THE SAME as exec() alone (real sharing, not just a type-checking parameter)", () => {
    const alone = buildAlone();
    const sharedInjected = buildSharedInjected();
    // sharedInjected exports ONE MORE function (caseConvCp itself) than
    // alone, so it is not byte-for-byte identical — but that export is
    // a handful of bytes (a name + an index into the SAME already-built
    // function), nowhere near the 978-byte duplicate-CODE cost below.
    expect(sharedInjected.length - alone.length, "cost of exporting the ALREADY-shared caseConvCp, not rebuilding it").toBeLessThan(50);
  });

  test("MEASURED: a second, INDEPENDENT CasingBuilder in the same module costs exactly 978 bytes of duplicated code over sharing", () => {
    const alone = buildAlone();
    const duplicated = buildDuplicated();
    expect(duplicated.length - alone.length, "duplicate-CasingBuilder code cost (table DATA itself already dedupes via internData regardless)").toBe(978);
  });
});
