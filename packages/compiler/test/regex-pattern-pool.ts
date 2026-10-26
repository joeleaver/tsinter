/* Unit P1: the (pattern, flags) pool the run-time compiler's gate runs —
 * every claim pattern, the generated grammar corpus, every regex literal
 * and `new RegExp(<string literal>)` in tests/corpus, the pattern fixtures
 * of the retired TypeScript pipeline's unit tests (frozen in
 * fixtures/regex/unit-test-patterns.json), and seeded mutations of all of
 * those (insert / delete / duplicate / replace a character, and random flag
 * strings, legal and not). Deterministic: one seed, one pool. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript5";
import { generatedCorpus, loadClaimPatterns } from "./regex-corpus.js";

export interface PoolRow {
  pattern: string;
  flags: string;
  origin: "claim" | "generated" | "corpus" | "fixture" | "targeted" | "mutation";
}

const HERE = import.meta.dirname;
const REPO = join(HERE, "..", "..", "..");

function walkFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name !== "node_modules") walkFiles(p, out);
    } else if (/\.(ts|js|mjs|cjs|mts|cts)$/.test(name)) out.push(p);
  }
}

/** Regex literals and `new RegExp("…", "…")` / `RegExp("…")` string-literal
 * arguments in a source file. */
function scrapeSource(text: string, file: string, out: Map<string, PoolRow>, origin: PoolRow["origin"]): void {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const add = (pattern: string, flags: string): void => {
    out.set(JSON.stringify([pattern, flags]), { pattern, flags, origin });
  };
  const strOf = (n: ts.Node | undefined): string | null =>
    n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
  const visit = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const t = n.getText(sf);
      const end = t.lastIndexOf("/");
      add(t.slice(1, end), t.slice(end + 1));
    } else if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === "RegExp") {
      const p = strOf(n.arguments?.[0]);
      if (p !== null) add(p, strOf(n.arguments?.[1]) ?? "");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ..."()[]{}|*+?\\^$.-,:=!<>/",
  ..."dDsSwWbBkpPucxntrfv0",
  ..."0123456789",
  ..."aAzZ_ ",
  "\n",
  "é",
  "K",
  "ſ",
  "😀",
  "\ud800",
  "\\u{1F600}",
  "\\p{L}",
  "\\P{Lu}",
  "\\p{Script=Greek}",
  "(?<n>",
  "\\k<n>",
  "(?:",
  "(?=",
  "(?!",
  "(?<=",
  "(?<!",
  "(?i:",
  "{2,3}",
  "{2,}",
  "{3}",
  "[^",
  "\\c",
];

/** Hand-picked rows: each V8 reason and its precedence against libregexp's,
 * the build-time pipeline's own known gaps, and the value edge cases
 * (.source escaping, canonical flags, named groups). */
const TARGETED: readonly (readonly [string, string])[] = [
  ["(", "ig"], ["(", "yusmigd"], ["(?<a>x)(?<a>", ""], ["(?<a>x)(?<a>y)", ""], ["((?<a>x)|y)(?<a>z)", ""], ["(?<a>x)|(?<a>y)", ""],
  ["(?<a>x)|(y|(?<a>z))", ""], ["(?<a>x)|((?<a>y))", ""], ["(?<a>(?<a>x))", ""], ["((?<a>x)|(?<a>y))(?<a>z)", ""], ["(?<a>x)(?<a>y)\\k<zz>", ""],
  ["(?<a>x)(?<a>y))", ""], ["\\k<zz>(?<a>x)(?<a>y)", ""], ["(?<a>x)|(?<a>y)|(?<a>z)", ""], ["(?:(?<a>x)|(?<b>y))(?<b>z)", ""], ["(?<a>x)\\k<a>|(?<a>y)", ""],
  ["(?<a>x)(?<b>y)|(?<a>z)(?<b>w)", ""], ["(x|(?<a>y))|(?<a>z)", ""], ["(?<a>x)|y(?<a>z)|(?<a>w)", ""], ["((?<a>x)|(?<a>y)|z)(?<b>w)", ""],
  ["(?<a>x)|(?:(?<b>q)|(?<a>y))", ""], ["(?<a>x)|(?<a>y)\\k<a>", ""], ["\\k<a>(?<a>x)|(?<a>y)", ""], ["(?<a>.)\\k<a>(?<a>.)", ""],
  ["\\k<x>(?<a>y)[", ""], ["\\k<x>(?<a>y)", ""], ["\\k<x>(?<a>y)", "u"], ["\\k<x>", "u"], ["\\k", "u"], ["\\k<x>", ""], ["\\k<1>", "u"],
  ["\\k<1>(?<a>x)", ""], ["\\k<a", ""], ["\\k<a(?<a>x)", ""], ["(?<a>x)\\k<a", ""], ["(?<a>x)[\\k]", ""], ["(?<a>x)\\k", ""], ["[\\k](?<a>x)", ""],
  ["(?<a>x)[\\k<a>]", ""], ["[\\k]", ""], ["[\\k]", "u"], ["a**", ""], ["*", ""], ["a{2,1}", ""], ["a{2,1", "u"], ["a{", "u"], ["}", ""], ["}", "u"],
  ["]", "u"], ["{", "u"], ["a{2", "u"], ["a{25,5", ""], ["a{25,5}", ""], ["x{2,1", "u"], ["{2}", "u"], ["{a}", "u"], ["{2,1}", ""], ["^{2,1}", ""], ["^{2}", ""],
  ["^*", ""], ["\\b{2,1}", ""], ["\\b+", ""], ["(?<=a){2,1}", ""], ["(?<=a){2", ""], ["(?<=a){2", "u"], ["(?<=a)*", ""], ["(?=a)*", "u"], ["(?=a)*", ""],
  ["(?<1a>x)", ""], ["(?<a", ""], ["(?x)", ""], ["(?", ""], ["[b-a]", ""], ["[\\d-a]", "u"], ["[\\d-a]", ""], ["\\c", "u"], ["\\c1", "u"], ["[\\c1]", "u"],
  ["[\\c]", "u"], ["\\x", "u"], ["[\\x]", "u"], ["\\u{110000}", "u"], ["[\\u{110000}]", "u"], ["\\u{", "u"], ["\\uD800", "u"], ["[\\a]", "u"],
  ["[\\-]", "u"], ["\\-", "u"], ["\\p{Foo}", "u"], ["[\\p{Foo}]", "u"], ["\\p{", "u"], ["\\p", "u"], ["[\\p]", "u"], ["\\P{Foo}", "u"],
  ["\\p{L=}", "u"], ["\\p{gc}", "u"], ["\\p{gc=L}", "u"], ["\\p{General_Category=Lu}", "u"], ["\\P{L}", "u"], ["[\\p{L}\\d]", "u"],
  ["\\p{Script=Greek}", "u"], ["\\p{Alphabetic}", "u"], ["\\", ""], ["\\", "u"], ["a\\", ""], ["[\\", ""], ["[a-", ""], ["\\1", "u"], ["\\01", "u"],
  ["\\8", "u"], ["[\\8]", "u"], ["[\\0]", "u"], ["[\\05]", "u"], ["[\\1]", ""], ["(?i-i:a)", ""], ["(?ii:a)", ""], ["(?-:a)", ""], ["(?i", ""],
  ["(?ii", ""], ["(?i-i", ""], ["(?i-", ""], ["(?-", ""], ["(?-m", ""], ["(?im-s", ""], ["(?--i:)", ""], ["(?i--m:a)", ""], ["(?i-mi-:a)", ""],
  ["(?i:a)", "i"], ["(?i:a)", ""], ["(?m:^)", ""], ["(?s:.)", ""], ["(?i:)", ""], ["(?i:\\b)", ""], ["(?i:a)", "u"], ["\\bfoo", "i"], ["\\Bfoo", "i"],
  ["\\bfoo", "iu"], ["[", ""], ["a)", ""], ["x{99999999999}", ""], ["x{2,99999999999}", ""], ["x{99999999999,2}", ""], ["x{0,2147483647}", ""], ["x{0,99999999999}", ""],
  ["a/b", ""], ["\n(", ""], ["/(", ""], ["[/]", ""], ["\\/", ""], ["a\\\nb", ""], ["\\\\/", ""], ["[\\]/]", ""], ["", ""], ["\u2028\u2029/", "g"],
  ["(?<a>x)(?<b>y)\\k<b>", "gimsy"], ["(?<\u00e9t\u00e9>x)\\k<\u00e9t\u00e9>", ""], ["(?<\\u0061>x)\\k<a>", ""], ["(?<\ud835\udc9c>x)", "u"],
  ["(?<\\ud835\\udc9c>x)", ""], ["[^x]", "i"], ["[^\\w\\d]", "i"], ["[\\w\u00e9]", "i"], ["\\W", "i"], ["\u212a", "i"], ["[\u017f-\u0180]", "i"],
  ["(?<=(a)\\1)b", ""], ["(?<!a|b+)c", ""], ["(a)|\\1", ""], ["\\1(a)", ""], ["(a)\\2", ""], ["\\12(a)", ""], ["\\0", ""], ["\\00", ""], ["\\08", ""],
  ["\\cA\\c", ""], ["[\\c_]", ""], ["\\c_", ""],
  ["a", "uv"], ["a", "vu"], ["(", "uv"], ["(", "iu"], ["a{2,1}", "iu"], ["\\k<x>", "iu"], ["[b-a]", "ui"], ["a", "iv"],
  ["a".repeat(8192), ""], ["a".repeat(8193), ""], ["(?:" + "a|".repeat(4100) + "b)", ""], ["(" + "a".repeat(9000), ""],
];

const FLAG_CHOICES = ["", "", "", "g", "i", "i", "m", "s", "u", "u", "y", "d", "gi", "im", "su", "ims", "gimsy", "iu", "ig", "yg", "dgimsuy", "x", "gg", "v", "uv", "gu", "is"];

export function patternPool(mutations = 30000, seed = 0x5eed1): PoolRow[] {
  const out = new Map<string, PoolRow>();
  for (const r of loadClaimPatterns()) out.set(JSON.stringify([r.pattern, r.flags]), { ...r, origin: "claim" });
  for (const r of generatedCorpus()) {
    const k = JSON.stringify([r.pattern, r.flags]);
    if (!out.has(k)) out.set(k, { ...r, origin: "generated" });
  }
  const corpusFiles: string[] = [];
  walkFiles(join(REPO, "tests", "corpus"), corpusFiles);
  for (const f of corpusFiles) scrapeSource(readFileSync(f, "utf8"), f, out, "corpus");
  for (const [pattern, flags] of TARGETED) {
    const k = JSON.stringify([pattern, flags]);
    if (!out.has(k)) out.set(k, { pattern, flags, origin: "targeted" });
  }
  // The pattern fixtures of the regex unit tests, frozen when the
  // TypeScript pipeline's own tests (parser, assembler, char class,
  // escape, closure, disposition) were retired with it (unit E): the rows
  // the old scrape of test/wasm-regex-*.test.ts added, in its order.
  const fixtures = JSON.parse(readFileSync(join(HERE, "fixtures", "regex", "unit-test-patterns.json"), "utf8")) as [string, string][];
  for (const [pattern, flags] of fixtures) {
    const k = JSON.stringify([pattern, flags]);
    if (!out.has(k)) out.set(k, { pattern, flags, origin: "fixture" });
  }
  const bases = [...out.values()];
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  let made = 0;
  let guard = 0;
  while (made < mutations && guard < mutations * 20) {
    guard++;
    let p = pick(bases).pattern;
    const edits = 1 + Math.floor(rnd() * 3);
    for (let e = 0; e < edits; e++) {
      const op = Math.floor(rnd() * 5);
      const at = Math.floor(rnd() * (p.length + 1));
      if (op === 0) p = p.slice(0, at) + pick(ALPHABET) + p.slice(at);
      else if (op === 1 && p.length > 0) p = p.slice(0, Math.min(at, p.length - 1)) + p.slice(Math.min(at, p.length - 1) + 1);
      else if (op === 2 && p.length > 0) {
        const len = 1 + Math.floor(rnd() * Math.min(6, p.length));
        const from = Math.floor(rnd() * Math.max(1, p.length - len + 1));
        p = p.slice(0, at) + p.slice(from, from + len) + p.slice(at);
      } else if (op === 3 && p.length > 0) {
        const i = Math.min(at, p.length - 1);
        p = p.slice(0, i) + pick(ALPHABET) + p.slice(i + 1);
      } else p = p + pick(bases).pattern.slice(0, 1 + Math.floor(rnd() * 8));
    }
    const flags = rnd() < 0.5 ? pick(bases).flags : pick(FLAG_CHOICES);
    const k = JSON.stringify([p, flags]);
    if (out.has(k)) continue;
    out.set(k, { pattern: p, flags, origin: "mutation" });
    made++;
  }
  return [...out.values()];
}
