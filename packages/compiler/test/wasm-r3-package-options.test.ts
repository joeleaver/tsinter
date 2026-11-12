/* R3: per-package compiler options (SEMANTICS.md S136). Each file is
 * checked under its NEAREST tsconfig's adopted options, the way its own
 * package's tsc (and the dev-runner loader) reads it; the whole program
 * still lowers under one program. Rows on synthetic multi-package trees:
 * running rows match Node on both WasmGC lanes; refusing rows name their
 * reason on both lanes. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("r3-pkgopts");
const cfg = (compilerOptions: Record<string, unknown>): string => JSON.stringify({ compilerOptions: { skipLibCheck: true, ...compilerOptions } });

/** The entry's package is stricter than the library's. */
const STRICT_APP = cfg({ strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true });
const LAX_LIB = cfg({ strict: true });

const RUNS: Row[] = [
  {
    id: "R3-01 a library valid under its own looser tsconfig compiles inside a stricter app",
    nodeTypes: false,
    files: {
      "tsconfig.json": STRICT_APP,
      "lib/tsconfig.json": LAX_LIB,
      "lib/first.ts": `const xs = [1, 2, 3];
const unused = 0;
export const first: number = xs[0];
export interface Opts { label?: string }
export const opts: Opts = { label: undefined };`,
      "main.ts": `import { first, opts } from "./lib/first.ts";
console.log(first, opts.label === undefined, "label" in opts);`,
    },
  },
  {
    id: "R3-02 a stricter library inside a looser app: its own knobs apply to its files only",
    nodeTypes: false,
    files: {
      "tsconfig.json": LAX_LIB,
      "lib/tsconfig.json": STRICT_APP,
      "lib/sum.ts": `export function sum(xs: readonly number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}`,
      "main.ts": `import { sum } from "./lib/sum.ts";
const xs = [4, 5];
const unusedHere = 1;
const second: number = xs[1];
console.log(sum(xs), second);`,
    },
  },
  {
    id: "R3-03 a type-shaping difference in a file only reached through a type import does not refuse",
    nodeTypes: false,
    files: {
      "tsconfig.json": cfg({ strict: true }),
      "lib/tsconfig.json": cfg({ strict: true, strictFunctionTypes: false }),
      "lib/handler.ts": `export type Handler = (x: string | number) => string;
export const handler: Handler = (x: string) => x.toUpperCase();`,
      "main.ts": `import type { Handler } from "./lib/handler.ts";
const h: Handler = (x) => String(x);
console.log(h(3), h("a"));`,
    },
  },
  {
    id: "R3-04 legacy-decorated code reached only through a type import (n8n's @n8n/config shape)",
    nodeTypes: false,
    files: {
      "tsconfig.json": cfg({ strict: true }),
      "config/tsconfig.json": cfg({ strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, strictPropertyInitialization: false }),
      "config/index.ts": `export const Env = (name: string): PropertyDecorator => (_target: object, _key: string | symbol) => {
  void name;
};
export const Config: ClassDecorator = (_c: Function) => {};
@Config
export class LoggingConfig {
  @Env("N8N_LOG_LEVEL")
  level: string = "info";
}
export type LogScope = "concurrency" | "pubsub";`,
      "main.ts": `import type { LogScope } from "./config/index.ts";
const scopes: LogScope[] = ["pubsub", "concurrency"];
console.log(scopes.join(","));`,
    },
  },
  {
    id: "R3-05 a library's check world sees the entry's included declaration files",
    nodeTypes: false,
    files: {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ["global.d.ts", "main.ts"] }),
      "global.d.ts": "type Mode = \"fast\" | \"slow\";",
      "lib/tsconfig.json": cfg({ strict: true, noImplicitReturns: true }),
      "lib/w.ts": "export function mode(fast: boolean): Mode { return fast ? \"fast\" : \"slow\"; }",
      "main.ts": `import { mode } from "./lib/w.ts";
console.log(mode(true), mode(false));`,
    },
  },
  {
    id: "R3-06 scriptc's own tighter lib (JSON.parse: unknown) is not a package typing difference",
    nodeTypes: false,
    files: {
      "tsconfig.json": cfg({ strict: true }),
      "lib/tsconfig.json": cfg({ strict: true, strictFunctionTypes: false }),
      "lib/parse.ts": `export function parse(s: string): { a: number } {
  return JSON.parse(s);
}`,
      "main.ts": `import { parse } from "./lib/parse.ts";
console.log(parse('{"a":1}').a);`,
    },
  },
  {
    id: "R3-07 each package is checked under its own lib (n8n's @n8n/tournament: no DOM in its lib)",
    files: {
      "tsconfig.json": cfg({ strict: true, lib: ["es2022", "dom"] }),
      "lib/tsconfig.json": cfg({ strict: true, lib: ["es2019"] }),
      "lib/types.ts": `// @ts-expect-error no DOM in this package's lib
export type Host = HTMLElement | null;
export type Mode = "fast" | "slow";`,
      "main.ts": `import type { Mode } from "./lib/types.ts";
const m: Mode = "fast";
console.log(m);`,
    },
  },
];

const LEGACY = cfg({ strict: true, experimentalDecorators: true, emitDecoratorMetadata: true });
const legacyRow = (id: string, cls: string, where: "entry" | "lib"): Row =>
  where === "entry"
    ? { id, nodeTypes: false, files: { "tsconfig.json": LEGACY, "main.ts": `${cls}\nconsole.log(typeof C);` } }
    : {
        id,
        nodeTypes: false,
        files: {
          "tsconfig.json": cfg({ strict: true }),
          "lib/tsconfig.json": LEGACY,
          "lib/c.ts": `${cls}\nexport { C };`,
          "main.ts": `import { C } from "./lib/c.ts";\nconsole.log(typeof C);`,
        },
      };

const REFUSES: { row: Row; expected: string }[] = [
  {
    row: {
      id: "R3-10 the app's own errors still gate under its own knobs",
      nodeTypes: false,
      files: {
        "tsconfig.json": STRICT_APP,
        "lib/tsconfig.json": LAX_LIB,
        "lib/one.ts": "export const one = 1;",
        "main.ts": `import { one } from "./lib/one.ts";
const xs = [one];
const n: number = xs[0];
console.log(n);`,
      },
    },
    expected: "Type 'number | undefined' is not assignable to type 'number'.",
  },
  {
    row: {
      id: "R3-11 a library's own stricter knob gates its files",
      nodeTypes: false,
      files: {
        "tsconfig.json": LAX_LIB,
        "lib/tsconfig.json": cfg({ strict: true, noImplicitReturns: true }),
        "lib/pick.ts": `export function pick(b: boolean): number | undefined {
  if (b) return 1;
}`,
        "main.ts": `import { pick } from "./lib/pick.ts";
console.log(pick(true));`,
      },
    },
    expected: "Not all code paths return a value.",
  },
  {
    row: {
      id: "R3-12 a type-shaping difference in a file Node evaluates refuses by name (SC0006)",
      nodeTypes: false,
      files: {
        "tsconfig.json": cfg({ strict: true }),
        "lib/tsconfig.json": cfg({ strict: true, strictFunctionTypes: false }),
        "lib/handler.ts": `export type Handler = (x: string | number) => string;
export const handler: Handler = (x: string) => x.toUpperCase();`,
        "main.ts": `import { handler } from "./lib/handler.ts";
console.log(handler("a"));`,
      },
    },
    expected: "SC0006 this code type-checks under its own package's tsconfig",
  },
  {
    row: legacyRow("R3-13 a legacy class decorator refuses (the effect-only shape TC39 lowering would mis-order)", `function register(_c: Function): void {}
@register
class C {
  static n = 1;
}`, "entry"),
    expected: "legacy decorators (this file's tsconfig enables experimentalDecorators",
  },
  {
    row: legacyRow("R3-14 a legacy method decorator refuses", `function log(_t: object, _k: string | symbol, d: PropertyDescriptor): PropertyDescriptor { return d; }
class C {
  @log
  run(): number { return 1; }
}`, "lib"),
    expected: "legacy decorators (this file's tsconfig enables experimentalDecorators",
  },
  {
    row: legacyRow("R3-15 a legacy accessor decorator refuses", `function ro(_t: object, _k: string | symbol, d: PropertyDescriptor): void { d.configurable = false; }
class C {
  #v = 1;
  @ro
  get v(): number { return this.#v; }
}`, "lib"),
    expected: "legacy decorators (this file's tsconfig enables experimentalDecorators",
  },
  {
    row: legacyRow("R3-16 a legacy property decorator refuses", `const Env = (_name: string): PropertyDecorator => () => {};
class C {
  @Env("PORT")
  port: number = 0;
}`, "entry"),
    expected: "legacy decorators (this file's tsconfig enables experimentalDecorators",
  },
  {
    row: legacyRow("R3-17 a legacy parameter decorator refuses", `function inject(_t: object, _k: string | symbol | undefined, _i: number): void {}
class C {
  constructor(@inject readonly port: number) {}
}`, "lib"),
    expected: "legacy decorators (this file's tsconfig enables experimentalDecorators",
  },
  {
    row: legacyRow("R3-18 a class whose only decorators are parameter decorators refuses even when nothing references it", `function inject(_t: object, _k: string | symbol | undefined, _i: number): void {}
class Unused {
  constructor(@inject readonly port: number) {}
}
class C {}`, "entry"),
    expected: "legacy decorators (this file's tsconfig enables experimentalDecorators",
  },
  {
    row: {
      id: "R3-19 legacy decorators are found under a package tsconfig when the entry has none",
      nodeTypes: false,
      noTsconfig: true,
      files: {
        "lib/tsconfig.json": LEGACY,
        "lib/c.ts": `function reg(_c: Function): void {}
@reg
export class C {
  static x = 1;
}`,
        "main.ts": `import { C } from "./lib/c.ts";
console.log(C.x);`,
      },
    },
    expected: "legacy decorators (this file's tsconfig enables experimentalDecorators",
  },
  {
    row: {
      id: "R3-20 an explicit allowUnreachableCode: false in a library is that library's own error",
      nodeTypes: false,
      files: {
        "tsconfig.json": cfg({ strict: true }),
        "lib/tsconfig.json": cfg({ strict: true, allowUnreachableCode: false }),
        "lib/f.ts": `export function f(): number {
  return 1;
  console.log("never");
}`,
        "main.ts": `import { f } from "./lib/f.ts";
console.log(f());`,
      },
    },
    expected: "Unreachable code detected.",
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`R3 per-package options (${backend} lane vs Node)`, () => {
    test.for(RUNS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
    test.for(REFUSES.map((r) => [r.row.id, r] as const))("%s", async ([, r]) => {
      await checkRefuses(scratch, r.row, r.expected, undefined, backend);
    }, 600_000);
  });
}
