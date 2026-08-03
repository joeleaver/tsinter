/* The wasm backend's differential: tier membership is AUTO-DISCOVERED by
 * attempting the wasm build on every corpus program, exactly like
 * llvm-differential.test.ts. A program the tier claims runs IN-PROCESS
 * through the abi.ts host contract (instantiate the .wasm, service its
 * `tsinter.write` import, drive `_start`) and must match the Node oracle
 * byte for byte; a program outside the tier must REFUSE loudly under the
 * `backend: "wasm"` pin — diagnostic SC3001 naming the first unsupported
 * IR construct, never wrong code.
 *
 * TWO DIFFERENCES from the LLVM suite, both structural:
 *
 * 1. There is no fallback lane to check. The wasm backend is an explicit
 *    pin only (its artifact is a .wasm module, not a native executable),
 *    so a refusal is always SC3001 and there is no "did the default lane
 *    land on C" half to assert.
 *
 * 2. The refusal histogram is not the whole work queue yet. While the
 *    tier is small most programs refuse at whatever the frontend emits
 *    FIRST, so the queue comes from the SURVEY (compile()'s `wasmSurvey`:
 *    every distinct construct a program needs, not just the first), and
 *    both histograms print at the end. As coverage lands the two
 *    converge, and the first-refusal histogram becomes the useful one —
 *    which is the signal that this comment can go.
 *
 * A wasm TRAP in a claimed program reports as exit code 1 — the
 * S003/S007 bridge: traps stand in for uncaught runtime errors (index
 * checks, empty pop, `throw`) until the exception protocol lands, and
 * Node exits 1 on an uncaught exception, so the comparison stays honest
 * through the @exit directive and the skipped nonzero-exit stderr. Any
 * NON-trap error (a host bug, a missing export) still fails the test as
 * the raised error itself. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@tsinter/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

// Same corpus and same SCRIPTC_TEST_SHARD slice as the other corpus lanes.
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = shardSelect(
  ENTRY_EXTS.flatMap((ext) => [
    ...globSync(join(corpusDir, `*.${ext}`)),
    ...globSync(join(corpusDir, `*/main.${ext}`)),
  ]).sort(),
  (f) => f.slice(corpusDir.length + 1),
);

// Same known-env contract as the other differential suites.
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

/** The tier floor: programs whose membership is pinned, so a regression
 * out of the tier fails the suite instead of quietly shrinking the
 * histogram. Auto-discovery may claim more; these regressing out is
 * always a bug. */
const TIER_FLOOR: string[] = [
  // Increment 1 (module prologue): hello world, and cross-module wiring
  // free of charge (module bindings flatten into %g. globals plus
  // per-file %init functions).
  "001-hello.ts",
  "2124-imports-field-wildcard/main.ts",
  // Increment 2 (scalars + control flow): comparisons, if/else chains,
  // switch dispatch, recursion, and the module-graph family whose
  // programs compute in scalars and print strings/bools.
  "102-comparisons.ts",
  "300-if-else.ts",
  "401-mutual-recursion.ts",
  "800-switch-basics.ts",
  "951-modules-diamond/main.ts",
  "1622-cjs-require-conditional/main.js",
  "1625-cjs-require-lazy-fn/main.js",
  "2121-esm-cycle-inert-backedge/main.ts",
  "2193-discarded-stdlib-reads.ts",
  "2605-cycle-three-module/main.ts",
  // Increment 3 (number→string): the Ryū claim wave — number formatting,
  // templates over numbers, loops that print, enums, IEEE corners (the
  // emitted fmod under corpus scrutiny), and the rest of the cjs/esm
  // module-graph family.
  "002-log-args.ts",
  "100-number-format.ts",
  "103-ternary.ts",
  "200-strings.ts",
  "201-templates.ts",
  "301-while.ts",
  "302-for.ts",
  "303-break-continue.ts",
  "305-truthiness.ts",
  "400-fib.ts",
  "402-string-functions.ts",
  "403-void-and-params.ts",
  "404-rc-stress.ts",
  "804-switch-braced-blocks.ts",
  "954-modules-reexport/main.ts",
  "1620-cjs-require-effects-order/main.js",
  "1621-cjs-require-cache-hit/main.js",
  "1623-cjs-require-diamond/main.js",
  "1624-cjs-require-dir-mid-file/main.js",
  "1626-cjs-require-mjs/main.js",
  "1627-mjs-import-cjs-requires/main.mjs",
  "1822-static-block-js.js",
  "1830-enum-numeric-basics.ts",
  "1891-ns-reexport/main.ts",
  "1968-namespace-import-eq-snapshot.ts",
  "2092-package-imports/main.ts",
  "2120-package-self-import/main.ts",
  "2260-http2-constants.cjs",
  "2382-cycle-two-decl/main.ts",
  "2384-cycle-mixed-bindings/main.ts",
  "2422-ieee-div-rem-corners.ts",
  "2426-default-snapshot-mutable/main.ts",
  "2617-enum-static-field-import/main.ts",
  // Increment 4 (arrays): the vector-struct representation and its core
  // intrinsic surface, plus the programs the array types unlock.
  "503-array-functions.ts",
  "511-array-indexof-includes.ts",
  "802-switch-loops.ts",
  "803-switch-rc-stress.ts",
  "963-generics-modules/main.ts",
  "1054-comptime-modules/main.ts",
  "1543-rest-destructuring.ts",
  // Increment 5 (closures + function values): captures through shared
  // boxes, per-iteration loop bindings, function identity, and the
  // programs those unlock (HOF desugars, class statics, namespaces).
  "600-closures-basic.ts",
  "601-closures-loops.ts",
  "602-closures-identity-recursion.ts",
  "750-cycle-closure-box.ts",
  "801-switch-lazy-tests.ts",
  "820-multi-decl.ts",
  "830-let-uninitialized.ts",
  "1050-comptime-tables.ts",
  "1596-cjs-modules/main.js",
  "1821-static-block-order.ts",
  "1943-class-statics-expanded.ts",
  "1960-namespace-basics.ts",
  "2021-generic-value-binding-modules/main.ts",
  "2390-dot-requires/main.cjs",
  // Increment 6 (records): struct-per-shape, tuples, accessor-slot
  // shapes, and the programs those unlock.
  "517-array-hof-index-args.ts",
  "751-cycle-records-mutual.ts",
  "901-records-eval-order.ts",
  "902-records-functions-closures.ts",
  "953-modules-default/main.ts",
  "960-generics-basics.ts",
  "1359-json-module/main.ts",
  "1450-incdec-expression.ts",
  "1537-chalk-hybrid/main.ts",
  "1824-for-of-destructuring-defaults.ts",
  "1964-namespace-type-only.ts",
  "2045-objlit-accessors-basic.ts",
  "2102-empty-pattern-decls.ts",
  "2551-generics-value-aliases.ts",
  "2555-generics-keyof-writes.ts",
  "2587-array-entries-forof.ts",
  // Increment 7 (unions): the shared-base tagged representation, unit-arm
  // singletons, per-union dispatch helpers (truthy/eq/toStr), nullish/
  // orDefault/optChain, unionDisc/unionKeyGet, pop/shift, insp.f64 — and
  // the claim wave those unlock: the union corpus family, the whole
  // narrowing-kill family (2392-2425), destructuring, union-element
  // arrays, recursive unions.
  "1366-union-equality.ts",
  "1367-destructuring.ts",
  "1368-constructor-functions.ts",
  "1370-spread.ts",
  "1372-loose-null-tests.ts",
  "1530-spread-override-completion.ts",
  "1532-union-shared-field-read.ts",
  "1536-destructuring-defaults.ts",
  "1549-array-isarray-unions.ts",
  "1553-truthy-hof-predicates.ts",
  "1676-func-array-surface.ts",
  "1853-overload-modules/main.ts",
  "2026-width-spread.ts",
  "2053-typeof-static-fold.ts",
  "2060-empty-tuple.ts",
  "2082-destructuring-assignment.ts",
  "2363-nullish-retag.ts",
  "2392-block-guard-alias-scope.ts",
  "2393-loop-exit-guard-narrow.ts",
  "2394-loop-narrow-containment.ts",
  "2395-while-cond-guard.ts",
  "2396-born-narrowed-decl.ts",
  "2397-branch-kill-merge.ts",
  "2398-switch-arm-kill.ts",
  "2399-reassign-kill-polarity.ts",
  "2400-kill-return-edge.ts",
  "2401-kill-break-staging.ts",
  "2402-labeled-break-kill.ts",
  "2403-kill-continue-backedge.ts",
  "2405-sibling-arm-narrow.ts",
  "2406-switch-clause-sibling-narrow.ts",
  "2407-infinite-loop-seal.ts",
  "2408-loop-terminality-reopen.ts",
  "2409-loop-body-return-not-terminal.ts",
  "2410-stacked-cases-terminality.ts",
  "2411-exhaustive-switch-terminality.ts",
  "2412-dowhile-guard-trailing-test.ts",
  "2413-dowhile-kill-renarrow.ts",
  "2414-dowhile-continue-kill.ts",
  "2415-dowhile-break-trailing-test.ts",
  "2418-wrapped-ternary-arms.ts",
  "2420-nullish-null-identity.ts",
  "2421-float-lane-inference.ts",
  "2423-param-null-reassign.ts",
  "2424-ternary-miss-first-narrowing.ts",
  "2425-elseif-head-exit-narrow.ts",
  "2442-union-literal-arm-widening.ts",
  "2443-union-literal-shadow-narrowing.ts",
  "2482-recursive-union-tree.ts",
  "2490-find-miss-null-compare.ts",
  "2492-loose-null-compare-unions.ts",
  "2493-switch-unit-cases.ts",
  "2494-no-arm-compare-effects.ts",
  "2530-object-destructuring-decl.ts",
  "2531-array-tuple-destructuring-decl.ts",
  "2536-destructuring-assign-nested.ts",
  "2541-destructuring-eval-order.ts",
  "501-array-push-pop.ts",
  "504-array-rc-stress.ts",
  "532-record-arrays-rc-stress.ts",
  "534-record-width-subtyping.ts",
  "535-object-statics.ts",
  "542-union-element-arrays.ts",
  "604-closures-for-of.ts",
  "961-generics-recursion.ts",
  "971-unions-switch.ts",
  "974-unions-modules/main.ts",
  "976-unions-null.ts",
  // Increment 8 (uncaught-throw-as-trap, S007): throw compiles to a trap
  // — an emitted program has no tryCatch, so every executed throw is
  // uncaught, and effect-free thrown values (error.new of literals) skip
  // evaluation so their out-of-tier construction can't refuse. Claims the
  // union retag/narrow backstop riders, the width-lift family, var
  // hoisting, the startup-crash pair (%main opens with the lowered
  // throw), and the invisible/poisoned cjs-esm tails.
  "1124-union-narrowed-retag.ts",
  "1535-union-param-defaults.ts",
  "1616-cjs-esm-lexer-invisible/main.mjs",
  "1618-cjs-esm-poisoned-tail/main.mjs",
  "1619-cjs-esm-reexport-invisible/main.mjs",
  "1837-var-undefined-hoisting.ts",
  "1838-var-modules/main.ts",
  "2024-width-array-elems.ts",
  "2025-width-union-compose.ts",
  "2030-width-nested.ts",
  "2122-import-refusal-crash/main.ts",
  "2123-ambient-import-crash/main.ts",
  "2615-nullish-field-record-binding.ts",
  "966-unions-retag-rc-stress.ts",
  // Increment 9 (string intrinsics): the UTF-16-exact method surface
  // direct over faithful (array i16) storage — everything but the
  // lre-backed case pair (strings.ts). The claim wave: the string corpus
  // family, string destructuring/for-of (cpAt), String.raw folds, and a
  // long tail of array/union/record/generics programs whose LAST refusal
  // was one string call.
  "104-ternary-empty-arrays.ts",
  "1051-comptime-strings.ts",
  "1053-comptime-json.ts",
  "1117-typeof-static-union.ts",
  "1364-union-truthiness.ts",
  "1365-union-logical.ts",
  "1371-union-template-tostring.ts",
  "140-bitwise-operators.ts",
  "1408-string-indexing.ts",
  "1432-destructured-params.ts",
  "1433-filter-narrow.ts",
  "1521-string-trim-pad-static.ts",
  "1533-bool-equality.ts",
  "1556-union-retag-width-arms.ts",
  "1561-forof-strings.ts",
  "1563-string-raw-fold.ts",
  "1564-string-raw.ts",
  "1851-overload-return-narrowing.ts",
  "1990-labels-basics.ts",
  "2087-destructuring-for-heads.ts",
  "210-string-methods.ts",
  "211-string-unicode.ts",
  "212-string-aliasing-append.ts",
  "2253-union-coercions.ts",
  "2419-selector-ternary-union.ts",
  "2491-strict-unit-compare-no-arm.ts",
  "2553-generics-signature-bindings.ts",
  "2556-crypto-introspection.ts",
  "2575-string-destructuring-decl.ts",
  "2576-string-destructuring-assign.ts",
  "2593-generic-inert-bindings.ts",
  "500-array-basics.ts",
  "502-array-for-of.ts",
  "510-array-map-filter-foreach.ts",
  "512-array-join-chains.ts",
  "513-array-methods-rc-stress.ts",
  "514-array-find-some-every.ts",
  "515-array-flatmap.ts",
  "603-closures-rc-stress.ts",
  "810-do-while.ts",
  "903-records-rc-stress.ts",
  "905-records-optional-rc-stress.ts",
  "962-generics-closures.ts",
  "964-generics-rc-stress.ts",
  "973-unions-rc-stress.ts",
  "975-unions-undefined.ts",
  "977-unions-unit-rc-stress.ts",
  // Increment 10 (exception protocol): pending-flag unwind — real
  // throw/catch/finally/rethrow, catch-binding snapshots with typeof and
  // builtin-error instanceof tests, TDZ ReferenceErrors, fences as
  // catchable Errors, error.new as an in-tier value. Claims the whole
  // exceptions corpus family plus the fence/throw riders.
  "1599-js-uncaught-throw.js",
  "1613-cjs-esm-proxy-named/main.mjs",
  "1835-var-basics.ts",
  "2404-kill-throw-catch.ts",
  "2588-array-entries-chains.ts",
  "980-exceptions-basics.ts",
  "982-exceptions-rc-stress.ts",
  "983-exceptions-control-flow.ts",
  "984-exceptions-finally.ts",
  "985-exceptions-call-chains.ts",
  "986-exceptions-uncaught.ts",
  "987-exceptions-result-unions.ts",
];

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** First TWO lines — a program can combine directives, one per line
 * (differential.test.ts's directiveHead). */
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 2);
}

function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

function wantsDynamic(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @dynamic\s*$/.test(l));
}

function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...ENTRY_EXTS.flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

/* ── the Node oracle (llvm-differential.test.ts's twin) ────────────────── */

const comptimeShim = pathToFileURL(join(import.meta.dirname, "comptime-shim.mjs")).href;
const islandShim = pathToFileURL(join(import.meta.dirname, "island-shim.mjs")).href;

/** The oracle runs with --experimental-transform-types for corpus programs
 * using non-erasable syntax — the `// @transform-types` directive
 * (namespaces) OR any enum declaration (strip-only mode refuses to parse
 * enums, no directive needed; a pure function of the program bytes). */
function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

/** `// @tsc-decorators`: decorators are the one supported construct Node
 * cannot execute at all, so the oracle runs tsc's deterministic ES2022
 * downlevel materialized under the test cache. */
function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

function nodeOracleFile(file: string): string {
  if (!wantsTscDecorators(file)) return file;
  const src = readFileSync(file, "utf8");
  const out = ts5.transpileModule(src, {
    compilerOptions: { target: ts5.ScriptTarget.ES2022, module: ts5.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const key = createHash("sha256").update(ts5.version).update("\0").update(src).digest("hex").slice(0, 16);
  const path = join(cacheDir, `dec-oracle-${key}.mjs`);
  mkdirSync(cacheDir, { recursive: true });
  // Atomic publish: concurrent suites write this same content-keyed path;
  // rename keeps readers from ever seeing a truncated oracle.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return path;
}

function wantsNoDeprecation(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l));
}

function nodeOracleArgs(file: string): string[] {
  const transform = wantsTransformTypes(file)
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
    : [];
  const nodep = wantsNoDeprecation(file) ? ["--no-deprecation"] : [];
  return [...transform, ...nodep, "--import", comptimeShim, "--import", islandShim, nodeOracleFile(file)];
}

/** Runs the oracle, tolerating an expected nonzero exit. The child's stdin
 * closes immediately: corpus programs may read fd 0 to EOF, and the
 * default open pipe would block both sides forever. */
async function runNode(file: string): Promise<RunResult> {
  const pending = execFileAsync("node", nodeOracleArgs(file), { encoding: "buffer" });
  pending.child.stdin?.end();
  try {
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) {
      throw err;
    }
    return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
  }
}

/* ── the wasm host ─────────────────────────────────────────────────────── */

/** The abi.ts contract's Node side: instantiate the module, service
 * `tsinter.write` by copying [ptr, ptr+len) out of the exported memory
 * into per-fd buffers, run `_start` to completion. In-process — a .wasm
 * needs no spawn, and the per-fd capture matches what the comparison
 * reads (cross-fd interleaving is not observable through separate
 * buffers on the Node side either). */
async function runWasm(modulePath: string): Promise<RunResult> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (fd !== 1 && fd !== 2) throw new Error(`write to unknown fd ${fd}`);
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  try {
    (instance.exports["_start"] as () => void)();
  } catch (err) {
    // A wasm TRAP is the tier's stand-in for an uncaught runtime error
    // (S003's index traps, until the exception protocol lands): Node
    // exits 1 on an uncaught exception, so a trap reports exit 1 with
    // whatever output preceded it. Comparison stays honest — the harness
    // skips the stderr compare for nonzero-exit programs, and any
    // OTHER error here (a bug in the host, a missing export) is not a
    // trap and still fails the test loudly.
    if (!(err instanceof WebAssembly.RuntimeError)) throw err;
    return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]), exitCode: 1 };
  }
  return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]), exitCode: 0 };
}

async function build(file: string) {
  const hash = createHash("sha256");
  for (const f of programInputs(file)) hash.update(f).update(readFileSync(f));
  const key = hash.update("wasm").update(wantsDynamic(file) ? "dyn" : "").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  return compile(file, {
    outPath: join(outDir, "program.wasm"),
    outDir,
    dynamic: wantsDynamic(file),
    backend: "wasm",
  });
}

// The two ledgers, summarized after the run: what the tier claims, the
// FIRST refusal per program (the loudness contract's census), and the
// SURVEY union (the actual work queue — see the header).
const claimed: string[] = [];
const refusalKinds = new Map<string, number>();
const refusalPrograms = new Map<string, string[]>();
const surveyKinds = new Map<string, number>();

describe(`wasm differential corpus (${files.length} programs${shardSuffix()})`, () => {
  test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
    "%s",
    async ([rel, file]) => {
      const res = await build(file);
      if (!res.ok) {
        // Out of tier: the refusal must be LOUD and must be THE refusal —
        // exactly one SC3001 naming the first unhandled construct. Any
        // other diagnostic here means a corpus program stopped compiling
        // at all, which the main differential suite forbids.
        expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
        const kind = /\(([^)]+)\)/.exec(res.diagnostics[0]!.message)?.[1] ?? "?";
        refusalKinds.set(kind, (refusalKinds.get(kind) ?? 0) + 1);
        refusalPrograms.set(kind, [...(refusalPrograms.get(kind) ?? []), rel]);
        // The survey rides every refusal — a program's whole construct
        // set, which is what makes the queue below a queue.
        expect(res.wasmSurvey).toBeDefined();
        for (const k of res.wasmSurvey!) surveyKinds.set(k, (surveyKinds.get(k) ?? 0) + 1);
        // The first refusal is always IN the survey: the two walks share
        // one dispatch, so a kind the emit path can produce and the
        // survey path cannot would mean they have drifted apart.
        expect(res.wasmSurvey).toContain(kind);
        return;
      }
      claimed.push(rel);
      expect(res.backend).toBe("wasm");
      // The module IS the artifact: no program TU beside it, no link.
      expect(res.binaryPath.endsWith(".wasm")).toBe(true);
      expect(res.cPath).toBe(res.binaryPath);

      // The claimed half of the contract: the module's output against the
      // Node oracle, byte for byte.
      const [wasm, node] = await Promise.all([runWasm(res.binaryPath), runNode(file)]);
      if (!wasm.stdout.equals(node.stdout)) {
        expect(wasm.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
        expect.unreachable("wasm-vs-node stdout differed at byte level but not after utf8 decode");
      }
      // stderr: the exit-0 contract of the main differential suite (a
      // nonzero-exit oracle's stderr carries Node stack traces no other
      // backend reproduces — but nothing that exits nonzero is claimable
      // yet anyway: throw and process.exit both still refuse).
      const expectedExit = expectedExitCode(file);
      if (expectedExit === 0 && !wasm.stderr.equals(node.stderr)) {
        expect(wasm.stderr.toString("utf8")).toBe(node.stderr.toString("utf8"));
        expect.unreachable("wasm-vs-node stderr differed at byte level but not after utf8 decode");
      }
      expect(wasm.exitCode).toBe(expectedExit);
      expect(node.exitCode).toBe(expectedExit);
    },
  );

  test("tier floor: pinned programs stay claimed", () => {
    // Under a shard, only the floor programs THIS slice ran can be
    // asserted (same key as the corpus split above); the shard union
    // covers the whole list.
    for (const name of shardSelect(TIER_FLOOR, (n) => n)) {
      expect(claimed, `${name} regressed out of the wasm tier`).toContain(name);
    }
  });

  afterAll(() => {
    const top = (m: Map<string, number>, n: number) =>
      [...m]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, n)
        .map(([k, c]) => `${k}×${c}`)
        .join(", ");
    /* eslint-disable no-console */
    console.info(
      `wasm tier: ${claimed.length}/${files.length} corpus programs claimed; ` +
        `first refusals: ${top(refusalKinds, 10)}`,
    );
    console.info(
      `wasm work queue (${surveyKinds.size} distinct constructs, by programs needing them): ${top(surveyKinds, 20)}`,
    );
    if (process.env["SCRIPTC_WASM_REFUSALS"] === "1") {
      console.info(`  claimed: ${[...claimed].sort().join(" ")}`);
      for (const [kind] of [...refusalKinds].sort((a, b) => b[1] - a[1])) {
        console.info(`  ${kind}: ${refusalPrograms.get(kind)!.join(" ")}`);
      }
    }
    /* eslint-enable no-console */
  });
});
