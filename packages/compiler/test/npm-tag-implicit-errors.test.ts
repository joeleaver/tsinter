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
 * in TypeScript passed in, TAG-41 lists typed TypeScript errors, TAG-42
 * on pin the review leads and edges of the typed-error routing (function
 * slot identity, members read back, key order, caught errors, subclass
 * fields, delete, inspection, JSON, structuredClone, the pending markers
 * an error keeps until it crosses) and TAG-60 on their named stops. Rows
 * against Node and the named stops run on both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRefuses, checkRow, nativeRun, type Row, scratchDir } from "./top10-paperclip-rows.js";
import { runWasmToTrap } from "./wasm-host.js";

const scratch = scratchDir("npm-tag-implicit-errors");
const pj = (o: unknown): string => JSON.stringify(o);

const TG_DTS = `export declare function errOwn(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function errArg(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function badArg(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function mkErr(): Error;
export declare function writeErr(e: Error): void;
export declare function readErr(e: Error): string;
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
export function mkErr() { const e = new Error("m"); e.stack = "S"; e.cause = 3; e.code = "K"; return e; }
export function writeErr(e) { e.stack = "W"; e.cause = 9; e.name = "WN"; e.message = "WM"; e.code = "WC"; }
export function readErr(e) { return [e.code, e.stack, e.cause, e.name, e.message].join("|"); }
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
  },  {
    id: "TAG-42 a `() => TypeError` in a `() => Error` slot is the same function (a binding, an array element, a parameter), and a `(e: Error) => string` in a `(e: TypeError) => string` slot",
    files: { "main.ts": [
      `const tf = () => new TypeError("b"); const f2: () => Error = tf; console.log(f2 === tf, f2().name);`,
      `const mk: (() => Error)[] = [tf]; console.log(mk[0] === tf, mk[0]().name);`,
      `class A extends Error {} const fa = () => new A("x"); const fb: () => Error = fa; function call(f: () => Error) { return f; } console.log(fb === fa, call(fa) === fa);`,
      `const g = (e: Error) => e.message; const h: (e: TypeError) => string = g; console.log(h === g, h(new TypeError("q")));`,
    ].join("\n") },
  },
  {
    id: "TAG-43 members read back through any: a typed write of stack and cause, a JavaScript-built error's stack/cause/code, a JavaScript write onto a TypeScript error (name, message, code, stack, cause and the keys it makes own)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { mkErr, writeErr } from "tg";`,
      `const t = new TypeError("m"); t.stack = "S"; t.cause = 1; const a: any = t; console.log(a.stack, a.cause, JSON.stringify(Object.keys(t)));`,
      `const j = mkErr(); const b: any = j; console.log(b.stack, b.cause, b.code, j.message, j.name, JSON.stringify(Object.keys(j)));`,
      `const w = new TypeError("m"); writeErr(w); const c: any = w; console.log(w.name, w.message, c.code, c.stack, c.cause, JSON.stringify(Object.keys(w)));`,
    ].join("\n") },
  },
  {
    id: "TAG-44 key order: integer keys first, a name written twice keeps its first place, a code written before the name, JSON of the error held as any",
    files: { "main.ts": [
      `const e = new Error("m"); const a = e as any; a.b = 1; a[2] = 2; a.name = "N"; a[1] = 1; console.log(Object.keys(e), JSON.stringify(a));`,
      `const d: any = new Error("m"); d.code = "C"; d.name = "A"; d.name = "B"; console.log(Object.keys(d), d.name, JSON.stringify(d));`,
      `const f = new Error("m"); (f as any).code = "C"; f.name = "A"; f.name = "B"; const fa: any = f; console.log(Object.keys(f), JSON.stringify(fa), JSON.stringify({ k: fa }));`,
      `const g = new Error("m"); g.name = "N"; g.name = "M"; (g as any).z = 1; g.name = "K"; console.log(Object.keys(g), Object.values(g));`,
    ].join("\n") },
  },
  {
    id: "TAG-45 errors caught from JSON.parse, decodeURIComponent and a null member read, written and listed",
    files: { "main.ts": [
      `try { JSON.parse("{"); } catch (e) { const x = e as Error; (x as any).code = "J"; console.log(Object.keys(x), x.name); }`,
      `try { decodeURIComponent("%"); } catch (e) { const x = e as Error; x.name = "U2"; console.log(Object.keys(x), x.message); }`,
      `try { const o: any = null; o.p; } catch (e) { const x = e as Error; (x as any).k = 1; console.log(Object.keys(x), x.name); }`,
    ].join("\n") },
  },
  {
    id: "TAG-46 a subclass's fields interleaved with expandos and a written name and code; delete of an expando; defineProperty onto an error held as any",
    files: { "main.ts": [
      `class E extends Error { a = 1; b = 2; } const s = new E("m"); (s as any).x = 9; s.name = "N"; (s as any).code = "C"; s.a = 5; console.log(Object.keys(s), JSON.stringify(Object.entries(s)));`,
      `const e = new Error("m"); (e as any).x = 1; (e as any).y = 2; delete (e as any).x; console.log(Object.keys(e));`,
      `const d: any = new Error("m"); d.x = 1; d.y = 2; delete d.x; Object.defineProperty(d, "z", { value: 3, enumerable: false }); Object.defineProperty(d, "w", { value: 4, enumerable: true }); console.log(Object.keys(d), d.z, "x" in d);`,
    ].join("\n") },
  },
  {
    id: "TAG-47 console.log and util.inspect of errors with an emptied stack (S027) and a written name or code, typed and held as any; String of written errors",
    files: { "main.ts": [
      `import * as util from "node:util";`,
      `const e = new Error("m"); (e as any).code = "C"; e.stack = ""; console.log(e);`,
      `const n = new Error("m"); n.name = "N"; n.stack = ""; console.log(n); console.log([n]);`,
      `const d: any = new Error("m"); d.name = "N"; d.stack = ""; console.log(d); const f: any = new Error("m"); f.code = "C"; f.stack = ""; console.log(f, { f });`,
      `const i = new Error("m"); i.stack = ""; (i as any).code = "C"; console.log(util.inspect(i), util.inspect({ i }));`,
      `const r = new RangeError("r"); const q = new Error("q"); (q as any).code = "Q"; q.stack = ""; console.log(String(r), String(q), q.name);`,
    ].join("\n") },
  },
  {
    id: "TAG-48 JSON.stringify of errors held as any: a written name (once, after a code, before an integer key) serializes in its place, a rewritten message and a written stack stay out, a written cause shows",
    files: { "main.ts": [
      `const e: any = new Error("m"); e.name = "N"; console.log(JSON.stringify(e)); e.code = "C"; console.log(JSON.stringify(e), JSON.stringify([e]));`,
      `const m: any = new Error("m"); m.message = "x"; console.log(JSON.stringify(m)); const t: any = new TypeError("m"); t.stack = "s"; t.cause = 2; console.log(JSON.stringify(t));`,
      `const n = new Error("m"); n.name = "N"; const a: any = n; console.log(JSON.stringify(a), JSON.stringify(a, null, 1));`,
      `const k: any = new Error("m"); k.code = "C"; k.name = "N"; k[2] = 1; console.log(JSON.stringify(k));`,
    ].join("\n") },
  },
  {
    id: "TAG-49 structuredClone of written errors; Object.fromEntries and Object.assign of one held as any",
    files: { "main.ts": [
      `const e = new Error("m"); e.name = "N"; (e as any).code = "C"; const c = structuredClone(e); console.log(c.name, c.message, Object.keys(c), c instanceof Error, (c as any).code);`,
      `const d: any = new Error("m"); d.name = "N"; d.code = "C"; const dc = structuredClone(d); console.log(dc.name, Object.keys(dc));`,
      `const f: any = new Error("m"); f.name = "N"; console.log(JSON.stringify(Object.fromEntries(Object.entries(f))), JSON.stringify(Object.assign({}, f)));`,
    ].join("\n") },
  },
  {
    id: "TAG-50 a name written before the error crosses (no encoding yet) lists in its place: before and after an expando, for-in, a throw caught as unknown, a loop of errors, a later dynamic code write and rename",
    files: { "main.ts": [
      `const e = new Error("m"); e.name = "N"; (e as any).x = 1; console.log(Object.keys(e), Object.values(e));`,
      `const f = new Error("m"); (f as any).x = 1; f.name = "N"; console.log(Object.keys(f), Object.values(f));`,
      `const g = new Error("m"); g.name = "N"; const ks: string[] = []; for (const k in g) ks.push(k); console.log(ks); const ga: any = g; console.log(ga.name, Object.keys(ga), JSON.stringify(Object.entries(ga)));`,
      `function thr(): never { const t = new TypeError("m"); t.name = "N"; throw t; } try { thr(); } catch (x) { const a: any = x; console.log(Object.keys(a), a.name, a.message, x instanceof TypeError); }`,
      `const out: string[][] = []; for (let i = 0; i < 3; i++) { const l = new Error("m" + i); if (i !== 1) l.name = "N" + i; out.push(Object.keys(l)); } console.log(JSON.stringify(out));`,
      `const h = new Error("m"); h.name = "N"; const ha: any = h; ha.code = "C"; h.name = "Q"; console.log(Object.keys(h), JSON.stringify(ha));`,
    ].join("\n") },
  },
  {
    id: "TAG-51 plain typed errors: field reads and writes, String, instanceof, catch, a subclass's field and name, a super() then this.message subclass",
    files: { "main.ts": [
      `const e = new Error("m"); console.log(e.message, e.name, e instanceof Error); e.message = "n"; console.log(e.message, String(e));`,
      `const w = new Error("m"); w.name = "N"; console.log(String(w), w.name, w.message, w instanceof Error);`,
      `try { throw new TypeError("tt"); } catch (x) { if (x instanceof TypeError) console.log(x.message, x.name); }`,
      `class My extends Error { code: number; constructor(code: number) { super("my"); this.code = code; this.name = "My"; } }`,
      `try { throw new My(4); } catch (x) { if (x instanceof My) console.log(x.code, x.name, x.message, Object.keys(x), x instanceof Error); }`,
      `const m = new My(5); m.code = 6; console.log(m.code, Object.keys(m));`,
      `class P extends Error { constructor(s: string) { super(); this.message = s; } } const p = new P("pm"); console.log(p.message, String(p), p instanceof P);`,
      `const b = new Error("y"); b.message = "z"; console.log(Object.keys(b));`,
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

/** Runtime stops by name: our stdout is Node's up to the fence ("before"),
 * stderr names it, the exit is non-zero. Node's own output for each is in
 * the row's comment. */
const STOPS: [id: string, main: string, fence: RegExp][] = [
  // Node: before\n[S2]
  ["TAG-60 console.log of a typed error with a written stack", `const e = new TypeError("m"); e.stack = "S2"; console.log("before"); console.log(e);`, /inspecting an error held in a dynamic value with its own 'stack' \(Node prints the stack\)/],
  // Node: before\nError: m\n    at …stack… {\n  cause: 1\n}
  ["TAG-61 console.log of a typed error with a written cause", `const e = new Error("m"); e.cause = 1; console.log("before"); console.log(e);`, /inspecting an error held in a dynamic value with own properties beyond name, message and code/],
  // Node: before\nError: m\n    at …stack… {\n  x: 1\n}
  ["TAG-62 console.log of a typed error with an expando", `const e = new Error("m"); (e as any).x = 1; console.log("before"); console.log(e);`, /inspecting an error held in a dynamic value with own properties beyond name, message and code/],
  // Node: before\n{"message":"x"}
  ["TAG-63 JSON.stringify of an error built without a message, its message then written (any)", `const e: any = new Error(); e.message = "x"; console.log("before"); console.log(JSON.stringify(e));`, /JSON\.stringify of an error held in a dynamic value whose 'message' was written while it was empty/],
  // Node: before\n[ 'message', 'name' ]
  ["TAG-64 a typed message then name written onto an error built without a message, listed through any", `const e = new Error(); e.message = "x"; e.name = "N"; const a: any = e; console.log("before"); console.log(Object.keys(a));`, /a key listing, spread or Object\.assign of an error held in a dynamic value whose 'message' was written while it was empty/],
  // Node: before\n[]  (an error built with "" lists no own message once written)
  ["TAG-65 an error built with an empty message, its message then written, listed", `const e = new Error(""); e.message = "x"; console.log("before"); console.log(Object.keys(e));`, /a key listing, spread or Object\.assign of an error held in a dynamic value whose 'message' was written while it was empty/],
  // Node: before\nK|S|3|Error|m
  ["TAG-66 JavaScript reading a code off a TypeScript Error passed in", `import { readErr } from "tg";\nconsole.log("before");\nconsole.log(readErr(new Error("m")));`, /reading 'code' from a value of type 'Error' is not supported yet/],
];

describe("errors routed through dynamic values: the cases this build stops at by name (S027, S080)", () => {
  test.for(STOPS.flatMap(([id, main, fence]) => (["wasm", "wasm-native"] as const).map((lane) => [`${id} (${lane})`, main, fence, lane] as const)))("%s", async ([, main, fence, lane]) => {
    const dir = mkdtempSync(join(tmpdir(), "tagstop-"));
    const files: Record<string, string> = { ...TG, "main.ts": main };
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
    expect(got.stderr).toMatch(new RegExp(`tsinter: unsupported: ${fence.source}`));
  }, 600_000);
});

/** Compile-time refusals by name: the leads that stay out of tier. */
const REFUSALS: [id: string, main: string, expected: string][] = [
  // Node: S 1
  ["TAG-70 a typed read of a written stack", `const t = new TypeError("m"); t.stack = "S"; console.log(t.stack);`, "'TypeError.stack' is part of the standard library types but has no scriptc lowering yet"],
  // Node: 1
  ["TAG-71 a typed read of a written cause", `const t = new Error("m"); t.cause = 1; console.log(t.cause);`, "'Error.cause' is part of the standard library types but has no scriptc lowering yet"],
  // Node: 2 Error
  ["TAG-72 a `(() => TypeError)[]` aliased as `(() => Error)[]` and pushed to", `const a: (() => TypeError)[] = [() => new TypeError("b")]; const b: (() => Error)[] = a; b.push(() => new Error("e")); console.log(a.length, a[1]().name);`, "a '(() => TypeError)[]' value where '(() => Error)[]' is expected: the slot would hold a COPY where JavaScript shares the object"],
  // Node: 2
  ["TAG-73 a `TypeError[]` aliased as `Error[]` and pushed to", `const a: TypeError[] = [new TypeError("b")]; const b: Error[] = a; b.push(new Error("e")); console.log(a.length);`, "a 'TypeError[]' value where 'Error[]' is expected: the slot would hold a COPY where JavaScript shares the object"],
  // Node: []
  ["TAG-74 a typed spread of an Error", `const e = new Error("m"); const o = { ...e }; console.log(Object.keys(o));`, "object spread of 'Error' sources"],
  // Node: m [ 'name' ]
  ["TAG-75 a rest binding over an Error", `const e = new Error("m"); e.name = "N"; const { message, ...rest } = e; console.log(message, Object.keys(rest));`, "rest bindings over runtime-provided class instances"],
];

describe("errors routed through dynamic values: the leads refused at compile time by name", () => {
  test.for(REFUSALS.flatMap(([id, main, expected]) => (["wasm", "wasm-native"] as const).map((lane) => [`${id} (${lane})`, id, main, expected, lane] as const)))("%s", async ([, id, main, expected, lane]) => {
    await checkRefuses(scratch, { id: `${id} ${lane}`, files: { "main.ts": main } }, expected, undefined, lane);
  }, 600_000);
});
