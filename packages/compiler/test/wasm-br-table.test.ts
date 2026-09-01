/* INC-24 P1, build step 1 (design §9.1): Code#brTable — the wasm br_table
 * opcode (0x0e), the only new instruction P1's engine needs (the regex
 * interpreter's opcode dispatch is its first real caller). code.ts had br
 * (0x0c) and brIf (0x0d) but no indexed branch; emitSwitch's existing
 * linear brIf chain (emitter.ts:16535) is a different, already-shipped
 * mechanism and is untouched here.
 *
 * Standing law on this project: every emitted branch gets an EXECUTION
 * pin, not a validate-only one — a pin that only proves the module
 * validates never actually ran the instruction, so a byte-order bug (say,
 * labels and defaultLabel swapped) would still pass validation and ship.
 * This file builds a tiny (selector: i32) -> i32 function directly against
 * ModuleBuilder + Code (bypassing the frontend/emitter entirely, same
 * discipline as wasm-bytes-validate.test.ts and wasm-numfmt.test.ts),
 * instantiates it, and CALLS it with inputs that reach the default arm and
 * at least one non-default arm, per §9.1's own wording. */
import { expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder } from "../src/backend/wasm/module.js";

/** Three nested blocks, br_table as the sole dispatch instruction:
 *   block $L2 (outer, the DEFAULT landing zone)
 *     block $L1 (the ARM-1 landing zone)
 *       block $L0 (the ARM-0 landing zone, innermost — br_table sits here)
 *         local.get $sel
 *         br_table [0, 1] default=2
 *       end                    ; branching to depth 0 lands HERE
 *       i32.const 100 ; return ; ARM 0
 *     end                      ; branching to depth 1 lands HERE
 *     i32.const 200 ; return   ; ARM 1
 *   end                        ; branching to depth 2 (out-of-range) lands HERE
 *   i32.const 999 ; return     ; DEFAULT
 * Every label is a raw relative depth from the br_table site itself, the
 * same convention br/brIf already use — L0 is 0 levels out, L1 is 1, and
 * the outer L2 (2 levels out) is deliberately never named as an explicit
 * br_table target: br_table's OWN default-clamping semantics reach it for
 * any selector outside [0,1], which is exactly the behavior under test. */
function buildDispatcher(): Uint8Array {
  const mb = new ModuleBuilder();
  const fnType = mb.funcType([I32], [I32]);
  const fn = mb.declareFunc(fnType, "%test.dispatch");
  const c = new Code();
  c.block(); // L2 (default)
  c.block(); // L1 (arm 1)
  c.block(); // L0 (arm 0)
  c.localGet(0);
  c.brTable([0, 1], 2);
  c.end(); // end L0 — arm 0 code follows
  c.i32Const(100);
  c.return_();
  c.end(); // end L1 — arm 1 code follows
  c.i32Const(200);
  c.return_();
  c.end(); // end L2 — default code follows
  c.i32Const(999);
  c.return_();
  mb.setBody(fn, [], c.bytes());
  mb.exportFunc("dispatch", fn);
  return mb.emit();
}

test("br_table (0x0e): emits a valid module", async () => {
  const bytes = buildDispatcher();
  expect(WebAssembly.validate(bytes)).toBe(true);
  await expect(WebAssembly.instantiate(bytes, {})).resolves.toBeDefined();
});

test("br_table (0x0e): EXECUTION pin — reaches both explicit arms and the default arm", async () => {
  const bytes = buildDispatcher();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as { dispatch: (sel: number) => number };
  // Arm 0 (selector 0 → br_table's first vector entry, relative depth 0).
  expect(exports.dispatch(0)).toBe(100);
  // Arm 1 (selector 1 → the vector's second entry, relative depth 1) — the
  // "≥1 non-default arm" §9.1 requires beyond the first.
  expect(exports.dispatch(1)).toBe(200);
  // Default (any selector outside the vector, including a value bigger
  // than the vector length AND one that would be negative as a signed
  // i32 — br_table's selector is unsigned, so this also pins that the
  // clamp isn't accidentally sign-sensitive).
  expect(exports.dispatch(2)).toBe(999);
  expect(exports.dispatch(1000)).toBe(999);
  expect(exports.dispatch(-1)).toBe(999);
});

test("br_table (0x0e): byte shape — opcode, vector length+entries, default, all ULEB", () => {
  const c = new Code();
  c.brTable([3, 7, 12], 9);
  const bytes = c.bytes();
  // 0x0e, vec.length=3, 3, 7, 12, default=9 — every value here is < 128,
  // so each is exactly one ULEB byte; this is a shape check alongside the
  // execution pin above, not a substitute for it.
  expect(Array.from(bytes)).toEqual([0x0e, 3, 3, 7, 12, 9]);
});
