/* rea (tests/real-apps-top10) step 7: an object spread AFTER explicit
 * properties (`{ ...processProof, source: "verified_process_cache" }` is
 * already supported; rea also writes `{ source, ...proof }`). The desugar
 * refused every spread that followed an explicit property, because a later
 * spread would overwrite earlier keys ("object spread after explicit
 * properties", 35 sites in rea's past-gate census). A spread whose source is
 * a known record sharing no field name with the explicit properties before
 * it overwrites nothing, so it now compiles when the record's type orders
 * its keys exactly as JS does (records print, serialize and list keys in
 * their TYPE's order; an unannotated `{ kind, ...proof }` types the
 * spread's keys first, so it keeps the refusal). An overlap keeps the
 * refusal too.
 *
 * Exact rows equal Node (spawned at test time); the refused row pins the
 * named refusal. Both lanes. No third-party code. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-spreadafter-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  refused?: RegExp;
}

const PROOF =
  "interface Proof { readonly sha256: string; readonly version: string }\n" +
  "interface Launcher extends Proof { readonly source: string }\n" +
  'const proof: Proof = { sha256: "abc", version: "1.2" };\n';

const ROWS: Row[] = [
  {
    id: "REA-SPREADAFTER-01 an explicit property then a disjoint record spread: values, key order, JSON",
    src:
      PROOF +
      'const merged: Launcher = { source: "override", ...proof };\n' +
      "console.log(merged, Object.keys(merged), JSON.stringify(merged));",
  },
  {
    id: "REA-SPREADAFTER-02 explicit properties around a disjoint spread, in source order",
    src:
      PROOF +
      "interface Around { kind: string; sha256: string; version: string; tail: string }\n" +
      "const order: string[] = [];\n" +
      "const mark = (s: string): string => { order.push(s); return s; };\n" +
      'const r: Around = { kind: mark("kind"), ...proof, tail: mark("tail") };\n' +
      "console.log(r, order, Object.keys(r));",
  },
  {
    id: "REA-SPREADAFTER-03 a disjoint spread with an optional field, absent and present",
    src:
      "type Extra = { note?: string; level: number };\n" +
      "interface Tagged { id: string; note?: string; level: number }\n" +
      "const without: Extra = { level: 1 };\n" +
      'const withNote: Extra = { note: "n", level: 2 };\n' +
      'const a: Tagged = { id: "a", ...without };\n' +
      'const b: Tagged = { id: "b", ...withNote };\n' +
      "console.log(a, b, JSON.stringify([a, b]), Object.keys(a), Object.keys(b));",
  },
  {
    id: "REA-SPREADAFTER-05 an unannotated literal whose type orders the spread's keys first refuses by name",
    src:
      PROOF +
      'const r = { kind: "k", ...proof };\n' +
      "console.log(r);",
    refused: /object spread after explicit properties/,
  },
  {
    id: "REA-SPREADAFTER-04 a spread overlapping an earlier explicit property still refuses",
    src:
      "const opt: { a?: number; b: number } = { b: 2 };\n" +
      "const both = { a: 1, ...opt };\n" +
      "console.log(both);",
    refused: /object spread after explicit properties/,
  },
  {
    id: "REA-SPREADAFTER-06 (review) a spread source's absent optional key written later refuses (JS puts it at the later position)",
    src:
      "interface S { p?: number; q: number }\n" +
      "interface T { a: number; p: number; q: number }\n" +
      "const s: S = { q: 1 };\n" +
      "const t: T = { a: 0, ...s, p: 5 };\n" +
      "console.log(t, JSON.stringify(t), Object.keys(t));",
    refused: /object spread after explicit properties/,
  },
  {
    id: "REA-SPREADAFTER-07 (review) the same key added to the source after it was built refuses",
    src:
      "interface S { p?: number; q: number }\n" +
      "interface T { a: number; p: number; q: number }\n" +
      "const s: S = { q: 1 };\n" +
      "s.p = 2;\n" +
      "const t: T = { a: 0, ...s, p: 5 };\n" +
      "console.log(t, Object.keys(t));",
    refused: /object spread after explicit properties/,
  },
  {
    id: "REA-SPREADAFTER-08 (review) an optional key a later SPREAD writes refuses too",
    src:
      "interface S1 { p: number }\n" +
      "interface S2 { p?: number; q: number }\n" +
      "interface T { x: number; q: number; p: number }\n" +
      "const s1: S1 = { p: 1 };\n" +
      "const s2: S2 = { q: 2 };\n" +
      "const t: T = { x: 0, ...s2, ...s1 };\n" +
      "console.log(t, Object.keys(t));",
    refused: /object spread after explicit properties/,
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
  if (row.refused !== undefined) {
    expect(res.ok, `${row.id} must refuse on ${backend}`).toBe(false);
    if (res.ok) return;
    const d = res.diagnostics.find((x) => x.code === "SC1090" && row.refused!.test(x.message));
    expect(d, res.diagnostics.map((x) => `${x.code} ${x.message}`).join(" | ")).toBeDefined();
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("rea: object spread after explicit properties (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: object spread after explicit properties (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
