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
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133 (k): a declared interface over a dynamic implementation (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
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
