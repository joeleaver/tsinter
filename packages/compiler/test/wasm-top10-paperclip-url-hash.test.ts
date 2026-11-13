/* paperclip step 10: the URL `hash` getter. paperclip's runtime command
 * reads `url.hash` while normalizing dashboard URLs; the getter fenced
 * ("protocol, pathname, href, host, hostname, search, searchParams ... are
 * the supported URL members"). It now reads the parsed fragment the way
 * WHATWG's getter does: "" when there is no fragment or an empty one, else
 * "#" and the fragment as the parser percent-encoded it. Rows run under
 * Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-url-hash");

const ROWS: Row[] = [
  {
    id: "PC10-01 URL.hash over fragments, empty fragments and none",
    files: {
      "main.ts": `const inputs = [
  "https://example.com/a/b?x=1#frag",
  "https://example.com/#",
  "https://example.com/",
  "https://example.com/p#a b%20c",
  "http://localhost:3100/#/issues/42?tab=1",
  "file:///tmp/x#é",
];
for (const s of inputs) {
  const u = new URL(s);
  console.log(JSON.stringify(u.hash), JSON.stringify(u.search), u.href);
}
const rel = new URL("../c#top", "https://example.com/a/b#old");
console.log(rel.hash, rel.pathname);
const u = new URL("https://example.com/?q=1#keep");
u.searchParams.set("q", "2");
console.log(u.hash, u.href);
const noHash = (s: string): string => { const v = new URL(s); return v.hash === "" ? v.href : v.href.slice(0, -v.hash.length); };
console.log(noHash("https://example.com/x#y"), noHash("https://example.com/x"));`,
    },
  },
];

describe("paperclip: URL.hash (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: URL.hash (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
