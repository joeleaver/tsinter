/* INC-29 U1 — node:net on the WasmGC tier: the HOST-FREE rows. Each row
 * compiles a small program and reads the result (the import and export
 * sections, a refusal and its key); the rows that run a module use the
 * shared host of wasm-host.ts, whose loud netCall stub proves where the
 * module first reached the host. Rows that open real sockets live in
 * tests/harness/wasm-differential.test.ts ("INC-29 U1 node:net rows");
 * rows that script netCall and evPoll live in wasm-host-net-u1.test.ts.
 * Every row names the single edit that would make it fail. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-net-u1-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
type Built = { ok: true; path: string; imports: string[]; exports: string[] } | { ok: false; diagnostics: string[]; survey: string[] };

/** Compiles `src` (`ext` its file kind) for the wasm backend: the module's
 * import and export names when it builds, else the diagnostics and the
 * survey. */
async function build(src: string, ext = "ts"): Promise<Built> {
  const file = join(scratch, `p${seq++}.${ext}`);
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

/** The refusal key a build answers with (its first SC3001's construct). */
function refusalKey(r: Built): string | null {
  if (r.ok) return null;
  const m = /\(([^)]+)\)/.exec(r.diagnostics[0] ?? "");
  return m?.[1] ?? null;
}

describe("INC-29 U1 node:net — host-free rows", () => {
  // PRESCAN: a module reaching a net key that can start host I/O is an
  // event module: it imports the clock, evPoll and netCall (netCall last)
  // and exports _loop instead of _tick, though the source arms no timer.
  const ioRows: [string, string, string][] = [
    ["N1-PS-01", "net.createServer", 'import * as net from "node:net";\nconst s = net.createServer();\ns.on("close", () => console.log("closed"));\n'],
    ["N1-PS-02", "net.connect", 'import * as net from "node:net";\nconst c = net.connect(1, "127.0.0.1");\nc.on("error", () => console.log("e"));\n'],
    ["N1-PS-03", "net.createServerCb + net.listenCb", 'import * as net from "node:net";\nconst s = net.createServer((sock) => sock.destroy());\ns.listen(0, () => s.close());\n'],
  ];
  for (const [id, key, src] of ioRows) {
    test(`${id} a module reaching ${key} imports now, evPoll and netCall (last) and exports _loop, not _tick — SINGLE-EDIT: the net prescan dropped from the now / evPoll / netCall decisions`, async () => {
      const r = await build(src);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.imports).toEqual(["tsinter.write", "tsinter.now", "tsinter.hostNum", "tsinter.evPoll", "tsinter.netCall"]);
      expect(r.exports).toContain("_loop");
      expect(r.exports).not.toContain("_tick");
    });
  }
  test("N1-PS-04 the attempt-budget pair alone never reaches the host: no now, evPoll or netCall import, no _loop — SINGLE-EDIT: net.getAutoSelTimeout / net.setAutoSelTimeout taken out of the prescan's pure set", async () => {
    const r = await build('import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";\nsetDefaultAutoSelectFamilyAttemptTimeout(42);\nconsole.log(getDefaultAutoSelectFamilyAttemptTimeout());\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toEqual(["tsinter.write"]);
    expect(r.exports).not.toContain("_loop");
    const out = await runWasm(r.path);
    expect(out.stdout).toBe("42\n");
  });
  test("N1-PS-05 a string literal that spells a net key does not make an event module — SINGLE-EDIT: the prescan scanning every string instead of libCall nodes", async () => {
    const r = await build('console.log("net.createServer");\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toEqual(["tsinter.write"]);
  });
  test("N1-PS-06 a net module run with no forced host fails at its first netCall (LISTEN), loudly — SINGLE-EDIT: wasm-host.ts's netCall stub answering instead of throwing", async () => {
    const r = await build('import * as net from "node:net";\nconst s = net.createServer();\ns.listen(0);\nconsole.log("after listen (never)");\n');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    await expect(runWasm(r.path)).rejects.toThrow("netCall: op 1 reached with no forced host");
  });

  // NOT LIFTED: each refuses under its own key, never a silent fallback.
  const refusals: [string, string, string, string?][] = [
    ["N1-NL-01", "libCall:net.sockSetEncoding", 'import * as net from "node:net";\nconst c = net.connect(1, "127.0.0.1");\nc.setEncoding("utf8");\n'],
    ["N1-NL-02", "libCall:net.sockSetTimeout", 'import * as net from "node:net";\nconst c = net.connect(1, "127.0.0.1");\nc.setTimeout(100);\n'],
    ["N1-NL-03", "libCall:net.sockPipe", 'import * as net from "node:net";\nconst a = net.connect(1, "127.0.0.1");\nconst b = net.connect(2, "127.0.0.1");\na.pipe(b);\n'],
    ["N1-NL-04", "libCall:net.serverAddress", 'import * as net from "node:net";\nconst s = net.createServer();\ns.listen(0, () => {\n  const a = s.address();\n  console.log(a.family);\n});\n'],
    ["N1-NL-05", "libCall:net.sockOnReadable", 'import * as net from "node:net";\nconst c = net.connect(1, "127.0.0.1");\nc.on("readable", () => console.log("r"));\n'],
    ["N1-NL-06", "libCall:net.sockRead", 'import * as net from "node:net";\nconst c = net.connect(1, "127.0.0.1");\nc.on("connect", () => {\n  const b = c.read(1);\n  if (b !== null) console.log(b.length);\n});\n'],
    ["N1-NL-07", "libCall:net.serverCloseCb:override", 'import * as net from "node:net";\nconst s = net.createServer();\nconst orig = s.close.bind(s);\ns.close = function (cb?: () => void) {\n  return orig(cb);\n} as typeof s.close;\ns.close(() => console.log("closed"));\n'],
    ["N1-NL-08", "libCall:net:with-spawn", 'import * as net from "node:net";\nimport { spawn } from "node:child_process";\nspawn("true", [], { stdio: "ignore" });\nnet.createServer();\n'],
    // INC-29 U4 lifted net.serverOnSecureConnection (tls.ts); a TLS
    // socket's 'session' listener still refuses.
    ["N1-NL-09", "libCall:tls.sockOnSession", 'import * as tls from "node:tls";\nconst c = tls.connect(1, "127.0.0.1", {});\nc.on("session", (s) => console.log(s.length));\n'],
    ["N1-NL-10", "libCall:net.sockOnTimeout", 'import * as net from "node:net";\nconst c = net.connect(1, "127.0.0.1");\nc.on("timeout", () => console.log("t"));\n'],
  ];
  for (const [id, key, src, ext] of refusals) {
    test(`${id} ${key} refuses by its own key — SINGLE-EDIT: the key lifted without its machinery`, async () => {
      const r = await build(src, ext);
      expect(r.ok, JSON.stringify(r)).toBe(false);
      expect(refusalKey(r)).toBe(key);
      if (!r.ok) expect(r.survey).toContain(key);
    });
  }
});
