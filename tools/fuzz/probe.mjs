/* Run one program file on Node and the given lanes and print everything:
 *   node --experimental-transform-types --import ./tools/fuzz/ts-resolve.mjs \
 *     tools/fuzz/probe.mjs <file.ts|file.js> [wasm,wasm-native]
 * Compile diagnostics are printed in full (code, message, line). */
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCase } from "./exec.mjs";

const file = process.argv[2];
const lanes = (process.argv[3] ?? "wasm").split(",");
const dir = mkdtempSync(join(tmpdir(), "tsinter-probe-"));
copyFileSync(file, join(dir, basename(file)));
const dist = await import(new URL("../../packages/compiler/dist/index.js", import.meta.url).href);
for (const lane of lanes) {
  const res = await dist.compile(join(dir, basename(file)), { outPath: join(dir, lane + ".out"), outDir: dir, backend: lane, dynamic: false });
  if (!res.ok) for (const d of res.diagnostics) console.log(`[${lane}] ${d.code} line ${d.loc?.line ?? "?"}: ${d.message.split("\n")[0]}`);
}
const r = await runCase(dir, basename(file), lanes);
console.log(JSON.stringify(r, null, 1));
