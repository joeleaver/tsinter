import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, renderCoverage } from "@tsinter/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixture = (name: string) => join(repoRoot, "tests/coverage-fixtures", name);

function report(path: string, opts: { dynamic?: boolean } = {}): string {
  const { coverage } = analyze(path, opts);
  return renderCoverage({ ...coverage, file: coverage.file.replace(repoRoot + "/", "") });
}

test("mixed program: percentage and grouped blockers", async () => {
  await expect(report(fixture("mixed.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-mixed.txt",
  );
});

test("dynamic-capable blockers split from static rejections", async () => {
  // SC2010/SC2011/SC2012 sites group under "runs with --dynamic";
  // constructs no flag fixes stay under "blockers".
  await expect(report(fixture("dynamic-mix.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-dynamic-mix.txt",
  );
});

test("--dynamic analysis: island sites count as compiled-dynamically", async () => {
  // The same fixture analyzed as a --dynamic build: the island-capable
  // sites LOWER (splitting out of "compile statically" into "compile
  // dynamically") and only the flag-independent rejections remain
  // blockers — this report is the "distance to a working build" view.
  await expect(report(fixture("dynamic-mix.ts"), { dynamic: true })).toMatchFileSnapshot(
    "__snapshots__/coverage-dynamic-mix-dynamic.txt",
  );
});

test("unreached blockers report in their own group", async () => {
  // Bodies nothing on the entry path reaches lower only for analysis:
  // their blockers render dim, under "in unreached code" — and the same
  // program BUILDS (the differential dead-strip tests pin that side).
  await expect(report(fixture("unreached.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-unreached.txt",
  );
});

test("fully static program reports 100%", () => {
  const out = report(join(repoRoot, "tests/corpus/400-fib.ts"));
  expect(out).toContain("(100%)");
  expect(out).toContain("fully static");
});

test("fully static JavaScript program reports 100%", () => {
  const out = report(join(repoRoot, "tests/corpus/1590-js-unannotated.js"));
  expect(out).toContain("(100%)");
  expect(out).toContain("fully static");
});

test("JS inference gaps land where 'any' lands: SC2011 static, island dynamic", async () => {
  // The js-gap fixture's tsconfig turns noImplicitAny off, so the untyped
  // parameter types `any` — the static analysis reports the site as
  // dynamic-capable (SC2011) while the JSDoc-typed neighbor stays static.
  await expect(report(fixture("js-gap/gap.js"))).toMatchFileSnapshot(
    "__snapshots__/coverage-js-gap.txt",
  );
  await expect(report(fixture("js-gap/gap.js"), { dynamic: true })).toMatchFileSnapshot(
    "__snapshots__/coverage-js-gap-dynamic.txt",
  );
});

test("npm package sites attribute per package", async () => {
  // Every site of a package-declared value groups into one SC2013 line
  // naming the package ("values from the 'mathkit' package ..."), inside
  // the "runs with --dynamic" group — reusing the diagnostics fixture so
  // the two views of the same program stay in sync.
  await expect(report(join(repoRoot, "tests/diagnostics/npm-imports/main.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-npm-packages.txt",
  );
});

test("lazy edges inventory: unresolvable require()/import() targets mark as lazy traps", async () => {
  // The lazy-traps npm fixture builds (Node's per-kind edge semantics:
  // require fails at the call, import() at evaluation) — the coverage
  // table lists every blocked-but-lazy specifier with the lazy-trap
  // marker instead of reporting SC2030 blockers.
  await expect(
    report(join(repoRoot, "tests/fixtures/npm/cases/lazy-traps/main.ts"), { dynamic: true }),
  ).toMatchFileSnapshot("__snapshots__/coverage-npm-lazy-traps.txt");
});

test("lazy builtin edges mark in the builtins table, __require sites included", async () => {
  // The esbuild-require fixture routes external requires through the
  // bundle's __require helper — its literal call sites collect as require
  // edges, so the builtins table lists node:os/node:tty (shimmed) and
  // node:stream as a lazy trap (unshimmed, reached only by the
  // never-called require) without failing the build.
  await expect(
    report(join(repoRoot, "tests/fixtures/npm/cases/esbuild-require/main.ts"), { dynamic: true }),
  ).toMatchFileSnapshot("__snapshots__/coverage-npm-lazy-builtin.txt");
});

test("import fences no longer stop analysis: percentage plus module blockers", async () => {
  // The fenced module reports ONE grouped blocker (the import line plus
  // every use of its bindings carry the same message); the rest of the
  // program still counts. Lives in the node-types fixture: builtin
  // specifiers only RESOLVE (typecheck) with @types/node adopted — the
  // fallback world turns them into tsc errors, which stay fatal. The same
  // file must FAIL a build (compile() keeps preflight fatal).
  await expect(
    report(join(repoRoot, "tests/fixtures/node-types/import-fences.ts")),
  ).toMatchFileSnapshot("__snapshots__/coverage-import-fences.txt");
});

test("type errors block analysis", () => {
  const out = report(fixture("type-errors.ts"));
  expect(out).toContain("not analyzable");
  expect(out).toContain("1 TypeScript error");
});

test("type errors render the same code frame a build prints", () => {
  const { coverage, sourceTexts } = analyze(fixture("type-errors.ts"));
  const out = renderCoverage(coverage, { sourceTexts });
  expect(out).toContain("not analyzable");
  expect(out).toContain("error SC0001");
  // The frame gutter with the offending line, exactly the build renderer.
  expect(out).toMatch(/\d+ \| /);
  expect(out).toContain("^");
});

test("bare '.' and '..' imports are relative edges (the vercel-CLI dialect)", () => {
  // `from '..'` / `from '.'` resolve as directory imports to the target's
  // index module — exactly what the project's bundler-resolution checker
  // answered — so the graph loads and everything compiles statically.
  const out = report(fixture("dot-parent/main.ts"));
  expect(out).toContain("(100%)");
  expect(out).toContain("fully static");
});

test("a cycle whose top level calls a builtin with a builtin function value is admitted", () => {
  // vercel's link.ts cluster: `promisify(fs.readFile)` at a cycle member's
  // top level. Callee and callable argument are both dts-rooted — no user
  // code can run in the init window — so no SC1016 and the analysis
  // renders statement counts (the statement itself may stay a
  // statement-LEVEL blocker; that is a different fence).
  const out = report(fixture("cycle-inert-builtin/main.ts"));
  expect(out).not.toContain("circular imports");
  expect(out).toContain("statements analyzed");
});

test(`every corpus program is 100% static (corpus and coverage agree${shardSuffix()})`, async () => {
  // The differential corpus compiles by definition; coverage must agree.
  // `// @dynamic` programs compile under --dynamic, so analyze them that way.
  // The sweep runs minutes on slow machines and each analyze() blocks the
  // worker thread — without the periodic yield, vitest's worker RPC starves
  // ("Timeout calling onTaskUpdate") even while every check passes, and the
  // default per-test timeout is far too small for a whole-corpus analysis.
  let n = 0;
  const flatEntries = shardSelect(
    ["ts", "js", "mjs", "cjs"].flatMap((ext) =>
      globSync(join(repoRoot, `tests/corpus/*.${ext}`)),
    ).sort(),
    (file) => file.slice(repoRoot.length + 1),
  );
  for (const file of flatEntries) {
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    // `// @deferred-fences: N` on the first line: a JS program that
    // DELIBERATELY carries N runtime-fence statements on untaken paths
    // (the deferred-fence corpus) — it still passes the differential
    // oracle because the fences never execute.
    const deferred = /^\/\/ @deferred-fences:\s*(\d+)\s*$/.exec(firstLine);
    const { coverage } = analyze(file, { dynamic: /^\/\/ @dynamic\s*$/.test(firstLine) });
    expect.soft(coverage.diagnostics, file).toEqual([]);
    expect.soft(coverage.stats.statementsFailed, file).toBe(deferred ? Number(deferred[1]) : 0);
    if (++n % 10 === 0) await new Promise((r) => setImmediate(r));
  }
}, 600_000);
