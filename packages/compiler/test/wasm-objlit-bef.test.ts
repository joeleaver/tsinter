/* Paperclip's small object-literal blockers (B + E + F of its object-model
 * slice): a URLSearchParams record init with shorthand entries, and
 * Object.prototype.hasOwnProperty.call over a typed record. (B, the
 * request-init literal with a leading spread and shorthand properties, is
 * FX-04 in wasm-fetch.test.ts: it needs a live fetch.) Compared with Node
 * byte for byte on the wasm and wasm-native lanes (u3u4-rows.ts). */
import { defineRows } from "./u3u4-rows.js";

defineRows("object-literal and own-key idioms", [
  {
    id: "BEF-E1 new URLSearchParams({ ref, path }): shorthand entries in source order, mixed with name: value",
    entry: "main.ts",
    src: `const ref = "main";
const path = "src/a b.ts";
const p = new URLSearchParams({ ref, path, mode: "raw" });
console.log(p.toString(), p.get("path"));`,
  },
  {
    id: "BEF-F1 Object.prototype.hasOwnProperty.call over a typed record: own keys only (an index-signature record and a plain one)",
    entry: "main.ts",
    src: `const files: Record<string, string> = { "a.txt": "x", "dir/b.txt": "y" };
const normalizedPath = "dir/b.txt";
console.log(Object.prototype.hasOwnProperty.call(files, normalizedPath), Object.prototype.hasOwnProperty.call(files, "toString"), Object.prototype.hasOwnProperty.call(files, "c"));
files["c"] = "z";
console.log(Object.prototype.hasOwnProperty.call(files, "c"), ({}).hasOwnProperty.call(files, "a.txt"));
const rec = { a: 1, b: "two" };
console.log(Object.prototype.hasOwnProperty.call(rec, "a"), Object.prototype.hasOwnProperty.call(rec, "z"));`,
  },
]);
