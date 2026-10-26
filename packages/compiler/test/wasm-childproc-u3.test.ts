/* INC-28 U3 — child output streams on the WasmGC tier: the HOST-FREE rows.
 * Each row compiles a small program and reads the result (the import and
 * export sections, the function names, a refusal, a build check) — no row
 * runs a module. Rows that run a real child live in
 * tests/harness/wasm-differential.test.ts ("INC-28 U3 child output stream
 * rows"); rows that script cpCall and evPoll live in wasm-host-cp-u3.test.ts;
 * string_decoder's rows (Node as the judge) in wasm-strdec-u3.test.ts. Every
 * row names the single edit that would make it fail. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-childproc-u3-"));
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

/** The module's bytes (its name section names every helper). */
async function moduleBytes(src: string): Promise<Buffer> {
  const r = await build(src);
  if (!r.ok) throw new Error(`refused: ${r.diagnostics.join("; ")}`);
  return readFile(r.path);
}

const PIPED = 'import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: ["ignore", "pipe", "pipe"] });\n';

describe("INC-28 U3 child output streams — host-free rows", () => {
  test("U3-PS-01 a module that pipes a child's output is an event module with U2's imports — write, now, hostStr, hostNum, cpCall, evPoll (last) — and exports _loop — SINGLE-EDIT: a new import minted for streams", async () => {
    const r = await build(PIPED + 'c.stdout?.on("data", (d: Buffer) => console.log(d.length));\nc.stderr?.on("end", () => console.log("end"));\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toEqual(["tsinter.write", "tsinter.now", "tsinter.hostStr", "tsinter.hostNum", "tsinter.cpCall", "tsinter.evPoll"]);
    expect(r.exports).toContain("_loop");
  });
  test("U3-PS-02 a stream 'data' listener reachable through a ChildProcess parameter while spawn sits only in an unreachable function mints cpCall (FLOW), not evPoll — SINGLE-EDIT: stream.onData dropped from the cpCall prescan", async () => {
    const r = await build(
      'import { spawn, type ChildProcess } from "node:child_process";\nfunction never(): ChildProcess {\n  return spawn("true", [], { stdio: ["ignore", "pipe", "ignore"] });\n}\nfunction watch(c: ChildProcess): void {\n  c.stdout?.on("data", (d: Buffer) => console.log(d.length));\n}\nconst none: ChildProcess[] = [];\nfor (const c of none) watch(c);\nconsole.log("no child", typeof never);\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toContain("tsinter.cpCall");
    expect(r.imports).not.toContain("tsinter.evPoll");
    expect(r.exports).not.toContain("_loop");
  });
  test("U3-PS-03 a U2-shaped module (no piped slot, no stream member) carries none of U3's machinery: no stream helper and no pipe poll in its bytes, while a piped module carries them — SINGLE-EDIT: the pipe prescan answers true for every event module", async () => {
    const u2 = await moduleBytes('import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: "ignore" });\nc.on("exit", (code) => console.log("exit", code));\n');
    const u3 = await moduleBytes(PIPED + 'c.stdout?.on("end", () => console.log("end"));\n');
    for (const name of ["%w.cpa.streamNew", "%w.cpa.flushTick", "%w.cpa.streamEnd", "%w.cpa.maybeRelease"]) {
      expect(u2.includes(Buffer.from(name)), name).toBe(false);
      expect(u3.includes(Buffer.from(name)), name).toBe(true);
    }
  });
  test("U3-PS-04 string_decoder alone is not an event module: no cpCall, no evPoll, no _loop, and none of the child helpers — SINGLE-EDIT: strdec routed through the child builder", async () => {
    const r = await build('import { StringDecoder } from "node:string_decoder";\nconst d = new StringDecoder("utf8");\nconsole.log(d.write(Buffer.from([0xe2, 0x82])), d.end());\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toEqual(["tsinter.write"]);
    expect(r.exports).not.toContain("_loop");
  });

  // NOT-LIFTED: what U3 leaves refused, each loud.
  const wasmKeys: [string, string, string][] = [
    ["U3-NL-01", "libCall:child.unref:pipe", PIPED + "c.unref();\n"],
    ["U3-NL-02", "libCall:child.unref:pipe", 'import { spawn } from "node:child_process";\nconst a = spawn("true", [], { stdio: ["ignore", "pipe", "ignore"] });\nconst b = spawn("true", [], { stdio: "ignore" });\nb.unref();\na.stdout?.on("end", () => console.log("end"));\n'],
    // Re-aimed at zlib by unit H, which lifts TextDecoder's decode.
    // re-aimed by the zlib unit, which lifts deflateSync
    ["U3-NL-03", "libCall:qs.parse:null-proto-inspect", 'import { parse } from "node:querystring";\nconsole.log(parse("a=1&b=2"));\n'],
    ["U3-NL-13", "libCall:cp.spawnOpts:pipeMixed", 'import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: ["ignore", "pipe", "inherit"] });\nc.on("exit", () => console.log("exit"));\n'],
    ["U3-NL-14", "libCall:cp.spawnOpts:pipeMixed", 'import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: ["ignore", 1, "pipe"] });\nc.on("exit", () => console.log("exit"));\n'],
  ];
  for (const [id, key, src] of wasmKeys) {
    test(`${id} stays refused by key: SC3001 (${key}) — SINGLE-EDIT: the ${key} refusal removed`, async () => {
      const r = await build(src);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.diagnostics.join("\n")).toContain(`(${key})`);
    });
  }
  const frontEnd: [string, string, string, string][] = [
    ["U3-NL-04", "setEncoding", PIPED + 'c.stdout?.setEncoding("utf8");\n', "ReadableStream.setEncoding"],
    ["U3-NL-05", "a piped stdin", 'import { spawn } from "node:child_process";\nconst c = spawn("cat", [], { stdio: ["pipe", "pipe", "ignore"] });\nc.on("exit", () => console.log("done"));\n', 'spawn with stdio: "pipe"'],
    ["U3-NL-06", "the default (all-pipe) stdio", 'import { spawn } from "node:child_process";\nconst c = spawn("true", []);\nc.on("exit", () => console.log("done"));\n', "spawn without"],
    ["U3-NL-07", "pause", PIPED + "c.stdout?.pause();\n", "pause"],
    ["U3-NL-08", "resume", PIPED + "c.stdout?.resume();\n", "resume"],
    ["U3-NL-09", "pipe", PIPED + "c.stdout?.pipe(process.stdout);\n", "pipe"],
    ["U3-NL-10", "a 'readable' listener", PIPED + 'c.stdout?.on("readable", () => {});\n', "readable"],
    ["U3-NL-11", "a 'close' listener on a stream", PIPED + 'c.stdout?.on("close", () => {});\n', "close"],
    ["U3-NL-12", "async iteration of a stream", PIPED + "for await (const x of c.stdout!) console.log(x);\n", "asyncIterator"],
  ];
  for (const [id, what, src, needle] of frontEnd) {
    test(`${id} ${what} on a child stream stays refused by the front end, every lane — SINGLE-EDIT: the stream surface widened to ${what}`, async () => {
      const r = await build(src);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.diagnostics.join("\n")).toContain(needle);
    });
  }

  test("U3-SH-01 the listener shapes compile: 'data' with no parameter, (chunk: Buffer), (chunk: Buffer | string), on and once, on both streams, through optional chaining, a non-null assertion and a narrowed local; 'end' on and once — SINGLE-EDIT: the Buffer-armed union adapter removed", async () => {
    const r = await build(
      PIPED +
        'const text = (chunk: Buffer | string): void => console.log(chunk.toString());\nc.stdout?.on("data", () => console.log("tick"));\nc.stdout?.on("data", (d: Buffer) => console.log(d.length));\nc.stdout?.once("data", text);\nc.stderr!.on("data", text);\nconst s = c.stderr;\nif (s) s.once("data", (d: Buffer) => console.log(d[0]));\nc.stdout?.on("end", () => console.log("e1"));\nc.stderr?.once("end", () => console.log("e2"));\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  test("U3-LS-01 a stream captured by a closure, held in a local union, passed and returned compiles to a valid module (mapType and mapTypeSoft agree on childStream; arrays and Maps of streams are refused by the front end) — SINGLE-EDIT: mapType's childStream arm removed (mapTypeSoft's arm removed reddens U3-SH-01)", async () => {
    const r = await build(
      PIPED +
        'type Out = NonNullable<typeof c.stdout>;\nfunction pick(o: Out | null): Out | null {\n  return o;\n}\nconst o = pick(c.stdout);\nlet n = 0;\nif (o) {\n  const later = (): void => {\n    o.on("end", () => console.log("end", n));\n  };\n  later();\n  n++;\n}\n',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
