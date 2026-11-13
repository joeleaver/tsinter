/* The full stat record's refusals by name (the values themselves are
 * corpus program tests/corpus/2949-fs-bigint-stats.ts, Node-differential
 * on both WasmGC lanes): the BigIntStats members with no lowering, and the
 * options bags beyond a literal { bigint }, a receiver that may hold either
 * record kind, and a cast between the kinds. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "tsinter-bigstat-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ROWS: { id: string; src: string; want: string }[] = [
  { id: "birthtime", src: 'const s = statSync("/", { bigint: true });\nconsole.log(s.birthtimeMs);', want: "BigIntStats.birthtimeMs" },
  { id: "dateTime", src: 'const s = statSync("/", { bigint: true });\nconsole.log(s.mtime);', want: "BigIntStats.mtime" },
  { id: "throwIfNoEntry", src: 'console.log(statSync("/", { bigint: true, throwIfNoEntry: false }));', want: "statSync with this options argument" },
  { id: "computedBag", src: 'const o = { bigint: true as const };\nconsole.log(statSync("/", o).size);', want: "statSync with this options argument" },
  // review (b504aab5): a receiver that may hold either kind never reaches
  // the plain Stats reader, and a recast between the kinds is a lying cast
  { id: "unionBinding", src: 'import type { BigIntStats, Stats } from "node:fs";\nconst u: Stats | BigIntStats = Math.random() > 2 ? statSync("/") : statSync("/", { bigint: true });\nconsole.log(u.size);', want: ".size on a Stats | BigIntStats receiver" },
  { id: "unionParam", src: 'import type { BigIntStats, Stats } from "node:fs";\nfunction t(s: Stats | BigIntStats) { return s.mtimeMs; }\nconsole.log(t(statSync("/", { bigint: true })));', want: ".mtimeMs on a Stats | BigIntStats receiver" },
  { id: "unionOptional", src: 'import type { BigIntStats, Stats } from "node:fs";\nfunction t(s?: Stats | BigIntStats) { return s?.size; }\nconsole.log(t(statSync("/", { bigint: true })));', want: ".size on a Stats | BigIntStats receiver" },
  { id: "bigAsPlain", src: 'import type { Stats } from "node:fs";\nconsole.log((statSync("/", { bigint: true }) as unknown as Stats).size);', want: "a BigIntStats cast to Stats" },
  { id: "plainAsBig", src: 'import type { BigIntStats } from "node:fs";\nconsole.log((statSync("/") as unknown as BigIntStats).size);', want: "a Stats cast to BigIntStats" },
];

describe("BigIntStats: what has no lowering refuses by name", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const dir = join(scratch, id);
    const file = join(dir, "main.ts");
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `import { statSync } from "node:fs";\n${row.src}\n`);
    const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm" });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toContain(row.want);
  });
});
