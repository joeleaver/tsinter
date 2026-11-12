/* rea (tests/real-apps-top10) step 4: --npm-static attribution against the
 * BASE program. A large project's compile under --npm-static loads the
 * program several times; the last-resort phase loads it once more per
 * opted-in package typed by INFERENCE (no declared-surface view, S133:
 * "solo probes") and drops a package whose solo load adds type errors
 * (SC0001). Attribution compares diagnostics by identity against the base
 * program's (no package opted in): an error the base has too is the
 * program's own and drops nothing, and when every remaining error is the
 * base's, no probe runs.
 *
 * analyze() rows over two scratch packages written here (no .d.ts, so their
 * surfaces are inferred from the JS): `okpkg` types cleanly, `shapey`'s
 * inferred surface breaks the program's use of it. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { analyze } from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-npmbase-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PACKAGES: Record<string, string> = {
  okpkg: "export function twice(n) {\n  return n * 2;\n}\n",
  // Inferred: `pick(): string | number`, which the program assigns to a string.
  shapey: "export function pick(flag) {\n  return flag ? \"word\" : 7;\n}\n",
};

function project(name: string, main: string): string {
  const dir = join(scratch, name);
  for (const [pkg, js] of Object.entries(PACKAGES)) {
    mkdirSync(join(dir, "node_modules", pkg), { recursive: true });
    writeFileSync(join(dir, "node_modules", pkg, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", type: "module", main: "index.js" }) + "\n");
    writeFileSync(join(dir, "node_modules", pkg, "index.js"), js);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module" }) + "\n");
  const entry = join(dir, "main.ts");
  writeFileSync(entry, main);
  return entry;
}

const BASE_ERROR = 'const wrong: number = "not a number";\nconsole.log(wrong);\n';
const OK_USE = 'import { twice } from "okpkg";\nconsole.log(twice(21));\n';
const SHAPEY_USE = 'import { pick } from "shapey";\nconst s: string = pick(true);\nconsole.log(s);\n';
const FALLBACK = "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase) — the package serves from the island instead";

describe("rea: --npm-static attribution against the base program", () => {
  test("NPMBASE-01 a package the program's own type error does not involve stays static", () => {
    const { coverage } = analyze(project("ok-base-error", OK_USE + BASE_ERROR), { npmStatic: ["okpkg"] });
    expect(coverage.npmStatic).toEqual([{ package: "okpkg", status: "static" }]);
    // The base program's own error still stops the build, by name.
    expect(coverage.diagnostics.some((d) => d.code === "SC0001" && /not assignable to type 'number'/.test(d.message))).toBe(true);
  }, 120_000);

  test("NPMBASE-02 a package whose inferred surface adds type errors falls back beside a base error", () => {
    const { coverage } = analyze(project("shapey-base-error", SHAPEY_USE + BASE_ERROR), { npmStatic: ["shapey"] });
    expect(coverage.npmStatic).toEqual([{ package: "shapey", status: "fallback", detail: FALLBACK }]);
  }, 120_000);

  test("NPMBASE-03 without a base error the attribution is unchanged", () => {
    const { coverage } = analyze(project("shapey-clean", SHAPEY_USE), { npmStatic: ["shapey"] });
    expect(coverage.npmStatic).toEqual([{ package: "shapey", status: "fallback", detail: FALLBACK }]);
  }, 120_000);
});
