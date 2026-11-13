/* GH #187 (frontend/lowering/big-widen.ts): arithmetic over `any` answers
 * the dynamic value only in a program that can hold a bigint. The values
 * themselves are corpus program tests/corpus/2950-bigint-any-arith
 * (Node-differential on both WasmGC lanes); these rows pin the gate: the
 * same binding is a number slot without a bigint source and the dynamic
 * value with one, whichever source it is. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "tsinter-bigwiden-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const BODY = 'const x: any = JSON.parse("2");\nconst r = -x;\nfunction twice(v: any) { return v * 2; }\nconst t = twice(x);\nconsole.log(r, t);\n';

const ROWS: { id: string; extra: string; want: "f64" | "jsval" }[] = [
  { id: "none", extra: 'const n: number = 3;\nconsole.log(n % 2, "bigint");\n', want: "f64" },
  { id: "falseBag", extra: 'console.log({ bigint: false });\n', want: "f64" },
  { id: "literal", extra: "console.log(1n);\n", want: "jsval" },
  { id: "global", extra: 'console.log(typeof BigInt);\n', want: "jsval" },
  { id: "bufferRead", extra: 'console.log(Buffer.alloc(8).readBigInt64LE(0));\n', want: "jsval" },
  { id: "statBag", extra: 'import { statSync } from "node:fs";\nconsole.log(statSync("/", { bigint: true }).size > 0n);\n', want: "jsval" },
];

describe("GH #187: arithmetic over any widens only where a bigint can exist", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const dir = join(scratch, id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "main.ts");
    const imports = row.extra.split("\n").filter((l) => l.startsWith("import "));
    const rest = row.extra.split("\n").filter((l) => !l.startsWith("import "));
    writeFileSync(file, [...imports, BODY, ...rest].join("\n"));
    const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", emitIr: true });
    expect(res.ok ? [] : res.diagnostics.map((d) => d.message)).toEqual([]);
    const ir = JSON.parse(readFileSync(join(dir, "main.ir.json"), "utf8")) as { globals: { name: string; type: { kind: string } }[] };
    const kind = (n: string): string | undefined => ir.globals.find((g) => g.name === n)?.type.kind;
    expect([kind("r"), kind("t")]).toEqual([row.want, row.want]);
  });
});
