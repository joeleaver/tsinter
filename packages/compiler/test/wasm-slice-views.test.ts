/* Strings unit S3: slice views (slices.ts) must never change what a
 * program prints. fixtures/wasm-slice-views.ts exercises every producer
 * (slice / substring / trim* in value and flat position, split pieces,
 * regex rows, global-match and split pieces), views of views, ropes of
 * views and views of ropes, every window reader (charCodeAt / charAt /
 * the string iterator / indexOf / includes / startsWith / endsWith, and
 * the windowed regex matcher: ^, \b, \B, lookbehind, /m, /y, /g with
 * lastIndex, /u at a window edge that splits a surrogate pair), equality,
 * Map / Set / record keys by content, the readers that materialise, a
 * class-field tokenizer, a closure-captured view, a window-shadowed
 * parameter fed views, and views that outlive their parents' bindings
 * under allocation pressure. It runs on the wasm tier and on the
 * wasm-native lane under the collector's stress mode (WN_GC_STRESS: a
 * collection every few allocations — a view's base must be traced), and
 * both must equal Node byte for byte. */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "fixtures", "wasm-slice-views.ts");
const scratch = mkdtempSync(join(tmpdir(), "tsinter-wasm-slice-views-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const node = execFileSync(process.execPath, [fixture], { encoding: "utf8" });

test("S3 slice views: the fixture on wasm equals Node", async () => {
  const res = await compile(fixture, { outPath: join(scratch, "views.wasm"), outDir: join(scratch, "w"), backend: "wasm" });
  if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join(" | "));
  const out = await runWasm(res.binaryPath);
  expect(out.stderr).toBe("");
  expect(out.stdout).toBe(node);
}, 300_000);

test("S3 slice views: the fixture on wasm-native under GC stress equals Node", async () => {
  const res = await compile(fixture, { outPath: join(scratch, "n", "program"), outDir: join(scratch, "n"), backend: "wasm-native" });
  if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join(" | "));
  for (const stress of ["", "7"]) {
    const r = await run(res.binaryPath, [], { encoding: "utf8", env: { ...process.env, WN_GC_STRESS: stress } });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(node);
  }
}, 300_000);
