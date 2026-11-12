/* n8n step 2: for-in over an array, and arrays' hasOwnProperty. n8n's
 * mapConnectionsByDestination walks each output list with
 * `for (const inputIndex in list) { if (!list.hasOwnProperty(inputIndex))
 * continue; ... list[inputIndex] ... parseInt(inputIndex, 10) }`. A
 * `for (const k in arr)` key is always a canonical index string, so
 * indexing an array with it is indexing with Number(k), and an array owns
 * "length" plus its in-range indices. Synthetic rows written from reading
 * n8n's source; each runs under Node and on both WasmGC lanes. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";
import { runWasmToTrap } from "./wasm-host.js";

const scratch = scratchDir("n8n-forin-array");

const ROWS: Row[] = [
  {
    id: "N8N2-01 the mapConnectionsByDestination walk: for-in keys index the list and parse back to numbers",
    nodeTypes: false,
    files: {
      "main.ts": `interface Link {
  node: string;
  index: number;
}
interface ByType {
  [type: string]: Array<Link[] | null>;
}
interface Graph {
  [node: string]: ByType;
}
const g: Graph = { S: { main: [[{ node: "A", index: 0 }], null, [{ node: "B", index: 2 }]] } };
const out: Graph = {};
for (const src in g) {
  if (!g.hasOwnProperty(src)) continue;
  for (const t of Object.keys(g[src])) {
    if (!g[src].hasOwnProperty(t)) continue;
    for (const i in g[src][t]) {
      if (!g[src][t].hasOwnProperty(i)) continue;
      for (const info of g[src][t][i] ?? []) {
        if (!out.hasOwnProperty(info.node)) out[info.node] = {};
        if (!out[info.node].hasOwnProperty(t)) out[info.node][t] = [];
        const last = out[info.node][t].length - 1;
        for (let j = last; j < info.index; j++) out[info.node][t].push([]);
        out[info.node][t][info.index]?.push({ node: src, index: parseInt(i, 10) });
      }
    }
  }
}
console.log(JSON.stringify(out));`,
    },
  },
  {
    id: "N8N2-02 arrays' own keys: length, in-range integer indices, string literals",
    nodeTypes: false,
    files: {
      "main.ts": `const a = [10, 20, 30];
console.log(a.hasOwnProperty(0), a.hasOwnProperty(2), a.hasOwnProperty(3), a.hasOwnProperty(-1));
console.log(a.hasOwnProperty(1.5), a.hasOwnProperty(-0), a.hasOwnProperty(NaN));
console.log(a.hasOwnProperty("length"), a.hasOwnProperty("1"), a.hasOwnProperty("01"), a.hasOwnProperty("map"));
const keys: string[] = [];
for (const k in a) keys.push(k + "=" + a[k] + ":" + a.hasOwnProperty(k));
console.log(keys.join(" "));
a.pop();
console.log(a.hasOwnProperty(2), a.hasOwnProperty("2"));`,
    },
  },
  {
    id: "N8N2-03 a shadowing own key on a member-chain receiver: V8 prints the key chain in the TypeError",
    nodeTypes: false,
    files: {
      "main.ts": `interface ByType {
  [type: string]: number[];
}
interface Graph {
  [node: string]: ByType;
}
const out: Graph = { a: {} };
const hop = "hasOwnProperty";
out.a[hop] = [1];
const info = { node: "a" };
try {
  console.log(out[info.node].hasOwnProperty("main"));
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`n8n step 2: for-in over arrays (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}

/* Holes (SEMANTICS.md S119; review of n8n steps 1-3): a hole is not an own
 * index, but this tier stores it as the element's undefined. Once the
 * program has made one, an array holding undefined takes for-in's named
 * fence instead of answering true. */
describe("n8n step 2: arrays' hasOwnProperty meets the hole fence (wasm lane)", () => {
  const HOLES =
    "hasOwnProperty over an array that may hold holes (a write past an array's end leaves undefined where Node keeps a hole, and hasOwnProperty tells them apart";
  test.for([
    ["N8N2-H1 a write past the end", "const a: (number | undefined)[] = [1, 2, 3];\na[6] = 7;\nconsole.log('before');\nconsole.log(a.hasOwnProperty(4));"],
    ["N8N2-H2 new Array(n)", "const a: number[] = new Array(3);\nconsole.log('before');\nconsole.log(a.hasOwnProperty(0));"],
    ["N8N2-H3 an elision", "const a = [1, , 3];\nconsole.log('before');\nconsole.log(a.hasOwnProperty(1));"],
    ["N8N2-H4 a string key and a literal key", "const a: number[] = [];\na[2] = 5;\nconsole.log('before');\nconsole.log(a.hasOwnProperty('0'));"],
  ] as const)("%s", async ([id, src]) => {
    const file = join(scratch, `${id.split(" ")[0]}.ts`);
    writeFileSync(file, `${src}\n`);
    const res = await compile(file, { outPath: join(scratch, `${id.split(" ")[0]}.wasm`), outDir: scratch, backend: "wasm" });
    if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
    const r = await runWasmToTrap(res.binaryPath);
    expect(String(r.stdout)).toBe("before\n");
    expect(String(r.stderr)).toContain(HOLES);
  }, 600_000);
});
