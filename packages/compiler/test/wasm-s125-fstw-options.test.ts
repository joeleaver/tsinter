/* S125 (objmodel2): an options object handed to fast-string-truncated-width's
 * `{}`-inferred parameters (truncationOptions = {}, widthOptions = {}) is
 * the caller's object, as in Node: absent keys read undefined (their `??`
 * defaults apply), present ones read the caller's values. The real package
 * (vendored unmodified under tests/fixtures/npm-static) is driven from
 * TypeScript and from a JavaScript wrapper of fast-string-width's shape. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineRows } from "./u3u4-rows.js";

const FSTW = join(__dirname, "../../../tests/fixtures/npm-static/node_modules/fast-string-truncated-width");
const PKG: Record<string, string> = { "node_modules/fast-string-truncated-width/package.json": readFileSync(join(FSTW, "package.json"), "utf8") };
for (const f of readdirSync(join(FSTW, "dist"))) PKG[`node_modules/fast-string-truncated-width/dist/${f}`] = readFileSync(join(FSTW, "dist", f), "utf8");
// A wrapper of fast-string-width's shape (its own module-level options
// literal into the measuring function, and its caller's options through).
const FSW: Record<string, string> = {
  "node_modules/fsw/package.json": `{"name":"fsw","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`,
  "node_modules/fsw/index.js": `import measure from "fast-string-truncated-width";
const WHOLE = { limit: Infinity, ellipsis: "", ellipsisWidth: 0 };
const width = (input, options = {}) => measure(input, WHOLE, options).width;
export default width;`,
  "node_modules/fsw/index.d.ts": `export type Options = { controlWidth?: number; tabWidth?: number; emojiWidth?: number; regularWidth?: number; wideWidth?: number };
declare const width: (input: string, options?: Options) => number;
export default width;`,
};
const NPM = ["fast-string-truncated-width", "fsw"];

defineRows("S125 fstw options", [
  {
    id: "S125-O-01 truncation options from TypeScript: limit and ellipsis present, ellipsisWidth absent (its `??` default measures the ellipsis)",
    entry: "main.ts", npmStatic: NPM, files: { ...PKG, ...FSW },
    src: `import measure from "fast-string-truncated-width";
const r = measure("hello world 漢字", { limit: 8, ellipsis: "…" });
console.log(r.width, r.index, r.truncated, r.ellipsed);
const o = { limit: 3 };
console.log(JSON.stringify(measure("abcdef", o)), JSON.stringify(o));`,
  },
  {
    id: "S125-O-02 width options from TypeScript beside empty truncation options",
    entry: "main.ts", npmStatic: NPM, files: { ...PKG, ...FSW },
    src: `import measure from "fast-string-truncated-width";
console.log(measure("\\t\\tx😀", {}, { tabWidth: 4, emojiWidth: 1 }).width, measure("\\tx", {}, {}).width);`,
  },
  {
    id: "S125-O-03 fast-string-width's shape: a JavaScript module's own options literal into the measuring function, and its caller's options passed through",
    entry: "main.ts", npmStatic: NPM, files: { ...PKG, ...FSW },
    src: `import width from "fsw";
console.log(width("┌  paperclip env"), width("\\tab"), width("\\tab", { tabWidth: 2 }), width("😀a", { emojiWidth: 3, regularWidth: 2 }));`,
  },
  {
    id: "S125-O-04 the callee writes the caller's options object (one object, as in Node), and an omitted one takes the default",
    entry: "main.ts", npmStatic: ["w"],
    files: {
      "node_modules/w/package.json": `{"name":"w","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`,
      "node_modules/w/index.js": `export function mark(input, opts = {}) { opts.seen = (opts.seen ?? 0) + 1; return input.length + (opts.extra ?? 0) + "/" + opts.seen; }`,
      "node_modules/w/index.d.ts": `export declare function mark(input: string, opts?: { seen?: number; extra?: number }): string;`,
    },
    src: `import { mark } from "w";
const o: { seen?: number; extra?: number } = { extra: 1 };
console.log(mark("ab", o), mark("ab", o), mark("x"), JSON.stringify(o), o.seen);`,
  },
]);
