/* paperclip step 1: the fetch init type names BodyInit and HeadersInit.
 * A project whose tsconfig names no `lib` gets its target's full lib,
 * DOM included, so these resolve under its own tsc; scriptc's lowering
 * program declares them as the members of the program's RequestInit
 * (ambient/scriptc-overrides.d.ts). Type-only: the rows check that the names resolve
 * and code typed through them builds and runs as Node does, with and
 * without @types/node. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-fetch-types");

const SRC = `type TextBody = Extract<BodyInit, string>;
type HeaderMap = Extract<HeadersInit, Record<string, string>>;
function encode(body: unknown): TextBody {
  return JSON.stringify(body);
}
function lower(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const k of Object.keys(headers)) out[k.toLowerCase()] = headers[k]!;
  return out;
}
console.log(encode({ a: 1 }));
console.log(JSON.stringify(lower({ Accept: "text/plain", "X-Id": "7" })));`;

const ROWS: Row[] = [
  { id: "PC1-01 BodyInit/HeadersInit with @types/node", files: { "main.ts": SRC } },
  { id: "PC1-02 BodyInit/HeadersInit without @types/node", files: { "main.ts": SRC }, nodeTypes: false },
];

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
