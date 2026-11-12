/* SEMANTICS.md S133: a program types against an npm package's SHIPPED
 * declarations while the package's JS compiles (--npm-static; the
 * npm-static.ts doctrine, dts-bridge.ts, lowering/lower-dts.ts).
 *
 * Every row writes a tiny synthetic package (no third-party code) whose
 * .d.ts says something inference over its JS would not: getter/setter
 * overloads over a union-returning body, a declared narrower field, a
 * declared shape over an untyped (`any`) result, a declared error class.
 * The program typechecks only against the declarations, so each row also
 * proves the program side sees them.
 *
 * An exact row equals Node (spawned at test time). A `fence` row compiles,
 * prints Node's stdout up to the crossing, and ends at the named fence
 * (S133's mismatch: the declaration's claim was false for this value). A
 * `refused` row fails to compile with the named code. Rows run on the wasm
 * lane; the wasm-native describe repeats them. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-dts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Files = Record<string, string>;

/* ── the synthetic packages ─────────────────────────────────────────── */

/** CommonJS, declarations in a separate typings/ directory (commander's
 * layout). */
const DECLSURFACE: Files = {
  "package.json": JSON.stringify({ name: "declsurface", version: "1.0.0", type: "commonjs", main: "./index.js", types: "typings/index.d.ts" }),
  "lib/error.js": `'use strict';
class DeclError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'DeclError';
    this.code = code;
    this.exitCode = 1;
  }
}
exports.DeclError = DeclError;
`,
  "lib/registry.js": `'use strict';
const { DeclError } = require('./error.js');

class Registry {
  /** @param {string} [name] */
  constructor(name) {
    this._name = name || 'registry';
    /** @type {string[]} */
    this.items = [];
    /** @type {number | undefined} */
    this.count = undefined;
    this.parent = null;
  }

  /** @param {string} name */
  child(name) {
    const c = new Registry(name);
    c.parent = this;
    return c;
  }

  /**
   * @param {string} [v]
   * @return {string | Registry}
   */
  name(v) {
    if (v === undefined) return this._name;
    this._name = v;
    return this;
  }

  /** @param {string} item */
  add(item) {
    this.items.push(item);
    this.count = this.items.length;
    return this;
  }

  /** @param {(item: string, index: number) => void} fn */
  each(fn) {
    for (let i = 0; i < this.items.length; i++) fn(this.items[i], i);
    return this;
  }

  /**
   * @param {boolean} [asText]
   * @return {string | number}
   */
  size(asText) {
    return asText ? String(this.items.length) : this.items.length;
  }

  /** @return {string | number} */
  label() {
    return this.items.length > 1 ? this.items.join(',') : this.items.length;
  }

  meta() {
    return JSON.parse('{"version":2,"tags":["a","b"]}');
  }

  /** @param {string} item */
  need(item) {
    if (!this.items.includes(item)) throw new DeclError("missing item '" + item + "'", 'declsurface.missing');
    return item;
  }
}
exports.Registry = Registry;
`,
  "index.js": `'use strict';
const { Registry } = require('./lib/registry.js');
const { DeclError } = require('./lib/error.js');

exports.registry = new Registry('default');
/** @param {string} [name] */
exports.createRegistry = (name) => new Registry(name);
exports.Registry = Registry;
exports.DeclError = DeclError;
`,
  "typings/index.d.ts": `export class DeclError extends Error {
  constructor(message: string, code: string);
  readonly code: string;
  exitCode: number;
}

export type ItemVisitor = (item: string, index: number) => void;

export interface Meta {
  version: number;
  tags: string[];
}

export class Registry {
  constructor(name?: string);
  readonly items: readonly string[];
  readonly count: number;
  parent: Registry | null;
  child(name: string): Registry;
  name(): string;
  name(v: string): this;
  add(item: string): this;
  each(fn: ItemVisitor): this;
  size(asText?: false): number;
  size(asText: true): string;
  label(): string;
  meta(): Meta;
  need(item: string): string;
  /** Declared, but the JS never defines it. */
  undeclaredInJs(): void;
}

export function createRegistry(name?: string): Registry;
export const registry: Registry;
`,
};

/** An ES module whose .d.ts files sit BESIDE the JS (tsc's layout): the
 * package's own `./util.js` edge must keep landing on the JS. */
const DECLESM: Files = {
  "package.json": JSON.stringify({ name: "declesm", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "util.js": `export function pad(s, n) {
  let out = String(s);
  while (out.length < n) out = ' ' + out;
  return out;
}
`,
  "util.d.ts": `export declare function pad(s: string | number, n: number): string;
`,
  "index.js": `import { pad } from './util.js';

export class Table {
  constructor() {
    this.rows = [];
  }
  row(label, value) {
    this.rows.push([label, value]);
    return this;
  }
  render() {
    return this.rows.map((r) => r[0] + ':' + pad(r[1], 4)).join('\\n');
  }
  static of(label, value) {
    return new Table().row(label, value);
  }
}

export function width(t) {
  return t.render().length;
}
`,
  "index.d.ts": `export declare class Table {
  row(label: string, value: number): this;
  render(): string;
  static of(label: string, value: number): Table;
}
export declare function width(t: Table): number;
`,
};

interface Row {
  id: string;
  pkgs: Record<string, Files>;
  src: string;
  npmStatic?: string[] | "auto";
  refused?: { code: string; text?: RegExp };
  fence?: { text: RegExp; stdout: string };
}

const ROWS: Row[] = [
  {
    id: "DTS-CHAIN-01 getter/setter overloads chain against the declarations (inference says string | Registry)",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { Registry } from "declsurface";
const r = new Registry();
r.name("tools").add("a").add("b");
const n: string = r.name();
console.log(n, r.name().length, r.items.length);`,
  },
  {
    id: "DTS-OPT-01 a field inference leaves 'any' takes its declared type; optional calls through it cross",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { Registry } from "declsurface";
const r = new Registry("top");
const c = r.child("kid");
console.log(c.parent?.name(), r.parent?.name(), c.parent?.name() === "top", c.parent === r, r.parent === null);`,
  },
  {
    id: "DTS-READ-01 a field the declarations type narrower than inference reads as declared",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { createRegistry } from "declsurface";
const r = createRegistry("x").add("one");
const c: number = r.count;
console.log(c + 1, r.count * 2, r.size(), r.size(true).padStart(3, "0"));`,
  },
  {
    id: "DTS-CB-01 a program callback typed by the declarations receives the implementation's values",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { registry, type ItemVisitor } from "declsurface";
const seen: string[] = [];
const v: ItemVisitor = (item, i) => { seen.push(i + "=" + item.toUpperCase()); };
registry.add("p").add("q").each(v).each((item) => { seen.push(item); });
console.log(seen.join(" "), registry.name());`,
  },
  {
    id: "DTS-DYN-01 an untyped (any) implementation result stays dynamic under its declared shape",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { Registry, type Meta } from "declsurface";
const m: Meta = new Registry().meta();
m.tags.push("c");
const v: number = m.version;
console.log(v + 1, m.tags.length, m, JSON.stringify(m));`,
  },
  {
    id: "DTS-ERR-01 a declared error class thrown by the package is caught and narrowed by the program",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { DeclError, Registry } from "declsurface";
const r = new Registry().add("a");
try {
  r.need("a");
  r.need("zz");
  console.log("unreached");
} catch (e) {
  if (e instanceof DeclError) console.log("caught", e.code, e.message, e.exitCode, e.name);
  else console.log("other", e);
}`,
  },
  {
    id: "DTS-FENCE-01 a value the declarations exclude stops at the crossing, by name",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { Registry } from "declsurface";
const r = new Registry().add("x").add("y");
console.log(r.label());
r.name("solo");
const one = new Registry().add("only");
console.log("before");
console.log(one.label());`,
    fence: { text: /declsurface's declarations type the result of 'one\.label\(…\)' as 'string', but its implementation produced a 'number' value \(SEMANTICS\.md S133\)/, stdout: "x,y\nbefore\n" },
  },
  {
    id: "DTS-REFUSE-01 a declared member the JS never defines refuses at compile time",
    pkgs: { declsurface: DECLSURFACE },
    src: `import { Registry } from "declsurface";
new Registry().undeclaredInJs();`,
    refused: { code: "SC2013", text: /'undeclaredInJs' is declared by the 'declsurface' package's type declarations, but its compiled JavaScript defines no 'undeclaredInJs'/ },
  },
  {
    id: "DTS-ESM-01 sibling .d.ts files: the program types against them, the package's own edges stay JS",
    pkgs: { declesm: DECLESM },
    src: `import { Table, width } from "declesm";
const t = Table.of("a", 1).row("bb", 22);
console.log(t.render());
console.log(width(t));`,
  },
  {
    id: "DTS-AUTO-01 --npm-static auto takes a package with its own declarations statically",
    pkgs: { declsurface: DECLSURFACE },
    npmStatic: "auto",
    src: `import { Registry } from "declsurface";
console.log(new Registry().name("auto").add("z").name(), new Registry().size());`,
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
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dts-row", private: true, type: "module" }));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "", cwd: dirname(file) });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
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
  const npmStatic = row.npmStatic ?? Object.keys(row.pkgs);
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, npmStatic });
  if (row.refused !== undefined) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const named = res.diagnostics.filter((d) => d.code === row.refused!.code);
    expect(named.length, JSON.stringify(res.diagnostics)).toBeGreaterThan(0);
    if (row.refused.text) expect(named.some((d) => row.refused!.text!.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode, node.stderr).toBe(0);
  if (row.fence !== undefined) {
    const got: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(got.stdout)).toBe(true);
    expect(got.stderr.split("\n")[0]).toMatch(/^tsinter: unsupported: /);
    expect(got.stderr.split("\n")[0]).toMatch(row.fence.text);
    return;
  }
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got).toEqual(node);
}

describe("S133: npm packages type against their shipped declarations (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  }, 120_000);
});

describe("S133: npm packages type against their shipped declarations (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});

describe("S133: the coverage report", () => {
  // The program fails to typecheck against the INFERRED surface (the
  // getter/setter union), so before S133 this package dropped to the
  // island; now it is static and the program's typecheck is the
  // declarations'.
  test("a package whose inferred surface breaks the program reports static", () => {
    const entry = write(ROWS[0]!, "analyze");
    const { coverage } = analyze(entry, { npmStatic: ["declsurface"] });
    expect(coverage.npmStatic).toEqual([{ package: "declsurface", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
  }, 120_000);

  // A program error against the DECLARATIONS is the program's own error
  // (the project's tsc reports it too): it stays a build failure, never an
  // island fallback.
  test("a program that fails against the declarations is a type error, not a fallback", () => {
    const entry = write({ ...ROWS[0]!, id: "DTS-TSC-01", src: `import { Registry } from "declsurface";\nconst n: number = new Registry().name();\nconsole.log(n);` }, "analyze");
    const { coverage } = analyze(entry, { npmStatic: ["declsurface"] });
    expect(coverage.npmStatic).toEqual([{ package: "declsurface", status: "static" }]);
    expect(coverage.diagnostics.some((d) => d.code === "SC0001" && /not assignable to type 'number'/.test(d.message))).toBe(true);
  }, 120_000);
});
