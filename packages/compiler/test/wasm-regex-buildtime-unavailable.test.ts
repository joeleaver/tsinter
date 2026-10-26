/* Unit E review M1: the build-time regex compiler runs on the host's
 * WasmGC (regex-buildtime.ts). A host that cannot instantiate it (Node 20
 * without --experimental-wasm-gc throws a CompileError) must get a named
 * refusal at the regex site — `build-time-compiler-unavailable` — never an
 * exception out of the compiler. Simulated here by making the host's
 * WebAssembly.Module reject the standalone compiler module only (it is the
 * one module exporting `errMessage`); this file runs in its own worker, so
 * the failure stays local to it. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";

const RealModule = WebAssembly.Module;
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-regex-bt-"));
  const marker = Buffer.from("errMessage");
  (WebAssembly as unknown as { Module: unknown }).Module = function (bytes: Uint8Array) {
    if (Buffer.from(bytes).includes(marker)) throw new WebAssembly.CompileError("simulated: this host has no WasmGC");
    return new RealModule(bytes);
  };
});
afterAll(async () => {
  (WebAssembly as unknown as { Module: unknown }).Module = RealModule;
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, src: string) {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, src);
  return compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm", dynamic: false });
}

test("M1: a regex literal refuses by name when the build-time compiler cannot run", async () => {
  const res = await build("lit", 'console.log(/a+b/.test("aab"));\n');
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.wasmSurvey).toContain("expr:regexLit:build-time-compiler-unavailable");
});

test("M1: a constant new RegExp refuses by name when the build-time compiler cannot run", async () => {
  const res = await build("new", 'console.log(new RegExp("a+b").test("aab"));\n');
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.wasmSurvey).toContain("libCall:regex.new:build-time-compiler-unavailable");
});

test("M1: a program without a constant regex still builds", async () => {
  const res = await build("plain", 'console.log("hi");\n');
  expect(res.ok).toBe(true);
});
