/* SEMANTICS.md S133 (k), callable amendment: a viewed package's declared
 * CALLABLE interface with members (postgres.js's `Sql<T>`: a generic call
 * signature, also a template tag, with generic and plain methods) is the
 * implementation's own dynamic value. Calls of it (plain and as a tag) and
 * its member calls dispatch dynamically; results cross into the declared
 * types at the use. The row package is a miniature postgres. Rows run under
 * Node and on both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRow, nativeRun, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-declared-callable");
const pj = (o: unknown): string => JSON.stringify(o);

const PG_DTS = (countType: string): string => `export interface PendingQuery<T> extends Promise<T> {
  readonly text: string;
}
export interface Sql<TTypes extends Record<string, unknown> = {}> {
  <T extends readonly unknown[] = Record<string, unknown>[]>(template: TemplateStringsArray, ...parameters: unknown[]): PendingQuery<T>;
  unsafe<T extends readonly unknown[] = Record<string, unknown>[]>(query: string, parameters?: unknown[]): PendingQuery<T>;
  end(options?: { timeout?: number }): Promise<void>;
  readonly max: number;
  readonly count: ${countType};
}
export interface Options { max?: number }
declare function postgres(url: string, options?: Options): Sql<{}>;
export default postgres;
`;

// postgres.js keeps its Query (a Promise subclass) in its own module.
const PG_QUERY_JS = `export class Query extends Promise {
  constructor(text, rows) {
    let resolve;
    super((a) => { resolve = a; });
    this.text = text;
    resolve(rows);
  }
  static get [Symbol.species]() { return Promise; }
}
`;

const PG_JS = `import { Query } from "./query.js";
function pending(text, rows) {
  return new Query(text, rows);
}
export default function postgres(url, opts) {
  const log = [];
  const max = opts && opts.max !== undefined ? opts.max : 10;
  function sql(strings, ...params) {
    let text = strings[0];
    for (let i = 0; i < params.length; i++) text += "$" + (i + 1) + strings[i + 1];
    log.push(text);
    return pending(text, [{ text, params }]);
  }
  function unsafe(query, parameters) {
    log.push(query);
    return pending(query, [{ count: log.length, parameters: parameters || [] }]);
  }
  async function end(o) {
    log.push("end:" + (o && o.timeout !== undefined ? o.timeout : "none"));
  }
  return Object.assign(sql, { unsafe, end, max, count: "not a number" });
}
`;

const PG = (countType = "number"): Record<string, string> => ({
  "node_modules/pg/package.json": pj({ name: "pg", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/pg/index.d.ts": PG_DTS(countType),
  "node_modules/pg/index.js": PG_JS,
  "node_modules/pg/query.js": PG_QUERY_JS,
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", target: "es2022", skipLibCheck: true, noEmit: true } }),
});

const MAIN = [
  `import postgres from "pg";`,
  `const sql = postgres("postgres://h/db", { max: 2 });`,
  `async function migrate(s: ReturnType<typeof postgres>): Promise<number> {`,
  `  await s.unsafe("BEGIN");`,
  `  const rows = await s.unsafe<{ count: number }[]>("SELECT count(*)");`,
  `  return rows[0]!.count;`,
  `}`,
  `const id = 7;`,
  `const q = sql\`select * from t where id = \${id}\`;`,
  `console.log(q.text, typeof sql.unsafe, sql.max);`,
  `async function show(p: typeof q): Promise<void> {`,
  `  const r = await p;`,
  `  console.log(JSON.stringify(r));`,
  `}`,
  `await show(q);`,
  `console.log(await migrate(sql));`,
  `const held: ReturnType<typeof postgres>[] = [sql];`,
  `console.log(held[0] === sql);`,
  `await sql.end({ timeout: 0 });`,
  `console.log("ended");`,
].join("\n");

const ROWS: Row[] = [
  {
    id: "DCALL-01 a declared callable interface: a tag call, a generic method with a type argument, a plain method, identity in an array",
    npmStatic: ["pg"],
    files: { ...PG(), "main.ts": MAIN },
  },
];

describe("S133 (k) callable: a declared callable interface over a dynamic implementation (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133 (k) callable: a declared callable interface over a dynamic implementation (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("S133 (k) callable: a declared primitive member the implementation does not produce stops by name", () => {
  test("DCALL-02 `count` declared number, implemented as a string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dcall02-"));
    const files: Record<string, string> = { ...PG("number"), "main.ts": `import postgres from "pg";\nconst sql = postgres("u");\nconsole.log("before");\nconst n: number = sql.count;\nconsole.log(n + 1);` };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["pg"] });
    if (!res.ok) throw new Error(`DCALL-02 refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
    const got = await nativeRun(res.binaryPath!, []);
    expect(got.stdout, got.stderr).toBe("before\n");
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(/expected number, got string/);
  }, 600_000);
});
