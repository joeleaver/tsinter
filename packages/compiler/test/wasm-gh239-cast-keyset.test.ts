// GH #239: a key written through a cast to an index-signature record
// (`x as Record<string, unknown>`) on a value of another record shape
// was an internal compiler error (SC9001 "recordKeySet receiver").
// The value keeps its own fixed fields through the cast, so the write
// refuses by name; a value that IS the cast's record type still writes.

import { defineRows } from "./u3u4-rows.js";

const REFUSED = /SC1090 .*a key added to a .* through a cast to .*nowhere to go/;

defineRows("GH #239 key writes through a record cast", [
  {
    id: "GH239-01 (issue) a dot write through `as Record<string, unknown>` on a closed record refuses by name",
    entry: "main.ts",
    src: `const x: { action: string } = { action: "a" };\n(x as Record<string, unknown>).z = 1;\nconsole.log(x);`,
    refused: REFUSED,
  },
  {
    id: "GH239-02 (issue, V14) the same write inside a forEach callback refuses by name",
    entry: "main.ts",
    src: `type P = { action: string; slug: string };\nconst ps: P[] = [{ action: "create", slug: "a" }];\nps.forEach((x) => { (x as Record<string, unknown>).seen = true; });\nconsole.log(ps);`,
    refused: REFUSED,
  },
  {
    id: "GH239-03 a bracket write with a literal key through the cast refuses by name",
    entry: "main.ts",
    src: `const x: { action: string } = { action: "a" };\n(x as Record<string, unknown>)["z"] = 1;\nconsole.log(x);`,
    refused: REFUSED,
  },
  {
    id: "GH239-04 a bracket write with a runtime key through the cast refuses by name",
    entry: "main.ts",
    src: `const x: { action: string } = { action: "a" };\nconst k = process.argv.length > 99 ? "q" : "z";\n(x as Record<string, unknown>)[k] = 1;\nconsole.log(x);`,
    refused: REFUSED,
  },
  {
    id: "GH239-05 (module-fns review) another module's function writes through the cast on its parameter: refuses by name",
    entry: "main.ts",
    files: {
      "w.ts": `export type W = { enabled?: boolean; n?: number };\nexport function mark(p: W): void { (p as Record<string, unknown>).n = 2; }`,
    },
    src: `import { mark } from "./w.ts";\nconst o: { enabled?: boolean; n?: number } = { enabled: true };\nmark(o);\nconsole.log(o);`,
    refused: REFUSED,
  },
  {
    id: "GH239-06 a value that IS the cast's record type still writes through it (Node's output)",
    entry: "main.ts",
    src: `const r: Record<string, unknown> = { a: 1 };\n(r as Record<string, unknown>).z = 2;\n(r as Record<string, unknown>)["y"] = 3;\nconst k = process.argv.length > 99 ? "q" : "w";\n(r as Record<string, unknown>)[k] = 4;\nconsole.log(r, Object.keys(r));`,
  },
]);
