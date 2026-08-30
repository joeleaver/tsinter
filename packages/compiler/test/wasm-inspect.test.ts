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
 * non-ICU tables applied PER CODE POINT, WITHOUT NFC normalization — which
 * Node applies unconditionally in both of its implementations, so there is
 * no Node function that computes what this does and nothing to compare
 * against differentially. Measured over all 1,114,112 code points, the
 * tables and this build's answer differ on 11148. VT-sequence stripping is
 * NOT part of that: `getStringWidth` takes the flag and the grid passes
 * `ctx.colors`, false here, so Node does not strip either. Width feeds only
 * grid grouping, which SEMANTICS.md S028 covers — and the two grid tests
 * below pin both sides of it, the exotic case diverging and the ASCII case
 * agreeing exactly. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
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
  /** insp.error over an errT built here: `code` null means no code slot. */
  error: (name: string, message: string, code: string | null, recurse: number, depth: number) => string;
}

async function buildHelpers(): Promise<Helpers> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  // The exception struct's SHAPE, not the emitter's instance of it: slot 0
  // is opaque to inspect.ts (the emitter puts a class-info ref there), and
  // 1/2/3 are name/message/code. Declaring it here is what lets the error
  // rendering be pinned at all — the only stamped-`code` errors the tier
  // can currently produce come from deferred JS fences.
  const errT = mb.structType([
    { storage: I32, mutable: false },
    { storage: strRef, mutable: true },
    { storage: strRef, mutable: true },
    { storage: strRef, mutable: false },
  ]);
  const errRef: ValType = { kind: "ref", nullable: true, typeIndex: errT };
  let f2s: number | null = null;
  const insp = new InspectBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    errT: () => errT,
    errName: () => 1,
    errMessage: () => 2,
    errCode: () => 3,
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
    // Stage C's dyn walker needs the whole dyn representation, which needs
    // the emitter's vector machinery — far past what this harness builds.
    // The four deps are only READ while `insp.dyn`/`insp.dynS` are emitted,
    // and this module exports neither, so throwing is the honest stub: the
    // dyn walker is pinned through COMPILED PROGRAMS below (JSON.parse is
    // the tier's dyn producer, so `inspect(JSON.parse(s))` reaches it
    // differentially with Node as the oracle).
    dyn: () => {
      throw new Error("harness 1 does not build the dyn representation");
    },
    inspF64: () => {
      throw new Error("harness 1 does not build inspF64");
    },
    throwError: () => {
      throw new Error("harness 1 has no exception cell");
    },
    excKind: () => {
      throw new Error("harness 1 has no exception cell");
    },
    strCmpU16: () => {
      throw new Error("harness 1 does not build the composite renderer's entry sort");
    },
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
  simple("mkerr", [strRef, strRef, strRef], [errRef], (c) => {
    c.i32Const(0);
    c.localGet(0);
    c.localGet(1);
    c.localGet(2);
    c.structNew(errT);
  });
  simple("mkerrBare", [strRef, strRef], [errRef], (c) => {
    c.i32Const(0);
    c.localGet(0);
    c.localGet(1);
    c.refNull(strType);
    c.structNew(errT);
  });
  mb.exportFunc("str", insp.str());
  mb.exportFunc("key", insp.key());
  mb.exportFunc("width", insp.width());
  mb.exportFunc("error", insp.error());

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
    error: (e: unknown, recurse: number, depth: number) => unknown;
    mkerr: (n: unknown, m: unknown, c: unknown) => unknown;
    mkerrBare: (n: unknown, m: unknown) => unknown;
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
    error: (name, message, code, recurse, depth) =>
      outOf(
        ex.error(
          code === null ? ex.mkerrBare(into(name), into(message)) : ex.mkerr(into(name), into(message), into(code)),
          recurse,
          depth,
        ),
      ),
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

/** Compile one program that inspects each TS EXPRESSION and compare the
 * whole stdout against Node's rendering of the paired JS value. The layout
 * engine's cases have to be spelled this way — a composite's rendering
 * depends on its static type, so the source expression is the input and the
 * JS twin is only the oracle. */
async function pinValues(name: string, cases: readonly (readonly [string, unknown])[]): Promise<void> {
  const source = [
    'import { inspect } from "node:util";',
    ...cases.map(([src]) => `console.log(inspect(${src}));`),
    "",
  ].join("\n");
  const got = await runProgram(name, source);
  const want = cases.map(([, v]) => inspect(v) + "\n").join("");
  if (got !== want) {
    const g = got.split("\n");
    const w = want.split("\n");
    for (let i = 0; i < Math.max(g.length, w.length); i++) {
      if (g[i] !== w[i]) {
        expect(
          `${g[i] ?? "(missing)"}\n  …after ${JSON.stringify(g.slice(Math.max(0, i - 2), i))}`,
          `first divergence at output line ${i}`,
        ).toBe(`${w[i] ?? "(missing)"}\n  …after ${JSON.stringify(w.slice(Math.max(0, i - 2), i))}`);
      }
    }
  }
  expect(got).toBe(want);
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

/* ── the layout engine (stage B) ──────────────────────────────────────── */

const nums = (n: number, f: (i: number) => number = (i) => i): number[] =>
  Array.from({ length: n }, (_, i) => f(i));
const list = (v: readonly unknown[]): string => `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;

describe("reduceToSingleString", () => {
  test("the single-line and one-per-line forms, and the break edges", async () => {
    await pinValues("layout-basic", [
      ["[]", []],
      ["[1, 2, 3]", [1, 2, 3]],
      ["[1, 2, 3, 4, 5, 6]", [1, 2, 3, 4, 5, 6]],
      ['({ a: 1 })', { a: 1 }],
      ['({ a: 1, b: "two", c: true })', { a: 1, b: "two", c: true }],
      ['({ "a-b": 1, ok_1: 2 })', { "a-b": 1, ok_1: 2 }],
      // The 80-column edge, one character at a time.
      [`({ key: "${"v".repeat(60)}" })`, { key: "v".repeat(60) }],
      [`({ key: "${"v".repeat(61)}" })`, { key: "v".repeat(61) }],
      [`({ key: "${"v".repeat(62)}" })`, { key: "v".repeat(62) }],
      [`({ key: "${"v".repeat(63)}" })`, { key: "v".repeat(63) }],
      [
        "({ aaaa: 1, bbbb: 2, cccc: 3, dddd: 4, eeee: 5, ffff: 6, gggg: 7, hhhh: 8 })",
        { aaaa: 1, bbbb: 2, cccc: 3, dddd: 4, eeee: 5, ffff: 6, gggg: 7, hhhh: 8 },
      ],
      // An entry containing a newline forbids the single-line form however
      // short the join is.
      [`({ s: "${"x".repeat(75)}\\ny" })`, { s: "x".repeat(75) + "\ny" }],
      [`([${JSON.stringify("a\nb")}])`, ["a\nb"]],
      // Entries long enough to break one per line.
      [
        list(Array.from({ length: 12 }, () => "0123456789012345678901234567890123456789")),
        Array.from({ length: 12 }, () => "0123456789012345678901234567890123456789"),
      ],
    ]);
  });

  test("the compact window: currentDepth - recurseTimes < 3", async () => {
    await pinValues("layout-compact", [
      ["({ a: { b: { c: { d: 1 } } } })", { a: { b: { c: { d: 1 } } } }],
      ["({ a: { b: { c: {} } } })", { a: { b: { c: {} } } }],
      ["({ a: { b: { c: [1, 2] } } })", { a: { b: { c: [1, 2] } } }],
      ["({ a: [[1, [2, [3, [4]]]]] })", { a: [[1, [2, [3, [4]]]]] }],
      [
        "({ deep: { deeper: { deepest: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } } })",
        { deep: { deeper: { deepest: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } } },
      ],
      [
        '({ nested: { one: "aaaaaaaaaaaaaaaaaaaa", two: "bbbbbbbbbbbbbbbbbbbb", three: "cccccccccccccccccccc" } })',
        { nested: { one: "aaaaaaaaaaaaaaaaaaaa", two: "bbbbbbbbbbbbbbbbbbbb", three: "cccccccccccccccccccc" } },
      ],
      // Depth placeholders: the budget is 2, so the fourth level is [Object].
      ["({ a: { b: { c: { d: { e: 1 } } } } })", { a: { b: { c: { d: { e: 1 } } } } }],
      ["[[[[1]]]]", [[[[1]]]]],
      ["[{ a: 1 }, { b: 2 }, { c: 3 }]", [{ a: 1 }, { b: 2 }, { c: 3 }]],
      [
        `[${nums(9).map((i) => `{ id: ${i} }`).join(", ")}]`,
        nums(9).map((i) => ({ id: i })),
      ],
    ]);
  });
});

describe("groupArrayElements", () => {
  test("the grid: column math, padStart for numbers, padEnd otherwise", async () => {
    await pinValues("layout-grid", [
      // Seven entries is the floor for grouping to be attempted at all.
      ["[1, 2, 3, 4, 5, 6, 7]", [1, 2, 3, 4, 5, 6, 7]],
      [list(nums(26)), nums(26)],
      [list(nums(30, (i) => i * 1000)), nums(30, (i) => i * 1000)],
      [list(nums(100)), nums(100)],
      // Wide numeric entries: fewer columns.
      [list(nums(40, (i) => i * 1e12)), nums(40, (i) => i * 1e12)],
      // Strings pad END, numbers pad START — the all_num flag.
      [list(nums(30).map((i) => `str-${i}`)), nums(30).map((i) => `str-${i}`)],
      [list(nums(20).map((i) => `${i}`)), nums(20).map((i) => `${i}`)],
      // A mixed array clears all_num on the first non-number.
      [
        `[${nums(8).map((i) => (i % 2 ? String(i) : `"s${i}"`)).join(", ")}]`,
        nums(8).map((i) => (i % 2 ? i : `s${i}`)),
      ],
      // Entries of very different length must NOT group (the 1/5 gate).
      [
        `[1, 2, 3, 4, 5, 6, 7, "${"z".repeat(70)}"]`,
        [1, 2, 3, 4, 5, 6, 7, "z".repeat(70)],
      ],
      // maxLength <= 6 is the other half of that gate.
      [list(nums(12).map((i) => `ab${i}`)), nums(12).map((i) => `ab${i}`)],
    ]);
  });

  test("a length sweep pins the column count across every transition", async () => {
    // The column formula is round(sqrt(2.5 * biasedMax * n) / biasedMax)
    // clamped three ways, so its output steps as `n` grows. Sweeping every
    // length from the grouping floor up through 40 crosses those steps
    // repeatedly — a single hand-picked array can sit in the middle of a
    // step and miss a wrong constant entirely.
    const cases: [string, unknown][] = [];
    for (let n = 7; n <= 40; n++) {
      cases.push([list(nums(n)), nums(n)]);
    }
    await pinValues("layout-grid-sweep", cases);
  });

  test("a width sweep pins it for wider entries too", async () => {
    // Same sweep at three entry widths: 2-digit, 5-digit and 9-digit
    // numbers give different actualMax, hence different column counts and
    // different clamps (the breakLength one starts to bind).
    const cases: [string, unknown][] = [];
    for (let n = 7; n <= 26; n++) {
      cases.push([list(nums(n, (i) => i * 11)), nums(n, (i) => i * 11)]);
      cases.push([list(nums(n, (i) => i * 11111)), nums(n, (i) => i * 11111)]);
      cases.push([list(nums(n, (i) => i * 111111111)), nums(n, (i) => i * 111111111)]);
    }
    await pinValues("layout-width-sweep", cases);
  });

  test("the more-items tail is excluded from the grid", async () => {
    await pinValues("layout-more", [
      [list(nums(101)), nums(101)],
      [list(nums(102)), nums(102)],
      [list(nums(120)), nums(120)],
      [list(nums(250, (i) => i * 1000)), nums(250, (i) => i * 1000)],
      // The tail's own numberness decides the pad order: element 100 here
      // is a string, so the whole grid pads END (Node checks value[100]).
      [
        `[${[...nums(100), '"tail"'].map(String).join(", ")}, "x"]`,
        [...nums(100), "tail", "x"],
      ],
      // averageBias divides totalLength by the FULL entry count (the tail
      // INCLUDED) while the column estimate uses the grid's count. The
      // asymmetry only bites when a tail exists AND biasedMax does not clamp
      // to 1 — every other more-items case above has entries short enough to
      // clamp, which hides it. Here the first 100 entries are exactly three
      // characters: correct code gives 12 columns, dividing by the grid count
      // instead gives 11.
      [list(nums(101, (i) => 100 + i)), nums(101, (i) => 100 + i)],
    ]);
  });

  test("the column formula's rounding is half-UP, not half-to-even", async () => {
    // Ten entries of exactly five characters put the column estimate on an
    // exact .5 boundary: sqrt(2.5 * 4 * 10) / 4 = 2.5. Math.round gives 3;
    // wasm's f64.nearest — the tempting single instruction — gives 2, because
    // it breaks ties to even. Node lays this out three columns wide, so the
    // floor(x + 0.5) transcription is what is being pinned.
    await pinValues("layout-tie", [
      [list(nums(10, (i) => 10000 + i)), nums(10, (i) => 10000 + i)],
      // A second tie at a different width, for the same reason.
      [list(nums(10).map((i) => `abc${i}`)), nums(10).map((i) => `abc${i}`)],
    ]);
  });

  test("SEMANTICS.md S028: a grid of exotic entries diverges, ASCII does not", async () => {
    // The one place the width tables become observable. U+0483 (COMBINING
    // CYRILLIC TITLO) is width 0 to an ICU Node and width 1 to the ported
    // non-ICU tables, so a grid of ten digit-plus-titlo entries sizes its
    // columns differently: Node fits four per row, this tier three.
    //
    // Our output is pinned LITERALLY here — it is the one case in this file
    // that must NOT match `util.inspect`, and the assertion that it differs
    // is what keeps the register entry honest if a future change silently
    // converges (or diverges further).
    const titlo = Array.from({ length: 10 }, (_, i) => `${i}҃`);
    const source = [
      'import { inspect } from "node:util";',
      `console.log(inspect([${titlo.map(tsLit).join(", ")}]));`,
      "",
    ].join("\n");
    const got = await runProgram("grid-s028", source);
    expect(got).toBe(
      "[\n" +
        "  '0҃', '1҃', '2҃',\n" +
        "  '3҃', '4҃', '5҃',\n" +
        "  '6҃', '7҃', '8҃',\n" +
        "  '9҃'\n" +
        "]\n",
    );
    // Node's answer for the same value, four columns wide.
    expect(inspect(titlo)).toBe(
      "[\n" +
        "  '0҃', '1҃', '2҃', '3҃',\n" +
        "  '4҃', '5҃', '6҃', '7҃',\n" +
        "  '8҃', '9҃'\n" +
        "]",
    );
    expect(got.trimEnd()).not.toBe(inspect(titlo));
  });

  test("SEMANTICS.md S028: pure-ASCII grids agree with Node exactly", async () => {
    // The other half of the entry's claim — the divergence needs exotic
    // code points, so ASCII grids at the same shapes are byte-identical.
    const cases: [string, unknown][] = [];
    for (const n of [8, 10, 12, 16, 20, 26]) {
      cases.push([list(nums(n).map((i) => `a${i}`)), nums(n).map((i) => `a${i}`)]);
    }
    await pinValues("grid-ascii", cases);
  });

  test("width, not length, sizes the columns", async () => {
    // Full-width CJK entries are two columns each, so a grid of them fits
    // fewer per row than their .length would suggest.
    await pinValues("layout-width", [
      [list(nums(12).map((i) => `日本${i}`)), nums(12).map((i) => `日本${i}`)],
      [list(nums(9).map(() => "0123456789".repeat(3))), nums(9).map(() => "0123456789".repeat(3))],
      [list(nums(20).map((i) => (i % 3 ? "✓" : "x").repeat((i % 5) + 1))),
       nums(20).map((i) => (i % 3 ? "✓" : "x").repeat((i % 5) + 1))],
    ]);
  });
});

describe("circular references", () => {
  test("<ref *N> and [Circular *N], numbered in discovery order", async () => {
    const source = [
      'import { inspect } from "node:util";',
      "interface N { name: string; next: N | null }",
      'const a: N = { name: "a", next: null };',
      "a.next = a;",
      "console.log(inspect(a));",
      'const b: N = { name: "b", next: null };',
      'const c: N = { name: "c", next: b };',
      "b.next = c;",
      "console.log(inspect(b));",
      "interface P { l: N | null; r: N | null }",
      "console.log(inspect({ l: a, r: b } as P));",
      'const d: N = { name: "d", next: { name: "e", next: null } };',
      "console.log(inspect(d));",
      // The same value twice is NOT circular — it is not on the path.
      "console.log(inspect({ l: d, r: d } as P));",
      "",
    ].join("\n");
    const got = await runProgram("circular", source);

    // The JS twins, built the same way.
    type JN = { name: string; next: JN | null };
    const ja: JN = { name: "a", next: null };
    ja.next = ja;
    const jb: JN = { name: "b", next: null };
    const jc: JN = { name: "c", next: jb };
    jb.next = jc;
    const jd: JN = { name: "d", next: { name: "e", next: null } };
    // Each console.log is a FRESH top-level inspect, which is what resets
    // the circular numbering — so the oracle calls inspect separately too.
    const want =
      inspect(ja) + "\n" +
      inspect(jb) + "\n" +
      inspect({ l: ja, r: jb }) + "\n" +
      inspect(jd) + "\n" +
      inspect({ l: jd, r: jd }) + "\n";
    expect(got).toBe(want);
    // Spot-check the shapes so a change in both sides at once still fails.
    expect(got).toContain("<ref *1> { name: 'a', next: [Circular *1] }");
    expect(got).toContain("r: <ref *2> { name: 'b', next: { name: 'c', next: [Circular *2] } }");
  });

  test("the numbering resets per top-level value", async () => {
    // Two renders in one program: the second must start at *1 again, which
    // is begin(1)'s reset. A leak would number it *2.
    const source = [
      'import { inspect } from "node:util";',
      "interface N { name: string; next: N | null }",
      'const a: N = { name: "a", next: null };',
      "a.next = a;",
      "console.log(inspect(a));",
      "console.log(inspect(a));",
      "",
    ].join("\n");
    const got = await runProgram("circular-reset", source);
    const line = "<ref *1> { name: 'a', next: [Circular *1] }";
    expect(got).toBe(line + "\n" + line + "\n");
  });
});

describe("errors (SEMANTICS.md S027)", () => {
  test("the stackless bracket form, the code property, and the depth gate", async () => {
    const source = [
      'import { inspect } from "node:util";',
      'console.log(inspect(new Error("boom")));',
      "console.log(inspect(new Error()));",
      'console.log(inspect(new TypeError("bad")));',
      'console.log(inspect(new RangeError("out")));',
      'console.log(inspect(new Error("line one\\nline two")));',
      'console.log(inspect({ e: new Error("line one\\nline two") }));',
      'console.log(inspect({ a: { b: { c: new Error("deep") } } }));',
      'console.log(inspect([new Error("in an array")]));',
      "",
    ].join("\n");
    const got = await runProgram("errors", source);
    // Node's own output for the same errors with an EMPTIED stack — the
    // form S027 adopts, reproduced here as the oracle rather than pinned as
    // invented text.
    const bare = (make: () => Error): Error => {
      const e = make();
      e.stack = "";
      return e;
    };
    const want =
      inspect(bare(() => new Error("boom"))) + "\n" +
      inspect(bare(() => new Error())) + "\n" +
      inspect(bare(() => new TypeError("bad"))) + "\n" +
      inspect(bare(() => new RangeError("out"))) + "\n" +
      inspect(bare(() => new Error("line one\nline two"))) + "\n" +
      inspect({ e: bare(() => new Error("line one\nline two")) }) + "\n" +
      inspect({ a: { b: { c: bare(() => new Error("deep")) } } }) + "\n" +
      inspect([bare(() => new Error("in an array"))]) + "\n";
    expect(got).toBe(want);
    expect(got.startsWith("[Error: boom]\n[Error]\n[TypeError: bad]\n")).toBe(true);
  });

  test("a stamped code slot renders as the one extra own property", async () => {
    // Invoked directly: the only errors this tier stamps a `code` onto come
    // from deferred JS fences, which no small program reaches, so a
    // compiled pin is not available yet. The oracle is still Node — an
    // Error with an emptied stack and a `code` property.
    const h = await buildHelpers();
    // The oracle has to construct the REAL class, not rename an Error:
    // Node's improveStack inserts the constructor when a name ending in
    // "Error" disagrees with it, so a renamed Error renders `[Error
    // [TypeError]: bad]`. That rule never fires for anything this tier
    // renders — the builtin classes' name IS their constructor name, and
    // inspect of an error SUBCLASS is fenced in the frontend.
    const CTORS: Record<string, ErrorConstructor> = { Error, TypeError, RangeError, SyntaxError };
    const withCode = (name: string, message: string, code: string): string => {
      const e = new CTORS[name]!(message);
      e.stack = "";
      (e as Error & { code: string }).code = code;
      return inspect(e);
    };
    expect(h.error("Error", "boom", "ENOENT", 0, 2)).toBe(withCode("Error", "boom", "ENOENT"));
    expect(h.error("Error", "", "ERR_X", 0, 2)).toBe(withCode("Error", "", "ERR_X"));
    expect(h.error("TypeError", "bad", "ERR_INVALID_ARG_TYPE", 0, 2)).toBe(
      withCode("TypeError", "bad", "ERR_INVALID_ARG_TYPE"),
    );
    // A code needing the quote ladder goes through it.
    expect(h.error("Error", "m", "it's", 0, 2)).toBe(withCode("Error", "m", "it's"));
    // Long enough to break the one-property object onto its own line.
    const long = "E".repeat(70);
    expect(h.error("Error", "m", long, 0, 2)).toBe(withCode("Error", "m", long));
  });

  test("the depth gate is asymmetric: only a code-carrying error collapses", async () => {
    const h = await buildHelpers();
    // recurse > depth with a code → `[Name]`; without one the full base
    // still prints, because for a stackless error the bracket form IS the
    // value. Both directions measured against Node above (S027).
    expect(h.error("Error", "boom", "ENOENT", 3, 2)).toBe("[Error]");
    expect(h.error("TypeError", "bad", "X", 3, 2)).toBe("[TypeError]");
    expect(h.error("Error", "boom", null, 3, 2)).toBe("[Error: boom]");
    expect(h.error("Error", "", null, 3, 2)).toBe("[Error]");
    // At the budget exactly, nothing collapses.
    expect(h.error("Error", "boom", "ENOENT", 2, 2)).toBe(
      (() => {
        const e = new Error("boom");
        e.stack = "";
        (e as Error & { code: string }).code = "ENOENT";
        return inspect(e);
      })(),
    );
  });

  test("a multi-line message indents to the CURRENT level", async () => {
    const h = await buildHelpers();
    // formatError's closing replaceAll uses ctx.indentationLvl, which the
    // frame engine has already bumped for a property value.
    h.setIndent(0);
    expect(h.error("Error", "one\ntwo", null, 0, 2)).toBe("[Error: one\ntwo]");
    h.setIndent(2);
    expect(h.error("Error", "one\ntwo", null, 0, 2)).toBe("[Error: one\n  two]");
    h.setIndent(4);
    expect(h.error("Error", "one\ntwo\nthree", null, 0, 2)).toBe("[Error: one\n    two\n    three]");
    h.setIndent(0);
  });
});

/* ── the dyn walker ───────────────────────────────────────────────────────
 * `JSON.parse` is the tier's dyn producer, so `inspect(JSON.parse(s))`
 * drives the walker over an arbitrary tree with Node as the oracle on the
 * same JSON text — a real differential, not a transcription check. The
 * cases below stress what the WALKER decides (kinds, key order, the 100-
 * entry cap, cycles) on top of everything the layout engine already
 * decides, since every rendering goes back through begin/entry/end.
 *
 * The trees that need mutation (cycles, boxed functions, a promise) are
 * built with top-level `let` chains, NOT loop-scoped consts: a dyn value
 * bound inside a loop body is COPIED rather than aliased on a keyed write
 * (its own task), and the usual `const x = {}; o.a = x; o = x` idiom would
 * quietly build a tree one level deep. */

/** One compiled program per case list: `inspect(JSON.parse(<lit>))` for
 * each, whole stdout against Node's rendering of the same parse. */
async function pinJson(name: string, cases: readonly string[]): Promise<void> {
  const source = [
    'import { inspect } from "node:util";',
    ...cases.map((c) => `console.log(inspect(JSON.parse(${JSON.stringify(c)})));`),
    "",
  ].join("\n");
  const got = await runProgram(name, source);
  const want = cases.map((c) => inspect(JSON.parse(c)) + "\n").join("");
  if (got !== want) {
    const g = got.split("\n");
    const w = want.split("\n");
    for (let i = 0; i < Math.max(g.length, w.length); i++) {
      if (g[i] !== w[i]) {
        expect(
          `${g[i] ?? "(missing)"}\n  …after ${JSON.stringify(g.slice(Math.max(0, i - 3), i))}`,
          `first divergence at output line ${i}`,
        ).toBe(`${w[i] ?? "(missing)"}\n  …after ${JSON.stringify(w.slice(Math.max(0, i - 3), i))}`);
      }
    }
  }
  expect(got).toBe(want);
}

const seq = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("the dyn walker", () => {
  test("JSON trees, byte for byte against Node", async () => {
    await pinJson("dyn-trees", [
      // the kinds
      '{"a":1,"b":"two","c":[1,2,3],"d":true,"e":false,"f":null}',
      '"top level string"',
      "42",
      "-0",
      "true",
      "null",
      '[true,false,null,0,-0,1.5,1e21,1e-7,123456789]',
      // the empty answers, which come before the depth check
      "[]",
      "{}",
      "[[]]",
      "[{}]",
      '{"e":[]}',
      '{"e":{}}',
      // the depth budget's [Array] / [Object]
      '{"a":{"b":{"c":1}}}',
      '{"a":{"b":{"c":{"d":1}}}}',
      "[[[1]]]",
      "[[[[1]]]]",
      '{"a":[[{"deep":1}]]}',
      // the layout engine over a dyn tree: breaking, grouping, indentation
      '[1,2,3,4,5,6,7]',
      `[${seq(20).join(",")}]`,
      '["aa","bb","cc","dd","ee","ff","gg","hh"]',
      `[${seq(27).map((i) => i * 111).join(",")}]`,
      `[${seq(8).map((i) => `{"i":${i}}`).join(",")}]`,
      '{"long":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      '{"k1":"v1","k2":"v2","k3":"v3","k4":"v4","k5":"v5","k6":"v6","k7":"v7","k8":"v8"}',
      `{"a":"${"x".repeat(60)}","b":"${"y".repeat(60)}"}`,
      // maxArrayLength: the "... N more items" tail and its grid order flag
      `[${seq(101).join(",")}]`,
      `[${seq(130).join(",")}]`,
      `[${seq(101).map((i) => `"s${i}"`).join(",")}]`,
      // strings inside a composite QUOTE (the console.log distinction is
      // dynS's, not the walker's) and go through the whole ladder
      `{"s":"with 'quote'","t":"with \\"dquote\\"","u":"line\\nbreak","v":"tab\\there"}`,
      // key order: integer-like keys ascending FIRST, whatever the text order
      '{"2":4,"10":3,"b":1,"a":2,"c":5}',
      '{"10":1,"2":2,"1":3,"b":4,"01":5,"-1":6,"1.5":7}',
      // keys through the bare / quoted / ['__proto__'] ladder
      `{"ok_1":1,"1bad":2,"":3,"__proto__":4,"with space":5,"quo'te":6}`,
    ]);
  });

  test("random dyn trees", async () => {
    // A deterministic generator, so a failure is reproducible from the seed
    // printed in the message. Two programs, many trees each — compilation
    // is what costs, not cases.
    const gen = (seed0: number, count: number): string[] => {
      let seed = seed0;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const WORDS = ["a", "bb", "key", "long_name", "x1", "with space", "it's", 'q"q', "__proto__", "", "10", "2"];
      const STRS = ["", "s", "hello world", "a'b", 'a"b', "tab\there", "nl\nhere", "long ".repeat(20), "é", "✓"];
      const NUMS = [0, 1, -1, 1.5, 1e21, 1e-7, 123456789, -0.5, 3.14159];
      const one = (depth: number): unknown => {
        const r = rnd();
        if (depth <= 0 || r < 0.25) {
          const k = rnd();
          if (k < 0.3) return pick(NUMS);
          if (k < 0.55) return pick(STRS);
          if (k < 0.7) return rnd() < 0.5;
          if (k < 0.8) return null;
          return pick(NUMS);
        }
        if (r < 0.62) return Array.from({ length: Math.floor(rnd() * 9) }, () => one(depth - 1));
        const o: Record<string, unknown> = {};
        for (let i = 0; i < Math.floor(rnd() * 7); i++) {
          o[pick(WORDS) + (rnd() < 0.4 ? String(i) : "")] = one(depth - 1);
        }
        return o;
      };
      return Array.from({ length: count }, () => JSON.stringify(one(1 + Math.floor(rnd() * 4))));
    };
    await pinJson("dyn-fuzz-a", gen(1, 60));
    await pinJson("dyn-fuzz-b", gen(7, 60));
  });

  test("cycles: the seen check precedes the depth check", async () => {
    const source = [
      'import { inspect } from "node:util";',
      // self
      "const self: any = JSON.parse('{}');",
      "self.self = self;",
      "console.log(inspect(self));",
      "const arr: any = JSON.parse('[]');",
      "arr[0] = arr;",
      "console.log(inspect(arr));",
      // mutual, numbered from the root outward
      `const x: any = JSON.parse('{"name":"x"}');`,
      `const y: any = JSON.parse('{"name":"y"}');`,
      "x.other = y;",
      "y.other = x;",
      "console.log(inspect(x));",
      // shared but NOT on the path: no marker at all
      `const shared: any = JSON.parse('{"v":1}');`,
      "const both: any = JSON.parse('{}');",
      "both.a = shared;",
      "both.b = shared;",
      "console.log(inspect(both));",
      // the cycle closes at recursion 3 with a depth budget of 2 — still
      // [Circular *1], because the SEEN check runs first
      `const o: any = JSON.parse('{"a":{"b":{}}}');`,
      "o.a.b.c = o;",
      "console.log(inspect(o));",
      // one level deeper the DEPTH cut stops the descent before the cycle
      // is reached, so the answer is a plain [Object] — this looks like a
      // counterexample to the ordering above and is not one
      `const p: any = JSON.parse('{"a":{"b":{"c":{}}}}');`,
      "p.a.b.c.d = p;",
      "console.log(inspect(p));",
      "",
    ].join("\n");
    const got = await runProgram("dyn-cycles", source);

    const jself: Record<string, unknown> = {};
    jself["self"] = jself;
    const jarr: unknown[] = [];
    jarr[0] = jarr;
    const jx: Record<string, unknown> = { name: "x" };
    const jy: Record<string, unknown> = { name: "y" };
    jx["other"] = jy;
    jy["other"] = jx;
    const jshared = { v: 1 };
    const jboth = { a: jshared, b: jshared };
    const jo: Record<string, unknown> = { a: { b: {} as Record<string, unknown> } };
    (jo["a"] as { b: Record<string, unknown> }).b["c"] = jo;
    const jp: Record<string, unknown> = { a: { b: { c: {} as Record<string, unknown> } } };
    (jp["a"] as { b: { c: Record<string, unknown> } }).b.c["d"] = jp;
    expect(got).toBe(
      [jself, jarr, jx, jboth, jo, jp].map((v) => inspect(v) + "\n").join(""),
    );
    // Spot-check the shapes, so a change on both sides at once still fails.
    expect(got).toContain("<ref *1> { self: [Circular *1] }");
    expect(got).toContain("<ref *1> [ [Circular *1] ]");
    expect(got).toContain("<ref *1> { a: { b: { c: [Circular *1] } } }");
    expect(got).toContain("{ a: { b: { c: [Object] } } }");
    expect(got).toContain("{ a: { v: 1 }, b: { v: 1 } }");
  });

  test("%s and console.log's rest-argument rule: a dyn string is verbatim", async () => {
    // The JSON text is spelled by JSON.stringify twice over — once for the
    // JSON, once for the TS literal holding it — because hand-escaping a
    // quote-carrying string through both layers is how you accidentally
    // write a program whose JSON.parse throws (which the wasm tier reports
    // as a trap, S007, not as a test failure that tells you why).
    const quoted = `it's "quoted"`;
    const deep = { a: { b: { c: { d: 1 } } } };
    const lit = (v: unknown): string => JSON.stringify(JSON.stringify(v));
    const source = [
      'import { inspect, format } from "node:util";',
      `const s: any = JSON.parse(${lit("hi there")});`,
      "console.log(s);",
      'console.log(format("%s", s));',
      "console.log(inspect(s));",
      `console.log(JSON.parse(${lit({ s: "hi there" })}));`,
      // a string needing the quote ladder: still verbatim at the top level
      `const q: any = JSON.parse(${lit(quoted)});`,
      "console.log(q);",
      "console.log(inspect(q));",
      // non-strings inspect at the rest-arg depth of 2
      `console.log(JSON.parse(${lit(deep)}));`,
      `console.log(format("%s", JSON.parse(${lit(deep)})));`,
      `console.log(JSON.parse("[1,2,3]"), JSON.parse("true"), JSON.parse("null"), JSON.parse("1.5"));`,
      "",
    ].join("\n");
    const got = await runProgram("dyn-fmt-s", source);
    expect(got).toBe(
      [
        "hi there",
        format("%s", "hi there"),
        inspect("hi there"),
        inspect({ s: "hi there" }),
        quoted,
        inspect(quoted),
        inspect(deep),
        format("%s", deep),
        [inspect([1, 2, 3]), "true", "null", "1.5"].join(" "),
        "",
      ].join("\n"),
    );
  });

  test("%j: JSON.stringify's text, with circularity swallowed", async () => {
    const source = [
      'import { format } from "node:util";',
      `console.log(format("%j", JSON.parse('{"a":1}')));`,
      `console.log(format("%j", JSON.parse('"hi"')));`,
      `console.log(format("%j", JSON.parse('1.5')));`,
      `console.log(format("%j", JSON.parse('[1,null,2]')));`,
      `console.log(format("%j", JSON.parse('{"nested":{"deep":[1,{"x":2}]}}')));`,
      // a cycle prints the LITERAL text, with no *N numbering
      "const self: any = JSON.parse('{}');",
      "self.self = self;",
      `console.log(format("%j", self));`,
      "const arr: any = JSON.parse('[]');",
      "arr[0] = arr;",
      `console.log(format("%j", arr));`,
      `const nest: any = JSON.parse('{"a":{"b":{}}}');`,
      "nest.a.b.back = nest;",
      `console.log(format("%j", nest));`,
      // a root the stringify DROPS prints "undefined"
      `const missing: any = JSON.parse('{"k":1}').nope;`,
      `console.log(format("%j", missing));`,
      "const fn: any = JSON.parse('{}');",
      "fn.f = (): number => 1;",
      `console.log(format("%j", fn.f));`,
      // and members that drop, per JSON's own rules
      `console.log(format("%j", fn));`,
      // the two ABSENT-value positions, which differ: an object member
      // vanishes with its key, an array slot becomes null
      `const holes: any = JSON.parse('[1,2,3]');`,
      "holes[0] = (): number => 1;",
      `holes[1] = JSON.parse('{"k":1}').missing;`,
      `console.log(format("%j", holes));`,
      `const drops: any = JSON.parse('{"a":1,"b":2,"c":3}');`,
      "drops.a = (): number => 1;",
      `drops.b = JSON.parse('{"k":1}').missing;`,
      `console.log(format("%j", drops));`,
      // the walk recovers: a plain case straight after a swallowed cycle
      `console.log(format("%j", JSON.parse('{"after":[1,2]}')));`,
      "",
    ].join("\n");
    const got = await runProgram("dyn-fmt-j", source);
    const jself: Record<string, unknown> = {};
    jself["self"] = jself;
    const jarr: unknown[] = [];
    jarr[0] = jarr;
    const jnest: Record<string, unknown> = { a: { b: {} as Record<string, unknown> } };
    (jnest["a"] as { b: Record<string, unknown> }).b["back"] = jnest;
    expect(got).toBe(
      [
        format("%j", { a: 1 }),
        format("%j", "hi"),
        format("%j", 1.5),
        format("%j", [1, null, 2]),
        format("%j", { nested: { deep: [1, { x: 2 }] } }),
        format("%j", jself),
        format("%j", jarr),
        format("%j", jnest),
        format("%j", undefined),
        format("%j", () => 1),
        format("%j", { f: () => 1 }),
        format("%j", [() => 1, undefined, 3]),
        format("%j", { a: () => 1, b: undefined, c: 3 }),
        format("%j", { after: [1, 2] }),
        "",
      ].join("\n"),
    );
    expect(got).toContain("[Circular]");
    expect(got).not.toContain("[Circular *1]");
  });

  test("boxed functions: named and anonymous", async () => {
    const source = [
      'import { inspect } from "node:util";',
      "const h: any = JSON.parse('{}');",
      // a property assignment infers NO name, on both sides
      "h.a = (): number => 1;",
      "h.b = function (): number { return 2; };",
      "h.c = function named(): number { return 3; };",
      "function decl(): number { return 4; }",
      "h.d = decl;",
      "console.log(inspect(h));",
      "console.log(inspect(h.c));",
      "console.log(inspect(h.a));",
      "",
    ].join("\n");
    const got = await runProgram("dyn-funcs", source);
    const jh = {
      a: (): number => 1,
      b: function (): number { return 2; },
      c: function named(): number { return 3; },
      d: function decl(): number { return 4; },
    };
    // The oracle's `a`/`b` DO get inferred names from the object literal, so
    // the shapes are pinned directly rather than through inspect(jh).
    void jh;
    expect(got).toBe(
      [
        "{",
        "  a: [Function (anonymous)],",
        "  b: [Function (anonymous)],",
        "  c: [Function: named],",
        "  d: [Function: decl]",
        "}",
        "[Function: named]",
        "[Function (anonymous)]",
        "",
      ].join("\n"),
    );
    // Node's own rendering of the same four values, built so that no name
    // is inferred — the texts above are Node's, not invented.
    const anon: unknown[] = [(): number => 1];
    expect(inspect(anon[0])).toBe("[Function (anonymous)]");
    expect(inspect(function named(): number { return 3; })).toBe("[Function: named]");
  });

  test("a promise inside a dyn tree fences (SEMANTICS.md S030)", async () => {
    const source = [
      'import { inspect } from "node:util";',
      "async function mk(): Promise<any> { return JSON.parse('{\"v\":1}'); }",
      "const p: any = mk();",
      "try { console.log(inspect(p)); }",
      'catch (e) { console.log("bare:", (e as Error).name, (e as Error).message); }',
      // nested, so the throw unwinds through frames the render left open
      `const holder: any = JSON.parse('{"before":1,"deep":{"x":2}}');`,
      "holder.deep.p = p;",
      "try { console.log(inspect(holder)); }",
      'catch (e) { console.log("nested:", (e as Error).message); }',
      // the engine recovers completely: buffer, frames, indentation
      `console.log(inspect(JSON.parse('{"after":{"ok":[1,2,3]}}')));`,
      `console.log(inspect(JSON.parse('{"z":"a string that is quite long so it needs the layout engine to break it up nicely"}')));`,
      "",
    ].join("\n");
    const got = await runProgram("dyn-promise-fence", source);
    const fence = "util.inspect of a promise value is not supported yet";
    expect(got).toBe(
      [
        `bare: Error ${fence}`,
        `nested: ${fence}`,
        inspect({ after: { ok: [1, 2, 3] } }),
        inspect({ z: "a string that is quite long so it needs the layout engine to break it up nicely" }),
        "",
      ].join("\n"),
    );
  });

  test("the recursion cap degrades like Node (SEMANTICS.md S029)", async () => {
    // Node CATCHES its own stack overflow mid-render, substitutes an
    // interruption marker for the composite that overflowed, and lets the
    // rest of the output finish. The depth it happens at is stack-dependent
    // (measured at 929, 1113 and 1421 levels on the same tree), so the
    // oracle cannot be a byte diff — what is pinned is the MARKER TEXT,
    // which is Node's exactly, and the shape of the degradation: one
    // marker, the render completes, the braces balance.
    const source = [
      'import { inspect } from "node:util";',
      "function chain(n: number): any {",
      "  const root: any = JSON.parse('{}');",
      "  let cur: any = root;",
      "  let nxt: any = null;",
      "  for (let i = 0; i < n; i++) { nxt = JSON.parse('{}'); cur.d = nxt; cur = nxt; }",
      "  cur.end = true;",
      "  return root;",
      "}",
      "const over: string = inspect(chain(1001), { depth: null });",
      'console.log("over markers:", over.split("Inspection interrupted").length - 1);',
      'console.log("over braces:", over.split("{").length - 1, over.split("}").length - 1);',
      'console.log("over has end:", over.indexOf("end: true") >= 0);',
      'console.log("over marker:", over.split("\\n")[1001].trim());',
      "const under: string = inspect(chain(1000), { depth: null });",
      'console.log("under markers:", under.split("Inspection interrupted").length - 1);',
      'console.log("under has end:", under.indexOf("end: true") >= 0);',
      // the engine is fine afterwards
      `console.log(inspect(JSON.parse('{"after":1}')));`,
      "",
    ].join("\n");
    const got = await runProgram("dyn-depth-cap", source);
    const marker = "d: [Object: Inspection interrupted prematurely. Maximum call stack size exceeded.]";
    expect(got).toBe(
      [
        "over markers: 1",
        "over braces: 1001 1001",
        "over has end: false",
        `over marker: ${marker}`,
        "under markers: 0",
        "under has end: true",
        "{ after: 1 }",
        "",
      ].join("\n"),
    );
    // The marker text is NODE'S: this is what it prints for a tree deep
    // enough to overflow its own stack.
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 20000; i++) {
      const next: Record<string, unknown> = {};
      cur["d"] = next;
      cur = next;
    }
    const nodeOut = inspect(deep, { depth: null });
    expect(nodeOut).toContain("[Object: Inspection interrupted prematurely. Maximum call stack size exceeded.]");
    expect(nodeOut.split("Inspection interrupted").length - 1).toBe(1);
  }, 60_000);
});
