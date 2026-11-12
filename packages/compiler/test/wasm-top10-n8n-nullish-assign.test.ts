/* n8n step 3: `??=` on member targets. n8n's node-helpers collects
 * parameter issues with `foundIssues.parameters ??= {}` and
 * `foundIssues.parameters[name] ??= []`, and fills filter defaults with
 * `filter.combinator ??= 'and'`. JS reads the target once and writes only
 * when it is nullish; over a side-effect-free member chain the statement is
 * `if (target == null) target = e`, with e evaluated only on the write
 * path. Synthetic rows written from reading n8n's source; each runs under
 * Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("n8n-nullish-assign");

const ROWS: Row[] = [
  {
    id: "N8N3-01 optional record fields and index-signature entries, filled once (n8n's issue collection)",
    nodeTypes: false,
    files: {
      "main.ts": `interface Issues {
  parameters?: { [name: string]: string[] };
  credentials?: string[];
}
const found: Issues = {};
let made = 0;
const fresh = (): string[] => {
  made++;
  return [];
};
for (const [name, msg] of [["a", "x"], ["b", "y"], ["a", "z"]] as const) {
  found.parameters ??= {};
  found.parameters[name] ??= fresh();
  found.parameters[name].push(msg);
}
console.log(JSON.stringify(found), made);`,
    },
  },
  {
    id: "N8N3-02 a present value is kept and the default never evaluates; null and undefined both take it",
    nodeTypes: false,
    files: {
      "main.ts": `interface Filter {
  combinator?: string;
  label: string | null;
  count: number | undefined;
}
let calls = 0;
const def = (s: string): string => {
  calls++;
  return s;
};
const f: Filter = { combinator: "or", label: null, count: undefined };
f.combinator ??= def("and");
f.label ??= def("none");
f.count ??= 3;
console.log(f.combinator, f.label, f.count, calls);
const g: Filter = { label: "l", count: 0 };
g.combinator ??= def("and");
g.label ??= def("unused");
g.count ??= 9;
console.log(g.combinator, g.label, g.count, calls);`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`n8n step 3: '??=' on member targets (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}
