/* child_process option records as values: spawn and the synchronous exec
 * pair. A typed SpawnOptions / ExecSyncOptions value, a spread with an
 * override, cwd and env, stdio strings and arrays, a shell, and the
 * members this build stops at by name when present (a piped stdio, a
 * timeout on spawn, a uid). Real children: the wasm-native lane runs the
 * rows, the wasm lane checks they build. */
import { describe, test } from "vitest";
import { checkBuilds, checkFenced, checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("child-options-spawn");

const ROWS: Row[] = [
  {
    id: "CO-SP-01 spawn over a SpawnOptions parameter spread under a stdio override (cwd, env)",
    files: {
      "main.ts": `import { spawn, type SpawnOptions } from "node:child_process";
function run(file: string, args: string[], options: SpawnOptions): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { ...options, stdio: "inherit" });
    child.on("exit", (code) => resolve(code));
  });
}
async function main(): Promise<void> {
  const base: SpawnOptions = { cwd: "/", env: { ...process.env, CO_S: "spawned" } };
  console.log("exit", await run("/bin/sh", ["-c", "echo $CO_S; pwd; exit 3"], base));
  console.log("exit", await run("/bin/sh", ["-c", "pwd"], { ...base, cwd: "/tmp" }));
  console.log("exit", await run("echo via-shell $0", [], { shell: true }));
}
main();`,
    },
  },
  {
    id: "CO-SP-02 spawn over a stdio array value (ignore stdout, inherit stderr) and a detached child",
    files: {
      "main.ts": `import { spawn, type SpawnOptions } from "node:child_process";
async function main(): Promise<void> {
  const quiet: SpawnOptions = { stdio: ["ignore", "ignore", "inherit"] };
  const c = spawn("/bin/sh", ["-c", "echo hidden; echo shown >&2"], quiet);
  await new Promise<void>((r) => { c.on("exit", () => r()); });
  const d = spawn("/bin/sh", ["-c", "echo detached"], { ...quiet, stdio: "inherit", detached: true });
  await new Promise<void>((r) => { d.on("exit", () => r()); });
  console.log("done");
}
main();`,
    },
  },
  {
    id: "CO-SY-01 execSync / execFileSync over a typed value and spreads (cwd, env, input, stdio)",
    files: {
      "main.ts": `import { execFileSync, execSync, type ExecFileSyncOptions, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
const base: ExecSyncOptionsWithStringEncoding = { encoding: "utf8", cwd: "/", env: { ...process.env, CO_Z: "zz" } };
console.log(JSON.stringify(execSync("echo $CO_Z $PWD", base)));
console.log(JSON.stringify(execSync("echo in:$(cat)", { ...base, input: "fed" })));
console.log(JSON.stringify(execSync("echo e >&2; echo o", { ...base, stdio: ["pipe", "pipe", "ignore"] })));
console.log(JSON.stringify(execFileSync("/bin/sh", ["-c", "pwd"], { ...base, cwd: "/tmp" })));
const f: ExecFileSyncOptions = { stdio: "ignore" };
execFileSync("/bin/echo", ["dropped"], f);
try {
  execFileSync("/bin/sh", ["-c", "echo bad >&2; exit 2"], { ...base, stdio: "pipe" });
} catch (e) {
  if (e instanceof Error) console.log(JSON.stringify(e.message));
}
console.log("done");`,
    },
  },
];

const FENCES: { row: Row; prefix: string; fence: string }[] = [
  {
    row: {
      id: "CO-SP-F1 spawn over a value with no stdio (Node's default \"pipe\") stops by name",
      files: {
        "main.ts": `import { spawn, type SpawnOptions } from "node:child_process";
console.log("before");
const o: SpawnOptions = { cwd: "/" };
const c = spawn("/bin/echo", ["x"], o);
c.on("exit", (code) => console.log("exit", code));`,
      },
    },
    prefix: "before\n",
    fence: "'spawn with a piped stdio slot in an options value",
  },
  {
    row: {
      id: "CO-SP-F2 spawn with a timeout stops by name",
      files: {
        "main.ts": `import { spawn, type SpawnOptions } from "node:child_process";
console.log("before");
const o: SpawnOptions = { stdio: "ignore", timeout: 100 };
const c = spawn("/bin/sleep", ["1"], o);
c.on("exit", (code) => console.log("exit", code));`,
      },
    },
    prefix: "before\n",
    fence: "'spawn option 'timeout'' is typed by @types/node but has no scriptc lowering yet",
  },
  {
    row: {
      id: "CO-SY-F1 execFileSync with a uid stops by name",
      files: {
        "main.ts": `import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
console.log("before");
const o: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8", uid: 12345 };
console.log(execFileSync("/bin/echo", ["x"], o));`,
      },
    },
    prefix: "before\n",
    fence: "'execFileSync option 'uid'' is typed by @types/node but has no scriptc lowering yet",
  },
];

describe("child_process option records as values — spawn and the synchronous exec pair", () => {
  for (const row of ROWS) {
    test(`${row.id} (wasm-native)`, () => checkRow(scratch, row, "wasm-native"), 60_000);
    test(`${row.id} builds on wasm`, () => checkBuilds(scratch, row, "wasm"), 60_000);
  }
  for (const { row, prefix, fence } of FENCES) {
    test(`${row.id} (wasm-native)`, () => checkFenced(scratch, row, "wasm-native", prefix, fence), 60_000);
  }
  test("CO-SY-R1 an execSync result over an ExecSyncOptions value (Node: string | Buffer) refuses by name", () =>
    checkRefuses(scratch, {
      id: "CO-SY-R1",
      files: {
        "main.ts": `import { execSync, type ExecSyncOptions } from "node:child_process";
const o: ExecSyncOptions = { cwd: "/" };
const out = execSync("echo x", o);
console.log(out.length);`,
      },
    }, "execSync with an options value whose result is not typed as a string"), 60_000);
});
