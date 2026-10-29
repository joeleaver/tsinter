/* INC-28 U1 — child_process's synchronous surface on the WasmGC tier: the
 * HOST-FREE rows. Nothing here runs a module: each row compiles a small
 * program and reads the result (the import section, a refusal, a build
 * check). Rows that run a real child live in
 * tests/harness/wasm-differential.test.ts ("INC-28 U1 child_process
 * rows"); rows that script the cpCall import live in
 * wasm-host-cp-u1.test.ts. Every row names the single edit that would make
 * it fail. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { constants as osConstants } from "node:os";
import { getSystemErrorMap } from "node:util";
import { compile } from "../src/index.js";
import { ERRNO_NAMES, SIGNAL_NAMES } from "../src/backend/wasm/os-names.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-childproc-u1-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
/** Compiles `src` for the wasm backend; answers the module's import names
 * (module.name) when it builds, else the diagnostics. */
async function build(src: string): Promise<{ ok: true; imports: string[] } | { ok: false; diagnostics: string[] }> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) return { ok: false, diagnostics: res.diagnostics.map((d) => `${d.code} ${d.message}`) };
  const mod = new WebAssembly.Module(await readFile(res.binaryPath));
  return { ok: true, imports: WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`) };
}

describe("INC-28 U1 child_process — host-free rows", () => {
  test("N-PRE-0 a module that reaches no child_process key imports no cpCall — SINGLE-EDIT: cpCall minted unconditionally", async () => {
    const r = await build('console.log("no child here");\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toContain("tsinter.write");
    expect(r.imports).not.toContain("tsinter.cpCall");
  });

  // PRESCAN: one host-free module per spawnSync key — none touches
  // process.env/argv/cwd/platform/os.*/path.resolve, so hostStr and hostNum
  // can only come from the key itself (its child receives the module's
  // own environment map).
  const prescanRows: [string, string, string][] = [
    ["N-PRE-1", "cp.spawnSync", 'import { spawnSync } from "node:child_process";\nconsole.log(spawnSync("true").status);\n'],
    ["N-PRE-2", "cp.spawnSyncOpts", 'import { spawnSync } from "node:child_process";\nconsole.log(spawnSync("true", [], { timeout: 1000 }).status);\n'],
    ["N-PRE-3", "cp.spawnSyncStdioStr", 'import { spawnSync } from "node:child_process";\nconst s: "pipe" | "ignore" = Math.random() > 2 ? "ignore" : "pipe";\nconsole.log(spawnSync("true", [], { stdio: s }).status);\n'],
    ["N-PRE-4", "cp.execSync", 'import { execSync } from "node:child_process";\nconsole.log(execSync("true", { encoding: "utf8" }));\n'],
    ["N-PRE-5", "cp.execCapture", 'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nasync function main(): Promise<void> {\n  const { stdout } = await run("true", []);\n  console.log(stdout);\n}\nmain();\n'],
  ];
  for (const [id, key, src] of prescanRows) {
    test(`${id} a module reaching only ${key} imports hostStr, hostNum and cpCall — SINGLE-EDIT: ${key} dropped from one of the three prescans`, async () => {
      const r = await build(src);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.imports).toEqual(expect.arrayContaining(["tsinter.hostStr", "tsinter.hostNum", "tsinter.cpCall"]));
    });
  }

  test("N-LOCK-01 a spawnSync result captured by a closure and passed as a parameter compiles to a valid module (mapType and mapTypeSoft agree on spawnRes) — SINGLE-EDIT: mapTypeSoft's spawnRes arm removed", async () => {
    const r = await build(
      'import { spawnSync } from "node:child_process";\nfunction make() { return spawnSync("/bin/echo", ["x"], { encoding: "utf8" }); }\ntype R = ReturnType<typeof make>;\nfunction show(r: R): string { return r.stdout; }\nconst r = make();\nconst later = (): string => r.stdout;\nconsole.log(show(r), later());\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  test("N-LOCK-02 a spawnSync result as a union arm (`x || spawnSync()`, `c ? undefined : spawnSync()`) compiles — SINGLE-EDIT: mapType's spawnRes arm removed", async () => {
    const r = await build(
      'import { spawnSync } from "node:child_process";\nconst none: ReturnType<typeof spawnSync> | undefined = undefined;\nconst a = none || spawnSync("true");\nconst b = Math.random() > 2 ? undefined : spawnSync("true");\nconsole.log(a.status, b?.status);\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  test("N-NL-01 (re-aimed at INC-28 U3, which lifts piped output) child.unref in a module that pipes a child's output stays refused by key: SC3001 (libCall:child.unref:pipe) — SINGLE-EDIT: the unref-in-a-pipe-module refusal removed", async () => {
    const r = await build('import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: ["ignore", "pipe", "pipe"] });\nc.unref();\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.join("\n")).toContain("(libCall:child.unref:pipe)");
  });

  test("N-NL-02 (re-aimed at INC-28 U3, which lifts child.stdout, then at unit H, which lifts TextDecoder's decode, then at the zlib unit, which lifts deflateSync) inspecting a qs.parse result stays refused by key: SC3001 (libCall:qs.parse:null-proto-inspect) — SINGLE-EDIT: the null-prototype inspect refusal removed", async () => {
    const r = await build('import { parse } from "node:querystring";\nconsole.log(parse("a=1&b=2"));\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.join("\n")).toContain("(libCall:qs.parse:null-proto-inspect)");
  });

  test("N-NL-03 (re-aimed at INC-28 U3, which lifts the stream listeners) a piped STDIN stays refused by the front end, every lane — SINGLE-EDIT: the stdin pipe fence removed", async () => {
    const r = await build('import { spawn } from "node:child_process";\nconst c = spawn("cat", [], { stdio: ["pipe", "pipe", "ignore"] });\nc.on("exit", () => console.log("done"));\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.join("\n")).toContain('spawn with stdio: "pipe"');
  });

  test("N-SHAPE-01 the exec-options record path (a typed options const, runtime stdio modes) compiles for wasm — SINGLE-EDIT: the cp.execSync arm removed", async () => {
    const r = await build('import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";\nconst o: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], timeout: 100 };\nconsole.log(execFileSync("/bin/echo", ["x"], o));\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  test("N-SHAPE-02 the conditional env spread (a ternary of two calls) compiles for wasm — SINGLE-EDIT: the cp.execSync arm removed", async () => {
    const r = await build('import { execFileSync } from "node:child_process";\nconst x: Record<string, string> | null = Math.random() > 2 ? { Z: "1" } : null;\nconsole.log(execFileSync("/usr/bin/env", [], { encoding: "utf8", ...(x ? { env: { ...process.env, ...x } } : {}) }).length > 0);\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  test("N-SHAPE-03 the promisified execFile helper with a conditional env compiles for wasm — SINGLE-EDIT: the cp.execCapture arm removed", async () => {
    const r = await build('import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nasync function main(c: boolean): Promise<void> {\n  const { stdout } = await run("/bin/echo", ["x"], { cwd: "/", timeout: 10, ...(c ? { env: { A: "1" } } : {}) });\n  console.log(stdout);\n}\nmain(true);\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  /** Compiles `src` for one backend; "ok" or the diagnostics as
   * "<code> <message>". The native backends build a real binary. */
  async function buildLane(src: string, backend: "wasm" | "c" | "llvm"): Promise<string> {
    const file = join(scratch, `p${seq++}.ts`);
    await writeFile(file, src);
    const out = backend === "wasm" ? `${file}.wasm` : `${file}.bin`;
    const res = await compile(file, { outPath: out, outDir: scratch, dynamic: false, backend });
    return res.ok ? "ok" : res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ");
  }
  const fenceMsg = (name: string): string =>
    `SC2020 '${name} without an encoding whose result is used (without an encoding, Node returns a Buffer)' is part of the standard library types but has no scriptc lowering yet`;
  const fenceRows: [string, string, string, string][] = [
    ["N-FENCE-01", "an encoding-less execSync whose result is bound to a const refuses by name on every lane — SINGLE-EDIT: the fence removed", 'import { execSync } from "node:child_process";\nconst out = execSync("echo c");\nconsole.log(out.length);\n', fenceMsg("execSync")],
    ["N-FENCE-02", "an encoding-less execFileSync passed to console.log refuses by name on every lane — SINGLE-EDIT: the fence removed", 'import { execFileSync } from "node:child_process";\nconsole.log(execFileSync("/bin/echo", ["d"]));\n', fenceMsg("execFileSync")],
    ["N-FENCE-03", "an encoding-less execSync with options but no encoding, its result read for .length, refuses by name on every lane — SINGLE-EDIT: the fence keyed on the options object instead of the encoding member", 'import { execSync } from "node:child_process";\nconsole.log(execSync("echo e", { stdio: "pipe" }).length);\n', fenceMsg("execSync")],
    ["N-FENCE-04", "encoding-less calls as statements (incl. parenthesized) compile on every lane — SINGLE-EDIT: the statement allowance removed", 'import { execFileSync, execSync } from "node:child_process";\nexecSync("true");\nexecFileSync("true", [], { stdio: "pipe" });\n(execSync("true", { stdio: "pipe" }));\nconsole.log("statements ran");\n', "ok"],
    ["N-FENCE-05", "an encoding-less call whose result is immediately decoded by .toString() compiles on every lane — SINGLE-EDIT: the .toString() allowance removed", 'import { execFileSync, execSync } from "node:child_process";\nconsole.log(JSON.stringify(execSync("echo c").toString()));\nconsole.log(JSON.stringify((execFileSync("/bin/echo", ["d"], { stdio: "pipe" })).toString()));\n', "ok"],
    ["N-FENCE-06", ".toString(\"utf8\") on an encoding-less call is refused by the type checker on every lane (the tier's child_process declarations type the result as a string) — SINGLE-EDIT: the declarations changed", 'import { execSync } from "node:child_process";\nconsole.log(JSON.stringify(execSync("echo c").toString("utf8")));\n', "SC0001 Expected 0 arguments, but got 1."],
    ["N-FENCE-07", "an encoding-less execSync with stdio \"inherit\" decoded by .toString() refuses by name on every lane (Node returns null there; Node prints \"to-inherit\" then \"T1 threw Cannot read properties of null (reading 'toString')\") — SINGLE-EDIT: the captured-stdout condition on the .toString() allowance removed", "import { execSync } from \"node:child_process\";\ntry {\n  const s = execSync(\"echo to-inherit\", { stdio: \"inherit\" }).toString();\n  console.log(\"T1\", JSON.stringify(s));\n} catch (e) {\n  console.log(\"T1 threw\", e instanceof Error ? e.message : \"?\");\n}\n", fenceMsg("execSync")],
    ["N-FENCE-08", "an encoding-less execFileSync with stdio \"ignore\" decoded by .toString() refuses by name on every lane (Node prints \"T2 threw Cannot read properties of null (reading 'toString')\") — SINGLE-EDIT: the captured-stdout condition on the .toString() allowance removed", "import { execFileSync } from \"node:child_process\";\ntry {\n  const s = execFileSync(\"/bin/echo\", [\"to-ignore\"], { stdio: \"ignore\" }).toString();\n  console.log(\"T2\", JSON.stringify(s));\n} catch (e) {\n  console.log(\"T2 threw\", e instanceof Error ? e.message : \"?\");\n}\n", fenceMsg("execFileSync")],
    ["N-FENCE-09", "an encoding-less execSync whose stdio tuple inherits fd 1, decoded by .toString(), refuses by name on every lane (Node prints \"tuple-inherit\" then \"T3 threw Cannot read properties of null (reading 'toString')\") — SINGLE-EDIT: the captured-stdout condition read from the whole-stdio string only", "import { execSync } from \"node:child_process\";\ntry {\n  const s = execSync(\"echo tuple-inherit\", { stdio: [\"pipe\", \"inherit\", \"pipe\"] }).toString();\n  console.log(\"T3\", JSON.stringify(s));\n} catch (e) {\n  console.log(\"T3 threw\", e instanceof Error ? e.message : \"?\");\n}\n", fenceMsg("execSync")],
    ["N-FENCE-10", "an encoding-less execSync whose stdio tuple pipes fd 1 (other fds ignore/inherit), decoded by .toString(), compiles on every lane (Node prints T4 \"tuple-pipe\\n\") — SINGLE-EDIT: the captured-stdout condition keyed on fd 0 or fd 2", "import { execSync } from \"node:child_process\";\nconst s = execSync(\"echo tuple-pipe\", { stdio: [\"ignore\", \"pipe\", \"inherit\"] }).toString();\nconsole.log(\"T4\", JSON.stringify(s));\n", "ok"],
    ["N-FENCE-11", "an encoding-less execSync as the operand of void compiles on every lane (Node prints \"done\") — SINGLE-EDIT: the void operand not treated as discarded", "import { execSync, execFileSync } from \"node:child_process\";\nvoid execSync(\"echo a\");\nconsole.log(\"done\");\n", "ok"],
    ["N-FENCE-12", "an encoding-less execSync under `as string`, decoded by .toString(), compiles on every lane (Node prints \"a\\n\" quoted) — SINGLE-EDIT: `as` not looked through", "import { execSync, execFileSync } from \"node:child_process\";\nconst s = (execSync(\"echo a\") as string).toString();\nconsole.log(JSON.stringify(s));\n", "ok"],
    ["N-FENCE-13", "an encoding-less execSync under a non-null `!`, decoded by .toString(), compiles on every lane (Node prints \"a\\n\" quoted) — SINGLE-EDIT: `!` not looked through", "import { execSync, execFileSync } from \"node:child_process\";\nconst s = execSync(\"echo a\")!.toString();\nconsole.log(JSON.stringify(s));\n", "ok"],
    ["N-FENCE-14", "an encoding-less execSync under `satisfies string` as a statement compiles on every lane (Node prints \"done\") — SINGLE-EDIT: `satisfies` not looked through", "import { execSync, execFileSync } from \"node:child_process\";\nexecSync(\"echo a\") satisfies string;\nconsole.log(\"done\");\n", "ok"],
    ["N-FENCE-15", "an encoding-less execSync as the operand of an await statement compiles on every lane (Node prints \"done\") — SINGLE-EDIT: an await operand not treated as discarded when the await is", "import { execSync, execFileSync } from \"node:child_process\";\nasync function m(): Promise<void> { await execSync(\"echo a\"); console.log(\"done\"); }\nm();\n", "ok"],
    ["N-FENCE-16", "encoding-less execSync calls as both branches of a conditional statement compile on every lane (Node prints \"done\") — SINGLE-EDIT: a conditional branch not treated as discarded when the conditional is", "import { execSync, execFileSync } from \"node:child_process\";\nconst c = process.argv.length > 0;\nc ? execSync(\"echo a\") : execSync(\"echo b\");\nconsole.log(\"done\");\n", "ok"],
  ];
  for (const [id, title, src, expected] of fenceRows) {
    test(`${id} ${title}`, async () => {
      for (const backend of ["wasm", "c", "llvm"] as const) {
        expect(`${backend}: ${await buildLane(src, backend)}`).toBe(`${backend}: ${expected}`);
      }
    }, 300_000);
  }

  // SEMANTICS.md S118: the module keeps names only (os-names.ts); the
  // numbers are the host's (hostNum kinds 16/17)
  test("N-MAP-01 the errno-name table equals Node's own util.getSystemErrorMap() names, entry for entry — SINGLE-EDIT: one table entry altered", () => {
    expect(ERRNO_NAMES.map(([name]) => name)).toEqual([...getSystemErrorMap().values()].map(([name]) => name));
  });

  test("N-MAP-02 the signal-name table reads each number back as its FIRST os.constants.signals name — SINGLE-EDIT: a name shifted by one", () => {
    const first = new Map<number, string>();
    for (const [name, n] of Object.entries(osConstants.signals as Record<string, number>)) if (!first.has(n)) first.set(n, name);
    const sigs = osConstants.signals as Record<string, number | undefined>;
    const firstByList = new Map<number, string>();
    for (const name of SIGNAL_NAMES) {
      const n = sigs[name];
      if (n !== undefined && !firstByList.has(n)) firstByList.set(n, name);
    }
    expect([...firstByList].sort((a, b) => a[0] - b[0])).toEqual([...first].sort((a, b) => a[0] - b[0]));
  });
});
