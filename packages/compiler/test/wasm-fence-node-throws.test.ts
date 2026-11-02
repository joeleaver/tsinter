/* GH #86 review (SEMANTICS.md S122): an error is catchable only where Node
 * also throws at that point, and then it is Node's own error — class,
 * message and code. Sites that were fences but meet a Node throw for some
 * inputs now throw Node's error for exactly those inputs (and stay the
 * fence for the rest):
 *   - a checked-dynamic stream construction's invalid highWaterMark
 *     (ERR_INVALID_ARG_VALUE) and a readable's unknown encoding
 *     (ERR_UNKNOWN_ENCODING);
 *   - ReflectApply's TypeError through AsyncLocalStorage / diagnostics_
 *     channel over a Uint8Array, a promise or an error;
 *   - `new Buffer(<plain object>, enc)`'s ERR_INVALID_ARG_TYPE;
 *   - Object.assign over a plain island object's getter-only member;
 *   - structuredClone of a URL held in a dynamic value (DataCloneError);
 *   - destructuring undefined/null in a JavaScript source (V8's
 *     "Cannot destructure property 'a' of 'o' as it is undefined." family).
 * Every row runs under Node (the oracle, spawned at test time) and on the
 * wasm and wasm-native lanes, byte for byte. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh86-node-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
}

const dynamicOf = (src: string): boolean => src.startsWith("// @dynamic");

async function nodeRun(file: string): Promise<Out> {
  const p = run(process.execPath, ["--no-deprecation", file], { encoding: "utf8" });
  p.child.stdin?.end();
  const r = await p;
  return { stdout: r.stdout, stderr: r.stderr };
}

async function wasmRun(id: string, file: string, src: string): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic: dynamicOf(src) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  expect(r.exitCode).toBe(0);
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
}

async function nativeRun(id: string, file: string, src: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", dynamic: dynamicOf(src) });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const p = run(res.binaryPath, [], { encoding: "utf8" });
  p.child.stdin?.end();
  const r = await p;
  return { stdout: r.stdout, stderr: r.stderr };
}

const ROWS: { id: string; src: string }[] = [
  {
    id: "01-stream-options",
    src: `'use strict';
const { Readable, Writable } = require('stream');
class R extends Readable {
  constructor(opts) { super(opts); }
  _read() {}
}
class W extends Writable {
  constructor(opts) { super(opts); }
  _write(c, e, cb) { cb(); }
}
const opts = JSON.parse('[{"highWaterMark":-1},{"highWaterMark":1.5},{"highWaterMark":"x"},{"highWaterMark":"16"},{"highWaterMark":true},{"highWaterMark":null},{"highWaterMark":4},{"encoding":"nope"},{"encoding":""},{"encoding":5},{"encoding":true},{"encoding":0},{"encoding":"utf8"}]');
for (const o of opts) {
  try { new R(o); console.log('R', JSON.stringify(o), 'ok'); } catch (e) { console.log('R', JSON.stringify(o), e.name, e.code, e.message); }
}
for (const o of opts.slice(0, 5)) {
  try { new W(o); console.log('W', JSON.stringify(o), 'ok'); } catch (e) { console.log('W', JSON.stringify(o), e.name, e.code, e.message); }
}`,
  },
  {
    id: "02-reflect-apply",
    src: `'use strict';
const { AsyncLocalStorage } = require('async_hooks');
function id(x) { return x; }
const t = (tag, f) => {
  try {
    const r = f();
    console.log(tag, 'ok', typeof r);
  } catch (e) {
    console.log(tag, e.name, e.message);
  }
};
const als = new AsyncLocalStorage();
t('apply-bytes', () => als.run(1, id(Buffer.from('x'))));
t('apply-promise', () => als.run(1, id(Promise.resolve(1))));
t('apply-error', () => als.run(1, id(new Error('boom'))));
t('apply-error-empty', () => als.run(1, id(new RangeError(''))));`,
  },
  {
    id: "03-buffer-plain-object",
    src: `'use strict';
const show = (fn) => {
  try {
    console.log('ret', fn());
  } catch (e) {
    console.log(\`\${e.name}|\${e.code}|\${e.message}\`);
  }
};
show(() => new Buffer({ a: 1 }, 'utf8'));
show(() => new Buffer(JSON.parse('{"k":[1]}'), 'hex'));
console.log('after');`,
  },
  {
    id: "04-assign-getter",
    src: `// @dynamic
const t: any = {
  n: 1,
  get g() {
    return 1;
  },
};
const tu: unknown = t;
if (typeof tu === "object" && tu !== null) {
  try {
    Object.assign(tu, { k: 3, g: 2 });
    console.log("assigned");
  } catch (e) {
    console.log(\`\${(e as Error).name}: \${(e as Error).message}\`);
  }
}
console.log("after");`,
  },
  {
    id: "05-clone-url",
    src: `// @dynamic
const u: any = new URL("http://h/x");
try {
  const c: unknown = structuredClone(u);
  console.log(typeof c);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
console.log("after");`,
  },
  {
    // a nullish source destructured: V8's own TypeError per pattern and
    // source shape (the SC1031 fence stays for shapes whose text is not
    // rendered); a union-typed source and a dynamic one alike
    id: "06-destructure-nullish",
    src: `function get(k) { return k > 0 ? { a: k, b: "x" } : undefined; }
function getN(k) { return k > 0 ? { a: k, b: "x" } : null; }
const holder = { v: get(0) };
try { const { a } = get(0); console.log(a); } catch (e) { console.log(e.name, e.message); }
try { const { a } = getN(0); console.log(a); } catch (e) { console.log(e.name, e.message); }
const o = get(0);
try { const { b: z } = o; console.log(z); } catch (e) { console.log(e.name, e.message); }
try { const { a = 5 } = o; console.log(a); } catch (e) { console.log(e.name, e.message); }
try { const { a } = holder.v; console.log(a); } catch (e) { console.log(e.name, e.message); }
const m = "abc".match(/z(.)/);
try { const [all, c] = m; console.log(all, c); } catch (e) { console.log(e.name, e.message); }
const { a: ok } = get(2);
console.log("ok", ok);`,
  },
];

const extOf = (id: string): string => (id.startsWith("04") || id.startsWith("05") ? "ts" : id.startsWith("06") ? "mjs" : "cjs");

describe("GH #86 review: Node's own errors where Node throws (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.${extOf(id)}`);
    writeFileSync(file, row.src + "\n");
    const [node, wasm] = await Promise.all([nodeRun(file), wasmRun(id, file, row.src)]);
    expect(wasm).toEqual(node);
  });
});

describe("GH #86 review: the same rows on the wasm-native lane", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.${extOf(id)}`);
    writeFileSync(file, row.src + "\n");
    const [node, wn] = await Promise.all([nodeRun(file), nativeRun(id, file, row.src)]);
    expect(wn).toEqual(node);
  }, 600_000);
});
