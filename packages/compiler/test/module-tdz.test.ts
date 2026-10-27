/* Board #265 — the module-scope temporal dead zone (module-tdz.ts).
 *
 * The ANALYSIS rows pin where guards are (and are not) emitted, on the
 * lowered IR: a `global.tdzCheck` libCall per guarded access, a BOOL
 * `%tdz` flag global per guarded binding. "Provably initialized" accesses
 * — a reading function nothing can start before the declaration ran —
 * carry no guard and the binding no flag, so such programs compile
 * exactly as before. The RUNTIME rows run guarded programs on the wasm
 * lane against Node's text (the corpus program 2765-module-tdz pins every
 * lane against Node itself). */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import type { IrModule } from "../src/ir/nodes.js";
import { deserializeModule } from "../src/ir/serialize.js";
import { runWasm } from "./wasm-host.js";

// The coverage invariant (module-tdz.ts assertTdzCoverage): every guarded
// source access in a lowered unit carries a check, or the build throws.
process.env["SCRIPTC_TDZ_ASSERT"] = "1";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-module-tdz-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let n = 0;
async function build(src: string): Promise<{ ir: IrModule; wasm: string }> {
  const dir = join(scratch, `p${n++}`);
  const entry = join(dir, "main.ts");
  await rm(dir, { recursive: true, force: true });
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  await writeFile(entry, src);
  const res = await compile(entry, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", emitIr: true });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  if (!res.irPath) throw new Error("no irPath");
  return { ir: deserializeModule(await readFile(res.irPath, "utf8")), wasm: res.binaryPath };
}

/** Guard sites: function name → the binding names its tdzChecks test. */
function guards(ir: IrModule): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const fn of ir.functions) {
    const names: string[] = [];
    const scan = (v: unknown): void => {
      if (v === null || typeof v !== "object") return;
      if (Array.isArray(v)) {
        for (const x of v) scan(x);
        return;
      }
      const r = v as Record<string, unknown>;
      if (r["kind"] === "libCall" && r["fn"] === "global.tdzCheck") {
        const nameArg = (r["args"] as { value?: string }[])[1];
        names.push(nameArg?.value ?? "?");
      }
      for (const k of Object.keys(r)) if (k !== "type" && k !== "loc") scan(r[k]);
    };
    scan(fn.body);
    if (names.length > 0) out.set(fn.name, names);
  }
  return out;
}
const flags = (ir: IrModule): string[] => (ir.globals ?? []).filter((g) => g.id.includes("%tdz")).map((g) => g.name);
const all = (g: Map<string, string[]>): string[] => [...g.values()].flat().sort();

describe("module TDZ analysis: where guards go", () => {
  test("TDZ-A1 a reading function called only after the declaration: no guard, no flag", async () => {
    const { ir } = await build(`
function f(): number { return n * 2; }
const n = 21;
console.log(f());
`);
    expect(all(guards(ir))).toEqual([]);
    expect(flags(ir)).toEqual([]);
  });

  test("TDZ-A2 a function called before the declaration: its read is guarded", async () => {
    const { ir } = await build(`
function f(): number { return n; }
try { console.log(f()); } catch (e) { console.log("tdz"); }
const n = 21;
`);
    expect(guards(ir).get("f")).toEqual(["n"]);
    expect(flags(ir)).toEqual(["%tdz.n"]);
  });

  test("TDZ-A3 only the functions that can run early are guarded", async () => {
    const { ir } = await build(`
function early(): number { return n; }
function late(): number { return n * 2; }
try { console.log(early()); } catch (e) { console.log("tdz"); }
const n = 1;
console.log(late());
`);
    const g = guards(ir);
    expect(g.get("early")).toEqual(["n"]);
    expect(g.has("late")).toBe(false);
  });

  test("TDZ-A4 transitive reach: a callee of an early call is guarded", async () => {
    const { ir } = await build(`
function outer(): number { return inner() + 1; }
function inner(): number { return n; }
try { console.log(outer()); } catch (e) { console.log("tdz"); }
const n = 1;
`);
    expect(guards(ir).get("inner")).toEqual(["n"]);
  });

  test("TDZ-A5 declarators initialize left to right: an earlier one is never guarded", async () => {
    const { ir } = await build(`
let base = 5, add = (x: number): number => x + base, applied = add(10);
console.log(applied, add(1));
`);
    expect(all(guards(ir))).toEqual([]);
    expect(flags(ir)).toEqual([]);
  });

  test("TDZ-A6 self-capture through a sync-inert initializer (a timer, an accessor literal): no guard", async () => {
    const { ir } = await build(`
let ticks = 0;
const timer = setInterval(() => { ticks++; if (ticks === 2) clearInterval(timer); }, 1);
const box = { w: 2, get v(): number { return box.w * 10; } };
console.log(box.v);
`);
    expect(all(guards(ir))).toEqual([]);
    expect(flags(ir)).toEqual([]);
  });

  test("TDZ-A7 self-capture through a USER call: guarded (the callee may run it)", async () => {
    const { ir } = await build(`
function run(f: () => number): number { return f(); }
let got = "";
try { const k: number = run(() => k + 1); got = String(k); } catch (e) { got = "inner"; }
const k2: number = (() => { try { return run(() => k2); } catch (e) { return -1; } })();
console.log(got, k2);
`);
    expect(all(guards(ir))).toEqual(["k2"]);
  });

  test("TDZ-A8 a class's own body reads its inner binding: no guard; an early outside use is guarded", async () => {
    const { ir } = await build(`
function make(): number { return C.make().v; }
try { console.log(make()); } catch (e) { console.log("tdz"); }
class C {
  v = 3;
  static make(): C { return new C(); }
}
console.log(make());
`);
    expect(all(guards(ir))).toEqual(["C"]);
  });

  test("TDZ-A9 typeof is guarded even though the read folds away", async () => {
    const { ir } = await build(`
function kind(): string { return typeof s; }
try { console.log(kind()); } catch (e) { console.log("tdz"); }
const s = "x";
`);
    expect(guards(ir).get("kind")).toEqual(["s"]);
  });

  test("TDZ-A10 a class alias whose initializer runs nothing: the aliasing reader cannot run early, no guard", async () => {
    const { ir } = await build(`
class Box {
  static scale = 10;
  static viaAlias(): number { return Alias.scale; }
}
const Alias = Box;
console.log(Box.viaAlias());
`);
    expect(all(guards(ir))).toEqual([]);
    expect(flags(ir)).toEqual([]);
  });

  test("TDZ-A11 a flag nothing can test is dropped (the reading function never runs early)", async () => {
    const { ir } = await build(`
function rd(): number { return late; }
const late = 1;
console.log(rd());
`);
    expect(all(guards(ir))).toEqual([]);
    expect(flags(ir)).toEqual([]);
  });
});

/* Board #265 review B1/B2: reads lowering FOLDS or ALIASES away (no global
 * access reaches emission) still throw, as does a function reached only
 * through a self-import of an anonymous default export. Every row runs
 * with the coverage invariant on (SCRIPTC_TDZ_ASSERT, set above). */
describe("module TDZ: folded and aliased reads", () => {
  const T = `function t(label: string, f: () => unknown): void {
  try { console.log(label, String(f())); } catch (e) { console.log(label, e instanceof Error ? e.message : "?"); }
}
`;
  const rows: [string, string, string][] = [
    ["alias-fn", `class Box { static scale = 10; }
function rd(): number { return Alias.scale; }
t('a', rd);
const Alias = Box;
console.log(rd());`, "a Cannot access 'Alias' before initialization\n10\n"],
    ["alias-chain", `class Box { static scale = 10; }
function rd(): number { return Alias2.scale; }
t('a', rd);
const Alias1 = Box;
const Alias2 = Alias1;
console.log(rd());`, "a Cannot access 'Alias2' before initialization\n10\n"],
    ["alias-static-method", `class Box { static scale = 10; static viaAlias(): number { return Alias.scale; } }
t('a', () => Box.viaAlias());
const Alias = Box;
console.log(Box.viaAlias());`, "a Cannot access 'Alias' before initialization\n10\n"],
    ["eq-undefined", `function a(): unknown { return late === undefined; }
t('a', a);
const late = [1];
console.log(a());`, "a Cannot access 'late' before initialization\nfalse\n"],
    ["ne-null", `function a(): unknown { return late !== null; }
t('a', a);
const late = { v: 1 };
console.log(a());`, "a Cannot access 'late' before initialization\ntrue\n"],
    ["void", `function a(): unknown { return void late; }
t('a', a);
const late = 1;
console.log(late);`, "a Cannot access 'late' before initialization\n1\n"],
    ["class-expr-static-block", `const K = class { static y = 1; static { t('a', () => K.y); } };
console.log(K.y);`, "a Cannot access 'K' before initialization\n1\n"],
    ["class-expr-static-init", `const K = class { static x: number = 1; static y: number = (() => { t('a', () => K.x); return 2; })(); };
console.log(K.y);`, "a Cannot access 'K' before initialization\n2\n"],
    ["inline-callback", `const late2: number[] = (() => { try { return [1, 2, 3].filter((x) => late2 === undefined || x > 1); } catch (e) { return [-1]; } })();
console.log(late2);`, "[ -1 ]\n"],
    ["self-import-default", `export default function (): number { return late; }
import def from './main.ts';
t('a', def);
const late = 1;
console.log(late, def());`, "a Cannot access 'late' before initialization\n1 1\n"],
  ];
  for (const [name, body, expected] of rows) {
    test(`TDZ-F ${name}`, async () => {
      const { wasm } = await build(T + body);
      const r = await runWasm(wasm);
      expect(r.stdout.toString("utf8")).toBe(expected);
    });
  }
});

describe("module TDZ at run time (wasm lane vs Node's text)", () => {
  test("TDZ-R1 read, write (RHS first), typeof, class: Node's ReferenceError, catchable, then values", async () => {
    const { wasm } = await build(`
function msg(e: unknown): string { return e instanceof Error ? e.name + ": " + e.message : "?"; }
function rd(): number { return n; }
function wr(): void { l = side(); }
function side(): number { console.log("rhs"); return 4; }
function ty(): string { return typeof l; }
function mk(): number { return new C().v; }
for (const f of [() => rd(), () => wr(), () => ty(), () => mk()]) {
  try { f(); console.log("ok"); } catch (e) { console.log(msg(e)); }
}
const n = 1;
let l = 2;
class C { v = 7; }
console.log(rd(), l, ty(), mk());
wr();
console.log(l);
`);
    const r = await runWasm(wasm);
    expect(r.stdout.toString("utf8")).toBe(
      [
        "ReferenceError: Cannot access 'n' before initialization",
        "rhs",
        "ReferenceError: Cannot access 'l' before initialization",
        "ReferenceError: Cannot access 'l' before initialization",
        "ReferenceError: Cannot access 'C' before initialization",
        "1 2 number 7",
        "rhs",
        "4",
        "",
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
  });

  test("TDZ-R3 a destructuring declaration binds element by element (flag set per element)", async () => {
    const { ir, wasm } = await build(`
function qOf(): number { return q; }
function lastOf(): number { try { return last; } catch (e) { return -1; } }
const { q = 3, r = qOf() + 1, s = lastOf(), last = 9 } = {} as { q?: number; r?: number; s?: number; last?: number };
console.log(q, r, s, last);
`);
    expect(all(guards(ir))).toEqual(["last", "q"]);
    const r = await runWasm(wasm);
    expect(r.stdout.toString("utf8")).toBe("3 4 -1 9\n");
  });

  test("TDZ-R4 class statics through early functions (read, write, call, construct as an argument)", async () => {
    const { wasm } = await build(`
function take(n: number): number { return n; }
function rd(): number { return take(C.count); }
function wr(): void { C.count = 5; }
function call(): void { C.reset(); }
function mk(): number { return take(new C().v); }
for (const f of [() => rd(), () => wr(), () => call(), () => mk()]) {
  try { f(); console.log("ok"); } catch (e) { console.log(e instanceof Error ? e.message : "?"); }
}
class C {
  static count = 1;
  v = 3;
  static reset(): void { C.count = 0; }
}
console.log(rd(), mk());
wr();
console.log(C.count);
call();
console.log(C.count);
`);
    const r = await runWasm(wasm);
    expect(r.stdout.toString("utf8")).toBe(
      "Cannot access 'C' before initialization\n".repeat(4) + "1 3\n5\n0\n",
    );
  });

  test("TDZ-R2 the self-capture through a user call throws inside, then the binding holds its value", async () => {
    const { wasm } = await build(`
function run(f: () => number): number { return f(); }
const k: number = (() => { try { return run(() => k); } catch (e) { return e instanceof Error ? -1 : -2; } })();
console.log(k);
`);
    const r = await runWasm(wasm);
    expect(r.stdout.toString("utf8")).toBe("-1\n");
  });
});
