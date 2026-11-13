/* paperclip step 14: `||` / `&&` over an OBJECT left operand. picocolors
 * (reached by paperclip's CLI) opens with `argv = p.argv || []` and
 * `env = p.env || {}`: the left is an array / record, which JS treats as
 * always truthy, so `obj || x` IS obj (x never evaluates) and `obj && x`
 * evaluates obj, then IS x — for a value that cannot be missing (a
 * construction, a literal, a process member). A plain-typed READ can hold
 * undefined at run time (SEMANTICS.md S119), so `read || dflt` of one type
 * tests it at run time, `read && x` answers the missing read itself
 * (undefined) without running x, and a mixed-kind `||` keeps its path (a
 * union result, or the named refusal). Mixed operand kinds used to refuse
 * (SC1042).
 * Rows run under Node and on both WasmGC lanes, from TypeScript and from
 * an untyped JavaScript module, with side-effecting operands to pin the
 * evaluation order. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-object-logical");

const ROWS: Row[] = [
  {
    id: "PC14-01 obj || x and obj && x in TypeScript",
    files: {
      "main.ts": `const log: string[] = [];
function arr(): string[] { log.push("arr"); return ["a", "b"]; }
function fallback(): string[] { log.push("fallback"); return []; }
const xs = arr() || fallback();
console.log(xs.length, xs.join(","));
const rec = { n: 1 };
const n = rec && rec.n + 1;
console.log(n);
const tail = arr() && "after";
console.log(tail);
const m = new Map<string, number>([["k", 2]]);
console.log((m || new Map<string, number>()).get("k"));
console.log(log.join(" "));`,
    },
  },
  {
    id: "PC14-02 the picocolors probe shape in an untyped JavaScript module",
    files: {
      "main.js": `function args() { return ["node", "x", "--color"]; }
let ys = ["y"];
let argv = args() || [], other = ys && argv.length;
console.log(argv.includes("--color"), other, typeof process.platform);`,
    },
  },
  // Review: a plain-typed READ can hold undefined at run time (S119), so it
  // is no constant fold — Node takes the right side there.
  {
    id: "PC14-03 an index-signature read || a default",
    files: {
      "main.ts": `const m: { [k: string]: string[] } = { a: ["x"] };
console.log(JSON.stringify(m["x"] || ["dflt"]), JSON.stringify(m["a"] || ["dflt"]));`,
    },
  },
  {
    id: "PC14-04 an index-signature read && its member",
    files: {
      "main.ts": `const m: { [k: string]: string[] } = { z: ["a", "b"] };
console.log(m["y"] && m["y"].length, m["z"] && m["z"].length);`,
    },
  },
  {
    id: "PC14-05 an array read past the end || a default",
    files: {
      "main.ts": `const arr: number[][] = [[1]];
console.log(JSON.stringify(arr[5] || [9]), JSON.stringify(arr[0] || [9]));`,
    },
  },
  {
    id: "PC14-07 a non-null-asserted Map read || a default",
    files: {
      "main.ts": `const mp = new Map<string, number[]>([["j", [1]]]);
console.log(JSON.stringify(mp.get("k")! || [7]), JSON.stringify(mp.get("j")! || [7]));`,
    },
  },
];

describe("paperclip: || and && over an object left operand (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: || and && over an object left operand (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

// A mixed-kind default over a maybe-missing read refuses by name (the
// base refused it too); Node takes the right side.
describe("paperclip: a mixed-kind || over a maybe-missing read refuses by name", () => {
  const refusals: [string, string, string][] = [
    ["PC14-06", `class C { items!: string[]; }\nconsole.log(new C().items || "none");`, "'string' values where 'string[]' is expected"],
  ];
  test.for(refusals)("%s", async ([id, src, text]) => {
    await checkRefuses(scratch, { id, files: { "main.ts": src } }, text);
  });
});

// The c lane has no run-time test for a missing read (no typed-slot
// undefined): the maybe-missing shapes refuse there by name rather than
// fold.
describe("paperclip: the c lane refuses a maybe-missing read under || by name", () => {
  test("PC14-C1", async () => {
    const dir = join(scratch, "PC14-C1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.ts"), `const m: { [k: string]: string[] } = {};\nconsole.log(m["x"] || ["dflt"]);\n`);
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "c" });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toContain("logical operators on mixed operand types");
  });
});
