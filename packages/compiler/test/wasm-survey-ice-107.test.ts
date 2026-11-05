/* GH #107 — the internal compiler errors (SC9001), analyze() crashes and
 * compile() throws the round-3 npm survey found (tests/real-apps-round3/
 * survey). Every row is a small program written for this file in the
 * shape of a surveyed package; no third-party source is copied.
 *
 *   exact   the program compiles and its wasm run equals Node's (spawned
 *           at test time), stdout and exit code;
 *   fence   it compiles, and the construct with no lowering is a named
 *           runtime fence (JavaScript defers its fences) that the run
 *           reaches: stdout before it, the fence line, exit 1;
 *   refuse  compile() and analyze() return the named diagnostic — never a
 *           thrown error, never SC9001.
 *
 * npm-static rows lay out a package under node_modules and compile with
 * `npmStatic: [pkg]`, as the survey did; the implicit-any instance
 * machinery only runs there. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";
import { emitWasmModule } from "../src/backend/wasm/emitter.js";
import { VOID, type IrModule, type SrcLoc } from "../src/ir/nodes.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const scratch = mkdtempSync(join(tmpdir(), "tsinter-survey-ice-107-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Row {
  id: string;
  /** relative path → content; the entry is `entry` */
  files: Record<string, string>;
  entry: string;
  /** the npm-static opt-in (a package under node_modules in `files`) */
  npmStatic?: string[];
  /** absent: equals Node */
  fence?: { stdout: string; stderr: RegExp };
}

/** package.json for an npm-static package directory */
const pkg = (name: string, type?: "module"): string =>
  JSON.stringify({ name, version: "1.0.0", main: "index.js", ...(type ? { type } : {}) });

function layout(row: Row): string {
  const dir = join(scratch, row.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  for (const [rel, text] of Object.entries(row.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return join(dir, row.entry);
}

function nodeRun(file: string): { stdout: string; exitCode: number } {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], {
    encoding: "utf8",
    cwd: dirname(file),
    input: "",
  });
  return { stdout: r.stdout, exitCode: r.status ?? -1 };
}

const ROWS: Row[] = [
  {
    // deepmerge, dayjs, underscore, path, colors, rxjs, esbuild, chai: a
    // `var` in a function lowered twice (two implicit-any instances) —
    // the second instance was handed the first one's hoisted slot
    // ("assign to undeclared local/global").
    id: "var-hoist-per-instance",
    npmStatic: ["vmerge"],
    entry: "main.ts",
    files: {
      "node_modules/vmerge/package.json": pkg("vmerge"),
      "node_modules/vmerge/index.js": `'use strict';
function wrap(value) {
  return Array.isArray(value) ? merge([], value) : value;
}
function merge(target, source) {
  var sourceIsArray = Array.isArray(source);
  var targetIsArray = Array.isArray(target);
  var same = sourceIsArray === targetIsArray;
  if (!same) {
    return wrap(source);
  } else if (sourceIsArray) {
    return target.concat(source);
  } else {
    return source;
  }
}
exports.merge = merge;
exports.wrap = wrap;
`,
      "main.ts": `import { merge, wrap } from "vmerge";
console.log(merge([1], [2]));
console.log(merge({ a: 1 }, [2]));
console.log(wrap([3]));
`,
    },
  },
  {
    // the function-declaration twin: a nested declaration referenced
    // above itself, in a function lowered more than once.
    id: "hoisted-fn-decl-per-instance",
    npmStatic: ["hoisty"],
    entry: "main.ts",
    files: {
      "node_modules/hoisty/package.json": pkg("hoisty"),
      "node_modules/hoisty/index.js": `'use strict';
function describe(value, label) {
  var parts = [];
  parts.push(tag(label));
  for (var i = 0; i < 2; i++) {
    var item = value + i;
    parts.push(String(item));
  }
  return parts.join(" ") + " " + i + " " + item;
  function tag(t) {
    return "<" + t + ">";
  }
}
exports.describe = describe;
`,
      "main.ts": `import { describe } from "hoisty";
console.log(describe(1, "num"));
console.log(describe("s", "str"));
console.log(describe(2.5, "again"));
`,
    },
  },
  {
    // chai's esbuild `__name` helper (137 sites): an implicit instance whose
    // body did not compile, demanded again by a second call site — the
    // second call named a function the module never got. Now every later
    // use inherits the body's blocker (SC2004); the fenced calls sit on a
    // path this run never takes.
    id: "failed-instance-reused",
    npmStatic: ["namer"],
    entry: "main.ts",
    files: {
      "node_modules/namer/package.json": pkg("namer", "module"),
      "node_modules/namer/index.js": `var __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });
function isEven(n) {
  return n % 2 === 0;
}
function isOdd(n) {
  return !isEven(n);
}
function label(always) {
  if (always) {
    __name(isEven, "isEven");
    __name(isOdd, "isOdd");
  }
  return "labelled";
}
export { isEven, isOdd, label };
`,
      "main.ts": `import { isEven, isOdd, label } from "namer";
console.log(isEven(4), isOdd(4), label(process.argv.length > 99));
`,
    },
  },
  {
    // rxjs bindCallbackInternals: same-key recursion inside a returned
    // closure observed the dyn fallback return, then the instance settled
    // on a function type ("type dyn != return func"). The re-demand now
    // pins the return.
    id: "recursive-instance-pins-return",
    npmStatic: ["binder"],
    entry: "main.ts",
    files: {
      "node_modules/binder/package.json": pkg("binder"),
      "node_modules/binder/index.js": `'use strict';
function bindTwice(label, fn, extra) {
  if (extra) {
    return function (x) {
      return bindTwice(label, fn)(x) + extra;
    };
  }
  return function (x) {
    return label + fn(x);
  };
}
exports.bindTwice = bindTwice;
`,
      "main.ts": `import { bindTwice } from "binder";
const f = bindTwice("v=", (x: number) => x * 2, "!");
console.log(f(21));
const g = bindTwice("w=", (x: number) => x + 1, "");
console.log(g(1));
`,
    },
  },
  {
    // eslint-plugin-flowtype's _getRequireWildcardCache: every valued
    // return the instance kept is \`null\` (the other one fenced) — a bare
    // null return type.
    id: "instance-null-only-return",
    npmStatic: ["nully"],
    entry: "main.ts",
    files: {
      "node_modules/nully/package.json": pkg("nully"),
      "node_modules/nully/index.js": `'use strict';
function pick(v) {
  if (v > 0) return null;
  return v.call(null);
}
function describe(v) {
  var c = pick(v);
  return String(c === null) + " " + String(c);
}
exports.describe = describe;
`,
      "main.ts": `import { describe } from "nully";
console.log(describe(1));
console.log(describe(2));
`,
    },
  },
  {
    // \`var count\` and \`exports.count = function\` took one global id.
    id: "cjs-export-name-clash",
    npmStatic: ["clash"],
    entry: "main.ts",
    files: {
      "node_modules/clash/package.json": pkg("clash"),
      "node_modules/clash/index.js": `'use strict';
var count = 0;
function bump() {
  count++;
  return count;
}
exports.bump = bump;
exports.count = function () {
  return count;
};
`,
      "main.ts": `import { bump, count } from "clash";
bump();
bump();
console.log(count());
`,
    },
  },
  {
    // jest, babel-jest, regenerator-runtime: a nested function declaration
    // reassigned (Babel's lazy-require helper rewrites itself; regenerator
    // replaces \`define\` in a catch). The binding is mutable and the body
    // reads it, not itself.
    id: "reassigned-nested-fn-decl",
    npmStatic: ["lazyreq"],
    entry: "main.ts",
    files: {
      "node_modules/lazyreq/package.json": pkg("lazyreq"),
      "node_modules/lazyreq/index.js": `'use strict';
function nested() {
  let made = 0;
  function cache() {
    made++;
    const data = { n: made };
    cache = function () {
      return data;
    };
    return data;
  }
  return cache().n + cache().n + made;
}
function runtime(broken) {
  function define(obj, key, value) {
    if (broken) throw new Error("no define");
    obj[key] = value + 1;
    return obj[key];
  }
  try {
    define({}, "probe", 0);
  } catch (err) {
    define = function (obj, key, value) {
      obj[key] = value;
      return obj[key];
    };
  }
  var o = {};
  return [define(o, "a", 1), define(o, "b", 2)].join(",");
}
exports.nested = nested;
exports.runtime = runtime;
`,
      "main.ts": `import { nested, runtime } from "lazyreq";
console.log(nested(), nested());
console.log(runtime(false), runtime(true));
`,
    },
  },
  {
    // the same helper at MODULE scope is a module function, not a slot:
    // still a named fence (not an ICE), reached at the first call.
    id: "reassigned-top-level-fn-decl",
    npmStatic: ["lazytop"],
    entry: "main.ts",
    files: {
      "node_modules/lazytop/package.json": pkg("lazytop"),
      "node_modules/lazytop/index.js": `'use strict';
function table() {
  const data = [10, 20, 30];
  table = function () {
    return data;
  };
  return data;
}
exports.sum = function () {
  let s = 0;
  for (const v of table()) s += v;
  return s;
};
`,
      "main.ts": `import { sum } from "lazytop";
console.log("before");
console.log(sum());
`,
    },
    fence: { stdout: "before\n", stderr: /^tsinter: unsupported: assignment to 'table' \(not a writable local or module global\) is not supported yet \[SC1090 at <ROW>[^\]]*index\.js:4\]\n$/ },
  },
  {
    // mkdirp, rollup-plugin-node-resolve: \`er ? rej(er) : res(v)\` — a
    // ternary whose arms are void, in a position nobody reads.
    id: "void-ternary-statement",
    entry: "main.mjs",
    files: {
      "main.mjs": `function later(fail, cb) {
  setTimeout(() => cb(fail ? "boom" : "", 42), 0);
}
const run = (fail) => new Promise((res, rej) => later(fail, (er, v) => er ? rej(er) : res(v)));
run(false).then((v) => console.log("ok", v));
const log = [];
const pick = (flag) => flag ? log.push("a") : console.log("b");
pick(true);
pick(false);
console.log(log.length);
const nest = (n) => n > 1 ? console.log("big") : n > 0 ? console.log("one") : log.push("zero");
nest(2);
nest(1);
nest(0);
function stmt(n) {
  n ? console.log("stmt", n) : console.log("stmt zero");
}
stmt(3);
stmt(0);
console.log(log.join(","));
`,
    },
  },
  {
    // babel-jest's webpack prologue: \`exports["default"] =
    // exports.createTransformer = void 0\` on an untyped object.
    id: "chained-void-0-write",
    entry: "main.cjs",
    files: {
      "main.cjs": `let store = {};
(() => {
  let target = store;
  target["first"] = target.second = void 0;
  console.log(Object.keys(target).join(","), target.first, target.second);
})();
let a, b;
a = b = undefined;
console.log(a, b);
`,
    },
  },
  {
    // eslint-plugin-jest: Object.fromEntries over pairs that lowered
    // checked-dynamic while the checker typed a tuple array.
    id: "from-entries-over-dyn",
    npmStatic: ["rulepack"],
    entry: "main.ts",
    files: {
      "node_modules/rulepack/package.json": pkg("rulepack"),
      "node_modules/rulepack/index.js": `"use strict";
const rules = JSON.parse('{"a":{"meta":{}},"b":{"meta":{"deprecated":true}},"c":{"meta":{}}}');
const allRules = Object.fromEntries(Object.entries(rules).filter(([, rule]) => !rule.meta.deprecated).map(([name]) => [\`x/\${name}\`, "error"]));
exports.summary = function () {
  return JSON.stringify(allRules);
};
`,
      "main.ts": `import { summary } from "rulepack";
console.log(summary());
`,
    },
    fence: { stdout: "", stderr: /^tsinter: unsupported: Object\.fromEntries over a 'unknown' value where the checker typed '\[string, string\]\[\]' \(the pairs did not lower to a static array\) is not supported yet \[SC1090 at <ROW>[^\]]*index\.js:3\]\n$/ },
  },
  {
    // eslint-plugin-promise, webpack: a JSDoc @type on a setter, method or
    // function makes tsgo's client AST answer the TYPE node as \`.body\`
    // (an upstream typescript-go decoding bug); analyze() crashed in
    // lowerStmts.
    id: "jsdoc-type-tag-bodies",
    entry: "main.cjs",
    files: {
      "main.cjs": `'use strict';
class Box {
  constructor() {
    this._value = "";
    this.writes = 0;
  }
  get value() {
    return this._value;
  }
  /** @type {string} */
  set value(v) {
    this._value = v;
    this.writes++;
  }
  /** @type {(n: number) => number} */
  twice(n) {
    return n * 2;
  }
}
/** @type {(s: string) => string} */
function shout(s) {
  return s.toUpperCase() + "!";
}
function outer() {
  /** @type {(n: number) => number} */
  function inc(n) {
    return n + 1;
  }
  return inc(41);
}
const b = new Box();
b.value = "x";
b.value = "y";
console.log(b.value, b.writes, b.twice(21), shout("hi"), outer());
`,
    },
  },
  {
    // less, sass: a JSDoc cast to a union of subclasses, read through —
    // a named fence on a branch this run never takes; widening casts
    // still lower.
    id: "jsdoc-cast-union-read",
    entry: "main.cjs",
    files: {
      "main.cjs": `'use strict';
class Node {
  constructor() {
    this.kind = "node";
  }
}
class Dimension extends Node {
  constructor() {
    super();
    this.unit = "px";
  }
}
class Color extends Node {
  constructor() {
    super();
    this.unit = "rgb";
  }
}
/** @param {Node} a */
function run(a) {
  if (a.kind === "never") {
    return /** @type {Dimension | Color} */ (a).unit;
  }
  return a.kind;
}
/** @param {Node} n */
function kindOf(n) {
  return n.kind;
}
const d = new Dimension();
const asBase = /** @type {Node} */ (d);
console.log(run(new Dimension()), run(new Color()), kindOf(asBase), kindOf(/** @type {Node} */ (d)), /** @type {Dimension} */ (d).unit);
`,
    },
  },
  {
    // the single-class downcast twin (an ICE: the value kept its class
    // under the cast's type), reached.
    id: "jsdoc-cast-downcast",
    entry: "main.cjs",
    files: {
      "main.cjs": `'use strict';
class Node {
  constructor() {
    this.kind = "node";
  }
}
class Dimension extends Node {
  constructor() {
    super();
    this.unit = "px";
  }
}
/** @param {Node} a */
function unitOf(a) {
  return /** @type {Dimension} */ (a).unit;
}
console.log("before");
console.log(unitOf(new Dimension()));
`,
    },
    fence: { stdout: "before\n", stderr: /^tsinter: unsupported: JSDoc @type casts that change a value's type \('Node' cast to 'Dimension' — a comment cast has no runtime check; narrow with instanceof instead\) is not supported yet \[SC1090 at <ROW>:15\]\n$/ },
  },
  // ── the #107 review's repros: a lowering may never be silently wrong.
  {
    // an implicit instance's concise body USES the ternary's value: one
    // void arm must not make the whole body a statement (Node prints 5;
    // the statement lowering returned undefined).
    id: "review-mixed-void-ternary-value",
    npmStatic: ["vta"],
    entry: "main.ts",
    files: {
      "node_modules/vta/package.json": pkg("vta"),
      "node_modules/vta/index.js": `'use strict';
function log(s) { console.log("log:" + s); }
const pick = (c, x) => c ? x : log("none");
function run(c, x) { return pick(c, x); }
exports.run = run;
`,
      "main.ts": `import { run } from "vta";
console.log(run(true, 5));
console.log(run(false, 5));
console.log(run(true, "s"));
`,
    },
    // U1b: the JS source joins the one world and the mixed ternary is a
    // value that runs as in Node (5, log:none then undefined, s).
  },
  {
    // a JSDoc cast to a record type would COPY: a write through it must
    // reach the original (Node), so it stays refused.
    id: "review-jsdoc-cast-record-write",
    entry: "main.cjs",
    files: {
      "main.cjs": `class P { constructor() { this.x = 1; this.y = 2; } }
const p = new P();
console.log("before");
(/** @type {{x: number}} */ (p)).x = 42;
console.log(p.x);
`,
    },
    fence: { stdout: "before\n", stderr: /^tsinter: unsupported: JSDoc @type casts that change a value's type \('P' cast to '\{ x: number \}'.*\[SC1090 at <ROW>:4\]\n$/ },
  },
  {
    id: "review-jsdoc-cast-this-and-literal",
    entry: "main.cjs",
    files: {
      "main.cjs": `class P {
  constructor() { this.x = 1; this.y = 2; }
  reset() { /** @type {{ x: number }} */ (this).x = 0; }
}
const q = { x: 1, y: 2 };
console.log("before");
(/** @type {{ x: number }} */ (q)).x = 9;
console.log(q.x);
const p = new P();
p.reset();
console.log(p.x);
`,
    },
    fence: { stdout: "before\n", stderr: /^tsinter: unsupported: JSDoc @type casts that change a value's type .*\[SC1090 at <ROW>:7\]\n$/ },
  },
  {
    // a nested declaration reassigned to a function with another return
    // type is named at the declaration.
    id: "review-reassigned-fn-other-return",
    npmStatic: ["relazy"],
    entry: "main.ts",
    files: {
      "node_modules/relazy/package.json": pkg("relazy"),
      "node_modules/relazy/index.js": `'use strict';
function outer() {
  function get() {
    get = function () { return "text"; };
    return 1;
  }
  return [get(), get()].join(",");
}
exports.outer = outer;
`,
      "main.ts": `import { outer } from "relazy";
console.log("before");
console.log(outer());
`,
    },
    fence: { stdout: "before\n", stderr: /^tsinter: unsupported: a function declaration \('get', returning 'number'\) reassigned to a function returning 'string' is not supported yet \[SC1090 at <ROW>[^\]]*index\.js:\d+\]\n$/ },
  },
];

describe("GH #107 survey ICE repros (wasm lane)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const entry = layout(row);
    const outDir = join(scratch, `${id}-out`);
    const res = await compile(entry, {
      outPath: join(outDir, "m.wasm"),
      outDir,
      backend: "wasm",
      dynamic: false,
      ...(row.npmStatic ? { npmStatic: row.npmStatic } : {}),
    });
    if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
    if (row.fence) {
      const r = await runWasmToTrap(res.binaryPath);
      expect(String(r.stdout)).toBe(row.fence.stdout);
      const stderr = String(r.stderr).split(entry).join("<ROW>").split(dirname(entry) + "/").join("<ROW>");
      expect(stderr, stderr).toMatch(row.fence.stderr);
      return;
    }
    const node = nodeRun(entry);
    const r = await runWasm(res.binaryPath);
    expect(String(r.stdout)).toBe(node.stdout);
    expect(r.exitCode).toBe(node.exitCode);
  });
});

describe("GH #107 named refusals instead of thrown errors", () => {
  test("SC0005: a .d.ts entry inside node_modules (the survey's @emotion/react and vue entries)", async () => {
    const entry = layout({
      id: "dts-entry",
      entry: "node_modules/typed/types.d.ts",
      files: {
        "node_modules/typed/package.json": pkg("typed"),
        "node_modules/typed/index.js": "exports.x = 1;\n",
        "node_modules/typed/types.d.ts": "export interface Point { x: number; y: number }\n",
      },
    });
    const outDir = join(scratch, "dts-entry-out");
    const res = await compile(entry, { outPath: join(outDir, "m.wasm"), outDir, backend: "wasm", npmStatic: ["typed"] });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.code)).toEqual(["SC0005"]);
    expect(res.diagnostics[0]!.message).toContain("is a declaration file (.d.ts) the TypeScript checker did not load as a program source");
    const { coverage } = analyze(entry, { npmStatic: ["typed"] });
    expect(coverage.preflightFailed).toBe(true);
    expect(coverage.diagnostics.map((d) => d.code)).toEqual(["SC0005"]);
  });

  test("SC0005: a missing entry", async () => {
    const entry = join(scratch, "no-such-entry.ts");
    const res = await compile(entry, { outPath: join(scratch, "nse.wasm"), outDir: scratch, backend: "wasm" });
    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]!.code).toBe("SC0005");
    expect(res.diagnostics[0]!.message).toContain("the file does not exist");
  });

  test("analyze() names the deferred fences the fixes left (no crash, no SC9001)", () => {
    const sites = (id: string, row: Row): string[] => {
      const entry = layout({ ...row, id: `${id}-an` });
      const { coverage } = analyze(entry, row.npmStatic ? { npmStatic: row.npmStatic } : {});
      return [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].map((d) => `${d.code} ${d.message}`);
    };
    const byId = (id: string): Row => ROWS.find((r) => r.id === id)!;
    const failed = sites("failed-instance-reused", byId("failed-instance-reused"));
    expect(failed.some((s) => s.startsWith("SC2004 uses of '__name' inherit the blocker"))).toBe(true);
    expect(failed.some((s) => s.startsWith("SC9001"))).toBe(false);
    const cast = sites("jsdoc-cast-union-read", byId("jsdoc-cast-union-read"));
    expect(cast).toEqual([
      "SC1090 JSDoc @type casts that change a value's type ('Node' cast to 'Color | Dimension' — a comment cast has no runtime check; narrow with instanceof instead) is not supported yet",
    ]);
  });

  test("a childStream slot in a module the pipe prescan did not mark emits (esbuild: compile() threw)", () => {
    const loc: SrcLoc = { file: "child-stream-slot.ts", start: 0, end: 0 };
    const mod: IrModule = {
      irVersion: 3,
      sourceFile: "child-stream-slot.ts",
      entry: "%init.0",
      globals: [],
      classes: [],
      functions: [
        {
          name: "%init.0",
          params: [],
          returnType: VOID,
          locals: [{ id: "stdout.0", name: "stdout", type: { kind: "childStream" }, mutable: true }],
          body: [{ kind: "varDecl", localId: "stdout.0", init: null, loc }],
          loc,
        },
      ],
    };
    const bytes = emitWasmModule(mod);
    expect(WebAssembly.validate(bytes)).toBe(true);
  });
});
