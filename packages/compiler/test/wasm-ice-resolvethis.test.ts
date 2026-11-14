/* A compiler crash (TypeError in CheckerFacade.symbolDeclaredIn) that
 * commander's JS and paperclip's census both hit, in commander@15's
 * lib/suggestSimilar.js: a Command method calls suggestSimilar(word,
 * candidates), whose `candidates.filter((candidate) => ...)` arrow calls
 * editDistance(a, b), which writes `d[i][j] = ...` into a local array.
 * JavaScript function instances are lowered at their first call, nested
 * inside the caller's body, so the element write's undefined-slot guard
 * asked resolveThis() for a `this` the instance does not have; the walk
 * reached the method's `this` and threaded it as a capture through the
 * capture-less instance, whose fence read the declarations of the
 * synthetic this-binding symbol (it has none). The guard now looks up
 * only the current function's own binding, and the checker facade
 * treats a symbol with no declarations as declared nowhere. */
import { describe, test } from "vitest";
import { checkBuilds, checkFenced, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("ice-resolvethis");

const ROWS: Row[] = [
  {
    id: "ICE-THIS-01 element writes in a JS function instance first called through an arrow inside a method of a .d.ts-typed npm-static package (commander's suggestSimilar)",
    nodeTypes: false,
    npmStatic: ["sim"],
    files: {
      "node_modules/sim/package.json": JSON.stringify({ name: "sim", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
      "node_modules/sim/index.d.ts": `export declare class Cmd {
  unknownOption(flag: string): string;
}`,
      "node_modules/sim/index.js": `const maxDistance = 3;
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > maxDistance) return Math.max(a.length, b.length);
  const d = [];
  for (let i = 0; i <= a.length; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j] = j;
  }
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      let cost;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
      } else {
        cost = 1;
      }
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}
function suggestSimilar(word, candidates) {
  let similar = [];
  let bestDistance = maxDistance;
  candidates.forEach((candidate) => {
    const distance = editDistance(word, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      similar = [candidate];
    } else if (distance === bestDistance) {
      similar.push(candidate);
    }
  });
  return similar;
}
class Cmd {
  constructor() {
    this.flags = ["help", "version", "port"];
  }
  unknownOption(flag) {
    const similar = suggestSimilar(flag, this.flags);
    return similar.length > 0 ? "Did you mean --" + similar.join(", --") + "?" : "no suggestion";
  }
}
module.exports = { Cmd };`,
      "main.ts": `import { Cmd } from "sim";
const c = new Cmd();
console.log(c.unknownOption("hepl"), c.unknownOption("zzzzzzzzz"));`,
    },
  },
];

// The program builds (the crash is gone) and then stops, by name, at the
// first deferred fence commander's own build carries on this path: the
// forEach callback value over `any` (SC2011; paperclip blocker B4, then
// B6's number[][] copy). When those land, this becomes a byte-for-byte row.
describe("element writes in a nested JS function instance: the build no longer crashes", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s (wasm builds)", async ([, row]) => {
    await checkBuilds(scratch, row, "wasm");
  });
  test.for(ROWS.map((r) => [r.id, r] as const))("%s (wasm-native stops by name at a deferred fence)", async ([, row]) => {
    await checkFenced(scratch, row, "wasm-native", "", "values of type '(candidate: any) => void'");
  }, 600_000);
});
