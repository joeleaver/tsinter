/* INC-28 U2 — child_process's asynchronous surface on the WasmGC tier: the
 * HOST-FREE rows. Each row compiles a small program and reads the result
 * (the import and export sections, a refusal, a build check); the one row
 * that runs a module uses the shared host of wasm-host.ts, whose loud
 * cpCall and evPoll stubs prove the module never reached either. Rows that
 * run a real child live in tests/harness/wasm-differential.test.ts
 * ("INC-28 U2 child_process async rows"); rows that script cpCall and
 * evPoll live in wasm-host-cp-u2.test.ts. Every row names the single edit
 * that would make it fail. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-childproc-u2-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
type Built = { ok: true; path: string; imports: string[]; exports: string[] } | { ok: false; diagnostics: string[]; survey: string[] };

/** Compiles `src` for the wasm backend: the module's import and export
 * names when it builds, else the diagnostics and the survey. */
async function build(src: string): Promise<Built> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) return { ok: false, diagnostics: res.diagnostics.map((d) => `${d.code} ${d.message}`), survey: res.wasmSurvey ?? [] };
  const mod = new WebAssembly.Module(await readFile(res.binaryPath));
  return {
    ok: true,
    path: res.binaryPath,
    imports: WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`),
    exports: WebAssembly.Module.exports(mod).map((e) => e.name),
  };
}

describe("INC-28 U2 child_process async — host-free rows", () => {
  // PRESCAN: an event module (cp.spawn or cp.spawnOpts, exact names)
  // imports the clock, the environment pair, cpCall and evPoll — evPoll
  // last — and exports _loop instead of _tick. Neither source touches
  // process.env, a timer or a clock itself.
  const eventRows: [string, string, string][] = [
    ["U2-PS-01", "cp.spawn", 'import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: "ignore" });\nc.on("exit", () => console.log("done"));\n'],
    ["U2-PS-02", "cp.spawnOpts", 'import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: "ignore", detached: true });\nc.on("exit", () => console.log("done"));\n'],
  ];
  for (const [id, key, src] of eventRows) {
    test(`${id} a module reaching only ${key} imports now, hostStr, hostNum, cpCall and evPoll (last) and exports _loop, not _tick — SINGLE-EDIT: ${key} dropped from one of the five prescans`, async () => {
      const r = await build(src);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.imports).toEqual(["tsinter.write", "tsinter.now", "tsinter.hostStr", "tsinter.hostNum", "tsinter.cpCall", "tsinter.evPoll"]);
      expect(r.exports).toContain("_loop");
      expect(r.exports).not.toContain("_tick");
    });
  }
  test("U2-PS-03 a spawnSync-only module is not an event module: no evPoll, no now, no _loop — SINGLE-EDIT: the event prescan matched cp.spawn as a prefix", async () => {
    const r = await build('import { spawnSync } from "node:child_process";\nconsole.log(spawnSync("true").status);\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toEqual(["tsinter.write", "tsinter.hostStr", "tsinter.hostNum", "tsinter.cpCall"]);
    expect(r.exports).not.toContain("_loop");
    expect(r.exports).not.toContain("_tick");
  });
  test("U2-PS-04 a timers-only module keeps _tick and imports no cpCall or evPoll — SINGLE-EDIT: _loop exported for every timer module", async () => {
    const r = await build('setTimeout(() => console.log("t"), 5);\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toEqual(["tsinter.write", "tsinter.now"]);
    expect(r.exports).toContain("_tick");
    expect(r.exports).not.toContain("_loop");
  });
  test("U2-PS-05 child.kill and child.unref reachable through a ChildProcess parameter while spawn sits only in an unreachable function: cpCall minted, evPoll and _loop absent — SINGLE-EDIT: child.kill and child.unref dropped from the cpCall prescan", async () => {
    const r = await build(
      'import { spawn, type ChildProcess } from "node:child_process";\nfunction never(): ChildProcess {\n  return spawn("true", [], { stdio: "ignore" });\n}\nfunction drop(c: ChildProcess): void {\n  c.kill("SIGTERM");\n  c.unref();\n}\nconst none: ChildProcess[] = [];\nfor (const c of none) drop(c);\nconsole.log("no child", typeof never);\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toContain("tsinter.cpCall");
    expect(r.imports).not.toContain("tsinter.evPoll");
    expect(r.exports).not.toContain("_loop");
  });

  // One ChildProcess member each, reached through a parameter while spawn
  // sits only in an unreachable function: that member alone mints cpCall.
  const memberRows: [string, string, string, string][] = [
    ["U2-PS-06", "child.kill", "kill with a signal name", "import { spawn, type ChildProcess } from \"node:child_process\";\nfunction never(): ChildProcess {\n  return spawn(\"true\", [], { stdio: \"ignore\" });\n}\nfunction drop(c: ChildProcess): void {\n  c.kill(\"SIGTERM\");\n}\nconst none: ChildProcess[] = [];\nfor (const c of none) drop(c);\nconsole.log(\"no child\", typeof never);\n"],
    ["U2-PS-07", "child.unref", "unref", "import { spawn, type ChildProcess } from \"node:child_process\";\nfunction never(): ChildProcess {\n  return spawn(\"true\", [], { stdio: \"ignore\" });\n}\nfunction drop(c: ChildProcess): void {\n  c.unref();\n}\nconst none: ChildProcess[] = [];\nfor (const c of none) drop(c);\nconsole.log(\"no child\", typeof never);\n"],
    ["U2-PS-08", "child.killNum", "kill with a signal number", "import { spawn, type ChildProcess } from \"node:child_process\";\nfunction never(): ChildProcess {\n  return spawn(\"true\", [], { stdio: \"ignore\" });\n}\nfunction drop(c: ChildProcess): void {\n  c.kill(9);\n}\nconst none: ChildProcess[] = [];\nfor (const c of none) drop(c);\nconsole.log(\"no child\", typeof never);\n"],
  ];
  for (const [id, key, what, src] of memberRows) {
    test(`${id} ${what} (${key}) reachable through a ChildProcess parameter, with spawn only in an unreachable function: cpCall minted, evPoll and _loop absent — SINGLE-EDIT: ${key} dropped from the cpCall prescan`, async () => {
      const r = await build(src);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.imports).toContain("tsinter.cpCall");
      expect(r.imports).not.toContain("tsinter.evPoll");
      expect(r.exports).not.toContain("_loop");
    });
  }

  // NOT-LIFTED: the stream half and the signal listeners stay refused by
  // key; inherited and fd outputs refuse by their own keys until the
  // host's stream capture routes them.
  const refusals: [string, string, string][] = [
    ["U2-NL-01", "libCall:cp.spawnOpts:pipe", 'import { spawn } from "node:child_process";\nspawn("true", [], { stdio: ["ignore", "pipe", "pipe"] });\n'],
    ["U2-NL-02", "libCall:child.stdout", 'import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: "ignore" });\nconsole.log(c.stdout === null);\n'],
    ["U2-NL-04", "libCall:process.onSignal", 'process.on("SIGINT", () => console.log("int"));\nconsole.log("armed");\n'],
  ];
  for (const [id, key, src] of refusals) {
    test(`${id} stays refused by key: SC3001 (${key}) — SINGLE-EDIT: the ${key} refusal removed`, async () => {
      const r = await build(src);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.diagnostics.join("\n")).toContain(`(${key})`);
    });
  }
  // Inherited and fd outputs, refused by their own keys until the host's
  // stream capture routed them, now compile (the rows that flipped).
  const lifted: [string, string, string][] = [
    ["U2-NL-05", "inherit", 'import { spawn } from "node:child_process";\nconst c = spawn("/bin/echo", ["x"], { stdio: "inherit" });\nc.on("exit", () => console.log("done"));\n'],
    ["U2-NL-06", "an fd tuple", 'import { spawn } from "node:child_process";\nconst c = spawn("/bin/echo", ["x"], { stdio: ["ignore", 2, "ignore"] });\nc.on("exit", () => console.log("done"));\n'],
  ];
  for (const [id, what, src] of lifted) {
    test(`${id} spawn with ${what} stdio compiles to an event module — SINGLE-EDIT: the stdio mode refused again`, async () => {
      const r = await build(src);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.exports).toContain("_loop");
    });
  }

  test("U2-SH-01 the lowering's shapes compile: exit listeners with 0, 1 and 2 parameters, error listeners with 0 and 1, an error listener on a union-narrowed receiver, a detached ternary, an env object and process.env, a cwd and fds held in variables — SINGLE-EDIT: the onError arm removed", async () => {
    const r = await build(
      'import { spawn, type ChildProcess } from "node:child_process";\nimport { openSync } from "node:fs";\nconst fd = openSync("/dev/null", "w");\nconst dir = "/tmp";\nconst flag = process.argv.length > 99;\nconst a = spawn("true", [], { stdio: ["ignore", fd, fd], cwd: dir, env: { K: "v" }, ...(flag ? {} : { detached: true }) });\na.on("exit", () => console.log("e0"));\na.on("exit", (code) => console.log("e1", code));\na.on("exit", (code, signal) => console.log("e2", code, signal));\na.on("error", () => console.log("r0"));\na.on("error", (e) => console.log("r1", e.message));\nconst m = new Map<string, ChildProcess>([["b", spawn("true", [], { stdio: "ignore", env: process.env })]]);\nconst b = m.get("b");\nif (b) b.on("error", () => console.log("r2"));\nconsole.log(a.pid !== undefined, a.exitCode, a.killed);\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  test("U2-NL-03 a stdout data listener stays refused: the survey names libCall:stream.onData — SINGLE-EDIT: a stream.onData arm added", async () => {
    const r = await build('import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: "ignore" });\nc.stdout!.on("data", (d: Buffer) => console.log(d.length));\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.survey).toContain("libCall:stream.onData");
  });

  test("U2-LS-01 a ChildProcess captured by a closure, held in an array and a Map, passed and returned compiles to a valid module (mapType, mapTypeSoft and its array-element list agree on child) — SINGLE-EDIT: mapTypeSoft's child arm removed", async () => {
    const r = await build(
      'import { spawn, type ChildProcess } from "node:child_process";\nfunction start(): ReturnType<typeof spawn> {\n  return spawn("true", [], { stdio: "ignore" });\n}\nfunction watch(c: ChildProcess, name: string): void {\n  c.on("exit", (code) => console.log(name, code));\n}\nconst all: ChildProcess[] = [];\nconst byName = new Map<string, ChildProcess>();\nfor (const n of ["a", "b"]) {\n  const c = start();\n  all.push(c);\n  byName.set(n, c);\n  const later = (): void => watch(c, n);\n  later();\n}\nconst a = byName.get("a");\nif (a) a.unref();\nconsole.log(all.length, byName.size);\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  test("U2-MT-01 spawn's validation throw reaches a caller two functions up, with no other try or rejection handler in the module; the catch's own cast marks only the caller (the may-throw analysis reads cp.spawn as throwing) — SINGLE-EDIT: cp.spawn dropped from the may-throw copy", async () => {
    const r = await build(
      'import { spawn } from "node:child_process";\nfunction start(file: string): void {\n  spawn(file, [], { stdio: "ignore" });\n  console.log("not reached");\n}\nfunction guarded(): void {\n  try {\n    start("");\n  } catch (e) {\n    console.log("caught", (e as Error).message);\n  }\n}\nguarded();\nconsole.log("after");\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const run = await runWasm(r.path);
    expect(run.stdout).toBe("caught The argument 'file' cannot be empty. Received ''\nafter\n");
    expect(run.exitCode).toBe(0);
  });
});
