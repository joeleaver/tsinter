/* INC-29 U2 — node:http on the WasmGC tier: the HOST-FREE rows. Each row
 * compiles a small program and reads the result (the import and export
 * sections, a refusal and its key). node:http is built in the module over
 * node:net's host contract (no new host import), so the rows that open
 * real sockets live in tests/harness/wasm-differential.test.ts ("INC-29 U2
 * node:http rows"). Every row names the single edit that would make it
 * fail. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-http-u2-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
type Built = { ok: true; imports: string[]; exports: string[] } | { ok: false; diagnostics: string[]; survey: string[] };

async function build(src: string, ext = "ts"): Promise<Built> {
  const file = join(scratch, `p${seq++}.${ext}`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) return { ok: false, diagnostics: res.diagnostics.map((d) => `${d.code} ${d.message}`), survey: res.wasmSurvey ?? [] };
  const mod = new WebAssembly.Module(await readFile(res.binaryPath));
  return {
    ok: true,
    imports: WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`),
    exports: WebAssembly.Module.exports(mod).map((e) => e.name),
  };
}

function refusalKey(r: Built): string | null {
  if (r.ok) return null;
  const m = /\(([^)]+)\)/.exec(r.diagnostics[0] ?? "");
  return m?.[1] ?? null;
}

describe("INC-29 U2 node:http — host-free rows", () => {
  const ioRows: [string, string, string, string][] = [
    ["H2-PS-01", "http.createServer", 'import * as http from "node:http";\nconst s = http.createServer((req, res) => res.end("x"));\ns.listen(0, () => s.close());\n', "ts"],
    ["H2-PS-02", "http.request", 'import * as http from "node:http";\nconst r = http.request({ host: "127.0.0.1", port: 1, path: "/" });\nr.on("error", () => console.log("e"));\nr.end();\n', "ts"],
    ["H2-PS-03", "new http.Agent", "'use strict';\nconst http = require('http');\nconst a = new http.Agent({ keepAlive: true });\nconsole.log(a.getName({ host: 'h', port: 1 }));\n", "cjs"],
  ];
  for (const [id, key, src, ext] of ioRows) {
    test(`${id} a module reaching ${key} is a node:net event module with the wall clock: it imports write, now, wallClock, evPoll and netCall and nothing else (no new host import), and exports _loop — SINGLE-EDIT: http.* libCalls dropped from the net prescan`, async () => {
      const r = await build(src, ext);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect([...r.imports].sort()).toEqual(["tsinter.evPoll", "tsinter.netCall", "tsinter.now", "tsinter.wallClock", "tsinter.write"]);
      expect(r.imports[r.imports.length - 1]).toBe("tsinter.netCall");
      expect(r.exports).toContain("_loop");
      expect(r.exports).not.toContain("_tick");
    });
  }

  // Out of the unit's scope: each refuses loudly under its own key.
  const refusals: [string, string, string, string][] = [
    // Re-aimed by INC-29 U3, which lifts the http.* URL-argument form: the
    // https spelling (TLS) still refuses by name.
    ["H2-REF-01", "libCall:https.requestUrlCb", 'import * as https from "node:https";\nhttps.get(new URL("https://127.0.0.1:1/"), (res) => res.resume());\n', "ts"],
    ["H2-REF-02", "libCall:https.requestCb", 'import * as https from "node:https";\nhttps.get({ host: "127.0.0.1", port: 1, path: "/" }, (res) => res.resume());\n', "ts"],
    ["H2-REF-03", "libCall:http.serverOnUpgrade", 'import * as http from "node:http";\nconst s = http.createServer();\ns.on("upgrade", (req, sock) => sock.destroy());\n', "ts"],
    ["H2-REF-04", "libCall:http.reqSetEncoding", 'import * as http from "node:http";\nconst s = http.createServer((req, res) => {\n  req.setEncoding("utf8");\n  res.end();\n});\ns.listen(0, () => s.close());\n', "ts"],
  ];
  for (const [id, key, src, ext] of refusals) {
    test(`${id} ${key} refuses with SC3001 under its own key — SINGLE-EDIT: emitHttpLibCall answering the key`, async () => {
      const r = await build(src, ext);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.diagnostics[0]).toMatch(/^SC3001 /);
      expect(refusalKey(r)).toBe(key);
    });
  }

  // Typed IncomingMessage reads that build a string[] or a record: each
  // module must validate (compile() succeeding is not enough — the
  // WebAssembly.Module constructor in build() is the check).
  const shapes: [string, string][] = [
    ["H2-VAL-01 server req.rawHeaders.length", "console.log(req.rawHeaders.length);"],
    ["H2-VAL-02 server JSON.stringify(req.headers)", "console.log(JSON.stringify(req.headers));"],
    ["H2-VAL-03 server Object.keys(req.headers)", "console.log(Object.keys(req.headers).length);"],
  ];
  for (const [id, read] of shapes) {
    test(`${id} builds a module that validates — SINGLE-EDIT: the string[] built over a nullable buffer`, async () => {
      const r = await build(`import * as http from "node:http";\nconst s = http.createServer((req, res) => {\n  ${read}\n  res.end();\n});\ns.listen(0, () => s.close());\n`);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });
    const client = read.replace(/req\./g, "res.");
    test(`${id.replace("server", "client")} (on the client response) builds a module that validates — SINGLE-EDIT: the string[] built over a nullable buffer`, async () => {
      const r = await build(`import * as http from "node:http";\nhttp.get({ host: "127.0.0.1", port: 1, path: "/" }, (res) => {\n  ${client}\n  res.resume();\n}).on("error", () => {});\n`);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });
  }

  test("H2-SET-01 a Set of http servers compiles: its keys are the servers' references (maps.ts's ref key kind) — SINGLE-EDIT: mapKeyRepFor without its netServer arm", async () => {
    const ok = await build('import * as http from "node:http";\nconst s = new Set<ReturnType<typeof http.createServer>>();\ns.add(http.createServer());\nconsole.log(s.size);\n');
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });
});
