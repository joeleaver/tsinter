/* SEMANTICS.md S133 (k), "a declared interface over a dynamic
 * implementation": a viewed package's declared interface with function
 * members (zod's ZodString, built per instance by `$constructor`, with
 * overloaded and generic methods and a self-referential `~standard`) is
 * the implementation's own dynamic value on the program side. Member
 * reads and calls dispatch dynamically; results cross into the declared
 * types at the use. zod merges each interface with a same-named const
 * (`interface ZodString` + `const ZodString`); the row package does too.
 * Rows run under Node and on both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRow, nativeRun, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-declared-dynamic");
const pj = (o: unknown): string => JSON.stringify(o);

const DECL_DTS = (kindType: string): string => `export interface StandardSchema<S> {
  readonly vendor: string;
  readonly self: S;
}
export interface SchemaError {
  readonly issues: { message: string }[];
  format(): string;
}
export type SafeResult<T> = { success: true; data: T } | { success: false; error: SchemaError };
export interface Schema<T> {
  readonly "~standard": StandardSchema<this>;
  readonly kind: ${kindType};
  readonly steps: string;
  parse(x: unknown): T;
  safeParse(x: unknown): SafeResult<T>;
  optional(): Schema<T | undefined>;
  email(params?: string | { message?: string }): Schema<T>;
  refine<U extends T>(check: (v: T) => v is U): Schema<U>;
  trim(): Schema<T>;
  toLowerCase(): Schema<T>;
  startsWith(prefix: string): Schema<T>;
}
export declare function string(): Schema<string>;
export declare function number(): Schema<number>;
export declare const Schema: { readonly typeName: string };
export declare function person(): Schema<{ name: string; age: number }>;
`;

const DECL_JS = `function $constructor(name, init) {
  function Made(def) {
    init(this, def);
  }
  Object.defineProperty(Made, "name", { value: name });
  return (def) => new Made(def);
}
function issue(message) {
  const e = { issues: [{ message }] };
  e.format = () => e.issues.map((i) => i.message).join("; ");
  return e;
}
function matches(kind, x) {
  if (kind === "object") return typeof x === "object" && x !== null;
  return kind === "string" ? typeof x === "string" : typeof x === "number";
}
const make = $constructor("Schema", (inst, def) => {
  inst.kind = def.kind;
  inst.parse = (x) => {
    if (!matches(def.kind, x)) throw new Error("expected " + def.kind);
    return x;
  };
  inst.safeParse = (x) => (matches(def.kind, x) ? { success: true, data: x } : { success: false, error: issue("expected " + def.kind) });
  inst.optional = () => make({ kind: def.kind });
  inst.email = (params) => make({ kind: def.kind, message: params });
  inst.refine = (check) => make({ kind: def.kind, check });
  inst.trim = () => make({ kind: def.kind, steps: (def.steps ?? "") + "trim;" });
  inst.toLowerCase = () => make({ kind: def.kind, steps: (def.steps ?? "") + "lower;" });
  inst.startsWith = (prefix) => make({ kind: def.kind, steps: (def.steps ?? "") + "starts:" + prefix + ";" });
  inst.steps = def.steps ?? "";
  inst["~standard"] = { vendor: "decl", self: inst };
});
export function string() {
  return make({ kind: "string" });
}
export function number() {
  return make({ kind: "number" });
}
export const Schema = { typeName: "Schema" };
export function person() {
  return make({ kind: "object" });
}
`;

const DECL = (kindType = "string"): Record<string, string> => ({
  "node_modules/decl/package.json": pj({ name: "decl", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/decl/index.d.ts": DECL_DTS(kindType),
  "node_modules/decl/index.js": DECL_JS,
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
});

// A postgres.js-shaped package (paperclip's `postgres@3.4.9` surface): the
// client is a JS function carrying properties, declared as a CALLABLE
// interface (a generic call signature, also a template tag) with a generic
// `unsafe<T>` whose type argument appears only in its result, plain
// methods, and a reserved connection whose interface extends the client's.
const PG_DTS = (unsafeResult: string): string => `export type Row = Record<string, unknown>;
export interface PendingQuery<T> extends Promise<T> {}
export interface Sql<TTypes extends Record<string, unknown> = {}> {
  <T extends readonly unknown[] = Row[]>(template: TemplateStringsArray, ...parameters: unknown[]): PendingQuery<T>;
  unsafe<T extends any[] = Row[]>(query: string, parameters?: unknown[]): PendingQuery<${unsafeResult}>;
  reserve(): Promise<ReservedSql<TTypes>>;
  end(options?: { timeout?: number }): Promise<void>;
}
export interface ReservedSql<TTypes extends Record<string, unknown> = {}> extends Sql<TTypes> {
  release(): void;
}
declare function postgres(url: string): Sql<{}>;
export default postgres;
`;

// (The client's members are defined with Object.defineProperties; real
// postgres.js uses Object.assign onto the function, a package-side form
// this file does not cover.)
const PG_JS = `function client(url) {
  let calls = 0;
  function sql(strings, ...params) {
    let text = strings[0];
    for (let i = 0; i < params.length; i++) text += "$" + (i + 1) + strings[i + 1];
    calls++;
    return Promise.resolve([{ text, params }]);
  }
  function unsafe(query, parameters) {
    calls++;
    if (query === "LIE") return Promise.resolve("not rows");
    return Promise.resolve(query.startsWith("SELECT") ? [{ n: calls, q: query, p: parameters ?? [] }] : []);
  }
  async function end(o) {
    console.log("end", url, o ? o.timeout : "none", calls);
  }
  function release() {
    console.log("released", url);
  }
  Object.defineProperties(sql, {
    unsafe: { value: unsafe, enumerable: true },
    end: { value: end, enumerable: true },
    release: { value: release, enumerable: true },
  });
  return sql;
}
export default function postgres(url) {
  const sql = client(url);
  async function reserve() {
    return client(url + "#reserved");
  }
  Object.defineProperty(sql, "reserve", { value: reserve, enumerable: true });
  return sql;
}
`;

const PG =(unsafeResult = "T"): Record<string, string> => ({
  "node_modules/pg/package.json": pj({ name: "pg", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/pg/index.d.ts": PG_DTS(unsafeResult),
  "node_modules/pg/index.js": PG_JS,
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", target: "es2022", skipLibCheck: true, noEmit: true } }),
});

const PG_ROWS: Row[] = [
  {
    id: "DD-07 a declared callable interface (postgres's Sql<{}>): a tagged-template call, unsafe<T> with typed field reads, unsafe() with its default type argument, end()",
    npmStatic: ["pg"],
    files: {
      ...PG(),
      "main.ts": [
        `import postgres from "pg";`,
        `const sql = postgres("u1");`,
        `async function run(s: typeof sql): Promise<void> {`,
        `  const id = 7;`,
        `  const tagged = await s\`select * from t where id = \${id}\`;`,
        `  console.log(JSON.stringify(tagged));`,
        `  const rows = await s.unsafe<{ n: number; q: string }[]>("SELECT n", [1, "a"]);`,
        `  console.log(rows.length, rows[0]!.n + 1, rows[0]!.q.toUpperCase());`,
        `  await s.unsafe("BEGIN");`,
        `  const none = await s.unsafe<never[]>("COMMIT");`,
        `  console.log(none.length);`,
        `}`,
        `await run(sql);`,
        `await sql.end({ timeout: 0 });`,
        `await sql.end();`,
      ].join("\n"),
    },
  },
  {
    id: "DD-08 Sql<{}> as a declared type: a parameter, a class field, an array element and a Map<string, Set<WeakRef<Sql<{}>>>> registry, with identity kept",
    npmStatic: ["pg"],
    files: {
      ...PG(),
      "main.ts": [
        `import postgres, { type Sql } from "pg";`,
        `async function first(s: Sql<{}>, q: string): Promise<number> {`,
        `  const r = await s.unsafe<{ n: number }[]>(q);`,
        `  return r[0]!.n;`,
        `}`,
        `class Holder {`,
        `  readonly sql: Sql<{}>;`,
        `  readonly name: string;`,
        `  constructor(sql: Sql<{}>, name: string) {`,
        `    this.sql = sql;`,
        `    this.name = name;`,
        `  }`,
        `  async count(): Promise<number> { return first(this.sql, "SELECT " + this.name); }`,
        `}`,
        `const sql = postgres("u2");`,
        `const h = new Holder(sql, "h");`,
        `console.log(await h.count(), h.sql === sql, await first(sql, "SELECT x"));`,
        `const all: Sql<{}>[] = [sql, postgres("u3")];`,
        `console.log(all.length, all[0] === sql, all[1] === sql);`,
        `const registry = new Map<string, Set<WeakRef<Sql<{}>>>>();`,
        `function register(key: string, s: Sql<{}>): void {`,
        `  let set = registry.get(key);`,
        `  if (set === undefined) { set = new Set(); registry.set(key, set); }`,
        `  set.add(new WeakRef(s));`,
        `}`,
        `register("a", sql);`,
        `register("a", all[1]!);`,
        `for (const ref of registry.get("a")!) {`,
        `  const s = ref.deref();`,
        `  console.log(s === sql, s === undefined);`,
        `}`,
        `await h.sql.end();`,
      ].join("\n"),
    },
  },
  {
    id: "DD-09 paperclip's SqlExecutor = Pick<ReturnType<typeof postgres>, \"unsafe\">, and an Omit: calls through the alias parameter, identity across it, and a tagged-template call on the same value",
    npmStatic: ["pg"],
    files: {
      ...PG(),
      "main.ts": [
        `import postgres from "pg";`,
        `type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;`,
        `type NoEnd = Omit<ReturnType<typeof postgres>, "end" | "reserve">;`,
        `const sql = postgres("u4");`,
        `async function migrate(ex: SqlExecutor): Promise<number> {`,
        `  await ex.unsafe("BEGIN");`,
        `  const rows = await ex.unsafe<{ n: number }[]>("SELECT n");`,
        `  await ex.unsafe("COMMIT");`,
        `  return rows[0]!.n * 10;`,
        `}`,
        `function same(ex: SqlExecutor): boolean {`,
        `  return ex === sql;`,
        `}`,
        `console.log(await migrate(sql), same(sql), same(postgres("u5")));`,
        `async function viaHeld(): Promise<void> {`,
        `  const held: SqlExecutor = sql;`,
        `  const d = await held.unsafe<{ n: number; q: string }[]>("SELECT d");`,
        `  console.log(d[0]!.q, held === sql);`,
        `}`,
        `await viaHeld();`,
        `async function viaOmit(s: NoEnd): Promise<string> {`,
        `  const u = await s.unsafe<{ q: string }[]>("SELECT o");`,
        `  return u[0]!.q + " " + (s === sql);`,
        `}`,
        `console.log(await viaOmit(sql));`,
        `async function tag(s: typeof sql): Promise<string> {`,
        `  const t = await s\`insert \${"x"}\`;`,
        `  return JSON.stringify(t);`,
        `}`,
        `console.log(await tag(sql));`,
        `await sql.end();`,
      ].join("\n"),
    },
  },
  {
    id: "DD-10 reserve() then release() (postgres's ReservedSql<{}>, an interface extending the callable Sql<{}>)",
    npmStatic: ["pg"],
    files: {
      ...PG(),
      "main.ts": [
        `import postgres, { type ReservedSql, type Sql } from "pg";`,
        `const pool: Sql<{}> = postgres("u6");`,
        `async function withReserved(p: Sql<{}>): Promise<number> {`,
        `  const conn: ReservedSql<{}> = await p.reserve();`,
        `  try {`,
        `    await conn.unsafe("BEGIN");`,
        `    const r = await conn.unsafe<{ n: number }[]>("SELECT r");`,
        `    const t = await conn\`select \${2}\`;`,
        `    console.log(JSON.stringify(t), conn === p);`,
        `    return r[0]!.n;`,
        `  } finally {`,
        `    conn.release();`,
        `  }`,
        `}`,
        `console.log(await withReserved(pool));`,
        `await pool.end({ timeout: 5 });`,
      ].join("\n"),
    },
  },
];

const ROWS: Row[] = [
  {
    id: "DD-01 calls, chains, a typed parameter, the self-referential member and a throw through a declared interface",
    npmStatic: ["decl"],
    files: {
      ...DECL(),
      "main.ts": [
        `import { number, string, type Schema } from "decl";`,
        `const s = string().email("bad address");`,
        `console.log(s.kind, s.parse("a@b"), s.safeParse(1).success);`,
        `function check(sc: Schema<string>, v: unknown): boolean {`,
        `  return sc.safeParse(v).success;`,
        `}`,
        `console.log(check(s, "x"), check(s, 2));`,
        `const n = number().optional();`,
        `console.log(n.safeParse(3).success, n["~standard"].vendor, n["~standard"].self === n);`,
        `const held: Schema<string>[] = [s, string()];`,
        `console.log(held.length, held[0] === s, held[1]!.kind);`,
        `import { Schema as SchemaValue } from "decl";`,
        `console.log(SchemaValue.typeName);`,
        `try {`,
        `  string().parse(5);`,
        `} catch (e) {`,
        `  console.log((e as Error).message);`,
        `}`,
      ].join("\n"),
    },
  },
  {
    id: "DD-03 declared methods named like String.prototype methods are the implementation's own (zod's z.string().trim().toLowerCase())",
    npmStatic: ["decl"],
    files: {
      ...DECL(),
      "main.ts": [
        `import { string } from "decl";`,
        `const s = string().trim().toLowerCase().startsWith("x");`,
        `console.log(s.steps, s.kind, s.safeParse("ok").success);`,
      ].join("\n"),
    },
  },
  {
    id: "DD-05 a safeParse result narrowed by .success (zod's headline pattern)",
    npmStatic: ["decl"],
    files: {
      ...DECL(),
      "main.ts": [
        `import { string, number, type SafeResult } from "decl";`,
        `function show(r: SafeResult<string>): string {`,
        `  if (!r.success) return "error: " + r.error.format() + " (" + r.error.issues.length + ")";`,
        `  return "data: " + r.data.toUpperCase();`,
        `}`,
        `console.log(show(string().safeParse("ok")));`,
        `console.log(show(string().safeParse(5)));`,
        `const n = number().safeParse(41);`,
        `if (n.success) console.log(n.data + 1);`,
        `const bad = number().safeParse("x");`,
        `console.log(bad.success ? "?" : bad.error.issues[0]!.message);`,
      ].join("\n"),
    },
  },
  {
    id: "DD-06 a safeParse result whose data is an object type: fields read off the narrowed data, and the data stored in a typed slot",
    npmStatic: ["decl"],
    files: {
      ...DECL(),
      "main.ts": [
        `import { person } from "decl";`,
        `const r = person().safeParse({ name: "ann", age: 3 });`,
        `if (r.success) {`,
        `  console.log(r.data.name, r.data.age + 1);`,
        `  const p: { name: string; age: number } = r.data;`,
        `  console.log(p.name.toUpperCase(), p.age);`,
        `}`,
        `const bad = person().safeParse(7);`,
        `console.log(bad.success);`,
      ].join("\n"),
    },
  },
];

describe("S133 (k): a declared interface over a dynamic implementation (wasm lane vs Node)", () => {
  test.for([...ROWS, ...PG_ROWS].map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133 (k): a declared interface over a dynamic implementation (wasm-native lane vs Node)", () => {
  test.for([...ROWS, ...PG_ROWS].map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("S133 (k): a declared primitive the implementation does not produce stops by name", () => {
  test("DD-02 `kind` declared number, implemented as a string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd02-"));
    const files: Record<string, string> = {
      ...DECL("number"),
      "main.ts": `import { string } from "decl";\nconst k: number = string().kind;\nconsole.log("before");\nconsole.log(k + 1);`,
    };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["decl"] });
    if (!res.ok) {
      expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(/kind|number/);
      return;
    }
    const got = await nativeRun(res.binaryPath!, []);
    expect(got.stdout).not.toContain("before\nNaN");
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(/number|string/);
  }, 600_000);
});

describe("S133 (k): a declared callable interface whose method result the implementation does not produce stops by name", () => {
  test("DD-11 `unsafe<{ n: number }[]>` declared to settle to rows, implemented as a string, passed to a typed method parameter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd11-"));
    const files: Record<string, string> = {
      ...PG(),
      "main.ts": [
        `import postgres from "pg";`,
        `const sql = postgres("u7");`,
        `console.log("before");`,
        `class C { count(r: { n: number }[]): number { return r.length; } }`,
        `console.log("after", new C().count(await sql.unsafe<{ n: number }[]>("LIE")));`,
      ].join("\n"),
    };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["pg"] });
    if (!res.ok) throw new Error(`DD-11 refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
    const got = await nativeRun(res.binaryPath!, []);
    // Node prints `after 8` (the string's length); the declaration's claim
    // is false for this value, so the program ends where it crosses into the
    // method's typed parameter. (DD-12: a module global holding the result
    // keeps the package's own value and never crosses.)
    expect(got.stdout, got.stderr).toBe("before\n");
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(/array|string/);
  }, 600_000);

  test("DD-12 the same result held by a module global is the package's own value (SEMANTICS.md S125 amendment (K)), matching Node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd12-"));
    const files: Record<string, string> = {
      ...PG(),
      "main.ts": [
        `import postgres from "pg";`,
        `const sql = postgres("u7");`,
        `console.log("before");`,
        `const rows = await sql.unsafe<{ n: number }[]>("LIE");`,
        `console.log("after", rows.length);`,
      ].join("\n"),
    };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["pg"] });
    if (!res.ok) throw new Error(`DD-12 refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
    const got = await nativeRun(res.binaryPath!, []);
    // Node prints the string's length: the global holds the string itself.
    expect(got.stdout, got.stderr).toBe("before\nafter 8\n");
    expect(got.exitCode).toBe(0);
  }, 600_000);
});

describe("S133 (k): a package class instance behind a declared interface whose methods compile per call site", () => {
  test("DD-04 untyped prototype methods of a JavaScript class are members of its view (its default instance)", async () => {
    const row: Row = {
      id: "DD-04",
      npmStatic: ["gp"],
      files: {
        "package.json": pj({ type: "module" }),
        "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
        "node_modules/gp/package.json": pj({ name: "gp", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
        "node_modules/gp/index.d.ts": `export interface Gen<T> { refine(c: (v: T) => boolean): Gen<T>; parse(x: unknown): T; }\nexport declare function gen(): Gen<string>;`,
        "node_modules/gp/index.js": `class GenT { constructor() { this.checks = 0; } refine(c) { this.checks++; return this; } parse(x) { return x; } }\nexport function gen() { return new GenT(); }`,
        "main.ts": `import { gen } from "gp";\nconsole.log("before");\nconst g = gen().refine((v) => v.length > 0);\nconsole.log(g.parse("a"));`,
      },
    };
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
