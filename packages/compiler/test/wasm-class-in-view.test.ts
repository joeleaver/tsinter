/* Vue 2.7's render-list.ts: an array of program class instances cast to
 * `any` (`(ret as any)._isVList = true`) crossed into dynamic code through
 * the array's view, whose element lift met the class instance and threw an
 * internal error ("jsvalLiftExpr of unliftable object"). Each row equals
 * Node (spawned at test time) on the wasm lane and, in the second
 * describe, on the wasm-native lane, or stops by name where noted. An
 * instance of a class whose own declaration does not compile (Vue's VNode)
 * refuses by name at the crossing instead (CVIEW-03). */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-cview-"));
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
  /** The build refuses, and some diagnostic's message contains this. */
  refusedMsg?: string;
}

const ROWS: Row[] = [
  {
    id: "CVIEW-01 vue's renderList shape: an array of class instances cast to any, read through the cast",
    src: `class VNode {
  tag?: string;
  children?: VNode[] | null;
  constructor(tag?: string) { this.tag = tag; }
}
function renderList(n: number): VNode[] | null {
  let ret: VNode[] | null = null;
  ret = [];
  for (let i = 0; i < n; i++) ret.push(new VNode("li" + i));
  const any = ret as any;
  console.log(any.length, any[1].tag, any[0] instanceof VNode);
  return ret;
}
const out = renderList(3)!;
console.log(out.length, out[2]!.tag);`,
  },
  {
    id: "CVIEW-02 a record holding a class instance and an array of them, cast to any",
    src: `class Item { constructor(public name: string, public n: number) {} }
interface Box { label: string; one: Item; many: Item[] }
const b: Box = { label: "x", one: new Item("a", 1), many: [new Item("b", 2), new Item("c", 3)] };
const u = b as any;
console.log(u.label, u.one.name, u.many.length, u.many[1].n, u.one instanceof Item);`,
  },
  {
    id: "CVIEW-03 an array of instances of a class that does not compile here (an Intl.Collator field), cast to any: the class's own diagnostics and a named refusal at the crossing, never an internal error",
    src: `class V {
  tag = "x";
  ref?: Intl.Collator;
}
function mark(xs: V[]): void {
  (xs as any)._isVList = true;
}
console.log("ok", typeof mark);`,
    refusedMsg: "instance crossing into dynamic code, whose class does not compile here",
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
  if (row.refusedMsg !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.some((d) => d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
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

describe("class instances inside a typed composite crossing into any (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("class instances inside a typed composite crossing into any (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
