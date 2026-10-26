/* #269 (wasm half, unit E): under /u, V8 tries a search at EVERY code
 * unit — its unanchored prelude is `.*?` over any code unit
 * (regexp-compiler-tonode.cc UnanchoredAdvance) — so zero-width
 * assertions (\b \B ^ $, empty lookarounds, the empty pattern) can match
 * between the two halves of a surrogate pair, while its /u character
 * matchers never consume half a pair from either side. A /u regex that is
 * global or sticky first tries one code unit back when lastIndex falls
 * inside a pair (OptionallyStepBackToLeadSurrogate). And Node's split
 * searches from each position with the non-sticky regex, so a split
 * point can fall inside a pair. `"a😀b".search(/\B/u)` is 2 in Node; the
 * tier said -1.
 *
 * Two instruments, both with Node as the oracle (never typed by hand):
 *   1. exec() itself over a (pattern × flags × subject × lastIndex) sweep
 *      — the match span and every capture, against Node's exec with the
 *      same lastIndex (for a regex that is neither global nor sticky Node
 *      starts at 0, and so does the sweep);
 *   2. whole programs on the wasm tier (search / test / replace / split /
 *      replaceAll over literals and run-time-compiled patterns) against
 *      the same source run by Node. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { A, Fn, I32, type X } from "../src/backend/wasm/asm.js";
import { ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { compileRegex } from "../src/backend/wasm/regex-buildtime.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";
import { RE_HEADER_REGISTER_COUNT } from "../src/backend/wasm/regex-opcodes.js";
import { runWasm } from "./wasm-host.js";

interface Exports {
  strNew(n: number): unknown;
  strSet(s: unknown, i: number, u: number): void;
  bcAt(offset: number, length: number): unknown;
  newCaptureArray(n: number): unknown;
  capAt(c: unknown, i: number): number;
  exec(bc: unknown, s: unknown, start: number, cap: unknown): number;
}

/** The interpreter, with every bytecode in `blobs` interned; returns each
 * blob's data offset (the bytecode array type is immutable, so it is
 * built with array.new_data, as the tier does). */
function harness(blobs: readonly Uint8Array[]): { x: Exports; offsets: number[] } {
  const mb = new ModuleBuilder();
  const strT = mb.arrayType("i16", true);
  const interp = new RegexInterpreterBuilder(mb, strT);
  const bcT = interp.bcType;
  const capT = interp.capType;
  const offsets = blobs.map((b) => mb.internData(b));
  const ref = (t: number): ValType => ({ kind: "ref", nullable: true, typeIndex: t });
  const d = (name: string, params: ValType[], results: ValType[], body: ($: A, p: (i: number) => X) => X | void): void => {
    const idx = mb.declareFunc(mb.funcType(params, results), name);
    const f = new Fn(params.length);
    const $ = new A(f);
    const v = body($, (i) => $.l(i));
    if (v) v();
    mb.setBody(idx, f.locals, f.c.bytes());
    mb.exportFunc(name, idx);
  };
  d("strNew", [I32], [ref(strT)], ($, p) => $.anew(strT, p(0)));
  d("strSet", [ref(strT), I32, I32], [], ($, p) => $.aset(strT, p(0), p(1), p(2)));
  d("bcAt", [I32, I32], [ref(bcT)], ($, p) => () => {
    p(0)();
    p(1)();
    $.c.arrayNewData(bcT, 0);
  });
  d("capAt", [ref(capT), I32], [I32], ($, p) => $.aget(capT, p(0), p(1)));
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  mb.exportFunc("exec", interp.exec());
  return { x: new WebAssembly.Instance(new WebAssembly.Module(mb.emit()), {}).exports as unknown as Exports, offsets };
}

const SUBJECTS = [
  "a\u{1F600}b",
  "\u{1F600}",
  "\u{1F600}\u{1F600}",
  "x\ud83d",
  "\ude00x",
  "\ud83d\ude00\ude00",
  "a\ud83d\ud83d\ude00b",
  "\ude00\u{1F600}\ude00",
  "\ud83d\u{1F600}",
  "ab\u{1F600}\u{1F600}cd",
];

const PATTERNS = [
  "\\B", "\\b", "(?:)", "(?=)", "(?!a)", "(?=\\ude00)", "(?<=\\ud83d)", "$", "^", "(?!)|\\B", "\\B\\ude00", "\\ude00", "\\ud83d",
  "(?=.)", "(?<!a)", "\\B|x", "(?:\\B)+", "()", "(?:\\B)?a", "\\B(?=\\ude00)", "[^a]", ".", "\\B.", "\\Bb", "(?<=.)", "(?<!.)",
  "\\B$", "(?=$)|\\B", "(?<=\\u{1F600})", "(?<=[^a])", "(?<=\\S)", "(?<=\\ude00)", "(?<!\\ud83d)", "(?<!.)\\B", "(?<=(.))\\B",
  "(\\ude00)\\1", "(?<=(\\ude00).*)\\1", "(?:)\\ude00", "[\\ude00]", "[\\ud800-\\udfff]", "[^\\ud800-\\udfff]", "\\W", "\\D", "\\S",
  "[\\s\\S]", "(?=[\\udc00-\\udfff])", "(?!\\ude00)\\B", "\\B(?=.)", "\\B(?!.)", "(?<=\\ud83d)\\B", "\\B(?<=.)", "(?:\\B|\\ude00)+",
  "(\\ud83d)(?=\\ude00)", "(?<=\\ud83d)(\\ude00)", "(.)(?<=\\1)", "(\\ud83d)?\\B", "\\u{1F600}", "(?<=a)", "a|\\B", "b|(?<!\\ud83d)",
  "x*", "(?:\\ud83d\\ude00)+", "\\w*", "(?=(\\B))\\1", "\\B\\1(x)?", "()\\1", "(?<n>)\\k<n>", "\\B(?<=\\1(\\B))", "(?<=\\1())",
  "(?<=(\\ude00)\\ud83d\\ude00)\\1", "(\\ud83d)\\1",
  // a back reference inside the group it names is EMPTY in V8 (no
  // surrogate check; review B2), one to a set or later group is not
  "(\\B\\1)", "(?!(\\B\\1))\\B", "(?<n>\\B\\k<n>)", "\\B()\\1", "\\B\\1()", "(?<n>\\k<n>(?<!a?[\\ud800-\\udfff]))+", "(a|\\B\\1)+",
  "(?<=(\\B\\1))", "(?<=\\B(\\1))", "((\\B)\\2\\1)", "(?:(?<n>\\B\\k<n>)|(?<n>x))", "(?<n>x)|(?<n>\\B\\k<n>)",
];
const FLAGS = ["u", "gu", "uy", "", "g", "y", "mu", "su", "gsu"];

interface Row {
  pattern: string;
  flags: string;
  subject: string;
  lastIndex: number;
}

function nodeExec(r: Row): number[] | null {
  const re = new RegExp(r.pattern, r.flags);
  re.lastIndex = r.lastIndex;
  const m = re.exec(r.subject);
  if (m === null) return null;
  // spans via the d flag's indices
  const d = new RegExp(r.pattern, r.flags + "d");
  d.lastIndex = r.lastIndex;
  const md = d.exec(r.subject)!;
  return md.indices!.flatMap((x) => (x === undefined ? [-1, -1] : [x[0], x[1]]));
}

describe("#269: exec() mid-pair semantics against Node", () => {
  test("pattern × flags × subject × lastIndex sweep", () => {
    const built: { pattern: string; flags: string; bytes: Uint8Array; captureCount: number }[] = [];
    let skipped = 0;
    for (const pattern of PATTERNS) {
      for (const flags of FLAGS) {
        const r = compileRegex(pattern, flags);
        if (r.kind === "ok") built.push({ pattern, flags, bytes: r.bytes, captureCount: r.captureCount });
        else skipped++;
      }
    }
    const { x, offsets } = harness(built.map((b) => b.bytes));
    let compared = 0;
    const bad: string[] = [];
    for (const [k, r] of built.entries()) {
      {
        const { pattern, flags } = r;
        const bc = x.bcAt(offsets[k]!, r.bytes.length);
        const slots = r.captureCount + Math.ceil(r.bytes[RE_HEADER_REGISTER_COUNT]! / 2);
        const stateful = flags.includes("g") || flags.includes("y");
        for (const subject of SUBJECTS) {
          const s = x.strNew(subject.length);
          for (let i = 0; i < subject.length; i++) x.strSet(s, i, subject.charCodeAt(i));
          for (let li = 0; li <= subject.length; li++) {
            if (!stateful && li > 0) break;
            const row: Row = { pattern, flags, subject, lastIndex: li };
            const want = nodeExec(row);
            const cap = x.newCaptureArray(slots);
            const ok = x.exec(bc, s, li, cap);
            const got = ok ? Array.from({ length: 2 * r.captureCount }, (_, k) => x.capAt(cap, k)) : null;
            compared++;
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              bad.push(`/${pattern}/${flags} on ${JSON.stringify(subject)} @${li}: node ${JSON.stringify(want)} wasm ${JSON.stringify(got)}`);
            }
          }
        }
      }
    }
    console.log(`#269 sweep: compared ${compared}, (pattern, flags) not built (fenced or invalid) ${skipped}, mismatches ${bad.length}`);
    expect(compared).toBeGreaterThan(3000);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 300_000);
});

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-regex-269-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function both(name: string, src: string): Promise<{ wasm: string; node: string }> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm", dynamic: false });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  const node = execFileSync(process.execPath, [entry], { encoding: "utf8" });
  return { wasm: run.stdout.toString() + run.stderr.toString(), node };
}

const PROGRAM_SUBJECTS = 'const S: string[] = ["a\\u{1F600}b", "\\u{1F600}", "\\u{1F600}\\u{1F600}", "x\\ud83d", "\\ude00x", "\\ud83d\\ude00\\ude00", "a\\ud83d\\ud83d\\ude00b", "ab\\u{1F600}\\u{1F600}cd"];\n';

describe("#269: whole programs on the wasm tier against Node", () => {
  test("S269-01 literals: search, test, replace, replaceAll and split with zero-width /u patterns", async () => {
    const lines = [
      PROGRAM_SUBJECTS,
      "for (const s of S) {",
      "  console.log(JSON.stringify([s.search(/\\B/u), s.search(/(?!a)/u), s.search(/\\B|x/u), s.search(/(?<!.)/u), s.search(/\\ude00/u), s.search(/(?<=\\ud83d)/u), s.search(/\\B./u), s.search(/(?<=.)/u)]));",
      "  console.log(JSON.stringify([/\\B(?=\\ude00)/u.test(s), /(?<=\\ud83d)\\B/u.test(s), /\\B(?!.)/u.test(s)]));",
      "  console.log(JSON.stringify([s.replace(/\\B/gu, \"-\"), s.replace(/(?<!a)/gu, \"-\"), s.replace(/(?=$)|\\B/gu, \"-\"), s.replace(/\\B/u, \"-\"), s.replaceAll(/\\b/gu, \"-\")]));",
      "  console.log(JSON.stringify([s.split(/\\B/u), s.split(/(?<!a)/u), s.split(/(?:)/u), s.split(/(?=\\ude00)|\\B/u), s.split(/(\\B)/u)]));",
      "}",
    ];
    const { wasm, node } = await both("s269-01", lines.join("\n"));
    expect(wasm).toBe(node);
  }, 120_000);

  test("S269-02 run-time-compiled patterns (new RegExp over a string known only at run time)", async () => {
    const lines = [
      PROGRAM_SUBJECTS,
      "function mk(p: string, f: string): RegExp {\n  return new RegExp(p, f);\n}",
      'const P: string[] = ["\\\\B", "(?<!a)", "(?=\\\\ude00)", "\\\\B.", "(?<=.)", "[^a]"];',
      "for (const p of P) {",
      "  const re = mk(p, \"u\");",
      "  const g = mk(p, \"gu\");",
      "  console.log(p, JSON.stringify(S.map((s) => [s.search(re), re.test(s), s.replace(g, \"-\")])));",
      "}",
    ];
    const { wasm, node } = await both("s269-02", lines.join("\n"));
    expect(wasm).toBe(node);
  }, 120_000);

  test("S269-03 (review B1) a STICKY /u split steps a whole code point (V8's spec path), a non-sticky one a code unit (its fast path)", async () => {
    const lines = [
      PROGRAM_SUBJECTS,
      "for (const s of S) {",
      "  console.log(JSON.stringify([s.split(/\\B/uy), s.split(/\\B/u), s.split(/(?<!\\u{1F600})/uy), s.split(/(?<!\\u{1F600})/u), s.split(/(?<!x)/uy), s.split(/(?<!x)/u), s.split(/(?:)/uy), s.split(/(?<!a)/guy)]));",
      "}",
    ];
    const { wasm, node } = await both("s269-03", lines.join("\n"));
    expect(wasm).toBe(node);
  }, 120_000);

  test("S269-04 (review B2) a back reference inside the group it names is empty — no surrogate-pair check — literal and run-time", async () => {
    const lines = [
      PROGRAM_SUBJECTS,
      "function mk(p: string, f: string): RegExp {\n  return new RegExp(p, f);\n}",
      "for (const s of S) {",
      "  console.log(JSON.stringify([s.search(/(?!(\\B\\1))\\B/u), s.search(/(\\B\\1)/u), s.search(/(?<n>\\B\\k<n>)/u), s.search(/\\B()\\1/u), s.search(/\\B\\1()/u), s.replace(/(?!(\\B\\1))\\B/gu, \"-\"), s.replace(/(\\B\\1)/gu, \"-\")]));",
      "  console.log(s.search(mk(\"(?!(\\\\B\\\\1))\\\\B\", \"u\")), s.search(mk(\"(\\\\B\\\\1)\", \"u\")));",
      "}",
      'console.log("\\ude00\\u{1F600}".search(/(?<n>\\k<n>(?<!a?[\\ud800-\\udfff]))+/mu));',
    ];
    const { wasm, node } = await both("s269-04", lines.join("\n"));
    expect(wasm).toBe(node);
  }, 120_000);
});
