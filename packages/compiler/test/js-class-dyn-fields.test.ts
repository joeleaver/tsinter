/* @clack/core's prompt classes (paperclip's p.text / p.select / p.confirm /
 * p.password / p.spinner reach them): JavaScript classes whose bare fields
 * inference leaves `any` hold dynamic values (a fresh instance reads
 * undefined, as in Node); a constructor that opens with `super(…), this.x =
 * …, …` runs super, then the field initializers, then the other operands in
 * order; and an object rest over a dynamic source (`constructor({ mask: t,
 * ...s })`, spinner's `{ …, ...I } = {}`) binds a fresh object of the
 * source's other own enumerable members in the source's order, never reading
 * an excluded one. Rows run under Node and on both WasmGC lanes, in a
 * JavaScript entry and through a package with declarations (SEMANTICS.md
 * S133), as clack ships. */
import { describe, test } from "vitest";
import { checkFenced, checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("js-class-dyn-fields");
const pj = (o: unknown): string => JSON.stringify(o);

// The clack-core shapes, close to the shipped dist (minified names kept).
const CORE = [
  `class V {`,
  `  input;`,
  `  output;`,
  `  opts;`,
  `  _render;`,
  `  _track = false;`,
  `  _subscribers = new Map();`,
  `  _cursor = 0;`,
  `  state = "initial";`,
  `  error = "";`,
  `  value;`,
  `  userInput = "";`,
  `  constructor(t, e = true) {`,
  `    const { input: i = "stdin", output: n = "stdout", render: s, signal: r, ...o } = t;`,
  `    this.opts = o, this._render = s, this._track = e, this.input = i, this.output = n;`,
  `  }`,
  `  setSubscriber(t, e) {`,
  `    const i = this._subscribers.get(t) ?? [];`,
  `    i.push(e), this._subscribers.set(t, i);`,
  `  }`,
  `  on(t, e) { this.setSubscriber(t, { cb: e }); }`,
  `  once(t, e) { this.setSubscriber(t, { cb: e, once: true }); }`,
  `  emit(t, ...e) {`,
  `    const i = this._subscribers.get(t) ?? [], n = [];`,
  // (clack spreads `...e` into the callback; a spread call through a
  // dynamic value still stops by name, so the rows pass the one argument)
  `    for (const s of i) s.cb(e[0]), s.once && n.push(() => i.splice(i.indexOf(s), 1));`,
  `    for (const s of n) s();`,
  `  }`,
  `  _setValue(t) { this.value = t, this.emit("value", this.value); }`,
  `  _setUserInput(t) { this.userInput = t ?? "", this.emit("userInput", this.userInput); }`,
  `  describe() {`,
  `    return [typeof this.value, String(this.value), this.state, this.input, this.output, this._track, JSON.stringify(this.opts), this._subscribers.size, this.userInput].join("|");`,
  `  }`,
  `}`,
  `class Confirm extends V {`,
  `  get cursor() { return this.value ? 0 : 1; }`,
  `  constructor(t) {`,
  `    super(t, false), this.value = !!t.initialValue, this.on("userInput", () => { this.value = this._cursor === 0; }), this.on("confirm", (e) => { this.value = e, this.state = "submit"; });`,
  `  }`,
  `}`,
  `class Password extends V {`,
  `  _mask = "*";`,
  `  constructor({ mask: t, ...s }) {`,
  `    super(s), this._mask = t ?? "*", this.on("userInput", (e) => { this._setValue(e); });`,
  `  }`,
  `  get masked() { return (this.userInput ?? "").replace(/./g, this._mask); }`,
  `}`,
  `class DateP extends V {`,
  `  #i;`,
  `  #n;`,
  `  constructor(t) {`,
  `    const n = String(t.format ?? "YMD"), o = n.toLowerCase();`,
  `    super({ ...t, initialUserInput: o }, false), this.#i = n, this.#n = o.length;`,
  `  }`,
  `  get fmt() { return this.#i + ":" + this.#n + ":" + this.opts.initialUserInput; }`,
  `}`,
  `class Text extends V {`,
  `  get userInputWithCursor() { return this.userInput + "_"; }`,
  `  constructor(t) {`,
  `    super({ ...t, initialUserInput: t.initialUserInput ?? t.initialValue }, true), this.on("userInput", (e) => { this._setValue(e); }), this.on("finalize", () => { this.value || (this.value = t.defaultValue), this.value === void 0 && (this.value = ""); });`,
  `  }`,
  `}`,
].join("\n");

// The prompts-side callers (each prompt is built and driven in JavaScript,
// as @clack/prompts does).
const PROMPTS = [
  `export function confirmDemo(opts) {`,
  `  const p = new Confirm({ ...opts, render() { return "r"; } });`,
  `  const out = [p.describe(), String(p.cursor)];`,
  `  p.emit("confirm", false);`,
  `  out.push(p.describe(), String(p.cursor));`,
  `  return out.join("\\n");`,
  `}`,
  `export function passwordDemo(opts) {`,
  `  const p = new Password(opts);`,
  `  const out = [p.describe(), p._mask];`,
  `  p._setUserInput("hunter2");`,
  `  out.push(p.describe(), p.masked);`,
  `  return out.join("\\n");`,
  `}`,
  `export function dateDemo(opts) {`,
  `  const p = new DateP(opts);`,
  `  return [p.describe(), p.fmt].join("\\n");`,
  `}`,
  `export function textDemo(opts) {`,
  `  const p = new Text(opts);`,
  `  const out = [p.describe()];`,
  `  p.once("userInput", (e) => out.push("once:" + e));`,
  `  p._setUserInput("ab");`,
  `  p._setUserInput("abc");`,
  `  p.emit("finalize");`,
  `  out.push(p.describe(), p.userInputWithCursor);`,
  `  return out.join("\\n");`,
  `}`,
  `export function bare() {`,
  `  const p = new V({ render() { return ""; } });`,
  `  return [p.value === undefined, typeof p.input, p.opts && Object.keys(p.opts).length, p.state, p.userInput === ""].join("|");`,
  `}`,
].join("\n");

const JS_MAIN = [
  CORE,
  PROMPTS,
  `console.log(bare());`,
  `console.log(confirmDemo({ message: "Go?", initialValue: true }));`,
  `console.log(confirmDemo({ message: "Go?" }));`,
  `console.log(passwordDemo({ message: "pw", mask: "#", b: 1, 2: "x", a: 2, 1: "y" }));`,
  `console.log(passwordDemo({ message: "pw" }));`,
  `console.log(dateDemo({ message: "when", format: "DMY" }));`,
  `console.log(textDemo({ message: "name", placeholder: "x", defaultValue: "dflt" }));`,
  `console.log(textDemo({ message: "name", initialValue: "iv" }));`,
].join("\n").replace(/^export /gm, "");

const ROWS: Row[] = [
  {
    id: "JCF-01 clack-core prompt classes in a JavaScript entry (dyn fields, comma super, rest params)",
    files: { "package.json": pj({ type: "module" }), "main.js": JS_MAIN },
  },
  {
    id: "JCF-02 an object rest over a dynamic source is a fresh object of the other members, in the source's order",
    files: {
      "package.json": pj({ type: "module" }),
      "main.js": [
        `function take({ mask: t, x, ...rest }) { console.log("took", t, x); return rest; }`,
        `const src = { mask: "#", y: 2, x: 1, 7: "seven", z: { deep: [1] }, 3: "three" };`,
        `const r = take(src);`,
        `console.log(JSON.stringify(r), Object.keys(r).join(","), r === src, "mask" in r, "x" in r);`,
        `r.y = 4; r.z.deep.push(2); console.log(src.y, r.y, JSON.stringify(src.z));`,
        `function inner({ a, ...r2 }) { return r2; }`,
        `console.log(JSON.stringify(inner({ a: 1 })), JSON.stringify(inner({ b: 2 })), JSON.stringify(inner(JSON.parse('{"a":1,"b":null}'))));`,
        `try { take(undefined); } catch (e) { console.log(e instanceof TypeError); }`,
      ].join("\n"),
    },
  },
  {
    id: "JCF-03 the clack shapes through a package with declarations (S133), driven from TypeScript",
    npmStatic: ["pc"],
    files: {
      "package.json": pj({ type: "module" }),
      "node_modules/pc/package.json": pj({ name: "pc", version: "1.0.0", type: "module", types: "./dist/index.d.mts", exports: { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } }),
      "node_modules/pc/dist/index.d.mts": [
        `export declare function bare(): string;`,
        `export declare function demos(): string;`,
      ].join("\n"),
      "node_modules/pc/dist/index.mjs": [
        CORE,
        PROMPTS,
        // The prompts build their own options, as @clack/prompts' wrappers
        // do (the program's option records crossing in are S125's).
        `export function demos() {`,
        `  return [confirmDemo({ message: "Go?", initialValue: true }), passwordDemo({ message: "pw", mask: "#", b: 1 }), dateDemo({ message: "when", format: "DMY" }), textDemo({ message: "name", defaultValue: "dflt" })].join("\\n");`,
        `}`,
      ].join("\n"),
      "main.ts": [
        `import * as p from "pc";`,
        `console.log(p.bare());`,
        `console.log(p.demos());`,
      ].join("\n"),
    },
  },
];

describe("JavaScript classes with dynamic fields, comma super, rest over dynamic (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("JavaScript classes with dynamic fields, comma super, rest over dynamic (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("the fences that stay", () => {
  test("JCF-R1 a super() after another comma operand keeps the expression-position fence", async () => {
    await checkRefuses(scratch, {
      id: "JCF-R1",
      files: {
        "main.ts": `class A { x: number; constructor(x: number) { this.x = x; } }\nclass B extends A { constructor() { let y = 0; y++, super(y); } }\nconsole.log(new B().x);`,
      },
    }, "super() calls anywhere but as a top-level constructor statement");
  }, 600_000);
  test("JCF-R2 a rest-only pattern over a dynamic source stops by name where it runs", async () => {
    await checkFenced(scratch, {
      id: "JCF-R2",
      files: { "package.json": pj({ type: "module" }), "main.js": `function f({ ...r }) { return r; }\nconsole.log("before");\nconsole.log(JSON.stringify(f({ a: 1 })));` },
    }, "wasm-native", "before\n", "object patterns holding only a rest element over checked-dynamic sources");
  }, 600_000);
  test("JCF-R4 a rest over a dynamic source with a symbol-keyed member stops by name where it runs", async () => {
    await checkFenced(scratch, {
      id: "JCF-R4",
      files: {
        "package.json": pj({ type: "module" }),
        "main.js": `const sy = Symbol("k");\nfunction f({ mask: t, ...s }) { return s; }\nconsole.log("before");\nconst r = f({ a: 1, mask: 2, [sy]: 3 });\nconsole.log(Object.getOwnPropertySymbols(r).length, r[sy], r.a);`,
      },
    }, "wasm-native", "before\n", "an object rest element over a dynamic value with symbol-keyed members is not supported yet");
  }, 600_000);
  test("JCF-R3 a rest over a dynamic array stops by name where it runs", async () => {
    await checkFenced(scratch, {
      id: "JCF-R3",
      files: {
        "package.json": pj({ type: "module" }),
        "main.js": `function f({ length: n, ...r }) { return r; }\nconsole.log("before");\nconst v = JSON.parse("[1,2]");\nconsole.log(JSON.stringify(f(v)));`,
      },
    }, "wasm-native", "before\n", "an object rest element over a dynamic value that is not a plain object is not supported yet");
  }, 600_000);
});
