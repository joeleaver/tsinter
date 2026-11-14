/* rea step 11 (B) verify mode: recursive groups change only shape
 * IDENTITIES, never a type's structure. Off by default; run with
 *   TSINTER_RECURSIVE_GROUPS_VERIFY=1 npx vitest run tests/harness/recursive-groups-verify.test.ts
 * (on nico-top). Every corpus program compiles twice to the wasm IR —
 * per-path record mapping (TSINTER_RECURSIVE_GROUPS=off) and recursive
 * groups (on) — and the two IR modules are compared by BISIMULATION:
 * walked in parallel, every record/union reference pairs the two ids
 * instead of comparing them, and every paired definition must match
 * structurally (field names, order, flags; union arms as a set), under
 * the same pairing, coinductively. A type-level difference, or a program
 * that builds in one mode and not the other, fails the run. Differences
 * outside type positions (a union arm's runtime tag literal follows its
 * arm order, which follows ids) are listed for inspection. With the flag
 * set, the type mapper also asserts that every group discovery left its
 * state untouched (types.ts discoverRecordGraph). Runtime behavior is the
 * census's job (wasm-differential), which runs with groups on. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../../packages/compiler/src/index.js";

const ON = process.env.TSINTER_RECURSIVE_GROUPS_VERIFY === "1";
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const files = ["ts", "js", "mjs", "cjs"]
  .flatMap((ext) => [...globSync(join(corpusDir, `*.${ext}`)), ...globSync(join(corpusDir, `*/main.${ext}`))])
  .sort();
const scratch = ON ? mkdtempSync(join(tmpdir(), "tsinter-rg-verify-")) : "";
afterAll(() => {
  if (ON) rmSync(scratch, { recursive: true, force: true });
});

type J = unknown;
interface Ir {
  records?: { id: string; fields: J[] }[];
  unions?: { id: string; arms: J[] }[];
  [k: string]: J;
}

async function irOf(file: string, mode: "on" | "off", dir: string): Promise<{ ok: boolean; codes: string[]; ir: Ir | null }> {
  mkdirSync(dir, { recursive: true });
  const prev = process.env.TSINTER_RECURSIVE_GROUPS;
  if (mode === "off") process.env.TSINTER_RECURSIVE_GROUPS = "off";
  else delete process.env.TSINTER_RECURSIVE_GROUPS;
  try {
    const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", emitIr: true });
    const irFile = readdirSync(dir).find((f) => f.endsWith(".ir.json"));
    const ir = irFile === undefined ? null : (JSON.parse(readFileSync(join(dir, irFile), "utf8")) as Ir);
    return { ok: res.ok, codes: res.ok ? [] : res.diagnostics.map((d) => d.code).sort(), ir };
  } finally {
    if (prev === undefined) delete process.env.TSINTER_RECURSIVE_GROUPS;
    else process.env.TSINTER_RECURSIVE_GROUPS = prev;
  }
}

/** Ids replaced by placeholders: a union arm's id-free signature. */
const sig = (t: J): string => JSON.stringify(t, (k, v) => (k === "shapeId" ? "R" : k === "unionId" ? "U" : v));

class Bisim {
  readonly typeDiffs: string[] = [];
  readonly otherDiffs: string[] = [];
  private readonly rec = new Map<string, string>();
  private readonly uni = new Map<string, string>();
  private readonly queue: ["r" | "u", string, string][] = [];
  constructor(private readonly a: Ir, private readonly b: Ir) {}

  private pair(kind: "r" | "u", x: string, y: string, path: string): void {
    const m = kind === "r" ? this.rec : this.uni;
    const seen = m.get(x);
    if (seen === undefined) {
      m.set(x, y);
      this.queue.push([kind, x, y]);
    } else if (seen !== y) {
      // One old id meeting two new ids is fine only if those are
      // structurally the same; check them as a pair too.
      this.queue.push([kind, seen, y]);
      void path;
    }
  }

  walk(x: J, y: J, path: string, inType: boolean): void {
    if (x !== null && y !== null && typeof x === "object" && typeof y === "object") {
      if (Array.isArray(x) !== Array.isArray(y)) return this.diff(path, inType, x, y);
      if (Array.isArray(x) && Array.isArray(y)) {
        if (x.length !== y.length) return this.diff(path, inType, `len ${x.length}`, `len ${y.length}`);
        x.forEach((e, i) => this.walk(e, y[i], `${path}[${i}]`, inType));
        return;
      }
      const ox = x as Record<string, J>;
      const oy = y as Record<string, J>;
      if (ox.kind === "record" && oy.kind === "record" && typeof ox.shapeId === "string" && typeof oy.shapeId === "string") {
        this.pair("r", ox.shapeId, oy.shapeId, path);
        return;
      }
      if (ox.kind === "union" && oy.kind === "union" && typeof ox.unionId === "string" && typeof oy.unionId === "string") {
        this.pair("u", ox.unionId, oy.unionId, path);
        return;
      }
      const keys = new Set([...Object.keys(ox), ...Object.keys(oy)]);
      for (const k of keys) {
        const typeKey = inType || k === "type" || k === "returnType" || k === "ret" || k === "params" || k === "fields" || k === "arms";
        this.walk(ox[k], oy[k], `${path}.${k}`, typeKey);
      }
      return;
    }
    if (x !== y) this.diff(path, inType, x, y);
  }

  private diff(path: string, inType: boolean, x: J, y: J): void {
    const line = `${path}: ${JSON.stringify(x)?.slice(0, 80)} vs ${JSON.stringify(y)?.slice(0, 80)}`;
    (inType ? this.typeDiffs : this.otherDiffs).push(line);
  }

  run(): void {
    const { records: _ra, unions: _ua, ...restA } = this.a;
    const { records: _rb, unions: _ub, ...restB } = this.b;
    this.walk(restA, restB, "$", false);
    const recA = new Map((this.a.records ?? []).map((r) => [r.id, r]));
    const recB = new Map((this.b.records ?? []).map((r) => [r.id, r]));
    const uniA = new Map((this.a.unions ?? []).map((u) => [u.id, u]));
    const uniB = new Map((this.b.unions ?? []).map((u) => [u.id, u]));
    const done = new Set<string>();
    while (this.queue.length > 0) {
      const [kind, x, y] = this.queue.shift()!;
      const key = `${kind}:${x}:${y}`;
      if (done.has(key)) continue;
      done.add(key);
      if (kind === "r") {
        const ra = recA.get(x);
        const rb = recB.get(y);
        if (ra === undefined || rb === undefined) continue; // an id the other side never emitted (a builtin shape)
        const { id: _ia, ...fa } = ra;
        const { id: _ib, ...fb } = rb;
        this.walk(fa, fb, `record ${x}~${y}`, true);
      } else {
        const ua = uniA.get(x);
        const ub = uniB.get(y);
        if (ua === undefined || ub === undefined) continue;
        if (ua.arms.length !== ub.arms.length) {
          this.typeDiffs.push(`union ${x}~${y}: ${ua.arms.length} vs ${ub.arms.length} arms`);
          continue;
        }
        // Arms as a set: match by id-free signature (unique per union by
        // construction: the arms are pairwise-distinct types).
        const byS = new Map(ub.arms.map((t) => [sig(t), t]));
        for (const t of ua.arms) {
          const m = byS.get(sig(t));
          if (m === undefined) this.typeDiffs.push(`union ${x}~${y}: arm ${sig(t).slice(0, 80)} has no counterpart`);
          else this.walk(t, m, `union ${x}~${y} arm`, true);
        }
      }
    }
  }
}

describe.skipIf(!ON)("rea step 11 (B) verify: recursive groups change shape identities only", () => {
  const summary = { same: 0, renamed: 0, otherOnly: 0 };
  test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))("%s", async ([name, file]) => {
    const base = join(scratch, name.replace(/[/\\]/g, "_"));
    const off = await irOf(file, "off", join(base, "off"));
    const on = await irOf(file, "on", join(base, "on"));
    expect(on.ok, `builds with groups ${on.ok ? "on" : "off"} only`).toBe(off.ok);
    if (!off.ok) {
      expect(on.codes).toEqual(off.codes);
      return;
    }
    if (off.ir === null || on.ir === null) return;
    if (JSON.stringify(off.ir) === JSON.stringify(on.ir)) {
      summary.same++;
      return;
    }
    const b = new Bisim(off.ir, on.ir);
    b.run();
    expect(b.typeDiffs, b.typeDiffs.slice(0, 10).join("\n")).toEqual([]);
    if (b.otherDiffs.length > 0) {
      summary.otherOnly++;
      console.log(`RG-VERIFY other-diffs ${name}: ${b.otherDiffs.length}\n  ${b.otherDiffs.slice(0, 5).join("\n  ")}`);
    } else {
      summary.renamed++;
    }
  }, 600_000);
  afterAll(() => {
    console.log(`RG-VERIFY summary: identical ${summary.same}, ids renamed only ${summary.renamed}, non-type differences ${summary.otherOnly}`);
  });
});
