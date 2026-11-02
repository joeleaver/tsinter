/* GH #86 (SEMANTICS.md S122): a RUNTIME FENCE — a construct this build
 * cannot run, reached — ends the program. It prints `tsinter: unsupported:
 * <message> [<code> at <file>:<line>]` on stderr and exits 1; no catch,
 * finally, promise reaction or 'exit' listener runs after it. Before GH #86
 * the fence was an ordinary Error, so a program's own try/catch swallowed
 * it and exited 0 with output Node never prints (the real-app trial's
 * tests/real-apps-round2/silent/01 and 05).
 *
 * Node is not the oracle for these rows (each one reaches a construct this
 * build refuses), so the expected output is pinned here: everything the
 * program printed before the fence, then the fence line, exit 1. The wasm
 * rows run in this package's host; the wasm-native rows also see the
 * runner's own trap text (S117 (d)); the c and llvm rows cover the
 * deferred compile fence on the native lanes. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh86-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type Lane = "wasm" | "wasm-native" | "c" | "llvm";

async function runOn(lane: Lane, id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-${lane}`);
  const res = await compile(file, {
    outPath: join(dir, lane === "wasm" ? "program.wasm" : "program"),
    outDir: dir,
    backend: lane,
  });
  if (!res.ok) throw new Error(`${id} refused on ${lane}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  if (lane === "wasm") {
    // this package's host surfaces a trap as a rejection (runWasmToTrap
    // asserts it): the wasm tier's exit 1 (abi.ts)
    const r = await runWasmToTrap(res.binaryPath);
    return { stdout: String(r.stdout), stderr: String(r.stderr).split(file).join("<ROW>"), exitCode: 1 };
  }
  try {
    const p = run(res.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr.split(file).join("<ROW>"), exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr.split(file).join("<ROW>"), exitCode: err.code };
  }
}

const SC2011 = (line: number): string =>
  `tsinter: unsupported: the '|' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include [SC2011 at <ROW>:${line}]\n`;
const HOLES = (line: number): string =>
  "tsinter: unsupported: Array.prototype.map over an array that may hold holes (a write past an array's end leaves undefined where Node keeps a hole, " +
  `and Array.prototype.map tells them apart — SEMANTICS.md S119) [SC1090 at <ROW>:${line}]\n`;

interface Row {
  id: string;
  ext: "mjs" | "ts";
  src: string;
  stdout: string;
  stderr: string;
  /** the c and llvm lanes run this row too (a deferred compile fence; the
   * S119 fences are WasmGC-only) */
  native?: true;
}

const ROWS: Row[] = [
  {
    // tests/real-apps-round2/silent/01: Node prints "result 7"
    id: "01-round2-try-catch",
    ext: "mjs",
    src: `function parse(options) {
  return options.pos | 0;
}
let r;
try {
  r = parse({ pos: 7 });
} catch (e) {
  r = -1;
}
console.log("result", r);`,
    stdout: "",
    stderr: SC2011(2),
    native: true,
  },
  {
    // finally and an 'exit' listener do not run either
    id: "02-finally-exit-listener",
    ext: "mjs",
    src: `function parse(o) { return o.pos | 0; }
process.on("exit", (c) => console.log("exit listener", c));
console.log("before");
try {
  parse({ pos: 7 });
  console.log("after fence");
} catch (e) {
  console.log("caught", e.message);
} finally {
  console.log("finally");
}
console.log("end");`,
    stdout: "before\n",
    stderr: SC2011(1),
    native: true,
  },
  {
    // an async function's fence never becomes a rejection a handler sees
    id: "03-async-rejection-handler",
    ext: "mjs",
    src: `async function f(o) { await null; return o.pos | 0; }
f({ pos: 1 }).then((v) => console.log("then", v)).catch(() => console.log("rejected"));
Promise.resolve().then(() => console.log("microtask"));
console.log("sync end");`,
    stdout: "sync end\n",
    stderr: SC2011(1),
    native: true,
  },
  {
    // tests/real-apps-round2/silent/05 inside a try: the S119 hole fence
    id: "04-hole-fence-try",
    ext: "ts",
    src: `const out: (number | undefined)[] = [];
out[4] = 7;
const m = new Map<string, number>([["k", 1]]);
try {
  console.log([m.get("k"), m.get("nope")].map((v) => v ?? -1).join(","));
} catch (e) {
  console.log("caught");
} finally {
  console.log("finally");
}`,
    stdout: "",
    stderr: HOLES(5),
  },
  {
    // inside a timer callback, with an 'exit' listener registered
    id: "05-timer-callback",
    ext: "ts",
    src: `process.on("exit", (c: number) => console.log("exit listener", c));
const out: (number | undefined)[] = [];
out[2] = 1;
setTimeout(() => {
  console.log("tick");
  try {
    console.log([out[0], 1].map((x) => x ?? 0).join(","));
  } finally {
    console.log("finally");
  }
}, 0);`,
    stdout: "tick\n",
    stderr: HOLES(7),
  },
];

describe("GH #86: a runtime fence ends the program (wasm lane)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.${row.ext}`);
    writeFileSync(file, row.src + "\n");
    expect(await runOn("wasm", id, file)).toEqual({ stdout: row.stdout, stderr: row.stderr, exitCode: 1 });
  });
});

describe("GH #86: the same rows on the wasm-native lane", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.${row.ext}`);
    writeFileSync(file, row.src + "\n");
    // the runner's own trap text follows the fence line (S117 (d))
    expect(await runOn("wasm-native", id, file)).toEqual({
      stdout: row.stdout,
      stderr: row.stderr + "RuntimeError: unreachable\n",
      exitCode: 1,
    });
  }, 600_000);
});

describe("GH #86: the deferred compile fence on the c and llvm lanes", () => {
  const native = ROWS.filter((r) => r.native === true);
  for (const lane of ["c", "llvm"] as const) {
    test.for(native.map((r) => [r.id, r] as const))(`${lane}: %s`, async ([id, row]) => {
      const file = join(scratch, `${id}-${lane}.${row.ext}`);
      writeFileSync(file, row.src + "\n");
      expect(await runOn(lane, id, file)).toEqual({ stdout: row.stdout, stderr: row.stderr, exitCode: 1 });
    }, 600_000);
  }
});
