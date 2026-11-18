/* SEMANTICS.md S133 (l), "a declared class the program only types
 * against": a class only a viewed package's declarations declare, which the
 * program's own sources never construct, extend or implement, is the
 * implementation's own dynamic value on the program side (drizzle's
 * PgColumn: pgTable(...) builds its columns in drizzle's JavaScript with
 * builders and Object.assign). Identity is kept, members dispatch
 * dynamically, results cross into the declared member types at the use; a
 * class the program constructs, extends or implements keeps its S115 view.
 * The row package is a miniature drizzle. Rows run under Node and on both
 * WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRow, nativeRun, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-declared-class-dynamic");
const pj = (o: unknown): string => JSON.stringify(o);

const ORM_DTS = (nameType: string): string => `export declare abstract class Column {
  readonly name: string;
  readonly sqlType: ${nameType};
  readonly notNullFlag: boolean;
  readonly enumValues: string[] | undefined;
  readonly hasDefault: boolean;
  readonly table: Table;
  getSQLType(): string;
}
export declare abstract class PgColumn extends Column {
  readonly isPg: boolean;
}
export declare class Table {
  readonly tableName: string;
  constructor(tableName: string);
}
export declare class SQL {
  readonly chunks: unknown[];
  toString(): string;
}
export interface ReferenceConfig {
  onDelete?: "cascade" | "restrict";
}
export declare class ColumnBuilder {
  notNull(): ColumnBuilder;
  primaryKey(): ColumnBuilder;
  defaultRandom(): ColumnBuilder;
  $defaultFn(fn: () => unknown): ColumnBuilder;
  $default(fn: () => unknown): ColumnBuilder;
  references(ref: () => PgColumn, config?: ReferenceConfig): ColumnBuilder;
}
export declare function uuid(name: string): ColumnBuilder;
export declare function text(name: string): ColumnBuilder;
export type BuiltTable<T> = Table & { [K in keyof T]: PgColumn };
export declare function pgTable<T extends Record<string, ColumnBuilder>>(name: string, columns: T): BuiltTable<T>;
export declare function eq(column: PgColumn, value: unknown): SQL;
export declare function getReferences(table: Table): string[];
export declare class Counter {
  constructor(start: number);
  next(): number;
}
`;

const ORM_JS = `export class Table {
  constructor(tableName) {
    this.tableName = tableName;
    this.refs = [];
  }
}
export class Column {
  constructor(table, config) {
    this.table = table;
    this.name = config.name;
    this.notNullFlag = config.notNull;
    this.sqlType = config.sqlType;
    this.hasDefault = config.defaultFn !== undefined;
  }
  enumValues = void 0;
  getSQLType() {
    return this.sqlType;
  }
}
export class PgColumn extends Column {
  constructor(table, config) {
    super(table, config);
    this.isPg = true;
    for (const r of config.refs) table.refs.push({ from: config.name, to: r });
  }
}
class PgUuid extends PgColumn {}
class PgText extends PgColumn {}
export class ColumnBuilder {
  constructor(name, sqlType) {
    this.config = { name, sqlType, notNull: false, refs: [] };
  }
  notNull() {
    this.config.notNull = true;
    return this;
  }
  primaryKey() {
    this.config.notNull = true;
    return this;
  }
  references(ref, config = {}) {
    this.config.refs.push(() => {
      const col = ref();
      return col.table.tableName + "." + col.name + (config.onDelete ? " on delete " + config.onDelete : "");
    });
    return this;
  }
  defaultRandom() {
    return this;
  }
  $defaultFn(fn) {
    this.config.defaultFn = fn;
    return this;
  }
  $default = this.$defaultFn;
  build(table) {
    return this.config.sqlType === "uuid" ? new PgUuid(table, this.config) : new PgText(table, this.config);
  }
}
export function uuid(name) {
  return new ColumnBuilder(name, "uuid");
}
export function text(name) {
  return new ColumnBuilder(name, "text");
}
export function pgTable(name, columns) {
  /** @type {Record<string, any>} */
  const table = {};
  table.tableName = name;
  table.refs = [];
  for (const key of Object.keys(columns)) table[key] = columns[key].build(table);
  return table;
}
export class SQL {
  constructor(chunks) {
    this.chunks = chunks;
  }
  toString() {
    return this.chunks.map((c) => (c instanceof Column ? '"' + c.table.tableName + '"."' + c.name + '"' : JSON.stringify(c))).join(" = ");
  }
}
export function eq(column, value) {
  return new SQL([column, value]);
}
export class Counter {
  constructor(start) {
    this.n = start;
  }
  next() {
    return this.n++;
  }
}
export function getReferences(table) {
  return table.refs.map((r) => r.from + " -> " + r.to());
}
`;

const ORM = (nameType = "string"): Record<string, string> => ({
  "node_modules/orm/package.json": pj({ name: "orm", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/orm/index.d.ts": ORM_DTS(nameType),
  "node_modules/orm/index.js": ORM_JS,
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
});

const SCHEMA = [
  `import { pgTable, uuid, text, eq, getReferences, type PgColumn } from "orm";`,
  `export const companies = pgTable("companies", {`,
  `  id: uuid("id").primaryKey().defaultRandom(),`,
  `  name: text("name").notNull().$default(() => "unnamed"),`,
  `});`,
  `export const agents = pgTable("agents", {`,
  `  id: uuid("id").primaryKey().defaultRandom(),`,
  `  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),`,
  `  ownerId: uuid("owner_id").references(() => companies.id),`,
  `});`,
].join("\n");

const ROWS: Row[] = [
  {
    id: "DC-01 the references(() => X.id) shape: a column read off a built table crosses into a declared PgColumn result",
    npmStatic: ["orm"],
    files: {
      ...ORM(),
      "main.ts": [
        SCHEMA,
        `console.log(getReferences(agents).join("; "));`,
        `console.log(agents.tableName, companies.tableName);`,
      ].join("\n"),
    },
  },
  {
    id: "DC-02 eq() and .notNull() keep the column's identity; declared members read through the dynamic column",
    npmStatic: ["orm"],
    files: {
      ...ORM(),
      "main.ts": [
        SCHEMA,
        `const col: PgColumn = agents.companyId;`,
        `console.log(col === agents.companyId, col.name, col.notNullFlag, col.isPg, col.getSQLType());`,
        `console.log(col.table === agents, col.table.tableName);`,
        `console.log(companies.name.hasDefault, companies.id.hasDefault, companies.id.enumValues === undefined);`,
        `const cond = eq(agents.companyId, "c-1");`,
        `console.log(cond.chunks[0] === agents.companyId, cond.toString());`,
        `function pick(c: PgColumn, flag: boolean): PgColumn {`,
        `  return flag ? c : companies.id;`,
        `}`,
        `console.log(pick(agents.ownerId, true).name, pick(agents.ownerId, false) === companies.id);`,
        `const cols: PgColumn[] = [companies.id, companies.name];`,
        `console.log(cols.map((c) => c.name).join(","), cols[1] === companies.name);`,
      ].join("\n"),
    },
  },
  {
    id: "DC-03 a declared class the program constructs keeps its typed view (Counter), beside the dynamic PgColumn",
    npmStatic: ["orm"],
    files: {
      ...ORM(),
      "main.ts": [
        SCHEMA,
        `import { Counter } from "orm";`,
        `const c = new Counter(5);`,
        `console.log(c.next(), c.next(), c instanceof Counter, companies.id.table.tableName);`,
      ].join("\n"),
    },
  },
];

describe("S133 (l): a declared class the program only types against (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133 (l): a declared class the program only types against (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

/** Compile `main.ts` over the orm package and return the diagnostics, or the
 * native run's output when it compiles. */
async function build(nameType: string, main: string): Promise<{ diags: string } | { stdout: string; stderr: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "dc-"));
  const files: Record<string, string> = { ...ORM(nameType), "main.ts": main };
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), src);
  }
  const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["orm"] });
  if (!res.ok) return { diags: res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n") };
  return nativeRun(res.binaryPath!, []);
}

describe("S133 (l): refusals by name", () => {
  test("DC-04 a declared primitive member the implementation does not produce stops by name", async () => {
    const got = await build("number", `${SCHEMA}\nconsole.log("before");\nconst n: number = companies.id.sqlType;\nconsole.log(n + 1);`);
    // The false claim surfaces at the first crossing that checks it: the
    // implementation's own field write, typed by the declaration, while
    // the schema builds (S133: "a wrong claim surfaces only where a
    // crossing checks it"). Never a wrong value printed.
    if ("diags" in got) throw new Error(`DC-04 refused: ${got.diags}`);
    expect(got.stdout).not.toMatch(/NaN|uuid1/);
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(/expected number at \$, got string/);
  }, 600_000);

  test("DC-05 instanceof against such a class is refused by name", async () => {
    const got = await build("string", `${SCHEMA}\nimport { PgColumn as PgColumnClass } from "orm";\nconsole.log(companies.id instanceof PgColumnClass);`);
    expect("diags" in got ? got.diags : "").toMatch(/instanceof .*PgColumn.*S133/);
  }, 600_000);
});

describe("S133 (l): a declared class the program extends or implements keeps its S115 view", () => {
  test.for([
    ["DC-06 extends", `class Mine extends PgColumnClass {}\nconsole.log(typeof Mine);`],
    ["DC-07 implements", `class Mine implements PgColumnClass { readonly name = "m"; readonly sqlType = "x"; readonly enumValues: string[] | undefined = undefined; readonly hasDefault = false; readonly notNullFlag = false; readonly isPg = false; readonly table = companies; getSQLType(): string { return "x"; } }\nconsole.log(new Mine().name);`],
  ] as const)("%s", async ([id, extra]) => {
    // The program names PgColumn in a heritage clause: PgColumn keeps its
    // view (the pre-(l) mapping), and the program runs as before (l).
    await checkRow(scratch, {
      id,
      npmStatic: ["orm"],
      files: { ...ORM(), "main.ts": `${SCHEMA}\nimport { PgColumn as PgColumnClass } from "orm";\n${extra}\nconsole.log(getReferences(agents).length);` },
    }, "wasm-native");
  }, 600_000);
});

/** Compile a plain TypeScript program (no package) and return its diagnostics. */
async function buildPlain(main: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dcm-"));
  writeFileSync(join(dir, "package.json"), pj({ type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }));
  writeFileSync(join(dir, "main.ts"), main);
  const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  return res.ok ? "compiled" : res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n");
}

describe("S133 (l): a method read as a value outside a package's alias field keeps the refusal (identity would differ from Node)", () => {
  test.for([
    ["DC-08 listener identity: on/off with a method value", `import { EventEmitter } from "node:events";\nclass W { n = 0; tick(): void { this.n++; } }\nconst w = new W();\nconst r = new EventEmitter();\nr.on("t", w.tick);\nr.off("t", w.tick);\nconsole.log(r.listenerCount("t"));`],
    ["DC-09 Set of one method read twice", `class W { tick(): number { return 1; } }\nconst w = new W();\nconsole.log(new Set([w.tick, w.tick]).size);`],
    ["DC-10 a TypeScript field aliasing a method", `class A { h = this.get; get(): number { return 1; } }\nconst a = new A();\nconsole.log(a.h === a.get);`],
  ] as const)("%s", async ([, main]) => {
    expect(await buildPlain(main)).toMatch(/bound method references/);
  }, 600_000);
});

describe("S133 (l): a package's method alias field keeps Node's identity (one function per declaring class and method)", () => {
  test.for(["wasm", "wasm-native"] as const)("DC-11 alias identity on %s", async (lane) => {
    await checkRow(scratch, {
      id: `DC-11-${lane}`,
      npmStatic: ["orm"],
      files: {
        ...ORM(),
        "main.ts": `${SCHEMA}\nconst b = uuid("x");\nconst o = uuid("y");\nconsole.log(b.$default === b.$defaultFn, b.$default === o.$default, b.$defaultFn === o.$defaultFn, typeof b.$default);\nb.$default(() => 1);\nconsole.log(b === b.$default(() => 2));`,
      },
    }, lane);
  }, 600_000);
});

describe("S115 (iv): one method function per declaring class across view factories", () => {
  test.for(["wasm", "wasm-native"] as const)("DC-12 an inherited method read through two classes' views on %s", async (lane) => {
    await checkRow(scratch, {
      id: `DC-12-${lane}`,
      npmStatic: ["inh"],
      files: {
        "node_modules/inh/package.json": pj({ name: "inh", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
        "node_modules/inh/index.d.ts": `export declare class Base { tag: string; mark(): this; }\nexport declare class Sub extends Base { extra(): this; }\nexport declare function base(): Base;\nexport declare function sub(): Sub;\n`,
        "node_modules/inh/index.js": `export class Base { constructor() { this.tag = ""; } mark() { this.tag += "m"; return this; } }\nexport class Sub extends Base { extra() { this.tag += "x"; return this; } }\nexport function base() { return new Base(); }\nexport function sub() { return new Sub(); }\n`,
        "package.json": pj({ type: "module" }),
        "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
        "main.ts": `import { base, sub } from "inh";\nconst b = base();\nconst s = sub();\nconsole.log(b.mark().tag, s.mark().extra().tag, b.mark === s.mark, s.extra === sub().extra);`,
      },
    }, lane);
  }, 600_000);
});
