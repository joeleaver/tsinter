/* rea (top-10 #2): `import { getManyValues, isMany, none, type Many } from
 * "stream-chain/defs.js"` (KunaJsonStream.ts), `import fun from
 * "stream-chain/fun.js"`, `import * as p from "stream-json/core/parser.js"`
 * beside `import type { Token } from` the same. A SUBPATH of an opted-in
 * package types against the package's shipped declaration for it, exactly
 * as the bare specifier does under the declared-surface view (SEMANTICS.md
 * S133): before this, the subpath landed on the JS (the view hides the
 * package's real declaration files) and a declared-only type (`Many`) did
 * not exist (SC0001).
 *
 * The views come from the pre-load source-graph scan (the subpaths the
 * program's own files spell, followed through relative edges); only those
 * subpaths' JS joins the program, so a package file Node never loads —
 * one the declarations reach only through their own imports included
 * (side2) — meets no import fence.
 *
 * Every row writes a tiny synthetic package (no third-party code). Exact
 * rows equal Node, spawned at test time; a `refused` row fails to compile
 * with the named code. Rows run on the wasm lane; the wasm-native describe
 * repeats them. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-dts-sub-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Files = Record<string, string>;

/** stream-chain's layout: ESM, "./*" → "./src/*", a .d.ts beside each
 * .js, an export list at the bottom. `web.js` imports a builtin a compiled
 * binary refuses (node:sqlite) — no program row loads it. */
const SUBPKG: Files = {
  "package.json": JSON.stringify({
    name: "subpkg",
    version: "1.0.0",
    type: "module",
    main: "./src/index.js",
    types: "./src/index.d.ts",
    exports: { ".": "./src/index.js", "./extra": "./src/extra-impl.js", "./*": "./src/*" },
  }),
  "src/index.js": `import { many } from './defs.js';
/**
 * @param {string} a
 * @param {string} b
 */
export const pair = (a, b) => many([a, b]);
`,
  "src/index.d.ts": `import type { Many } from './defs.js';
export declare function pair(a: string, b: string): Many<string>;
`,
  // JSDoc types the implementation as declared, and the declared functions
  // are not generic: an untyped (any) result checked into a declared
  // interface with a mutable array field (S125's copy refusal) and a call
  // of a declared generic function refuse through the bare specifier as
  // much as through a subpath — limits of the view, not of subpaths.
  "src/defs.js": `const none = 'subpkg.none';
/**
 * @param {string[]} values
 * @returns {{ __many: 1, values: string[] }}
 */
const many = values => ({ __many: 1, values });
/** @param {unknown} o */
const isMany = o => !!o && /** @type {{ __many?: unknown }} */ (o).__many === 1;
/**
 * @param {{ values: string[] }} o
 * @returns {string[]}
 */
const getManyValues = o => o.values;
export { none, many, isMany, getManyValues };
`,
  "src/defs.d.ts": `export declare const none: 'subpkg.none';
export interface Many<T = unknown> {
  __many: 1;
  values: T[];
}
export declare function isMany(o: unknown): o is Many;
export declare function many(values: string[]): Many<string>;
export declare function getManyValues(o: Many<string>): string[];
`,
  "src/fun.js": `/**
 * @param {...((x: number) => number)} fns
 * @returns {(x: number) => number}
 */
export function compose(...fns) {
  return (x) => fns.reduce((acc, f) => f(acc), x);
}
`,
  "src/fun.d.ts": `export type Step = (x: number) => number;
export declare function compose(...fns: Step[]): Step;
`,
  "src/core/parser.js": `/** @param {string} text */
export function tokenize(text) {
  return text.split(/\\s+/).filter((t) => t.length > 0).map((value) => ({ name: 'word', value }));
}
`,
  "src/core/parser.d.ts": `export interface Token {
  name: 'word';
  value: string;
}
export interface ParserOptions {
  strict?: boolean;
}
export declare function tokenize(text: string, options?: ParserOptions): Token[];
`,
  "src/extra-impl.js": `export const label = (n) => 'extra:' + n;
`,
  "src/extra-impl.d.ts": `export type Labelled = \`extra:\${number}\`;
export declare function label(n: number): Labelled;
`,
  "src/web.js": `import { DatabaseSync } from 'node:sqlite';
export const open = () => new DatabaseSync(':memory:');
`,
  "src/web.d.ts": `export declare function open(): unknown;
`,
};

/** CommonJS with no "exports": every file is a subpath; typings beside
 * the JS under lib/. */
const CJSPKG: Files = {
  "package.json": JSON.stringify({ name: "cjspkg", version: "1.0.0", type: "commonjs", main: "./lib/index.js", types: "./lib/index.d.ts" }),
  "lib/index.js": `'use strict';
exports.hello = (n) => 'hello ' + n;
`,
  "lib/index.d.ts": `export declare function hello(n: string): string;
`,
  "lib/util.js": `'use strict';
function scale(p, k) { return { x: p.x * k, y: p.y * k }; }
exports.scale = scale;
`,
  "lib/util.d.ts": `export interface Point {
  x: number;
  y: number;
}
export declare function scale(p: Point, k: number): Point;
`,
};

/** The review's repro: "./*" → "./*", and index.d.ts imports a type from
 * ./types.js, whose JS imports a builtin a compiled binary refuses. Node
 * never loads types.js; neither may the compile. */
const SIDE2: Files = {
  "package.json": JSON.stringify({ name: "side2", version: "1.0.0", type: "module", main: "./index.js", types: "./index.d.ts", exports: { ".": "./index.js", "./*": "./*" } }),
  "index.js": "export function f() { return 1; }\n",
  "index.d.ts": "import type { Opts } from './types.js';\nexport declare function f(o?: Opts): number;\n",
  "types.js": "import { DatabaseSync } from 'node:sqlite';\nexport const db = () => new DatabaseSync(':memory:');\n",
  "types.d.ts": "export interface Opts { verbose?: boolean }\nexport declare const db: () => unknown;\n",
};

interface Row {
  id: string;
  pkgs: Record<string, Files>;
  src: string;
  /** Program files beside main.ts. */
  files?: Files;
  refused?: { code: string; text?: RegExp };
}

const ROWS: Row[] = [
  {
    id: "DTSSUB-01 a type-only export of a \"./*\" subpath (the stream-chain/defs.js shape) types against the sibling .d.ts",
    pkgs: { subpkg: SUBPKG },
    src: `import { getManyValues, isMany, many, none, type Many } from "subpkg/defs.js";
const m: Many<string> = many(["a", "b"]);
const out: string[] = [];
if (isMany(m)) out.push(getManyValues(m).join(","));
const u: unknown = { values: [] };
out.push(String(isMany(u)), none);
console.log(out.join(" "));`,
  },
  {
    id: "DTSSUB-02 a function export of a subpath (the stream-chain/fun.js file) with its declared-only type alias",
    pkgs: { subpkg: SUBPKG },
    src: `import { compose, type Step } from "subpkg/fun.js";
const inc: Step = (x) => x + 1;
const f = compose(inc, (x) => x * 10);
console.log(f(2), compose()(7));`,
  },
  {
    id: "DTSSUB-03 a value import and a type-only import of one nested subpath (the stream-json/core/parser.js file)",
    pkgs: { subpkg: SUBPKG },
    src: `import { tokenize } from "subpkg/core/parser.js";
import type { ParserOptions, Token } from "subpkg/core/parser.js";
const opts: ParserOptions = { strict: true };
const toks: Token[] = tokenize("  a bb  ccc ", opts);
console.log(toks.length, toks.map((t) => t.name + "=" + t.value).join(" "));`,
  },
  {
    id: "DTSSUB-04 an exact \"exports\" key beside the pattern, with the bare specifier and a pattern subpath in one program",
    pkgs: { subpkg: SUBPKG },
    src: `import { label, type Labelled } from "subpkg/extra";
import { pair } from "subpkg";
import { getManyValues } from "subpkg/defs.js";
const l: Labelled = label(3);
console.log(l, getManyValues(pair("1", "2")).join("+"));`,
  },
  {
    id: "DTSSUB-05 a CommonJS package with no \"exports\": a file subpath types against its sibling declaration",
    pkgs: { cjspkg: CJSPKG },
    src: `import { scale, type Point } from "cjspkg/lib/util.js";
import { hello } from "cjspkg";
const p: Point = scale({ x: 1, y: 2 }, 3);
console.log(p.x, p.y, hello("w"));`,
  },
  {
    id: "DTSSUB-06 a declaration's own import of a sibling file (Node never loads its JS) brings no JS into the compile (the review's side2)",
    pkgs: { side2: SIDE2 },
    src: `import { f } from "side2";
console.log(f());`,
  },
  {
    id: "DTSSUB-07 a subpath named only in a file the entry reaches through a relative import",
    pkgs: { subpkg: SUBPKG },
    files: {
      "lib/many.ts": `import { getManyValues, many, type Many } from "subpkg/defs.js";
export function joined(xs: string[]): string {
  const m: Many<string> = many(xs);
  return getManyValues(m).join("|");
}
`,
    },
    src: `import { joined } from "./lib/many.ts";
console.log(joined(["p", "q"]));`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  for (const [pkg, files] of Object.entries(row.pkgs)) {
    for (const [rel, text] of Object.entries(files)) {
      const p = join(dir, "node_modules", pkg, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  for (const [rel, text] of Object.entries(row.files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dts-sub-row", private: true, type: "module" }));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function nativeRun(path: string): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(row, backend);
  const dir = dirname(entry);
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, npmStatic: Object.keys(row.pkgs) });
  if (row.refused !== undefined) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const named = res.diagnostics.filter((d) => d.code === row.refused!.code);
    expect(named.length, JSON.stringify(res.diagnostics)).toBeGreaterThan(0);
    if (row.refused.text) expect(named.some((d) => row.refused!.text!.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const nr = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dir });
  const node: Out = { stdout: nr.stdout, stderr: nr.stderr, exitCode: nr.status ?? -1 };
  expect(node.exitCode, node.stderr).toBe(0);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got).toEqual(node);
}

describe("S133 subpaths: an opted-in package's subpath types against its shipped declarations (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  }, 120_000);
});

describe("S133 subpaths: an opted-in package's subpath types against its shipped declarations (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
