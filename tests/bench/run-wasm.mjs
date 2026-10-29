// node tests/bench/run-wasm.mjs <module.wasm>: runs a benchmark module under
// Node's V8 through wasm-host.mjs (the stand-in for the browser wasm column).
import { readFileSync, writeSync } from "node:fs";
import { run } from "./wasm-host.mjs";

const { exitCode } = await run(readFileSync(process.argv[2]), (fd, u8) => {
  let off = 0;
  while (off < u8.length) off += writeSync(fd === 2 ? 2 : 1, u8, off);
});
process.exitCode = exitCode;
