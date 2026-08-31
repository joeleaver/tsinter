/* Increment 23 P4 (board #98) — `Object.defineProperties` over a
 * checked-dynamic value: `%w.dyn.defineProps` (dyn.ts SITE B), the
 * `$fnProps` side table (SITE A), the keyGet/hasOwn/objWalk/keySet
 * FUNC-arm amendments (SITE C), and the LOG/CF renderer FUNC arms
 * (SITE D). Every pin here is a REAL compiled-TypeScript program run
 * end to end (the frontend libCall wiring — SITE E — is what makes this
 * possible, unlike wasm-assert-dyn.test.ts's own force-emit style,
 * built before its own libCall existed). Every expected string is a
 * byte-exact live Node v24.18.1 measurement, not a transcription.
 * CLAIM 0 throughout — no corpus program can pin any of this directly
 * (design-p4.txt §0/§6): a program observing this feature's own
 * behavior, divergent OR matching, would fail the differential on
 * every lane by construction (S016's own argument, inherited here). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

async function compileAndRun(
  src: string,
  expectTrap = false,
): Promise<{ stdout: string; stderr: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "defineprops-pin-"));
  const entry = join(scratch, "t.ts");
  await writeFile(entry, src);
  try {
    const res = await compile(entry, { outPath: join(scratch, "t.wasm"), outDir: scratch, backend: "wasm" });
    if (!res.ok) throw new Error(`BUILD REFUSED: ${res.diagnostics[0]?.message ?? "(no diagnostic)"}`);
    const bytes = readFileSync(res.binaryPath);
    if (!WebAssembly.validate(bytes)) throw new Error("emitted module failed WebAssembly.validate");
    return expectTrap ? runWasmToTrap(res.binaryPath) : runWasm(res.binaryPath);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/* ── MECHANISM (SITE A) ─────────────────────────────────────────────
 * design-p4.txt §6: "define through one box, read through ANOTHER box
 * of the same function" and "define through an EE-wrapped listener,
 * read through the original (board #89's route)" — both prove the
 * `$fnProps` table is keyed on FN_CLOS, not the dyn box, which is what
 * makes it agree with `===` across S014's copy-on-crossing. */

test("mechanism: a property defined through one box reads through ANOTHER box of the same function", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function h() {}",
      "const a1: any = h;",
      "const a2: any = h;",
      "a1.tag = 'set-via-a1';",
      "console.log(a2.tag);",
      "console.log((a1 as unknown) === (a2 as unknown));",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("set-via-a1\ntrue\n");
});

test("mechanism: a property defined on the ORIGINAL reads through an EventEmitter .once() wrapper", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "import { EventEmitter } from 'node:events';",
      "function handler(x: number): void { console.log('h', x); }",
      "const orig: any = handler;",
      "orig.tag = 'from-orig';",
      "const ee = new EventEmitter();",
      "ee.once('evt', handler);",
      "const got: any = ee.listeners('evt')[0];",
      "console.log(got.tag, (got as unknown) === (orig as unknown));",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("from-orig true\n");
});

/* ── SEMANTICS (SITE B) — every §5 error shape byte-exact, plus C-3/C-4's
 * two NO-THROW rows a C-faithful port gets wrong. ────────────────────── */

test("semantics: non-object target throws Node's own TypeError text", async () => {
  const { stdout, stderr } = await compileAndRun(
    ["const o: any = 5;", "Object.defineProperties(o, {});", "console.log('unreachable');"].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught TypeError: Object.defineProperties called on non-object\n");
});

test("semantics: nullish descs throws ToObject's TypeError text", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "const o: any = {};",
      "const descs: any = null;",
      "Object.defineProperties(o, descs);",
      "console.log('unreachable');",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught TypeError: Cannot convert undefined or null to object\n");
});

test("semantics C-3: a non-nullish, non-object descs is a NO-OP — returns target, copies nothing", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "const o: any = { a: 1 };",
      "const descs: any = 5;",
      "const r = Object.defineProperties(o, descs);",
      "console.log(r === o, o.a);",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("true 1\n");
});

test("semantics C-4: a non-object-like descriptor value throws with the ToString(value) text", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "const o: any = {};",
      "const descs: any = {};",
      "descs.x = 5;",
      "Object.defineProperties(o, descs);",
      "console.log('unreachable');",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught TypeError: Property description must be an object: 5\n");
});

test("semantics C-4: an ARRAY descriptor value is object-like — no throw, defines undefined (FUNC target: an OBJ target would hit S062 instead, since an array's own `.enumerable` read is ALSO undefined -> false, MEASURED against Node directly)", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function g() {}",
      "const f: any = g;",
      "const arr: any = [1, 2];",
      "const descs: any = {};",
      "descs.x = arr;",
      "Object.defineProperties(f, descs);",
      "console.log(f.x);",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("undefined\n");
});

test("semantics S061: an accessor descriptor (get/set PRESENCE) throws a plain Error, not TypeError — non-callable get, OBJ target", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "const o: any = {};",
      "const d: any = {};",
      "d.get = 1;",
      "const descs: any = {};",
      "descs.x = d;",
      "Object.defineProperties(o, descs);",
      "console.log('unreachable');",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe(
    "Uncaught Error: accessor (get/set) property descriptors on a dynamic value are not supported yet\n",
  );
});

test("semantics S061: a CALLABLE get on a FUNC target throws identically — presence is the trigger regardless of target kind or callability", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function g() {}",
      "const f: any = g;",
      "function getter() { return 42; }",
      "const getterAny: any = getter;",
      "const d: any = {};",
      "d.get = getterAny;",
      "d.enumerable = true;",
      "const descs: any = {};",
      "descs.x = d;",
      "Object.defineProperties(f, descs);",
      "console.log('unreachable');",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe(
    "Uncaught Error: accessor (get/set) property descriptors on a dynamic value are not supported yet\n",
  );
});

test("semantics S062: a non-enumerable OBJ-target write refuses by name (Node succeeds silently)", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "const o: any = {};",
      "const d: any = {};",
      "d.value = 1;",
      "d.enumerable = false;",
      "const descs: any = {};",
      "descs.x = d;",
      "Object.defineProperties(o, descs);",
      "console.log('unreachable');",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe(
    "Uncaught Error: Object.defineProperties: a non-enumerable property descriptor on a plain-object " +
      "dynamic value is not supported yet\n",
  );
});

test("semantics S062's own positive control: enumerable:true on an OBJ target succeeds", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "const o: any = {};",
      "const d: any = {};",
      "d.value = 1;",
      "d.enumerable = true;",
      "const descs: any = {};",
      "descs.x = d;",
      "Object.defineProperties(o, descs);",
      "console.log(o.x, Object.keys(o));",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("1 [ 'x' ]\n");
});

/* ── SURFACE (SITE C) — design-p4.txt §4's table, both flag states,
 * for get / hasOwn / keys / for-in (NOT `in` — §4.1: the libCall does
 * not exist on wasm for ANY dyn kind, so there is nothing to pin). */

test("surface: get/hasOwn/keys over an enumerable vs a hidden FUNC property", async () => {
  // NOT for-in: `for...in` over an `any`-typed receiver refuses tier-wide
  // ("for-in over 'any' receivers... are not supported yet") — a
  // pre-existing, orthogonal frontend limitation unrelated to P4 (design
  // §4's own row is covered by `Object.keys`/`Object.entries` instead,
  // which agree with for-in's own enumeration order for a plain FUNC).
  const { stdout, stderr } = await compileAndRun(
    [
      "function g() {}",
      "const f: any = g;",
      "const dv: any = {}; dv.value = 1; dv.enumerable = true;",
      "const dh: any = {}; dh.value = 2; dh.enumerable = false;",
      "const descs: any = {}; descs.vis = dv; descs.hid = dh;",
      "Object.defineProperties(f, descs);",
      "console.log('get', f.vis, f.hid);",
      "console.log('hasOwn', Object.hasOwn(f, 'vis'), Object.hasOwn(f, 'hid'));",
      "console.log('keys', Object.keys(f));",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("get 1 2\nhasOwn true true\nkeys [ 'vis' ]\n");
});

test("surface: keySet (f.x=1) on a FUNC creates an ENUMERABLE property (Node's own default)", async () => {
  const { stdout, stderr } = await compileAndRun(
    ["function g() {}", "const f: any = g;", "f.x = 1;", "console.log(f.x, Object.keys(f), f);"].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("1 [ 'x' ] [Function: g] { x: 1 }\n");
});

test("surface bound: an ARR non-index write and a primitive receiver STILL throw (S016's other side)", async () => {
  const { stdout, stderr } = await compileAndRun(
    ["const a: any = [1, 2, 3];", "a.nope = 1;", "console.log('unreachable');"].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught TypeError: Cannot create property 'nope' on array\n");
});

test("surface bound: a NUMBER receiver still throws the primitive-write text (unchanged by P4)", async () => {
  const { stdout, stderr } = await compileAndRun(
    ["const n: any = 5;", "n.x = 1;", "console.log('unreachable');"].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught TypeError: Cannot create property 'x' on number '5'\n");
});

/* ── RENDERING (SITE D) — design-p4.txt §3's 14 rows, both renderers,
 * plus this pass's own additional findings (circularity, the depth
 * cutoff) that the design's own rows never exercised. */

const renderCases: Array<{ name: string; src: string; expect: string }> = [
  {
    name: "named-1prop",
    src: "function g(){} const f:any=g; const d:any={};d.value=1;d.enumerable=true; const ds:any={};ds.a=d; Object.defineProperties(f,ds); console.log(f);",
    expect: "[Function: g] { a: 1 }\n",
  },
  {
    name: "named-0props",
    src: "function g(){} const f:any=g; console.log(f);",
    expect: "[Function: g]\n",
  },
  {
    name: "anon-1prop",
    src: "const f:any=[function(){}][0]; const d:any={};d.value=1;d.enumerable=true; const ds:any={};ds.a=d; Object.defineProperties(f,ds); console.log(f);",
    expect: "[Function (anonymous)] { a: 1 }\n",
  },
  {
    name: "mustCall-name-length",
    src: "function orig(){} const w:any=orig; const dn:any={};dn.value='orig';dn.enumerable=false; const dl:any={};dl.value=0;dl.enumerable=false; const ds:any={};ds.name=dn;ds.length=dl; Object.defineProperties(w,ds); console.log(w); console.log(Object.keys(w));",
    expect: "[Function: orig]\n[]\n",
  },
  {
    name: "name-redefined-to-a-different-string",
    src: "const f:any=[function(){}][0]; const d:any={};d.value='picked';d.enumerable=true; const ds:any={};ds.name=d; Object.defineProperties(f,ds); console.log(f);",
    expect: "[Function: picked] { name: 'picked' }\n",
  },
  {
    name: "sorted-mixed-keys (LOG: insertion order)",
    src: "function g(){} const f:any=g; const d1:any={};d1.value=1;d1.enumerable=true; const d2:any={};d2.value=2;d2.enumerable=true; const d3:any={};d3.value=3;d3.enumerable=true; const ds:any={};ds.zz=d1;ds.aa=d2;ds['a-b']=d3; Object.defineProperties(f,ds); console.log(f);",
    expect: "[Function: g] { zz: 1, aa: 2, 'a-b': 3 }\n",
  },
  {
    name: "circular-self",
    src: "function g(){} const f:any=g; const d:any={};d.value=f;d.enumerable=true; const ds:any={};ds.self=d; Object.defineProperties(f,ds); console.log(f);",
    expect: "<ref *1> [Function: g] { self: [Circular *1] }\n",
  },
  {
    name: "circular-hidden-is-invisible",
    src: "function g(){} const f:any=g; const d:any={};d.value=f;d.enumerable=false; const ds:any={};ds.self=d; Object.defineProperties(f,ds); console.log(f);",
    expect: "[Function: g]\n",
  },
];

for (const c of renderCases) {
  test(`LOG rendering: ${c.name}`, async () => {
    const { stdout, stderr } = await compileAndRun(c.src);
    expect(stderr).toBe("");
    expect(stdout).toBe(c.expect);
  });
}

test("LOG rendering: a FUNC-with-props beyond the default display depth collapses to bare [Function]", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function g() {}",
      "const f: any = g;",
      "const d: any = {}; d.value = 1; d.enumerable = true;",
      "const descs: any = {}; descs.a = d;",
      "Object.defineProperties(f, descs);",
      "const p: any = {}; const q: any = {}; const r: any = {};",
      "r.z = f; q.y = r; p.x = q;",
      "console.log(p);",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("{ x: { y: { z: [Function] } } }\n");
});

test("LOG rendering: the SAME FUNC-with-props AT the depth boundary still renders fully", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function g() {}",
      "const f: any = g;",
      "const d: any = {}; d.value = 1; d.enumerable = true;",
      "const descs: any = {}; descs.a = d;",
      "Object.defineProperties(f, descs);",
      "const p: any = {}; const q: any = {};",
      "q.z = f; p.x = q;",
      "console.log(p);",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("{ x: { z: [Function: g] { a: 1 } } }\n");
});

test("CF rendering: assert.deepStrictEqual sorts keys and expands multi-line, unlike LOG", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "import assert from 'node:assert';",
      "function g() {}",
      "const f: any = g;",
      "const d1: any = {}; d1.value = 1; d1.enumerable = true;",
      "const d2: any = {}; d2.value = 3; d2.enumerable = true;",
      "const d3: any = {}; d3.value = 2; d3.enumerable = true;",
      "const descs: any = {}; descs.zz = d1; descs['a-b'] = d2; descs.aa = d3;",
      "Object.defineProperties(f, descs);",
      "assert.deepStrictEqual(f, {});",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("[Function: g] {\n+   'a-b': 3,\n+   aa: 2,\n+   zz: 1\n+ }");
});

/* ── LAZY GATE — `%w.dyn.defineProps` itself must be REACHABILITY-gated
 * like every other `cached()` helper (emitter.ts's own "Only REACHABLE
 * functions exist for this backend" discipline): a program that reads/
 * writes FUNC properties through `keySet`/`keyGet` but never calls
 * `Object.defineProperties` must NOT link in `defineProps()`'s own body
 * — an eager build would leak its own unique literal string into every
 * such binary regardless of use. */

test("lazy gate: a program using keySet/keyGet on a FUNC (but never Object.defineProperties) does not embed defineProps' own literal", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "defineprops-lazy-"));
  const entry = join(scratch, "t.ts");
  await writeFile(entry, ["function g() {}", "const f: any = g;", "f.x = 1;", "console.log(f.x);"].join("\n"));
  try {
    const res = await compile(entry, { outPath: join(scratch, "t.wasm"), outDir: scratch, backend: "wasm" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bytes = readFileSync(res.binaryPath);
    const text = "Object.defineProperties called on non-object";
    const hasMarker = bytes.includes(Buffer.from(text, "utf8")) || bytes.includes(Buffer.from(text, "utf16le"));
    expect(hasMarker).toBe(false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("CF rendering: mustCall's own shape (non-enumerable name/length) renders with NO block", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "import assert from 'node:assert';",
      "function orig() {}",
      "const wrapper: any = orig;",
      "const dn: any = {}; dn.value = 'orig'; dn.enumerable = false;",
      "const dl: any = {}; dl.value = 0; dl.enumerable = false;",
      "const descs: any = {}; descs.name = dn; descs.length = dl;",
      "Object.defineProperties(wrapper, descs);",
      "assert.deepStrictEqual(wrapper, {});",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toContain("+ [Function: orig]\n- {}");
});

/* ── DURABLE PLAN ADDITIONS (lead, rev-23's oracle work) — every claim
 * below independently re-measured against live Node before being
 * trusted, per the standing rule, not accepted on the message's word
 * alone. Each finding that changed the build is: (a) confirmed via a
 * standalone Node script FIRST, (b) then landed as a wasm-side fix,
 * (c) then pinned here. */

test("descs THREE arms: nullish throws, non-nullish-non-object no-ops, non-empty strings THROW naming a character", async () => {
  // arm (i): nullish — already covered by the earlier "nullish descs"
  // pin above; not repeated here.
  // arm (ii): no-op primitives, INCLUDING the empty-string boundary a
  // naive typeof check cannot see, and a boxed Number.
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "const o: any = { a: 1 };",
        "const empty: any = '';",
        "const r = Object.defineProperties(o, empty);",
        "console.log(r === o, o.a);",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("true 1\n");
  }
  // arm (iii): a NON-EMPTY string throws, naming the FIRST CHARACTER —
  // "ab" names "a", not the whole string (MEASURED: the walk processes
  // characters in order and throws on the first, which is character 0).
  {
    const { stdout, stderr } = await compileAndRun(
      ["const o: any = {};", "const s: any = 'x';", "Object.defineProperties(o, s);", "console.log('unreachable');"]
        .join("\n"),
      true,
    );
    expect(stdout).toBe("");
    expect(stderr).toBe("Uncaught TypeError: Property description must be an object: x\n");
  }
  {
    const { stdout, stderr } = await compileAndRun(
      ["const o: any = {};", "const s: any = 'ab';", "Object.defineProperties(o, s);", "console.log('unreachable');"]
        .join("\n"),
      true,
    );
    expect(stdout).toBe("");
    expect(stderr).toBe("Uncaught TypeError: Property description must be an object: a\n");
  }
});

test("descs: an ARRAY is a valid descs map — [] no-ops, [{value,enumerable}] defines key \"0\"", async () => {
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "const o: any = { a: 1 };",
        "const empty: any = [];",
        "const r = Object.defineProperties(o, empty);",
        "console.log(r === o, o.a);",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("true 1\n");
  }
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "const o: any = { a: 1 };",
        "const d: any = {}; d.value = 1; d.enumerable = true;",
        "const descs: any = []; descs[0] = d;",
        "Object.defineProperties(o, descs);",
        "console.log(o.a, o[0], Object.keys(o));",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    // Integer-like keys sort FIRST regardless of insertion order — "0"
    // (added by defineProperties) precedes "a" (already on the target),
    // MEASURED against live Node directly (not assumed from insertion
    // order).
    expect(stdout).toBe("1 1 [ '0', 'a' ]\n");
  }
});

test("descs: a FUNCTION descs bag no-ops when bare, but processes its OWN enumerable own property when it has one", async () => {
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "function bareFn() {}",
        "const o: any = { a: 1 };",
        "const descsFn: any = bareFn;",
        "const r = Object.defineProperties(o, descsFn);",
        "console.log(r === o, o.a);",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("true 1\n");
  }
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "function tagged() {}",
        "const descsFn: any = tagged;",
        "const d: any = {}; d.value = 99; d.enumerable = true;",
        "descsFn.x = d;",
        "const o: any = { a: 1 };",
        "Object.defineProperties(o, descsFn);",
        "console.log(o.a, o.x);",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("1 99\n");
  }
});

test("descs: a typed array (BYTES) throws on its first element — elements are raw numbers, never object-like", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "const o: any = {};",
      "const bytes: any = new Uint8Array([9, 8]);",
      "Object.defineProperties(o, bytes);",
      "console.log('unreachable');",
    ].join("\n"),
    true,
  );
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught TypeError: Property description must be an object: 9\n");
});

test("ONE FIXTURE discriminates BOTH surface mutations (H-4, both halves) — enumerable:true visible, enumerable OMITTED defaults hidden", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function g() {}",
      "const gAny: any = g;",
      "const dv: any = {}; dv.value = 1; dv.enumerable = true;",
      "const dh: any = {}; dh.value = 2;", // enumerable OMITTED — defaults false
      "const descs: any = {}; descs.vis = dv; descs.hid = dh;",
      "Object.defineProperties(gAny, descs);",
      "console.log(Object.keys(gAny));",
      "console.log(gAny);",
      "console.log(Object.hasOwn(gAny, 'hid'));",
      "console.log(gAny.hid);",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("[ 'vis' ]\n[Function: g] { vis: 1 }\ntrue\n2\n");
});

test("render key order: integer-like keys ascend FIRST and render QUOTED, then strings in insertion order", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function g() {}",
      "const gAny: any = g;",
      "const d2: any = {}; d2.value = 'two'; d2.enumerable = true;",
      "const d1: any = {}; d1.value = 'one'; d1.enumerable = true;",
      "const da: any = {}; da.value = 'A'; da.enumerable = true;",
      "const descs: any = {}; descs['2'] = d2; descs['1'] = d1; descs.a = da;",
      "Object.defineProperties(gAny, descs);",
      "console.log(Object.keys(gAny));",
      "console.log(gAny);",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("[ '1', '2', 'a' ]\n[Function: g] { '1': 'one', '2': 'two', a: 'A' }\n");
});

test("render key order near-misses: \"01\" and \"-1\" are NOT integer-like — insertion order, no reordering", async () => {
  {
    const { stdout } = await compileAndRun(
      [
        "function g() {}",
        "const gAny: any = g;",
        "const d01: any = {}; d01.value = 'x'; d01.enumerable = true;",
        "const d1: any = {}; d1.value = 'y'; d1.enumerable = true;",
        "const descs: any = {}; descs['01'] = d01; descs['1'] = d1;",
        "Object.defineProperties(gAny, descs);",
        "console.log(Object.keys(gAny));",
      ].join("\n"),
    );
    expect(stdout).toBe("[ '1', '01' ]\n");
  }
  {
    const { stdout } = await compileAndRun(
      [
        "function g() {}",
        "const gAny: any = g;",
        "const dm1: any = {}; dm1.value = 'x'; dm1.enumerable = true;",
        "const d0: any = {}; d0.value = 'y'; d0.enumerable = true;",
        "const descs: any = {}; descs['-1'] = dm1; descs['0'] = d0;",
        "Object.defineProperties(gAny, descs);",
        "console.log(Object.keys(gAny));",
      ].join("\n"),
    );
    expect(stdout).toBe("[ '0', '-1' ]\n");
  }
});

test("mustCall no-block pin, POSITIVE and NEGATIVE together (one test): hidden name/length render NOTHING while a sibling visible prop DOES", async () => {
  const { stdout, stderr } = await compileAndRun(
    [
      "function orig() {}",
      "const wrapper: any = orig;",
      "const dn: any = {}; dn.value = 'orig'; dn.enumerable = false;",
      "const dl: any = {}; dl.value = 0; dl.enumerable = false;",
      "const dv: any = {}; dv.value = 7; dv.enumerable = true;",
      "const descs: any = {}; descs.name = dn; descs.length = dl; descs.extra = dv;",
      "Object.defineProperties(wrapper, descs);",
      "console.log(wrapper);",
      "console.log(Object.keys(wrapper));",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("[Function: orig] { extra: 7 }\n[ 'extra' ]\n");
});

/* ── GATE FIX F-3 (rev-23) — the LOG renderer's FUNC property block
 * must feed base.length into Node's line-break arithmetic the way
 * cfValue already does. All Node-side expectations below are LIVE
 * measurements (node v24.18.1), not transcribed. */

const STRADDLE_PROPS = ["a", "b", "c", "d", "e"] as const;
function straddleDescsSrc(varName: string): string[] {
  const lines: string[] = [`const ${varName}: any = {};`];
  for (const k of STRADDLE_PROPS) {
    lines.push(`const d_${varName}_${k}: any = {}; d_${varName}_${k}.value = 'xxxxx'; d_${varName}_${k}.enumerable = true;`);
    lines.push(`${varName}.${k} = d_${varName}_${k};`);
  }
  return lines;
}

test("F-3 threshold-straddle, LOG: SAME 5-prop entry set is single-line on an OBJ receiver, multi-line on a FUNC receiver (the base.length omission this fix corrects)", async () => {
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "const o: any = {};",
        ...straddleDescsSrc("descs"),
        "Object.defineProperties(o, descs);",
        "console.log(o);",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("{ a: 'xxxxx', b: 'xxxxx', c: 'xxxxx', d: 'xxxxx', e: 'xxxxx' }\n");
  }
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "function g() {}",
        "const f: any = g;",
        ...straddleDescsSrc("descs"),
        "Object.defineProperties(f, descs);",
        "console.log(f);",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(stdout).toBe(
      "[Function: g] {\n  a: 'xxxxx',\n  b: 'xxxxx',\n  c: 'xxxxx',\n  d: 'xxxxx',\n  e: 'xxxxx'\n}\n",
    );
  }
});

test("F-3 regression guard, CF: the SAME 5-prop entry set — CF already breaks multi-line on BOTH receivers (unaffected by the LOG-only fix), byte-exact as it stood before", async () => {
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "import assert from 'node:assert';",
        "const o: any = {};",
        ...straddleDescsSrc("descs"),
        "Object.defineProperties(o, descs);",
        "assert.deepStrictEqual(o, {});",
      ].join("\n"),
      true,
    );
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "+ {\n+   a: 'xxxxx',\n+   b: 'xxxxx',\n+   c: 'xxxxx',\n+   d: 'xxxxx',\n+   e: 'xxxxx'\n+ }\n- {}",
    );
  }
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "import assert from 'node:assert';",
        "function g() {}",
        "const f: any = g;",
        ...straddleDescsSrc("descs"),
        "Object.defineProperties(f, descs);",
        "assert.deepStrictEqual(f, {});",
      ].join("\n"),
      true,
    );
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "+ [Function: g] {\n+   a: 'xxxxx',\n+   b: 'xxxxx',\n+   c: 'xxxxx',\n+   d: 'xxxxx',\n+   e: 'xxxxx'\n+ }\n- {}",
    );
  }
});

test("F-3 companion, CF-vs-LOG key order DIFFERENCE on one fixture: LOG uses JS insertion order (integer-like first), CF sorts — both correct today, the difference itself pinned", async () => {
  const descsSrc = [
    "const descs: any = {};",
    "const d2: any = {}; d2.value = 'v2'; d2.enumerable = true; descs['2'] = d2;",
    "const d1: any = {}; d1.value = 'v1'; d1.enumerable = true; descs['1'] = d1;",
    "const da: any = {}; da.value = 'vA'; da.enumerable = true; descs.a = da;",
    "const d01: any = {}; d01.value = 'v01'; d01.enumerable = true; descs['01'] = d01;",
    "const dm1: any = {}; dm1.value = 'vM1'; dm1.enumerable = true; descs['-1'] = dm1;",
  ];
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "function g() {}",
        "const f: any = g;",
        ...descsSrc,
        "Object.defineProperties(f, descs);",
        "console.log(Object.keys(f));",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("[ '1', '2', 'a', '01', '-1' ]\n");
  }
  {
    const { stdout, stderr } = await compileAndRun(
      [
        "import assert from 'node:assert';",
        "function g() {}",
        "const f: any = g;",
        ...descsSrc,
        "Object.defineProperties(f, descs);",
        "assert.deepStrictEqual(f, {});",
      ].join("\n"),
      true,
    );
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "+   '-1': 'vM1',\n+   '01': 'v01',\n+   '1': 'v1',\n+   '2': 'v2',\n+   a: 'vA'",
    );
  }
});
