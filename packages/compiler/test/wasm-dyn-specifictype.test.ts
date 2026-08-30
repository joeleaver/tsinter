/* dyn.ts's specificType() — determineSpecificType (internal/errors.js)
 * ported verbatim, board #26/P2b's renderer for error.argTypeThrow's
 * "Received ..." tail. Two reachable frontend call sites exist today:
 * lower-stream.ts's pipeline()/finished() stage-arg ladders (2634, the
 * named claim) and lower-emitter.ts's EventEmitter.setMaxListeners
 * per-target validation — this file's own durable table-driven sweep,
 * one row per BUILT arm, each independently measured against a live
 * Node oracle (node v24.18.1) rather than transcribed from prose.
 * wasm-stream-pipeline.test.ts's own pattern: compile real source
 * through the actual frontend+backend, run it through the real abi.ts
 * host, compare against a live-Node-measured shape.
 *
 * The EventEmitter site only exists reachably through UNTYPED (.cjs)
 * source: the project's own vendored Node type declarations do not
 * expose EventEmitter.setMaxListeners's static per-target overload on
 * `typeof EventEmitter` at all (confirmed: any .ts source calling it
 * refuses to type-check before argument types even enter the picture),
 * matching 2634's/2570's own .cjs convention for out-of-typed-surface
 * constructs.
 *
 * HANDLE and JSVAL are unconstructible on this tier (no real source, JS
 * or TS, can produce one) — their row is a force-emission check for a
 * BARE `unreachable` trap (no name, code, or message; there is nothing
 * to grep), cause-pinned to the specificType() call via a sentinel
 * global (wasm-bytes-validate.test.ts's force-emission pattern:
 * DynBuilder built directly against ModuleBuilder, bypassing the
 * frontend, to reach a branch no lowering can). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";
import { VecBuilder } from "../src/backend/wasm/arrays.js";
import { Code } from "../src/backend/wasm/code.js";
import { DK, DynBuilder } from "../src/backend/wasm/dyn.js";
import { JsonBuilder } from "../src/backend/wasm/json.js";
import { F64, I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-specifictype-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, lines: string[]) {
  const entry = join(scratch, name);
  await writeFile(entry, `${lines.join("\n")}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  return res.binaryPath;
}

/** Every row below drives the SAME construct — a target provably not an
 * EventEmitter/EventTarget passed to the static per-target
 * setMaxListeners — so one call builds all of them in a single module,
 * matching Node's stdout line for line. */
async function buildTargetSweep(name: string, exprs: string[]) {
  const lines = [
    "'use strict';",
    "const { EventEmitter } = require('events');",
    "const show = (fn) => {",
    "  try { fn(); console.log('ok'); } catch (e) { console.log(`${e.name}|${e.code}|${e.message}`); }",
    "};",
    ...exprs.map((e) => `show(() => { EventEmitter.setMaxListeners(5, ${e}); });`),
  ];
  return build(name, lines);
}

test("specificType: NUM (general + the four specials) — byte-exact vs Node", async () => {
  const path = await buildTargetSweep("st-num.cjs", ["NaN", "-0", "0", "Infinity", "-Infinity", "3.5"]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type number (NaN)',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type number (-0)',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type number (0)',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type number (Infinity)',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type number (-Infinity)',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type number (3.5)',
      "",
    ].join("\n"),
  );
});

test("specificType: STR — short, >28-char truncation, and the embedded-quote JSON.stringify fallback (short + truncated)", async () => {
  const path = await buildTargetSweep("st-str.cjs", [
    "'abc'",
    "'this string is exactly thirty chars'",
    `"it's got a quote"`,
    `"it's a very very very long string past 28 chars"`,
    "''",
  ]);
  const { stdout } = await runWasm(path);
  // Node's own truncation: value.slice(0, 25) + "...", THEN the quote
  // check runs on that (possibly truncated) value — never the original.
  expect(stdout).toBe(
    [
      `TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type string ('abc')`,
      `TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type string ('this string is exactly th...')`,
      `TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type string ("it's got a quote")`,
      `TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type string ("it's a very very very lon...")`,
      `TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type string ('')`,
      "",
    ].join("\n"),
  );
});

test("specificType: BOOL, ARR, BYTES (Uint8Array) — byte-exact vs Node", async () => {
  const path = await buildTargetSweep("st-misc.cjs", [
    "true",
    "false",
    "[1, 2, 3]",
    "new Uint8Array([1, 2, 3])",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type boolean (true)',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received type boolean (false)',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received an instance of Array',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received an instance of Uint8Array',
      "",
    ].join("\n"),
  );
});

test("specificType: BYTES Buffer inherits S014/S037's known flag gap (renders Uint8Array, not Buffer — NOT a new divergence)", async () => {
  // Buffer.from() IS a real Buffer at runtime; Node says "an instance of
  // Buffer". This tier's BYTES_PAYLOAD_IS_BUFFER flag has no surviving
  // marker at this generic dynFrom crossing (SEMANTICS.md S014/S037,
  // registered LONG before this renderer existed) — specificType()'s own
  // BYTES arm reads the flag correctly (mirrors kindName()'s proven
  // Buffer/Uint8Array branch exactly), it just always sees `false` here,
  // inheriting the pre-existing gap rather than introducing a new one.
  const path = await buildTargetSweep("st-buffer.cjs", ["Buffer.from([1, 2, 3])"]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received an instance of Uint8Array\n',
  );
});

test("specificType: FUNC — declared, const-bound named expression (S020's alias approximation), inline anonymous arrow, IIFE-returned anonymous", async () => {
  const path = await build("st-func.cjs", [
    "'use strict';",
    "const { EventEmitter } = require('events');",
    "const show = (fn) => {",
    "  try { fn(); console.log('ok'); } catch (e) { console.log(`${e.name}|${e.code}|${e.message}`); }",
    "};",
    "function declaredFn() {}",
    "const constFnExpr = function namedExpr() {}",
    "const arrowConst = () => {};",
    "show(() => { EventEmitter.setMaxListeners(5, declaredFn); });",
    "show(() => { EventEmitter.setMaxListeners(5, constFnExpr); });",
    "show(() => { EventEmitter.setMaxListeners(5, arrowConst); });",
    "show(() => { EventEmitter.setMaxListeners(5, () => {}); });",
    "show(() => { EventEmitter.setMaxListeners(5, (function () { return function () {}; })()); });",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received function declaredFn',
      // Node's real answer here is "namedExpr" (the function EXPRESSION's
      // OWN creation-site name wins over the binding it is assigned to) —
      // this tier's jsFuncNameOf is a REFERENCE-SITE approximation
      // (SEMANTICS.md S020's registered "aliased binding reports the
      // alias" case), so it reports the BINDING name instead. Asserting
      // the ACTUAL (approximated) output here, not Node's, is the point:
      // this is the pre-existing, already-registered gap, not a fresh one.
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received function constFnExpr',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received function arrowConst',
      // An inline arrow argument and an IIFE's returned closure have no
      // binding at all — Node's own NamedEvaluation rule only fires for a
      // variable initializer or property assignment, so both are
      // genuinely anonymous in Node too (not an approximation here).
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received function ',
      'TypeError|ERR_INVALID_ARG_TYPE|The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received function ',
      "",
    ].join("\n"),
  );
});

/** HANDLE and JSVAL: unconstructible on this tier through any real
 * source (dynFrom refuses everything that could produce one before
 * argTypeThrow's libCall node is even built) — force-emitted directly
 * against a minimal DynBuilder, mirroring wasm-bytes-validate.test.ts's
 * pattern, to prove the trap fires rather than an approximation
 * silently standing in. specificType()'s HANDLE/JSVAL arm is a BARE
 * `unreachable` — no name, code, or message survives to the host; it is
 * the unconditional trap every other arm falls past, not a diagnosed
 * refusal. It never calls into ANY of these deps, so their behavior is
 * irrelevant; only their SHAPE needs to satisfy DynDeps (bytes-validate.
 * test.ts's own split: this file checks the trap fires, not what the
 * stubs compute). Cause-pinned rather than bare `toThrow`: a sentinel
 * global is set to 1 immediately before the specificType() call and
 * read back after the catch, so a pass proves execution reached THAT
 * call (not an earlier failure in the hand-built box or module setup)
 * and nothing after it in `run`'s body could have produced the trap. */
async function buildHandleJsvalTrap(kind: number): Promise<string> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const stub = (params: ValType[], results: ValType[], name: string, body: (c: Code) => void) => {
    const idx = mb.declareFunc(mb.funcType(params, results), name);
    const c = new Code();
    body(c);
    mb.setBody(idx, [], c.bytes());
    return idx;
  };
  const strEqFn = stub([strRef, strRef], [I32], "%stub.strEq", (c) => c.i32Const(1));
  const f64ToStrFn = stub([F64], [strRef], "%stub.f64ToStr", (c) => c.refNull(strType));
  const concatFn = stub([strRef, strRef], [strRef], "%stub.concat", (c) => c.localGet(0));
  const strSliceFn = stub([strRef, F64, F64], [strRef], "%stub.strSlice", (c) => c.localGet(0));
  const strIndexOfFn = stub([strRef, strRef, F64], [F64], "%stub.strIndexOf", (c) => c.f64Const(-1));
  const strMatchAtFn = stub([strRef, strRef, I32], [I32], "%stub.strMatchAt", (c) => c.i32Const(0));
  const strCpAtFn = stub([strRef, I32], [I32], "%stub.strCpAt", (c) => c.i32Const(0));
  // A no-arg, no-result stub covers every dep specificType()'s HANDLE/
  // JSVAL arm never touches (bytesLen/bytesGet/bytesSet/bytesToStrUtf8/
  // jsToNumber/arrPush/arrNewLen) — nothing calls these, so their real
  // signature is irrelevant, only that they're valid declared functions.
  const noopFn = stub([], [], "%stub.noop", () => {});
  const lit = (c: Code, _s: string): void => c.refNull(strType);

  const vecs = new VecBuilder(mb, { strEq: () => strEqFn, f64ToStr: () => f64ToStrFn, concat: () => concatFn, lit });
  const f64VecInfo = vecs.info("vec(f64)", F64, F64, "f64");

  const errT = mb.structType([
    { storage: I32, mutable: false },
    { storage: strRef, mutable: true },
    { storage: strRef, mutable: true },
    { storage: strRef, mutable: false },
  ]);
  const excKindG = mb.addGlobal(I32, true, (w) => {
    w.u8(0x41);
    w.sleb(0);
  });

  let dyn!: DynBuilder;
  let json!: JsonBuilder;
  dyn = new DynBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    strEq: () => strEqFn,
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    throwTypeError: (c, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    arrVec: () => f64VecInfo,
    arrPush: () => vecs.pushOne(f64VecInfo),
    arrNewLen: () => vecs.newLen(f64VecInfo),
    strCpAt: () => strCpAtFn,
    errT: () => errT,
    errName: () => 1,
    errMessage: () => 2,
    errCode: () => 3,
    throwError: (c, _cn, _n, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    excKind: () => excKindG,
    strCmpU16: () => strEqFn,
    strSlice: () => strSliceFn,
    strIndexOf: () => strIndexOfFn,
    strMatchAt: () => strMatchAtFn,
    bytesRefU8: () => strRef,
    bytesTypeU8: () => strType,
    bytesEquals: () => strEqFn,
    bytesLen: () => noopFn,
    bytesGet: () => noopFn,
    bytesSet: () => noopFn,
    bytesToStrUtf8: () => noopFn,
    jsToNumber: () => noopFn,
    jsonQuoteStr: () => json.quoteStr(),
    // Increment 23 P2a's own DynDeps additions — specificType()'s
    // HANDLE/JSVAL arm never reaches sameValueDyn/deepEqDyn, so only the
    // SHAPE needs to satisfy DynDeps, matching every other dep here.
    sameValueF64: () => noopFn,
    deqEnter: () => noopFn,
    deqLeave: () => noopFn,
  });
  json = new JsonBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    throwError: (c, _cn, _n, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    excKind: () => excKindG,
    clearExc: (c) => {
      c.i32Const(0);
      c.globalSet(excKindG);
    },
    newDynVec: (c) => {
      c.f64Const(0);
      c.call(vecs.newLen(f64VecInfo));
    },
    dyn: () => dyn,
    bytesRefU8: () => strRef,
    bytesGet: () => noopFn,
  });

  // The cause-pin: set to 1 immediately before the specificType() call,
  // read back after the catch. A pass requires BOTH the trap AND
  // sentinel === 1 — proving control reached the last instruction before
  // that call (ruling out the hand-built box or module setup as the
  // trap's source) with nothing after the call in `run`'s body that
  // could have produced it instead.
  const sentinelG = mb.addGlobal(I32, true, (w) => {
    w.u8(0x41);
    w.sleb(0);
  });

  // The forced HANDLE/JSVAL box, built by hand: `$dyn{kind, num:0, ref:
  // null}` — the SAME field order boxNum/boxBool/boxStr all use
  // (dyn.ts). -0x13 is `eq`'s own s33 heap-type encoding (dyn.ts's own
  // EQ_HEAP, a wasm-gc spec constant, not an implementation detail).
  const runIdx = mb.declareFunc(mb.funcType([], []), "run");
  const c = new Code();
  c.i32Const(kind);
  c.f64Const(0);
  c.refNull(-0x13);
  c.structNew(dyn.dynT());
  c.i32Const(1);
  c.globalSet(sentinelG);
  c.call(dyn.specificType());
  c.drop();
  mb.setBody(runIdx, [], c.bytes());
  mb.exportFunc("run", runIdx);

  const sentinelIdx = mb.declareFunc(mb.funcType([], [I32]), "sentinel");
  const sc = new Code();
  sc.globalGet(sentinelG);
  mb.setBody(sentinelIdx, [], sc.bytes());
  mb.exportFunc("sentinel", sentinelIdx);

  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const path = join(scratch, `handle-jsval-${kind}.wasm`);
  await writeFile(path, bytes);
  return path;
}

test("specificType: HANDLE hits a bare unreachable trap (unconstructible on this tier — no approximation), cause-pinned to the specificType() call", async () => {
  const path = await buildHandleJsvalTrap(DK.HANDLE);
  const { instance } = await WebAssembly.instantiate(readFileSync(path));
  const run = instance.exports["run"] as () => void;
  const sentinel = instance.exports["sentinel"] as () => number;
  expect(() => run()).toThrow(WebAssembly.RuntimeError);
  expect(sentinel()).toBe(1);
});

test("specificType: JSVAL hits a bare unreachable trap (unconstructible on this tier — no approximation), cause-pinned to the specificType() call", async () => {
  const path = await buildHandleJsvalTrap(DK.JSVAL);
  const { instance } = await WebAssembly.instantiate(readFileSync(path));
  const run = instance.exports["run"] as () => void;
  const sentinel = instance.exports["sentinel"] as () => number;
  expect(() => run()).toThrow(WebAssembly.RuntimeError);
  expect(sentinel()).toBe(1);
});
