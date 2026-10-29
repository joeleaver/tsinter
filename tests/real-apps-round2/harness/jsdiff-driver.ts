// A diff/patch CLI over jsdiff 9.0.0's own TypeScript source.
//   main.ts files <a> <b>          unified diff of two files, then apply it back
//   main.ts words <a> <b>          word diff of two strings, rendered [-x-]{+y+}
//   main.ts chars <a> <b>          char diff rendered
//   main.ts fuzz <seed> <n>        n random line/word/char diffs; checks patch roundtrip
import { readFileSync } from "node:fs";
import { diffChars, diffWords, diffLines, createTwoFilesPatch, applyPatch, parsePatch, reversePatch, diffArrays, structuredPatch } from "./src/index.ts";
import type { ChangeObject } from "./src/types.ts";

const args = process.argv.slice(2);
const cmd = args[0];

function render(parts: ChangeObject<string>[]): string {
  let s = "";
  for (const p of parts) {
    if (p.added) s += "{+" + p.value + "+}";
    else if (p.removed) s += "[-" + p.value + "-]";
    else s += p.value;
  }
  return s;
}

function files(a: string, b: string): void {
  const ta = readFileSync(a, "utf8");
  const tb = readFileSync(b, "utf8");
  const patch = createTwoFilesPatch(a, b, ta, tb, "old", "new", { context: 3 });
  process.stdout.write(patch);
  const back = applyPatch(ta, patch);
  console.log("apply ok:", back === tb);
  const parsed = parsePatch(patch);
  console.log("hunks:", parsed[0].hunks.length, "lines:", parsed[0].hunks.map((h) => h.lines.length).join(","));
  const rev = reversePatch(parsed[0]);
  console.log("reverse ok:", applyPatch(tb, rev) === ta);
  const lines = diffLines(ta, tb);
  let add = 0, del = 0;
  for (const p of lines) {
    if (p.added) add += p.count;
    else if (p.removed) del += p.count;
  }
  console.log(`+${add} -${del}`);
}

function fuzz(seed: number, n: number): void {
  let s = seed >>> 0;
  const rnd = (k: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % k;
  };
  const words = ["alpha", "beta", "gamma", "delta", "x", "y", "  ", "\t", "foo-bar", "é", "日本", "a.b", "", "1", "22"];
  const mkLine = (): string => {
    const k = rnd(5);
    const out: string[] = [];
    for (let i = 0; i < k; i++) out.push(words[rnd(words.length)]);
    return out.join(rnd(3) === 0 ? "  " : " ");
  };
  const mkText = (): string => {
    const k = rnd(12);
    const out: string[] = [];
    for (let i = 0; i < k; i++) out.push(mkLine());
    return out.join("\n") + (rnd(2) === 0 ? "\n" : "");
  };
  const mutate = (t: string): string => {
    const ls = t.split("\n");
    const m = rnd(4);
    for (let i = 0; i < m; i++) {
      const op = rnd(3);
      const at = rnd(ls.length + 1);
      if (op === 0) ls.splice(at, 0, mkLine());
      else if (op === 1 && ls.length > 0) ls.splice(at % ls.length, 1);
      else if (ls.length > 0) ls[at % ls.length] = mkLine();
    }
    return ls.join("\n");
  };
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const a = mkText();
    const b = rnd(5) === 0 ? mkText() : mutate(a);
    const p = createTwoFilesPatch("a", "b", a, b, undefined, undefined, { context: rnd(4) });
    const back = applyPatch(a, p);
    const w = render(diffWords(a, b));
    const c = render(diffChars(a.slice(0, 40), b.slice(0, 40)));
    const arr = diffArrays(a.split(""), b.split("")).length;
    const sp = structuredPatch("a", "b", a, b);
    console.log(`#${i} ${back === b ? "ok" : "FAIL"} plen=${p.length} hunks=${sp.hunks.length} arr=${arr} w=${JSON.stringify(w).length} c=${JSON.stringify(c)}`);
    if (back === b) ok++;
  }
  console.log(`fuzz ${ok}/${n}`);
}

if (cmd === "files") files(args[1], args[2]);
else if (cmd === "words") console.log(render(diffWords(args[1], args[2])));
else if (cmd === "chars") console.log(render(diffChars(args[1], args[2])));
else if (cmd === "fuzz") fuzz(Number(args[1]), Number(args[2]));
else {
  console.error("usage: files|words|chars|fuzz");
  process.exit(2);
}
