/* docs/design/vue-object-model.md: Vue 2's object model. A body-less
 * `declare class` in the program's own sources (and a program-declared
 * callable interface with members) is the dynamic value; TypeScript
 * functions newed, given a prototype, or reaching such a slot are dynamic
 * constructors (U4's machinery); an implicit-any `this` in a plain
 * TypeScript function is the ambient receiver. Rows drive a miniature Vue:
 * `function Vue` + mixins installing prototype methods through `this`,
 * `$on` / `$emit`, `Vue.extend` over Object.create.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-vueom-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  entry?: string;
  fence?: string;
  /** The build refuses, and some diagnostic's message contains this. */
  refusedMsg?: string;
  extra?: Record<string, string>;
}

/** Vue 2.7's own compiler options (the ones that matter here). */
const VUE_TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: false, noImplicitThis: false, target: "es2022", module: "esnext", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true } });

const COMPONENT = `export declare class Component {
  constructor(options?: any);
  static cid: number;
  static options: Record<string, any>;
  static extend: (options: any) => typeof Component;
  static super: typeof Component;
  _uid: number;
  _events: Record<string, Function[]>;
  $options: Record<string, any>;
  _init(options?: any): void;
  $on(event: string, fn: Function): Component;
  $emit(event: string, payload?: any): Component;
}`;

const MIXINS = `import type { Component } from "./component.ts";
let uid = 0;
export function initMixin(Vue: typeof Component) {
  Vue.prototype._init = function (options?: Record<string, any>) {
    const vm: Component = this;
    vm._uid = uid++;
    vm._events = Object.create(null);
    vm.$options = options || {};
  };
}
export function eventsMixin(Vue: typeof Component) {
  Vue.prototype.$on = function (event: string, fn: Function): Component {
    const vm: Component = this;
    if (!vm._events[event]) vm._events[event] = [];
    vm._events[event].push(fn);
    return vm;
  };
  Vue.prototype.$emit = function (event: string, payload?: any): Component {
    const vm: Component = this;
    const cbs = vm._events[event];
    if (cbs) {
      for (let i = 0; i < cbs.length; i++) cbs[i].call(vm, payload);
    }
    return vm;
  };
}
export function initExtend(Vue: typeof Component) {
  Vue.cid = 0;
  let cid = 1;
  Vue.extend = function (extendOptions: any): typeof Component {
    const Super = this;
    const Sub = function VueComponent(options) {
      this._init(options);
    } as unknown as typeof Component;
    Sub.prototype = Object.create(Super.prototype);
    Sub.prototype.constructor = Sub;
    Sub.cid = cid++;
    Sub["super"] = Super;
    Sub.options = extendOptions;
    Sub.extend = Super.extend;
    return Sub;
  };
}`;

const VUE = `import type { Component } from "./component.ts";
import { initMixin, eventsMixin, initExtend } from "./mixins.ts";
function Vue(options) {
  if (!(this instanceof Vue)) {
    console.log("Vue is a constructor and should be called with the \`new\` keyword");
  }
  this._init(options);
}
//@ts-expect-error Vue has function type
initMixin(Vue);
//@ts-expect-error Vue has function type
eventsMixin(Vue);
//@ts-expect-error Vue has function type
initExtend(Vue);
export default Vue as unknown as typeof Component;`;

const FILES = { "component.ts": COMPONENT, "mixins.ts": MIXINS, "vue.ts": VUE, "tsconfig.json": VUE_TSCONFIG };

const ROWS: Row[] = [
  {
    id: "VO-01 a miniature Vue: new Vue runs _init through the prototype, $on/$emit dispatch with this bound, instanceof, own keys",
    extra: FILES,
    src: `import Vue from "./vue.ts";
const app = new Vue({ name: "app" });
app.$on("hi", function (x: string) { console.log("hi", x, this._uid, this.$options.name); });
app.$on("hi", function (x: string) { console.log("again", x); });
app.$emit("hi", "there").$emit("none");
console.log(app instanceof Vue, typeof app._init, Object.keys(app).join(","));
const app2 = new Vue({ name: "second" });
console.log(app2._uid, app2.$options.name, app.$on === app2.$on);`,
  },
  {
    id: "VO-02 Vue.extend: Object.create over the super's prototype, constructor and super links, cid, instances of the subclass",
    extra: FILES,
    src: `import Vue from "./vue.ts";
const Child = Vue.extend({ name: "child" });
const c = new Child({ name: "c1" });
c.$on("e", function (v: number) { console.log("child got", v, this.$options.name); });
c.$emit("e", 7);
console.log(c instanceof Child, c instanceof Vue, Child.cid, Child["super"] === Vue, Child.options.name);
console.log(Object.getPrototypeOf(Child.prototype) === Vue.prototype, Child.prototype.constructor === Child, Vue.cid);
const Grand = Child.extend({ name: "grand" });
const g = new Grand({ name: "g1" });
console.log(g instanceof Child, g instanceof Vue, Grand.cid, g._uid);`,
  },
  {
    id: "VO-03 a program-declared callable interface with members (GlobalAPI) over a plain function given properties, across modules",
    extra: {
      "api.ts": `export interface GlobalAPI {
  (options?: any): void;
  version: string;
  cid: number;
  use(plugin: any): GlobalAPI;
}
function Vue(options) {
  this.options = options;
}
const installed: string[] = [];
const api = Vue as unknown as GlobalAPI;
api.version = "2.7.16";
api.cid = 0;
api.use = function (plugin: any): GlobalAPI {
  installed.push(plugin.name);
  return this;
};
export function plugins(): string { return installed.join(","); }
export default api;`,
      "tsconfig.json": VUE_TSCONFIG,
    },
    src: `import Vue, { plugins } from "./api.ts";
Vue.use({ name: "router" }).use({ name: "store" });
console.log(Vue.version, Vue.cid, typeof Vue, plugins());`,
  },
  {
    id: "VO-04 an implicit-any this in a plain TypeScript function: a method call binds the object, call/apply/bind their thisArg, a plain call undefined (strict module)",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
function who() { return this; }
const o: any = { who, name: "o" };
console.log(o.who() === o, who() === undefined, who.call(5), who.apply("s"), who.bind(o)() === o);
function setName(n: string) { this.name = n; return this; }
const p: any = {};
setName.call(p, "pee");
console.log(p.name);`,
  },
  {
    id: "VO-05 a typed class holding a Component field (Vue's VNode.context): typed code stores and reads the dynamic instance",
    extra: FILES,
    src: `import Vue from "./vue.ts";
import type { Component } from "./component.ts";
class VNode {
  tag: string;
  context: Component | undefined;
  constructor(tag: string, context?: Component) {
    this.tag = tag;
    this.context = context;
  }
}
const vm = new Vue({ name: "root" });
const a = new VNode("div", vm);
const b = new VNode("span");
console.log(a.tag, a.context === vm, a.context ? a.context.$options.name : "none", b.context === undefined);
a.context!.$on("x", function (v: string) { console.log("x", v, this === vm); });
a.context!.$emit("x", "y");`,
  },
  {
    id: "VO-06 a dynamic constructor never newed: its prototype is an object, a write to it lands, its keys list",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
function plain(n) { return n * 2; }
console.log(typeof plain.prototype, plain(4));
plain.prototype.k = 1;
console.log(plain.prototype.k, Object.keys(plain.prototype).join(","));`,
  },
  {
    id: "VO-07 a dynamic constructor's own members (expandos) live in its property table: writes, ++, and reads agree",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
function F() { this.x = 1; }
F.count = 0;
F.count++;
F.count += 2;
F.tag = "t";
console.log(F.count, F.tag, new F().x);`,
  },
  {
    id: "VO-08 a TypeScript arrow inside a plain function captures that function's receiver when created",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
function Outer() { const arrow = () => this; return arrow(); }
const o: any = { n: 1 };
console.log(Outer.call(o) === o);
function Mk() { return () => this; }
const f = Mk.call(o);
const other = { f };
console.log(f() === o, other.f() === o);`,
  },
  {
    id: "VO-09 an implicit-any this in a TypeScript script with no module syntax (sloppy CommonJS to Node) refuses by name",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `function who() { return this; }
console.log(typeof who());`,
    refusedMsg: "a TypeScript script with no module syntax",
  },
  {
    id: "VO-10 inspect after Vue.extend names the instance by its prototype's constructor (VueComponent)",
    extra: FILES,
    src: `import Vue from "./vue.ts";
const Child = Vue.extend({ name: "child" });
const c = new Child({ name: "x" });
console.log(c);
console.log(new Vue({ name: "root" }));`,
  },
  {
    id: "VO-11 a function cast to a callable interface keeps the binding's name (NamedEvaluation through 'as')",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
interface Counter {
  (start: number): number;
  step: number;
}
let counter = function (start: number) { return start + counter.step; } as Counter;
console.log(counter);
counter.step = 2;
console.log(counter.name, counter(1));`,
  },
  {
    id: "VO-12 a plain function nested in a class method, and an array callback, read their own this (undefined), not the method's",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
class A {
  m() { function f() { return this; } return f(); }
  n() { let seen: any = "unset"; [1].forEach(function () { seen = this; }); return seen; }
}
const a = new A();
console.log(a.m() === undefined, a.n() === undefined);`,
  },
  {
    id: "VO-13 arrows returned in an array keep the receiver their plain function had (element calls through a dynamic method call's result)",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
function Outer2() { const arrows = [() => this, () => this]; return arrows; }
const p: any = { Outer2, name: "p" };
const got = p.Outer2();
console.log(got[0]() === p, got[1]() === p, got.length);
const g0 = got[0];
console.log(g0() === p);`,
  },
  {
    id: "VO-14 a TypeScript function listener of a builtin EventEmitter reading this refuses by name (Node binds the emitter)",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.on("x", function (v) { console.log("got", v, this === e); });
e.emit("x", 1);`,
    refusedMsg: "function listener of a builtin emitter",
  },
  {
    id: "VO-15 sort and toSorted comparators run with this undefined inside a dynamic method call",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
const o: any = { tag: "o" };
o.m = function () {
  console.log([3, 1, 2].sort(function (a, b) { return this === undefined ? a - b : 0; }).join());
  console.log([3, 1, 2].toSorted(function (a, b) { return this === undefined ? a - b : 0; }).join());
};
o.m();`,
  },
  {
    id: "VO-16 find, findIndex, findLast, findLastIndex, every, some callbacks run with this undefined (a thisArg is refused by name)",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
const o: any = { tag: "o" };
o.m = function () {
  const t = { k: 1 };
  const xs = [1, 2, 3];
  console.log(xs.find(function () { return this === undefined; }), xs.findIndex(function () { return this === undefined; }));
  console.log(xs.findLast(function () { return this === undefined; }), xs.findLastIndex(function () { return this === undefined; }));
  console.log(xs.every(function () { return this === undefined; }), xs.some(function () { return this === undefined; }), t.k);
};
o.m();`,
  },
  {
    id: "VO-17 Array.from's mapFn, flatMap (its lib-typed `this: undefined` callback) and reduceRight callbacks run with this undefined",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
const o: any = { tag: "o" };
o.m = function () {
  const t = { k: 1 };
  console.log(Array.from([1, 2], function (x) { return this === undefined ? x * 10 : -1; }).join());
  console.log([1, 2].flatMap(function (x) { return this === undefined ? [x, x] : []; }).join());
  console.log([1, 2, 3].reduceRight(function (acc: number, x: number) { return this === undefined ? acc + x : -100; }, 0));
};
o.m();`,
  },
  {
    id: "VO-18 String replace and replaceAll with a function: the replacer runs with this undefined",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
const o: any = { tag: "o" };
o.m = function () {
  console.log("a-b-a".replace("a", function (m) { return this === undefined ? "X" : "?"; }));
  console.log("a-b-a".replaceAll("a", function (m) { return this === undefined ? "Y" : "?"; }));
  console.log("a1b2".replace(/[0-9]/g, function (m) { return this === undefined ? "#" : "?"; }));
};
o.m();`,
  },
  {
    id: "VO-19 Map and Set forEach callbacks run with this undefined (a thisArg is refused by name)",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
const o: any = { tag: "o" };
o.m = function () {
  const t = { k: 1 };
  const out: string[] = [];
  new Map([["a", 1]]).forEach(function (v, k) { out.push(k + (this === undefined)); });
  new Set([3]).forEach(function (v) { out.push(String(v) + (this === undefined)); });
  console.log(out.join(","));
};
o.m();`,
  },
  {
    id: "VO-20 Promise then, catch and finally callbacks reading this stop by name (a suspending this read)",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
const o: any = { tag: "o" };
o.m = function () {
  Promise.resolve(1).then(function (v) { console.log("then", v, this === undefined); return Promise.reject(new Error("e")); })
    .catch(function (e) { console.log("catch", this === undefined); })
    .finally(function () { console.log("finally", this === undefined); });
};
o.m();`,
    refusedMsg: "dyn.this:suspending",
  },
  {
    id: "VO-22 a program's own `this: undefined` callback type stops by name (its this-typed signature does not compile): only a standard-library callback's This default reads the ambient receiver",
    extra: { "tsconfig.json": VUE_TSCONFIG },
    src: `export {};
function run(cb: (this: undefined, x: number) => number): number { return cb.call(undefined, 1); }
console.log(run(function (x) { return this === undefined ? x : 0; }));`,
    refusedMsg: "values of type '(this: undefined, x: number) => number' cannot be compiled",
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.extra ?? {})) writeFileSync(join(dir, name), text + "\n");
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
  if (row.refusedMsg !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.some((d) => d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
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
  expect(node.exitCode, JSON.stringify(node)).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("Vue 2's object model (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("Vue 2's object model (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
