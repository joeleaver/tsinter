/* Class-instance views (class-views.ts; SEMANTICS.md S115's class
 * amendment): a typed class instance entering a dynamic slot is SHARED as
 * a live view, and a dynamic value leaving into a class slot unwraps the
 * instance it views — the JavaScript library idioms S133's compiled npm
 * packages are made of (commander pushes `this` into `any[]` arrays,
 * stores Commands in null-initialized fields and hands them to callbacks
 * through `fn.apply(this, args)`).
 *
 * An exact row equals Node (spawned at test time). A `fence` row compiles,
 * prints Node's stdout up to the check, and ends at the named fence. Rows
 * run on the wasm lane; the wasm-native describe repeats them. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-cview-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Row {
  id: string;
  src: string;
  entry?: string;
  fence?: { text: RegExp; stdout: string };
}

const ROWS: Row[] = [
  {
    id: "CV-CHAIN-01 a null-initialized parent field walks to the root (a JSDoc'd field and an untyped one)",
    entry: "main.js",
    src: `class Node1 {
  constructor(name) {
    this.name = name;
    /** @type {Node1 | null} */
    this.parent = null;
    this.up = null;
    this.kids = [];
  }
  add(k) { k.parent = this; k.up = this; this.kids.push(k); return this; }
  path() {
    const out = [];
    for (let n = this; n; n = n.parent) out.push(n.name);
    return out.reverse().join('/');
  }
  path2() {
    const out = [];
    for (let n = this; n; n = n.up) out.push(n.name);
    return out.reverse().join('/');
  }
}
const r = new Node1('root');
const a = new Node1('a');
const b = new Node1('b');
r.add(a); a.add(b);
console.log(b.path(), r.parent === null, b.parent.name, r.kids.length);
console.log(b.path2());`,
  },
  {
    id: "CV-CB-01 instances through any[] arguments, fn.apply(this, args), hooks and a lazily-set callback field",
    entry: "main.js",
    src: `class Base {
  constructor() { this.kind = 'base'; }
  describe() { return 'I am ' + this.kind; }
}
class Cmd extends Base {
  constructor(name) {
    super();
    this.kind = 'cmd';
    this._name = name;
    this._handler = null;
    this.hooks = [];
    this.parent = null;
  }
  name() { return this._name; }
  action(fn) {
    this._handler = (args) => {
      const actionArgs = args.slice();
      actionArgs.push(this);
      return fn.apply(this, actionArgs);
    };
    return this;
  }
  hook(fn) { this.hooks.push(fn); return this; }
  run(args) {
    for (const h of this.hooks) h(this, args.length);
    return this._handler(args);
  }
  sub(name) { const c = new Cmd(name); c.parent = this; return c; }
}
const root = new Cmd('root');
const child = root.sub('child');
child.hook((cmd, n) => console.log('hook', cmd.name(), n, cmd.describe(), cmd instanceof Cmd, cmd instanceof Base));
child.action(function (a, b, cmd) {
  console.log('action', a, b, cmd.name(), this === cmd, cmd.parent.name());
  return [a, b].join('');
});
console.log(child.run(['x', 'y']));`,
  },
  {
    id: "CV-ARR-01 instances in a JS array: methods, identity, printing, JSON, writes through the view",
    entry: "main.js",
    src: `class Item {
  constructor(name, n) {
    this.name = name;
    this.n = n;
  }
  label() { return this.name + '#' + this.n; }
}
const bag = [];
bag.push(new Item('a', 1));
bag.push(new Item('b', 2));
console.log(bag.map((i) => i.label()).join(','), bag[0] === bag[0], bag[0] === bag[1]);
console.log(bag[1]);
console.log(JSON.stringify(bag));
const o = {};
o.it = bag[0];
o.it.n = 5;
console.log(bag[0].n);
const t = bag[1];
console.log(t instanceof Item, t.label());`,
  },
  {
    id: "CV-FENCE-01 a dynamic value that is no instance of the slot's class ends the program by name",
    src: `class P { v = 1; get(): number { return this.v; } }
const raw: any[] = [];
raw.push(new P());
raw.push({ v: 2 });
const first: P = raw[0];
console.log("first", first.get(), first === raw[0]);
const second: P = raw[1];
console.log("second", second.v);`,
    fence: { text: /Cannot store object into a 'P' slot \(it holds only 'P' instances\)/, stdout: "first 1 true\n" },
  },
  {
    id: "CV-CALL-01 a method called directly on a view (any[] push, an any[] literal, an any binding, a typed array crossed whole)",
    src: `class G {
  n = 3;
  a(s: string): string { return s + this.n; }
  greet(name: string = "world", times?: number): string { return ("hi " + name).repeat(times ?? 1); }
  add(k: number): this { this.n += k; return this; }
  pick(o: G | null): string { return o === null ? "none" : "g" + o.n; }
}
const arr: any[] = [];
arr.push(new G());
const lit: any[] = [new G()];
const one: any = new G();
const gs: G[] = [new G()];
const viaArr: any = gs;
for (const [k, g] of [["push", arr[0]], ["lit", lit[0]], ["one", one], ["viaArr", viaArr[0]]] as [string, any][]) {
  console.log(k, g.a("x"), g instanceof G, typeof g.a);
}
console.log(one.greet(), one.greet("bob"), one.greet("x", 2));
console.log(one.add(2).add(3).n, one.add(1) === one, gs[0].n);
console.log(one.pick(null), one.pick(one));`,
  },
  {
    id: "CV-CALL-02 a method read off a view runs on the call's own this: .call(other) on another instance (GH #186)",
    src: `class G {
  n: number;
  constructor(n: number) { this.n = n; }
  a(s: string): string { return s + this.n; }
}
const xs: any[] = [new G(1), new G(2)];
const m = xs[0].a;
console.log(m.call(xs[1], "x"), xs[0].a("y"), typeof m);
console.log(m.apply(xs[0], ["z"]));`,
  },
  {
    id: "CV-CALL-04 a base method called with a subclass instance as this runs the base body, not the override (GH #186 review)",
    src: `class G {
  n = 1;
  a(): string { return "G" + this.n; }
}
class H2 extends G {
  n = 2;
  a(): string { return "H" + this.n; }
}
const g: any = new G(), h: any = new H2();
console.log(g.a.call(h), g.a.apply(h, []), h.a(), g.a());
const ms: any[] = [new H2(), new G()];
console.log(ms[1].a.call(ms[0]), ms[0].a.call(ms[0]));`,
  },
  {
    id: "CV-CALL-03 a method read off a view and called detached stops by name (Node runs it with this undefined; GH #186)",
    src: `class G {
  n = 3;
  a(s: string): string { return s + this.n; }
}
const one: any = new G();
const h = one.a;
console.log(one.a("x"));
console.log(h("2"));`,
    fence: { text: /calling the method 'a' of a 'G' instance shared with dynamic code without that instance as 'this'/, stdout: "x3\n" },
  },
  {
    id: "CV-ERR-01 a callback over a user error class crosses into dynamic code: the error it is called with arrives as itself; another error stops by name",
    src: `class AppError extends Error {
  describe(): string { return "AE:" + this.message; }
}
class Other extends Error {}
const hooks: any[] = [];
function onErr(cb: (err: AppError) => void): void { hooks.push(cb); }
const seen: AppError[] = [];
onErr((err) => { seen.push(err); console.log("got", err.describe(), err.message, err instanceof AppError); });
const fire = (e: unknown): void => { for (const h of hooks) h(e); };
const first = new AppError("boom");
fire(first);
console.log(seen[0] === first);
fire(new Other("x"));`,
    fence: { text: /a dynamic value that is no 'AppError' error leaving into a 'AppError' slot/, stdout: "got AE:boom boom true\ntrue\n" },
  },
  {
    id: "CV-PRIM-01 String(), a template, + and join convert a view through its own toString / valueOf",
    src: `class P {
  constructor(public x: number) {}
  toString(): string { return "P" + this.x; }
}
class V {
  n = 4;
  valueOf(): number { return this.n; }
}
class Plain { k = 1; }
const d: any = new P(1);
console.log(String(d), \`\${d}\`, d.toString());
console.log("v=" + d);
const arr: P[] = [new P(2), new P(3)];
const da: any = arr;
console.log(da.join("-"), String(da));
const v: any = new V();
console.log(v + 1, \`\${v}\`, v * 2);
const pl: any = new Plain();
console.log(String(pl), pl.toString(), "x" + pl, pl.hasOwnProperty("k"));`,
  },
  {
    id: "CV-IN-01 'in' finds a view's fields, methods and getters, a subclass's own too",
    src: `class P {
  x: number;
  constructor(x: number) { this.x = x; }
  get dbl(): number { return this.x * 2; }
  hi(): number { return 1; }
}
class Q extends P { lo(): number { return 0; } }
const ps: P[] = [new P(1), new Q(2)];
const dp: any = ps;
console.log("dbl" in dp[0], "hi" in dp[0], "x" in dp[0], "nope" in dp[0], typeof dp[0].hi);
console.log("lo" in dp[1], "lo" in dp[0], "hi" in dp[1], dp[1].dbl, dp[1].lo());
console.log(Object.keys(dp[1]).join(","), JSON.stringify(dp[0]), dp[0].hasOwnProperty("x"), dp[0].hasOwnProperty("hi"));
const k = "hi";
console.log(k in dp[0]);`,
  },
  {
    id: "CV-JSON-01 JSON.stringify of a view calls its own toJSON",
    src: `class Cmd {
  name: string;
  parent: Cmd | null = null;
  constructor(name: string) { this.name = name; }
  toJSON(): unknown { return { cmd: this.name }; }
}
class Pt { x = 1; y = 2; }
const list: any[] = [new Cmd("a"), new Pt()];
console.log(JSON.stringify(list), JSON.stringify(list[0]), JSON.stringify({ c: list[0] }));`,
  },
  {
    id: "CV-PRINT-01 printing a view stops by name (Node prints the class name and cycle markers)",
    src: `class P { constructor(public x: number) {} }
const ps: P[] = [new P(1)];
const dp: any = ps;
console.log(dp.length, dp[0].x);
console.log(dp);`,
    fence: { text: /printing a 'P' instance shared with dynamic code is not supported yet/, stdout: "1 1\n" },
  },
  {
    id: "CV-PRINT-02 a view nested in a dynamic object, and a self-referencing one, stop by name when printed",
    src: `class Node2 { self: Node2 | null = null; v = 2; }
const n = new Node2();
n.self = n;
const o: any = { label: "L", p: n };
console.log(o.label, o.p.v, o.p.self === o.p);
console.log(o);`,
    fence: { text: /printing a 'Node2' instance shared with dynamic code is not supported yet/, stdout: "L 2 true\n" },
  },
  {
    id: "CV-LATE-01 a JavaScript property first assigned outside the constructor is an own key only once assigned",
    entry: "main.js",
    src: `class Cmd {
  constructor(name) { this.name = name; this.kids = []; }
  mark() { this._late = "m"; return this; }
}
/** @type {any[]} */
const bag = [];
bag.push(new Cmd("a").mark());
console.log(Object.keys(bag[0]).join(","), JSON.stringify(bag[0]), "_late" in bag[0]);
bag.push(new Cmd("b"));
console.log(bag[1].name, bag[1]._late, "_late" in bag[1], JSON.stringify(bag[1]));
console.log(Object.keys(bag[1]).join(","));
bag[1].mark();
console.log(Object.keys(bag[1]).join(","));`,
  },
  {
    id: "CV-LATE-02 a late JavaScript property a write may set to undefined: listing it while it holds undefined stops by name",
    entry: "main.js",
    src: `class Cmd {
  constructor(name) { this.name = name; }
  mark(on) { this._late = on ? "m" : undefined; return this; }
}
/** @type {any[]} */
const bag = [];
bag.push(new Cmd("a").mark(true));
console.log(Object.keys(bag[0]).join(","));
bag.push(new Cmd("b"));
console.log(bag[1].name);
console.log(Object.keys(bag[1]).join(","));`,
    fence: { text: /listing the own keys of a 'Cmd' instance shared with dynamic code while its field '_late' \(first assigned outside the constructor\) holds undefined/, stdout: "name,_late\nb\n" },
  },
  {
    id: "CV-NULL-01 null leaving into a class slot names null",
    entry: "main.js",
    src: `class N { constructor(v, next) { this.v = v; this.next = next; } }
let cur = new N(1, new N(2, null));
let total = 0;
while (cur) { total += cur.v; cur = cur.next; }
console.log(total, cur);`,
    fence: { text: /Cannot store null into a 'N' slot \(it holds only 'N' instances\)/, stdout: "" },
  },
];

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

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
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
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
  expect(node.exitCode).toBe(0);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got).toEqual(node);
}

describe("class-instance views (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  }, 120_000);
});

describe("class-instance views (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
