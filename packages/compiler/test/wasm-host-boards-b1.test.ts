/* INC-26 pass B1 (the "boards pass") — the boards forced-host rows for
 * #139 (nextTick-in-rejection-listener), #140 (promise identity / S076),
 * #141 (number.toString(radix) refusal), and #149 (Buffer.fill/compareBuf
 * validation). Same pattern as wasm-assert.test.ts: compile REAL
 * TypeScript through the actual frontend+backend, run it through the real
 * abi.ts host (wasm-host.ts), assert against values measured directly
 * against Node v24.18.1 (own probes, hashed under
 * inc26-work/inc26/impl-b1/probes/ — never transcribed from a brief).
 *
 * ROW VACUITY (P3/P4/P5's own retro rule, restated here): every row below
 * carries a "SINGLE-EDIT:" marker in its own title naming the one-line
 * mutation that would redden it, OR "SINGLE-EDIT: none, <reason>" for a
 * breadth/REFUSAL-shape/survey-set row with no single corresponding
 * mutation. Exactly ONE test in this file (the vacuity self-check) is
 * exempted, carrying the literal "VACUITY-ROW" token instead — checked by
 * name, never inferred from an absent colon. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-boards-b1-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
async function build(lines: string[], opts: { dynamic?: boolean } = {}) {
  const name = `p${seq++}.ts`;
  const entry = join(scratch, name);
  await writeFile(entry, `${lines.join("\n")}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    dynamic: opts.dynamic ?? false,
    backend: "wasm",
  });
  return res;
}
async function buildOk(lines: string[], opts: { dynamic?: boolean } = {}): Promise<string> {
  const res = await build(lines, opts);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message} (${res.diagnostics[0]?.code})`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

// A shared show()-style helper: catches, prints label + class/code/message
// or the successful result. Every test file inlines its own copy so each
// program stays a single, independently-compilable unit (matches 1602's
// own landed catch idiom — `catch (e)` with NO type annotation on the
// binding, which the tier supports; `e.constructor.name` does NOT compile
// (SC2020, Function.name has no lowering) so every row below reads
// `e.name` instead, exactly like the landed corpus).
const SHOW_HELPER = [
  "function show(label: string, fn: () => string): void {",
  "  try { console.log(label + ' => OK   ' + fn()); }",
  "  catch (e) {",
  "    if (e instanceof Error) {",
  "      const code = (e as NodeJS.ErrnoException).code ?? '-';",
  "      console.log(label + ' => ' + e.name + ' [' + code + '] ' + e.message);",
  "    } else { console.log(label + ' => (non-Error thrown)'); }",
  "  }",
  "}",
];
const MK_BUF = "const mk = () => Buffer.from([1,2,3,4,5,6,7,8]);";

describe("board #149: Buffer.fill/fillNum/fillStr/compareBuf — every row measured against a hashed Node v24.18.1 oracle", () => {
  test("fill(string, 0, len) — plain in-range fill — SINGLE-EDIT: none, the positive-control baseline row", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill('a',0,8).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe("fill => OK   6161616161616161");
  });

  test("fill(string, 0, end>len) — RangeError naming \"end\", bound <= the buffer length — SINGLE-EDIT: the fillCore 'end' validateOff call's max-bound operand (LENI) swapped for a different local", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill('a',0,9).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe(
      'fill => RangeError [ERR_OUT_OF_RANGE] The value of "end" is out of range. It must be >= 0 && <= 8. Received 9',
    );
  });

  test("TWO-CALL ROW, call A: fill(num, start>len, WITH an explicit end) throws naming \"end\" — Node checks end BEFORE start — SINGLE-EDIT: the fillCore 'end' validateOff call removed (M-7's target)", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill('a',9,10).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe(
      'fill => RangeError [ERR_OUT_OF_RANGE] The value of "end" is out of range. It must be >= 0 && <= 8. Received 10',
    );
  });

  test("TWO-CALL ROW, call B: fill(num, SAME start>len, NO end) is a SILENT NO-OP — the 'end' validateOff call never runs when nargs<2 (END defaults to the buffer length), so this row observes an axis call A cannot — SINGLE-EDIT: the fillCore nargs<2 branch's END default changed from LENI to something start can beat", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill(0x41,9).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe("fill => OK   0102030405060708");
  });

  test("fill(string, start>end, both in range) — silent no-op (Node never throws for start>end alone) — SINGLE-EDIT: none, breadth row for the offset<end gate", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill('a',6,2).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe("fill => OK   0102030405060708");
  });

  test("fill(string, negative start) — RangeError naming \"offset\", bound <= 9007199254740991 (Number.MAX_SAFE_INTEGER) — SINGLE-EDIT: the fillCore 'offset' validateOff call's max-bound literal changed from 9007199254740991", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill('a',-1,4).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe(
      'fill => RangeError [ERR_OUT_OF_RANGE] The value of "offset" is out of range. It must be >= 0 && <= 9007199254740991. Received -1',
    );
  });

  test("fill(string, non-integer start) — RangeError naming \"offset\", 'must be an integer' — SINGLE-EDIT: none, breadth row for validateOff's integer check", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill('a',1.5,4).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe(
      'fill => RangeError [ERR_OUT_OF_RANGE] The value of "offset" is out of range. It must be an integer. Received 1.5',
    );
  });

  test("fill(\"\", 0, len) — an EMPTY STRING pattern ZERO-FILLS (never a TypeError) — SINGLE-EDIT: the fillCoreHelper 'lenient' zeroOk branch's i32Eqz check inverted", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill('',0,8).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe("fill => OK   0000000000000000");
  });

  test("fill(Buffer.alloc(0)) — an EMPTY BUFFER pattern throws TypeError ERR_INVALID_ARG_VALUE (the 'strict' zeroOk=false arm — distinct from the empty-STRING row above, which is 'lenient') — SINGLE-EDIT: fillCoreHelper's zeroOk parameter swapped at fill's own call site (false -> true)", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fill', () => mk().fill(Buffer.alloc(0)).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe(
      "fill => TypeError [ERR_INVALID_ARG_VALUE] The argument 'value' is invalid. Received <Buffer >",
    );
  });

  test("fillNum(257) — wraps MOD 256 (never a RangeError on the value itself) — SINGLE-EDIT: none, breadth row for the numeric-fill element-write coercion", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fillNum', () => mk().fill(257,0,8).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe("fillNum => OK   0101010101010101");
  });

  test("fillNum(-1) — wraps MOD 256 to 0xff — SINGLE-EDIT: none, breadth row (negative side of the same wrap)", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('fillNum', () => mk().fill(-1,0,8).toString('hex'));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe("fillNum => OK   ffffffffffffffff");
  });

  test("compareBuf(target, tStart>tEnd) — answers 1, never throws (an empty target slice sorts before source) — SINGLE-EDIT: none, breadth row for compareBuf's start>end gate", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('compare', () => String(mk().compare(mk(),4,2)));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe("compare => OK   1");
  });

  test("compareBuf(target, tEnd>len) — RangeError naming \"targetEnd\" — SINGLE-EDIT: none, breadth row proving compareBuf's OWN validateOff calls use compareBuf's own parameter names, not fillCore's", async () => {
    const path = await buildOk([
      MK_BUF,
      ...SHOW_HELPER,
      "show('compare', () => String(mk().compare(mk(),0,9)));",
    ]);
    const { stdout } = await runWasm(path);
    expect(stdout.trim()).toBe(
      'compare => RangeError [ERR_OUT_OF_RANGE] The value of "targetEnd" is out of range. It must be >= 0 && <= 8. Received 9',
    );
  });
});

// board #141 — number.toString(radix): B1 does NOT build a static arm
// (P6-J5): the deliverable is (i) a pinned refusal row (SC2012's code AND
// hint text, all four forms) under a static build, and its acceptance
// under --dynamic; (ii) Node's oracle, committed as a hashed probe
// (inc26-work/inc26/rev27/probes/b1/141-toradix.out, re-verified
// byte-identical against a fresh `node v24.18.1` run this session — the
// spec the later cross-lane unit is held to). The board stays OPEN.
const RADIX_HINT =
  "build with --dynamic to run this call in the embedded engine (adds ~620KB to the binary); static builds never include it";
const RADIX_FORMS: { label: string; lines: string[] }[] = [
  { label: "literal-receiver", lines: ["console.log((255).toString(16));"] },
  { label: "number-local", lines: ["const n = 255;", "console.log(n.toString(16));"] },
  { label: "charCodeAt-result", lines: ["console.log('A'.charCodeAt(0).toString(16));"] },
  {
    label: "number-parameter",
    lines: ["function f(n: number): string { return n.toString(16); }", "console.log(f(255));"],
  },
];

describe("board #141: number.toString(radix) refuses SC2012 under a static build (all four forms, identical code+hint), and all four compile under --dynamic", () => {
  for (const form of RADIX_FORMS) {
    test(`${form.label} — static: SC2012 with the generic dynamic-engine hint (never surfaces.ts's OWN radix hint, which is dead for this construct — R-4) — SINGLE-EDIT: none, the four-form uniformity row`, async () => {
      const res = await build(form.lines, { dynamic: false });
      expect(res.ok, `expected a refusal for ${form.label}, got OK`).toBe(false);
      if (res.ok) return;
      expect(res.diagnostics[0]?.code).toBe("SC2012");
      expect(res.diagnostics[0]?.message).toBe(
        "'.toString()' on numbers runs in the embedded dynamic engine, which this build does not include",
      );
      expect(res.diagnostics[0]?.hint).toBe(RADIX_HINT);
    });
    test(`${form.label} — --dynamic: compiles clean (no static arm needed; the island engine serves it) — SINGLE-EDIT: none, the four-form uniformity row`, async () => {
      const path = await buildOk(form.lines, { dynamic: true });
      expect(typeof path).toBe("string");
    });
  }
});

// board #139 — emitCheckpointCore's fixed-point restructure (design-139-v2,
// delta-06/-07). Every row's expected text is from a hashed Node v24.18.1
// oracle, re-run from a durable source before this file was written
// (impl-b1/design-139-probes/r139-node-oracle.log,
// r139-rerun-from-sealed-sources.log, r139-post-build-verification.log);
// R139-e's oracle is rev-27's (rev27/probes/b1/139e-reentrancy.cjs /
// -micro.cjs), cited per delta-07 §B.
describe("board #139: emitCheckpointCore drains a fixed point — a listener-queued tick or microtask is never dropped, with no timer surface", () => {
  test("R139-a: listener queues nextTick(cb), NO timer surface (the board's own repro) — SINGLE-EDIT: none, MEASURED under M-1 (the loop term removed): this row does NOT redden, because the newly-queued tick's OWN queue-head global already flips non-null during dispatch, so the loop's UNMUTATED tick-queue check alone re-triggers the next iteration — this row has no single corresponding mutation; its green rests on the Node oracle", async () => {
    const path = await buildOk([
      'process.on("unhandledRejection", (reason, promise) => {',
      '  console.log("listener fired, reason=" + String(reason));',
      '  process.nextTick(() => { console.log("TICK-FROM-LISTENER RAN"); });',
      '  console.log("listener returned after queueing the tick");',
      "});",
      'Promise.reject(new Error("boom"));',
      'console.log("main body done");',
      'process.on("exit", (c) => { console.log("exit listener, code=" + c); });',
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe(
      "main body done\nlistener fired, reason=Error: boom\nlistener returned after queueing the tick\nTICK-FROM-LISTENER RAN\nexit listener, code=0\n",
    );
    expect(exitCode).toBe(0);
  });

  test("R139-b: listener queues ONLY .then(cb), no nextTick anywhere, NO timer surface (the no-ticks branch's own hole) — SINGLE-EDIT: emitCheckpointCore's no-ticks-branch gated loop's brIf dropped (falls back to the straight-line shape)", async () => {
    const path = await buildOk([
      'process.on("unhandledRejection", (reason, promise) => {',
      '  console.log("L " + String(reason));',
      '  Promise.resolve().then(() => { console.log("MICRO"); });',
      "});",
      'Promise.reject(new Error("x"));',
      'console.log("main body done");',
      'process.on("exit", (c) => { console.log("end " + c); });',
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe("main body done\nL Error: x\nMICRO\nend 0\n");
    expect(exitCode).toBe(0);
  });

  test("R139-c: listener queues BOTH nextTick and .then — ORDER (tick before microtask), NO timer surface — SINGLE-EDIT: none, the steady-state-order breadth row", async () => {
    const path = await buildOk([
      'process.on("unhandledRejection", (reason, promise) => {',
      '  console.log("L " + String(reason));',
      '  process.nextTick(() => { console.log("TICK"); });',
      '  Promise.resolve().then(() => { console.log("MICRO"); });',
      "});",
      'Promise.reject(new Error("x"));',
      'console.log("main body done");',
      'process.on("exit", (c) => { console.log("end " + c); });',
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe("main body done\nL Error: x\nTICK\nMICRO\nend 0\n");
    expect(exitCode).toBe(0);
  });

  test("R139-d: a rejectionHandled listener queues a tick — NO timer surface (the late handler attaches from a nextTick queued by the unhandledRejection listener, onto the ORIGINAL promise via closure capture, never setImmediate — an immediate surface is one of the surfaces that masks this bug, N-1) — SINGLE-EDIT: none, MEASURED under M-1: does NOT redden, same reason as R139-a (the queued tick's own queue-head flips the UNMUTATED tick-queue check); this row's value is proving the SECOND listener path (rejectionHandled) reaches the same fixed-point machinery as the first, not distinguishing the loop term from the tick-queue check", async () => {
    const path = await buildOk([
      'const p = Promise.reject(new Error("x"));',
      'process.on("unhandledRejection", (reason) => {',
      '  console.log("UR " + String(reason));',
      '  process.nextTick(() => { p.catch(() => { console.log("caught"); }); });',
      "});",
      'process.on("rejectionHandled", () => {',
      '  console.log("RH");',
      '  process.nextTick(() => { console.log("TICK"); });',
      "});",
      'console.log("main body done");',
      'process.on("exit", (c) => console.log("end " + c));',
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe("main body done\nUR Error: x\ncaught\nRH\nTICK\nend 0\n");
    expect(exitCode).toBe(0);
  });

  test("R139-e: RE-ENTRANCY — a listener's queued tick rejects ANOTHER promise nobody handles, NO timer surface (rev-27's oracle, 139e-reentrancy.cjs) — SINGLE-EDIT: none, MEASURED under M-1: does NOT redden, same reason as R139-a/-d (the tick queue's own head check re-triggers the loop regardless of the invoked term); this row's value is proving the loop is a genuine unbounded fixed point (L2 fires, not just L1) rather than distinguishing the loop term specifically — a manually-unrolled 'loop at most twice' implementation would still pass THIS mutation's own axis but fail the open-item-3 discipline check", async () => {
    const path = await buildOk([
      "let fired = 0;",
      'process.on("unhandledRejection", (reason, promise) => {',
      "  fired++;",
      '  console.log("L" + fired + " " + String(reason));',
      "  if (fired === 1) {",
      "    process.nextTick(() => {",
      '      console.log("TICK-FROM-L1");',
      '      Promise.reject(new Error("second"));',
      "    });",
      "  }",
      "});",
      'Promise.reject(new Error("first"));',
      'console.log("main body done");',
      'process.on("exit", (c) => { console.log("end " + c); });',
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe("main body done\nL1 Error: first\nTICK-FROM-L1\nL2 Error: second\nend 0\n");
    expect(exitCode).toBe(0);
  });

  test("R139-f: a listener-free program's emitted-module hash is BYTE-IDENTICAL whether or not board #139's fixed-point machinery exists in the compiler (both shapes: hasProms-only, and hasTicks+hasProms) — SINGLE-EDIT: settle()'s ledger-generation-counter increment gated on deps.needsListenerLoopTerm() removed (made unconditional)", async () => {
    const { createHash } = await import("node:crypto");
    const pathA = await buildOk([
      'Promise.reject(new Error("x")).catch(() => { console.log("caught"); });',
      'console.log("done");',
    ]);
    const pathB = await buildOk([
      'process.nextTick(() => { console.log("tick"); });',
      'Promise.reject(new Error("x")).catch(() => { console.log("caught"); });',
      'console.log("done");',
    ]);
    const hashA = createHash("sha256").update(readFileSync(pathA)).digest("hex");
    const hashB = createHash("sha256").update(readFileSync(pathB)).digest("hex");
    expect(hashA).toBe("788640486a92bbd2305c29f1a87e08ca402dc070da81c392a517639797d583fd");
    expect(hashB).toBe("5358571f89ac34cfd3e9c2214a54d2685dd9fac83ed0021f900c516d84ed8ddc");
  });

  // R139-g's oracle: rev-27's probe, rev27/probes/b1/139g-two-function-timer.cjs
  // (sha256 fc4b9d493a391a5e0ccba08803afa53abd1c039db864f5ee55acb429d0b883d3),
  // independently re-run against Node v24.18.1 and logged at
  // impl-b1/design-139-probes/r139g-rev27-oracle-independent-run.log (exit
  // 0). Walk order is KNOWN, not assumed: lowerer.ts's `run()` pushes each
  // top-level `function` declaration into the module's `functions` array
  // by iterating `fp.fnDecls` in FILE ORDER, and emitter.ts's own walk
  // consumes that same array in order — so `funcA` (declared first) is
  // WALKED before `funcB` (declared second).
  test("R139-g: CORRECTNESS ROW, NOT AN INSTRUMENT — timer surface PRESENT by design (funcA, walked FIRST, arms a setTimeout; funcB, walked LATER, is the ONLY process.nextTick call) — asserts the tick-before-timer ORDER against Node, the only timer-ful row in this file; NOT a widening probe: rev-27's proof (findings-rev27-r139g-b1.txt) plus this pass's own measurement showed the eager-touch widening's user-walk-order target structurally unreachable (emitFirstCheckpoint/tick() are each requested from one call site, both strictly after the whole-module walk loop completes, so hasTicks is already final either way) — the widening's OTHER four-disjunct form was WITHDRAWN from emitter.ts for that reason, and M-1b (aimed at it) is WITHDRAWN with it, not a null result — SINGLE-EDIT: none, this row has no single corresponding mutation; it survives as a breadth/correctness check on the fixed-point loop's ORDER guarantee in a timer-ful module", async () => {
    const path = await buildOk([
      "function funcA() {",
      '  setTimeout(() => { console.log("TIMER"); }, 0);',
      "}",
      "function funcB() {",
      '  process.nextTick(() => { console.log("TICK"); });',
      "}",
      "funcA();",
      "funcB();",
      'console.log("main body done");',
      'process.on("exit", (c) => { console.log("end " + c); });',
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe("main body done\nTICK\nTIMER\nend 0\n");
    expect(exitCode).toBe(0);
  });
});

// board #140 — promise identity across the dyn boundary for
// unhandledRejection/rejectionHandled listener arguments (SEMANTICS.md
// S076, RETIRED by this board). Expected text from a hashed Node v24.18.1
// oracle (impl-b1/design-140-probes/140-identity-verify.log).
describe("board #140: the unhandledRejection/rejectionHandled listener 'promise' argument preserves identity (DK.PROMISE boxing over the real ref, dyn.strictEq's existing arm) — S076 RETIRED", () => {
  test("O2: rejectionHandled's argument === unhandledRejection's argument for the SAME underlying promise (the SHARPEST of the four lost observables — the documented WeakMap-keyed idiom) — SINGLE-EDIT: fireRejectionHandled's DK.PROMISE construction reverted to dyn.boxObj(pushNewObj) (a fresh generic object, S076's original shape)", async () => {
    const path = await buildOk([
      'const p = Promise.reject(new Error("x"));',
      "let firstArg: unknown = null;",
      'process.on("unhandledRejection", (reason, promise) => {',
      "  firstArg = promise;",
      '  process.nextTick(() => { p.catch(() => { console.log("caught"); }); });',
      "});",
      'process.on("rejectionHandled", (promise) => {',
      '  console.log("O2 rejectionHandled arg === unhandledRejection arg:", promise === firstArg);',
      "});",
      'console.log("main body done");',
      'process.on("exit", (c) => console.log("end", c));',
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe(
      "main body done\ncaught\nO2 rejectionHandled arg === unhandledRejection arg: true\nend 0\n",
    );
    expect(exitCode).toBe(0);
  });

  test("O1/O3 (via the restored FIFO-order mechanism): TWO DIFFERENT promises' unhandledRejection arguments are distinguishable from EACH OTHER (never mutually ===) — the same array-membership idiom Map/WeakMap/Set keying reduces to — SINGLE-EDIT: dispatchOrReport's DK.PROMISE construction reverted to a fresh generic object", async () => {
    const path = await buildOk([
      "const seen: unknown[] = [];",
      'process.on("unhandledRejection", (reason, promise) => { seen.push(promise); });',
      "async function doomedA(): Promise<void> { throw new Error(\"A\"); }",
      "async function doomedB(): Promise<void> { throw new Error(\"B\"); }",
      "doomedA();",
      "doomedB();",
      'process.on("exit", (c) => {',
      '  console.log("distinct:", seen.length === 2 && seen[0] !== seen[1]);',
      '  console.log("each self-identical:", seen[0] === seen[0] && seen[1] === seen[1]);',
      "});",
    ]);
    const { stdout, exitCode } = await runWasm(path);
    expect(stdout).toBe("distinct: true\neach self-identical: true\n");
    expect(exitCode).toBe(0);
  });

  test("observable 4 (p instanceof Promise) is UNCHANGED by this board — a SEPARATE, pre-existing tier limitation (SC1090, no class-graph representation for Promise), not fixed and not this board's to fix — SINGLE-EDIT: none, a REFUSAL-shape control documenting the boundary of this fix", async () => {
    const res = await build([
      'process.on("unhandledRejection", (reason, promise) => {',
      "  console.log(promise instanceof Promise);",
      "});",
      'Promise.reject(new Error("x"));',
    ]);
    expect(res.ok, "expected a refusal (observable 4 stays unposeable)").toBe(false);
    if (res.ok) return;
    expect(res.diagnostics[0]?.code).toBe("SC1090");
  });
});

describe("wasm-host-boards-b1: ROW VACUITY, asserted (P3/P4/P5's own retro rule)", () => {
  test("VACUITY-ROW — the marker count equals this file's own test count, minus the named controls (every breadth/REFUSAL-shape row is itself a named control, carrying its own explicit marker text naming 'none' plus a reason — never silently exempted); THIS row is the ONE test exempted from carrying either the marker or a 'none' reason, and its exemption is checked by name (the literal token 'VACUITY-ROW' in this title), never inferred from an absent colon — a row without a marker AND without the token is not a row", async () => {
    const src = readFileSync(import.meta.filename, "utf8");
    const rowsWithMarker = (src.match(/^\s*test\(.*SINGLE-EDIT:/gm) ?? []).length;
    const vacuityRows = (src.match(/^\s*test\("VACUITY-ROW/gm) ?? []).length;
    const testCount = (src.match(/^\s*test\(/gm) ?? []).length;
    expect(vacuityRows, `expected exactly 1 row carrying the VACUITY-ROW token (this row itself), found ${vacuityRows}`).toBe(1);
    expect(
      rowsWithMarker,
      `${rowsWithMarker} rows carry the SINGLE-EDIT marker vs ${testCount} test() calls total (expect exactly one test — the VACUITY-ROW one — without a marker)`,
    ).toBe(testCount - 1);
    expect(rowsWithMarker + vacuityRows, "SINGLE-EDIT rows + VACUITY-ROW rows must partition every test() in this file").toBe(
      testCount,
    );
  });
});
