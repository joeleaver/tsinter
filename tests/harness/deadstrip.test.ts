/* Reachability's build contract — scriptc-only, deliberately NOT
 * differential:
 *
 * - The dead-strip side (a program importing a module whose UNUSED exports
 *   hold rejected constructs must build and run) is covered differentially
 *   by tests/corpus/420-dead-strip-modules. Here the same program's emitted
 *   C is grepped: an unreached body leaves NO trace — no function, no async
 *   spawn wrapper, no generic instance.
 * - The failure side cannot be differential (Node runs the "reached"
 *   variants fine): the SAME constructs, reached, must fail the build with
 *   exactly the diagnostics they always produced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("unreached bodies leave no trace in the emitted C", async () => {
  const outDir = join(cacheDir, `deadstrip-c${sanitize ? "-san" : ""}`);
  const result = await compile(join(repoRoot, "tests/corpus/420-dead-strip-modules/main.ts"), {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    // Pinned: this test greps the emitted C for reached/unreached names —
    // it measures the C backend's artifact by design.
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  const c = readFileSync(result.cPath, "utf8");
  // Reached bodies are there (mangled names embed the source name)...
  for (const reached of ["used", "double", "evenSteps", "oddSteps", "usedMethod", "tag"]) {
    expect(c, `expected reached '${reached}' in the emitted C`).toContain(reached);
  }
  // ...unreached ones are not: no function body, no async spawn wrapper or
  // trampoline (unusedAsync), no monomorphized instance (unusedGeneric),
  // no vtable slot or method function (unusedMethod).
  for (const gone of [
    "unusedForIn",
    "unusedAsync",
    "unusedComptime",
    "unusedGeneric",
    "unusedMethod",
  ]) {
    expect(c, `unreached '${gone}' must leave no trace in the emitted C`).not.toContain(gone);
  }
});

/** Compiles an in-repo fixture and returns its diagnostics codes+messages.
 * Deliberately NO backend pin: every program here fails during lowering,
 * before any backend runs — the default is irrelevant by construction, and
 * pinning would claim otherwise. */
async function diagnosticsOf(file: string): Promise<string[]> {
  const outDir = join(cacheDir, "deadstrip-reached");
  const result = await compile(join(repoRoot, file), {
    outPath: join(outDir, "never"),
    outDir,
  });
  if (result.ok) throw new Error(`${file} compiled but must fail`);
  return result.diagnostics.map((d) => `${d.code}: ${d.message}`);
}

describe("the same constructs, reached, fail exactly as before", () => {
  test("a reached class-instance for-in fails the build", async () => {
    const diags = await diagnosticsOf("tests/deadstrip/reached-for-in.ts");
    expect(diags).toEqual([
      "SC1052: for-in over class instances (which keys exist on an instance depends on runtime property creation the class model does not track — for-in over records and arrays compiles) are not supported yet",
    ]);
  });

  test("a reached comptime throw fails at compile time", async () => {
    const diags = await diagnosticsOf("tests/deadstrip/reached-comptime-throw.ts");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain("SC1110");
    expect(diags[0]).toContain("the callback threw");
  });
});
