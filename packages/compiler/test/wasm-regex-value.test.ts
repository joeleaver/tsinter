/* INC-24 P1, CP4 back half: the %w.re.Regex VALUE struct (design §3.2)
 * and its literal-interning data-embedding path (§3.3), standalone —
 * built and pinned here BEFORE any real caller exists, matching every
 * other piece of this port's own regex engine (parser, assembler,
 * interpreter all shipped test-verified with zero live callers first).
 * Verifies: every field round-trips (source/flags/bytecode/
 * captureCount/groupNames, both null and populated), the bytecode
 * embedded is BYTE-IDENTICAL to what assemble() itself produced (the
 * SAME kind of measured claim the canonicalize-sweep's own BRIDGE
 * checks made, not argued), and literal INTERNING actually holds:
 * calling regexLiteral() twice with the identical (source,flags) pair
 * returns the SAME function index at BUILD time, and the two resulting
 * runtime values are ref.eq at RUN time ("re === re", §3.2's own
 * words) — a DIFFERENT (source,flags) pair must NOT collide with it. */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { assemble } from "../src/backend/wasm/regex-assembler.js";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { RegexBuilder } from "../src/backend/wasm/regex-value.js";

interface ValueExports {
  litA: () => unknown;
  litA2: () => unknown; // same (source,flags) as litA, built via a SEPARATE regexLiteral() call
  litB: () => unknown; // different (source,flags)
  litNamed: () => unknown;
  sameRef: (a: unknown, b: unknown) => number; // ref.eq(a,b) ? 1 : 0
  source: (r: unknown) => unknown;
  flags: (r: unknown) => unknown;
  bytecode: (r: unknown) => unknown;
  captureCount: (r: unknown) => number;
  groupNamesIsNull: (r: unknown) => number;
  groupNameAt: (r: unknown, i: number) => unknown;
  strLen: (s: unknown) => number;
  strCharAt: (s: unknown, i: number) => number;
  bcLen: (b: unknown) => number;
  bcAt: (b: unknown, i: number) => number;
}

function assembledFor(pattern: string, flagStr: string): { bytes: Uint8Array; captureCount: number; groupNames: string[] | null } {
  const flags = { global: false, ignoreCase: flagStr.includes("i"), multiLine: flagStr.includes("m"), dotAll: flagStr.includes("s"), unicode: flagStr.includes("u"), sticky: flagStr.includes("y") };
  const parsed = parsePattern(pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll)!;
  const asm = assemble(parsed.ast, flags);
  // Named-group extraction: walk the AST for group nodes with a name,
  // in capture-index order — a small local walk (this test's own need,
  // not a production helper) since regexLiteral() takes groupNames as
  // a plain input rather than deriving it itself (division of labour:
  // the CALLER's already-built AST is the one source of truth for
  // names, matching how captureCount/bytecode are ALSO caller-supplied
  // here rather than re-derived).
  const names: (string | null)[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec.kind === "group" && rec.capture !== null) {
      names[(rec.capture as number) - 1] = (rec.name as string | null) ?? null;
    }
    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(parsed.ast);
  const hasNamed = names.some((n) => n !== null && n !== undefined);
  return { bytes: asm.bytes, captureCount: asm.captureCount, groupNames: hasNamed ? names.map((n) => n ?? "") : null };
}

async function build(): Promise<ValueExports> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const rb = new RegexBuilder(mb, strType);
  const regexRef: ValType = { kind: "ref", nullable: true, typeIndex: rb.regexType };

  const A = assembledFor("a(b)c", "i");
  const B = assembledFor("x", "");
  const Named = assembledFor("(?<year>\\d{4})-(?<month>\\d{2})", "");

  const litAFn = rb.regexLiteral("a(b)c", "i", A.bytes, A.captureCount, A.groupNames);
  const litA2Fn = rb.regexLiteral("a(b)c", "i", A.bytes, A.captureCount, A.groupNames); // SAME pair — must intern to the SAME fn
  const litBFn = rb.regexLiteral("x", "", B.bytes, B.captureCount, B.groupNames);
  const litNamedFn = rb.regexLiteral("(?<year>\\d{4})-(?<month>\\d{2})", "", Named.bytes, Named.captureCount, Named.groupNames);

  const sameRefFn = mb.declareFunc(mb.funcType([regexRef, regexRef], [I32]), "sameRef");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.refEq();
    mb.setBody(sameRefFn, [], c.bytes());
  }
  const sourceFn = mb.declareFunc(mb.funcType([regexRef], [strRef]), "source");
  {
    const c = new Code();
    c.localGet(0);
    c.structGet(rb.regexType, 0);
    mb.setBody(sourceFn, [], c.bytes());
  }
  const flagsFn = mb.declareFunc(mb.funcType([regexRef], [strRef]), "flags");
  {
    const c = new Code();
    c.localGet(0);
    c.structGet(rb.regexType, 1);
    mb.setBody(flagsFn, [], c.bytes());
  }
  const bcType = mb.arrayType("i8", false);
  const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
  const bytecodeFn = mb.declareFunc(mb.funcType([regexRef], [bcRef]), "bytecode");
  {
    const c = new Code();
    c.localGet(0);
    c.structGet(rb.regexType, 2);
    mb.setBody(bytecodeFn, [], c.bytes());
  }
  const captureCountFn = mb.declareFunc(mb.funcType([regexRef], [I32]), "captureCount");
  {
    const c = new Code();
    c.localGet(0);
    c.structGet(rb.regexType, 3);
    mb.setBody(captureCountFn, [], c.bytes());
  }
  const strArrType = mb.arrayType(strRef, false);
  const groupNamesIsNullFn = mb.declareFunc(mb.funcType([regexRef], [I32]), "groupNamesIsNull");
  {
    const c = new Code();
    c.localGet(0);
    c.structGet(rb.regexType, 4);
    c.refIsNull();
    mb.setBody(groupNamesIsNullFn, [], c.bytes());
  }
  const groupNameAtFn = mb.declareFunc(mb.funcType([regexRef, I32], [strRef]), "groupNameAt");
  {
    const c = new Code();
    c.localGet(0);
    c.structGet(rb.regexType, 4);
    c.localGet(1);
    c.arrayGet(strArrType);
    mb.setBody(groupNameAtFn, [], c.bytes());
  }
  const strLenFn = mb.declareFunc(mb.funcType([strRef], [I32]), "strLen");
  {
    const c = new Code();
    c.localGet(0);
    c.arrayLen();
    mb.setBody(strLenFn, [], c.bytes());
  }
  const strCharAtFn = mb.declareFunc(mb.funcType([strRef, I32], [I32]), "strCharAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGetU(strType);
    mb.setBody(strCharAtFn, [], c.bytes());
  }
  const bcLenFn = mb.declareFunc(mb.funcType([bcRef], [I32]), "bcLen");
  {
    const c = new Code();
    c.localGet(0);
    c.arrayLen();
    mb.setBody(bcLenFn, [], c.bytes());
  }
  const bcAtFn = mb.declareFunc(mb.funcType([bcRef, I32], [I32]), "bcAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGetU(bcType);
    mb.setBody(bcAtFn, [], c.bytes());
  }

  mb.exportFunc("litA", litAFn);
  mb.exportFunc("litA2", litA2Fn);
  mb.exportFunc("litB", litBFn);
  mb.exportFunc("litNamed", litNamedFn);
  mb.exportFunc("sameRef", sameRefFn);
  mb.exportFunc("source", sourceFn);
  mb.exportFunc("flags", flagsFn);
  mb.exportFunc("bytecode", bytecodeFn);
  mb.exportFunc("captureCount", captureCountFn);
  mb.exportFunc("groupNamesIsNull", groupNamesIsNullFn);
  mb.exportFunc("groupNameAt", groupNameAtFn);
  mb.exportFunc("strLen", strLenFn);
  mb.exportFunc("strCharAt", strCharAtFn);
  mb.exportFunc("bcLen", bcLenFn);
  mb.exportFunc("bcAt", bcAtFn);

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`regex-value module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as ValueExports;
}

function readStr(ex: ValueExports, s: unknown): string {
  const len = ex.strLen(s);
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(ex.strCharAt(s, i));
  return out;
}

function readBytes(ex: ValueExports, b: unknown): Uint8Array {
  const len = ex.bcLen(b);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = ex.bcAt(b, i);
  return out;
}

describe("%w.re.Regex value struct + literal interning (design §3.2/§3.3)", () => {
  test("source/flags/bytecode/captureCount round-trip exactly, bytecode byte-identical to assemble()'s own output", async () => {
    const ex = await build();
    const A = assembledFor("a(b)c", "i");
    const r = ex.litA();
    expect(readStr(ex, ex.source(r))).toBe("a(b)c");
    expect(readStr(ex, ex.flags(r))).toBe("i");
    expect(ex.captureCount(r)).toBe(A.captureCount);
    expect(Array.from(readBytes(ex, ex.bytecode(r))), "embedded bytecode vs assemble()'s own real output").toEqual(Array.from(A.bytes));
    expect(ex.groupNamesIsNull(r), "a(b)c has no NAMED groups").toBe(1);
  });

  test("groupNames: null for an unnamed pattern, populated in capture order for a named one", async () => {
    const ex = await build();
    const b = ex.litB();
    expect(ex.groupNamesIsNull(b)).toBe(1);
    const named = ex.litNamed();
    expect(ex.groupNamesIsNull(named)).toBe(0);
    expect(readStr(ex, ex.groupNameAt(named, 0))).toBe("year");
    expect(readStr(ex, ex.groupNameAt(named, 1))).toBe("month");
  });

  test("literal interning: the SAME (source,flags) pair returns THE SAME struct reference — 're === re' (§3.2's own words)", async () => {
    const ex = await build();
    const a1 = ex.litA();
    const a2 = ex.litA2(); // a SEPARATE regexLiteral() call with the identical (source,flags)
    expect(ex.sameRef(a1, a2), "two regexLiteral() calls for the SAME (source,flags) must yield the SAME immortal instance").toBe(1);
  });

  test("literal interning does NOT collide across DIFFERENT (source,flags) pairs", async () => {
    const ex = await build();
    const a = ex.litA();
    const b = ex.litB();
    expect(ex.sameRef(a, b), "different (source,flags) pairs must be DIFFERENT instances").toBe(0);
  });

  test("calling the SAME literal function TWICE at runtime returns the SAME reference (the guard's own idempotence, not just build-time interning)", async () => {
    const ex = await build();
    const first = ex.litA();
    const second = ex.litA(); // calling the EXPORTED FUNCTION twice
    expect(ex.sameRef(first, second), "the guard must not reconstruct on a second call").toBe(1);
  });
});
