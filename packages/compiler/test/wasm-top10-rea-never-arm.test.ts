/* rea (tests/real-apps-top10) step 1: the ok/err helper idiom
 * `ok = <T>(value: T): Result<T, never>` / `err = <E>(error: E): Result<never, E>`.
 * `Result<never, E>`'s ok arm `{ ok: true; value: never }` holds no value. It used
 * to map with the dead-read placeholder for the `never` field (an f64), so the
 * helper's result was a two-arm union that no longer re-tagged into the
 * caller's `Result<T, E>` (SC2003, 514 sites in rea). An uninhabited record
 * arm now gets no arm at all (SEMANTICS.md S135): `Result<never, E>` is the
 * error record. An OPTIONAL `never` field is the absent-field spelling and
 * stays an ordinary arm, and a read of the dropped arm's field (only in a
 * branch TypeScript narrows to it, which never runs) refuses by name.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and on the
 * wasm-native lane. No third-party code: the rows are written from scratch. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-never-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  /** Refused at compile time with an SC1090 whose message matches. */
  refused?: RegExp;
}

const RESULT =
  "type Result<T, E> =\n" +
  "  | { readonly ok: true; readonly value: T }\n" +
  "  | { readonly ok: false; readonly error: E };\n" +
  "const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });\n" +
  "const err = <E>(error: E): Result<never, E> => ({ ok: false, error });\n";

const ROWS: Row[] = [
  {
    id: "REA-NEVER-01 ok/err helpers return into a Result with a class error and a record value",
    src:
      RESULT +
      'class ParseError extends Error {\n  constructor(readonly reason: "empty" | "nan", message: string) { super(message); }\n}\n' +
      "interface Parsed { readonly n: number; readonly source: string }\n" +
      "const parse = (s: string): Result<Parsed, ParseError> => {\n" +
      '  if (s.length === 0) return err(new ParseError("empty", "empty input"));\n' +
      "  const n = Number(s);\n" +
      '  if (Number.isNaN(n)) return err(new ParseError("nan", `not a number: ${s}`));\n' +
      "  return ok({ n, source: s });\n" +
      "};\n" +
      "const twice = (s: string): Result<Parsed, ParseError> => {\n" +
      "  const r = parse(s);\n" +
      "  if (!r.ok) return r;\n" +
      "  return ok({ n: r.value.n * 2, source: r.value.source });\n" +
      "};\n" +
      'for (const s of ["", "x", "21"]) {\n' +
      "  const r = twice(s);\n" +
      "  console.log(r.ok ? `value ${r.value.n} from ${r.value.source}` : `error ${r.error.reason}: ${r.error.message}`);\n" +
      "}",
  },
  {
    id: "REA-NEVER-02 helper results printed and serialized",
    src:
      RESULT +
      'type Failure = { readonly kind: "missing" | "denied"; readonly path: string };\n' +
      "const look = (p: string): Result<number, Failure> =>\n" +
      '  p === "" ? err({ kind: "missing", path: p }) : p.startsWith("/root") ? err({ kind: "denied", path: p }) : ok(p.length);\n' +
      'const all = ["", "/root/x", "/tmp/abc"].map(look);\n' +
      "console.log(all);\n" +
      "console.log(JSON.stringify(all));\n" +
      "for (const r of all) console.log(r.ok, r.ok ? r.value : r.error.kind);\n" +
      "console.log(ok(3), err(\"bad\"));",
  },
  {
    id: "REA-NEVER-03 a Result<never, E> binding narrows and reads its error",
    src:
      RESULT +
      'const e = err({ code: 7, text: "seven" });\n' +
      "if (!e.ok) console.log(e.error.code, e.error.text);\n" +
      "const v = ok([1, 2, 3]);\n" +
      "if (v.ok) console.log(v.value.length, v.value);\n" +
      "const pick = (flag: boolean): Result<number[], { code: number; text: string }> => (flag ? v : e);\n" +
      "console.log(pick(true), pick(false));",
  },
  {
    id: "REA-NEVER-04 an optional never field is an ordinary arm",
    src:
      'type Shape = { readonly kind: "dot"; readonly r?: never } | { readonly kind: "circle"; readonly r: number };\n' +
      'const shapes: Shape[] = [{ kind: "dot" }, { kind: "circle", r: 2 }];\n' +
      'for (const s of shapes) console.log(s.kind, s.kind === "circle" ? s.r * 2 : "none");\n' +
      "console.log(shapes, JSON.stringify(shapes));",
  },
  {
    id: "REA-NEVER-05 a Result passed through a helper that maps its value",
    src:
      RESULT +
      "const mapOk = (r: Result<number, string>, f: (v: number) => string): Result<string, string> => (r.ok ? ok(f(r.value)) : r);\n" +
      "const half = (n: number): Result<number, string> => (n % 2 === 0 ? ok(n / 2) : err(`odd ${n}`));\n" +
      "for (const n of [4, 5]) {\n" +
      "  const r = mapOk(half(n), (h) => `half is ${h}`);\n" +
      "  console.log(r.ok ? r.value : r.error);\n" +
      "}",
  },
  {
    id: "REA-NEVER-06 a dynamic value in a Result<never, E> slot stays the value itself (S128)",
    src:
      RESULT +
      "const lie: any = JSON.parse('{\"ok\":true,\"value\":1}');\n" +
      "const r: Result<never, string> = lie;\n" +
      "const show = (x: Result<number, string>): string => (x.ok ? `v${x.value}` : `e${x.error}`);\n" +
      "console.log(show(r), show(err(\"no\")), show(ok(2)));",
  },
  {
    id: "REA-NEVER-07 reading the dropped arm's field in a branch that never runs refuses by name",
    src:
      RESULT +
      'const e = err("x");\n' +
      'if (e.ok) console.log("dead", e.value);\n' +
      "else console.log(e.error);",
    refused: /reading 'value' from a value of type '\{ readonly ok: true; readonly value: never; \}'/,
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

describe("rea: uninhabited Result arms (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: uninhabited Result arms (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
