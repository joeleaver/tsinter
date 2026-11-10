/* GH #148: an object spread of a wider record into a narrower annotated
 * type keeps every key in Node (`const n: Narrow = { ...wide, a: 3 }` —
 * spreads escape tsc's excess-property check). A record of the narrower
 * shape has no slot for the extra keys, so the literal builds at its own
 * type and the slot holds a width COPY, judged by SEMANTICS.md S125 (b):
 * where the program could tell the copy by its keys (printing, JSON, key
 * listings, a later spread) it refuses by name (SC1090), and where it only
 * reads the slot's fields it runs. Before this, the extra keys dropped
 * silently. A spread of a DYNAMIC source (`any`, `JSON.parse`, a cast
 * `unknown`) may carry any key, and the record keeps only its fields: the
 * same rule refuses it by name where its keys could be observed.
 *
 * Exact rows equal Node (spawned at test time); refused rows pin the
 * named refusal. Both run on the wasm lane and, in the second describe,
 * on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh148-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  /** The entry's file name (main.ts unless given). */
  entry?: string;
  /** Refused at compile time with an SC1090 whose message matches. */
  refused?: RegExp;
}

const W = "type Wide = { b: number; c: number };\ntype Narrow = { b: number; a?: number };\n";
const DYN_COPY = /an object spread of a dynamic value into '.*': the record keeps only the type's own fields where JavaScript's object keeps every key the source has, and the program prints, serializes, lists the keys of.*S125/;
const COPY = /the slot would hold a COPY where JavaScript shares the object, and the program prints, serializes, lists the keys of or tests the class of the copy.*S125/;

const ROWS: Row[] = [
  {
    id: "GH148-01 the issue's repro: printing the narrowed spread refuses by name",
    src: W + "const w: Wide = { b: 1, c: 2 };\nconst n: Narrow = { ...w, a: 3 };\nconsole.log(n);",
    refused: COPY,
  },
  {
    id: "GH148-02 reading only the slot's fields runs",
    src: W + "const w: Wide = { b: 1, c: 2 };\nconst n: Narrow = { ...w, a: 3 };\nconsole.log(n.b, n.a, n.b + (n.a ?? 0));",
  },
  {
    id: "GH148-03 JSON and Object.keys of the narrowed spread refuse",
    src: W + "const w: Wide = { b: 1, c: 2 };\nconst n: Narrow = { ...w };\nconsole.log(JSON.stringify(n), Object.keys(n));",
    refused: COPY,
  },
  {
    id: "GH148-04 a narrowed spread returned from a function and printed refuses",
    src: W + "function mk(w: Wide): Narrow { return { ...w, a: 3 }; }\nconsole.log(mk({ b: 1, c: 2 }));",
    refused: COPY,
  },
  {
    id: "GH148-05 a narrowed spread into an array element, printed, refuses",
    src: W + "const w: Wide = { b: 1, c: 2 };\nconst arr: Narrow[] = [{ ...w }, { b: 5 }];\nconsole.log(arr);",
    refused: COPY,
  },
  {
    id: "GH148-06 a narrowed spread in a nested field, serialized, refuses",
    src: W + "type Holder = { inner: Narrow };\nconst w: Wide = { b: 1, c: 2 };\nconst h: Holder = { inner: { ...w, a: 1 } };\nconsole.log(JSON.stringify(h));",
    refused: COPY,
  },
  {
    id: "GH148-07 a conditional spread's key the annotation lacks refuses when printed",
    src: "type Narrow = { b: number; a?: number };\nconst flag = process.argv.length > 0;\nconst base: Narrow = { b: 1 };\nconst n: Narrow = { ...base, ...(flag ? { z: 9 } : {}) };\nconsole.log(n);",
    refused: COPY,
  },
  {
    id: "GH148-08 a later spread of the narrowed copy refuses",
    src: "type Wide = { b: number; c: number; d: string };\ntype Narrow = { b: number; d: string };\nconst w: Wide = { b: 1, c: 2, d: \"x\" };\nconst n: Narrow = { ...w };\nconst copy = { ...n };\nconsole.log(copy);",
    refused: COPY,
  },
  {
    id: "GH148-09 a cast of the spread refuses the same way",
    src: W + "const w: Wide = { b: 1, c: 2 };\nconst n = { ...w, a: 3 } as Narrow;\nconsole.log(n);",
    refused: COPY,
  },
  {
    id: "GH148-10 an unannotated, satisfies-checked or wide-annotated spread keeps every key",
    src: W + "type Both = { b: number; c: number; a?: number };\nconst w: Wide = { b: 1, c: 2 };\nconst x = { ...w, a: 3 };\nconst y = { ...w, a: 4 } satisfies Narrow;\nconst z: Both = { ...w, a: 5 };\nconsole.log(x, y, z, Object.keys(x), JSON.stringify(z));",
  },
  {
    id: "GH148-11 a spread whose keys the annotation all has keeps its order",
    src: "type Narrow = { b: number; a?: number };\nconst base: Narrow = { b: 1 };\nconst n: Narrow = { ...base, a: 3 };\nconst m: Narrow = { ...base };\nconsole.log(n, m, Object.keys(n), JSON.stringify(m));",
  },
  {
    id: "GH148-13 the review's repro: an any source spread into a narrower slot, printed, refuses",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = { b: 1, c: 2 };\nconst n: Narrow = { ...x };\nconsole.log(n);",
    refused: DYN_COPY,
  },
  {
    id: "GH148-14 a JSON.parse source spread, serialized, refuses",
    src: "type Narrow = { b: number; a?: number };\nconst n: Narrow = { ...JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\") };\nconsole.log(JSON.stringify(n));",
    refused: DYN_COPY,
  },
  {
    id: "GH148-15 an any source spread returned and printed refuses",
    src: "type Narrow = { b: number; a?: number };\nfunction mk(x: any): Narrow { return { ...x, a: 3 }; }\nconsole.log(mk(JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\")));",
    refused: DYN_COPY,
  },
  {
    id: "GH148-16 an any source spread as an argument whose keys the callee lists refuses",
    src: "type Narrow = { b: number; a?: number };\nfunction show(n: Narrow) { console.log(Object.keys(n)); }\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nshow({ ...x });",
    refused: DYN_COPY,
  },
  {
    id: "GH148-17 an any source spread into an array element, serialized, refuses",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nconst arr: Narrow[] = [{ ...x }];\nconsole.log(JSON.stringify(arr));",
    refused: DYN_COPY,
  },
  {
    id: "GH148-18 an any source spread read only through the slot's fields runs; into an any or index-signature slot it keeps every key",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nconst n: Narrow = { ...x, a: 3 };\nconsole.log(n.b, n.a);\nfunction mk(y: any): Narrow { return { ...y }; }\nconsole.log(mk(x).b);\nconst d: any = { ...x, a: 3 };\nconst m: Record<string, number> = { ...x };\nconst o = { ...x, a: 4 };\nconsole.log(d, m, o);",
  },
  {
    id: "GH148-19 an any source spread into a union-typed slot (Narrow | undefined), printed, refuses",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nconst n: Narrow | undefined = { ...x };\nconsole.log(n);",
    refused: DYN_COPY,
  },
  {
    id: "GH148-19b an any source spread returned as Narrow | string, printed, refuses",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nfunction mk(): Narrow | string { return { ...x }; }\nconsole.log(mk());",
    refused: DYN_COPY,
  },
  {
    id: "GH148-20 an any source spread in a ?: arm of a plain slot, printed, refuses",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nconst flag = process.argv.length > 0;\nfunction mk(): Narrow { return flag ? { ...x } : { b: 0 }; }\nconsole.log(mk());",
    refused: DYN_COPY,
  },
  {
    id: "GH148-21 an any source spread in an && / || arm, printed, refuses",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nconst flag = process.argv.length > 0;\nconst n: Narrow = (flag && { ...x }) || { b: 0 };\nconsole.log(n);",
    refused: DYN_COPY,
  },
  {
    id: "GH148-22 JavaScript: a spread returned through a JSDoc @returns record type, printed, refuses",
    entry: "main.js",
    src: "/** @typedef {{ b: number, a?: number }} Narrow */\n/** @param {any} opts @returns {Narrow} */\nfunction f(opts) { return { ...opts }; }\nconsole.log(f(JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\")));",
    refused: DYN_COPY,
  },
  {
    id: "GH148-23 JavaScript: a spread passed to a JSDoc @param record type that prints it refuses",
    entry: "main.js",
    src: "/** @typedef {{ b: number, a?: number }} Narrow */\n/** @param {Narrow} n */\nfunction show(n) { console.log(n); }\n/** @param {any} o */\nfunction f(o) { show({ ...o }); }\nf(JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\"));",
    refused: DYN_COPY,
  },
  {
    id: "GH148-24 an any source spread in a ?: or || arm read only through the slot's fields runs",
    src: "type Narrow = { b: number; a?: number };\nconst x: any = JSON.parse(\"{\\\"b\\\":1,\\\"c\\\":2}\");\nconst flag = process.argv.length > 0;\nconst m: Narrow = flag ? { ...x } : { b: 0 };\nconsole.log(m.b, ((flag && { ...x }) || { b: 0 }).b);",
  },
  {
    id: "GH148-12 the registered cost: a field write through the copy refuses although no run could tell",
    src: W + "const w: Wide = { b: 1, c: 2 };\nconst n: Narrow = { ...w, a: 3 };\nn.b = 7;\nconsole.log(n.b, w.b);",
    refused: COPY,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
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

describe("GH #148: a wider record spread into a narrower annotated type (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #148: a wider record spread into a narrower annotated type (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
