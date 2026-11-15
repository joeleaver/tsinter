/* Commander stops past the dynamic emitter (the emitter-dyn unit's
 * workload pass). Each row is a tiny program without third-party code
 * reproducing one construct commander@15's lib/command.js reached; rows
 * run under Node and on both WasmGC lanes and must match byte for byte. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("cmdr-stops2");

const ROWS: Row[] = [
  {
    id: "CMDR2-01 instanceof on a primitive operand answers false (command.js:733 _optionEx)",
    files: {
      "main.cjs": `class Option {
  constructor(flags) { this.flags = flags; }
}
class Command {
  _optionEx(config, flags, description) {
    if (typeof flags === "object" && flags instanceof Option) {
      throw new Error("To add an Option object use addOption()");
    }
    return [config.mandatory === true, flags, description, flags instanceof Option];
  }
}
const c = new Command();
console.log(c._optionEx({}, "-d, --debug", "debug"));
console.log(c._optionEx({ mandatory: true }, "--port <n>", "port"));
const n = 5;
console.log("s" instanceof Option);
console.log(n instanceof Option);
function probe(x) {
  return [typeof x === "object" && x instanceof Option, x instanceof Option];
}
console.log(probe("str"), probe(7), probe(new Option("-o")));
const parts = ["a", "b"];
console.log(parts.join("") instanceof Option);`,
    },
  },
  {
    id: "CMDR2-02 a key a JS record's shape lacks reads undefined (command.js:735 !!config.mandatory)",
    files: {
      "main.cjs": `class Command {
  _optionEx(config, flags) {
    const mandatory = !!config.mandatory;
    return [flags, mandatory, config.mandatory, typeof config.other];
  }
  option(flags) {
    return this._optionEx({}, flags);
  }
  requiredOption(flags) {
    return this._optionEx({ mandatory: true }, flags);
  }
}
const c = new Command();
console.log(c.option("-d"), c.requiredOption("--port <n>"));
const cfg = {};
console.log(cfg.missing === undefined, String(cfg.missing));`,
    },
  },
  {
    id: "CMDR2-10 a JSDoc Promise|undefined result chains as checked-dynamic (_chainOrCall over an action-handler field)",
    files: {
      "main.cjs": `class Cmd {
  constructor(handler) {
    this.log = [];
    this._actionHandler = handler;
  }
  /**
   * @param {(Promise<any>|undefined)} promise
   * @param {Function} fn
   * @return {(Promise<any>|undefined)}
   */
  _chainOrCall(promise, fn) {
    if (promise?.then && typeof promise.then === "function") {
      return promise.then(() => fn());
    }
    return fn();
  }
  run(args) {
    let chain;
    chain = this._chainOrCall(chain, () => {
      this.log.push("a");
    });
    chain = this._chainOrCall(chain, () => this._actionHandler(args));
    chain = this._chainOrCall(chain, () => {
      this.log.push("c");
    });
    return chain;
  }
}
const sync = new Cmd((args) => {
  console.log("sync action", args);
});
console.log(sync.run(["x"]), sync.log.join(""));
const later = new Cmd(async (args) => {
  console.log("async action", args);
  return 1;
});
const p = later.run(["y"]);
console.log(typeof p.then, later.log.join(""));
p.then(() => console.log("after", later.log.join("")));`,
    },
  },
  {
    id: "CMDR2-11 a JSDoc string|Command getter-setter: method calls on its results",
    files: {
      "main.cjs": `class Command {
  constructor() {
    this._name = "";
    this.commands = [];
  }
  /**
   * @param {string} [str]
   * @return {(string|Command)}
   */
  name(str) {
    if (str === undefined) return this._name;
    this._name = str;
    return this;
  }
  command(n) {
    const c = new Command();
    c.name(n);
    this.commands.push(c);
    return c;
  }
}
const p = new Command();
p.name("prog").command("deploy");
p.command("build");
console.log(p.name(), p.commands.map((c) => c.name()).join(","));
const names = [p.name()].concat(p.commands.map((c) => c.name()));
console.log(names.sort((a, b) => a.localeCompare(b)));`,
    },
  },
  {
    id: "CMDR2-12 a JSDoc Command|null field crosses into dynamic code",
    files: {
      "main.cjs": `class Command {
  constructor(name) {
    /** @type {Command | null} */
    this.parent = null;
    this._name = name;
  }
  addCommand(c) {
    c.parent = this;
    return this;
  }
  path() {
    const parts = [];
    for (let c = this; c; c = c.parent) parts.unshift(c._name);
    return parts.join(" ");
  }
}
const root = new Command("root");
const sub = new Command("sub");
root.addCommand(sub);
console.log(sub.path(), root.parent === null, sub.parent === root);
const holder = [];
holder.push(sub.parent);
holder.push(root.parent);
console.log(holder.length, holder[0] === root, holder[1]);`,
    },
  },
  {
    id: "CMDR2-13 a JSDoc that lies (claims Promise|undefined, returns a number) answers the number",
    files: {
      "main.cjs": `/** @return {(Promise<any>|undefined)} */
function lie(n) {
  return n * 6;
}
const v = lie(7);
console.log(v, typeof v, String(v), JSON.stringify(v));`,
    },
  },
  {
    id: "CMDR2-14 a dynamic promise's then/catch/finally read as values (S015's promise amendment)",
    files: {
      "main.cjs": `/**
 * @param {any} p
 * @param {any} q
 */
function show(p, q) {
  console.log(typeof p.then, typeof p.catch, typeof p.finally, !!p.then);
  console.log(p.then === q.then, p.then.name, p.then.length, p.catch.length);
  p.then((v) => console.log("method call", v));
}
const make = async () => 5;
show(make(), make());
const o = JSON.parse('{"then": 1}');
console.log(typeof o.then, o.then);`,
    },
  },
  {
    id: "CMDR2-16 a class-or-undefined union (an array find result) keeps its typed union (command.js:1677 _findOption)",
    files: {
      "main.cjs": `class Option {
  /** @param {string} flags */
  constructor(flags) {
    this.flags = flags;
  }
  /**
   * @param {string} arg
   * @return {boolean}
   */
  is(arg) {
    return this.flags === arg;
  }
}
class Command {
  constructor() {
    this.options = [new Option("-a"), new Option("-b")];
  }
  /**
   * @param {string} arg
   * @return {Option}
   */
  _findOption(arg) {
    return this.options.find((option) => option.is(arg));
  }
  parse(argv) {
    for (const a of argv) console.log(a, !!this._findOption(a));
  }
}
new Command().parse(JSON.parse('["-a", "-c"]'));
new Command().parse(["-b"]);`,
    },
  },
  {
    id: "CMDR2-17 a JSDoc (Promise|undefined) class field keeps its .then after a flow narrowing (review B-1)",
    files: {
      "main.cjs": `class Holder {
  constructor() {
    /** @type {(Promise<number>|undefined)} */
    this.p = undefined;
  }
}
const h = new Holder();
console.log(h.p === undefined);
h.p = Promise.resolve(9);
h.p.then((v) => console.log("p", v));`,
    },
  },
  {
    id: "CMDR2-21 calls chained off a JSDoc (Promise|undefined) field's then stay dynamic (review: .then(...).finally(...))",
    files: {
      "main.cjs": `class Holder {
  constructor() {
    /** @type {(Promise<number>|undefined)} */
    this.p = undefined;
  }
}
const h = new Holder();
h.p = Promise.resolve(9);
h.p
  .then((v) => console.log("then", v))
  .catch((e) => console.log("caught", e))
  .finally(() => console.log("finally"));`,
    },
  },
  {
    id: "CMDR2-22 an instance with a typed array field held in a JSDoc (Foo|string) field: calls, reads, narrowing, arrays (review regression)",
    files: {
      "main.cjs": `class Foo {
  constructor(n) {
    this.n = n;
    this.items = [1, 3, 2];
  }
  hi() {
    return "hi" + this.n;
  }
  sorted() {
    return this.items.slice().sort();
  }
}
class Holder {
  constructor() {
    /** @type {(Foo|string)} */
    this.v = "init";
    /** @type {Array<Foo|string>} */
    this.list = [];
  }
}
const h = new Holder();
console.log(h.v);
h.v = new Foo(1);
console.log(h.v.hi(), h.v.n);
console.log(h.v.items.length, h.v.sorted().join(","));
h.v.items.push(4);
h.v.items[0] = 7;
console.log(h.v.items.join(","), h.v.sorted().join(","));
const local = h.v;
if (typeof local !== "string") console.log("local", local.hi(), local.items[0]);
h.list.push(new Foo(2), "s");
for (const x of h.list) console.log(typeof x === "string" ? x : x.hi());
const a = new Foo(3), b = new Foo(4), c = new Foo(5);
h.list.push(a, "t", b, c);
console.log(h.list.length, h.list[2] === a, h.list.map((x) => (typeof x === "string" ? x : x.n)).join(","));`,
    },
  },
];

describe("commander stops, pass 2 (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("commander stops, pass 2 (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("commander stops, pass 2: the primitive fold leaves Symbol.hasInstance alone", () => {
  test("CMDR2-03 a class with a static Symbol.hasInstance keeps the named refusal (Node runs the method)", async () => {
    const row: Row = {
      id: "CMDR2-03",
      files: {
        "main.cjs": `class Even {
  static [Symbol.hasInstance](n) {
    return n % 2 === 0;
  }
}
console.log(2 instanceof Even, 3 instanceof Even);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'instanceof' on values other than class instances");
  }, 600_000);
});

describe("commander stops, pass 2: other Symbol.hasInstance spellings keep the refusal too", () => {
  test("CMDR2-04 a static getter for Symbol.hasInstance", async () => {
    const row: Row = {
      id: "CMDR2-04",
      files: {
        "main.cjs": `class G {
  static get [Symbol.hasInstance]() {
    return (v) => v === 1;
  }
}
console.log(1 instanceof G, 2 instanceof G);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'instanceof' on values other than class instances");
  }, 600_000);

  test("CMDR2-05 the bracket spelling Symbol[\"hasInstance\"]", async () => {
    const row: Row = {
      id: "CMDR2-05",
      files: {
        "main.cjs": `class B {
  static [Symbol["hasInstance"]](v) {
    return v === 1;
  }
}
console.log(1 instanceof B, 2 instanceof B);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'instanceof' on values other than class instances");
  }, 600_000);
});

describe("commander stops, pass 2: named stops", () => {
  test("CMDR2-15 calling a dynamic promise's then read as a value stops by name", async () => {
    const row: Row = {
      id: "CMDR2-15",
      files: {
        "main.cjs": `/** @param {any} p */
function go(p) {
  console.log("before", typeof p.then);
  const t = p.then;
  t.call(p, (v) => console.log("v", v));
}
go((async () => 1)());`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "before function\n", "calling Promise.prototype.then read as a value from a dynamic promise");
  }, 600_000);
});

describe("commander batch 1: named stops from the review", () => {
  test("CMDR2-18 printing an instance a JSDoc string|Foo union returned stops by name (S115's class-view print)", async () => {
    const row: Row = {
      id: "CMDR2-18",
      files: {
        "main.cjs": `class Foo {
  constructor() {
    this.n = 1;
  }
  /**
   * @param {string} [s]
   * @return {(string|Foo)}
   */
  name(s) {
    return s === undefined ? "foo" : this;
  }
}
const f = new Foo();
console.log(f.name());
console.log(f.name("x"));`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "foo\n", "printing a 'Foo' instance shared with dynamic code");
  }, 600_000);

  test("CMDR2-19 reading call off a dynamic promise's then stops by name (review B-3)", async () => {
    const row: Row = {
      id: "CMDR2-19",
      files: {
        "main.cjs": `/** @param {any} p */
function go(p) {
  console.log("before", typeof p.then);
  console.log(p.then.call === undefined);
}
go((async () => 1)());`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "before function\n", "reading 'call' of Promise.prototype.then read as a value from a dynamic promise");
  }, 600_000);

  test("CMDR2-20 localeCompare with a locales argument on a dynamic string stops by name (review B-4)", async () => {
    const row: Row = {
      id: "CMDR2-20",
      files: {
        "main.cjs": `const v = JSON.parse('["a", "b"]');
console.log(v[0].localeCompare(v[1]));
console.log(v[0].localeCompare(v[1], "en"));`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "-1\n", "localeCompare with a locales or options argument on a dynamic string");
  }, 600_000);
});

describe("commander batch 1: a dynamic store into a viewed instance's typed array field stops by name", () => {
  test("CMDR2-23 storing into the number[] field through the dynamic value", async () => {
    const row: Row = {
      id: "CMDR2-23",
      files: {
        "main.cjs": `class Foo {
  constructor(n) {
    this.n = n;
    this.items = [1, 3, 2];
  }
}
class Holder {
  constructor() {
    /** @type {(Foo|string)} */
    this.v = "init";
  }
}
const h = new Holder();
h.v = new Foo(1);
console.log("before", h.v.n);
h.v.items = [9];
console.log("after", h.v.items[0]);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "before 1\n", "an 'any' value flowing into a typed 'number[]' slot");
  }, 600_000);
});
