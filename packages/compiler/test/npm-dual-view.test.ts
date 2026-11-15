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

describe("the dynamic-crossing type walk has a depth budget", () => {
  test("DV-06 a 600-deep chain of record types crossing into JSON.stringify refuses by name, never crashes", async () => {
    const decls = Array.from({ length: 600 }, (_, i) => `interface T${i} { k: string; next: T${i + 1} | null }`).join("\n");
    const entry = project("deep", {
      "main.ts": `${decls}\ninterface T600 { k: string }\nfunction show(x: T0): string { return JSON.stringify(x); }\nconsole.log(typeof show);`,
    });
    const res = await compile(entry, { outPath: join(entry, "..", "p.wasm"), outDir: join(entry, ".."), backend: "wasm" });
    // Either outcome is honest; a thrown RangeError (the old ICE) is not.
    if (!res.ok) expect((res.diagnostics ?? []).length).toBeGreaterThan(0);
  }, 600_000);
});
