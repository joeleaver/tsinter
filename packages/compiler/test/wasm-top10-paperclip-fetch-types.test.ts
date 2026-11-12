/* paperclip step 1: the fetch init type names BodyInit and HeadersInit.
 * A project whose tsconfig names no `lib` gets its target's full lib,
 * DOM included, so these resolve under its own tsc; scriptc's lowering
 * programs declare them (ambient/scriptc-fetch-init.d.ts: HeadersInit as
 * lib.dom does, BodyInit as the program's RequestInit body), in the
 * lowering world AND the project world preflight falls back to when the
 * lowering world has errors (PC1-03: paperclip reached that world). The
 * file joins only a program whose lib has no DOM entry, so a program that
 * does load lib.dom keeps lib.dom's own names (no duplicate identifier):
 * PC1-04/05 build projects whose tsconfig asks for DOM, and the gate's
 * predicate is pinned below. Type-only:
 * the rows check that the names resolve and code typed through them
 * builds and runs as Node does, with and without @types/node. */
import { describe, expect, test } from "vitest";
import { libIncludesDom } from "../src/frontend/shared.js";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-fetch-types");

const SRC = `type TextBody = Extract<BodyInit, string>;
// paperclip's http.ts passes init.headers into a HeadersInit parameter:
// the program's RequestInit members must be assignable to the names.
type HeadersFit = RequestInit["headers"] extends HeadersInit | undefined ? "yes" : "no";
type BodyFits = RequestInit["body"] extends BodyInit | null | undefined ? "yes" : "no";
const fits: [HeadersFit, BodyFits] = ["yes", "yes"];
function encode(body: unknown): TextBody {
  return JSON.stringify(body);
}
console.log(encode({ a: 1 }), fits[0], fits[1]);`;

const ROWS: Row[] = [
  { id: "PC1-01 BodyInit/HeadersInit with @types/node", files: { "main.ts": SRC } },
  { id: "PC1-02 BodyInit/HeadersInit without @types/node", files: { "main.ts": SRC }, nodeTypes: false },
  {
    // JSON.parse answers unknown in the lowering world (the override) and
    // any in the project world: the assignment errors only in the former,
    // so preflight consults the project world, where the fetch type names
    // must resolve too.
    id: "PC1-03 the names resolve in preflight's project world",
    files: {
      "main.ts": `${SRC}
const parsed = JSON.parse("1");
const n: number = parsed;
console.log(n + 1);`,
    },
  },
  {
    id: "PC1-04 a tsconfig with lib [ES2023, DOM]",
    files: {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, lib: ["ES2023", "DOM"] } }),
      "main.ts": SRC,
    },
  },
  {
    id: "PC1-05 a tsconfig with no lib at an ES target (the full default lib)",
    files: {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, target: "ES2023" } }),
      "main.ts": SRC,
    },
  },
];

describe("paperclip: the fetch-names file joins only DOM-less programs", () => {
  test("libIncludesDom", () => {
    expect(libIncludesDom(["lib.es2025.d.ts"])).toBe(false);
    expect(libIncludesDom(["es2023"])).toBe(false);
    expect(libIncludesDom(["ES2023", "DOM"])).toBe(true);
    expect(libIncludesDom(["lib.dom.d.ts"])).toBe(true);
    expect(libIncludesDom(["es2023", "dom.iterable"])).toBe(true);
    expect(libIncludesDom(undefined)).toBe(true);
    expect(libIncludesDom(["domain"])).toBe(false);
  });
});

describe("paperclip: fetch init type names (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: fetch init type names (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
