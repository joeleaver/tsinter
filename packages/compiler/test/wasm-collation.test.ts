/* GH #87: String.prototype.localeCompare collates as Node does — ICU 78.3's
 * root collation (CLDR 48, UCA 17), tertiary strength, non-ignorable,
 * normalization on (SEMANTICS.md S120).
 *
 * Three layers, every expectation Node's own (nothing below is hand-typed
 * output):
 *
 *   1. the TABLES, through collation-model.ts (a JavaScript model of
 *      collation.ts over the checked-in collation-tables.ts), against
 *      Intl.Collator: every code point in order, contractions with marks
 *      between and around them, canonically equivalent spellings, and a
 *      few hundred thousand mixed strings; and the locales the lowering
 *      accepts ("en", "en-US") against the default;
 *   2. the RUNTIME: generated programs compiled for the wasm and
 *      wasm-native lanes (one module, one routine) against Node running
 *      the same source — thousands of comparisons and a sort;
 *   3. the c / llvm lanes' ASCII table (scr_string.c) against the model,
 *      and the refusals by name.
 *
 * Node, the oracle, runs with the harness's environment; its default
 * locale's collation must be root's for these rows to mean anything, so
 * the first test pins that. */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { CollationStop, collationElements, collationTables, modelCompare } from "./collation-model.js";
import { STOP_MESSAGE } from "../src/backend/wasm/collation.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-collation-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const icu = new Intl.Collator().compare;

/** The model's answer, or "stop" where the routine stops by name. */
function tryModel(a: string, b: string): -1 | 0 | 1 | "stop" {
  try {
    return modelCompare(a, b);
  } catch (e) {
    if (e instanceof CollationStop) return "stop";
    throw e;
  }
}
const sgn = (x: number): number => (x < 0 ? -1 : x > 0 ? 1 : 0);
const hex = (s: string): string => [...s].map((c) => c.codePointAt(0)!.toString(16)).join(" ");

/** A deterministic generator (an LCG), so every run checks the same strings. */
function rng(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

/** Code points that exercise every mechanism: marks of many classes,
 * contraction pieces, prefix context, Hangul, Han, implicit weights,
 * surrogates, specials. */
const MARKS = [0x300, 0x301, 0x302, 0x303, 0x308, 0x30a, 0x323, 0x327, 0x328, 0x31b, 0x345, 0x5b0, 0x591, 0x0f71, 0x0f72, 0x0f74, 0x0f80, 0x0e48, 0x0e38, 0x093c, 0x094d, 0x3099, 0x309a, 0x0306, 0x1dfa, 0x20d2];
const EXTRA = [
  0x00c5, 0x212b, 0x00e5, 0x1e9b, 0x0418, 0x0419, 0x0438, 0x0439, 0x0e40, 0x0e01, 0x0fb2, 0x0fb3, 0x0f40, 0x0f90, 0x0fb5, 0x0f42,
  0x0fb7, 0x006c, 0x004c, 0x00b7, 0x0387, 0x1100, 0x1161, 0x11a8, 0xac00, 0xac01, 0xd7a3, 0x4e00, 0x4e17, 0x9fa5, 0x3400, 0x20000,
  0xf900, 0xfa0e, 0x2f800, 0x17000, 0x18d00, 0x18800, 0x1b170, 0x18b00, 0x18cff, 0x1f600, 0x1f468, 0x200d, 0xfe0f, 0x1f3fb, 0xd800,
  0xdc00, 0xdbff, 0xfffd, 0xfffe, 0xffff, 0xfdd0, 0xfdd1, 0x0000, 0x0009, 0x00a0, 0x00ad, 0x3042, 0x30a2, 0x30fc, 0x309d, 0x3005,
  0x0627, 0x0644, 0x05d0, 0x0391, 0x03b1, 0x1f80, 0x0130, 0x0131, 0x00df, 0x1e9e, 0xfb01, 0xff21, 0x2460, 0x00bd, 0x1d400, 0x0d4e,
  0x1611e, 0x1611f, 0x16129, 0x16120, 0x16d63, 0x16d67, 0x0cc6, 0x0cc2, 0x0cd5, 0x0dd9, 0x0dcf, 0x0dca, 0x0e33, 0x0eb3, 0x0378,
  0xe000, 0x10ffff, 0x2a6df, 0x33479, 0x3347a, 0x0041, 0x0061, 0x00e9, 0x00c9, 0x0065, 0x0301, 0x00f1, 0x006e, 0x0303,
];
const ALPHA = [..."aAbBcCeEzZ0129 -_.,'!?@#$%&*()[]{}/\\|~`^\t\n"].map((c) => c.codePointAt(0)!);

/** The contraction and prefix keys of the tables (from the unpacked CTR
 * records), for strings built around them. */
function contractionPieces(): number[] {
  const D = collationTables();
  const out = new Set<number>();
  for (const [cp, e] of D.entries) {
    if ((e & 3) !== 3) continue;
    out.add(cp);
    const at = e >>> 2;
    const np = D.ctr[at + 1]!;
    const nc = D.ctr[at + 2]!;
    for (let k = 0; k < np; k++) out.add(D.ctr[at + 3 + 2 * k]!);
    for (let k = 0; k < nc; k++) {
      out.add(D.ctr[at + 3 + 2 * np + 3 * k]!);
      const c3 = D.ctr[at + 3 + 2 * np + 3 * k + 1]!;
      if (c3) out.add(c3);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Mixed strings: mostly from the alphabets above, with contraction
 * pieces, marks, NFC/NFD twins, and prefixes of each other. */
function mixedStrings(count: number, seed: number): [string, string][] {
  const r = rng(seed);
  const pieces = contractionPieces();
  const allMarks = [...collationTables().ccc.keys()];
  const pick = (): number => {
    const k = r(12);
    if (k < 4) return ALPHA[r(ALPHA.length)]!;
    if (k < 6) return MARKS[r(MARKS.length)]!;
    if (k < 7) return allMarks[r(allMarks.length)]!;
    if (k < 9) return pieces[r(pieces.length)]!;
    if (k < 10) return r(0x110000);
    return EXTRA[r(EXTRA.length)]!;
  };
  const mk = (): string => {
    let s = "";
    const n = r(7);
    for (let k = 0; k < n; k++) s += String.fromCodePoint(pick());
    return s;
  };
  const out: [string, string][] = [];
  for (let k = 0; k < count; k++) {
    const a = mk();
    const v = r(6);
    const b =
      v === 0 ? a.normalize("NFC") : v === 1 ? a.normalize("NFD") : v === 2 ? a + String.fromCodePoint(pick()) : v === 3 ? a.slice(0, r(a.length + 1)) : mk();
    out.push([a, b]);
  }
  return out;
}

/** Contraction starters followed by marks drawn on purpose from the
 * supplementary planes, the BMP and the Tibetan vowels, then optionally a
 * starter, paired with a canonically equivalent or shuffled twin — the
 * shapes where ICU re-reads raw text after a failed contraction lookahead
 * (collation.ts markQuirks). */
function starterMarkStrings(count: number, seed: number): [string, string][] {
  const r = rng(seed);
  const D = collationTables();
  const starters: number[] = [];
  for (const [cp, e] of D.entries) if ((e & 3) === 3) starters.push(cp);
  starters.sort((a, b) => a - b);
  const pieces = contractionPieces();
  const marks = [...D.ccc.keys()].sort((a, b) => a - b);
  const supp = marks.filter((c) => c > 0xffff);
  const bmp = marks.filter((c) => c <= 0xffff);
  const tib = [0xf71, 0xf72, 0xf73, 0xf74, 0xf75, 0xf80, 0xf81, 0xf82, 0xf83, 0xf39, 0xfc6];
  const pick = (): number => {
    const k = r(10);
    if (k < 3) return supp[r(supp.length)]!;
    if (k < 5) return bmp[r(bmp.length)]!;
    if (k < 7) return pieces[r(pieces.length)]!;
    if (k < 8) return tib[r(tib.length)]!;
    if (k < 9) return starters[r(starters.length)]!;
    return [0x61, 0x62, 0x20, 0x4e00, 0x10000][r(5)]!;
  };
  const out: [string, string][] = [];
  for (let k = 0; k < count; k++) {
    let a = String.fromCodePoint(starters[r(starters.length)]!);
    const n = 1 + r(5);
    for (let i = 0; i < n; i++) a += String.fromCodePoint(pick());
    if (r(2)) a += String.fromCodePoint(pick());
    const arr = [...a];
    const v = r(4);
    let b: string;
    if (v === 0) b = a.normalize("NFD");
    else if (v === 1) {
      for (let i = arr.length - 1; i > 1; i--) {
        const j = 1 + r(i);
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      b = arr.join("");
    } else if (v === 2) b = a.normalize("NFC");
    else b = String.fromCodePoint(starters[r(starters.length)]!, pick(), pick());
    if (r(3) === 0) {
      a = "x" + a;
      b = "x" + b;
    }
    out.push([a, b]);
  }
  return out;
}

describe("the root collation tables (collation-model.ts) against Node's ICU", () => {
  test("the oracle: Node v24.18.1, ICU 78.3 / CLDR 48 / Unicode 17, default collation root's", () => {
    expect(process.versions.icu).toBe("78.3");
    expect(process.versions.cldr).toBe("48.0");
    expect(process.versions.unicode).toBe("17.0");
    const o = new Intl.Collator().resolvedOptions();
    expect([o.usage, o.sensitivity, o.ignorePunctuation, o.collation, o.numeric, o.caseFirst]).toEqual([
      "sort", "variant", false, "default", false, "false",
    ]);
  });

  test("every code point, lone surrogates included, in Node's order (adjacent pairs of the model's sort)", () => {
    const all: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) all.push(String.fromCodePoint(c));
    all.sort(modelCompare);
    const bad: string[] = [];
    for (let i = 0; i + 1 < all.length; i++) {
      const m = modelCompare(all[i]!, all[i + 1]!);
      const n = sgn(icu(all[i]!, all[i + 1]!));
      if (m !== n && bad.length < 20) bad.push(`${hex(all[i]!)} vs ${hex(all[i + 1]!)}: model ${m}, Node ${n}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  test("two code points: every BMP code point below U+3000 and a sample beyond, before contraction tails and marks", () => {
    const heads: number[] = [];
    for (let c = 0; c < 0x3000; c++) heads.push(c);
    heads.push(0x4e00, 0xac00, 0x1f600, 0x10000, 0x17000, 0xd800, 0xdfff, 0xffff, 0xfffe, 0xfdd0, 0xfdd1);
    const tails = [0x61, 0x41, 0x300, 0x301, 0x327, 0x323, 0x0f71, 0x0f72, 0x0f80, 0x0e01, 0x00b7, 0x0306, 0x3099, 0x20, 0x2d, 0x0, 0xfdd0, 0x5b57, 0xac00, 0xac01, 0x1100];
    const strs: string[] = [];
    for (const h of heads) for (const t of tails) strs.push(String.fromCodePoint(h, t));
    strs.sort(modelCompare);
    const bad: string[] = [];
    for (let i = 0; i + 1 < strs.length; i++) {
      const m = modelCompare(strs[i]!, strs[i + 1]!);
      const n = sgn(icu(strs[i]!, strs[i + 1]!));
      if (m !== n && bad.length < 20) bad.push(`${hex(strs[i]!)} vs ${hex(strs[i + 1]!)}: model ${m}, Node ${n}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  test("400,000 mixed strings: marks, contractions (contiguous and discontiguous), prefixes, NFC/NFD twins", () => {
    const bad: string[] = [];
    for (const [a, b] of mixedStrings(400_000, 87)) {
      const m = modelCompare(a, b);
      const n = sgn(icu(a, b));
      if (m !== n && bad.length < 20) bad.push(`${hex(a)} | ${hex(b)}: model ${m}, Node ${n}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  test("a contraction starter, then every nonspacing mark and a lower-class mark out of canonical order (ICU's raw re-read)", () => {
    const marks: number[] = [];
    for (let cp = 0x300; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (/\p{Mn}/u.test(ch) && ch.normalize("NFD") === ch) marks.push(cp);
    }
    const bad: string[] = [];
    let stops = 0;
    let exact = 0;
    for (const base of ["\u0438", "a", "\u0418", "\u0fb2", "\u0f71"]) {
      for (const lo of [0x3099, 0x0316, 0x0334, 0x05b0, 0x0e38, 0x0f71, 0x093c, 0x1d167]) {
        for (const cp of marks) {
          const m = String.fromCodePoint(cp);
          const l = String.fromCodePoint(lo);
          for (const [a, b] of [[base + m + l, base + l + m], [base + m + l + "z", base + l + m + "z"]] as const) {
            if (a === b || a.normalize("NFD") !== b.normalize("NFD")) continue;
            const n = sgn(icu(a, b));
            const m = tryModel(a, b);
            if (m === "stop") {
              stops++;
              // only a contraction starter inside the marks stops (ཱ here)
              if (!a.includes("\u0f71") && bad.length < 20) bad.push(`${hex(a)} stopped`);
              continue;
            }
            exact++;
            if (m !== n && bad.length < 20) bad.push(`${hex(a)} vs ${hex(b)}: Node ${n}, model ${m}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(exact).toBeGreaterThan(10 * stops);
  }, 300_000);

  test("400,000 contraction starters before supplementary, BMP and Tibetan marks, against canonical twins and shuffles", () => {
    const bad: string[] = [];
    let stops = 0;
    for (const [a, b] of starterMarkStrings(400_000, 787)) {
      const m = tryModel(a, b);
      if (m === "stop") {
        stops++;
        continue;
      }
      const n = sgn(icu(a, b));
      if (m !== n && bad.length < 20) bad.push(`${hex(a)} | ${hex(b)}: model ${m}, Node ${n}`);
    }
    expect(bad).toEqual([]);
    expect(stops).toBeLessThan(4000); // the named stop stays rare (S120 (c))
  }, 300_000);

  test('the locales the lowering accepts collate as the default does: "en", "en-US", undefined', () => {
    const en = new Intl.Collator("en").compare;
    const enUS = new Intl.Collator("en-US").compare;
    const all: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) all.push(String.fromCodePoint(c));
    all.sort(modelCompare);
    let bad = 0;
    const check = (a: string, b: string): void => {
      const m = modelCompare(a, b);
      if (sgn(en(a, b)) !== m || sgn(enUS(a, b)) !== m || sgn(a.localeCompare(b, undefined, undefined)) !== m) bad++;
    };
    for (let i = 0; i + 1 < all.length; i++) check(all[i]!, all[i + 1]!);
    for (const [a, b] of mixedStrings(100_000, 4)) check(a, b);
    expect(bad).toBe(0);
  }, 120_000);
});

/* ── compiled programs ────────────────────────────────────────────────── */

interface Out {
  stdout: string;
  code: number;
}

async function exec(cmd: string, args: string[]): Promise<Out> {
  const p = run(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  p.child.stdin?.end();
  try {
    const r = await p;
    return { stdout: r.stdout, code: 0 };
  } catch (e) {
    const x = e as { stdout?: string; code?: number };
    return { stdout: x.stdout ?? "", code: typeof x.code === "number" ? x.code : -1 };
  }
}

async function wasmRun(id: string, file: string): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  return { stdout: String(r.stdout), code: r.exitCode };
}

async function nativeRun(id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  return exec(res.binaryPath, []);
}

/** A program over `strs`: the sign of every listed comparison, one
 * character each, then the order a localeCompare sort leaves them in. */
function program(strs: string[], pairs: [number, number][]): string {
  return [
    `const S: string[] = [${strs.map((s) => JSON.stringify(s)).join(",\n")}];`,
    `const P: number[] = [${pairs.flat().join(",")}];`,
    `let out = "";`,
    `for (let k = 0; k < P.length; k += 2) {`,
    `  const r = S[P[k]].localeCompare(S[P[k + 1]]);`,
    `  out += r < 0 ? "<" : r > 0 ? ">" : "=";`,
    `}`,
    `console.log(out);`,
    `const idx: number[] = S.map((_, i) => i);`,
    `idx.sort((a, b) => S[a].localeCompare(S[b]));`,
    `console.log(idx.join(","));`,
    `console.log(S.slice(0, 300).sort((a, b) => a.localeCompare(b)).map((s) => s.length).join(","));`,
    ``,
  ].join("\n");
}

describe("compiled programs against Node: the wasm and wasm-native lanes", () => {
  const r = rng(2026);
  const strs: string[] = [];
  for (const [a, b] of mixedStrings(1500, 11)) strs.push(a, b);
  for (const [a, b] of starterMarkStrings(800, 31)) if (tryModel(a, b) !== "stop") strs.push(a, b);
  strs.push("\u0438\u{10AE5}\u3099", "\u0438\u3099\u{10AE5}", "\u0418\u{1E944}\u0316", "\u0418\u0316\u{1E944}", "\u0438\u{10AE5}\u0f71", "\u0438\u0f71\u{10AE5}");
  for (let c = 0; c < 128; c++) strs.push(String.fromCharCode(c), `x${String.fromCharCode(c)}y`);
  strs.push("", "a", "A", "B", "b", "é", "é", "f", "résumé", "resume", "Resume", "résume", "coté", "côte", "côté", "cote");
  strs.push("Å", "Å", "Å", "ﬁ", "fi", "Straße", "STRASSE", "strasse", "ǅ", "Ǆ", "ǆ", "😀", "\ud83d", "\ude00", "\ud800\ud800");
  strs.push("l·l", "L·L", "ll", "l·l", "ྲཱི", "ྲཱྀ", "ྲཱི", "Й", "Й", "й́");
  strs.push("\ufdd1\uac00", "\ufdd1\u1100\u1161", "\ufdd1\uac01", "\ufdd1\u0301\uac00", "\ufdd0A", "\ufdd0", "\ufdd1A", "\ufdd14");
  strs.push("한국어", "한글", "한", "中文", "中国", "丗", "世", "日本語", "にほんご", "ニホンゴ", "ｶﾀｶﾅ");
  const pairs: [number, number][] = [];
  for (let k = 0; k < 20000; k++) pairs.push([r(strs.length), r(strs.length)]);
  for (let k = 0; k + 1 < strs.length; k++) pairs.push([k, k + 1]);
  const file = join(scratch, "collation-diff.ts");
  writeFileSync(file, program(strs, pairs));

  test(`${pairs.length} comparisons over ${strs.length} strings and two localeCompare sorts, wasm lane`, async () => {
    const [node, wasm] = await Promise.all([exec(process.execPath, [file]), wasmRun("diff", file)]);
    expect(node.code).toBe(0);
    expect(wasm.code).toBe(0);
    expect(wasm.stdout).toBe(node.stdout);
  }, 300_000);

  test("the same program, wasm-native lane", async () => {
    const [node, nat] = await Promise.all([exec(process.execPath, [file]), nativeRun("diff", file)]);
    expect(nat.code).toBe(0);
    expect(nat.stdout).toBe(node.stdout);
  }, 600_000);

  test("the reference repro (tests/real-apps-round2/silent/02-localecompare-code-unit-order.ts), both lanes", async () => {
    const repro = join(import.meta.dirname, "../../../tests/real-apps-round2/silent/02-localecompare-code-unit-order.ts");
    const [node, wasm, nat] = await Promise.all([exec(process.execPath, [repro]), wasmRun("repro", repro), nativeRun("repro", repro)]);
    expect(node.stdout).toBe("-1 1 -1 -1\na,b,C,E,é\n");
    expect(wasm.stdout).toBe(node.stdout);
    expect(nat.stdout).toBe(node.stdout);
  }, 600_000);

  test("locales and options: absent, undefined, \"en\", \"en-US\" lower; a slot holding undefined is ToString'd", async () => {
    const src = join(scratch, "locales.ts");
    writeFileSync(
      src,
      [
        `const a = "a", b = "B", e = "é";`,
        `console.log(a.localeCompare(b), a.localeCompare(b, undefined), a.localeCompare(b, undefined, undefined), a.localeCompare(b, "en"), a.localeCompare(b, "en-US"), e.localeCompare("f", void 0));`,
        `const xs: string[] = ["u"];`,
        `const u = xs[3];`,
        `console.log("undefined".localeCompare(u), "v".localeCompare(u), "t".localeCompare(u));`,
        // views (a slice of 13 units or more) and ropes (concatenations) as
        // either operand
        `const long = "prefix-" + "Ä".repeat(3) + "-middle-part-" + "é" + "-suffix";`,
        `const view = long.slice(7), rope = "ÄÄÄ" + "-middle-part-" + "e\\u0301" + "-suffix";`,
        // a const bound to an accepted literal, [], a one-element list, a
        // tag Intl canonicalizes to an accepted one; a parameter that
        // shadows \`undefined\` is not the absent locale (it refuses: see
        // the refusals below)
        `const EN = "en", ENUS = "en-US";`,
        `console.log("a".localeCompare("B", EN), "a".localeCompare("B", []), "a".localeCompare("B", [ENUS]), "a".localeCompare("B", ["en"]), "a".localeCompare("B", "EN-us"), "e\u0301".localeCompare("f", ["eN"]));`,
        `function late(): number { return "a".localeCompare("B", LATE); }`,
        `try { console.log(late()); } catch (e) { console.log((e as Error).name); }`,
        `const LATE = "en";`,
        `console.log(late());`,
        `console.log(view.localeCompare(rope), rope.localeCompare(view), long.slice(2).localeCompare(long.slice(3)), (view + "a").localeCompare(rope + "B"));`,
        ``,
      ].join("\n"),
    );
    const [node, wasm, nat] = await Promise.all([exec(process.execPath, [src]), wasmRun("locales", src), nativeRun("locales", src)]);
    expect(node.stdout).toBe("-1 -1 -1 -1 -1 -1\n0 1 -1\n-1 -1 -1 -1 -1 -1\nReferenceError\n-1\n0 0 -1 -1\n");
    expect(wasm.stdout).toBe(node.stdout);
    expect(nat.stdout).toBe(node.stdout);
  }, 600_000);
});

describe("the named stop (SEMANTICS.md S120 (c))", () => {
  test("a contraction starter inside marks ending in a supplementary then a BMP mark, out of order: both lanes stop by name; the model agrees", async () => {
    const a = "\u0f71\u{10AE5}\u3099";
    expect(tryModel(a, "x")).toBe("stop");
    const src = join(scratch, "stop.ts");
    writeFileSync(src, `console.log("before");\nconsole.log(${JSON.stringify(a)}.localeCompare("x"));\n`);
    const res = await compile(src, { outPath: join(scratch, "stop.wasm"), outDir: scratch, backend: "wasm" });
    expect(res.ok).toBe(true);
    const w = await runWasmToTrap(res.binaryPath);
    expect(w.stdout).toBe("before\n");
    expect(w.stderr).toContain(STOP_MESSAGE);
    const dir = join(scratch, "stop-native");
    const nres = await compile(src, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
    expect(nres.ok).toBe(true);
    const p = run(nres.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const err = await p.then(() => null, (e: { code?: number; stdout?: string; stderr?: string }) => e);
    expect(err).not.toBeNull();
    expect(err!.stdout).toBe("before\n");
    expect(err!.stderr).toContain(STOP_MESSAGE);
  }, 600_000);
});

describe("refusals by name", () => {
  const cases: [string, string, RegExp][] = [
    ["other-locale", `console.log("a".localeCompare("b", "sv"));`, /SC2020.*\.localeCompare with locale 'sv'/],
    ["tailored-en", `console.log("a".localeCompare("b", "en-u-kn-true"));`, /SC2020.*\.localeCompare with locale 'en-u-kn-true'/],
    ["runtime-locale", `const l = process.argv.length > 9 ? "de" : "en";\nconsole.log("a".localeCompare("b", l));`, /SC2020.*\.localeCompare with a locales argument other than a string literal/],
    ["locale-list", `console.log("a".localeCompare("b", ["en", "fr"]));`, /SC2020.*\.localeCompare with a locales argument other than a string literal/],
    ["list-other", `console.log("a".localeCompare("b", ["sv"]));`, /SC2020.*\.localeCompare with locale 'sv'/],
    ["let-locale", `let l = "en";\nconsole.log("a".localeCompare("b", l));`, /SC2020.*\.localeCompare with a locales argument other than a string literal/],
    ["const-other", `const l = "de";\nconsole.log("a".localeCompare("b", l));`, /SC2020.*\.localeCompare with locale 'de'/],
    ["malformed", `console.log("a".localeCompare("b", "en_US"));`, /SC2020.*\.localeCompare with locale 'en_US'/],
    ["shadowed-undefined", `function f(undefined: string) { return "z".localeCompare("a", undefined); }\nconsole.log(f("sv"));`, /SC2020.*\.localeCompare with a locales argument other than a string literal/],
    ["shadowed-undefined-options", `function g(undefined: any) { return "a".localeCompare("A", "en", undefined); }\nconsole.log(g({ sensitivity: "base" }));`, /SC2020.*\.localeCompare with an options argument/],
    ["spread", `const xs: [string] = ["b"];\nconsole.log("a".localeCompare(...xs));`, /SC2020.*\.localeCompare with a spread argument/],
    ["options", `console.log("a".localeCompare("b", "en", { numeric: true }));`, /SC2020.*\.localeCompare with an options argument/],
    ["empty-options", `console.log("a".localeCompare("b", undefined, {}));`, /SC2020.*\.localeCompare with an options argument/],
    ["collator", `console.log(new Intl.Collator().compare("a", "b"));`, /SC2020/],
  ];
  for (const [id, src, want] of cases) {
    test(id, async () => {
      const file = join(scratch, `refuse-${id}.ts`);
      writeFileSync(file, src + "\n");
      for (const backend of ["wasm", "c"] as const) {
        const res = await compile(file, { outPath: join(scratch, `refuse-${id}-${backend}`), outDir: scratch, backend });
        expect(res.ok).toBe(false);
        expect(res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")).toMatch(want);
      }
    }, 120_000);
  }
});

describe("the c and llvm lanes' ASCII slice (scr_string.c, SEMANTICS.md S120)", () => {
  test("scr_ascii_coll holds the root collation's per-level order for U+0000..U+007F", () => {
    const text = readFileSync(join(import.meta.dirname, "../../runtime/src/scr_string.c"), "utf8");
    const body = /scr_ascii_coll\[128\]\[3\] = \{([\s\S]*?)\n\};/.exec(text)![1]!;
    const table = [...body.matchAll(/\{(\d+),(\d+),(\d+)\}/g)].map((m) => [+m[1]!, +m[2]!, +m[3]!]);
    expect(table.length).toBe(128);
    const ces = Array.from({ length: 128 }, (_, c) => collationElements(String.fromCharCode(c)));
    expect(ces.every((x) => x.length <= 1)).toBe(true); // no ASCII character expands
    for (let lv = 0; lv < 3; lv++) {
      const w = ces.map((x) => x[0]?.[lv] ?? 0);
      const ranks = [...new Set(w.filter((v) => v !== 0))].sort((a, b) => a - b);
      expect(table.map((row) => row[lv])).toEqual(w.map((v) => (v === 0 ? 0 : ranks.indexOf(v) + 1)));
    }
  });
});
