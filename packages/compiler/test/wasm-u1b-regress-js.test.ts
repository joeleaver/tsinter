/* GH #179, #180, #181: three regressions U1b (cbd34df1) introduced in
 * JavaScript sources, found by the round-3 npm survey (uuid, jest-cli,
 * web-vitals / rollup-plugin-postcss / @vue/cli-plugin-eslint). Each row
 * is a small program written for this file in the shape of the package;
 * no third-party source is copied.
 *
 *   #179  `new Uint8Array(16 + n)` over an untyped `n`: the argument
 *         lowers to a number, which the island constructor boxed as if
 *         it were a jsval (SC9001).
 *   #180  `exports.a = exports.b = void 0` on a JavaScript parameter: the
 *         bare `undefined` value had no slot (SC9001).
 *   #181  an island object literal member that fails to lower (a fence
 *         getter) or a get accessor, followed by a data member: the
 *         getter was appended after the data members, so the build
 *         refused (SC3001 jsOp:defineGetter-order). The getter now keeps
 *         its source position.
 *
 * An exact row equals Node (spawned at test time); a `fence` row prints
 * Node's stdout up to the named fence and ends there. Both wasm lanes. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-u1b-regress-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** relative path → content; the entry is `entry` */
  files: Record<string, string>;
  entry: string;
  npmStatic?: string[];
  /** absent: equals Node */
  fence?: { text: RegExp; stdout: string };
}

const pkg = (name: string): string => JSON.stringify({ name, version: "1.0.0", main: "index.js", type: "module" });

const ROWS: Row[] = [
  {
    id: "U1BR-179-01 new Uint8Array(16 + n) over an untyped parameter (uuid)",
    entry: "main.js",
    files: {
      "main.js": `function f(n) { console.log(new Uint8Array(16 + n).length); }
f(2);
function g(buf, offset) {
  const b = new Uint8Array(offset + 16);
  for (let i = 0; i < 16; i++) b[offset + i] = i * 3;
  return b;
}
console.log(g(null, 0).length, g(null, 4)[5]);
function h(n) { return new Uint8Array(n * 2); }
console.log(h(3).length, h(0).length);
function k(s) { return new Uint8Array(s.length + 1); }
console.log(k("ab").length);`,
    },
  },
  {
    id: "U1BR-180-01 exports.a = exports.b = void 0 on a module-function parameter (the webpack shape, jest-cli)",
    entry: "main.js",
    files: {
      "main.js": `var mods = {
  "m"(unused, exports) {
    exports.c = exports.a = exports.b = void 0;
    exports.a = 1;
  },
  "n"(module, exports) {
    exports.x = exports.y = null;
    exports.z = exports.w = undefined;
    const r = exports.v = void 0;
    console.log(r);
  },
};
const e = {}; mods.m(null, e); console.log(e);
const e2 = {}; mods.n(null, e2); console.log(e2, Object.keys(e2).length);`,
    },
  },
  {
    id: "U1BR-180-02 the same chain in a plain function",
    entry: "main.js",
    files: {
      "main.js": `function setup(o) { o.a = o.b = void 0; return o; }
console.log(setup({ k: 1 }));
const q = {}; setup(q); console.log(Object.keys(q));`,
    },
  },
  {
    id: "U1BR-181-01 a get accessor between data members of an island literal keeps its position",
    entry: "main.mjs",
    files: {
      "main.mjs": `let r = 5;
function mk(v) { return { x: v, get g() { return r; }, y: 3 }; }
const q = mk(JSON.parse("2"));
console.log(Object.keys(q), q.g, q.y);
r = 6;
console.log(q.g, JSON.stringify(q));`,
    },
  },
  {
    id: "U1BR-181-02 a member that cannot lower, before data members: the literal builds in source order and the read fences (web-vitals)",
    entry: "main.mjs",
    files: {
      "main.mjs": `function k(t) { return { name: t, e: performance.getEntriesByType("mark")[0], n: 0 }; }
const o = k(JSON.parse('"z"'));
console.log(Object.keys(o), o.n, o.name);
console.log(o.e);`,
    },
    fence: { text: /performance\.getEntriesByType/, stdout: "[ 'name', 'e', 'n' ] 0 z\n" },
  },
  {
    id: "U1BR-181-03 the npm-static shape of the issue",
    entry: "main.mjs",
    npmStatic: ["fakepkg"],
    files: {
      "node_modules/fakepkg/package.json": pkg("fakepkg"),
      "node_modules/fakepkg/index.js": `const s = () => { const t = performance.getEntriesByType("mark")[0]; if (t && t.startTime >= 0) return t; };
export const l = (t, c) => { const h = s(); return { name: t, url: c || h?.name, n: 0 }; };
export const m = (t) => ({ name: t, e: performance.getEntriesByType("mark")[0], n: 0 });`,
      "main.mjs": `import { l, m } from "fakepkg";
console.log("before");
console.log(l("x", undefined));
console.log(m("y"));`,
    },
    fence: { text: /performance\.getEntriesByType/, stdout: "before\n" },
  },
];

function layout(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  for (const [rel, text] of Object.entries(row.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text + "\n");
  }
  return join(dir, row.entry);
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", input: "", cwd: dirname(file) });
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
  const entry = layout(row, backend);
  const dir = dirname(entry);
  const res = await compile(entry, {
    outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"),
    outDir: join(dir, "out"),
    backend,
    ...(row.npmStatic ? { npmStatic: row.npmStatic } : {}),
  });
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
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got).toEqual(node);
}

describe("U1b regressions #179-#181 (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("U1b regressions #179-#181 (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
