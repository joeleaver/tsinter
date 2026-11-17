/* process.stdout / process.stderr as values on the WasmGC lanes: a static
 * value is the stream's fd; crossing into a dynamic value it is a HANDLE
 * whose tag names the stream. The surface is @clack/prompts' (paperclip's
 * env path): `(t?.output ?? process.stdout).write(s)`, the default-param
 * `{ output: m = process.stdout } = {}`, isTTY / columns / `"columns" in s`
 * (absent off a terminal: getColumns answers 80 when piped), fd, identity.
 * Anything else stops by name. Rows run under Node and on both lanes; the
 * harness pipes stdout and stderr, as paperclip's workload does. */
import { describe, test } from "vitest";
import { checkFenced, checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("wasm-proc-streams");
const pj = (o: unknown): string => JSON.stringify(o);

// clack's own shapes (prompts dist index.mjs: log.message, intro, outro,
// cancel, note's getColumns), without styleText.
const CLACK = [
  `const settings = { withGuide: true };`,
  `const getColumns = (e) => "columns" in e && typeof e.columns == "number" ? e.columns : 80;`,
  `const log = {`,
  `  message: (s = [], { symbol: e = "|", secondarySymbol: r = "|", output: m = process.stdout, spacing: l = 1, withGuide: c } = {}) => {`,
  `    const t = [], o = c ?? settings.withGuide, f = o ? r : "", O = o ? \`\${e}  \` : "", u = o ? \`\${r}  \` : "";`,
  `    for (let i = 0; i < l; i++) t.push(f);`,
  `    const g = Array.isArray(s) ? s : s.split("\\n");`,
  `    if (g.length > 0) {`,
  `      const [i, ...y] = g;`,
  `      i.length > 0 ? t.push(\`\${O}\${i}\`) : t.push(o ? e : "");`,
  `      for (const p of y) p.length > 0 ? t.push(\`\${u}\${p}\`) : t.push(o ? r : "");`,
  `    }`,
  `    m.write(\`\${t.join("\\n")}\\n\`);`,
  `  },`,
  `  warn: (s, e) => { log.message(s, { ...e, symbol: "^" }); },`,
  `};`,
  `const cancel = (o = "", t) => {`,
  `  const i = t?.output ?? process.stdout, e = t?.withGuide ?? settings.withGuide ? "L  " : "";`,
  `  i.write(\`\${e}\${o}\\n\\n\`);`,
  `}, intro = (o = "", t) => {`,
  `  const i = t?.output ?? process.stdout, e = t?.withGuide ?? settings.withGuide ? "T  " : "";`,
  `  i.write(\`\${e}\${o}\\n\`);`,
  `}, outro = (o = "", t) => {`,
  `  const i = t?.output ?? process.stdout, e = t?.withGuide ?? settings.withGuide ? "|\\nL  " : "";`,
  `  i.write(\`\${e}\${o}\\n\\n\`);`,
  `};`,
  `const note = (o = "", e = "", s) => {`,
  `  const a = s?.output ?? process.stdout, w = getColumns(a) - 6;`,
  `  a.write(\`<\${e}> \${o} (\${w})\\n\`);`,
  `};`,
].join("\n");

const DRIVE = [
  `intro("hello");`,
  `note("a note", "Title");`,
  `log.message("msg");`,
  `log.message("two\\nlines\\n\\nend");`,
  `log.message(["x", "", "y"], { spacing: 2, withGuide: false });`,
  `log.warn("careful");`,
  `log.message("to stderr", { output: process.stderr });`,
  `intro("unguided", { withGuide: false });`,
  `cancel("nope");`,
  `outro("bye", { output: process.stderr });`,
  `outro("bye");`,
].join("\n");

const ROWS: Row[] = [
  {
    id: "PS-01 clack's intro / note / log.message / cancel / outro over process streams (JavaScript)",
    files: { "package.json": pj({ type: "module" }), "main.js": `${CLACK}\n${DRIVE}` },
  },
  {
    id: "PS-02 a dynamic process stream's members, presence, identity and write's answer",
    files: {
      "package.json": pj({ type: "module" }),
      "main.js": [
        `function id(x) { return x; }`,
        `function g(e) { return [e.isTTY, e.columns, "columns" in e, "isTTY" in e, "write" in e, "fd" in e, e.fd, typeof e, !!e, String(e)].join("|"); }`,
        `console.log(g(process.stdout));`,
        `console.log(g(process.stderr));`,
        `const o = id(process.stdout), e = id(process.stderr);`,
        `console.log(o === process.stdout, o === e, e === process.stderr, o !== e, id(o) === o, o === undefined);`,
        `const w = (s, t) => (t?.output ?? process.stdout).write(s);`,
        `console.log(w("hi\\n"), w("err\\n", { output: process.stderr }));`,
      ].join("\n"),
    },
  },
  {
    id: "PS-04 the clack shapes through a package with declarations (S133), driven from TypeScript",
    npmStatic: ["pk"],
    files: {
      "package.json": pj({ type: "module" }),
      "node_modules/pk/package.json": pj({ name: "pk", version: "1.0.0", type: "module", types: "./index.d.mts", exports: { ".": { types: "./index.d.mts", default: "./index.mjs" } } }),
      "node_modules/pk/index.d.mts": [
        `import type { Writable } from "node:stream";`,
        `interface CommonOptions { output?: Writable; withGuide?: boolean }`,
        `interface LogMessageOptions extends CommonOptions { symbol?: string; spacing?: number; secondarySymbol?: string }`,
        `export declare const log: { message: (message?: string | string[], opts?: LogMessageOptions) => void; warn: (message: string, opts?: LogMessageOptions) => void };`,
        `export declare const intro: (title?: string, opts?: CommonOptions) => void;`,
        `export declare const outro: (message?: string, opts?: CommonOptions) => void;`,
        `export declare const cancel: (message?: string, opts?: CommonOptions) => void;`,
        `export declare const note: (message?: string, title?: string, opts?: CommonOptions) => void;`,
      ].join("\n"),
      "node_modules/pk/index.mjs": `${CLACK}\nexport { log, intro, outro, cancel, note };`,
      "main.ts": [
        `import * as p from "pk";`,
        `p.intro("hello");`,
        `p.note("a note", "Title");`,
        `p.log.message("msg");`,
        `p.log.message("two\\nlines");`,
        `p.log.warn("careful");`,
        `p.cancel("nope");`,
        `p.outro("bye");`,
      ].join("\n"),
    },
  },
];

describe("process streams as values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("process streams as values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

const fenced = (id: string, body: string): Row => ({ id, files: { "package.json": pj({ type: "module" }), "main.js": `function id(x) { return x; }\nconsole.log("before");\n${body}` } });

describe("what a dynamic process stream does not model stops by name", () => {
  test("PS-R1 write with a callback", async () => {
    await checkFenced(scratch, fenced("PS-R1", `id(process.stdout).write("x\\n", () => {});`), "wasm-native", "before\n",
      "write() on a process stream with other than one string argument is not supported yet");
  }, 600_000);
  test("PS-R2 write of bytes", async () => {
    await checkFenced(scratch, fenced("PS-R2", `id(process.stdout).write(new Uint8Array([65, 10]));`), "wasm-native", "before\n",
      "write() on a process stream with other than one string argument is not supported yet");
  }, 600_000);
  test("PS-R3 an unmodeled member read", async () => {
    await checkFenced(scratch, fenced("PS-R3", `console.log(id(process.stdout).writableLength);`), "wasm-native", "before\n",
      "reading the property 'writableLength' of a process stream is not supported yet");
  }, 600_000);
  test("PS-R4 an unmodeled method", async () => {
    await checkFenced(scratch, fenced("PS-R4", `id(process.stdout).end();`), "wasm-native", "before\n",
      "'end' on a process stream is not supported yet");
  }, 600_000);
  test("PS-R5 an unmodeled 'in' key", async () => {
    await checkFenced(scratch, fenced("PS-R5", `console.log("rows" in id(process.stdout));`), "wasm-native", "before\n",
      "'in' with the key 'rows' on a process stream is not supported yet");
  }, 600_000);
  test("PS-R6 a stream bound directly to a JavaScript const (its declared type has no write lowering)", async () => {
    await checkFenced(scratch, {
      id: "PS-R6",
      files: { "package.json": pj({ type: "module" }), "main.js": `const out = process.stdout;\nconsole.log("before");\nout.write("hi\\n");` },
    }, "wasm-native", "before\n", "'WriteStream & { fd: 1; }.write' is typed by @types/node but has no scriptc lowering yet");
  }, 600_000);
  test("PS-R7 a stream bound directly in TypeScript refuses at build time", async () => {
    await checkRefuses(scratch, {
      id: "PS-R7",
      files: { "main.ts": `const s = process.stdout;\nconsole.log("before");\ns.write("hi\\n");` },
    }, "values of type 'WriteStream & { fd: 1; }' cannot be compiled");
  }, 600_000);
});
