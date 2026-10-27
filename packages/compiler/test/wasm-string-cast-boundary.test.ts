/* Strings unit S2: a string VALUE may be a concatenation node, so the only
 * crossing from a value to the flat `$chars` array is strings.ts
 * emitFlat/emitFlatCast (ropes.ts and strings.ts themselves use
 * code.ts castChars). Three guards pin that:
 *
 *  1. a source lint: no `refCast`/`refCastNull`/`$.cast` naming a string
 *     array type by any of the names the backend gives it, outside
 *     strings.ts and ropes.ts;
 *  2. code.ts refuses a raw ref.cast to the string type while a module is
 *     being emitted (the runtime half — it catches a cast through a
 *     generic type variable the lint cannot see);
 *  3. the review's repro shape compiles: a typed string[] holding a node
 *     crosses into a checked-dynamic box (an http header list) whose
 *     reader used to cast it raw — emitting that reader would now throw
 *     at build time if the cast came back. */
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { Code, setCharsType } from "../src/backend/wasm/code.js";

const wasmDir = join(import.meta.dirname, "../src/backend/wasm");

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-castbound-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("lint: no raw cast to the flat string type outside strings.ts/ropes.ts", () => {
  // The names the backend's builders give the `$chars` type.
  const strName = String.raw`(?:this\.)?(?:deps\.)?(?:strType|strT|charsType|S)(?:\(\))?`;
  const re = new RegExp(String.raw`(?:refCast|refCastNull)\(\s*${strName}\s*\)|\$\.cast\(\s*${strName}\s*,`);
  const hits: string[] = [];
  for (const f of readdirSync(wasmDir)) {
    if (!f.endsWith(".ts") || f === "strings.ts" || f === "ropes.ts") continue;
    readFileSync(join(wasmDir, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(hits).toEqual([]);
});

test("code.ts refuses a raw ref.cast to the string type during an emission; castChars is the sanctioned spelling", () => {
  setCharsType(7);
  try {
    expect(() => new Code().refCast(7)).toThrow(/raw ref\.cast to the flat string type/);
    expect(() => new Code().refCastNull(7)).toThrow(/raw ref\.cast to the flat string type/);
    expect(() => new Code().refCast(8)).not.toThrow();
    expect(() => new Code().castChars(7, true)).not.toThrow();
  } finally {
    setCharsType(null);
  }
  expect(() => new Code().refCast(7)).not.toThrow();
});

test("a node in a typed string[] crossing into a checked-dynamic header list compiles (its reader flattens)", async () => {
  // The review's repro (CommonJS, so the handler's array reaches
  // writeHead through the checked-dynamic surface).
  const entry = join(scratch, "h6.cjs");
  await writeFile(
    entry,
    [
      "'use strict';",
      "const http = require('http');",
      "let v = 'header-value-';",
      "for (let i = 0; i < 5; i++) v += String(i);",
      "function wrap(fn) { return function () { return fn.apply(this, arguments); }; }",
      "const server = http.createServer();",
      "server.on('request', wrap(function (req, res) {",
      "  res.writeHead(200, ['x-a', v]);",
      "  res.end('raw');",
      "}));",
      "server.listen(0, () => server.close());",
      "",
    ].join("\n"),
  );
  const res = await compile(entry, { outPath: join(scratch, "h6.wasm"), outDir: scratch, backend: "wasm" });
  expect(res.ok ? "ok" : res.diagnostics.map((d) => d.message).join(" | ")).toBe("ok");
  if (res.ok) expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
}, 120_000);
