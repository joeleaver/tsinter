/* rea (tests/real-apps-top10) step 9: an instance of a program's own Error
 * subclass in a dynamic value. The dynamic error encoding (dyn.fromError)
 * carries errT's name, message and stamped code only, so a subclass's own
 * members were LOST where Node keeps them (`a.code` undefined, JSON `{}`): a
 * silent miscompile on main, found while lifting rea's catch idiom.
 * SEMANTICS.md S138 stopped those by name; since GH #191 the encoding
 * mirrors the instance (own members in Node's order, read live; prototype
 * methods and accessors through the class), and the rows that pinned the
 * stops are exact rows. The remaining stops are S138's GH #191 amendment
 * (wasm-gh191-error-mirror.test.ts).
 * Also GH #193: a program's key listing or Object.assign of an error held
 * in a dynamic value no longer shows the encoding's internal entries.
 *
 * Exact rows equal Node (spawned at test time); stopped rows pin the named
 * runtime stop (exit 1, the S138 text) after what Node printed first. Both
 * lanes. No third-party code. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-errdyn-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  /** Stops at runtime with the S138 fence; `before` is the stdout printed first. */
  stops?: { before: string };
}

const FS =
  "class FsError extends Error {\n" +
  "  constructor(message: string, readonly code: string) { super(message); }\n" +
  "}\n";

const ROWS: Row[] = [
  {
    id: "REA-ERRDYN-01 a parameter-property subclass into any reads its own members (GH #191)",
    src: FS + 'console.log("start");\nconst a: any = new FsError("own", "EOWN");\nconsole.log(a.code);',
  },
  {
    id: "REA-ERRDYN-02 a field-bearing subclass into unknown: its JSON lists the fields (GH #191)",
    src: 'class FieldErr extends Error { detail = 3; }\nconsole.log("start");\nconst u: unknown = new FieldErr("x");\nconsole.log(JSON.stringify(u));',
  },
  {
    id: "REA-ERRDYN-03 a caught field-bearing subclass read as any reads its fields (GH #191)",
    src: FS + 'console.log("start");\ntry { throw new FsError("own", "EOWN"); } catch (e: any) { console.log(e.code); }',
  },
  {
    id: "REA-ERRDYN-04 a getter-only subclass: a dynamic read of its getter calls it (GH #191)",
    src: 'class GetErr extends Error { get code(): string { return "G"; } }\nconst a: any = new GetErr("g");\nconsole.log(a.message, a.other);\nconsole.log(a.code);',
  },
  {
    id: "REA-ERRDYN-05 a subclass with nothing of its own keeps crossing (any, unknown, JSON, catch)",
    src:
      "class PlainErr extends Error {}\n" +
      'const a: any = new PlainErr("p");\n' +
      'const u: unknown = new PlainErr("q");\n' +
      "console.log(a.message, a instanceof Error, JSON.stringify(u));\n" +
      'try { throw new PlainErr("r"); } catch (e: any) { console.log(e.message, String(e)); }',
  },
  {
    id: "REA-ERRDYN-06 builtin and Node errors keep crossing (a TypeError, an ERR_INVALID_URL code)",
    src:
      'try { throw new TypeError("t"); } catch (e: any) { console.log(e.name, e.message); }\n' +
      'try { new URL("not a url"); } catch (e: any) { console.log(e.name, e.code); }',
  },
  {
    id: "REA-ERRDYN-07 (review) a declare field assigned inside an if is listed once present (GH #191)",
    src:
      'class CondErr extends Error { declare detail: string; constructor(m: string, d?: string) { super(m); if (d !== undefined) { this.detail = d; } } }\n' +
      'console.log("start");\nconst a: any = new CondErr("m", "D");\nconsole.log(a.detail);',
  },
  {
    id: "REA-ERRDYN-08 (review F2) a declare-only field nothing assigns: reads through any equal Node",
    src:
      "class D1 extends Error { declare code: string; }\n" +
      'const a: any = new D1("x");\n' +
      "console.log(a.message, a.code, JSON.stringify(a));",
  },
  {
    id: "REA-ERRDYN-09 (review) a subclass setting its own name lists it (GH #191)",
    src:
      'class MyErr extends Error { constructor(m: string) { super(m); this.name = "MyErr"; } }\n' +
      'console.log("start");\nconst a: any = new MyErr("m");\nconsole.log(Object.keys(a), JSON.stringify(a));',
  },
  {
    id: "REA-ERRDYN-10 a method-only subclass: message, JSON and keys equal Node; a dynamic call of its method runs it (GH #191)",
    src:
      'class MErr extends Error { describe(): string { return "d:" + this.message; } }\n' +
      'const a: any = new MErr("m");\n' +
      "console.log(a.message);\n" +
      "console.log(JSON.stringify(a), Object.keys(a));\n" +
      "console.log(a.describe());",
  },
  {
    id: "REA-ERRDYN-11 (review) a method-only subclass in the catch idiom: e.code on an undeclared name equals Node",
    src:
      'class MErr extends Error { describe(): string { return "d"; } }\n' +
      'try { throw new MErr("m"); } catch (e: any) { console.log(e.code === "ENOENT" ? "enoent" : "other", e.message); }',
  },
  {
    id: "REA-ERRDYN-12 (review) a method-only subclass: in/hasOwn equal Node, its method included (GH #191)",
    src:
      'class MErr extends Error { describe(): string { return "d"; } }\n' +
      'const a: any = new MErr("m");\n' +
      'console.log("code" in a, Object.hasOwn(a, "describe"), Object.hasOwn(a, "code"));\n' +
      'console.log("describe" in a);',
  },
  {
    id: "REA-ERRDYN-13 (GH #193) keys, entries and Object.assign of a plain error in any list no internal entries; an expando lists",
    src:
      'const a: any = new Error("m");\n' +
      "console.log(Object.keys(a), Object.entries(a), Object.assign({}, a));\n" +
      "a.extra = 1;\n" +
      "console.log(Object.keys(a), Object.values(a), Object.assign({}, a));",
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
  let got: Out;
  if (backend === "wasm") {
    // A fence ends the module with a trap: the trap-tolerant host keeps
    // what the program printed before it.
    got = row.stops !== undefined
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }));
  } else {
    got = await nativeRun(res.binaryPath!);
  }
  if (row.stops !== undefined) {
    expect(got.stdout, row.id).toBe(row.stops.before);
    expect(got.exitCode, row.id).not.toBe(0);
    expect(got.stderr, row.id).toMatch(/Error subclass .*dynamic value .*SEMANTICS\.md S138/);
    return;
  }
  expect(got, row.id).toEqual(node);
}

describe("rea: Error subclasses crossing into dynamic values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: Error subclasses crossing into dynamic values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
