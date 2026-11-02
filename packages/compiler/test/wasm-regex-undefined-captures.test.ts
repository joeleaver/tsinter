/* GH #89 (SEMANTICS.md S064, narrowed to the c and llvm lanes): on the
 * WasmGC lanes a capture group that did not participate in a match is
 * Node's `undefined` — in exec/match rows, matchAll rows, `.groups`
 * entries (duplicate names included), split()'s spliced slots and a
 * function replacer's capture arguments, however the parameter is
 * annotated — while `$n` / `$<n>` in a replacement string stay "" as in
 * Node. Unit U (S119) made string slots able to hold `undefined`.
 *
 * The c and llvm lanes keep "" (S064), so these programs cannot be corpus
 * programs (the corpus runs on every lane); each row runs here under Node
 * (the oracle, spawned at test time — no hand-typed output) and on the
 * wasm and wasm-native lanes. Printing a match ARRAY is avoided: Node
 * prints its index/input/groups too (S116 (c)), and a groups object is
 * null-prototype in Node — rows print through JSON, String and typeof. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh89-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function nodeRun(file: string): Promise<string> {
  const p = run(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8" });
  p.child.stdin?.end();
  return (await p).stdout;
}

async function wasmRun(id: string, file: string): Promise<string> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  expect(r.exitCode).toBe(0);
  return String(r.stdout);
}

async function nativeRun(id: string, file: string): Promise<string> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const p = run(res.binaryPath, [], { encoding: "utf8" });
  p.child.stdin?.end();
  return (await p).stdout;
}

const ROWS: { id: string; src: string }[] = [
  {
    // the real-app trial's repro (tests/real-apps-round2/silent/04), minus
    // the match-array print (S116 (c))
    id: "01-round2-repro",
    src: `const m = /(a)(b)?(?<c>c)?/.exec("a")!;
console.log(m[2], m[2] === undefined, typeof m[2], m.length);
console.log(m.groups?.["c"], m.groups?.["c"] === undefined, typeof m.groups?.["c"]);
console.log(JSON.stringify(m.groups), \`\${m.groups!["c"]}\`);
const all = [..."xa".matchAll(/x(y)?/g)];
console.log(all[0][1] === undefined, "x".match(/x(y)?/)![1] === undefined);
console.log("x".replace(/x(y)?/, (_m, g: string | undefined) => String(g === undefined)));`,
  },
  {
    id: "02-observers",
    src: `const m = /(a)(b)?(?<c>c)?/.exec("xa")!;
console.log(String(m[2]), \`\${m[3]}\`, m[2] ?? "dflt", typeof m[3], m[2] === m[3], m[1] === "a", m[2] == null);
console.log(JSON.stringify(m), JSON.stringify(m.groups), Object.keys(m.groups!));
const [, a1, b1, c1] = m;
console.log(a1, b1, c1, b1 === undefined, "<" + b1 + ">");
console.log(m.slice(1).map((x) => x ?? "-").join("|"), m.join("/"), m[2]?.length, m.length);
const [, , two = "dflt2"] = m;
console.log(two);`,
  },
  {
    // an UNSET capture vs a participating-EMPTY one: Node tells them apart
    id: "03-unset-vs-empty",
    src: `const u = "b".match(/(a*)*/)!;
const e = /(a*)+/.exec("b")!;
console.log(JSON.stringify(u), JSON.stringify(e), u[1] === undefined, e[1] === "");
const g = /(?<y>\\d{4})-(?<mo>\\d\\d)?/.exec("2024-")!;
console.log(g.groups!["mo"], g.groups!.y, g.groups!["mo"] === undefined, JSON.stringify(g.groups));`,
  },
  {
    id: "04-global-exec-and-matchall",
    src: `const w = /(a)|(b)/g;
let e: RegExpExecArray | null;
while ((e = w.exec("ab")) !== null) console.log(e[1] ?? "U1", e[2] ?? "U2", JSON.stringify(e), e.index);
for (const r of "a1 b".matchAll(/([a-z])(\\d)?/g)) console.log(r[1], r[2], r.index, typeof r[2]);
console.log(JSON.stringify([..."q".matchAll(/(z)?/g)].map((r) => r[1])));
const s = "k=v; flag; x=1".match(/(\\w+)(?:=(\\w+))?/)!;
console.log(s[2] === undefined ? "no value" : s[2]);`,
  },
  {
    id: "05-split-splice",
    src: `console.log(JSON.stringify("ab".split(/(x)?b/)));
console.log(JSON.stringify("1a2b3".split(/(\\d)|([a-z])/)));
const parts = "a-b_c".split(/(-)|(_)/);
console.log(parts.length, parts.map((p) => (p === undefined ? "U" : p)).join(","));`,
  },
  {
    // \`$n\` / \`$<n>\` in a replacement STRING stay "" (Node's GetSubstitution);
    // a function replacer's capture is undefined however it is annotated
    id: "06-replace",
    src: `console.log("ab".replace(/(x)?b/, "[$1]"), "ab".replace(/(?<n>x)?b/, "[$<n>]"), "ab".replaceAll(/(x)?b/g, "<$1>"));
console.log("ab".replace(/(x)?b/, (_m: string, g: string) => \`<\${g}|\${typeof g}>\`));
console.log("ab".replace(/(x)?b/, (_m, g) => \`<\${g}>\`));
console.log("ab".replace(/(x)?b/, (_m: string, g?: string) => g ?? "opt"));
console.log("ab".replace(/(?<n>x)?b/, (_m: string, _g: string, _o: number, _s: string, groups: { [k: string]: string }) => JSON.stringify(groups) + String(groups["n"])));`,
  },
  {
    // ES2025 duplicate named groups: the participating occurrence, also
    // when the first occurrence did not participate
    id: "07-duplicate-named-groups",
    src: `const re = /(?<n>a)x|(?<n>b)y/;
for (const s of ["ax", "by", "zz"]) {
  const m = re.exec(s);
  console.log(s, m === null ? "null" : String(m.groups!["n"]), m === null ? "-" : JSON.stringify(m));
}`,
  },
];

describe("GH #89: nonparticipating captures are undefined (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, row.src + "\n");
    const [node, wasm] = await Promise.all([nodeRun(file), wasmRun(id, file)]);
    expect(wasm).toBe(node);
  });
});

describe("GH #89: the same rows on the wasm-native lane", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    const [node, wn] = await Promise.all([nodeRun(file), nativeRun(id, file)]);
    expect(wn).toBe(node);
  }, 600_000);
});
