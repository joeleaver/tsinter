/* The surface manifest is a shipped artifact with two contract properties:
 * the version spine is the exact published release version, and every
 * non-static entry carries the diagnostic code the compiler actually
 * raises for it. This suite holds the manifest to both:
 *
 * - staleness guard: the committed packages/compiler/surface-manifest.json
 *   regenerates byte-identically from the current tree (a table edit that
 *   changes the projection fails here until `pnpm manifest` is rerun and
 *   the result committed);
 * - schema and determinism: unique sorted ids, valid kind/status values,
 *   a code on every non-static entry, identical output across generations;
 * - the sampling harness: N probe programs per status class, checked
 *   against the compiler itself — listed-static entries COMPILE, and for
 *   every sampled non-static entry the refusal's diagnostic code equals
 *   the entry's code (dynamic-only entries additionally analyze clean
 *   under --dynamic). The probes don't exercise every entry; they exist
 *   to catch the manifest lying.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyze,
  compile,
  generateSurfaceManifest,
  ir,
  LIB_FN_SIGS,
  renderAll,
  renderSurfaceManifest,
  resolveLibraryFences,
  type SurfaceManifest,
} from "@tsinter/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const manifestPath = join(repoRoot, "packages/compiler/surface-manifest.json");
const readJson = (p: string): { version: string } =>
  JSON.parse(readFileSync(join(repoRoot, p), "utf8")) as { version: string };

// The version spine: the release workflow keys on packages/cli (the
// published `scriptc` package); sync-versions.mjs stamps the same string
// into runtime and compiler.
const releaseVersion = readJson("packages/cli/package.json").version;

const committed = readFileSync(manifestPath, "utf8");
const manifest = generateSurfaceManifest(releaseVersion);
const entryById = new Map(manifest.entries.map((e) => [e.id, e]));

describe("surface manifest generation", () => {
  test("the committed manifest regenerates byte-identically (staleness guard)", () => {
    expect(
      renderSurfaceManifest(manifest),
      "packages/compiler/surface-manifest.json is stale — run 'pnpm manifest' and commit the result",
    ).toBe(committed);
  });

  test("generation is deterministic", () => {
    expect(renderSurfaceManifest(generateSurfaceManifest(releaseVersion))).toBe(
      renderSurfaceManifest(manifest),
    );
  });

  test("the version spine is the exact published version string", () => {
    const parsed = JSON.parse(committed) as SurfaceManifest;
    expect(parsed.compilerVersion).toBe(releaseVersion);
    // The three packages publish in lockstep; a drifted stamp would make
    // the spine ambiguous for a version pin.
    expect(readJson("packages/compiler/package.json").version).toBe(releaseVersion);
    expect(readJson("packages/runtime/package.json").version).toBe(releaseVersion);
  });

  test("schema: ids unique and sorted, enums valid, codes on every non-static entry", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entries.length).toBeGreaterThan(0);
    const ids = manifest.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const e of manifest.entries) {
      expect(e.id).toMatch(/^[a-z][a-z0-9-]*(\.[A-Za-z0-9$_-]+)+$/);
      expect(["syntax", "stdlib", "node-builtin", "diagnostic-fence"]).toContain(e.kind);
      expect(["static", "dynamic-only", "unsupported"]).toContain(e.status);
      if (e.status !== "static") {
        expect(e.code, `${e.id}: non-static entries must carry their diagnostic code`).toMatch(
          /^SC\d{4}$/,
        );
      }
    }
    // Every kind and every status class is populated — an empty class
    // means a projection source silently dropped out.
    for (const kind of ["syntax", "stdlib", "node-builtin", "diagnostic-fence"]) {
      expect(manifest.entries.some((e) => e.kind === kind), `no ${kind} entries`).toBe(true);
    }
    for (const status of ["static", "dynamic-only", "unsupported"]) {
      expect(manifest.entries.some((e) => e.status === status), `no ${status} entries`).toBe(true);
    }
  });
});

/* ── the sampling harness ────────────────────────────────────────────────
 * Each probe is one program exercising exactly one manifest entry. The
 * EXPECTATION is not written here — it is read from the manifest, so a
 * probe checks what the manifest CLAIMS: a status flip, a code change, or
 * an id rename in the manifest fails the probe until both agree again. */
interface Probe {
  id: string;
  source: string;
}

const PROBES: Probe[] = [
  // status static — these must compile to a binary
  { id: "syntax.compound-assignment.plus", source: 'let x = 1;\nx += 2;\nconsole.log(x);\n' },
  { id: "stdlib.string.charCodeAt", source: 'console.log("abc".charCodeAt(0));\n' },
  { id: "stdlib.array.push", source: "const xs: number[] = [1];\nxs.push(2);\nconsole.log(xs.length);\n" },
  { id: "stdlib.math.floor", source: "console.log(Math.floor(1.5));\n" },
  { id: "stdlib.map.has", source: 'const m = new Map<string, number>();\nm.set("a", 1);\nconsole.log(m.has("a"));\n' },
  { id: "stdlib.date.now", source: "console.log(Date.now() > 0);\n" },
  { id: "stdlib.number.toFixed", source: "const n = 1.2345;\nconsole.log(n.toFixed(2));\n" },
  { id: "node-builtin.process.pid", source: "console.log(process.pid > 0);\n" },
  { id: "node-builtin.perf_hooks.performance.now", source: "console.log(performance.now() >= 0);\n" },
  { id: "node-builtin.path.join", source: 'import { join } from "node:path";\nconsole.log(join("a", "b"));\n' },
  { id: "node-builtin.os.EOL", source: 'import { EOL } from "node:os";\nconsole.log(EOL.length);\n' },
  // status dynamic-only — refused with the entry's code statically,
  // analyzed clean under --dynamic
  { id: "stdlib.math.sqrt", source: "console.log(Math.sqrt(2));\n" },
  { id: "stdlib.math.PI", source: "console.log(Math.PI);\n" },
  { id: "stdlib.string.replace", source: 'console.log("aa".replace("a", "b"));\n' },
  { id: "diagnostic.sc2011", source: "const y: any = 1;\nconst z = y * 2;\nconsole.log(0);\n" },
  // status unsupported — refused with the entry's code
  { id: "syntax.debugger-statements", source: "debugger;\nconsole.log(0);\n" },
  {
    id: "syntax.delete-expressions",
    source:
      'type Hybrid = { base: string; [k: string]: string };\nconst h: Hybrid = { base: "b", extra: "e" };\ndelete h["extra"];\nconsole.log(h.base);\n',
  },
  // Class-instance field/getter destructures graduated (corpus 2429); the
  // METHOD-extraction refusal carries the sample now.
  { id: "diagnostic.sc1031", source: "class C {\n  f = 1;\n  m(): number {\n    return this.f;\n  }\n}\nconst { m } = new C();\nconsole.log(m());\n" },
  { id: "diagnostic.sc1121", source: 'console.log(/ab/g.test("abab"));\n' },
  {
    id: "node-builtin.zlib.gzipSync",
    source: 'import { gzipSync } from "node:zlib";\ngzipSync("data");\nconsole.log(0);\n',
  },
];

const probeRoot = mkdtempSync(join(tmpdir(), "scr-surface-manifest-"));

function probeFile(probe: Probe): string {
  const dir = join(probeRoot, probe.id.replace(/[^A-Za-z0-9]+/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.ts");
  writeFileSync(file, probe.source);
  return file;
}

describe("surface manifest sampling harness", () => {
  test("the probe set covers every status class", () => {
    const byStatus = new Map<string, number>();
    for (const p of PROBES) {
      const entry = entryById.get(p.id);
      expect(entry, `probe id ${p.id} is not in the manifest`).toBeDefined();
      byStatus.set(entry!.status, (byStatus.get(entry!.status) ?? 0) + 1);
    }
    expect(byStatus.get("static") ?? 0).toBeGreaterThanOrEqual(5);
    expect(byStatus.get("dynamic-only") ?? 0).toBeGreaterThanOrEqual(4);
    expect(byStatus.get("unsupported") ?? 0).toBeGreaterThanOrEqual(4);
  });

  test.for(PROBES.map((p) => [p.id, p] as const))("%s", async ([, probe]) => {
    const entry = entryById.get(probe.id);
    expect(entry, `probe id ${probe.id} is not in the manifest`).toBeDefined();
    const file = probeFile(probe);
    if (entry!.status === "static") {
      const outDir = join(file, "..", "out");
      const result = await compile(file, { outPath: join(outDir, "bin"), outDir });
      if (!result.ok) {
        expect.unreachable(
          `${probe.id} is listed static but did not compile:\n` +
            renderAll(result.diagnostics, result.sourceTexts, { color: false }),
        );
      }
      return;
    }
    // Non-static: the refusal's code must equal the entry's code — the
    // property external tooling depends on most.
    const { coverage } = analyze(file);
    expect(coverage.preflightFailed, `${probe.id}: probe must reach lowering`).toBe(false);
    const codes = [...new Set(coverage.diagnostics.map((d) => d.code))];
    expect(codes, `${probe.id}: expected exactly the listed refusal code`).toEqual([entry!.code]);
    if (entry!.status === "dynamic-only") {
      const dyn = analyze(file, { dynamic: true }).coverage;
      expect(
        dyn.diagnostics.map((d) => `${d.code}: ${d.message}`),
        `${probe.id}: dynamic-only entries must analyze clean under --dynamic`,
      ).toEqual([]);
      expect(dyn.stats.statementsFailed).toBe(0);
    }
  });
});

/* ── attestation ↔ fence parity: the ask-5 §4 invariant's ground ─────────
 * The library sidecar's `deterministic` attestation demotes on libCall
 * spellings by prefix (ir/nodes.ts's LIB_NONDETERMINISTIC_PREFIXES); the
 * profile's determinism fences deny surfaces by manifest id. The §4
 * invariant — a program that compiles under full fences attests
 * deterministic: true — holds only if every spelling the attestation
 * demotes on is deniable through some manifest entry's fence detector.
 * This test holds the two scans to that, mechanically, over the exhaustive
 * IrLibFn registry: a new ambient spelling added to a lowering fails here
 * until a manifest entry (or an alias on an existing one) covers it. */
describe("determinism attestation ↔ fence parity", () => {
  test("every attestation-demoting libFn spelling is deniable by a manifest-id fence", () => {
    // The full-fence declaration set: every ambient family the attestation
    // knows, spelled the way a profile would spell it.
    const resolved = resolveLibraryFences([
      { path: "parity[0]", id: "stdlib.math.random" },
      { path: "parity[1]", prefix: "node-builtin.fs." },
      { path: "parity[2]", prefix: "node-builtin.os." },
      { path: "parity[3]", prefix: "node-builtin.crypto." },
      { path: "parity[4]", prefix: "stdlib.date." },
      { path: "parity[5]", prefix: "node-builtin.process." },
      { path: "parity[6]", prefix: "node-builtin.perf_hooks." },
      // The host CA store (tlsca.*): the trust anchors are machine
      // identity, so the attestation demotes on them like os.* — the
      // family needs its own declaration here, not just manifest entries.
      { path: "parity[7]", prefix: "node-builtin.tls." },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const covered = new Set<string>();
    for (const fence of resolved.fences) {
      for (const s of fence.surfaces) {
        for (const fn of s.detector?.libFns ?? []) covered.add(fn);
      }
    }
    // Spellings the attestation demotes on that no fence detector needs to
    // witness, pinned WITH REASONS — additions here require the same
    // scrutiny as a manifest entry:
    const excused = new Set([
      // Refused SC4005 in library mode before any fence runs (the async
      // fs callback surface — LIB_MODE_REFUSED_PREFIXES).
      "fs.existsChk",
      // The JS-source validation-ladder spellings whose honest tail is a
      // compile-rendered runtime fence: the ladder replicates Node's typed
      // argument errors and then FENCES — the ambient operation never
      // runs, so the attestation's demote is pure conservatism.
      "fs.mkdtempChk",
      "fs.readFileChk",
      "fs.opendirChk",
      "fs.watchFileChk",
      "fs.lchmodChk",
      "fs.readChk",
      "fs.streamOptsChk",
      // fs._toUnixTimestamp — Node's underscore-stable seconds coercion
      // (the utimes ladder's time argument): it reads the clock only for
      // negative inputs, and the member is undeclared in @types/node, so
      // only the JS lane reaches it. A residual, documented gap: no
      // manifest member exists to hang a detector on yet.
      "fs.toUnixTimestamp",
    ]);
    const missing = Object.keys(LIB_FN_SIGS).filter(
      (fn) =>
        ir.LIB_NONDETERMINISTIC_PREFIXES.some(([prefix]) => fn.startsWith(prefix)) &&
        !covered.has(fn) &&
        !excused.has(fn),
    );
    expect(
      missing,
      "attestation-demoting spellings no declarable fence can deny — add a manifest projection (AMBIENT_SURFACE_FNS) or a member alias (BUILTIN_MODULE_FN_ALIASES)",
    ).toEqual([]);
    // The excuse list stays honest in the other direction too: an excused
    // spelling that gains detector coverage must leave the list.
    expect([...excused].filter((fn) => covered.has(fn))).toEqual([]);
  });
});
