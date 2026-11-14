/* rea (top-10 #2), javascriptSemanticGetterQueries.ts: a class field
 * `#nodes: Set<Node>` over Babel's AST node union. Record types cut a
 * cycle only at a type on the walk's stack, so ~250 mutually recursive
 * node interfaces re-expanded once per path and the compile ran for hours.
 * A top-level mapping now takes at most MAP_TYPE_STEP_BUDGET steps and
 * refuses past it by name (SC1090, naming Class.member and the record
 * path) — a loud stop in seconds instead of a silent stall. Mappings
 * under the budget are untouched (the recursive-tree row, and the census).
 * A FINITE shared sub-type (a DAG of interfaces) maps once per request —
 * completed non-recursive record mappings are memoized — so DAGs stay
 * linear and the budget bites only on cyclic re-expansion (rows 04–05).
 *
 * The AST here is synthetic: 30 node interfaces whose fields are typed by
 * DISTINCT small unions of other node interfaces (Babel's shape:
 * `left: LVal`, `body: Array<Statement | Directive>`, …) — the walk
 * re-expands every interface off its stack once per path. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const scratch = mkdtempSync(join(tmpdir(), "tsinter-map-budget-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function astProgram(n: number, sites = 1): string {
  const names = Array.from({ length: n }, (_, i) => `N${i}`);
  const lines: string[] = [`type Node = ${names.join(" | ")};`];
  const at = (k: number): string => names[k % n]!;
  names.forEach((name, i) => {
    lines.push(
      `interface ${name} { kind: "n${i}"; ` +
        `left: ${at(i + 1)} | ${at(i + 2)} | null; ` +
        `right: Array<${at(i + 3)} | ${at(i + 5)}>; ` +
        `meta: { start: number; inner: ${at(i + 7)} | ${at(i + 11)} | null } }`,
    );
  });
  lines.push(`class SemanticSet {
  #nodes = new Set<Node>();
  add(node: Node): void { this.#nodes.add(node); }
  get size(): number { return this.#nodes.size; }
}
const s = new SemanticSet();
s.add({ kind: "n0", left: null, right: [], meta: { start: 0, inner: null } });
console.log(s.size);`);
  // More sites over the same graph through DIFFERENT container types (each
  // its own top-level mapping request).
  if (sites >= 2) lines.push(`class ByName { #byName = new Map<string, Node[]>(); get n(): number { return this.#byName.size; } }\nconsole.log(new ByName().n);`);
  if (sites >= 3) lines.push(`class Pairs { pairs: Array<[string, Node | null]> = []; }\nconsole.log(new Pairs().pairs.length);`);
  return lines.join("\n");
}

/** A DAG of interfaces: level i has `fan` fields all typed by level i+1;
 * the last level is a leaf `{ v: number }`. Values share each level's one
 * object, so the program is small while the type has fan^depth paths. */
function dagProgram(fan: number, depth: number): string {
  const lines: string[] = [`interface L${depth} { v: number }`];
  const fields = Array.from({ length: fan }, (_, k) => `f${k}`);
  for (let i = depth - 1; i >= 0; i--) lines.push(`interface L${i} { ${fields.map((f) => `${f}: L${i + 1}`).join("; ")} }`);
  lines.push(`const x${depth}: L${depth} = { v: 7 };`);
  for (let i = depth - 1; i >= 0; i--) lines.push(`const x${i}: L${i} = { ${fields.map((f) => `${f}: x${i + 1}`).join(", ")} };`);
  const hops = Array.from({ length: depth }, (_, i) => `.f${(i * 3) % fan}`).join("");
  lines.push(`class Holder { root: L0 = x0; }`);
  lines.push(`console.log(new Holder().root${hops}.v, x0${hops}.v + 1);`);
  return lines.join("\n");
}

/** The per-path walk (TSINTER_RECURSIVE_GROUPS=off): with recursive
 * groups (step 11 (B)) the synthetic AST maps as one group, so the budget
 * rows exercise the per-path backstop the budget still guards. */
async function compilePerPath(entry: string) {
  const prev = process.env.TSINTER_RECURSIVE_GROUPS;
  process.env.TSINTER_RECURSIVE_GROUPS = "off";
  try {
    return await compile(entry, { outPath: join(dirname(entry), "p.wasm"), outDir: dirname(entry), backend: "wasm" });
  } finally {
    if (prev === undefined) delete process.env.TSINTER_RECURSIVE_GROUPS;
    else process.env.TSINTER_RECURSIVE_GROUPS = prev;
  }
}

function write(id: string, src: string): string {
  const dir = join(scratch, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "map-budget-row", private: true, type: "module" }));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, src + "\n");
  return entry;
}

describe("rea step 11: the type-mapping step budget (wasm lane vs Node)", () => {
  test("MAPBUDGET-01 a 30-interface mutually recursive AST behind a class field refuses by name, fast, naming Class.member and the record path", async () => {
    const entry = write("MAPBUDGET-01", astProgram(30));
    const t0 = Date.now();
    const res = await compilePerPath(entry);
    const secs = (Date.now() - t0) / 1000;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const named = res.diagnostics.filter((d) => d.code === "SC1090" && /static mapping expands past \d+ steps/.test(d.message));
    expect(named.length, JSON.stringify(res.diagnostics)).toBeGreaterThan(0);
    expect(named[0]!.message).toMatch(/\(SemanticSet\.#nodes: [^)]*N\d+[^)]*\)/);
    expect(secs).toBeLessThan(240);
  }, 600_000);

  test("MAPBUDGET-03 more sites over the same graph through different container types refuse by name at once: only the first pays the budget", async () => {
    const entry = write("MAPBUDGET-03", astProgram(30, 3));
    const t0 = Date.now();
    const res = await compilePerPath(entry);
    const secs = (Date.now() - t0) / 1000;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const named = res.diagnostics.filter((d) => d.code === "SC1090" && /static mapping expands past \d+ steps/.test(d.message));
    expect(named.length, JSON.stringify(res.diagnostics.map((d) => d.message))).toBeGreaterThanOrEqual(2);
    expect(named.some((d) => /SemanticSet\.#nodes/.test(d.message)), named.map((d) => d.message).join(" || ")).toBe(true);
    expect(named.some((d) => /ByName\.#byName/.test(d.message)), named.map((d) => d.message).join(" || ")).toBe(true);
    expect(secs).toBeLessThan(240);
  }, 600_000);

  test.for([
    ["MAPBUDGET-04 a binary DAG of interfaces 17 deep (2^17 paths, one shared object per level) compiles fast and matches Node", 2, 17],
    ["MAPBUDGET-05 a 10-way fan of interfaces 5 deep (10^5 paths) compiles fast and matches Node", 10, 5],
  ] as const)("%s", async ([id, fan, depth]) => {
    const entry = write(id.split(" ")[0]!, dagProgram(fan, depth));
    const dir = dirname(entry);
    const t0 = Date.now();
    const res = await compile(entry, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm" });
    const secs = (Date.now() - t0) / 1000;
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
    expect(secs).toBeLessThan(60);
    const node = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dir });
    expect(node.status, node.stderr).toBe(0);
    const got = await runWasm(res.binaryPath!);
    expect(String(got.stdout)).toBe(node.stdout);
  }, 300_000);

  test("MAPBUDGET-02 an ordinary recursive tree type (a parent back-pointer, a Set of roots) still maps and runs as Node", async () => {
    // (A recursive record type as a CLASS FIELD crashes the wasm emitter
    // on main — "beginRecGroup inside an open rec group", filed separately;
    // the row keeps the type at module level.)
    const src = `interface Tree { label: string; kids: Tree[]; parent: Tree | null }
const roots = new Set<Tree>();
const root: Tree = { label: "r", kids: [], parent: null };
root.kids.push({ label: "a", kids: [], parent: root }, { label: "b", kids: [], parent: root });
roots.add(root);
let n = 0;
const walk = (t: Tree): void => { n++; for (const k of t.kids) walk(k); };
for (const r of roots) walk(r);
console.log(n, root.kids.map((k) => k.label + "<" + (k.parent?.label ?? "")).join(" "));`;
    const entry = write("MAPBUDGET-02", src);
    const dir = dirname(entry);
    const res = await compile(entry, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm" });
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
    const node = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entry], { encoding: "utf8", input: "", cwd: dir });
    expect(node.status, node.stderr).toBe(0);
    const got = await runWasm(res.binaryPath!);
    expect(String(got.stdout)).toBe(node.stdout);
  }, 120_000);
});
