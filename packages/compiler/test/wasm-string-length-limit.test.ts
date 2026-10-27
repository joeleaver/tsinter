/* Strings unit S2: V8's string length limit (String::kMaxLength,
 * 0x1fffffe8 = 2^29 - 24 code units) on the wasm tier. Concatenation
 * nodes make a string past it cheap to describe (doubling a node 25
 * times), so the limit must be checked where a concatenation is built:
 * one past it is Node's catchable `RangeError: Invalid string length` on
 * every concatenation path — `+=`, a node built in a callee and caught in
 * its caller, a template, a concatenation read flat on the spot, a
 * prepend, a conditional's arm — and exactly the limit is a legal string.
 * Every probe is built from nodes only, so neither Node nor this tier
 * allocates the gigabyte the strings describe.
 *
 * repeat/padStart past the same limit keep S008's trap (Node's RangeError
 * there, an uncatchable trap here — the registered divergence), now at
 * Node's own threshold. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-strlimit-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, src: string): Promise<{ entry: string; wasm: string }> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, src);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  return { entry, wasm: res.binaryPath };
}

const LIMIT_PROGRAM = `let s = "abcdefghijklmnop";
try {
  for (let i = 0; i < 25; i++) { s += s; if (i >= 22) console.log(i, s.length); }
} catch (e) { console.log("caught", (e as Error).name, (e as Error).message, e instanceof RangeError); }
console.log(s.length);
function grow(x: string): string { return x + x; }
function outer(x: string): number { return grow(x).length; }
try { console.log(outer(s)); } catch (e) { console.log("callee", (e as Error).message); }
try { console.log(\`\${s}\${s}\`.length); } catch (e) { console.log("template", (e as Error).name); }
try { console.log((s + s).charCodeAt(0)); } catch (e) { console.log("flat read", (e as Error).name); }
const d: string[] = ["abcdefgh"];
for (let k = 1; k <= 25; k++) d.push(d[k - 1]! + d[k - 1]!);
let t = d[0]!;
for (let k = 2; k <= 25; k++) t = t + d[k]!;
console.log("exactly the limit", t.length, t.length === 0x1fffffe8);
try { t = t + "y"; console.log("no"); } catch (e) { console.log("append", (e as Error).message); }
try { t = "y" + t; console.log("no"); } catch (e) { console.log("prepend", (e as Error).message); }
const c = Math.random() < 2;
try { t = c ? t + "zz" : "q"; console.log("no"); } catch (e) { console.log("ternary", (e as Error).message); }
try { t = t + ""; console.log("empty operand", t.length); } catch (e) { console.log("no", (e as Error).message); }
`;

test("S2: a concatenation past V8's string length limit throws Node's catchable RangeError on every path; exactly the limit is legal", async () => {
  const { entry, wasm } = await build("limit", LIMIT_PROGRAM);
  const run = await runWasm(wasm);
  const node = execFileSync(process.execPath, [entry], { encoding: "utf8" });
  expect(run.stdout).toBe(node);
  expect(run.stderr).toBe("");
  expect(node).toContain("caught RangeError Invalid string length true");
}, 120_000);

test("S008: repeat and padStart one past the same limit trap (before allocating)", async () => {
  for (const [name, expr] of [
    ["repeat", '"ab".repeat(268435445)'],
    ["pad", '"a".padStart(0x1fffffe9, "b")'],
  ] as const) {
    const { wasm } = await build(name, `console.log("before");\nconst r = ${expr};\nconsole.log(r.length);\n`);
    const out = await runWasmToTrap(wasm);
    expect(out.stdout).toBe("before\n");
  }
}, 120_000);
