/* GH #138: a Buffer held in a dynamic value answers as a Buffer. A value
 * TypeScript types as `Buffer` that crosses into `any` / `unknown` carries
 * the BYTES payload's Buffer flag, so `constructor` (named Buffer, length
 * 3), util.inspect / console.log (`<Buffer 61>`), String() and
 * JSON.stringify answer as Node's (SEMANTICS.md S037's GH #138
 * amendment). A Buffer nested in a composite that crosses keeps S037's
 * Uint8Array answer; those rows pin it beside Node's. Every other row
 * equals Node (spawned at test time), on the wasm lane and, in the second
 * describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh138-"));
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
  /** Build with --dynamic (the engine). */
  dynamic?: true;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** A registered divergence (the SEMANTICS.md entry the row names): this
   * tier prints `tier`, Node prints `node`; both are pinned. */
  pin?: { tier: string; node: string };
}

const ROWS: Row[] = [
  {
    id: "GH138-TS-01 the issue's repro: an any-held Buffer's constructor is Buffer",
    src: `const b: any = Buffer.from("a");
console.log(b.constructor.name);
console.log(String(b.constructor.length), b.constructor === b.constructor, b instanceof Uint8Array);
const u: any = new Uint8Array(2);
console.log(u.constructor.name, u.constructor === b.constructor);`,
  },
  {
    id: "GH138-TS-02 inspect, console.log, String() and JSON.stringify of an any-held Buffer",
    src: `import * as util from "node:util";
const b: any = Buffer.from("hi");
console.log(util.inspect(b));
console.log(b);
console.log(String(b), JSON.stringify(b), \`\${b}\`);
console.log({ k: b });`,
  },
  {
    id: "GH138-TS-03 Buffers passed into any / unknown positions, beside a Uint8Array",
    src: `function show(x: any): void {
  console.log(x.constructor.name, String(x), JSON.stringify(x), x);
}
show(Buffer.from("hi"));
show(Buffer.alloc(2));
show(new Uint8Array([104, 105]));
const c: any = Buffer.concat([Buffer.from("a"), Buffer.from("b")]);
console.log(c.constructor.name, c.length);
const x: unknown = Buffer.from("z");
console.log((x as any).constructor.name);
const s = Buffer.from("q");
const sa: any = s;
console.log(sa.constructor.name, sa.length);`,
  },
  {
    id: "GH138-TS-04 (S037) a Buffer nested in a composite that crosses answers Uint8Array",
    src: `const b = Buffer.from("a");
const arr: any[] = [b];
console.log(arr[0].constructor.name);
const o: any = { b };
console.log(o.b.constructor.name);
const typed: Uint8Array = Buffer.from("t");
const ta: any = typed;
console.log(ta.constructor.name);`,
    pin: { tier: "Uint8Array\nUint8Array\nUint8Array\n", node: "Buffer\nBuffer\nBuffer\n" },
  },
  {
    id: "GH138-JS-01 a JavaScript source's Buffer constructor read stops at its named fence",
    entry: "main.js",
    src: `const b = Buffer.from("hi");
console.log("before");
console.log(b.constructor.name);`,
    fence: { text: /'Buffer<ArrayBufferLike>\.constructor' is part of the standard library types but has no scriptc lowering yet/, stdout: "before\n" },
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
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, ...(row.dynamic ? { dynamic: true } : {}) });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  if (row.fence !== undefined) {
    const got: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(got.stdout)).toBe(true);
    expect(got.stderr.split("\n")[0]).toMatch(/^tsinter: unsupported: /);
    expect(got.stderr.split("\n")[0]).toMatch(row.fence.text);
    return;
  }
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.pin !== undefined) {
    // A registered divergence: this tier's answer and Node's, both pinned.
    expect(node.stdout, `${row.id} (Node)`).toBe(row.pin.node);
    expect(got, row.id).toEqual({ stdout: row.pin.tier, stderr: "", exitCode: 0 });
    return;
  }
  expect(got, row.id).toEqual(node);
}

describe("GH #138: a Buffer held in a dynamic value answers as a Buffer (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #138: a Buffer held in a dynamic value answers as a Buffer (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
