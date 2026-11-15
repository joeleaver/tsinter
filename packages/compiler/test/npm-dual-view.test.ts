/* SEMANTICS.md S133 (j): the declared-surface view of a DUAL package
 * (import and require load different files) and of a package only a
 * non-entry file resolves, from the program's own import sites:
 *   - every site uses one syntax: the program types against the shipped
 *     declarations and compiles the JS Node loads for that syntax;
 *   - both syntaxes: no view, the fallback note says so;
 *   - importers resolving to different copies: no view, the note names them;
 * and the type walk that decides whether a value crosses into dynamic code
 * stops at a depth budget (a refusal by name, never a stack overflow).
 * Rows run under Node and on both WasmGC lanes. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";
import { isJsonSafeType, JSON_SAFE_DEPTH_BUDGET, STRING, type IrRecordShape, type IrType } from "../src/ir/nodes.js";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-dual-view");

const DUAL: Record<string, string> = {
  "node_modules/dualpkg/package.json": JSON.stringify({
    name: "dualpkg",
    version: "1.0.0",
    exports: { ".": { types: "./index.d.ts", import: "./index.mjs", require: "./index.cjs" } },
  }),
  "node_modules/dualpkg/index.d.ts": `export interface Opts { loud: boolean }\nexport declare function greet(name: string, opts?: Opts): string;\nexport declare const flavor: string;`,
  "node_modules/dualpkg/index.mjs": `export function greet(n, opts) { return (opts && opts.loud ? "HI " : "hi ") + n + " (esm)"; }\nexport const flavor = "esm";`,
  "node_modules/dualpkg/index.cjs": `exports.greet = (n, opts) => (opts && opts.loud ? "HI " : "hi ") + n + " (cjs)";\nexports.flavor = "cjs";`,
};

function cpk(version: string): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "cpk", version, type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
    "index.d.ts": `export interface Opts { n: number }\nexport declare function tag(o: Opts): string;`,
    "index.js": `export function tag(o) { return "v${version}:" + o.n; }`,
  };
}

const ROWS: Row[] = [
  {
    id: "DV-01 a dual package the program only imports: the ESM entry, typed by its declarations",
    npmStatic: ["dualpkg"],
    files: {
      ...DUAL,
      "main.ts": `import { greet, flavor, type Opts } from "dualpkg";\nconst o: Opts = { loud: true };\nconsole.log(greet("x"), greet("y", o), flavor);`,
    },
  },
  {
    id: "DV-02 a dual package the program only requires: the CommonJS entry",
    npmStatic: ["dualpkg"],
    files: {
      ...DUAL,
      "main.js": `const { greet, flavor } = require("dualpkg");\nconsole.log(greet("x"), greet("y", { loud: true }), flavor);`,
    },
  },
  {
    id: "DV-04 a package only a non-entry file resolves (a sub-package's own dependency)",
    npmStatic: ["cpk"],
    files: {
      ...Object.fromEntries(Object.entries(cpk("1.0.0")).map(([k, v]) => [`lib/node_modules/cpk/${k}`, v])),
      "lib/use.ts": `import { tag, type Opts } from "cpk";\nconst o: Opts = { n: 7 };\nexport const out: string = tag(o);`,
      "main.ts": `import { out } from "./lib/use.ts";\nconsole.log(out);`,
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true, module: "nodenext" } }),
    },
  },
];

describe("S133 (j): dual and non-entry declared views (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("S133 (j): dual and non-entry declared views (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

function project(tag: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `dual-${tag}-`));
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), src + "\n");
  }
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", target: "es2022", allowImportingTsExtensions: true, noEmit: true } }));
  return join(dir, "main.ts");
}

describe("S133 (j): shapes with no declared view say why", () => {
  test("DV-03 a dual package loaded with both import and require", () => {
    const entry = project("mixed", {
      ...DUAL,
      "helper.cjs": `const d = require("dualpkg");\nmodule.exports = () => d.flavor;`,
      "main.ts": `import { greet, type Opts } from "dualpkg";\nimport h from "./helper.cjs";\nconst o: Opts = { loud: false };\nconsole.log(greet("a", o), h());`,
    });
    const { coverage } = analyze(entry, { npmStatic: ["dualpkg"] });
    const st = (coverage.npmStatic ?? []).find((s) => s.package === "dualpkg");
    expect(st?.status).toBe("fallback");
    expect(st?.detail).toContain("both import and require");
  });

  test("DV-05 importers resolving to different copies", () => {
    const entry = project("copies", {
      ...Object.fromEntries(Object.entries(cpk("1.0.0")).map(([k, v]) => [`a/node_modules/cpk/${k}`, v])),
      ...Object.fromEntries(Object.entries(cpk("2.0.0")).map(([k, v]) => [`b/node_modules/cpk/${k}`, v])),
      "a/use.ts": `import { tag, type Opts } from "cpk";\nconst o: Opts = { n: 1 };\nexport const a: string = tag(o);`,
      "b/use.ts": `import { tag, type Opts } from "cpk";\nconst o: Opts = { n: 2 };\nexport const b: string = tag(o);`,
      "main.ts": `import { a } from "./a/use.ts";\nimport { b } from "./b/use.ts";\nconsole.log(a, b);`,
    });
    const { coverage } = analyze(entry, { npmStatic: ["cpk"] });
    const st = (coverage.npmStatic ?? []).find((s) => s.package === "cpk");
    expect(st?.status).toBe("fallback");
    expect(st?.detail).toContain("different copies");
  });
});

function chain(n: number): string {
  // Four array levels per record: each link adds five levels to the
  // JSON-safety walk while the type mapping stays linear.
  const decls = Array.from({ length: n }, (_, i) => `interface T${i} { k: string; next: T${i + 1}[][][][] }`).join("\n");
  return `${decls}\ninterface T${n} { k: string }\nfunction show(x: T0): string { return JSON.stringify(x); }\nconsole.log(typeof show);`;
}

describe("the dynamic-crossing type walk has a depth budget", () => {
  // The walk itself, on a synthetic IR type graph: a chain of N distinct
  // records, each field the next record — N levels deep.
  const chainShapes = (n: number): { root: IrType; get: (id: string) => IrRecordShape | undefined } => {
    const shapes = new Map<string, IrRecordShape>();
    for (let i = 0; i <= n; i++) {
      const fields = i === n ? [{ name: "k", type: STRING }] : [{ name: "next", type: { kind: "record", shapeId: `c${i + 1}` } as IrType }];
      shapes.set(`c${i}`, { id: `c${i}`, fields } as IrRecordShape);
    }
    return { root: { kind: "record", shapeId: "c0" }, get: (id) => shapes.get(id) };
  };
  test("DV-06 past the budget the JSON-safety walk answers false (the use refuses by name), never a stack overflow", () => {
    const deep = chainShapes(JSON_SAFE_DEPTH_BUDGET + 50);
    expect(isJsonSafeType(deep.root, deep.get, () => undefined)).toBe(false);
    const huge = chainShapes(100_000);
    expect(() => isJsonSafeType(huge.root, huge.get, () => undefined)).not.toThrow();
  });
  test("DV-06b control: inside the budget the same chain is JSON-safe", () => {
    const ok = chainShapes(JSON_SAFE_DEPTH_BUDGET - 50);
    expect(isJsonSafeType(ok.root, ok.get, () => undefined)).toBe(true);
  });
  test("DV-06c a deep chain in a program refuses by name instead of crashing", async () => {
    const entry = project("deep", { "main.ts": chain(100) });
    const res = await compile(entry, { outPath: join(entry, "..", "p.wasm"), outDir: join(entry, ".."), backend: "wasm" });
    expect(res.ok).toBe(false);
    expect((res.diagnostics ?? []).length).toBeGreaterThan(0);
  }, 600_000);
});

/* Review fixes: a declared export the loaded JS lacks refuses at build time
 * (S133 (b)); a require view types against the require side's declarations;
 * one copy loading ONE file keeps its view whatever syntax reaches it, and
 * type-only uses decide nothing. */
const pj = (o: object): string => JSON.stringify(o);
const under = (prefix: string, files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}/${k}`, v]));
const LACKS = (name: string, dual: boolean, cjsHas: boolean, esmHas: boolean): Record<string, string> =>
  under(`node_modules/${name}`, {
    "package.json": pj(dual
      ? { name, version: "1.0.0", exports: { ".": { types: "./index.d.ts", import: "./index.mjs", require: "./index.cjs" } } }
      : { name, version: "1.0.0", main: "./index.cjs", types: "./index.d.ts" }),
    "index.d.ts": `export declare function greet(n: string): string;\nexport declare const flavor: string;`,
    "index.cjs": `exports.greet = (n) => "cjs " + n;${cjsHas ? `\nexports.flavor = "cjs";` : ""}`,
    ...(dual ? { "index.mjs": `export function greet(n) { return "esm " + n; }${esmHas ? `\nexport const flavor = "esm";` : ""}` } : {}),
  });
const DECLARED_ONLY = "is declared by the";

describe("S133 (b) through the view: a declared export the loaded JS lacks refuses at build time", () => {
  const cases: [string, string[], Record<string, string>][] = [
    ["DV-07 a CommonJS package's require destructure", ["ndiff"], { ...LACKS("ndiff", false, false, false), "main.js": `const { greet, flavor } = require("ndiff");\nconsole.log(greet("x"), flavor);` }],
    ["DV-08 a dual package's ESM side lacks a named import (Node's link-time SyntaxError)", ["cdiff2"], { ...LACKS("cdiff2", true, true, false), "main.ts": `import { greet, flavor } from "cdiff2";\nconsole.log(greet("x"), flavor);` }],
    ["DV-09 a member read of the module object", ["cdiff"], { ...LACKS("cdiff", true, false, true), "main.js": `const m = require("cdiff");\nconsole.log(m.greet("x"), m.flavor);` }],
  ];
  test.for(cases)("%s", async ([id, pkgs, files]) => {
    const entry = project(id.split(" ")[0]!, files);
    const real = files["main.ts"] !== undefined ? entry : join(entry, "..", "main.js");
    const res = await compile(real, { outPath: join(entry, "..", "p.wasm"), outDir: join(entry, ".."), backend: "wasm", npmStatic: pkgs });
    expect(res.ok).toBe(false);
    const text = (res.diagnostics ?? []).map((d) => d.message).join("\n");
    expect(text).toContain(DECLARED_ONLY);
    expect(text).toContain("'flavor'");
  }, 600_000);
});

const PERCOND = (name: string): Record<string, string> =>
  under(`node_modules/${name}`, {
    "package.json": pj({ name, version: "1.0.0", exports: { ".": { import: { types: "./index.d.mts", default: "./index.mjs" }, require: { types: "./index.d.cts", default: "./index.cjs" } } } }),
    "index.d.mts": `export declare function greet(n: string): string;\nexport declare const esmOnly: number;`,
    "index.d.cts": `export declare function greet(n: string): string;\nexport declare const cjsOnly: number;`,
    "index.mjs": `export function greet(n) { return "esm " + n; }\nexport const esmOnly = 1;`,
    "index.cjs": `exports.greet = (n) => "cjs " + n;\nexports.cjsOnly = 2;`,
  });

const ROWS2: Row[] = [
  {
    id: "DV-10 a require view types against the require side's declarations (.d.cts)",
    npmStatic: ["ctypes"],
    files: { ...PERCOND("ctypes"), "main.js": `const m = require("ctypes");\nconsole.log(m.greet("x"), m.cjsOnly + 1);` },
  },
  {
    id: "DV-11 a non-dual package reached by both import and require keeps its view (one file)",
    npmStatic: ["onefile"],
    files: {
      ...under("node_modules/onefile", {
        "package.json": pj({ name: "onefile", version: "1.0.0", main: "./index.cjs", types: "./index.d.ts" }),
        "index.d.ts": `export interface Opts { n: number }\nexport declare function tag(o: Opts): string;`,
        "index.cjs": `exports.tag = (o) => "tag:" + o.n;`,
      }),
      "helper.cjs": `const { tag } = require("onefile");\nmodule.exports = () => tag({ n: 2 });`,
      "main.ts": `import { tag, type Opts } from "onefile";\nimport h from "./helper.cjs";\nconst o: Opts = { n: 1 };\nconsole.log(tag(o), h());`,
      "tsconfig.json": pj({ compilerOptions: { strict: true, skipLibCheck: true, module: "nodenext", allowJs: true } }),
    },
  },
  {
    id: "DV-12 an `import type` site decides nothing: a dual package only required keeps the require view",
    npmStatic: ["dualpkg"],
    files: {
      ...DUAL,
      "types.ts": `import type { Opts } from "dualpkg";\nexport const LOUD: Opts = { loud: true };`,
      "helper.cjs": `const { greet, flavor } = require("dualpkg");\nmodule.exports = (o) => greet("y", o) + " " + flavor;`,
      "main.ts": `import { LOUD } from "./types.ts";\nimport h from "./helper.cjs";\nconsole.log(h(LOUD));`,
      "tsconfig.json": pj({ compilerOptions: { strict: true, skipLibCheck: true, module: "nodenext", allowJs: true, allowImportingTsExtensions: true, noEmit: true } }),
    },
  },
];

describe("S133 (j) review fixes (wasm lane vs Node)", () => {
  test.for(ROWS2.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("S133 (j) review fixes (wasm-native lane vs Node)", () => {
  test.for(ROWS2.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

// The view's mirror serves the package.json files that set its declarations'
// module format: postgres ships `types/package.json` (no "type") inside a
// "type": "module" package, so its `export =` declarations are CommonJS and
// keep their default import under NodeNext, as the project's own tsc sees.
describe("S133 (j): the mirror keeps the declarations' module format", () => {
  const PGX: Row = {
    id: "DV-13 an export= declaration made CommonJS by a nested types/package.json",
    npmStatic: ["pgx"],
    files: {
      ...under("node_modules/pgx", {
        "package.json": pj({ name: "pgx", version: "1.0.0", type: "module", exports: { types: "./types/index.d.ts", import: "./src/index.js", default: "./cjs/index.js" } }),
        "types/package.json": pj({ devDependencies: {} }),
        "types/index.d.ts": `declare function pgx(url: string): pgx.Sql;\ndeclare namespace pgx { interface Sql { url: string } }\nexport = pgx;`,
        "src/index.js": `export default function pgx(url) { return { url: "esm:" + url }; }`,
        "cjs/package.json": pj({ type: "commonjs" }),
        "cjs/index.js": `module.exports = function pgx(url) { return { url: "cjs:" + url }; };`,
      }),
      "main.ts": `import pgx from "pgx";\nconst sql = pgx("db");\nconsole.log(sql.url);`,
      "tsconfig.json": pj({ compilerOptions: { strict: true, skipLibCheck: true, module: "nodenext", moduleResolution: "nodenext", esModuleInterop: true } }),
    },
  };
  test("DV-13 wasm", async () => {
    await checkRow(scratch, PGX, "wasm");
  });
  test("DV-13 wasm-native", async () => {
    await checkRow(scratch, PGX, "wasm-native");
  }, 600_000);
});
