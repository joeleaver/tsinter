/* JS copy refusals turned into sharing (SEMANTICS.md S128, its amendment
 * for function-literal results; S125 (c)). Driven by the round-3 npm
 * survey: every build-blocking copy refusal sampled in lodash, tslib and
 * js-yaml was a function literal crossing into dynamic code whose
 * composite RESULT would have been copied. Each row is a small program
 * written for this file in the shape of the package's pattern; no
 * third-party source is copied.
 *
 *   - A result built fresh (`() => []`, `function () { return [[], []]; }`,
 *     `(c) => Object.keys(c)`): the checked copy of a dynamic value nothing
 *     else holds is the only one, so the copy is unobservable and builds.
 *   - Any other result of a function literal handed to dynamic code (a
 *     shared array, a local the function filled through other functions —
 *     tslib's `__rest`, lodash's `omit`/`stringToPath`) takes the dynamic
 *     arm: the function returns the value itself, shared as in Node.
 *   - A dynamic argument into a JSDoc-typed parameter of a JavaScript
 *     function (lodash's documented helpers) takes S125 (a)'s per-call-site
 *     instance with the parameter on the dynamic arm, as TypeScript does.
 *   - A JSDoc-typed `var` of a function (sinon's shape) holds the dynamic
 *     value it is initialized from, as a `const`/`let` does.
 *
 * Every row equals Node (spawned at test time) on the wasm and wasm-native
 * lanes; before this change each refused to build with an S125 (c) COPY.
 * The JSC-HELD rows (from the review) pin the other side: a copy of a value
 * that is still held elsewhere (a module const) inside what a boxed function
 * returns refuses by name, never a silent copy. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-js-copies-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  /** main.js unless set */
  entry?: string;
  /** The copy is observable and has no sharing form yet: the build
   * refuses with SC1090 naming S125's COPY (never a silent copy). */
  refused?: true;
}

const COPY_REFUSAL = /it would be a COPY where JavaScript shares the object, and .* \(SEMANTICS\.md S125\)/;

const ROWS: Row[] = [
  {
    id: "JSC-FRESH-01 js-yaml: a callback returning Object.keys of its argument",
    src: `const ks = JSON.parse('[{"x":1,"y":2},{"q":3}]').map((c) => Object.keys(c));
ks[0].push("w");
console.log(ks, ks[1].length);`,
  },
  {
    id: "JSC-FRESH-02 js-yaml: an arrow building an empty array, stored on a dynamic object",
    src: `const mk = () => [];
const holder = JSON.parse("{}");
holder.make = mk;
const a = holder.make();
a.push(1);
const b = holder.make();
console.log(a, b, a === b);`,
  },
  {
    id: "JSC-FRESH-03 lodash listCacheClear: a function returning a literal of fresh arrays",
    src: `function listCacheClear() { return [[], []]; }
const holder = JSON.parse("{}");
holder.clear = listCacheClear;
const c = holder.clear();
c[0].push(5);
console.log(c, holder.clear());`,
  },
  {
    id: "JSC-ARM-01 tslib __rest: a function value in a var, its result a local it filled",
    src: `var __rest = function (s, e) {
  var t = {};
  for (var p of Object.keys(s)) if (e.indexOf(p) < 0) t[p] = s[p];
  return t;
};
const src = JSON.parse('{"a":1,"b":2,"c":3}');
const ex = JSON.parse("{}");
ex.__rest = __rest;
const r = ex.__rest(src, ["b"]);
r.z = 9;
console.log(r, Object.keys(r));`,
  },
  {
    id: "JSC-ARM-02 a shared array handed out by a function stored on a dynamic object",
    src: `const holder = JSON.parse("{}");
const cache = [1, 2];
holder.get = function () { return cache; };
const a = holder.get();
a.push(3);
console.log(cache);
cache.push(4);
console.log(a);
const tbl = { rows: [] };
holder.rows = () => tbl.rows;
holder.rows().push("r");
console.log(tbl);`,
  },
  {
    id: "JSC-ARM-03 lodash omit / stringToPath: a function literal handed to a higher-order helper",
    src: `function flatRest(func) {
  return function () { return func.apply(this, arguments); };
}
function copyObject(source, props, object) {
  for (var i = 0; i < props.length; i++) object[props[i]] = source[props[i]];
  return object;
}
var omit = flatRest(function (object, paths) {
  var result = {};
  if (object == null) {
    return result;
  }
  copyObject(object, Object.keys(object).filter(function (k) { return paths.indexOf(k) < 0; }), result);
  return result;
});
var o = omit({ a: 1, b: "2", c: 3 }, ["a", "c"]);
o.z = 1;
console.log(o, omit(null, []));
function memoize(func) {
  var last = null;
  var lastKey = "";
  return function (key) {
    if (last !== null && key === lastKey) return last;
    last = func(key);
    lastKey = key;
    return last;
  };
}
var stringToPath = memoize(function (string) {
  var result = [];
  if (string.charCodeAt(0) === 46) result.push("");
  string.split(/[.[\\]]/).forEach(function (part) { if (part !== "") result.push(part); });
  return result;
});
var p1 = stringToPath("a.b[0]");
p1.push("x");
console.log(p1, stringToPath("a.b[0]"), stringToPath(".q"));`,
  },
  {
    id: "JSC-PARAM-01 a dynamic argument into a JSDoc-typed parameter of a JavaScript function: the per-call-site instance shares it",
    src: `/**
 * @param {string[]} path
 * @param {string} part
 * @returns {number}
 */
function addPart(path, part) {
  path.push(part);
  return path.length;
}
const own = ["x"];
console.log(addPart(own, "y"), own);
const data = JSON.parse('{"path":["a"]}');
console.log(addPart(data.path, "b"), data.path);
console.log(addPart(data.path, "c"), data.path.join("/"));
/** @param {{ n: number }} o */
function bump(o) { o.n += 1; }
const q = JSON.parse('{"n":1,"extra":true}');
bump(q);
bump(q);
console.log(q);`,
  },
  {
    id: "JSC-VAR-01 a JSDoc-typed var of a function holds the dynamic value it is initialized from (captured, in a loop)",
    src: `/** @typedef {{ calls: string[] }} Spy */
function track(raw) {
  /** @type {Spy} */
  var spy = raw;
  spy.calls.push("a");
  return spy.calls.length;
}
const shared = JSON.parse('{"calls":[],"name":"s"}');
console.log(track(shared), track(shared), shared);
function hoisted(raw) {
  var before = "b";
  /** @type {Spy} */
  var spy = raw;
  var get = function () { return spy.calls.length; };
  spy.calls.push("h");
  return before + " " + get();
}
console.log(hoisted(shared), shared.calls);
function loop(list) {
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    /** @type {Spy} */
    var s = list[i];
    s.calls.push(String(i));
    n += s.calls.length;
  }
  return n;
}
const arr = JSON.parse('[{"calls":[]},{"calls":["x"]}]');
console.log(loop(arr), JSON.stringify(arr));`,
  },
  {
    id: "JSC-HELD-01 (review) a module const inside a returned array literal is shared, never fresh: refused, never a silent copy",
    src: `const cache = { n: 1 };
const holder = JSON.parse("{}");
holder.mk = () => [cache];
holder.mk()[0].n = 9;
console.log(cache);`,
    refused: true,
  },
  {
    id: "JSC-HELD-02 (review) ... beside a fresh literal",
    src: `const cache = { n: 1 };
const holder = JSON.parse("{}");
holder.mk = () => [cache, { n: 2 }];
const x = holder.mk();
x[0].n = 9;
console.log(cache, x);`,
    refused: true,
  },
  {
    id: "JSC-HELD-03 (review) ... through a returned local",
    src: `const cache = { n: 1 };
const holder = JSON.parse("{}");
holder.mk = function () { const r = [cache]; return r; };
holder.mk()[0].n = 9;
console.log(cache);`,
    refused: true,
  },
  {
    id: "JSC-HELD-04 (review; silently copied on main) ... inside a returned object literal",
    src: `const cache = { n: 1 };
const holder = JSON.parse("{}");
holder.mk = () => ({ c: cache });
holder.mk().c.n = 9;
console.log(cache);`,
    refused: true,
  },
  {
    id: "JSC-UNION-01 moment relativeTime: `(c && ['m']) || (c2 && ['mm', n])` widens fresh literals into the union's array, then writes it (the copy is the only reference); a bool arm only `c && X` forms contribute holds only false and is not a result arm of `||`",
    src: `function rel(x, withoutSuffix, thresholds) {
  var seconds = Math.round(x),
    minutes = Math.round(x / 60),
    a =
      (seconds <= thresholds.ss && ["s", seconds]) ||
      (seconds < thresholds.s && ["ss", seconds]) ||
      (minutes <= 1 && ["m"]) ||
      (minutes < thresholds.m && ["mm", minutes]) ||
      ["yy", minutes];
  a[2] = String(withoutSuffix);
  a[3] = seconds * 2;
  a[4] = "loc";
  return a.join("|");
}
const th = { ss: 44, s: 45, m: 45 };
console.log(rel(10, true, th), rel(50, false, th), rel(100, true, th), rel(3000, false, th), rel(99999, true, th));`,
  },
  {
    id: "JSC-UNION-02 (review) TypeScript: a value only TYPED false (a flag a call flipped) is no proof: `u || d` keeps its bool arm (no falseArm) and answers true as Node, never an illegal cast",
    entry: "main.ts",
    src: `let ok = false;
function flip(): void { ok = true; }
flip();
const u = Math.random() < 2 ? ok : ["x"];
console.log(u || ["d"]);`,
  },
  {
    id: "JSC-UNION-03 (review) JavaScript: the same flipped flag answers true as Node",
    src: `let ok = false;
function flip() { ok = true; }
flip();
const u = Math.random() < 2 ? ok : ["x"];
console.log(u || ["d"]);`,
  },
  {
    id: "JSC-UNION-04 (review) TypeScript: an `as false` cast is no proof either, inline in the || chain: true as Node",
    entry: "main.ts",
    src: `let ok = false;
function flip(): void { ok = true; }
flip();
console.log((Math.random() < 2 ? (ok as false) : ["x"]) || ["d"]);`,
  },
  {
    id: "JSC-ARM-04 TypeScript: an annotated function literal stored on an 'any' object returns the shared value",
    entry: "main.ts",
    src: `const holder: any = JSON.parse("{}");
const cache: number[] = [1, 2];
holder.get = (): number[] => cache;
const a = holder.get();
a.push(3);
console.log(cache);
cache.push(4);
console.log(a);
const cfg = { tags: ["x"] };
holder.tags = function () { return cfg.tags; };
holder.tags().push("y");
console.log(cfg);`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.js");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(row, backend);
  const dir = dirname(entry);
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (row.refused) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "SC1090" && COPY_REFUSAL.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got).toEqual(node);
}

describe("JS copies: contained slots (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("JS copies: contained slots (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
