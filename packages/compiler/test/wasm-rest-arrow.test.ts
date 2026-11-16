/* A rest-parameter arrow that is only ever called: paperclip's
 * `const one = (...scopes: string[]) => [scopes.map(auth)]`
 * (packages/shared/src/google-workspace-connectors.ts) lowers like a
 * function declaration, with each call packing its surplus arguments into
 * the rest array (lower-calls.ts bindingRestFnNodeOf). A function VALUE
 * with a rest convention keeps its named refusal.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane, or is refused by name
 * where noted. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rest-arrow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source (written as main.ts). */
  src: string;
  /** Node's exit status for the row (default 0); the tier's must match. */
  exit?: number;
  /** The build refuses, and some diagnostic's message contains this. */
  refusedMsg?: string;
  /** Ends with an uncaught error: Node and this tier exit with `exit`,
   * stdout matches exactly, and the tier's stderr contains `contains`
   * (Node's stack trace names its own file paths). */
  uncaught?: { exit: number; contains: string };
}

const VALUE_REFUSAL = "functions with rest parameters as values";

const ROWS: Row[] = [
  {
    id: "RA-01 paperclip's shape: a called-only rest arrow over a module function, called from map callbacks inside an object literal, with one, two and three arguments",
    src: `const auth = (scope: string) => \`https://www.googleapis.com/auth/\${scope}\`;
const one = (...scopes: string[]) => [scopes.map(auth)];
const gmail: [string, string[][]][] = [
  ...["get_message", "get_thread"].map((name): [string, string[][]] => [name, one("gmail.readonly")]),
  ["create_draft", one("gmail.compose")],
];
const toolScopes: Record<string, Record<string, string[][]>> = {
  docs: { read_doc: one("documents.readonly", "documents"), update_doc: one("documents") },
  calendar: { suggest_time: one("calendar.events.freebusy", "calendar.events", "calendar.readonly") },
};
for (const [tool, groups] of gmail) console.log("gmail", tool, JSON.stringify(groups));
for (const [service, tools] of Object.entries(toolScopes)) {
  for (const [tool, groups] of Object.entries(tools)) console.log(service, tool, JSON.stringify(groups));
}
console.log(JSON.stringify(one()));`,
  },
  {
    id: "RA-02 zero surplus arguments, leading fixed parameters, a block body, recursion through the binding, a spread into the rest, and arguments evaluated left to right",
    src: `const tag = (label: string, ...parts: number[]): string => {
  if (parts.length === 0) return label + ":empty";
  return label + ":" + parts.join("+") + "=" + parts.reduce((a, b) => a + b, 0);
};
const sum = (acc: number, ...xs: number[]): number => (xs.length === 0 ? acc : sum(acc + xs[0]!, ...xs.slice(1)));
let n = 0;
const next = (): number => ++n;
console.log(tag("none"));
console.log(tag("three", next(), next(), next()));
console.log(sum(0, 1, 2, 3, 4), sum(5));
const more = [10, 20];
console.log(tag("spread", 1, ...more, 2));
console.log(n);`,
  },
  {
    id: "RA-03 a rest arrow taken as a value keeps the named refusal",
    src: `const count = (...xs: string[]) => xs.length;
const alias = count;
console.log(alias("a", "b"));`,
    refusedMsg: VALUE_REFUSAL,
  },
  {
    id: "RA-04 a rest arrow whose length is read keeps the named refusal (the read takes it as a value)",
    src: `const count = (first: string, ...xs: string[]) => xs.length;
console.log(count("a"), count.length);`,
    refusedMsg: VALUE_REFUSAL,
  },
  {
    id: "RA-05 an exported rest arrow keeps the named refusal (another module can take it as a value)",
    src: `export const count = (...xs: string[]) => xs.length;
console.log(count("a", "b"));`,
    refusedMsg: VALUE_REFUSAL,
  },
  {
    id: "RA-06 an early call of a rest arrow throws Node's TDZ ReferenceError: from a function declaration, a const-arrow caller, a class method and an escaping callback, then runs once the binding is initialized",
    src: `function early() { return one(1, 2); }
const viaArrow = () => one(3);
class Box { get() { return one(4, 5, 6); } }
const callbacks: (() => number[])[] = [() => one()];
const attempt = (label: string, f: () => number[]) => {
  try { console.log(label, f()); } catch (e) { console.log(label, "threw", (e as Error).name, (e as Error).message); }
};
attempt("decl", early);
attempt("arrow", viaArrow);
attempt("method", () => new Box().get());
attempt("callback", callbacks[0]!);
const one = (...xs: number[]) => xs;
attempt("decl", early);
attempt("arrow", viaArrow);
attempt("method", () => new Box().get());
attempt("callback", callbacks[0]!);`,
  },
  {
    id: "RA-07 an uncaught early call of a rest arrow in an ES module ends the run as Node does (exit 1)",
    src: `export {};
function early() { return one("a"); }
console.log("before");
console.log(early());
const one = (...xs: string[]) => xs.length;
console.log("never");`,
    uncaught: { exit: 1, contains: "ReferenceError" },
  },
  {
    id: "RA-08 an early call of a generic arrow binding throws Node's TDZ ReferenceError (GH #241), then runs once initialized",
    src: `function early() { return id(7); }
try { console.log(early()); } catch (e) { console.log("threw", (e as Error).name, (e as Error).message); }
const id = <T,>(x: T): T => x;
console.log(early(), id("s"));`,
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
  if (row.refusedMsg !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.some((d) => d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.uncaught !== undefined) {
    expect(node.exitCode, JSON.stringify(node)).toBe(row.uncaught.exit);
    expect(got.exitCode, row.id).toBe(row.uncaught.exit);
    expect(got.stdout, row.id).toBe(node.stdout);
    expect(node.stderr, row.id).toContain(row.uncaught.contains);
    expect(got.stderr, row.id).toContain(row.uncaught.contains);
    return;
  }
  expect(node.exitCode, JSON.stringify(node)).toBe(row.exit ?? 0);
  expect(got, row.id).toEqual(node);
}

describe("called-only rest arrows (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("called-only rest arrows (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
