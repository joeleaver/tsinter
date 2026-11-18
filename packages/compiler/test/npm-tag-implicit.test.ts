/* A tagged template whose tag is an implicit-any JavaScript function
 * (drizzle's `sql(strings, ...params)`, with members merged onto it
 * afterwards) compiles as a per-call-site implicit instance: the strings
 * argument is the site's own frozen array (one object per site, the same on
 * every evaluation, distinct between sites), `.raw` carries the raw spans,
 * and the substitutions keep their own types. Rows run under Node and on
 * both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-tag-implicit");
const pj = (o: unknown): string => JSON.stringify(o);

const TG_DTS = `export interface SQL { readonly text: string; readonly params: unknown[]; }
export declare function sql(strings: TemplateStringsArray, ...params: unknown[]): SQL;
export declare namespace sql {
  function raw(s: string): SQL;
  function empty(): SQL;
}
export declare function tagIdentity(): unknown[];
export declare function rawOf(strings: TemplateStringsArray, ...params: unknown[]): string;
export declare function frozen(strings: TemplateStringsArray): boolean;
`;

const TG_JS = `function sql(strings, ...params) {
  let text = strings[0];
  for (let i = 0; i < params.length; i++) text += "$" + (i + 1) + strings[i + 1];
  return { text, params };
}
((sql2) => {
  function raw(s) { return { text: s, params: [] }; }
  sql2.raw = raw;
  function empty() { return { text: "", params: [] }; }
  sql2.empty = empty;
})(sql || (sql = {}));
const seen = [];
function keep(strings) {
  seen.push(strings);
  return strings.length;
}
export function tagIdentity() {
  seen.length = 0;
  for (let i = 0; i < 3; i++) keep\`same \${i} site\`;
  keep\`same \${0} site\`;
  return [seen[0] === seen[1], seen[1] === seen[2], seen[0] === seen[3], seen.length];
}
function rawOf(strings, ...params) {
  return JSON.stringify([strings.length, strings[0], strings.raw[0], strings.raw.length, params.length]);
}
function frozen(strings) {
  return Object.isFrozen(strings) && Object.isFrozen(strings.raw);
}
export { sql, rawOf, frozen };
`;

const TG: Record<string, string> = {
  "node_modules/tg/package.json": pj({ name: "tg", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/tg/index.d.ts": TG_DTS,
  "node_modules/tg/index.js": TG_JS,
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
};

const ROWS: Row[] = [
  {
    id: "TAG-01 an implicit-any rest-parameter tag (with members merged onto it) with mixed substitutions, a nested tag result and zero substitutions",
    npmStatic: ["tg"],
    files: {
      ...TG,
      "main.ts": [
        `import { sql } from "tg";`,
        `const id = 7;`,
        `const name = "ann";`,
        `const inner = sql\`now()\`;`,
        `const q = sql\`select * from t where id = \${id} and name = \${name} and at > \${inner}\`;`,
        `console.log(q.text, JSON.stringify(q.params));`,
        `const z = sql\`select 1\`;`,
        `console.log(z.text, z.params.length);`,
      ].join("\n"),
    },
  },
  {
    id: "TAG-02 the strings array is one object per site: the same across a loop, distinct between two sites with identical text",
    npmStatic: ["tg"],
    files: {
      ...TG,
      "main.ts": `import { tagIdentity } from "tg";\nconsole.log(JSON.stringify(tagIdentity()));`,
    },
  },
  {
    id: "TAG-03 .raw carries the raw spans: escapes cooked versus raw, \\u sequences, and a frozen array",
    npmStatic: ["tg"],
    files: {
      ...TG,
      "main.ts": [
        `import { rawOf, frozen } from "tg";`,
        `console.log(rawOf\`a\\nb\${1}c\`);`,
        `console.log(rawOf\`\\u0041\\u{1F600}\\t\`);`,
        `console.log(frozen\`x\`);`,
      ].join("\n"),
    },
  },
];

describe("implicit-any JavaScript tags (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("implicit-any JavaScript tags (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("implicit-any JavaScript tags: a write to the strings array refuses by name", () => {
  test("TAG-04 a tag that writes its strings array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tag04-"));
    const files: Record<string, string> = {
      ...TG,
      "node_modules/tg/index.js": `${TG_JS}\nexport function bad(strings) { strings[0] = "x"; return strings[0]; }\n`,
      "node_modules/tg/index.d.ts": `${TG_DTS}\nexport declare function bad(strings: TemplateStringsArray): string;\n`,
      "main.ts": `import { bad } from "tg";\nconsole.log(bad\`y\`);`,
    };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["tg"] });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(/writing a tag function's strings array/);
  }, 600_000);
});

describe("implicit-any JavaScript tags: an invalid escape (cooked undefined) refuses by name", () => {
  test("TAG-05 an invalid escape in a tagged template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tag05-"));
    const files: Record<string, string> = { ...TG, "main.ts": `import { rawOf } from "tg";\nconsole.log(rawOf\`\\unicode\`);` };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["tg"] });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(/invalid escape sequences/);
  }, 600_000);
});
