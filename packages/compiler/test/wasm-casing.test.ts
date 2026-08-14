/* casing.ts (CasingBuilder) pin suite — builder-level only, per increment
 * 20 stage A (increment-20-design.md v2 RECONCILED; full pin rationale in
 * the session-14 scratchpad's inc20/rev-preread.md §6). Two load-bearing
 * pins convert a MEASURED zero-skew finding into a MAINTAINED one: the
 * exhaustive mapping sweep asserts the exact non-identity count (3068)
 * and the exhaustive predicate sweep asserts the exact positive count of
 * EACH predicate (Cased = 4632, Case_Ignorable = 2794 — together with
 * 268 code points where both hold, the union is 7158, which is the
 * number reported during design-phase measurement; the two predicates
 * are asserted separately here, not as a combined 7158) — a future
 * Node/ICU bump that silently changes even one code point trips these,
 * and a helper that returns its input verbatim would otherwise pass 99%+
 * of a naive comparison.
 *
 * Oracle throughout: plain Node (this file runs under vitest/Node
 * directly — no --experimental-transform-types needed here, since
 * String.prototype.toUpperCase/toLowerCase and \p{Cased}/\p{Case_Ignorable}
 * are ordinary reachable JS, not out-of-range literals or internal
 * natives; the harness's transform-types requirement is for the
 * SEPARATE differential-corpus oracle, not this builder-level suite).
 *
 * Gate stays closed in this stage: emitter.ts's strIntrinsic refusal for
 * toLowerCase/toUpperCase is untouched. Everything here calls CasingBuilder
 * directly via ModuleBuilder, bypassing the frontend/emitter entirely —
 * the validate-sweep force-emission pattern (wasm-bytes-validate.test.ts).
 */
import { describe, expect, test } from "vitest";
import { CasingBuilder } from "../src/backend/wasm/casing.js";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";

interface CoreExports {
  caseConvCp: (cp: number, convType: number) => [number, number, number, number];
  isCased: (cp: number) => number;
  isCaseIgnorable: (cp: number) => number;
  initCount: () => number;
}

async function buildCore(): Promise<CoreExports> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const casing = new CasingBuilder(mb, strType);

  const initCountFn = mb.declareFunc(mb.funcType([], [I32]), "initCount");
  {
    const c = new Code();
    c.globalGet(casing.initCountGlobal());
    mb.setBody(initCountFn, [], c.bytes());
  }

  mb.exportFunc("caseConvCp", casing.caseConvCp());
  mb.exportFunc("isCased", casing.isCased());
  mb.exportFunc("isCaseIgnorable", casing.isCaseIgnorable());
  mb.exportFunc("toLower", casing.toLowerCase());
  mb.exportFunc("toUpper", casing.toUpperCase());
  mb.exportFunc("initCount", initCountFn);

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`core module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as CoreExports;
}

/* ── String-level test module: named literal accessors + toLower/toUpper
 * + len/at readback, one shared instance for every string-shaped pin. */

const LITERALS: Record<string, string> = {
  empty: "",
  hello: "  Hello, World  ",
  mixedLower: "MIXED case Words",
  mixedUpper: "mixed CASE words",
  strasse: "straße",
  istanbul: "İstanbul",
  fnal: "ﬁnal",
  sigisyphos: "ΣΊΣΥΦΟΣ",
  odosOdos: "ΟΔΟΣ ΟΔΟΣ",
  sigma: "Σ",
  alphaSigma: "ΑΣ",
  sigma2: "Σ2",
  deseretPair: "\u{10437}\u{10437}",
  deseretLower: "\u{1040F}",
  privetMir: "Привет МИР",
  privetMirLower: "привет мир",
  cafeAccents: "Café ÀÉÎÕÜ",
  cafeAccentsLower: "café àéîõü",
  cjkMix: "日本語 123 —",
  words: "alpha beta gamma",
  slice: "beta",

  // Final_Sigma context matrix (rev-preread.md §3's full measured matrix).
  aSigma: "AΣ",
  sigmaA: "ΣA",
  aSigmaA: "AΣA",
  aSigma2: "AΣ2",
  aSigmaSpace: "AΣ ",
  aQuoteSigma: "A'Σ",
  aAcuteSigma: "ÁΣ",
  aSoftHyphenSigma: "A­Σ",
  quoteSigma: "'Σ",
  aSigmaQuote: "AΣ'",
  aSigmaQuoteA: "AΣ'A",
  aSigmaAcute2: "AΣ́2",
  sigmaSigma: "ΣΣ",
  aSigmaSigma: "AΣΣ",
  emojiSigma: "😀Σ",
  loneSurrogateSigma: "\ud800Σ\udc00",
  sigmaAcute: "Σ́", // nothing precedes Σ -> not final, discriminates back-scan short-circuit
  aAcuteSigmaLit: "ÁΣ", // precomposed cased char precedes Σ -> final

  // Astral Final_Sigma discriminating pins (rev-preread.md §3, the
  // "UTF-16 pair-stepping trap").
  deseretSigma: "\u{10428}Σ", // back-scan over an astral pair
  aSigmaDeseret: "AΣ\u{10428}", // forward-scan false-positive direction
  aMusicSigma: "A\u{1D167}Σ", // astral case-ignorable, back-scan
  aSigmaMusic: "AΣ\u{1D167}", // NOT a discriminating pin (right either way) — sanity only

  aSigmaLower: "aς", // for the "Final_Sigma does not fire upward" pin

  // N2 (gate finding): end-to-end worst-case growth through the ACTUAL
  // caseConvWorker buffer path, not just at the code-point level. Verified
  // against Node before adding: 3 input units -> 9 output units (3x, the
  // measured bound) — a 2*len scratch allocation fails this.
  triple0390: "\u{390}\u{390}\u{390}",

  // Lone-surrogate identity (rides S002, not a new divergence).
  loneHigh: "\ud800",
  loneLow: "\udfff",
  loneReversed: "\udc00\ud800",
  loneHighA: "\ud800a",

  // ASCII fast-path boundaries.
  ascii: "abcXYZ",
  atSign: "@",
  bracket: "[",
  backtick: "`",
  brace: "{",
};

interface StrExports {
  lit: (i: number) => unknown;
  toLower: (s: unknown) => unknown;
  toUpper: (s: unknown) => unknown;
  len: (r: unknown) => number;
  at: (r: unknown, i: number) => number;
  initCount: () => number;
}

const LIT_KEYS = Object.keys(LITERALS);

async function buildStrings(): Promise<StrExports> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const casing = new CasingBuilder(mb, strType);

  const litUnits = (s: string): Uint8Array => {
    const units = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    return units;
  };

  // One dispatcher function: lit(i) -> the i-th literal, indexed by
  // LIT_KEYS order — avoids one exported function per literal.
  const litFn = mb.declareFunc(mb.funcType([I32], [strRef]), "lit");
  {
    const c = new Code();
    LIT_KEYS.forEach((key, i) => {
      const s = LITERALS[key]!;
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      const off = mb.internData(litUnits(s));
      c.i32Const(off);
      c.i32Const(s.length);
      c.arrayNewData(strType, 0);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(litFn, [], c.bytes());
  }

  const len = mb.declareFunc(mb.funcType([strRef], [I32]), "len");
  {
    const c = new Code();
    c.localGet(0);
    c.arrayLen();
    mb.setBody(len, [], c.bytes());
  }
  const at = mb.declareFunc(mb.funcType([strRef, I32], [I32]), "at");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGetU(strType);
    mb.setBody(at, [], c.bytes());
  }
  const initCountFn = mb.declareFunc(mb.funcType([], [I32]), "initCount");
  {
    const c = new Code();
    c.globalGet(casing.initCountGlobal());
    mb.setBody(initCountFn, [], c.bytes());
  }

  mb.exportFunc("lit", litFn);
  mb.exportFunc("len", len);
  mb.exportFunc("at", at);
  mb.exportFunc("toLower", casing.toLowerCase());
  mb.exportFunc("toUpper", casing.toUpperCase());
  mb.exportFunc("initCount", initCountFn);

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`strings module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as StrExports;
}

function jsToStr(ex: StrExports, r: unknown): string {
  const n = ex.len(r);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(ex.at(r, i));
  return s;
}
function lit(ex: StrExports, key: string): unknown {
  const i = LIT_KEYS.indexOf(key);
  if (i < 0) throw new Error(`no literal "${key}"`);
  return ex.lit(i);
}

describe("casing.ts pin #1: exhaustive mapping sweep vs Node", () => {
  test(
    "all 1,114,112 code points, both directions, full result + length + exact non-identity count 3068",
    async () => {
      const core = await buildCore();
      let nonIdentityUpper = 0;
      let nonIdentityLower = 0;
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        const ch = String.fromCodePoint(cp);
        for (const convType of [0, 1] as const) {
          const want = convType === 0 ? ch.toUpperCase() : ch.toLowerCase();
          const [cnt, r0, r1, r2] = core.caseConvCp(cp, convType);
          // NOT Array.from(String.fromCodePoint(cp2)) — string iteration
          // combines surrogate pairs back into one code-POINT step, which
          // silently drops the low surrogate here. Re-encode units
          // directly instead (this is exactly what the wasm side's own
          // emitWriteCp does — matching it independently, not reusing it).
          const got = [r0, r1, r2]
            .slice(0, cnt)
            .flatMap((cp2) =>
              cp2 < 0x10000
                ? [cp2]
                : [0xd800 + ((cp2 - 0x10000) >> 10), 0xdc00 + ((cp2 - 0x10000) & 0x3ff)],
            )
            .map((u) => String.fromCharCode(u))
            .join("");
          if (got !== want) {
            expect(got, `cp=0x${cp.toString(16)} convType=${convType} (ICU 78.3/Unicode 17.0)`).toBe(want);
          }
          if (got !== ch) {
            if (convType === 0) nonIdentityUpper++;
            else nonIdentityLower++;
          }
        }
      }
      // Positive control: an uncontrolled zero is unfalsifiable — report
      // the hits beside the count. Measured (rev-inc20 + independent
      // Node-side sweep, increment-20-design.md): shrink 0, grow 103
      // (upper 102 + lower 1), non-identity 3068 total across both
      // directions combined with the SAME-mapping-but-different-case
      // entries (this counts every cp whose result differs from itself
      // under the given direction, not just growth — matches the C
      // oracle's "3068 agreeing non-identity mappings" count exactly).
      expect(nonIdentityUpper + nonIdentityLower, "total non-identity mappings, both directions").toBe(3068);
    },
    120_000,
  );
});

describe("casing.ts pin #2: exhaustive predicate sweep vs Node property escapes", () => {
  test(
    "isCased/isCaseIgnorable match /\\p{Cased}/u and /\\p{Case_Ignorable}/u exactly, exact positive counts",
    async () => {
      const core = await buildCore();
      const casedRe = /\p{Cased}/u;
      const ciRe = /\p{Case_Ignorable}/u;
      let casedCount = 0;
      let ciCount = 0;
      // Full domain, no surrogate skip (N1 fix): \p{Cased}/\p{Case_Ignorable}
      // test lone surrogates fine (measured — /\p{Cased}/u.test("\uD800")
      // returns false, no throw, for all of U+D800/U+DBFF/U+DC00/U+DFFF),
      // and finalSigma genuinely feeds isCased/isCaseIgnorable a lone
      // surrogate on inputs like "\uD800Σ\uDC00" — skipping the range here
      // left those 2,048 code points unexercised against the oracle.
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        const ch = String.fromCodePoint(cp);
        const wantCased = casedRe.test(ch) ? 1 : 0;
        const wantCi = ciRe.test(ch) ? 1 : 0;
        const gotCased = core.isCased(cp);
        const gotCi = core.isCaseIgnorable(cp);
        if (gotCased !== wantCased) {
          expect(gotCased, `isCased(0x${cp.toString(16)})`).toBe(wantCased);
        }
        if (gotCi !== wantCi) {
          expect(gotCi, `isCaseIgnorable(0x${cp.toString(16)})`).toBe(wantCi);
        }
        casedCount += gotCased;
        ciCount += gotCi;
      }
      // Exact counts (gate B1 fix), independently re-verified against a
      // fresh Node sweep before writing these in: Cased = 4632,
      // Case_Ignorable = 2794, both = 268, union (Cased OR Case_Ignorable)
      // = 4632 + 2794 - 268 = 7158 — the header's "7158" names the UNION,
      // not either predicate alone. A toBeGreaterThan(0) presence check
      // here would pass under a truncated sweep domain (e.g. stopping at
      // 0xFFFF) exactly the way pin #1's exact-3068 count is armored
      // against — these two exact-count assertions close that gap.
      expect(casedCount, "total Cased positives").toBe(4632);
      expect(ciCount, "total Case_Ignorable positives").toBe(2794);
    },
    120_000,
  );
});

describe("casing.ts pin #3: Final_Sigma astral discriminating matrix", () => {
  test("back-scan over an astral cased pair: \\u{10428}Σ -> final ς", async () => {
    const ex = await buildStrings();
    const got = jsToStr(ex, ex.toLower(lit(ex, "deseretSigma")));
    expect(got).toBe("\u{10428}ς");
  });
  test("forward-scan false-positive direction: AΣ\\u{10428} -> medial σ", async () => {
    const ex = await buildStrings();
    const got = jsToStr(ex, ex.toLower(lit(ex, "aSigmaDeseret")));
    expect(got).toBe("aσ\u{10428}");
  });
  test("astral case-ignorable back-skip: A\\u{1D167}Σ -> final ς", async () => {
    const ex = await buildStrings();
    const got = jsToStr(ex, ex.toLower(lit(ex, "aMusicSigma")));
    expect(got).toBe("a\u{1D167}ς");
  });
  test("non-discriminating sanity: AΣ\\u{1D167} -> final ς (right either way)", async () => {
    const ex = await buildStrings();
    const got = jsToStr(ex, ex.toLower(lit(ex, "aSigmaMusic")));
    expect(got).toBe("aς\u{1D167}");
  });
});

describe("casing.ts pin #4: Final_Sigma context matrix", () => {
  const cases: [string, string][] = [
    ["sigma", "σ"],
    ["aSigma", "aς"],
    ["sigmaA", "σa"],
    ["aSigmaA", "aσa"],
    ["aSigma2", "aς2"],
    ["aSigmaSpace", "aς "],
    ["aQuoteSigma", "a'ς"],
    ["aAcuteSigma", "áς"],
    ["aSoftHyphenSigma", "a­ς"],
    ["quoteSigma", "'σ"],
    ["aSigmaQuote", "aς'"],
    ["aSigmaQuoteA", "aσ'a"],
    ["aSigmaAcute2", "aς́2"],
    ["sigmaSigma", "σς"],
    ["aSigmaSigma", "aσς"],
    ["odosOdos", "οδος οδος"],
    ["emojiSigma", "\u{1F600}σ"],
    ["loneSurrogateSigma", "\ud800σ\udc00"],
    ["sigmaAcute", "σ́"],
    ["aAcuteSigmaLit", "áς"],
  ];
  for (const [key, want] of cases) {
    test(`${key} -> ${JSON.stringify(want)}`, async () => {
      const ex = await buildStrings();
      const jsWant = LITERALS[key]!.toLowerCase();
      expect(jsWant, "sanity: matches the live Node oracle too").toBe(want);
      const got = jsToStr(ex, ex.toLower(lit(ex, key)));
      expect(got).toBe(want);
    });
  }
  test("Final_Sigma does not fire upward: aς.toUpperCase() === AΣ", async () => {
    const ex = await buildStrings();
    expect(LITERALS.aSigmaLower!.toUpperCase()).toBe("AΣ"); // sanity vs live Node
    const got = jsToStr(ex, ex.toUpper(lit(ex, "aSigmaLower")));
    expect(got).toBe("AΣ");
  });
});

describe("casing.ts pin #5: length-growth with per-index charCodeAt", () => {
  test("ß -> SS (1 -> 2 units)", async () => {
    const ex = await buildStrings();
    const r = ex.toUpper(lit(ex, "strasse"));
    const got = jsToStr(ex, r);
    expect(got).toBe("STRASSE");
    expect(ex.len(ex.toUpper(lit(ex, "strasse")))).toBeGreaterThan(0);
  });
  // v2.2 pin directive: U+0130 İ -> U+0069 U+0307 is the ONLY lower-
  // direction growth mapping in all of Unicode (102 of the other 103
  // growers are upper-only) — MUST exercise toLowerCase specifically.
  // İ uppercases to itself, so a pin written against toUpperCase would
  // pass as a silent no-op even with the lowercase growth path entirely
  // broken. This is the sole dedicated witness for lowercase-direction
  // buffer growth: the exhaustive sweep covers it as just 1 of 3068
  // non-identity rows, so any future sharding/sampling/scoping of that
  // sweep must know this pin is the lowercase growth path's anchor.
  test("İ -> i + U+0307 (1 -> 2 units), exact code units", async () => {
    const ex = await buildStrings();
    const r = ex.toLower(lit(ex, "istanbul"));
    expect(ex.at(r, 0)).toBe(0x69);
    expect(ex.at(r, 1)).toBe(0x0307);
    expect(jsToStr(ex, r)).toBe("İstanbul".toLowerCase());
  });
  test("ﬁ -> FI", async () => {
    const ex = await buildStrings();
    expect(jsToStr(ex, ex.toUpper(lit(ex, "fnal")))).toBe("ﬁnal".toUpperCase());
  });
  test("U+0390 (ΐ) upper -> 3 units, exact code units (worst-case growth)", async () => {
    const ex = await buildStrings();
    const core = await buildCore();
    const [cnt, r0, r1, r2] = core.caseConvCp(0x390, 0);
    expect(cnt).toBe(3);
    const got = String.fromCharCode(r0, r1, r2);
    expect(got).toBe("\u{390}".toUpperCase());
    void ex;
  });

  // N2 (gate finding): the code-point-level pin above proves the MAPPING
  // is right but never drives a maximal-growth result through
  // caseConvWorker's own 3*len scratch buffer — the largest end-to-end
  // string this suite exercised before this pin was "straße" at 6->7
  // units (~1.17x). Three U+0390s (3 input units) is a REAL 3x case
  // through the actual buffer/trim path, not just the arithmetic.
  test("3x U+0390 through the real caseConvWorker buffer: 3 -> 9 units end-to-end", async () => {
    const ex = await buildStrings();
    const want = LITERALS.triple0390!.toUpperCase();
    expect(want.length).toBe(9); // sanity vs live Node, checked before adding this pin
    const r = ex.toUpper(lit(ex, "triple0390"));
    expect(ex.len(r)).toBe(9);
    expect(jsToStr(ex, r)).toBe(want);
  });
});

describe("casing.ts pin #6: astral case pairs + lone-surrogate identity", () => {
  test("Deseret pair round trip, .length and charCodeAt", async () => {
    const ex = await buildStrings();
    const up = ex.toUpper(lit(ex, "deseretPair"));
    expect(ex.len(up)).toBe(4);
    expect(jsToStr(ex, up)).toBe("\u{10437}\u{10437}".toUpperCase());
    const lo = ex.toLower(lit(ex, "deseretLower"));
    expect(jsToStr(ex, lo)).toBe("\u{10437}");
  });
  test("lone surrogates: identity both directions, neighbors undisturbed", async () => {
    const ex = await buildStrings();
    for (const key of ["loneHigh", "loneLow", "loneReversed", "loneHighA"] as const) {
      const src = LITERALS[key]!;
      expect(jsToStr(ex, ex.toUpper(lit(ex, key))), key).toBe(src.toUpperCase());
      expect(jsToStr(ex, ex.toLower(lit(ex, key))), key).toBe(src.toLowerCase());
    }
  });
});

describe("casing.ts pin #7/#8: binary-search boundaries + ASCII fast path", () => {
  test("ASCII a-z/A-Z convert; boundary punctuation does not; empty stays empty", async () => {
    const ex = await buildStrings();
    expect(jsToStr(ex, ex.toUpper(lit(ex, "ascii")))).toBe("ABCXYZ");
    expect(jsToStr(ex, ex.toLower(lit(ex, "ascii")))).toBe("abcxyz");
    for (const key of ["atSign", "bracket", "backtick", "brace"] as const) {
      const src = LITERALS[key]!;
      expect(jsToStr(ex, ex.toUpper(lit(ex, key))), key).toBe(src);
      expect(jsToStr(ex, ex.toLower(lit(ex, key))), key).toBe(src);
    }
    expect(jsToStr(ex, ex.toUpper(lit(ex, "empty")))).toBe("");
    expect(jsToStr(ex, ex.toLower(lit(ex, "empty")))).toBe("");
  });

  // LE round-trip spot pin (team-lead audit note): case_conv_table1's LAST
  // two entries (idx 376/377, the Adlam block) have the top bit set
  // (0xf4802231 / 0xf4912201) — this exercises the u32 little-endian
  // data-segment packing + the actual wasm arrayGet(table1Type) path at a
  // boundary value that would misbehave first under a signed-shift or
  // byte-order bug (the exhaustive sweep already covers this entry as 2 of
  // its 3068 rows; this pin makes that specific boundary legible on its
  // own rather than relying on the aggregate count).
  test("LE round-trip at a top-bit-set table1 boundary entry (Adlam capital/small)", async () => {
    const core = await buildCore();
    const [cnt1, r0_1] = core.caseConvCp(0x1e900, 1); // Adlam capital ALIF -> lower
    expect(cnt1).toBe(1);
    expect(r0_1).toBe(0x1e922);
    const [cnt2, r0_2] = core.caseConvCp(0x1e922, 0); // Adlam small ALIF -> upper
    expect(cnt2).toBe(1);
    expect(r0_2).toBe(0x1e900);
  });
});

describe("casing.ts pin #9: bitmap-membership spot pins", () => {
  test("known Cased/Case_Ignorable members and non-members", async () => {
    const core = await buildCore();
    expect(core.isCased(0x41)).toBe(1); // 'A'
    expect(core.isCased(0x3b1)).toBe(1); // 'α'
    expect(core.isCased(0x20)).toBe(0); // space
    expect(core.isCased(0x30)).toBe(0); // '0'
    expect(core.isCaseIgnorable(0x301)).toBe(1); // combining acute
    expect(core.isCaseIgnorable(0x2b0)).toBe(1); // modifier letter small h
    expect(core.isCaseIgnorable(0x41)).toBe(0); // 'A'
    expect(core.isCaseIgnorable(0x20)).toBe(0); // space
  });
});

describe("casing.ts pin #10: init-guard structural pin", () => {
  test("gInitCount is exactly 1 after many calls across every entry point, any order", async () => {
    const core = await buildCore();
    core.isCaseIgnorable(0x301);
    core.caseConvCp(0x41, 0);
    core.isCased(0x3b1);
    core.caseConvCp(0xdf, 0);
    core.isCased(0x20);
    core.caseConvCp(0x390, 1);
    expect(core.initCount()).toBe(1);
  });
});

describe("casing.ts full-surface smoke: the 1481 corpus pin's shapes, direct", () => {
  test("mixed-case round trips, whitespace preserved", async () => {
    const ex = await buildStrings();
    expect(jsToStr(ex, ex.toUpper(lit(ex, "hello")))).toBe(LITERALS.hello!.toUpperCase());
    expect(jsToStr(ex, ex.toLower(lit(ex, "hello")))).toBe(LITERALS.hello!.toLowerCase());
    expect(jsToStr(ex, ex.toLower(lit(ex, "mixedLower")))).toBe(LITERALS.mixedLower!.toLowerCase());
    expect(jsToStr(ex, ex.toUpper(lit(ex, "mixedUpper")))).toBe(LITERALS.mixedUpper!.toUpperCase());
  });
  test("Cyrillic, Greek, and accented Latin round trips", async () => {
    const ex = await buildStrings();
    expect(jsToStr(ex, ex.toLower(lit(ex, "privetMir")))).toBe(LITERALS.privetMir!.toLowerCase());
    expect(jsToStr(ex, ex.toUpper(lit(ex, "privetMirLower")))).toBe(LITERALS.privetMirLower!.toUpperCase());
    expect(jsToStr(ex, ex.toLower(lit(ex, "cafeAccents")))).toBe(LITERALS.cafeAccents!.toLowerCase());
    expect(jsToStr(ex, ex.toUpper(lit(ex, "cafeAccentsLower")))).toBe(LITERALS.cafeAccentsLower!.toUpperCase());
  });
  test("case-less content (CJK) untouched", async () => {
    const ex = await buildStrings();
    expect(jsToStr(ex, ex.toUpper(lit(ex, "cjkMix")))).toBe(LITERALS.cjkMix!.toUpperCase());
  });
  test("ΣΊΣΥΦΟΣ Final_Sigma", async () => {
    const ex = await buildStrings();
    expect(jsToStr(ex, ex.toLower(lit(ex, "sigisyphos")))).toBe(LITERALS.sigisyphos!.toLowerCase());
  });
  test("Σ/ΑΣ/Σ2 corpus shapes", async () => {
    const ex = await buildStrings();
    expect(jsToStr(ex, ex.toLower(lit(ex, "sigma")))).toBe("σ");
    expect(jsToStr(ex, ex.toLower(lit(ex, "alphaSigma")))).toBe("ας");
    // Σ is the FIRST character here (nothing precedes it in this string),
    // so the back-scan fails immediately regardless of what follows —
    // non-final, verified directly against live Node ("Σ2".toLowerCase()
    // === "σ2"), not assumed from the corpus comment's grouping.
    expect(jsToStr(ex, ex.toLower(lit(ex, "sigma2")))).toBe("σ2");
  });
});
