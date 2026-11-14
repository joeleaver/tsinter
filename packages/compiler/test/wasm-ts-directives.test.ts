/* docs/design/ts-directives.md: TypeScript directives across checker
 * versions. An unused @ts-expect-error never blocks the build, and a
 * @ts-expect-error / @ts-ignore covers its whole next statement, so a
 * project pinned to an older TypeScript (Vue 2.7 on 4.9.5, whose error
 * TypeScript 7 reports at a later line of the same statement) builds as
 * its own tsc accepts it. The covered sites lower like any other: Node's
 * output, or a named stop. An error in the statement after the covered
 * one still refuses the build.
 *
 * Every running row equals Node (spawned at test time), on the wasm lane
 * and, in the second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-tsd-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source (written as main.ts unless `entry` names another). */
  src: string;
  entry?: string;
  /** Ends uncaught: Node and this tier both exit 1 after the same stdout,
   * and this tier's report is `report` (S007). */
  uncaught?: { report: string };
  /** The build refuses with this diagnostic code (the directive does not
   * reach the error, or the write is one Node rejects). */
  refused?: string;
  /** ...and that diagnostic's message contains this. */
  refusedMsg?: string;
}

const ROWS: Row[] = [
  {
    id: "TSD-01 an unused @ts-expect-error does not block the build (TS2578 is a complaint about a comment)",
    src: `// @ts-expect-error
const ok: number = 1;
// @ts-expect-error
import { basename } from "node:path";
console.log("ok", ok, basename("/a/b.txt"));`,
  },
  {
    id: "TSD-02 Vue's locateNode shape: the directive covers a return whose error TypeScript 7 reports at the later branch",
    src: `function first(xs: string[], ok: boolean): string {
  // @ts-expect-error
  return ok
    ? xs[0]!
    : undefined
}
console.log(first(["a"], true), first(["a"], false), typeof first(["b"], false));`,
  },
  {
    id: "TSD-03 a @ts-ignore covers an error on a later line of a multi-line call: the value meets the slot's own handling (S119 undefined)",
    src: `function shout(s: string): string { return String(s).toUpperCase(); }
const maybe: string | undefined = process.argv.length > 99 ? "x" : undefined;
// @ts-ignore
console.log(
  shout(maybe),
  "done",
);`,
  },
  {
    id: "TSD-04 a directive over a class member covers the member's whole initializer",
    src: `class Box {
  // @ts-expect-error
  label: string =
    process.argv.length > 99 ? "big" : undefined;
  show(): string { return "label=" + this.label; }
}
console.log(new Box().show());`,
  },
  {
    id: "TSD-05 the reach ends at the statement: an error in the statement after it still refuses the build",
    src: `function first(xs: string[], ok: boolean): string {
  // @ts-expect-error
  const v: string = ok ? xs[0]! : "";
  return ok
    ? v
    : undefined
}
console.log(first(["a"], true));`,
    refused: "SC0001",
  },
  {
    id: "TSD-06 over an if statement the reach stays TypeScript's one line: an error on the condition's second line still refuses the build",
    src: `function f(xs: string[], ok: boolean): string {
  // @ts-expect-error
  if (ok
    && xs.length > "1") return "a";
  return "b";
}
console.log(f(["x"], true));`,
    refused: "SC0001",
  },
  {
    id: "TSD-07 a '// @ts-ignore' line inside a template literal is text, not a directive: the next statement's error still refuses the build",
    src: `const doc = \`
  // @ts-ignore\`;
const bad: number = (
  "x");
console.log(doc, bad);`,
    refused: "SC0001",
  },
  {
    id: "TSD-08 an assignment to a const binding refuses by name even where a directive suppresses TypeScript's error (Node: TypeError: Assignment to constant variable.)",
    src: `const x = 1;
// @ts-ignore
x = 2;
console.log(x);`,
    refused: "SC1090",
    refusedMsg: "an assignment to the constant binding 'x'",
  },
  {
    id: "TSD-09 the same inside a widened statement",
    src: `const y = 1;
// @ts-expect-error
console.log(
  (y = 3),
);`,
    refused: "SC1090",
    refusedMsg: "an assignment to the constant binding 'y'",
  },
  {
    id: "TSD-10 the same in a loop (++ on a const)",
    src: `const z = 0;
for (let i = 0; i < 2; i++) {
  // @ts-ignore
  z++;
}
console.log(z);`,
    refused: "SC1090",
    refusedMsg: "an assignment to the constant binding 'z'",
  },
  {
    id: "TSD-11 a member read through a value the checker types possibly undefined, its error suppressed, throws Node's TypeError (never undefined)",
    src: `interface E { k: number; n?: string }
function get(b: boolean): E | undefined { return b ? { k: 1 } : undefined; }
const e = get(process.argv.length > 99);
try {
  // @ts-ignore
  console.log(e.k);
} catch (err) { console.log(String(err)); }
const f = get(true);
// @ts-ignore
console.log(f.k, f.n);
console.log("after");`,
  },
  {
    id: "TSD-12 a write to an Object.freeze'd object, its error suppressed, refuses by name (this build keeps no frozen bit)",
    src: `const o = Object.freeze({ a: 1 });
// @ts-ignore
o.a = 2;
console.log(o.a);`,
    refused: "SC1090",
    refusedMsg: "a write to a read-only value",
  },
  {
    id: "TSD-13 a mutating method on an Object.freeze'd array, its error suppressed, refuses by name",
    src: `const a = Object.freeze([1, 2]);
// @ts-ignore
a.push(3);
console.log(a);`,
    refused: "SC1090",
    refusedMsg: "'push' on a read-only array",
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
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
  if (row.refused !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.map((d) => d.code), JSON.stringify(res.diagnostics)).toContain(row.refused);
    if (row.refusedMsg !== undefined) {
      expect(res.diagnostics.some((d) => d.code === row.refused && d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
    }
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.uncaught !== undefined) {
    expect(node.exitCode).toBe(1);
    expect(got.exitCode, row.id).toBe(1);
    expect(got.stdout, row.id).toBe(node.stdout);
    expect(got.stderr.split("\n")[0], row.id).toBe(row.uncaught.report);
    return;
  }
  expect(node.exitCode).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("TypeScript directives across checker versions (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("TypeScript directives across checker versions (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
