/* n8n step 1: `hasOwnProperty(k)` on records. n8n's workflow graph code
 * (mapConnectionsByDestination, getConnectedNodes, Workflow) walks its
 * connection maps, index-signature records of records, with
 * `if (!connections.hasOwnProperty(name)) continue`. The method is
 * Object.prototype's, so the answer is Object.hasOwn's own-key walk; an own
 * "hasOwnProperty" key shadows it (Node's TypeError). Synthetic rows written
 * from reading n8n's source; each runs under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("n8n-hasown");

const GRAPH = `interface ByType {
  [type: string]: number[];
}
interface Graph {
  [node: string]: ByType;
}
`;

const ROWS: Row[] = [
  {
    id: "N8N1-01 own keys of an index-signature record of records, literal and computed keys",
    nodeTypes: false,
    files: {
      "main.ts": `${GRAPH}const g: Graph = { S: { main: [1, 2] }, T: {} };
let calls = 0;
const key = (s: string): string => {
  calls++;
  return s;
};
console.log(g.hasOwnProperty("S"), g.hasOwnProperty("Z"), g.hasOwnProperty(key("T")), calls);
console.log(g.S.hasOwnProperty("main"), g["T"].hasOwnProperty("main"), g.hasOwnProperty("toString"));
g.Z = {};
delete g.S;
console.log(g.hasOwnProperty("Z"), g.hasOwnProperty("S"));`,
    },
  },
  {
    id: "N8N1-02 the for-in / hasOwnProperty walk (n8n's mapConnectionsByDestination loop head)",
    nodeTypes: false,
    files: {
      "main.ts": `${GRAPH}const g: Graph = { S: { main: [1], ai: [] }, T: { main: [] } };
const out: string[] = [];
for (const src in g) {
  if (!g.hasOwnProperty(src)) continue;
  for (const type of Object.keys(g[src])) {
    if (!g[src].hasOwnProperty(type)) continue;
    out.push(src + "." + type);
  }
}
console.log(out.join(" "));`,
    },
  },
  {
    id: "N8N1-03 declared fields: an optional field is own once it holds a value; number keys stringify",
    nodeTypes: false,
    files: {
      "main.ts": `interface Opt {
  a?: number;
  b: string;
}
const o: Opt = { b: "x" };
console.log(o.hasOwnProperty("a"), o.hasOwnProperty("b"), o.hasOwnProperty("c"));
o.a = 1;
console.log(o.hasOwnProperty("a"));
const n: { [k: string]: number } = { 1: 5 };
console.log(n.hasOwnProperty(1), n.hasOwnProperty("1"), n.hasOwnProperty(2));`,
    },
  },
  {
    id: "N8N1-04 an own 'hasOwnProperty' key shadows the method: TypeError after the argument evaluates",
    nodeTypes: false,
    files: {
      "main.ts": `${GRAPH}const shadow: Graph = {};
const hop = "hasOwnProperty";
shadow[hop] = { x: [1] };
let calls = 0;
const key = (s: string): string => {
  calls++;
  return s;
};
try {
  console.log(shadow.hasOwnProperty(key("x")));
} catch (e) {
  console.log((e as Error).name, (e as Error).message, calls);
}`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`n8n step 1: hasOwnProperty on records (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}
