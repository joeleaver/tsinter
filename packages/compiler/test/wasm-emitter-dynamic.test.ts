/* The dynamic-emitter unit (commander's computed event names): a
 * non-literal event name anywhere in an EventEmitter class family puts
 * the whole family in dynamic mode — one general table keyed by the
 * run-time name string ('error' included), listeners registered as
 * dynamic values, emitted arguments boxed (lower-emitter.ts's
 * "dynamic-mode emitters" block). Rows run under Node and on both WasmGC
 * lanes and must match byte for byte; the stop rows pin GH #208's named
 * stops (listeners()/rawListeners() and the leak warning) and the
 * stream-upcast refusal that keeps streams out of dynamic mode. */
import { describe, test } from "vitest";
import { checkFenced, checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("emitter-dyn");

const ROWS: Row[] = [
  {
    id: "EDYN-01 listener order, once, prependListener, prependOnceListener (TS)",
    files: {
      "main.ts": `import { EventEmitter } from "node:events";
class Bus extends EventEmitter {}
const bus = new Bus();
const n = (s: string): string => "ev:" + s;
const log: string[] = [];
bus.on(n("a"), (x: unknown) => log.push("on1 " + String(x)));
bus.prependListener(n("a"), (x: unknown) => log.push("pre " + String(x)));
bus.once(n("a"), (x: unknown) => log.push("once " + String(x)));
bus.addListener(n("a"), (x: unknown, y: unknown) => log.push("add " + String(x) + " " + String(y)));
bus.prependOnceListener(n("a"), (x: unknown) => log.push("preonce " + String(x)));
console.log(bus.emit(n("a"), 1), bus.listenerCount(n("a")));
console.log(bus.emit(n("a"), 2, "two"), bus.listenerCount(n("a")));
console.log(bus.emit(n("b")), bus.listenerCount(n("b")));
console.log(log.join("\\n"));`,
    },
  },
  {
    id: "EDYN-02 off during emit iterates a copy; once is removed before its call (TS)",
    files: {
      "main.ts": `import { EventEmitter } from "node:events";
class Bus extends EventEmitter {}
const bus = new Bus();
const name = ["t", "ick"].join("");
const g = (): void => console.log("g");
const f = (): void => {
  console.log("f", bus.listenerCount(name));
  bus.off(name, g);
};
bus.on(name, f);
bus.on(name, g);
bus.once(name, () => console.log("once sees", bus.listenerCount(name)));
bus.emit(name);
bus.emit(name);
bus.removeListener(name, f);
console.log(bus.listenerCount(name), bus.eventNames());`,
    },
  },
  {
    id: "EDYN-03 a mixed literal/computed family beside a static family (TS)",
    files: {
      "main.ts": `import { EventEmitter } from "node:events";
class Base extends EventEmitter {}
class Child extends Base {
  fire(n: string): boolean {
    return this.emit("dyn:" + n, n.length, n);
  }
}
class Other extends EventEmitter {}
const c = new Child();
c.on("dyn:abc", (len: number, s: string) => console.log("typed", len, s));
c.on("lit", (a: string, b: number) => console.log("lit", a, b));
console.log(c.emit("lit", "x", 1), c.fire("abc"), c.fire("zz"));
const b: Base = c;
b.on("lit", () => console.log("via base"));
c.emit("lit", "y", 2);
c.on("error", (e: Error) => console.log("child error", e.message));
c.emit("error", new Error("e0"));
const o = new Other();
o.on("lit", (a: string, b: number) => console.log("other", a, b));
o.on("error", (e: Error) => console.log("other error", e.message));
o.emit("lit", "z", 3);
o.emit("error", new Error("e1"));
console.log(c.eventNames(), o.eventNames(), c.listenerCount("lit"));`,
    },
  },
  {
    id: "EDYN-04 commander's option:*/optionEnv:*/command:* shapes (JS)",
    files: {
      "main.cjs": `const EventEmitter = require("node:events").EventEmitter;
class Command extends EventEmitter {
  constructor(name) {
    super();
    this._name = name;
    this.seen = [];
  }
  option(name, envVar) {
    const oname = name;
    this.on("option:" + oname, (val) => {
      this.seen.push(oname + "=" + val);
    });
    if (envVar) {
      this.on(\`optionEnv:\${oname}\`, (val) => {
        this.seen.push(oname + "=env:" + val);
      });
    }
    return this;
  }
  run(argv) {
    for (const a of argv) {
      if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        this.emit(\`option:\${a.slice(2, eq)}\`, a.slice(eq + 1));
      } else if (a.startsWith("$")) {
        this.emit(\`optionEnv:\${a.slice(1)}\`, "E");
      } else if (this.listenerCount("command:" + a) > 0) {
        this.emit("command:" + a, [a], []);
      } else if (this.listenerCount("command:*") > 0) {
        this.emit("command:*", [a], ["--x"]);
      } else {
        console.log("unknown", a);
      }
    }
    return this;
  }
}
const p = new Command("prog");
p.option("debug").option("port", "PORT");
p.on("command:build", (operands, unknown) => console.log("build", operands, unknown));
p.run(["--debug=yes", "--port=80", "$port", "build", "other"]);
p.on("command:*", (operands, unknown) => console.log("star", operands, unknown));
p.run(["other"]);
console.log(p.seen.join(" "));
console.log(p.eventNames());`,
    },
  },
  {
    id: "EDYN-05 this inside a listener, eventNames order, listenerCount, setMaxListeners (JS)",
    files: {
      "main.cjs": `const EventEmitter = require("node:events").EventEmitter;
class Hub extends EventEmitter {}
const h = new Hub();
const k = (s) => "k" + s;
h.on(k(1), function (a, b, c) {
  console.log(this === h, a, b, c);
});
h.on(k(2), () => {});
h.on(k(0), () => {});
h.on(k(1), (a) => console.log("arrow", a));
console.log(h.emit(k(1), "x", 2));
console.log(h.eventNames(), h.listenerCount(k(1)), h.listenerCount("none"));
h.setMaxListeners(20);
for (let i = 0; i < 15; i++) h.on(k("many"), () => {});
console.log(h.getMaxListeners(), h.listenerCount(k("many")));
const f = () => {};
h.on(k(3), f);
console.log(h.listenerCount(k(3), f), h.listenerCount(k(3), () => {}));`,
    },
  },
  {
    id: "EDYN-06 newListener/removeListener meta events with computed names (JS)",
    files: {
      "main.cjs": `const EventEmitter = require("node:events").EventEmitter;
class Hub extends EventEmitter {}
const h = new Hub();
const k = (s) => "k:" + s;
h.on("newListener", (ev, fn) => console.log("new", ev, typeof fn));
h.on(k("removeListener").slice(2), (ev, fn) => console.log("removed", ev, typeof fn));
const f = () => {};
h.on(k("x"), f);
h.once(k("y"), () => console.log("y fired"));
h.emit(k("y"));
h.off(k("x"), f);
h.on(k("z"), f);
h.on(k("z"), f);
h.removeAllListeners(k("z"));
console.log(h.eventNames());`,
    },
  },
  {
    id: "EDYN-07 'error' with and without listeners, computed and literal (JS)",
    files: {
      "main.cjs": `const EventEmitter = require("node:events").EventEmitter;
class Hub extends EventEmitter {}
const h = new Hub();
const ev = (s) => [s].join("");
try { h.emit(ev("error"), new Error("boom")); } catch (e) { console.log("caught", e.message, e.name); }
const err = new TypeError("t");
try { h.emit(ev("error"), err); } catch (e) { console.log("same", e.message, e.name); }
try { h.emit(ev("error"), "str"); } catch (e) { console.log(e.code, e.name, e.message); }
try { h.emit(ev("error"), { a: 1, b: [2] }); } catch (e) { console.log(e.message); }
try { h.emit(ev("error")); } catch (e) { console.log(e.message); }
try { h.emit("error", 42); } catch (e) { console.log(e.message); }
h.on(ev("error"), (e) => console.log("handled", e));
console.log(h.emit("error", "s2"), h.emit(ev("error"), 7));
console.log(h.listenerCount("error"), h.eventNames());
h.removeAllListeners("error");
try { h.emit("error", null); } catch (e) { console.log(e.message); }`,
    },
  },
];

describe("dynamic-mode EventEmitter (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("dynamic-mode EventEmitter (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("dynamic-mode EventEmitter: named stops (GH #208)", () => {
  test("EDYN-S1 listeners() on a dynamic-mode family refuses by name", async () => {
    const row: Row = {
      id: "EDYN-S1",
      files: {
        "main.ts": `import { EventEmitter } from "node:events";
class Bus extends EventEmitter {}
const bus = new Bus();
bus.on("a" + String(1), () => {});
const ls = bus.listeners("a1");
console.log(typeof ls);`,
      },
    };
    await checkRefuses(scratch, row, "listeners() on an emitter whose class family uses dynamic event names");
  });

  test("EDYN-S2 rawListeners() on a dynamic-mode family refuses by name", async () => {
    const row: Row = {
      id: "EDYN-S2",
      files: {
        "main.cjs": `const EventEmitter = require("node:events").EventEmitter;
class Bus extends EventEmitter {}
const bus = new Bus();
const n = "a" + 1;
bus.on(n, () => {});
console.log("before");
const ls = bus.rawListeners(n);
console.log(typeof ls);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "'rawListeners() on an emitter whose class family uses dynamic event names");
  }, 600_000);

  test("EDYN-S3 the leak warning stops by name", async () => {
    const row: Row = {
      id: "EDYN-S3",
      files: {
        "main.cjs": `const EventEmitter = require("node:events").EventEmitter;
class Bus extends EventEmitter {}
const bus = new Bus();
const n = "a" + 1;
for (let i = 0; i < 10; i++) bus.on(n, () => {});
console.log("ten", bus.listenerCount(n));
bus.on(n, () => {});
console.log("eleven", bus.listenerCount(n));`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "ten 10\n", "EventEmitter's MaxListenersExceededWarning");
  }, 600_000);

  test("EDYN-S4 a stream cannot reach an EventEmitter-typed receiver (the upcast refuses by name)", async () => {
    const row: Row = {
      id: "EDYN-S4",
      files: {
        "main.ts": `import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
function reg(e: EventEmitter, n: string): void {
  e.on(n, () => {});
}
const ee = new EventEmitter();
reg(ee, "a" + 1);
console.log("ok", ee.listenerCount("a1"));
const r = new Readable({ read() {} });
reg(r, "x");`,
      },
    };
    await checkRefuses(scratch, row, "'Readable' values where 'EventEmitter' is expected");
  });

  test("EDYN-S5 a dynamic event name that is not a string stops by name", async () => {
    const row: Row = {
      id: "EDYN-S5",
      files: {
        "main.cjs": `const EventEmitter = require("node:events").EventEmitter;
class Bus extends EventEmitter {}
const bus = new Bus();
const names = JSON.parse('["a", 5]');
bus.on(names[0], () => console.log("a fired"));
bus.emit(names[0]);
bus.on(names[1], () => {});
console.log("not reached");`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "a fired\n", "an EventEmitter event name that is not a string");
  }, 600_000);
});
