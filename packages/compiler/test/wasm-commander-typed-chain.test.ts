/* Commander from TypeScript through its shipped declarations (SEMANTICS.md
 * S133) — the chained-builder setup paperclip's index.ts and deepseek's
 * parseDshArgs share — and the commander stops met on that path. Rows run
 * under Node and on both WasmGC lanes and must match byte for byte. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("cmdr-typed-chain");

const ROWS: Row[] = [
  {
    id: "CMDT-01 instanceof RegExp over a dynamic value tests it at run time (command.js:742)",
    files: {
      "main.cjs": `function optionEx(fn) {
  if (typeof fn === "function") return "parser";
  else if (fn instanceof RegExp) return "regex";
  return "default " + JSON.stringify(fn);
}
const vals = JSON.parse('[1, "x", null, {"a": 2}]');
for (const v of vals) console.log(optionEx(v));
console.log(optionEx((v) => v));`,
    },
  },
  {
    id: "CMDT-02 a parent command reached through an optional chain, its method called (command.js:2279 alias)",
    files: {
      "main.cjs": `class Command {
  constructor(name) {
    this._name = name;
    /** @type {Command | null} */
    this.parent = null;
    this.commands = [];
  }
  _findCommand(name) {
    return this.commands.find((cmd) => cmd._name === name);
  }
  addCommand(cmd) {
    cmd.parent = this;
    this.commands.push(cmd);
    return this;
  }
  alias(a) {
    if (a === this._name) throw new Error("Command alias can't be the same as its name");
    const matchingCommand = this.parent?._findCommand(a);
    return matchingCommand ? "taken by " + matchingCommand._name : "free";
  }
}
const root = new Command("root");
const a = new Command("deploy");
const b = new Command("build");
root.addCommand(a).addCommand(b);
console.log(b.alias("deploy"), b.alias("ship"), root.alias("x"));`,
    },
  },
  {
    id: "CMDT-03 an object-literal field reassigned with a dynamic spread holds the dynamic object (command.js:249 configureOutput)",
    files: {
      "main.cjs": `class Command {
  constructor() {
    this._outputConfiguration = {
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
      getOutHelpWidth: () => 80,
    };
  }
  /**
   * @param {object} [configuration] - configuration options
   * @return {(Command | object)} \`this\` command for chaining, or stored configuration
   */
  configureOutput(configuration) {
    if (configuration === undefined) return this._outputConfiguration;
    this._outputConfiguration = {
      ...this._outputConfiguration,
      ...configuration,
    };
    return this;
  }
  out(s) {
    this._outputConfiguration.writeOut(s + "\\n");
  }
}
const c = new Command();
c.out("plain");
c.configureOutput({ writeOut: (str) => process.stdout.write("[x] " + str) });
c.out("configured");
console.log(Object.keys(c.configureOutput()).join(","), c.configureOutput().getOutHelpWidth());`,
    },
  },
  {
    id: "CMDT-04 a typed-array filter whose JavaScript predicate returns an untyped value (command.js:1125 _prepareForParse)",
    files: {
      "main.cjs": `class Option {
  constructor(flags, negate) {
    this.flags = flags;
    this.negate = negate;
    this.defaultValue = undefined;
  }
  attributeName() {
    return this.flags.replace(/^--(no-)?/, "");
  }
}
class Command {
  constructor() {
    this.options = [new Option("--no-color", true), new Option("--port", false), new Option("--no-cache", true)];
    this._optionValues = {};
    this._optionValues.cache = false;
  }
  getOptionValue(key) {
    return this._optionValues[key];
  }
  negated() {
    return this.options
      .filter((option) => option.negate && option.defaultValue === undefined && this.getOptionValue(option.attributeName()) === undefined)
      .map((o) => o.flags);
  }
}
console.log(new Command().negated());
const anyPred = JSON.parse('[0, 1, "", "x", null]');
console.log([10, 20, 30, 40, 50].filter((_, i) => anyPred[i]));`,
    },
  },
  {
    id: "CMDT-05 a literal spreading a dynamic object field builds the dynamic object (command.js:1160 saveStateBeforeParse)",
    files: {
      "main.cjs": `class Command {
  constructor(name) {
    this._name = name;
    this._optionValues = {};
    this._optionValueSources = {};
    this._savedState = null;
  }
  /**
   * @param {string} key
   * @param {Object} value
   * @param {string} source - expected values are default/config/env/cli/implied
   * @return {Command} \`this\` command for chaining
   */
  setOptionValueWithSource(key, value, source) {
    this._optionValues[key] = value;
    this._optionValueSources[key] = source;
    return this;
  }
  saveStateBeforeParse() {
    this._savedState = {
      _name: this._name,
      _optionValues: { ...this._optionValues },
      _optionValueSources: { ...this._optionValueSources },
    };
  }
  restoreStateBeforeParse() {
    if (this._savedState === null) return;
    this._name = this._savedState._name;
    this._optionValues = { ...this._savedState._optionValues };
    this._optionValueSources = { ...this._savedState._optionValueSources };
  }
}
const c = new Command("prog");
c.setOptionValueWithSource("port", 80, "default");
c.saveStateBeforeParse();
c.setOptionValueWithSource("port", 9000, "cli");
console.log(c._savedState._name, c._savedState._optionValues.port, c._savedState._optionValueSources.port, c._optionValues.port);
console.log(JSON.stringify(c._savedState));
c.restoreStateBeforeParse();
console.log(c._name, c._optionValues.port, c._optionValueSources.port, c._savedState._optionValues === c._optionValues);`,
    },
  },
  {
    id: "CMDT-06 process.versions?.electron through require('node:process') reads undefined (command.js:1000 parse)",
    files: {
      "main.cjs": `const process = require('node:process');
function from(parseOptions) {
  parseOptions = parseOptions || {};
  if (parseOptions.from === undefined) {
    if (process.versions?.electron) {
      parseOptions.from = 'electron';
    }
  }
  return parseOptions.from === undefined ? 'node' : parseOptions.from;
}
console.log(from(), from({ from: 'user' }), typeof process.versions.electron);`,
    },
  },
  {
    id: "CMDT-07 a switch on a dynamic value with case undefined among string cases (command.js:1023 parse)",
    files: {
      "main.cjs": `function pick(parseOptions) {
  switch (parseOptions.from) {
    case undefined:
    case 'node':
      return 'node';
    case 'electron':
      return 'electron';
    case 'user':
      return 'user';
    default:
      return 'bad:' + String(parseOptions.from);
  }
}
console.log(pick({}), pick({ from: 'node' }), pick({ from: 'user' }), pick({ from: 'electron' }), pick({ from: null }), pick({ from: 'x' }), pick({ from: 3 }));`,
    },
  },
  {
    id: "CMDT-08 instanceof RegExp over an any binding, an unknown parameter, an identity call's result and a spread-held value",
    files: {
      "main.ts": `const a: any = /q/;
const b: any = "q";
console.log(a instanceof RegExp, b instanceof RegExp);
function isRe(u: unknown): boolean {
  return u instanceof RegExp;
}
console.log(isRe(/x/), isRe({}), isRe(null), isRe(3));`,
      "package.json": `{"type":"module"}`,
    },
  },
  {
    id: "CMDT-09 instanceof RegExp in CommonJS through an identity function",
    files: {
      "main.cjs": `function id(x) { return x; }
function isRe(v) { return v instanceof RegExp; }
console.log(isRe(id(/a/)), isRe(id("a")), isRe(id(null)));`,
    },
  },
  {
    id: "CMDT-10 a callback with defaulted and optional parameters crossing into a package declaration keeps Node's length (a rest-parameter callback value stays refused by name)",
    npmStatic: ["ap"],
    files: {
      "node_modules/ap/package.json": `{"name":"ap","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`,
      "node_modules/ap/index.d.ts": `export declare function apply(f: (a: string, b: number) => string): string;
export declare function applyOptional(f: (a: string, b: number) => string): string;
export declare function applyBoth(f: (a: string, b: number, c: number) => string): string;
export declare function applyConst(f: (a: string, b: number) => string): string;
`,
      "node_modules/ap/index.js": `export function apply(f) {
  return f.length + ":" + f("x", 2) + ":" + f("y");
}
export function applyOptional(f) {
  return f.length + ":" + f("x", 2) + ":" + f("y");
}
export function applyBoth(f) {
  return f.length + ":" + f("x", 2, 3) + ":" + f("y");
}
export function applyConst(f) {
  return f.length + ":" + f("x", 2);
}
`,
      "package.json": `{"type":"module"}`,
      "tsconfig.json": `{"compilerOptions":{"strict":true,"module":"nodenext","skipLibCheck":true,"noEmit":true}}`,
      "main.ts": `import { apply, applyOptional, applyBoth, applyConst } from "ap";
console.log(apply((a: string, b: number = 5) => a + b));
console.log(applyOptional((a: string, b?: number) => a + String(b)));
console.log(applyBoth((a: string, b: number = 1, c?: number) => a + b + String(c)));
const cb = (a: string, b: number = 3) => a + b;
console.log(applyConst(cb));
`,
    },
  },
];

describe("commander typed chain (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("commander typed chain (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("commander typed chain: stops by name (wasm-native lane)", () => {
  test("CMDT-11 a record holding a RegExp that becomes a dynamic field stops by name where it is built (never a wrong instanceof)", async () => {
    const row: Row = {
    id: "CMDT-11 a record holding a RegExp that becomes a dynamic field stops by name where it is built (never a wrong instanceof)",
    files: {
      "main.cjs": `class C {
  constructor() { this.cfg = { re: /k/ }; }
  conf(c) { this.cfg = { ...this.cfg, ...c }; return this; }
}
console.log("before");
const c = new C();
c.conf(JSON.parse('{"a":1}'));
console.log(c.cfg.re instanceof RegExp, c.cfg.a);`,
    },
  };
    await checkFenced(scratch, row, "wasm-native", "before\n", "holding 'RegExp' values in a runtime-keyed (computed-key) object literal");
  }, 600_000);
});
