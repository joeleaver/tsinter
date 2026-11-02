/* Unit P1 — `new RegExp(pattern, flags)` over strings known only at run
 * time, end to end: each row is a program compiled with --backend wasm,
 * run under the unit-test host, and compared with the SAME source run by
 * Node (process.execPath, which strips the types itself) — the expected
 * output is Node's, never typed by hand. The fence rows (RTN-03), where
 * Node builds the regex and this tier refuses by name (SEMANTICS.md
 * S102), compare the parts both agree on and pin the fence's own text.
 *
 * wasm-regex-runtime-compiler.test.ts holds the compiler itself to the
 * build-time pipeline and to Node over the whole pattern pool; these rows
 * prove the wiring: the call site's throw (V8's catchable SyntaxError, or
 * the named fence that ends the program — GH #86, S122), the value's use by every regex operation, the
 * island boundary, and the build-time fixes made alongside. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-regex-rtn-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function both(name: string, src: string): Promise<{ wasm: string; node: string }> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm", dynamic: src.startsWith("// @dynamic") });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  const node = execFileSync(process.execPath, [entry], { encoding: "utf8" });
  return { wasm: run.stdout.toString() + run.stderr.toString(), node };
}

const MK = "function mk(p: string, f: string): RegExp {\n  return new RegExp(p, f);\n}\n";

test("RTN-01 run-time patterns and flags: test, exec, replace, source, flags", async () => {
  const { wasm, node } = await both(
    "rtn01",
    MK +
      [
        "const PRAGMAS = ['format', 'prettier'];",
        "const [HAS] = [PRAGMAS].map((ps) => new RegExp(`^\\\\s*@(?:${ps.join('|')})\\\\b`));",
        "console.log(HAS.test('  @format x'), HAS.test('  @noformat'), HAS.source, JSON.stringify(HAS.flags));",
        "for (const w of ['alpha', 'Beta', 'a.b']) {",
        "  const re = mk(`^${w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'i');",
        "  console.log(re.source, re.flags, re.test(w.toUpperCase()), re.test(w + '!'));",
        "}",
        "for (const f of ['', 'i', 'm', 's', 'u', 'is', 'smi', 'yg', 'dg']) console.log(JSON.stringify(f), mk('a', f).flags);",
        "const d = mk('(?<y>\\\\d{4})-(?<m>\\\\d{2})', '');",
        "const m = d.exec('on 2024-05 today');",
        "if (m !== null) console.log(m[0], m[1], m[2]);",
        "console.log('A-b-C'.replace(mk('[a-c]', 'gi'), '<$&>'));",
        "console.log(mk('[^x]', 'i').test('X'), mk('[^x]', 'i').test('y'), mk('\\\\u212a', 'i').test('k'));",
        "console.log(mk('(?<=\\\\$)\\\\d+', '').exec('cost $42')?.[0]);",
        "console.log(mk('(a)|(?<n>b)\\\\k<n>', '').exec('bb')?.[0]);",
      ].join("\n"),
  );
  expect(wasm).toBe(node);
});

test("RTN-02 an invalid run-time pattern or flags string throws V8's SyntaxError, catchable", async () => {
  const { wasm, node } = await both(
    "rtn02",
    MK +
      [
        "const rows: [string, string][] = [",
        "  ['(', ''], ['(', 'ig'], ['(', 'ysmgd'], ['a)', ''], ['[', 'm'], ['a{2,1}', ''], ['x**', ''], ['{2}', 'u'], ['}', 'u'],",
        "  ['a{2', 'u'], ['(?x)', ''], ['(?<1>x)', ''], ['(?<a>x)(?<a>y)', ''], ['((?<a>x)|y)(?<a>z)', ''], ['\\\\k<q>(?<a>x)', ''],",
        "  ['\\\\k', 'u'], ['\\\\p{', 'u'], ['[\\\\p]', 'u'], ['[b-a]', ''], ['[\\\\d-a]', 'u'], ['\\\\x', 'u'], ['\\\\u{110000}', 'u'],",
        "  ['\\\\', ''], ['(?<=a)*', ''], ['\\\\01', 'u'], ['(?ii:a)', ''], ['(?-:a)', ''], ['(?--i:a)', ''], ['(?<a>x)[\\\\k]', ''],",
        "  ['a', 'gg'], ['a', 'x'], ['a', 'Q'], ['a', 'uv'], ['(', 'iu'], ['[b-a]', 'ui'],",
        "];",
        "for (const [p, f] of rows) {",
        "  try {",
        "    mk(p, f);",
        "    console.log('built', p);",
        "  } catch (e) {",
        "    console.log(e instanceof SyntaxError, (e as Error).name, (e as Error).message);",
        "  }",
        "}",
        "// the build-time (constant-folded) arm: canonical flags in the message",
        "try { new RegExp('(', 'ig'); } catch (e) { console.log((e as Error).message); }",
      ].join("\n"),
  );
  expect(wasm).toBe(node);
});

// GH #86 (SEMANTICS.md S122): the S102 fence ENDS the program — stderr
// `tsinter: unsupported: <message> [<key>]`, exit 1 — so a program's own
// try/catch no longer sees it. One program per key, each pinning its text.
const RTN03_ROWS: [string, string, string][] = [
  ["a", "iu", "unicode-casefold"],
  ["a", "v", "unicode-sets-flag"],
  ["(?i:a)", "", "modifiers"],
  ["a]", "", "annexb-extended-pattern-char"],
  ["\\\\p{Script=Greek}", "u", "unported-unicode-property"],
  ["a{2", "", "annexb-brace-literal"],
  ["[\\\\d-z]", "", "annexb-class-range-escape"],
  ["' + 'x'.repeat(9000) + '", "", "pattern-too-large"],
];

test("RTN-03 Node builds every pattern the tier fences", () => {
  const entry = join(scratch, "rtn03-node.ts");
  const rows = RTN03_ROWS.map(([p, f]) => `['${p}', '${f}']`).join(", ");
  return writeFile(
    entry,
    MK +
      [
        `const rows: [string, string][] = [${rows}];`,
        "for (const [p, f] of rows) {",
        "  const r = mk(p, f);",
        "  console.log('built', r.source.length > 40 ? r.source.length : r.source, r.flags);",
        "}",
      ].join("\n") +
      "\n",
  ).then(() => {
    const node = execFileSync(process.execPath, [entry], { encoding: "utf8" });
    expect(node).toBe(
      ["built a iu", "built a v", "built (?i:a) ", "built a] ", "built \\p{Script=Greek} u", "built a{2 ", "built [\\d-z] ", "built 9000 ", ""].join("\n"),
    );
  });
});

test.for(RTN03_ROWS.map((r) => [r[2], r] as const))(
  "RTN-03 a run-time pattern outside the tier ends the program at the named fence carrying the refusal key: %s",
  async ([key, [p, f]]) => {
    const name = `rtn03-${key}`;
    const entry = join(scratch, `${name}.ts`);
    await writeFile(
      entry,
      MK +
        [
          "console.log('before');",
          "try {",
          `  const r = mk('${p}', '${f}');`,
          "  console.log('built', r.source.length);",
          "} catch (e) {",
          "  console.log('caught', (e as Error).message);",
          "} finally {",
          "  console.log('finally');",
          "}",
        ].join("\n") +
        "\n",
    );
    const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
    if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
    const run = await runWasmToTrap(res.binaryPath);
    expect(String(run.stdout)).toBe("before\n");
    expect(String(run.stderr)).toBe(`tsinter: unsupported: new RegExp(): '${key}' is not supported yet [libCall:regex.new:${key}]\n`);
  },
);

test("RTN-04 a run-time RegExp crossing into `any` is an island RegExp", async () => {
  const { wasm, node } = await both(
    "rtn04",
    [
      "// @dynamic",
      "const src = process.argv.length > 99 ? 'a' : 'b+/c';",
      "const flg = process.argv.length > 99 ? '' : 'i';",
      "const re = new RegExp(src, flg);",
      "const r: any = re;",
      "console.log(`${r.source} ${r.flags} ${r.test('xBB/cy')} ${String(r)} ${r.global} ${r.ignoreCase}`);",
      "const re2 = new RegExp(src);",
      "const r2: any = re2;",
      "console.log(`${r2.source} ${r2.flags} ${r2.test('xbb/cy')} ${r2.test('B/C')}`);",
    ].join("\n"),
  );
  expect(wasm).toBe(node);
});

test("RTN-05 .source is V8's EscapeRegExpSource, at run time and at build time", async () => {
  const { wasm, node } = await both(
    "rtn05",
    MK +
      [
        "const ps = ['', '/', 'a/b', '[/]', '\\\\/', '\\\\\\\\/', '[\\\\]/]/', '\\n', 'a\\\\\\nb', '\\r', '\\u2028\\u2029', 'x\\\\\\u2028'];",
        "for (const p of ps) console.log(JSON.stringify(mk(p, '').source));",
        "console.log(JSON.stringify(new RegExp('[/]').source), JSON.stringify(new RegExp('\\\\/').source), JSON.stringify(new RegExp('a\\\\\\nb').source));",
      ].join("\n"),
  );
  expect(wasm).toBe(node);
});

test("RTN-06 build-time fixes found by the gate: \\b under /i, (?i:..) under /i, \\p{L=}", async () => {
  const { wasm, node } = await both(
    "rtn06",
    [
      "console.log(/\\bfoo/i.test('a FOO'), /\\Bfoo/i.test('aFOO'), new RegExp('\\\\bba', 'i').test('x BAR'));",
      "console.log(new RegExp('(?i:a)', 'i').test('A'));",
      "try { new RegExp('\\\\p{L=}', 'u'); console.log('built'); } catch (e) { console.log((e as Error).message); }",
    ].join("\n"),
  );
  // \p{L=} under /u used to build \p{L}, then refused as
  // unported-unicode-property; since unit E's review it throws V8's own
  // "Invalid property name" SyntaxError at the call, as Node does.
  expect(wasm).toBe(node);
});

test("RTN-07 constant patterns the build-time pipeline used to build or refuse wrongly now answer as Node does", async () => {
  const { wasm, node } = await both(
    "rtn07",
    [
      "const tries: (() => RegExp)[] = [",
      "  () => new RegExp('((?<a>x)|y)(?<a>z)'),",
      "  () => new RegExp('(?<a>x)[\\\\k]'),",
      "  () => new RegExp('(?<a>x)|(?<a>y)'),",
      "  () => new RegExp('(', 'iu'),",
      "  () => new RegExp('a', 'uv'),",
      "];",
      "for (const t of tries) {",
      "  try {",
      "    const r = t();",
      "    console.log('built', r.source, r.test('y'));",
      "  } catch (e) {",
      "    console.log((e as Error).name, (e as Error).message);",
      "  }",
      "}",
    ].join("\n"),
  );
  expect(wasm).toBe(node);
});
