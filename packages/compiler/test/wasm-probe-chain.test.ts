/* A method chain lowers each link once (lower-exprs.ts heldProbes): a
 * dynamic-receiver call's probe of its receiver is the typed path's own
 * lowering of that receiver, so `new Command().a().b()...` (commander's
 * setup chains: shadcn, paperclip, deepseek) compiles in linear time
 * instead of doubling per link. A poisoned link reports its diagnostic
 * exactly once.
 *
 * Every row equals Node (spawned at test time) on the wasm lane and, in the
 * second describe, on the wasm-native lane, and its build takes seconds. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-probechain-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  entry?: string;
  /** The build refuses with exactly one diagnostic containing this. */
  refusedOnce?: string;
  /** That diagnostic's message names its generic instantiation exactly
   * once (the suffix is never repeated per enclosing chain link). */
  oneInstantiation?: true;
  extra?: Record<string, string>;
}

/** `.opt("o0").opt("o1")...` over n links. */
const links = (n: number, m = "opt"): string => Array.from({ length: n }, (_, i) => `.${m}("o${i}")`).join("\n  ");

const JS_COMMAND = `export class Command {
  constructor() { this.parts = []; }
  name(n) { this.parts.push("name:" + n); return this; }
  opt(o) { this.parts.push(o); return this; }
  description(d) { this.parts.push("desc:" + d); return this; }
  done() { return this.parts.join(","); }
}`;

const ROWS: Row[] = [
  {
    id: "PC-01 a 30-link fluent chain on a TypeScript class (methods returning this)",
    src: `class Command {
  private parts: string[] = [];
  name(n: string): this { this.parts.push("name:" + n); return this; }
  opt(o: string): this { this.parts.push(o); return this; }
  done(): string { return this.parts.join(","); }
}
const c = new Command()
  .name("tool")
  ${links(30)};
console.log(c.done());`,
  },
  {
    id: "PC-02 a 30-link chain on a JavaScript ES5 constructor (a dynamic receiver)",
    entry: "main.js",
    src: `function Command() { this.parts = []; }
Command.prototype.opt = function (o) { this.parts.push(o); return this; };
Command.prototype.done = function () { return this.parts.join(","); };
const c = new Command()
  ${links(30)};
console.log(c.done());`,
  },
  {
    id: "PC-03 new Command().name().description().opt()... over a JavaScript class imported into TypeScript (commander's shape), 30 links",
    extra: { "command.js": JS_COMMAND },
    src: `import { Command } from "./command.js";
const program = new Command()
  .name("shadcn")
  .description("add components")
  ${links(30)};
console.log(program.done());`,
  },
  {
    id: "PC-04 a 30-link chain on an 'any' receiver",
    extra: { "command.js": JS_COMMAND },
    src: `import { Command } from "./command.js";
const base: any = new Command();
const out = base
  ${links(30)}
  .done();
console.log(out);`,
  },
  {
    id: "PC-05 a chain whose innermost link refuses reports that diagnostic exactly once",
    src: `class Command {
  private parts: string[] = [];
  opt(o: string): this { this.parts.push(o); return this; }
  done(): string { return this.parts.join(","); }
}
const o = { n: 0 };
const c = new Command()
  .opt(String(o.n += 1))
  ${links(12)};
console.log(c.done());`,
    refusedOnce: "compound assignment as an expression",
  },
  {
    id: "PC-06 a refused link inside a generic function: one diagnostic, naming its instantiation once",
    src: `class Command {
  private parts: string[] = [];
  opt(o: string): this { this.parts.push(o); return this; }
  done(): string { return this.parts.join(","); }
}
function mk<T>(x: T): string {
  const o = { n: 0 };
  return new Command()
    .opt(String(o.n += 1))
    ${links(8)}
    .done() + String(x);
}
console.log(mk(1));`,
    refusedOnce: "compound assignment as an expression",
    oneInstantiation: true,
  },
  {
    id: "PC-07 a refused link inside a generic class's method: one diagnostic, naming its instantiation once",
    src: `class Command {
  private parts: string[] = [];
  opt(o: string): this { this.parts.push(o); return this; }
  done(): string { return this.parts.join(","); }
}
class Box<T> {
  constructor(private v: T) {}
  make(): string {
    const o = { n: 0 };
    return new Command()
      .opt(String(o.n += 1))
      ${links(8)}
      .done() + String(this.v);
  }
}
console.log(new Box<number>(1).make());`,
    refusedOnce: "compound assignment as an expression",
    oneInstantiation: true,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.extra ?? {})) writeFileSync(join(dir, name), text + "\n");
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
  const t0 = Date.now();
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  const secs = (Date.now() - t0) / 1000;
  // Linear lowering: a 30-link chain builds in seconds (it doubled per
  // link before; the native lane's C build is outside the lowering).
  if (backend === "wasm") expect(secs, `${row.id} build took ${secs}s`).toBeLessThan(30);
  if (row.refusedOnce !== undefined) {
    expect(res.ok, row.id).toBe(false);
    const hits = res.diagnostics.filter((d) => d.message.includes(row.refusedOnce!));
    expect(hits.length, JSON.stringify(res.diagnostics)).toBe(1);
    if (row.oneInstantiation) {
      expect(hits[0]!.message.split("(instantiating ").length - 1, hits[0]!.message).toBe(1);
    }
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  expect(node.exitCode, JSON.stringify(node)).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("method chains lower each link once (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  }, 120_000);
});

describe("method chains lower each link once (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
