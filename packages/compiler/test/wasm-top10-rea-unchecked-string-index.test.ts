/* rea (tests/real-apps-top10) step 2: `s[i]` with a number index under
 * noUncheckedIndexedAccess (rea's tsconfig sets it). The checker types the
 * read `string | undefined`. On the WasmGC lanes a string slot holds
 * `undefined` (SEMANTICS.md S119) and the charAt read already answers it
 * past the end, for a fraction, a negative or NaN index, so the read lowers
 * exactly as the plain `string`-typed read does: the same stance the array
 * element path takes for `T | undefined` reads. It used to refuse (SC1090,
 * 127 sites in rea's past-gate census).
 *
 * Every row equals Node (spawned at test time) on the wasm lane and on the
 * wasm-native lane, compiled under a tsconfig with noUncheckedIndexedAccess.
 * No third-party code: the rows are written from scratch. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-strindex-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noUncheckedIndexedAccess: true, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext" },
});

const ROWS: Row[] = [
  {
    id: "REA-STRIDX-01 the scanning loop: a regex test on s[i]!, a comparison, reads past the end",
    src:
      'const text = "a b\\tc";\n' +
      "let spaces = 0;\n" +
      "for (let at = 0; at < text.length; at++) {\n" +
      "  if (/\\s/u.test(text[at]!)) spaces++;\n" +
      "  const ch = text[at];\n" +
      '  if (ch === "b") console.log("b at", at);\n' +
      "}\n" +
      "console.log(spaces, text[10], text[0], text.length);",
  },
  {
    id: "REA-STRIDX-02 the undefined a read past the end answers, through every observer",
    src:
      'const s = "xyz";\n' +
      "const past = s[9];\n" +
      'console.log(past === undefined, typeof past, `${past}`, past ?? "-", String(past), [s[0], past]);\n' +
      "const all: (string | undefined)[] = [s[0], s[5], s[2]];\n" +
      "console.log(all, all.filter((c) => c !== undefined).join(\"\"));\n" +
      "const fallback = s[3] || \"empty\";\n" +
      "console.log(fallback, s[1]?.toUpperCase(), s[7]?.toUpperCase());",
  },
  {
    id: "REA-STRIDX-03 fractional, negative and NaN indices answer undefined",
    src:
      'const s = "abc";\n' +
      "const idx = [1.5, -1, Number.NaN, 2, 3];\n" +
      "for (const i of idx) console.log(i, s[i], s[i] === undefined);",
  },
  {
    id: "REA-STRIDX-04 reads handed to functions: an optional parameter and a non-null assertion",
    src:
      'const describe = (c: string | undefined): string => (c === undefined ? "none" : `char ${c}`);\n' +
      "const code = (c: string): number => c.charCodeAt(0);\n" +
      'const s = "Hi";\n' +
      "for (let i = 0; i <= s.length; i++) console.log(describe(s[i]));\n" +
      "console.log(code(s[0]!), code(s[1]!));\n" +
      "const words = [\"alpha\", \"beta\", \"\"];\n" +
      "console.log(words.map((w) => w[0] ?? \"?\").join(\",\"));",
  },
  {
    id: "REA-STRIDX-05 UTF-16 code units, as Node reads them",
    src:
      'const s = "\\u00e9t\\u00e9 \\u{1F600}!";\n' +
      "const units: number[] = [];\n" +
      "for (let i = 0; i < s.length; i++) units.push(s[i]!.charCodeAt(0));\n" +
      "console.log(s.length, units.join(\" \"), s[s.length - 1], s[s.length]);",
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG + "\n");
  const entry = join(dir, "main.ts");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(row, backend);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("rea: s[i] under noUncheckedIndexedAccess (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: s[i] under noUncheckedIndexedAccess (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
