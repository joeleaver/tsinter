/* Inheritance codegen guarantees that are scriptc-only by nature —
 * deliberately NOT in the differential corpus (behavior is; these pin the
 * COST model):
 *
 * - Zero-cost standalone classes: a program whose classes never extend
 *   must emit no vtable machinery at all — no vtable word, no ScrVt, no
 *   dynamic dispatch. The "inheritance costs nothing until you use it"
 *   claim, machine-enforced.
 * - Whole-program devirtualization: inside a hierarchy, a method nobody
 *   overrides keeps the direct static call (and gets no vtable slot);
 *   only genuinely-overridden methods dispatch through the vtable.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** Compiles an inline program and returns the emitted C text. */
async function emittedC(name: string, source: string, ext = "ts"): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `inh-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.${ext}`);
  writeFileSync(file, source);
  // Pinned: the zero-cost/devirtualization claims are asserted by grepping
  // the emitted C — the suite measures the C backend's artifact by design.
  const result = await compile(file, { outPath: join(outDir, name), outDir, sanitize, backend: "c" });
  if (!result.ok) {
    throw new Error(
      "inheritance program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return readFileSync(result.cPath, "utf8");
}

describe("inheritance codegen", () => {
  test("standalone classes emit no vtable machinery", async () => {
    const c = await emittedC(
      "standalone",
      `class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
  norm(): number {
    return this.x * this.x;
  }
}
const p = new Point(3);
console.log(p.norm());
`,
    );
    expect(c).not.toContain("ScrVt");
    expect(c).not.toContain("->vt");
    expect(c).not.toContain("sc_vtable_");
  });

  test("a never-overridden method in a hierarchy stays a direct call", async () => {
    const c = await emittedC(
      "devirt",
      `class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  id(): string {
    return this.name; // never overridden: no slot, direct calls
  }
  speak(): string {
    return "..."; // overridden below: vtable slot, dynamic calls
  }
}
class Dog extends Animal {
  speak(): string {
    return "woof";
  }
}
const a: Animal = new Dog("rex");
console.log(a.id(), a.speak());
`,
    );
    // The devirtualized call is a direct sc_f_ call of Animal's id...
    expect(c).toMatch(/sc_f__x25_Animal_id\(/);
    // ...and id never becomes a vtable slot, while speak does and the
    // base-typed call site dispatches through it.
    expect(c).not.toContain("sc_vs_id");
    expect(c).toContain("sc_vs_speak");
    expect(c).toMatch(/->vt\)->sc_vs_speak\(/);
  });

  test("accessors on standalone classes stay zero-cost direct calls", async () => {
    const c = await emittedC(
      "accessor-standalone",
      `class Gauge {
  _level: number;
  constructor() {
    this._level = 0;
  }
  get level(): number {
    return this._level;
  }
  set level(v: number) {
    this._level = v;
  }
}
const g = new Gauge();
g.level = 5;
g.level += 2;
console.log(g.level);
`,
    );
    expect(c).not.toContain("ScrVt");
    expect(c).not.toContain("->vt");
    expect(c).not.toContain("sc_vtable_");
    // Reads and writes are direct calls of the accessor functions
    // ("get:level" mangles ':' as _x3a_).
    expect(c).toMatch(/sc_f__x25_Gauge_get_x3a_level\(/);
    expect(c).toMatch(/sc_f__x25_Gauge_set_x3a_level\(/);
  });

  test("the get and set halves of accessors devirtualize independently", async () => {
    const c = await emittedC(
      "accessor-devirt",
      `class Cell {
  _v: number;
  constructor() {
    this._v = 0;
  }
  get v(): number {
    return this._v; // pair, never overridden: no slots, direct calls
  }
  set v(x: number) {
    this._v = x;
  }
  get label(): string {
    return "cell"; // getter-only, overridden below: vtable slot
  }
}
class LoudCell extends Cell {
  get label(): string {
    return "LOUD " + this._v;
  }
}
const c: Cell = new LoudCell();
c.v = 3;
console.log(c.v, c.label);
`,
    );
    // The overridden getter dispatches through its slot...
    expect(c).toContain("sc_vs_get_x3a_label");
    expect(c).toMatch(/->vt\)->sc_vs_get_x3a_label\(/);
    // ...while the never-overridden pair keeps direct calls and no slots.
    expect(c).not.toContain("sc_vs_get_x3a_v");
    expect(c).not.toContain("sc_vs_set_x3a_v");
    expect(c).toMatch(/sc_f__x25_Cell_get_x3a_v\(/);
    expect(c).toMatch(/sc_f__x25_Cell_set_x3a_v\(/);
  });

  test("a stream subclass embeds the ScrStream prefix and delegates its state RC", async () => {
    const c = await emittedC(
      "stream-subclass",
      `import { Readable } from "node:stream";
class Counter extends Readable {
  n = 0;
  _read(): void {
    this.n++;
    this.push(this.n <= 2 ? String(this.n) : null);
  }
}
const r = new Counter();
r.on("data", (b: Buffer) => console.log(b.toString()));
`,
    );
    // The subclass struct carries the full ScrStream prefix (registry,
    // display name, state pointer) ahead of user fields...
    expect(c).toMatch(/ScrStreamState \*sc_st;[\s\S]{0,200}\/\* n \*\//);
    // ...its teardown delegates the state block to the runtime...
    expect(c).toContain("scr_stream_st_release(o->sc_st)");
    // ...and super() initializes the state over the allocated struct.
    expect(c).toContain("scr_stream_init_readable((ScrStream *)");
  });

  test("a runtime-fenced nested class extending a stream still compiles to C", async () => {
    // The phase-1 reachable bug: a class declared inside a block (a
    // runtime fence in JS) whose instances are captured emitted capture-
    // box RC adapters for the uncollected class — a C compile error.
    // run()'s unregistered-class sweep now rewrites such type slots to
    // the inert f64 placeholder before emission (no instance can exist;
    // every use traps), so the capture box is a PLAIN-kind box and the
    // class never reaches the emitter at all.
    const c = await emittedC(
      "stream-nested-fence",
      `const { Readable } = require("stream");
{
  class R extends Readable {
    _read() { this.push(null); }
  }
  function onRead() { stream.read(); }
  const stream = new R();
  stream.once("readable", onRead);
}
`,
      "js",
    );
    expect(c).not.toContain("sc_retain_R_v");
    expect(c).not.toContain("uncollected class");
    expect(c).toMatch(/sc_l_stream_0 = scr_box_new\(SCR_BOX_\w+\)/);
  });

  test("a getter-only override of a pair fills the set slot with a thrower", async () => {
    const c = await emittedC(
      "accessor-shadow",
      `class Box {
  _v: number;
  constructor() {
    this._v = 1;
  }
  get v(): number {
    return this._v;
  }
  set v(x: number) {
    this._v = x;
  }
}
class SealedBox extends Box {
  get v(): number {
    return 42;
  }
}
const b: Box = new SealedBox();
try {
  b.v = 9;
} catch {
  console.log("sealed");
}
console.log(b.v);
`,
    );
    // JS shadowing: the derived class's synthesized setter occupies the
    // set slot (a base-typed write must throw like Node), so BOTH halves
    // dispatch dynamically here.
    expect(c).toContain("sc_vs_get_x3a_v");
    expect(c).toContain("sc_vs_set_x3a_v");
    expect(c).toMatch(/sc_f__x25_SealedBox_set_x3a_v/);
  });
});
