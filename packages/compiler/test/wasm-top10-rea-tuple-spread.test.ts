/* rea (tests/real-apps-top10) step 6: spreading a fixed tuple into an array
 * literal (`["-id", id, "-notype", ...X11_WINDOW_PROPERTY_NAMES]` over an
 * `as const` tuple). Tuples are records with positional fields on the
 * WasmGC lanes, so the spread refused ("only a same-element-type array
 * spreads", 36 sites in rea's past-gate census). A tuple whose elements
 * share one type now spreads as a fresh array of its field reads, in index
 * order, with the source read once; that array then spreads or lifts like
 * any `T[]` source.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and on the
 * wasm-native lane. No third-party code. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-tuplespread-"));
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

const ROWS: Row[] = [
  {
    id: "REA-TSPREAD-01 an as-const string tuple spread into a string[] argument list",
    src:
      'const NAMES = ["_NET_WM_NAME", "WM_CLASS", "_NET_WM_PID"] as const;\n' +
      'const id = "0x1";\n' +
      'const args: string[] = ["-id", id, "-notype", ...NAMES];\n' +
      "console.log(args, args.length, args.join(\" \"));",
  },
  {
    id: "REA-TSPREAD-02 annotated tuples, two spreads, an empty-tail literal",
    src:
      'const PAIR: [string, string] = ["a", "b"];\n' +
      "const NUMS: readonly [number, number, number] = [3, 1, 2];\n" +
      'const more = ["x", ...PAIR, "y", ...PAIR];\n' +
      "const ns = [...NUMS, 4].sort((a, b) => a - b);\n" +
      "console.log(more, ns, [...PAIR].length, JSON.stringify([...NUMS]));",
  },
  {
    id: "REA-TSPREAD-03 the source is evaluated once, and the copy is fresh",
    src:
      "let calls = 0;\n" +
      'const make = (): [string, string] => { calls++; return ["p", "q"]; };\n' +
      'const xs = [...make(), "r"];\n' +
      'const t: [number, number] = [1, 2];\n' +
      "const copy = [...t];\n" +
      "copy[0] = 9;\n" +
      "console.log(xs, calls, t, copy);",
  },
  {
    id: "REA-TSPREAD-04 a string tuple spread into a wider (string | number)[] literal",
    src:
      'const PAIR: [string, string] = ["a", "b"];\n' +
      "const mixed: (string | number)[] = [1, ...PAIR, 2];\n" +
      'console.log(mixed, mixed.map((v) => typeof v).join(","));',
  },
  {
    id: "REA-TSPREAD-05 optional tuple elements (absent and present) spread their real length",
    src:
      'const absent: [string, string?] = ["a"];\n' +
      'const present: [string, string?] = ["a", "b"];\n' +
      'console.log([...absent, "z"], [...present, "z"], [...absent].length);',
  },
  {
    id: "REA-TSPREAD-06 a rest tuple spreads every element",
    src:
      'const rest: [string, ...string[]] = ["a", "b", "c"];\n' +
      'const one: [string, ...string[]] = ["solo"];\n' +
      'console.log([...rest, "z"], [...one], [...rest].length);',
  },
  {
    id: "REA-TSPREAD-07 a mutable tuple written just before the spread, beside a readonly one",
    src:
      'const t: [string, string] = ["a", "b"];\n' +
      'const r: readonly [string, string] = ["c", "d"];\n' +
      't[1] = "B";\n' +
      "const out = [...t, ...r];\n" +
      't[0] = "A";\n' +
      "console.log(out, t, [...t]);",
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
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

describe("rea: tuple spreads into array literals (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: tuple spreads into array literals (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
