/* GH #193, continuing npm-tag-implicit.test.ts after TAG-36: an Error that
 * a program wrote onto, copied by Object.assign onto a JavaScript tag's
 * frozen strings array (or its raw) and listed by the plain-target
 * consumers of an error's user view (Object.keys/values/entries, a
 * plain-target Object.assign, spread, for-in). Node lists a written `name`
 * and `code` as own enumerable keys in write order, keeps a rewritten
 * constructor-given `message` and a written `stack` non-enumerable, and
 * lists a `message` written onto an error built without one; this build
 * cannot tell that last case from a present empty message, so it stops by
 * name there (SEMANTICS.md S080). TAG-37 builds the errors in the
 * JavaScript tag (typed `Error` bindings, the reviewer's repros), TAG-38
 * in TypeScript passed in, TAG-41 lists typed TypeScript errors. Rows
 * against Node and the named stops (TAG-39/40) run on both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRow, nativeRun, type Row, scratchDir } from "./top10-paperclip-rows.js";
import { runWasmToTrap } from "./wasm-host.js";

const scratch = scratchDir("npm-tag-implicit-errors");
const pj = (o: unknown): string => JSON.stringify(o);

const TG_DTS = `export declare function errOwn(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function errArg(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function badArg(strings: TemplateStringsArray, ...params: unknown[]): unknown;
`;

const TG_JS = String.raw`
export function errOwn(strings) {
  const out = [];
  const mk = [
    () => { const e = new Error("m"); e.name = "X"; return e; },
    () => { const e = new TypeError("m"); e.name = "T"; return e; },
    () => { const e = new Error("m"); e.code = "E"; return e; },
    () => { const e = new Error("m"); e.message = "y"; return e; },
    () => { const e = new Error("m"); e.stack = "s"; return e; },
    () => { const e = new Error("m"); e.foo = 1; e.name = "N"; e.code = "C"; e.name = "N2"; return e; },
    () => { const e = new Error("m"); e.code = "C"; e.name = "N"; return e; },
  ];
  for (const a of [strings, strings.raw]) {
    for (const f of mk) {
      try { out.push(String(Object.assign(a, f()) === a)); } catch (e) { out.push(e.constructor.name + ": " + e.message); }
    }
  }
  for (const f of mk) {
    const e = f();
    const ks = [];
    for (const k in e) ks.push(k);
    out.push(JSON.stringify([Object.keys(e), Object.values(e), Object.entries(e), Object.assign({}, e), { ...e }, ks]));
  }
  return out.join("\n") + "\n" + strings.join() + "|" + strings.raw.join();
}
export function errArg(strings, ...errs) {
  const out = [];
  for (const a of [strings, strings.raw]) {
    for (const e of errs) {
      try { out.push(String(Object.assign(a, e) === a)); } catch (x) { out.push(x.constructor.name + ": " + x.message); }
    }
  }
  for (const e of errs) out.push(JSON.stringify([Object.keys(e), Object.assign({}, e)]));
  return out.join("\n");
}
export function badArg(strings, e) {
  return String(Object.assign(strings, e) === strings);
}
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
    id: "TAG-37 errors built in JavaScript (a typed Error binding): Object.assign onto the frozen arrays throws naming a written name (Error, TypeError) or code, in write order after an expando; a rewritten message and a written stack copy nothing; Object.keys/values/entries, a plain-target Object.assign, spread and for-in list the same keys",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": `import { errOwn } from "tg";\nconsole.log(errOwn\`a\${1}b\`);` },
  },
  {
    id: "TAG-38 Object.assign onto the frozen arrays from TypeScript errors passed in: a typed or an any-held own name and an any-held code throw naming it; a typed message rewrite and an any-held stack copy nothing",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { errArg } from "tg";`,
      `const e1 = new Error("m"); e1.name = "Q";`,
      `const e2: any = new Error("m"); e2.name = "Z";`,
      `const e3: any = new Error("m"); e3.code = "E";`,
      `const e4 = new Error("m"); e4.message = "y";`,
      `const e5: any = new Error("m"); e5.stack = "s";`,
      `console.log(errArg\`a\${e1}b\${e2}c\${e3}d\${e4}e\${e5}f\`);`,
      `console.log(JSON.stringify([Object.keys(e2), Object.keys(e3), Object.assign({}, e2), { ...e3 }]));`,
    ].join("\n") },
  },
  {
    id: "TAG-41 TypeScript's typed errors listed: a written code (through any) and name, stack and cause; Object.keys/values/entries and for-in of a typed Error, TypeError and subclass instance; a `() => TypeError` called through a `() => Error` slot",
    files: { "main.ts": [
      `const e = new Error("m"); (e as any).code = "C"; e.name = "N";`,
      `const ks: string[] = []; for (const k in e) ks.push(k);`,
      `console.log(JSON.stringify(Object.keys(e)), JSON.stringify(Object.entries(e)), JSON.stringify(ks));`,
      `const t = new TypeError("m"); t.stack = "s"; t.cause = 1;`,
      `console.log(JSON.stringify(Object.keys(t)), JSON.stringify(Object.values(t)));`,
      `class E extends Error { x = 1; }`,
      `const s = new E("m"); s.name = "Q";`,
      `console.log(JSON.stringify(Object.keys(s)));`,
      `const mk: (() => Error)[] = [() => new Error("a"), () => new TypeError("b")];`,
      `for (const f of mk) { const x = f(); console.log(x.name, x.message, x instanceof TypeError); }`,
    ].join("\n") },
  },
];

describe("implicit-any JavaScript tags, Error sources a program wrote onto (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("implicit-any JavaScript tags, Error sources a program wrote onto (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

const MSG_STOPS = [
  ["TAG-39 written in JavaScript", `export function bad(strings) { const e = new Error(); e.message = "x"; return badArg(strings, e); }`, `import { bad } from "tg";\nconsole.log("before");\nconsole.log(bad\`y\${1}z\`);`],
  ["TAG-40 written through a TypeScript any", "", `import { badArg } from "tg";\nconst e: any = new Error(); e.message = "x";\nconsole.log("before");\nconsole.log(badArg\`y\${e}z\`);`],
] as const;

describe("implicit-any JavaScript tags: an Error built without a message, its message then written, copied onto the array stops by name (S080)", () => {
  test.for(MSG_STOPS.flatMap(([id, js, main]) => (["wasm", "wasm-native"] as const).map((lane) => [`${id} (${lane})`, js, main, lane] as const)))("%s", async ([, js, main, lane]) => {
    const dir = mkdtempSync(join(tmpdir(), "tagmsg-"));
    const files: Record<string, string> = {
      ...TG,
      "node_modules/tg/index.js": `${TG_JS}\n${js}\n`,
      "node_modules/tg/index.d.ts": `${TG_DTS}\nexport declare function bad(strings: TemplateStringsArray, ...v: unknown[]): unknown;\n`,
      "main.ts": main,
    };
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, lane === "wasm" ? "p.wasm" : "program"), outDir: dir, backend: lane, npmStatic: ["tg"] });
    if (!res.ok) throw new Error(`refused at compile time: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
    const got = lane === "wasm"
      // the trap (runWasmToTrap asserts it) is the tier's exit 1
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!, []);
    expect(got.stdout, got.stderr).toBe("before\n");
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(/tsinter: unsupported: a key listing, spread or Object\.assign of an error held in a dynamic value whose 'message' was written while it was empty/);
  }, 600_000);
});
