/* The inspect substrate against Node (inspect.ts): the quoting ladder, the
 * UTF-16 measures, formatPrimitive's string arm and formatProperty's key
 * arm. Two harnesses, because the two halves are reachable differently.
 *
 * `util.inspect` of a bare string lowers straight to the `insp.str`
 * libCall, so a tiny compiled program pins that whole surface
 * DIFFERENTIALLY — `node:util`'s own `inspect` is the oracle, called right
 * here in the test. One program carries many cases and the whole stdout is
 * compared at once, which keeps compilation out of the inner loop.
 *
 * `insp.key` and the indentation-dependent half of `insp.str` have no
 * reachable call site yet: keys come from the synthesized
 * index-signature-record helpers (still `record:index-signature` at the
 * emitter) and indentation only moves once the layout engine lands, both
 * of which are increment 16's later stages. Those are pinned by INVOKING
 * THE HELPERS DIRECTLY out of a purpose-built module, the wasm-numfmt
 * pattern — with Node still the oracle: a key's rendering is read out of
 * `inspect({ [k]: 0 })`, and a string at indentation 2 out of
 * `inspect({ s })`, whose property values Node formats at exactly that
 * level (measured).
 *
 * Widths are pinned BY VALUE, because what the backend implements is Node's
 * non-ICU tables applied PER CODE POINT, without NFC normalization and
 * without VT-sequence stripping — and Node does both of those in BOTH its
 * implementations (the non-ICU fallback at inspect.js:2695-2711 as much as
 * the ICU path this build takes), so there is no Node function to
 * differentially compare against. Measured over all 1,114,112 code points,
 * the tables and this build's answer differ on 11148 of them. Width feeds
 * only grid grouping, so the divergence becomes observable, and gets its
 * register entry, when the grid lands. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { Code } from "../src/backend/wasm/code.js";
import { InspectBuilder } from "../src/backend/wasm/inspect.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { buildF64ToStr } from "../src/backend/wasm/numfmt.js";

/* ── harness 1: the helpers, invoked directly ─────────────────────────── */

interface Helpers {
  str: (s: string) => string;
  key: (s: string) => string;
  width: (s: string) => number;
  setIndent: (n: number) => void;
}

async function buildHelpers(): Promise<Helpers> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  let f2s: number | null = null;
  const insp = new InspectBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    lit: (c, s) => {
      // pushStrLitInto's encoding: UTF-16LE units into the module blob.
      const units = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        const u = s.charCodeAt(i);
        units[i * 2] = u & 0xff;
        units[i * 2 + 1] = u >> 8;
      }
      c.i32Const(mb.internData(units));
      c.i32Const(s.length);
      c.arrayNewData(strType, 0);
    },
    f64ToStr: () => (f2s ??= buildF64ToStr(mb, strType, strRef)),
  });

  const simple = (name: string, params: ValType[], results: ValType[], body: (c: Code) => void): void => {
    const idx = mb.declareFunc(mb.funcType(params, results), name);
    const c = new Code();
    body(c);
    mb.setBody(idx, [], c.bytes());
    mb.exportFunc(name, idx);
  };
  simple("alloc", [I32], [strRef], (c) => {
    c.localGet(0);
    c.arrayNewDefault(strType);
  });
  simple("poke", [strRef, I32, I32], [], (c) => {
    c.localGet(0);
    c.localGet(1);
    c.localGet(2);
    c.arraySet(strType);
  });
  simple("len", [strRef], [I32], (c) => {
    c.localGet(0);
    c.arrayLen();
  });
  simple("at", [strRef, I32], [I32], (c) => {
    c.localGet(0);
    c.localGet(1);
    c.arrayGetU(strType);
  });
  simple("setIndent", [I32], [], (c) => {
    c.localGet(0);
    c.globalSet(insp.indentGlobal());
  });
  mb.exportFunc("str", insp.str());
  mb.exportFunc("key", insp.key());
  mb.exportFunc("width", insp.width());

  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as {
    alloc: (n: number) => unknown;
    poke: (r: unknown, i: number, u: number) => void;
    len: (r: unknown) => number;
    at: (r: unknown, i: number) => number;
    setIndent: (n: number) => void;
    str: (r: unknown) => unknown;
    key: (r: unknown) => unknown;
    width: (r: unknown) => number;
  };
  const into = (s: string): unknown => {
    const r = ex.alloc(s.length);
    for (let i = 0; i < s.length; i++) ex.poke(r, i, s.charCodeAt(i));
    return r;
  };
  const outOf = (r: unknown): string => {
    const n = ex.len(r);
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCharCode(ex.at(r, i));
    return out;
  };
  return {
    str: (s) => outOf(ex.str(into(s))),
    key: (s) => outOf(ex.key(into(s))),
    width: (s) => ex.width(into(s)),
    setIndent: (n) => ex.setIndent(n),
  };
}

/* ── harness 2: whole compiled programs ───────────────────────────────── */

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-inspect-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A TS source literal for an arbitrary string: printable ASCII verbatim,
 * everything else (including lone surrogates) as `\uXXXX`, so the source
 * file on disk stays well-formed UTF-8 whatever the case holds. */
function tsLit(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    out += u >= 0x20 && u <= 0x7e && u !== 0x22 && u !== 0x5c
      ? s[i]
      : `\\u${u.toString(16).padStart(4, "0")}`;
  }
  return out + '"';
}

async function runProgram(name: string, source: string): Promise<string> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, source);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const bin = readFileSync(res.binaryPath);
  expect(WebAssembly.validate(bin)).toBe(true);
  const chunks: Buffer[] = [];
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(bin, {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        if (fd !== 1) throw new Error("unexpected write to fd " + String(fd));
        chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
      now: () => 0,
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  return Buffer.concat(chunks).toString("utf8");
}

/** Compile one program that inspects every case and compare the whole
 * stdout against Node's. `spell` renders a case as TS source; the default
 * is a plain literal. */
async function pinCases(
  name: string,
  cases: readonly string[],
  spell: (s: string) => string = tsLit,
): Promise<void> {
  const source = [
    'import { inspect } from "node:util";',
    ...cases.map((s) => `console.log(inspect(${spell(s)}));`),
    "",
  ].join("\n");
  const got = await runProgram(name, source);
  const want = cases.map((s) => inspect(s) + "\n").join("");
  if (got !== want) {
    // Name the first offender: a 300-case diff is unreadable otherwise.
    const gotLines = got.split("\n");
    const wantLines = want.split("\n");
    for (let i = 0; i < Math.max(gotLines.length, wantLines.length); i++) {
      if (gotLines[i] !== wantLines[i]) {
        expect(gotLines[i], `first divergence at output line ${i}`).toBe(wantLines[i]);
      }
    }
  }
  expect(got).toBe(want);
}

/* ── the case lists ───────────────────────────────────────────────────── */

/** gen-inspect-cases.mjs's `str` op, the interesting entries, plus the
 * quote-ladder and escape branches each spelled out. */
const LADDER = [
  "",
  "a",
  "abc",
  "it's",
  'say "hi"',
  `it's "quoted"`,
  "a`b",
  "`tick`",
  "mix ' \" `",
  "dollar ${x} ' \"",
  "${only}",
  "$ { not adjacent ' \"",
  "has ' and \" quote",
  "has ' \" ` quote",
  "has ' \" ` and ${x}",
  "trailing $",
  "brace { alone ' \"",
] as const;

const ESCAPES = [
  "tab\there",
  "nl\nhere",
  "cr\rhere",
  "\x00\x01\x1f",
  "\x7f",
  "\x80\x9f",
  "\xa0",
  "backslash\\here",
  "\b\f\v",
  "\x0b\x0e\x0f\x1a\x1b",
  "all\x00\x01\x02\x03\x04\x05\x06\x07\b\t\n\v\f\r\x0e\x0f",
  "\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f",
  "unicode ✓ ok",
  "emoji \u{1f600} wide",
  "日本語テキスト",
  "combining é",
  "zero​width",
] as const;

const SURROGATES = [
  "\ud800",
  "\udfff",
  "\udc00",
  "\udbff",
  "a\ud800b",
  "\udfffend",
  "\u{1f600}",
  "\ud83d\ud83d", // two high halves: both lone
  "\ude00\ud83d", // low then high: both lone
  "😀\ud83d", // a pair then a lone high
  "𐀀", // the lowest astral pair
  "􏿿", // the highest astral pair
  "pair \u{10000} and lone \ud801 mixed",
  "\ud83d'\ude00", // a quote between the halves — neither pairs
] as const;

const SPLITTING = [
  "x".repeat(75),
  "x".repeat(76),
  "y".repeat(200),
  "line one\nline two\nline three",
  "a\n",
  "a\n\nb",
  "\n",
  "short\nlines\nhere",
  // the gate edges at indentation 0: split iff units > 16 AND units > 76
  "a\n" + "b".repeat(14), // 16 units, has \n
  "a\n" + "b".repeat(15), // 17 units, below 76
  "a\n" + "b".repeat(73), // 75
  "a\n" + "b".repeat(74), // 76 — still one line
  "a\n" + "b".repeat(75), // 77 — splits
  "a\n" + "b".repeat(76), // 78
  "c".repeat(90), // long, no newline: never splits
  "\n" + "b".repeat(80), // leading newline
  "a\n" + "b".repeat(80) + "\n", // trailing newline
  "a\n\n" + "b".repeat(80), // empty middle chunk
  "\n".repeat(80), // every chunk a bare newline
  // per-chunk quoting is independent
  "it's\n" + "b".repeat(80),
  "a\n" + "it's " + "b".repeat(80),
  "it's \"x\"\n" + "b".repeat(80),
  "a\n" + "\u{1f600}".repeat(60), // astral pairs across the split
  ("long line padding padding padding padding padding padding padding X\n").repeat(3),
] as const;

/** The >10000-unit cap. Spelled with `.repeat` rather than as a 10-kilobyte
 * source literal — and that keeps the strings RUNTIME values, so the cap
 * runs over a concatenation rather than an interned constant. */
const CAP: readonly { readonly src: string; readonly value: string }[] = [
  { src: '"z".repeat(9999)', value: "z".repeat(9999) },
  { src: '"z".repeat(10000)', value: "z".repeat(10000) },
  { src: '"z".repeat(10001)', value: "z".repeat(10001) }, // "1 more character"
  { src: '"z".repeat(10002)', value: "z".repeat(10002) }, // "2 more characters"
  { src: '"z".repeat(11000)', value: "z".repeat(11000) },
  // unit 10000 splits an astral pair: the kept high half escapes as \ud83d
  { src: '"a".repeat(9999) + "\\ud83d\\ude00" + "bcd"', value: "a".repeat(9999) + "\u{1f600}" + "bcd" },
  // ... and the same cut with exactly one unit left over
  { src: '"a".repeat(9999) + "\\ud83d\\ude00"', value: "a".repeat(9999) + "\u{1f600}" },
  // the pair starts exactly AT the cap, so nothing is split
  { src: '"a".repeat(10000) + "\\ud83d\\ude00"', value: "a".repeat(10000) + "\u{1f600}" },
  // truncation interacts with splitting: 101 lines cut back to 100
  { src: '("x".repeat(99) + "\\n").repeat(101)', value: ("x".repeat(99) + "\n").repeat(101) },
  // the cut lands exactly on a newline
  { src: '"y".repeat(9999) + "\\n" + "z".repeat(50)', value: "y".repeat(9999) + "\n" + "z".repeat(50) },
  { src: '"w".repeat(5000) + "\\n" + "w".repeat(6000)', value: "w".repeat(5000) + "\n" + "w".repeat(6000) },
];

/** Seeded strings mixing every feature above, at lengths that straddle the
 * 16- and 76-unit gates. */
function fuzzCases(count: number): string[] {
  let seed = 0x1234_5678;
  const rnd = (): number => {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0x1_0000_0000;
  };
  const pieces = [
    "a", "b", "z", " ", "0", "_", "-",
    "'", '"', "`", "${", "}", "$", "\\",
    "\n", "\t", "\r", "\v", "\b", "\f",
    "\x00", "\x01", "\x1f", "\x7f", "\x85", "\x9f", "\xa0",
    "✓", "日", "​", "́", "　",
    "\u{1f600}", "\u{10000}", "\u{3fffd}",
    "\ud800", "\udfff", "\udbff", "\udc00",
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    // Lengths cluster around the gates: 0-20 and 60-100.
    const target = rnd() < 0.4 ? Math.floor(rnd() * 21) : 55 + Math.floor(rnd() * 50);
    let s = "";
    while (s.length < target) s += pieces[Math.floor(rnd() * pieces.length)]!;
    out.push(s);
  }
  return out;
}

/* ── insp.str, differentially, through compiled programs ──────────────── */

describe("insp.str vs util.inspect", () => {
  test("the quoting ladder", async () => {
    await pinCases("ladder", LADDER);
  });

  test("C0, DEL, C1 and backslash escapes", async () => {
    await pinCases("escapes", ESCAPES);
  });

  test("lone surrogates and astral pairs", async () => {
    await pinCases("surrogates", SURROGATES);
  });

  test("the ` +` continuation form and its gate edges", async () => {
    await pinCases("splitting", SPLITTING);
  });

  test("the 10000-unit cap, its trailer, and the split pair", async () => {
    const source = [
      'import { inspect } from "node:util";',
      ...CAP.map((c) => `console.log(inspect(${c.src}));`),
      "",
    ].join("\n");
    const got = await runProgram("cap", source);
    const want = CAP.map((c) => inspect(c.value) + "\n").join("");
    // Report the first differing case rather than dumping 100KB.
    const gotParts = got.split("\n");
    const wantParts = want.split("\n");
    for (let i = 0; i < Math.max(gotParts.length, wantParts.length); i++) {
      if (gotParts[i] !== wantParts[i]) {
        const g = gotParts[i] ?? "";
        const w = wantParts[i] ?? "";
        expect(
          `len ${g.length} …${g.slice(-60)}`,
          `first divergence at output line ${i}`,
        ).toBe(`len ${w.length} …${w.slice(-60)}`);
      }
    }
    expect(got).toBe(want);
  });

  test("300 seeded strings mixing every feature", async () => {
    await pinCases("fuzz", fuzzCases(300));
  });
});

/* ── the helpers, invoked directly ────────────────────────────────────── */

describe("insp.str at a nonzero indentation", () => {
  // Node formats a property's value at indentationLvl 2 and a
  // twice-nested one at 4 (measured), so `inspect({ s })` and
  // `inspect({ o: { s } })` are the oracles for indentation 2 and 4.
  const unwrap1 = (s: string): string => {
    const out = inspect({ s });
    const head = "{\n  s: ";
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith("\n}")).toBe(true);
    return out.slice(head.length, -2);
  };
  const unwrap2 = (s: string): string => {
    const out = inspect({ o: { s } });
    const head = "{\n  o: {\n    s: ";
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith("\n  }\n}")).toBe(true);
    return out.slice(head.length, -"\n  }\n}".length);
  };

  test("the gate moves with the indentation and so does the continuation indent", async () => {
    const h = await buildHelpers();
    // At indentation 2 the gate is 80 - 2 - 4 = 74 units.
    const at2 = ["a\n" + "b".repeat(71), "a\n" + "b".repeat(72), "a\n" + "b".repeat(73), "a\n" + "b".repeat(74)];
    h.setIndent(2);
    for (const s of at2) expect(h.str(s), `indent 2, ${s.length} units`).toBe(unwrap1(s));
    // At indentation 4 it is 72, and continuation lines get 6 spaces.
    const at4 = ["a\n" + "b".repeat(69), "a\n" + "b".repeat(70), "a\n" + "b".repeat(71), "a\n" + "b".repeat(72)];
    h.setIndent(4);
    for (const s of at4) expect(h.str(s), `indent 4, ${s.length} units`).toBe(unwrap2(s));
    // Back to 0: the helper READS the global, it does not cache it.
    h.setIndent(0);
    expect(h.str("a\n" + "b".repeat(74))).toBe(inspect("a\n" + "b".repeat(74)));
    expect(h.str("a\n" + "b".repeat(75))).toBe(inspect("a\n" + "b".repeat(75)));
  });

  test("the 16-unit floor holds however deep the indentation", async () => {
    const h = await buildHelpers();
    // 80 - 60 - 4 = 16, so only the kMinLineLength floor can refuse here.
    h.setIndent(60);
    expect(h.str("a\nbcdefghijklmno")).toBe("'a\\nbcdefghijklmno'"); // exactly 16
    expect(h.str("a\nbcdefghijklmnop")).toBe("'a\\n' +\n" + " ".repeat(62) + "'bcdefghijklmnop'"); // 17
    // Past 76 the bound goes NEGATIVE, and Node's JS arithmetic still
    // says "split" where C's size_t would wrap and say "don't".
    h.setIndent(80);
    expect(h.str("a\nbcdefghijklmnop")).toBe("'a\\n' +\n" + " ".repeat(82) + "'bcdefghijklmnop'");
    h.setIndent(0);
  });
});

describe("insp.key", () => {
  /** Node's own rendering of `k` as a property name, read back out of
   * `inspect({ [k]: 0 })` — which lands on one line for a short key and
   * breaks for a long one, so both wrappers are peeled. `null` means the
   * rendering was neither shape and the case is not usable as an oracle. */
  const oracle = (k: string): string | null => {
    const out = inspect({ [k]: 0 });
    if (out.startsWith("{ ") && out.endsWith(": 0 }")) return out.slice(2, -": 0 }".length);
    if (out.startsWith("{\n  ") && out.endsWith(": 0\n}")) return out.slice(4, -": 0\n}".length);
    return null;
  };

  const KEYS = [
    "a", "abc", "_", "_b", "A", "Z9", "a0", "camelCase", "_0", "z".repeat(40),
    "", "0", "1", "9x", "$", "$c", "a-b", "a b", "a.b", "it's", 'q"q', "`t`",
    "Ω", "日本", "\u{1f600}", "\ud800", "with\nnewline", "\x00",
    "tab\there", "back\\slash", "${x}", "a'b\"c`d",
  ];

  test("bare identifiers stay bare, everything else quotes", async () => {
    const h = await buildHelpers();
    for (const k of KEYS) {
      expect(h.key(k), `key ${JSON.stringify(k)}`).toBe(oracle(k));
    }
  });

  test("__proto__ is the computed-key exception", async () => {
    const h = await buildHelpers();
    expect(h.key("__proto__")).toBe("['__proto__']");
    // Node agrees, and only for the exact nine units.
    expect(inspect({ ["__proto__"]: 0 })).toBe("{ ['__proto__']: 0 }");
    expect(h.key("__proto___")).toBe("__proto___");
    expect(h.key("_proto__")).toBe("_proto__");
    expect(h.key("__protoo_")).toBe("__protoo_");
    expect(h.key("__PROTO__")).toBe("__PROTO__");
  });

  test("a key is quoted with the same ladder a value gets", async () => {
    const h = await buildHelpers();
    for (const k of ["it's", 'has \' and " quote', "has ' \" ` quote", "has ' \" ` and ${x}"]) {
      // inspect(k) quotes the same text as a VALUE — the key rendering of
      // a non-bare name is exactly that.
      expect(h.key(k), `key ${JSON.stringify(k)}`).toBe(inspect(k));
    }
  });

  test("seeded keys against Node", async () => {
    const h = await buildHelpers();
    let checked = 0;
    for (const k of fuzzCases(150)) {
      const want = oracle(k);
      if (want === null) continue;
      expect(h.key(k), `key ${JSON.stringify(k)}`).toBe(want);
      checked++;
    }
    // The oracle has to be usable for most of them, or this pins nothing.
    expect(checked).toBeGreaterThan(100);
  });
});

describe("insp_width (the non-ICU tables, pinned by value)", () => {
  /* Hand-checked against Node's isFullWidthCodePoint/isZeroWidthCodePoint
   * fallback tables — NOT against this Node's getStringWidth, which is the
   * ICU one (see the file header). The entries whose reason says "ICU says
   * N" are code points where the two provably disagree (measured); they
   * are here on purpose, to pin which side this tier implements. */
  const CASES: readonly [string, number, string][] = [
    ["", 0, "empty"],
    ["a", 1, "ascii"],
    ["ab\u4e2d", 4, "ascii then a CJK ideograph"],
    ["\u0000", 0, "NUL is zero-width"],
    ["\u001f", 0, "the C0 range's top"],
    [" ", 1, "space"],
    ["~", 1, "tilde"],
    ["\u007f", 0, "DEL"],
    ["\u0080", 0, "the C1 floor"],
    ["\u009f", 0, "the C1 top"],
    ["\u00a0", 1, "nbsp is NOT zero-width here"],
    ["\u02ff", 1, "just below the combining block"],
    ["\u0300", 0, "combining grave"],
    ["\u036f", 0, "the combining block's top"],
    ["\u0370", 1, "just past it"],
    ["\u200a", 1, "just below the format block"],
    ["\u200b", 0, "zero-width space"],
    ["\u200f", 0, "RLM, the block's top"],
    ["\u2010", 1, "just past it"],
    ["\u20cf", 1, "just below the symbol marks"],
    ["\u20d0", 0, "combining mark for symbols"],
    ["\u20ff", 0, "the range's top: unassigned, and ICU says 1"],
    ["\ufe00", 0, "variation selector 1"],
    ["\ufe0f", 0, "variation selector 16"],
    ["\ufe20", 0, "a half mark"],
    ["\ufe2f", 0, "the half marks' top"],
    ["\u10ff", 1, "just below the full-width floor"],
    ["\u1100", 2, "Hangul jamo, the floor itself"],
    ["\u115f", 2, "the jamo range's top"],
    ["\u1160", 1, "just past it"],
    ["\u2328", 1, "just below the bracket pair"],
    ["\u2329", 2, "left-pointing angle bracket"],
    ["\u232a", 2, "right-pointing angle bracket"],
    ["\u232b", 1, "just past it"],
    ["\u2e7f", 1, "just below the CJK radicals"],
    ["\u2e80", 2, "CJK radicals"],
    ["\u303e", 2, "just below the exception"],
    ["\u303f", 1, "the ideographic half-fill space, excepted by name"],
    ["\u3040", 2, "unassigned Hiragana, inside the range; ICU says 1"],
    ["\u3247", 2, "the range's top"],
    ["\u3248", 1, "the gap between 0x3247 and 0x3250"],
    ["\u324f", 1, "the gap's far end"],
    ["\u3250", 2, "the gap's far side"],
    ["\u4dbf", 2, "the hexagram block's end"],
    ["\u4dc0", 1, "the 0x4dc0-0x4dff hole; ICU says 2"],
    ["\u4e00", 2, "CJK unified ideographs"],
    ["\ua4c6", 2, "the block's top"],
    ["\ua4c7", 1, "just past it"],
    ["\ua95f", 1, "just below Hangul jamo extended-A"],
    ["\ua960", 2, "Hangul jamo extended-A"],
    ["\ua97c", 2, "its top"],
    ["\ua97d", 1, "just past it"],
    ["\uac00", 2, "Hangul syllables"],
    ["\ud7a3", 2, "the syllables' top"],
    ["\ud7a4", 1, "just past it"],
    ["\uf900", 2, "CJK compatibility ideographs"],
    ["\ufaff", 2, "the block's top"],
    ["\ufb00", 1, "just past it"],
    ["\ufe10", 2, "vertical forms"],
    ["\ufe19", 2, "the vertical forms' top"],
    ["\ufe1a", 1, "just past them"],
    ["\ufe30", 2, "CJK compatibility forms"],
    ["\ufe6b", 2, "their top"],
    ["\ufe6c", 1, "just past them"],
    ["\uff00", 1, "just below the fullwidth forms"],
    ["\uff01", 2, "fullwidth exclamation"],
    ["\uff60", 2, "the fullwidth forms' top"],
    ["\uff61", 1, "halfwidth ideographic full stop"],
    ["\uffe0", 2, "fullwidth cent sign"],
    ["\uffe6", 2, "fullwidth won sign"],
    ["\uffe7", 1, "just past it"],
    ["\ud800", 1, "a lone HIGH surrogate measures as itself"],
    ["\udfff", 1, "a lone LOW surrogate too"],
    ["\ud83d\ud83d", 2, "two lone high halves are two code points"],
    ["\ud83d\ude00", 2, "the same two units PAIRED are one wide emoji"],
    ["\ud82c\udc00", 2, "Kana supplement"],
    ["\ud82c\udc01", 2, "its top"],
    ["\ud82c\udc02", 1, "just past it; ICU says 2"],
    ["\ud83c\uddff", 1, "just below the enclosed ideographic supplement"],
    ["\ud83c\ude00", 2, "enclosed ideographic supplement"],
    ["\ud83c\ude51", 2, "its top"],
    ["\ud83c\ude52", 1, "just past it"],
    ["\ud83c\udf00", 2, "the emoji range's floor"],
    ["\ud83d\ude00", 2, "a grinning face"],
    ["\ud83d\ude4f", 2, "the emoji range's top"],
    ["\ud83d\ude50", 1, "just past it"],
    ["\ud83f\udfff", 1, "just below CJK extension B"],
    ["\ud840\udc00", 2, "CJK extension B, an astral PAIR"],
    ["\ud8bf\udffd", 2, "the astral range's top"],
    ["\ud8bf\udffe", 1, "just past it"],
    ["\udb40\udcff", 1, "just below the astral variation selectors"],
    ["\udb40\udd00", 0, "an astral variation selector is zero-width"],
    ["\udb40\uddef", 0, "its top"],
    ["\udb40\uddf0", 1, "just past it"],
    ["\udbff\udfff", 1, "the last code point"],
    ["\u4e2d\u6587abc", 7, "two wide plus three narrow"],
    ["e\u0301", 1, "a base letter plus a zero-width combining mark"],
    ["\ud83d\ude00\ud83d\ude00", 4, "two astral pairs"],
    ["\u1100\u0300a", 3, "wide, zero, narrow in one string"],
  ];

  test("code point widths", async () => {
    const h = await buildHelpers();
    for (const [s, want, why] of CASES) {
      expect(h.width(s), `${why} — ${JSON.stringify(s)}`).toBe(want);
    }
  });

  test("width is additive over code points", async () => {
    const h = await buildHelpers();
    const parts = ["a", "\u4e2d", "\u0301", "\ud83d\ude00", "\ud800", " ", "\u200b", "\u1100", "\u007f"];
    let total = 0;
    for (const p of parts) total += h.width(p);
    expect(h.width(parts.join(""))).toBe(total);
  });
});

describe("the append buffer", () => {
  test("regions nest and the buffer is reused across renders", async () => {
    const h = await buildHelpers();
    // Every call opens a region at the current length and takes it back
    // down, so a long render followed by short ones must not leak units
    // from the previous one.
    expect(h.str("z".repeat(11000)).endsWith("... 1000 more characters")).toBe(true);
    expect(h.str("a")).toBe("'a'");
    expect(h.key("k")).toBe("k");
    expect(h.str("")).toBe("''");
  });

  test("an oversized backing array is dropped and the next render reallocates", async () => {
    const h = await buildHelpers();
    // The drop in ibTake needs the BUFFER past 2^16 units, which a long
    // input alone cannot do — the 10000-unit cap truncates first, so even
    // a 70000-unit string only ever fills ~10030. The continuation form is
    // what grows it: 10000 bare newlines survive the cap exactly, and each
    // chunk past the first costs `'\n'` (4) + " +\n" (3) + two indent
    // spaces = 9 units, so the region reaches 4 + 9999*9 = 89995 units.
    // The asserted length below IS the evidence the drop fired: the whole
    // region has to be in the buffer before ibTake copies it out, so the
    // backing array held at least 89995 > 2^16 units at a mark of 0.
    const many = "\n".repeat(10000);
    const rendered = h.str(many);
    expect(rendered).toBe(inspect(many));
    expect(rendered.length).toBe(89_995);
    // So the next renders come off a NULL buffer, exercising the
    // first-fill path in ibEnsure rather than the reuse path.
    expect(h.str("a")).toBe("'a'");
    expect(h.key("k")).toBe("k");
    expect(h.str("z".repeat(11000))).toBe(inspect("z".repeat(11000)));
  });
});
