/* GH #144: a write to `name` or `message` on an instance of a user
 * `extends Error` class — `this.message = ...` inside the class, or
 * `me.name = ...` from outside on an instance that also crossed into
 * `any` — made an invalid wasm module in any module that concatenates
 * strings: a class field holds a string VALUE (possibly a concatenation
 * node), but these two are errT's own flat-string slots, which the
 * builtin errors' writes already flattened into. Every row equals Node
 * (spawned at test time), on the wasm lane and, in the second describe, on
 * the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh144-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source, written as main.ts. */
  src: string;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
}

const ROWS: Row[] = [
  {
    id: "GH144-TS-01 the issue's repro: a user error class writes this.message from a concatenation",
    src: `class SE extends Error { constructor(m: string) { super(m); this.message = "SE-" + m; } }
console.log(String(new SE("x")));`,
  },
  {
    id: "GH144-TS-02 outside typed writes on an instance that crossed into any",
    src: `class ME extends Error { constructor(m: string) { super(m); } }
const me = new ME("q");
const seen: any = me;
me.name = "Back" + "x".repeat(2);
me.message = "M" + me.message;
console.log(String(me), String(seen), seen.name, seen.message, me instanceof ME, seen === me);
seen.name = "Dyn";
console.log(me.name, \`\${me}\`);`,
  },
  {
    id: "GH144-TS-03 name and message writes inside the class: a field beside them, a compound write, a subclass",
    src: `class SE extends Error {
  extra: string;
  constructor(m: string) { super(m); this.message += "!" + m; this.extra = "e" + m; this.name = "N" + m; }
  bump(): string { this.message = this.message + "+"; return this.message; }
}
const s = new SE("x");
console.log(s.message, s.extra, s.bump(), String(s), s.name);
class Sub extends SE { tail = 3; constructor() { super("y"); this.name = "Sub" + this.extra; } }
const u = new Sub();
const ua: any = u;
u.message = u.message + "#";
console.log(String(u), String(ua), ua.name, ua.message, \`\${u.name}|\${u.message}|\${u.extra}|\${u.tail}\`);
const t = new TypeError("t");
t.message += "?" + t.name;
t.name = "R" + t.message;
console.log(String(t));`,
  },
  {
    id: "GH144-TS-04 a user error class keeps its own fields beside the error slots, crossed or thrown",
    src: `class AppError extends Error {
  readonly code2: number;
  label = "L";
  constructor(m: string, c: number) { super(m); this.code2 = c; this.message = m + "/" + c; }
}
const errs: AppError[] = [];
for (let i = 0; i < 3; i++) errs.push(new AppError("m" + i, i * 10));
const crossed: any = errs[1];
errs[1]!.name = "Renamed" + errs[1]!.code2;
for (const e of errs) console.log(String(e), e.code2, e.label, e instanceof AppError, e instanceof Error);
const again: any = errs[1];
console.log(crossed.name, String(crossed), crossed === again);
try { throw errs[0]!; } catch (x) { const c = x as AppError; console.log(c.code2, c.label, c.message, c === errs[0]); }`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.ts");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(row, backend);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  if (row.fence !== undefined) {
    const stopped: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(stopped.exitCode).toBe(1);
    expect(stopped.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(stopped.stdout)).toBe(true);
    expect(stopped.stderr.split("\n")[0]).toMatch(row.fence.text);
    return;
  }
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("GH #144: name / message writes on a user error class make a valid module (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #144: name / message writes on a user error class make a valid module (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
