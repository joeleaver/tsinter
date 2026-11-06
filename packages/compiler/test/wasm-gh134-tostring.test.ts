/* GH #134: a dynamic object's (or function's) own `toString` / `valueOf`
 * member — or one it inherits through an A2 prototype link — is the one
 * JavaScript's conversions call: String(o), `${o}`, the method call
 * o.toString(), a dynamic array's join / toString, and the `+` operator
 * (ToPrimitive with the default hint: valueOf before toString). A member
 * answering an object falls through to the next; neither answering a
 * primitive is V8's TypeError "Cannot convert object to primitive value";
 * a member's throw propagates; a method-style member sees `this` = the
 * object. Sites that still convert through the total helper refuse by
 * name rather than answer "[object Object]".
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh134-"));
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
  /** Further files of the program, by name. */
  files?: Record<string, string>;
  /** Build with --dynamic (the engine). */
  dynamic?: true;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's) — a construct this lane does not
   * model yet, refused by name rather than answered wrongly. */
  fence?: { text: RegExp; stdout: string };
  /** Refuses to compile with the named code (and message). */
  refused?: { code: string; text: RegExp };
}

/** The catch-and-print helper every error row uses. */
const T = `const t = (f) => { try { console.log(f()); } catch (e) { console.log((e instanceof TypeError ? "TypeError" : "other") + ": " + e.message); } };`;
const TT = `const t = (f: () => unknown): void => { try { console.log(f()); } catch (e) { console.log((e instanceof TypeError ? "TypeError" : "other") + ": " + (e as Error).message); } };`;

const ROWS: Row[] = [
  // ── JavaScript sources ──────────────────────────────────────────────
  {
    id: "GH134-JS-01 an own arrow toString on an empty literal (the issue's repro)",
    entry: "main.js",
    src: `const o = {};
o.toString = () => "mine";
console.log(o.toString(), String(o), \`\${o}\`);
console.log("" + o, o + "!", \`[\${o}]\`, String(o).length);`,
  },
  {
    id: "GH134-JS-02 a method-style toString sees this = the object",
    entry: "main.js",
    src: `'use strict';
const o = {};
o.x = 3;
o.toString = function () { return "x=" + this.x; };
console.log(o.toString(), String(o), \`\${o}\`, o + "");
o.x = 4;
console.log(String(o), \`<\${o}>\`);
const j = JSON.parse('{"n":2}');
j.toString = function () { return "J" + this.n; };
console.log(j.toString(), String(j), \`\${j}\`, j + "", "" + j);`,
  },
  {
    id: "GH134-JS-03 + calls valueOf before toString; String() and templates call toString first",
    entry: "main.js",
    src: `const o = JSON.parse("{}");
o.valueOf = () => 42;
o.toString = () => "s";
console.log(o + "", "" + o, \`\${o}\`, String(o), o.toString());
let acc = "a";
acc += o;
console.log(acc);
const v = JSON.parse("{}");
v.valueOf = () => 5;
console.log(v + "", \`\${v}\`, String(v), v.toString());
const w = JSON.parse("{}");
w.valueOf = () => ({});
w.toString = () => "W";
console.log(w + "", String(w));`,
  },
  {
    id: "GH134-JS-04 a dynamic array's join / toString / String converts each element through its own toString",
    entry: "main.js",
    src: `const q = JSON.parse('{"list":[{"n":1},{"n":2}],"mixed":[null,{"n":3},7]}');
for (const it of q.list) it.toString = function () { return "#" + this.n; };
q.mixed[1].toString = () => "M";
console.log(q.list.join(" "), String(q.list), \`\${q.list}\`, q.list + "", q.list.toString());
console.log(q.mixed.join("-"), String(q.mixed), "[" + q.mixed + "]");
const nested = JSON.parse("[[1],[2]]");
nested[1].push(q.list[0]);
console.log(String(nested), nested.join("|"));`,
  },
  {
    id: "GH134-JS-05 conversion errors are catchable with V8's texts",
    entry: "main.js",
    src: `${T}
const a = JSON.parse("{}"); a.toString = () => ({});
t(() => String(a));
t(() => \`\${a}\`);
t(() => a + "");
const arr = JSON.parse("[1]"); arr.push(a);
t(() => arr.join());
const b = JSON.parse("{}"); b.toString = () => ({}); b.valueOf = () => 7;
t(() => String(b));
t(() => b + "");
const c = JSON.parse("{}"); c.toString = () => { throw new Error("boom"); };
t(() => String(c));
t(() => \`\${c}\`);
t(() => c + "");
t(() => c.toString());
const d = JSON.parse("{}");
d.toString = 5;
t(() => String(d));
t(() => d + "");
t(() => d.toString());
const j = JSON.parse('{"toString":"x"}');
t(() => String(j));
t(() => j.toString());
const k = JSON.parse('{"toString":"x","valueOf":null}');
t(() => \`\${k}\`);
console.log("after");`,
  },
  {
    id: "GH134-JS-06 toLocaleString calls the toString member",
    entry: "main.js",
    src: `const o = JSON.parse("{}");
o.toString = () => "L";
const p = JSON.parse('{"n":1}');
console.log(o.toLocaleString(), p.toLocaleString());`,
  },
  {
    id: "GH134-JS-07 a null-prototype object converts through its own members, else throws",
    entry: "main.js",
    src: `${T}
const g = Object.create(null); g.toString = () => "G";
t(() => String(g)); t(() => g + ""); t(() => g.toString()); t(() => \`\${g}\`);
const h = Object.create(null); h.valueOf = () => 3;
t(() => String(h)); t(() => h + "");
const k = Object.create(null);
t(() => String(k));
t(() => \`\${k}\`);`,
  },
  {
    id: "GH134-JS-08 an object without its own members keeps the inherited answers",
    entry: "main.js",
    src: `const o = JSON.parse('{"a":1}');
const arr = JSON.parse('[1,[2,3],null,{"b":2}]');
console.log(String(o), \`\${o}\`, o + "", o.toString(), String(arr), arr + "", arr.join(";"), arr.toString());
const n = JSON.parse('[null,true,"s",2.5]');
console.log(\`\${n}\`, String(n[0]), \`\${n[1]}\`, "" + n[2], n[3] + "");`,
  },
  {
    id: "GH134-JS-09 a getter-defined toString is read, then called",
    entry: "main.js",
    src: `'use strict';
/** @returns {*} */
function mk() {
  return { get toString() { return () => "got"; } };
}
const o = mk();
console.log(String(o), \`\${o}\`, o + "");`,
  },
  {
    id: "GH134-JS-10 --dynamic: an Object.create link's inherited toString",
    entry: "main.js",
    dynamic: true,
    src: `'use strict';
/** @returns {*} */
function mk() {
  return { n: 0, toString() { return "own"; } };
}
const w = mk();
const d = Object.create(w);
console.log(d.toString(), String(d), \`\${d}\`, d + "");`,
  },
  {
    id: "GH134-JS-11 a bare console argument inspects an object with its own toString (it never calls it)",
    entry: "main.js",
    src: `const o = JSON.parse('{"a":1}');
o.toString = () => "custom";
const th = JSON.parse("{}");
th.toString = () => { throw new Error("never"); };
const np = Object.create(null); np.toString = () => "NP";
console.log(o);
console.error("err:", o, th);
console.log("x", th, np);
console.log("%s|", o, th);`,
  },
  {
    id: "GH134-JS-12 --dynamic: a bare console argument over an Object.create link inspects",
    entry: "main.js",
    dynamic: true,
    src: `'use strict';
/** @returns {*} */
function mk() {
  return { n: 2, toString() { return "P"; } };
}
const o = Object.create(mk());
o.n = 3;
console.log(o);
console.log("x", o);
console.log("%s", o);`,
  },
  {
    id: "GH134-JS-13 a cyclic array converts with V8's join-stack guard",
    entry: "main.js",
    src: `const c = JSON.parse("[1,2]");
c.push(c);
console.log(c.join("-"), String(c), \`\${c}\`, c + "", c.toString());
const a = JSON.parse("[1]");
const b = JSON.parse("[2]");
a.push(b);
b.push(a);
console.log(String(a), a.join(";"), String(b));
const d = JSON.parse("[[3]]");
const twice = JSON.parse("[]");
twice.push(d, d);
console.log(String(twice), twice.join("|"));`,
  },
  // ── TypeScript sources ──────────────────────────────────────────────
  {
    id: "GH134-TS-01 an any object's own toString (the issue's TS repro)",
    src: `const o: any = {};
o.toString = () => "mine";
console.log(o.toString(), String(o), \`\${o}\`, "" + o, o + "!", o + 1);
const u: unknown = o;
console.log(String(u), \`\${u}\`);`,
  },
  {
    id: "GH134-TS-02 a method-style toString built in JavaScript, converted in TypeScript",
    files: {
      "lib.js": `export function mk(n) {
  const o = JSON.parse("{}");
  o.n = n;
  o.toString = function () { return "N" + this.n; };
  return o;
}
`,
    },
    src: `import { mk } from "./lib.js";
const a: any = mk(1);
const b: any = mk(2);
console.log(a.toString(), String(b), \`\${a}/\${b}\`, a + "", a + b);
const xs: any[] = [a, b, null];
console.log(xs.join(","), String(xs));`,
  },
  {
    id: "GH134-TS-03 valueOf and toString in ToPrimitive order on any values",
    src: `const o: any = JSON.parse("{}");
o.valueOf = () => 42;
o.toString = () => "s";
console.log(o + 1, o + "", \`\${o}\`, String(o), o * 2, o > 41, o - 2);
const xs: any[] = [o];
console.log(xs.join(), String(xs), xs + "");
const v: any = JSON.parse("{}");
v.valueOf = () => 5;
console.log(v + 1, \`\${v}\`, String(v), v + "");
let s = "x";
s += o;
console.log(s);`,
  },
  {
    id: "GH134-TS-04 an array operand's elements convert before the other operand's valueOf",
    src: `const log: string[] = [];
const a: any = JSON.parse("{}");
a.toString = () => { log.push("a.toString"); return "A"; };
const b: any = JSON.parse("{}");
b.valueOf = () => { log.push("b.valueOf"); return 1; };
const arr: any = JSON.parse("[]");
arr.push(a);
console.log(arr + b, log.join(","));`,
  },
  {
    id: "GH134-TS-05 conversion errors are catchable on any values",
    src: `${TT}
const a: any = JSON.parse("{}");
a.toString = () => ({});
t(() => String(a));
t(() => \`\${a}\`);
t(() => a + "");
t(() => a + 1);
const c: any = JSON.parse("{}");
c.toString = () => { throw new RangeError("boom"); };
t(() => String(c));
t(() => \`\${c}\`);
t(() => c.toString());
t(() => c + "");
const e: any = JSON.parse("{}");
e.valueOf = () => ({});
e.toString = () => ({});
t(() => e + 1);
t(() => e * 1);
t(() => String(e));
console.log("after");`,
  },
  {
    id: "GH134-TS-06 a Record<string, any> with its own toString",
    src: `const r: Record<string, any> = {};
r.toString = () => "rec";
console.log(String(r), \`\${r}\`, r + "", r.toString());
const xs: any[] = [r, 1];
console.log(xs.join("|"), String(xs));`,
  },
  {
    id: "GH134-TS-07 a class's own toString method (unchanged)",
    src: `class P { x = 1; toString(): string { return "P" + this.x; } }
const p = new P();
console.log(p.toString());`,
  },
  {
    id: "GH134-TS-08 a typed value converted by String() whose type declares toString refuses at compile time",
    src: `class P { x = 1; toString(): string { return "P" + this.x; } }
const p = new P();
console.log(String(p), \`\${p}\`);`,
    refused: { code: "SC2011", text: /values of type 'P' have no static representation/ },
  },
  {
    id: "GH134-TS-09 a typed record with a toString member refuses at compile time",
    src: `type R = { n: number; toString: () => string };
const r: R = { n: 1, toString: () => "R" };
console.log(String(r));`,
    refused: { code: "SC2011", text: /values of type 'R' have no static representation/ },
  },
  {
    id: "GH134-TS-10 a toString member answering a non-string, called as a method, stops at its fence",
    src: `const o: any = JSON.parse("{}");
o.toString = () => 5;
console.log(String(o), \`\${o}\`, o + "");
console.log(o.toString());`,
    fence: { text: /an own toString member that answers a non-string value, called as a method, is not supported yet/, stdout: "5 5 5\n" },
  },
  {
    id: "GH134-TS-11 an own toString called with an argument stops at its fence",
    src: `const o: any = JSON.parse("{}");
o.toString = (enc: string) => "enc:" + enc;
console.log("before");
console.log(o.toString("hex"));`,
    fence: { text: /calling an object's own toString member with an argument is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH134-TS-12 a conversion site without the object protocol refuses an own toString by name",
    src: `const o: any = JSON.parse("{}");
o.toString = () => "1.5";
console.log("before", String(o));
console.log(parseFloat(o));`,
    fence: { text: /converting an object with its own toString member to a string at this site is not supported yet/, stdout: "before 1.5\n" },
  },
  {
    id: "GH134-TS-13 util.format's %s String()s an object with its own toString, else inspects",
    src: `const o: any = JSON.parse("{}");
o.toString = () => "pct";
const p: any = JSON.parse('{"toString":5}');
const n: any = JSON.parse("{}");
n.toString = () => 5;
const plain: any = JSON.parse('{"a":1}');
console.log("%s|%s|%s|%s", o, p, n, plain);
const th: any = JSON.parse("{}");
th.toString = () => { throw new Error("fmt"); };
try { console.log("%s", th); } catch (e) { console.log("caught", (e as Error).message); }`,
  },
  {
    id: "GH134-TS-14 a property key, a sort's default order, a join separator and a relational operand convert through toString",
    src: `const o: any = JSON.parse("{}");
o.toString = () => "k";
const m: any = {};
m[o] = 1;
console.log(JSON.stringify(m), m[o], m.k);
const a: any = JSON.parse("{}"); a.toString = () => "b";
const b: any = JSON.parse("{}"); b.toString = () => "a";
const xs: any[] = [a, b, "c"];
xs.sort();
console.log(String(xs));
const sep: any = JSON.parse("{}"); sep.toString = () => "+";
const ns: any = JSON.parse("[1,2]");
console.log(ns.join(sep));
console.log(a < "c", a > "c", "a" < a);
const arr: any = JSON.parse("[]"); arr.push(a);
console.log(arr < "c", Number(JSON.parse('{"x":1}')) > 0);`,
  },
  {
    id: "GH134-TS-15 a throwing toString inside a sort or a key conversion is catchable",
    src: `${TT}
const a: any = JSON.parse("{}");
a.toString = () => { throw new Error("st"); };
const xs: any[] = [a, 1];
t(() => xs.sort());
const m: any = {};
t(() => { m[a] = 1; return "set"; });
console.log("after", JSON.stringify(m));`,
  },
  {
    id: "GH134-TS-16 String(e) of a thrown dynamic object calls its own toString",
    src: `const o: any = JSON.parse("{}");
o.toString = () => "thrown";
try { throw o; } catch (e) { console.log(String(e), \`[\${e}]\`); }
const bad: any = JSON.parse("{}");
bad.toString = () => { throw new Error("inner"); };
try {
  try { throw bad; } catch (e) { console.log(String(e)); }
} catch (e2) { console.log("outer", (e2 as Error).message); }`,
  },
  {
    id: "GH134-TS-17 Number(), unary plus and Math over an object with its own toString",
    src: `const o: any = JSON.parse("{}");
o.toString = () => "12";
console.log(Number(o), +o, o * 1, Math.max(o, 3));`,
  },
  {
    id: "GH134-TS-18 bare console.log / console.error arguments inspect; a throwing toString is never called",
    src: `const o: any = { a: 1 };
o.toString = () => "custom";
console.log(o);
console.error("err:", o);
const r: Record<string, any> = JSON.parse('{"k":2}');
r.toString = () => { throw new Error("nope"); };
console.log("before");
console.log(r);
console.log("x", r, [r]);
console.log("after");`,
  },
  {
    id: "GH134-TS-19 a compound += onto a string field converts an any operand valueOf-first",
    src: `const a: any = JSON.parse("{}");
a.valueOf = () => 1;
a.toString = () => "A";
class C { s = "c"; }
const c = new C();
c.s += a;
const r = { s: "r" };
r.s += a;
let l = "l";
l += a;
console.log(c.s, r.s, l, "x" + a, \`\${a}\`);`,
  },
  {
    id: "GH134-JS-14 util.format's %s over a getter-defined toString stops at its fence",
    entry: "main.js",
    src: `'use strict';
/** @returns {*} */
function mk() {
  return { get toString() { return () => "G"; } };
}
const g = mk();
console.log("before", String(g));
console.log("%s", g);`,
    fence: { text: /util.format's %s over an object whose toString is a getter is not supported yet/, stdout: "before G\n" },
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.files ?? {})) writeFileSync(join(dir, name), text);
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
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, ...(row.dynamic ? { dynamic: true } : {}) });
  if (row.refused !== undefined) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === row.refused!.code && row.refused!.text.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  if (row.fence !== undefined) {
    const got: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(got.stdout)).toBe(true);
    expect(got.stderr.split("\n")[0]).toMatch(/^tsinter: unsupported: /);
    expect(got.stderr.split("\n")[0]).toMatch(row.fence.text);
    return;
  }
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("GH #134: own toString / valueOf conversions (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #134: own toString / valueOf conversions (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
