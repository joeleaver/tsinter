/* S125: a frozen module-scope sentinel in a compiled package's JavaScript
 * (zod 4.6.7 v4/core/core.js:4, `export const NEVER = Object.freeze({ status:
 * "aborted" })`): one object, compared by identity, frozen as in Node. */
import { defineRows } from "./u3u4-rows.js";

const PKG: Record<string, string> = {
  "node_modules/z/package.json": `{"name":"z","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`,
  "node_modules/z/core.js": `export const NEVER = /*@__PURE__*/ Object.freeze({
    status: "aborted",
});`,
  "node_modules/z/index.js": `import { NEVER } from "./core.js";
export { NEVER };
export function run(x) { return x < 0 ? NEVER : { status: "valid", value: x }; }
export function isNever(r) { return r === NEVER; }
export function frozen() { return [Object.isFrozen(NEVER), Object.isFrozen({})].join(","); }
export function tryWrite() { try { NEVER.status = "x"; return "wrote " + NEVER.status; } catch (e) { return e.constructor.name + " " + NEVER.status; } }`,
  "node_modules/z/index.d.ts": `export declare const NEVER: never;
export declare function run(x: number): unknown;
export declare function isNever(r: unknown): boolean;
export declare function frozen(): string;
export declare function tryWrite(): string;`,
};

defineRows("S125 frozen sentinel", [
  {
    id: "S125-Z-01 (zod NEVER) a package's frozen sentinel returned across modules and compared by identity; isFrozen; a write throws in a module",
    entry: "main.ts", npmStatic: ["z"], files: PKG,
    src: `import { run, isNever, frozen, tryWrite } from "z";
const a = run(-1), b = run(2);
console.log(a, b, isNever(a), isNever(b));
console.log(frozen(), tryWrite());`,
  },
  {
    id: "S125-Z-02 (zod NEVER, paperclip's `return z.NEVER` transforms) the program builds; the sentinel (declared 'never') returned where the function's type is 'number' stops by name when that branch runs",
    entry: "main.ts", npmStatic: ["z"], files: PKG,
    fence: { text: /expected number at \$, got object/, stdout: "4 false\n" },
    src: `import { NEVER, isNever } from "z";
function transform(v: number): number { if (v < 0) return NEVER; return v * 2; }
console.log(transform(2), isNever(transform(3)));
try { console.log(isNever(transform(-1))); } catch (e) { console.log("threw", (e as Error).name); }`,
  },
  {
    id: "S125-Z-03 a sloppy-mode script's write to a frozen object is silently ignored; strict mode throws; Object.isFrozen and a sentinel compared by identity",
    entry: "main.cjs",
    src: `const NEVER = Object.freeze({ status: "aborted" });
function run(x) { return x < 0 ? NEVER : { status: "valid", value: x }; }
const a = run(-1), b = run(1);
console.log(a === NEVER, b === NEVER, Object.isFrozen(NEVER), Object.isFrozen(b));
NEVER.status = "x";
NEVER.extra = 1;
console.log(NEVER.status, NEVER.extra, JSON.stringify(NEVER), Object.keys(NEVER));
const strict = () => { "use strict"; try { NEVER.status = "y"; return "wrote"; } catch (e) { return e.constructor.name; } };
console.log(strict(), NEVER.status);`,
  },
]);
