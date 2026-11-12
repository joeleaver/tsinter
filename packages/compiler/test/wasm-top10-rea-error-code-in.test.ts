/* rea (tests/real-apps-top10) step 8: `"code" in err` on an Error-typed value.
 * The `in` answered from the runtime error's code slot only (stamped by fs,
 * system, event and spawn errors), so a program's OWN Error subclass that
 * declares `code` (a parameter property, a field, a getter) answered false
 * where Node answers true: a SILENT divergence, on main, found while
 * lifting rea's `cause instanceof Error && "code" in cause && cause.code`
 * catch idiom (that narrowed read itself stays refused, SC1063: its dynamic
 * conversion would not carry a subclass's fields). Such subclasses now
 * answer true through an instanceof test per declaring class; the code slot
 * answers the rest.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-errcodein-"));
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

const ROWS: Row[] = [
  {
    id: "REA-ERRCODEIN-02 a caught plain Error and a caught own subclass, tested with in",
    src:
      "class FsError extends Error {\n" +
      "  constructor(message: string, readonly code: string) { super(message); }\n" +
      "}\n" +
      "const attempts: (() => void)[] = [\n" +
      '  () => { throw new FsError("own", "EOWN"); },\n' +
      '  () => { throw new Error("plain"); },\n' +
      "];\n" +
      "for (const attempt of attempts) {\n" +
      "  try {\n" +
      "    attempt();\n" +
      "  } catch (cause) {\n" +
      '    if (cause instanceof Error) console.log(cause.message, "code" in cause);\n' +
      "  }\n" +
      "}",
  },
  {
    id: "REA-ERRCODEIN-01 'code' in an Error-typed value holding a program's own subclass (field, parameter property, getter)",
    src:
      "class FsError extends Error {\n" +
      "  constructor(message: string, readonly code: string) { super(message); }\n" +
      "}\n" +
      "class FieldError extends Error { code = 3; }\n" +
      'class GetterError extends Error { get code(): string { return "G"; } }\n' +
      "class Leaf extends FsError {}\n" +
      "const values: Error[] = [\n" +
      '  new FsError("m", "X"), new FieldError("f"), new GetterError("g"), new Leaf("l", "L"), new Error("p"), new RangeError("r"),\n' +
      "];\n" +
      'console.log(values.map((e) => "code" in e).join(" "), values.map((e) => "message" in e).join(" "));',
  },
  {
    id: "REA-ERRCODEIN-03 (review F1) a declare-only code field emits nothing (false); one the constructor assigns is own (true)",
    src:
      "class D1 extends Error { declare code: string; }\n" +
      'class D2 extends Error { declare code: string; constructor(m: string) { super(m); this.code = "C"; } }\n' +
      'const xs: Error[] = [new D1("x"), new D2("y")];\n' +
      'console.log(xs.map((e) => "code" in e).join(" "));',
  },
  {
    id: "REA-ERRCODEIN-04 (review) a subclass assigning this.code inside an if: 'code' in refuses by name (its presence is a runtime fact)",
    src:
      'class CondErr extends Error { declare code: string; constructor(m: string, c?: string) { super(m); if (c !== undefined) { this.code = c; } } }\n' +
      'const xs: Error[] = [new CondErr("x"), new CondErr("y", "C")];\n' +
      'console.log(xs.map((e) => "code" in e).join(" "));',
    refused: /'in' with the key 'code' on Error receivers while an Error subclass \('CondErr'\) assigns 'this\.code' conditionally/,
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

describe("rea: 'code' in Error-typed values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: 'code' in Error-typed values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
