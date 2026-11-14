/* GH #204: a JavaScript array binding whose program writes elements of
 * another kind than its literals' element type (moment's relativeTime:
 * `a[2] = withoutSuffix; a[3] = +x > 0; a[4] = locale` on an array typed
 * `(string | number)[]`) is the dynamic array when every value assigned
 * to it is fresh, so the writes store the value as in Node (SEMANTICS.md
 * S014's U1b amendment). An alias of another array keeps its typed array
 * and the write's named stop.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh204-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source (written as main.ts unless `entry` names another). */
  src: string;
  entry?: string;
  /** Ends uncaught: Node and this tier both exit 1 after the same stdout,
   * and this tier's report is `report` (S007). */
  uncaught?: { report: string };
  /** Still stops by name on this tier: stdout up to the stop is a prefix
   * of Node's, and stderr names the diagnostic. */
  fence?: string;
}

const ROWS: Row[] = [
  {
    id: "GH204-01 moment's relativeTime: a ||-chain array written with a boolean, a boolean and an object, applied",
    entry: "main.js",
    src: `function substituteTimeAgo(string, number, withoutSuffix, isFuture, locale) {
  return locale.relativeTime(number || 1, !!withoutSuffix, string, isFuture);
}
var loc = { relativeTime: function (n, ws, s, fut) { return s + ":" + n + ":" + ws + ":" + fut; } };
function rel(x, withoutSuffix, thresholds, locale) {
  var seconds = Math.round(x),
    minutes = Math.round(x / 60),
    a =
      (seconds <= thresholds.ss && ["s", seconds]) ||
      (seconds < thresholds.s && ["ss", seconds]) ||
      (minutes <= 1 && ["m"]) ||
      (minutes < thresholds.m && ["mm", minutes]) ||
      ["yy", minutes];
  a[2] = withoutSuffix;
  a[3] = +x > 0;
  a[4] = locale;
  return substituteTimeAgo.apply(null, a);
}
var th = { ss: 44, s: 45, m: 45 };
console.log(rel(10, true, th, loc), rel(50, false, th, loc), rel(100, true, th, loc), rel(3000, false, th, loc), rel(99999, true, th, loc));`,
  },
  {
    id: "GH204-02 push of an object and a boolean: length, JSON, inspect and element reads as Node",
    entry: "main.js",
    src: `function f(n) {
  var a = ["x", n];
  a.push({ k: 1 });
  a.push(true);
  console.log(a.length, JSON.stringify(a), a, typeof a[2], a[2].k, a[3] === true, Array.isArray(a));
  return a;
}
var r = f(3);
r.unshift(null);
console.log(r, r.join("-"));`,
  },
  {
    id: "GH204-03 fill and splice inserting other kinds",
    entry: "main.js",
    src: `function g() {
  var a = [1, 2, 3, 4];
  a.fill(false, 1, 2);
  a.splice(2, 1, "s", null);
  console.log(a, a.length, a.indexOf(false), a.includes(null));
  for (var i = 0; i < a.length; i++) console.log(i, typeof a[i], String(a[i]));
}
g();`,
  },
  {
    id: "GH204-04 a module-scope var widens",
    entry: "main.js",
    src: `var tbl = [1, 2];
function add(v) { tbl[tbl.length] = v; }
add("three");
add(undefined);
console.log(tbl, tbl.length);`,
  },
  {
    id: "GH204-04b a closure-captured let widens, and the function returning it returns the dynamic array",
    entry: "main.js",
    src: `function mk() {
  let a = [0];
  const set = (v) => { a[0] = v; };
  set({ deep: [1] });
  return a;
}
var m = mk();
console.log(m, JSON.stringify(mk()), m.length);`,
  },
  {
    id: "GH204-05 a ?: initializer and a later fresh reassignment",
    entry: "main.js",
    src: `function h(c) {
  var a = c ? ["a"] : ["b", "c"];
  a[1] = 42;
  a[2] = c;
  console.log(a);
  a = [true];
  a[1] = "again";
  console.log(a, a.length);
}
h(true);
h(false);`,
  },
  {
    id: "GH204-05b a function returning a widened binding: its callers see the dynamic array",
    entry: "main.js",
    src: `function h(c) {
  var a = c ? ["a", "x"] : ["b", "c"];
  a[2] = c;
  return a;
}
var r = h(true);
r.push(null);
console.log(r, h(false), h(true)[2]);`,
  },
  {
    id: "GH204-09 a write past the end leaves a hole: reads and length as Node, and printing it stops by name (S119 (b), as a typed array's printing does)",
    entry: "main.js",
    src: `function h(c) {
  var a = ["a"];
  a[2] = c;
  return a;
}
var r = h(true);
console.log(r.length, r[1], r[2], r.join("-"));
console.log(r);`,
    fence: "printing (util.inspect) over an array that may hold holes",
  },
  {
    id: "GH204-06 arrays whose writes fit keep their element type",
    entry: "main.js",
    src: `var a = [1, 2];
a[2] = 3;
a.push(4);
var b = ["x", 1];
b[2] = "y";
b[3] = 5;
console.log(a, b, a.reduce(function (s, v) { return s + v; }, 0));`,
  },
  {
    id: "GH204-08 unary plus on a dynamic value is ToNumber (valueOf included), as in moment's `+posNegDuration > 0`",
    entry: "main.js",
    src: `function f(x) { return [+x, +x > 0]; }
var vals = ["12", "", " 7 ", "x", null, undefined, true, false, { valueOf: function () { return 5; } }, [3], -2];
for (var i = 0; i < vals.length; i++) console.log(i, f(vals[i]).join(" "));`,
  },
  {
    id: "GH204-07 an alias of another array keeps its typed array and the write stops by name",
    entry: "main.js",
    src: `var src = [1, 2];
var b = src;
console.log("before");
b[0] = JSON.parse('"x"');
console.log(src[0]);`,
    fence: "SC1100",
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
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
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.fence !== undefined) {
    expect(node.exitCode).toBe(0);
    expect(got.exitCode, row.id).not.toBe(0);
    expect(node.stdout.startsWith(got.stdout), row.id).toBe(true);
    expect(got.stderr, row.id).toContain(row.fence);
    return;
  }
  if (row.uncaught !== undefined) {
    expect(node.exitCode).toBe(1);
    expect(got.exitCode, row.id).toBe(1);
    expect(got.stdout, row.id).toBe(node.stdout);
    expect(got.stderr.split("\n")[0], row.id).toBe(row.uncaught.report);
    return;
  }
  expect(node.exitCode).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("GH #204: a JavaScript array written with other kinds (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #204: a JavaScript array written with other kinds (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
