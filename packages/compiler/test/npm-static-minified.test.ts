/* deepseek step 5: --npm-static's "looks minified" heuristic reads real
 * signals. Minified output is LONG LINES and MANGLED NAMES together; a
 * compact single-file package (long lines, real names) and a types-only
 * package's empty JS stub are not minified. The two minified shapes below
 * are written in the style of slimmed (tests/library-mode/npm-refuse) and
 * resolve.exports' dist (one line, one-letter names). */
import { describe, expect, test } from "vitest";
import { looksUnminified } from "../src/frontend/npm-static.js";

const READABLE_COMPACT =
  'export function resolveConditions(packageName, specifier, conditions) { const matches = conditions.filter((condition) => condition.startsWith(packageName)); return matches.length > 0 ? matches.map((match) => `${match}:${specifier}`).join(",") : `missing "${specifier}" in "${packageName}"`; } export function describeTarget(target, options) { if (options.verbose) return `target ${target.name} (${target.version})`; return target.name; }'.repeat(3);

const MANGLED_ONE_LINE =
  'function e(e,n,r){throw new Error(r?`No known conditions for "${n}" in "${e}"`:`Missing "${n}" in "${e}"`)}function n(n,i,o,f){let s,u,l=r(n,o),c=function(e){let n=new Set(["default",...e.c||[]]);return e.u||n.add(e.q?"q":"i"),n}(f||{}),a=i[l];if(void 0===a){let e,n,r,t;for(t in i)n&&t.length<n.length||("/"===t[t.length-1]&&l.startsWith(t)?(u=l.substring(t.length),n=t):t.length>1&&(r=t.indexOf("*",1)))}return a}';

const SLIMMED =
  '"use strict";' + Array.from({ length: 12 }, (_, i) => `exports.f${i}=function(a,b){return a+b*${i}};`).join("");

describe("npm-static: looksUnminified", () => {
  test.for([
    ["an empty types-only stub", "", true],
    ["a comment-only stub", "// types only\n/* nothing here */\n", true],
    ["readable multi-line code with short loop variables", "export function sum(values) {\n  let t = 0;\n  for (let i = 0; i < values.length; i++) t += values[i];\n  return t;\n}\n", true],
    ["a compact single-line package with real names", READABLE_COMPACT, true],
    ["a long data table (numbers, not names)", `export const TABLE = [${Array.from({ length: 400 }, (_, i) => i * 7).join(",")}];`, true],
    ["mangled one-line dist (resolve.exports style)", MANGLED_ONE_LINE, false],
    ["mangled exports table (slimmed)", SLIMMED, false],
  ] as const)("%s", ([, source, expected]) => {
    expect(looksUnminified(source)).toBe(expected);
  });
});
