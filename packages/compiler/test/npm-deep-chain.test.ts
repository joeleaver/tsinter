/* An opted-in package's own import graph is compiled to the depth Node
 * loads it (drizzle's pg-core/columns/date.common.js sits five relative
 * imports below the package entry), and a JavaScript method every return
 * of which is `return this` yields its receiver at a subclass call site
 * (drizzle's `defaultNow() { return this.default(sql`now()`) }`). Rows run
 * under Node and on both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-deep-chain");
const pj = (o: unknown): string => JSON.stringify(o);

const PKG: Record<string, string> = {
  "node_modules/deep/package.json": pj({ name: "deep", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/deep/index.d.ts": `export { ts, describe, TsB } from "./a/index.js";\n`,
  "node_modules/deep/index.js": `export { ts, describe, TsB } from "./a/index.js";\n`,
  "node_modules/deep/a/index.d.ts": `export * from "../b/index.js";\n`,
  "node_modules/deep/a/index.js": `export * from "../b/index.js";\n`,
  "node_modules/deep/b/index.d.ts": `export * from "../c/index.js";\n`,
  "node_modules/deep/b/index.js": `export * from "../c/index.js";\n`,
  "node_modules/deep/c/index.d.ts": `export * from "./cols/ts.js";\n`,
  "node_modules/deep/c/index.js": `export * from "./cols/ts.js";\n`,
  "node_modules/deep/c/cols/base.d.ts": `export declare class Builder { name: string; def: string; nn: boolean; constructor(name: string); default(v: string): this; notNull(): this; }\n`,
  "node_modules/deep/c/cols/base.js": `export class Builder {
  constructor(name) { this.name = name; this.def = ""; this.nn = false; }
  default(v) { this.def = v; return this; }
  notNull() { this.nn = true; return this; }
}
`,
  "node_modules/deep/c/cols/date.common.d.ts": `import { Builder } from "./base.js";\nexport declare abstract class DateBase extends Builder { defaultNow(): this; }\n`,
  "node_modules/deep/c/cols/date.common.js": `import { Builder } from "./base.js";
export class DateBase extends Builder {
  defaultNow() { return this.default("now()"); }
}
`,
  "node_modules/deep/c/cols/ts.d.ts": `import { DateBase } from "./date.common.js";
export declare class TsB extends DateBase { readonly kind: string; }
export declare function ts(name: string): TsB;
export declare function describe(b: TsB): string;
`,
  "node_modules/deep/c/cols/ts.js": `import { DateBase } from "./date.common.js";
export class TsB extends DateBase { constructor(n) { super(n); this.kind = "date"; } }
export function ts(n) { return new TsB(n); }
export function describe(b) { return [b.name, b.kind, b.def, b.nn, b instanceof DateBase].join(":"); }
`,
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
};

const ROWS: Row[] = [
  {
    id: "DEEP-01 a class five imports below the package entry compiles, and a this-returning base method yields the subclass receiver",
    npmStatic: ["deep"],
    files: {
      ...PKG,
      "main.ts": [
        `import { ts, describe } from "deep";`,
        `const a = ts("created_at").defaultNow().notNull();`,
        `console.log(describe(a));`,
        `const b = ts("updated_at").notNull();`,
        `console.log(describe(b), a === a.defaultNow());`,
      ].join("\n"),
    },
  },
];

describe("npm-static deep import chain (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("npm-static deep import chain (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("npm-static deep import chain: a subclass overriding the this-returning method", () => {
  test("DEEP-02 the base method's result is not narrowed; the override's foreign result stops by name, never a trap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deep02-"));
    const files: Record<string, string> = {
      ...PKG,
      "node_modules/deep/c/cols/ts.d.ts": `${PKG["node_modules/deep/c/cols/ts.d.ts"]}import { Builder } from "./base.js";\nexport declare class Weird extends DateBase {}\nexport declare function weird(name: string): Weird;\nexport declare function info(b: Builder): string;\n`,
      "node_modules/deep/c/cols/ts.js": `import { Builder } from "./base.js";\n${PKG["node_modules/deep/c/cols/ts.js"]}export class Weird extends DateBase { default(v) { return new Builder("other:" + v); } }\nexport function weird(n) { return new Weird(n); }\nexport function info(b) { return [b.name, b instanceof DateBase, b.constructor.name].join(":"); }\n`,
      "node_modules/deep/index.d.ts": `export { ts, describe, TsB, weird, info } from "./a/index.js";\n`,
      "node_modules/deep/index.js": `export { ts, describe, TsB, weird, info } from "./a/index.js";\n`,
      "main.ts": `import { weird, info } from "deep";\nconsole.log(info(weird("w").defaultNow()));`,
    };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["deep"] });
    // Node prints "other:now():false:Builder"; this build refuses by name
    // (at compile time, or a named stop at run time), never a trap.
    if (!res.ok) {
      expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(/Weird|Builder/);
      return;
    }
    throw new Error("DEEP-02 compiled; expected a named refusal");
  }, 600_000);
});
