/* Ask 4 end to end — profile-declared i64/u64 integer boundary slots with
 * compile-time prove-or-refuse inference, over the REAL pipeline
 * (frontend lowering, both emissions, real archives, real probes):
 *
 *   corpus       the reference package's §3 conformance corpus, all 16
 *                cases as library fixtures: `send(x)`/`sendU64(x)` are
 *                profile-mapped exports whose parameter the profile
 *                declares i64/u64, so every internal call site is a
 *                declared-slot crossing. PROVE cases compile on both
 *                emissions and every crossed value equals the Node
 *                oracle's number exactly (this test process IS Node — the
 *                oracle runs the same case source); REFUSE cases name the
 *                listed obligation with the slot path and evidence, on
 *                both emissions (the verdict is emission-invariant).
 *   returns      the outbound declared-integer edge: i64/u64 RETURNS
 *                cross as real int64_t/uint64_t through the C ABI, pinned
 *                against the oracle's singletons (9007199254740991, 0 for
 *                -0, -1 for -7 % 3, 4294967295).
 *   inbound trap the host-contract edge: an inbound i64/u64 past
 *                ±(2^53 − 1) cannot ride f64 exactly, so the wrapper
 *                delivers the structured SC4012 trap (profile teaching +
 *                remediation riding it) instead of silently rounding;
 *                in-range extremes convert exactly.
 *   sidecar      sidecar-declared slots (msg arms, record fields, helper
 *                params/returns): integer_slots emitted as the resolved
 *                attestation in declaration order, the declared slots
 *                spelled i64 in the document (V10 bijection), program-side
 *                writes proven or refused by slot path, and unresolvable
 *                or non-number declarations refused at projection.
 *   layer 1      the unobservability differential: scriptc implements NO
 *                Layer-1 integer representation, so the reference
 *                package's on/off differential is trivially satisfied;
 *                what CAN be pinned is the observable consequence — the
 *                same program compiled with the slot declared f64 vs i64
 *                crosses byte-identical values (declaring a slot adds
 *                proofs and wrapper conversions, never new semantics).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary, renderAll, validateSidecar } from "@tsinter/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/library-mode");
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-int", flavor);

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

/* ── the corpus (reference package §3, sources verbatim) ─────────────────
 * `body` is the case's program text: top-level statements, or the body of
 * `export function f(a: number): void` when `param` is set. The oracle
 * executes the same text in this Node process. */
interface CorpusCase {
  name: string;
  body: string;
  param?: boolean;
  /** Host-side arguments fed to f through the wrapper (PROVE cases). */
  args?: string[];
  expected: "prove" | "refuse";
  obligation?: "representability" | "wholeness" | "range";
  code?: string;
  slot?: string;
  evidence?: string[];
}

const CORPUS: CorpusCase[] = [
  {
    name: "max-safe-integer-exact",
    body: `send(2 ** 53 - 1);`,
    expected: "prove",
  },
  {
    name: "literal-not-representable",
    body: `send(9007199254740993);`,
    expected: "refuse",
    obligation: "representability",
    code: "SC4021",
    slot: "exports.send.params[0]",
    // The refusal fires on the SPELLING, and the evidence names both the
    // author's text and its f64 read-back.
    evidence: ["9007199254740993", "reads back as 9007199254740992"],
  },
  {
    name: "proven-range-overflow",
    body: `if (a >= 0 && a <= 2 ** 30) {\n  const t = Math.trunc(a);\n  send(t * t);\n}`,
    param: true,
    expected: "refuse",
    obligation: "range",
    code: "SC4023",
    slot: "exports.send.params[0]",
    evidence: ["±(2^53 − 1)"],
  },
  {
    name: "negative-zero-crosses-as-zero",
    body: `send(-0);`,
    expected: "prove",
  },
  {
    name: "times-half-unprovable",
    body: `if (a >= 0 && a <= 1000) {\n  const t = a * 0.5;\n  send(t);\n}`,
    param: true,
    expected: "refuse",
    obligation: "wholeness",
    code: "SC4022",
    slot: "exports.send.params[0]",
    // The guard already proved the range and excluded NaN: the ONLY
    // failed obligation is wholeness, and the evidence says so.
    evidence: ["[0, 500]", "non-integers"],
  },
  {
    name: "times-half-with-trunc",
    body: `if (a >= 0 && a <= 1000) {\n  const t = a * 0.5;\n  send(Math.trunc(t));\n}`,
    param: true,
    args: ["0", "999", "1000", "500.5", "-3"],
    expected: "prove",
  },
  {
    name: "bounded-counter-loop",
    body: `for (let n = 0; n < 10; n = n + 1) {\n  send(n);\n}`,
    expected: "prove", // the precision gate: 0..9 in order, pinned below
  },
  {
    name: "division-non-integer",
    body: `send(7 / 2);`,
    expected: "refuse",
    obligation: "wholeness",
    code: "SC4022",
    slot: "exports.send.params[0]",
  },
  {
    name: "remainder-negative-dividend",
    body: `send(-7 % 3);`,
    expected: "prove",
  },
  {
    name: "bitwise-or-int32",
    body: `send(a | 0);`,
    param: true,
    args: ["3.7", "-2.5", "nan", "1e300", "4294967297"],
    expected: "prove",
  },
  {
    name: "unsigned-shift-u64",
    body: `sendU64(a >>> 0);`,
    param: true,
    args: ["5.9", "-1", "nan", "4294967295"],
    expected: "prove",
  },
  {
    name: "u64-negative-proven-range",
    body: `if (a >= -100 && a <= 100) {\n  sendU64(Math.trunc(a));\n}`,
    param: true,
    expected: "refuse",
    obligation: "range",
    code: "SC4023",
    slot: "exports.sendU64.params[0]",
    evidence: ["[-100, 100]", "non-negative"],
  },
  {
    name: "conditional-range-refinement",
    body: `if (a >= 2 && a <= 6) {\n  send(Math.round(a));\n}`,
    param: true,
    args: ["2", "5.4", "6", "1", "nan"],
    expected: "prove",
  },
  {
    name: "data-dependent-loop-bound",
    body: `for (let n = 0; n < a; n = n + 1) {\n  send(n);\n}`,
    param: true,
    expected: "refuse",
    obligation: "range",
    code: "SC4023",
    slot: "exports.send.params[0]",
  },
  {
    name: "nan-reaches-slot",
    body: `send(0 / 0);`,
    expected: "refuse",
    obligation: "wholeness",
    code: "SC4022",
    slot: "exports.send.params[0]",
    evidence: ["NaN"],
  },
  {
    name: "infinity-reaches-slot",
    body: `send(1 / 0);`,
    expected: "refuse",
    obligation: "range",
    code: "SC4023",
    slot: "exports.send.params[0]",
    evidence: ["Infinity"],
  },
];

const PRELUDE = `let crossed: number[] = [];
export function send(x: number): void { crossed.push(x); }
export function sendU64(x: number): void { crossed.push(x); }
export function count(): number { return crossed.length; }
export function at(i: number): number { return crossed[i]; }
`;

function corpusSource(c: CorpusCase): string {
  return c.param === true ? `${PRELUDE}export function f(a: number): void {\n${c.body}\n}\n` : `${PRELUDE}${c.body}\n`;
}

function corpusProfile(c: CorpusCase, emission: Emission, entry: string, sendClass = "i64"): object {
  return {
    profile_format: 1,
    name: "int-corpus",
    entry,
    emission,
    abi: {
      prefix: "kc_",
      init_symbol: "kc_init",
      sink_register_symbol: "kc_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [
      { export: "send", symbol: "kc_send", params: [sendClass], returns: "void" },
      { export: "sendU64", symbol: "kc_send_u64", params: ["u64"], returns: "void" },
      { export: "count", symbol: "kc_count", params: [], returns: "f64" },
      { export: "at", symbol: "kc_at", params: ["f64"], returns: "f64" },
      ...(c.param === true ? [{ export: "f", symbol: "kc_f", params: ["f64"], returns: "void" }] : []),
    ],
  };
}

/** The Node oracle: this test process runs the SAME case source and
 * records what crossed. Number(arg) mirrors the probe's strtod. */
function nodeOracle(c: CorpusCase): number[] {
  const crossed: number[] = [];
  const send = (x: number): void => {
    crossed.push(x);
  };
  const fn = new Function("send", "sendU64", "a", c.body) as (s: unknown, u: unknown, a?: number) => void;
  if (c.param === true) {
    for (const a of c.args ?? []) fn(send, send, Number(a));
  } else {
    fn(send, send);
  }
  return crossed;
}

async function buildCase(tag: string, source: string, profile: object): Promise<
  | { ok: true; archive: string; outDir: string; sidecarPath?: string }
  | { ok: false; diagnostics: { code: string; message: string; hint?: string; note?: string }[] }
> {
  const outDir = join(cacheDir, tag);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "lib.ts");
  writeFileSync(entry, source);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify({ ...profile, entry }, null, 2));
  const result = await compileLibrary({ profilePath, outDir });
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((d) => ({
        code: d.code,
        message: d.message,
        ...(d.hint !== undefined ? { hint: d.hint } : {}),
        ...(d.note !== undefined ? { note: d.note } : {}),
      })),
    };
  }
  return {
    ok: true,
    archive: result.archivePath,
    outDir,
    ...(result.sidecarPath !== undefined ? { sidecarPath: result.sidecarPath } : {}),
  };
}

function buildProbe(probeSrc: string, archive: string, outDir: string, defines: string[] = []): string {
  const bin = join(outDir, "probe");
  execFileSync("clang", ["-std=c11", ...defines.map((d) => `-D${d}`), probeSrc, archive, "-lm", "-o", bin]);
  return bin;
}

function runProbe(bin: string, args: string[] = []): { stdout: string; status: number | null; signal: string | null } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
  return { stdout: r.stdout ?? "", status: r.status, signal: r.signal };
}

/* ── the corpus, both emissions ──────────────────────────────────────── */

describe.each(EMISSIONS)("ask-4 corpus, %s emission", (emission) => {
  for (const c of CORPUS) {
    test(`${c.name} — ${c.expected.toUpperCase()}${c.obligation !== undefined ? ` (${c.obligation})` : ""}`, async () => {
      const r = await buildCase(`corpus-${c.name}-${emission}`, corpusSource(c), corpusProfile(c, emission, "lib.ts"));
      if (c.expected === "refuse") {
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.diagnostics.map((d) => d.code)).toEqual([c.code]);
        const d = r.diagnostics[0]!;
        // The teaching triple: the slot path, the failed obligation, the
        // evidence, and (as the hint) the author's fix.
        expect(d.message).toContain(`'${c.slot}'`);
        expect(d.message).toContain(`${c.obligation} failed`);
        for (const ev of c.evidence ?? []) expect(d.message).toContain(ev);
        expect(d.hint).toBeTruthy();
        return;
      }
      expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
      if (!r.ok) return;
      // The crossing values, pinned against the Node oracle exactly —
      // this process IS Node, running the same case source.
      const probe = buildProbe(join(fixtureRoot, "int-corpus/probe.c"), r.archive, r.outDir, c.param === true ? ["HAS_F"] : []);
      const run = runProbe(probe, c.param === true ? (c.args ?? []) : []);
      expect(run.signal).toBeNull();
      expect(run.status).toBe(0);
      const got = run.stdout.split("\n").filter((l) => l !== "").map(Number);
      const want = nodeOracle(c);
      expect(got.length).toBe(want.length);
      got.forEach((v, i) => {
        expect(Object.is(v, want[i]), `crossing ${i}: got ${v}, Node says ${want[i]}`).toBe(true);
      });
      if (c.name === "bounded-counter-loop") {
        // The precision gate's runtime half: 0 through 9, in order.
        expect(got).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      }
    });
  }

  /* ── outbound integer returns: real int64_t/uint64_t crossings ─────── */

  test("declared integer returns cross as exact int64_t/uint64_t", async () => {
    const dir = join(fixtureRoot, "int-returns");
    const outDir = join(cacheDir, `int-returns-${emission}`);
    mkdirSync(outDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as { entry: string; emission: string };
    profile.emission = emission;
    profile.entry = join(dir, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));
    const result = await compileLibrary({ profilePath, outDir });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const probe = buildProbe(join(dir, "probe.c"), result.archivePath, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    // The Node oracle's numbers, converted exactly: 2**53-1, -0 as the
    // mathematically exact integer 0, JS remainder's -1, ToUint32's max.
    expect(run.stdout).toBe(`max=9007199254740991\nnegzero=0\nrem=-1\nu32max=4294967295\n`);
  });

  /* ── the inbound host-contract trap ─────────────────────────────────── */

  test("an inbound integer past 2^53−1 traps SC4012; in-range extremes convert exactly", async () => {
    const dir = join(fixtureRoot, "int-trap");
    const outDir = join(cacheDir, `int-trap-${emission}`);
    mkdirSync(outDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as { entry: string; emission: string };
    profile.emission = emission;
    profile.entry = join(dir, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));
    const result = await compileLibrary({ profilePath, outDir });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const probe = buildProbe(join(dir, "probe.c"), result.archivePath, outDir);

    const ok = runProbe(probe, ["ok"]);
    expect(ok.signal).toBeNull();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(
      `i64 max: 9007199254740991\ni64 min: -9007199254740991\nu64 max: 9007199254740991\nok, sink_calls=0\n`,
    );

    for (const mode of ["trap-i64", "trap-u64"] as const) {
      const run = runProbe(probe, [mode]);
      expect(run.signal).toBeNull();
      expect(run.status).toBe(0);
      // The structured SC4012 message: the profile's teaching as the
      // text, the code, the trapping export's symbol, the remediation —
      // and the host survives (nothing was silently rounded).
      expect(run.stdout).toBe(
        `sink[1]:
text=[this core's integer channel carries at most 2^53 - 1]
code=[SC4012]
symbol=[${mode === "trap-i64" ? "kt_take" : "kt_take_u"}]
remediation=[keep host-side ids within the exact-integer range]
fields=4
survived, sink_calls=1
`,
      );
    }
  });

  /* ── Layer-1 unobservability ────────────────────────────────────────── */

  test("declaring the slot integer changes no program output (Layer 1 differential)", async () => {
    // scriptc implements NO Layer-1 integer representation (semantics
    // stay f64, byte-exact to Node), so the reference's on/off flip is
    // trivially satisfied; the observable consequence pinned here: the
    // SAME program under an f64-declared and an i64-declared send slot
    // crosses byte-identical values — the declaration adds proofs and
    // wrapper conversions, never semantics.
    const loop = CORPUS.find((c) => c.name === "bounded-counter-loop")!;
    const outputs: string[] = [];
    for (const cls of ["f64", "i64"]) {
      const r = await buildCase(
        `layer1-${cls}-${emission}`,
        corpusSource(loop),
        corpusProfile(loop, emission, "lib.ts", cls),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const probe = buildProbe(join(fixtureRoot, "int-corpus/probe.c"), r.archive, r.outDir);
      const run = runProbe(probe);
      expect(run.status).toBe(0);
      outputs.push(run.stdout);
    }
    expect(outputs[1]).toBe(outputs[0]);
  });
});

/* ── the rendered refusals, snapshotted per code ─────────────────────────
 * One program refusing all three obligations at once: the full rendered
 * output (codes, spans, evidence, fixes) is the quality artifact — the
 * diagnostics-corpus discipline applied to the library-only codes the
 * executable-lane corpus cannot reach. */

test("SC4021/SC4022/SC4023 render with the teaching triple (snapshot)", async () => {
  const source = `${PRELUDE}send(9007199254740993);
export function half(a: number): void {
  if (a >= 0 && a <= 1000) {
    send(a * 0.5);
  }
}
export function grow(a: number): void {
  if (a >= 0 && a <= 2 ** 30) {
    const t = Math.trunc(a);
    send(t * t);
  }
}
`;
  const c: CorpusCase = { name: "render", body: "", param: false, expected: "refuse" };
  const profile = corpusProfile(c, "c", "lib.ts") as { exports: object[] };
  profile.exports.push(
    { export: "half", symbol: "kc_half", params: ["f64"], returns: "void" },
    { export: "grow", symbol: "kc_grow", params: ["f64"], returns: "void" },
  );
  const outDir = join(cacheDir, "render-refusals");
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "lib.ts");
  writeFileSync(entry, source);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify({ ...profile, entry }, null, 2));
  const result = await compileLibrary({ profilePath, outDir });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code).sort()).toEqual(["SC4021", "SC4022", "SC4023"]);
  const rendered = renderAll(result.diagnostics, result.sourceTexts, { color: false }).replaceAll(outDir + "/", "");
  await expect(rendered).toMatchFileSnapshot("__snapshots__/library-int-refusals.txt");
});

/* ── sidecar-declared slots (msg arms, record fields, helpers) ───────────
 * The projection resolves the profile's sidecar.integer_slots, spells the
 * declared slots i64, emits the attestation list, and the inference
 * proves every program-side write. Refusals are pre-emission and pinned
 * emission-invariant by the corpus above, so one lane suffices here. */

const SIDECAR_ENTRY = `export interface Model { total: number; label: string; }
export type Msg = { kind: "count"; n: number } | { kind: "clear" };
export function init(): Model { return { total: 0, label: "" }; }
export function update(m: Model, msg: Msg): Model { return m; }
let last: Msg = { kind: "clear" };
export function poke(v: number): void {
  if (v >= 0 && v <= 100) { last = { kind: "count", n: Math.trunc(v) }; }
}
export function lastN(): number { return last.kind === "count" ? last.n : -1; }
export function clampIdx(m: Model, i: number): number { return i | 0; }
`;

function sidecarProfile(integerSlots: object[], patch: Record<string, unknown> = {}): object {
  return {
    profile_format: 1,
    name: "int-sidecar",
    entry: "lib.ts",
    emission: "c",
    abi: {
      prefix: "ks_",
      init_symbol: "ks_init",
      sink_register_symbol: "ks_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [
      { export: "poke", symbol: "ks_poke", params: ["f64"], returns: "void" },
      { export: "lastN", symbol: "ks_last_n", params: [], returns: "f64" },
    ],
    sidecar: {
      wire_version: 3,
      abi_version: 1,
      snapshot_format: 1,
      build_id_symbol: "ks_build_id",
      abi_version_symbol: "ks_abi_version",
      model: "Model",
      msg: "Msg",
      integer_slots: integerSlots,
    },
    ...patch,
  };
}

describe("ask-4 sidecar-declared slots", () => {
  const DECLARED = [
    { slot: "Msg.count", class: "i64" },
    { slot: "Model.total", class: "i64" },
    { slot: "helpers.clampIdx.return", class: "i64" },
  ];

  test("integer_slots attest the declared classes; declared slots spell i64", async () => {
    const r = await buildCase("sidecar-ok", SIDECAR_ENTRY, sidecarProfile(DECLARED));
    expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    if (!r.ok) return;
    const doc = JSON.parse(readFileSync(r.sidecarPath!, "utf8")) as {
      integer_slots: { slot: string; class: string }[];
      msg: { arms: { name: string; payload: { kind: string; class?: string } }[] };
      types: { structs: { name: string; fields: { name: string; type: { kind: string } }[] }[] };
      model_helpers: { name: string; returns: { kind: string } }[];
    };
    // The resolved-decision list, profile declaration order, each entry
    // recording its DECLARED class (all i64 here; the TypeRef spellings
    // below are the frozen format-1 vocabulary).
    expect(doc.integer_slots).toEqual([
      { slot: "Msg.count", class: "i64" },
      { slot: "Model.total", class: "i64" },
      { slot: "helpers.clampIdx.return", class: "i64" },
    ]);
    expect(doc.msg.arms.find((a) => a.name === "count")!.payload).toEqual({ kind: "number", class: "i64" });
    const model = doc.types.structs.find((s) => s.name === "Model")!;
    expect(model.fields.find((f) => f.name === "total")!.type).toEqual({ kind: "i64" });
    expect(model.fields.find((f) => f.name === "label")!.type).toEqual({ kind: "bytes" });
    expect(doc.model_helpers.find((h) => h.name === "clampIdx")!.returns).toEqual({ kind: "i64" });
    // The document conforms end to end (V10's bijection included).
    expect(validateSidecar(doc)).toEqual([]);
  });

  test("a u64 declaration attests u64; the TypeRef still spells i64", async () => {
    // The attestation-level class: integer_slots records the DECLARED
    // class in its own {i64, u64} vocabulary, while the frozen format-1
    // TypeRef keeps spelling i64 (unsigned-ness is a boundary-slot
    // refinement, not a type-table concept). The regression pinned here:
    // u64 declarations used to flatten to i64 in the attestation itself,
    // misstating the discharged proof's domain.
    const r = await buildCase("sidecar-u64-attest", SIDECAR_ENTRY, sidecarProfile([{ slot: "Model.total", class: "u64" }]));
    expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    if (!r.ok) return;
    const doc = JSON.parse(readFileSync(r.sidecarPath!, "utf8")) as {
      integer_slots: { slot: string; class: string }[];
      types: { structs: { name: string; fields: { name: string; type: { kind: string } }[] }[] };
    };
    expect(doc.integer_slots).toEqual([{ slot: "Model.total", class: "u64" }]);
    expect(doc.types.structs.find((s) => s.name === "Model")!.fields.find((f) => f.name === "total")!.type).toEqual({ kind: "i64" });
    expect(validateSidecar(doc)).toEqual([]);
  });

  test("an unproven update write into a declared model field refuses by slot path", async () => {
    // The model-slot prove-or-refuse gate: a declared Model field class
    // obligates every write the contract surface performs — init and
    // update are force-lowered so their record constructions enter the
    // boundary check (the regression pinned here: dead-stripped
    // init/update bodies let an unprovable write attest).
    const broken = SIDECAR_ENTRY.replace(
      "export function update(m: Model, msg: Msg): Model { return m; }",
      "export function update(m: Model, msg: Msg): Model { return { total: m.total * 0.5, label: m.label }; }",
    );
    const r = await buildCase("sidecar-refuse-model-update", broken, sidecarProfile([{ slot: "Model.total", class: "i64" }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4022"]);
    expect(r.diagnostics[0]!.message).toContain("'Model.total'");
    expect(r.diagnostics[0]!.message).toContain("wholeness failed");
    expect(r.diagnostics[0]!.hint).toBeTruthy();
  });

  test("an unbounded counter increment into a declared model field refuses range", async () => {
    // The read side of the declared-slot contract: m.total reads back
    // whole-in-class-range (every write was checked), so the unguarded
    // increment fails RANGE — the counter may leave ±(2^53 − 1) — never a
    // spurious NaN complaint. A clamped increment proves (next test).
    const broken = SIDECAR_ENTRY.replace(
      "export function update(m: Model, msg: Msg): Model { return m; }",
      "export function update(m: Model, msg: Msg): Model { return { total: m.total + 1, label: m.label }; }",
    );
    const r = await buildCase("sidecar-refuse-model-counter", broken, sidecarProfile([{ slot: "Model.total", class: "i64" }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4023"]);
    expect(r.diagnostics[0]!.message).toContain("'Model.total'");
    expect(r.diagnostics[0]!.message).toContain("range failed");
  });

  test("a direct field guard proves and remains byte-exact to Node in both emissions", async () => {
    const guarded = `${SIDECAR_ENTRY}
export function guardedStep(v: number): number {
  const m: Model = { total: v, label: "" };
  if (m.total < 1000) { m.total = m.total + 1; }
  return m.total;
}
`;
    const inputs = [Number.MIN_SAFE_INTEGER, -1, 999, 1000, Number.MAX_SAFE_INTEGER];
    const nodeOutput = inputs
      .map((v) => String(v < 1000 ? v + 1 : v))
      .join("\n") + "\n";

    for (const emission of EMISSIONS) {
      const r = await buildCase(
        `sidecar-prove-model-field-guard-${emission}`,
        guarded,
        sidecarProfile(
          [{ slot: "Model.total", class: "i64" }],
          {
            emission,
            exports: [
              { export: "guardedStep", symbol: "ks_guarded_step", params: ["i64"], returns: "f64" },
            ],
          },
        ),
      );
      expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
      if (!r.ok) continue;

      const probeSrc = join(r.outDir, "guarded-field-probe.c");
      writeFileSync(probeSrc, `#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

extern void ks_init(void);
extern double ks_guarded_step(int64_t v);

int main(void) {
  const int64_t inputs[] = {
    -INT64_C(9007199254740991), -INT64_C(1), INT64_C(999),
    INT64_C(1000), INT64_C(9007199254740991)
  };
  ks_init();
  for (unsigned i = 0; i < sizeof(inputs) / sizeof(inputs[0]); i++) {
    printf("%.17g\\n", ks_guarded_step(inputs[i]));
  }
  return 0;
}
`);
      const run = runProbe(buildProbe(probeSrc, r.archive, r.outDir));
      expect(run.signal).toBeNull();
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(nodeOutput);
    }
  });

  test("a ternary guard and literal bracket spelling share the static field path", async () => {
    const guarded = SIDECAR_ENTRY.replace(
      "export function update(m: Model, msg: Msg): Model { return m; }",
      `export function update(m: Model, msg: Msg): Model {
  m.total = m["total"] < 1000 ? m.total + 1 : 0;
  return m;
}`,
    );
    const r = await buildCase(
      "sidecar-prove-model-field-ternary",
      guarded,
      sidecarProfile([{ slot: "Model.total", class: "i64" }]),
    );
    expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
  });

  test("a call after a field guard kills the refinement with the same range refusal", async () => {
    const guarded = SIDECAR_ENTRY.replace(
      "export function update(m: Model, msg: Msg): Model { return m; }",
      `function touch(): void {}
export function update(m: Model, msg: Msg): Model {
  if (m.total < 1000) {
    touch();
    m.total = m.total + 1;
  }
  return m;
}`,
    );
    const r = await buildCase(
      "sidecar-refuse-model-field-call-kill",
      guarded,
      sidecarProfile([{ slot: "Model.total", class: "i64" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4023"]);
    expect(r.diagnostics[0]!.message).toContain("'Model.total'");
    expect(r.diagnostics[0]!.message).toContain("range failed");
  });

  test("a possible aliasing write after a field guard kills the refinement", async () => {
    const guarded = SIDECAR_ENTRY.replace(
      "export function update(m: Model, msg: Msg): Model { return m; }",
      `export function update(m: Model, msg: Msg): Model {
  const alias = m;
  if (m.total < 1000) {
    alias.label = "changed";
    m.total = m.total + 1;
  }
  return m;
}`,
    );
    const r = await buildCase(
      "sidecar-refuse-model-field-write-kill",
      guarded,
      sidecarProfile([{ slot: "Model.total", class: "i64" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4023"]);
    expect(r.diagnostics[0]!.message).toContain("'Model.total'");
    expect(r.diagnostics[0]!.message).toContain("range failed");
  });

  test("guarded model-field writes prove and the build attests them", async () => {
    const guarded = SIDECAR_ENTRY.replace(
      "export function update(m: Model, msg: Msg): Model { return m; }",
      "export function update(m: Model, msg: Msg): Model { return { total: (m.total + 1) % 1000000, label: m.label }; }",
    );
    const r = await buildCase("sidecar-prove-model", guarded, sidecarProfile([{ slot: "Model.total", class: "u64" }]));
    expect(r.ok, r.ok ? "" : r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    if (!r.ok) return;
    const doc = JSON.parse(readFileSync(r.sidecarPath!, "utf8")) as { integer_slots: { slot: string; class: string }[] };
    expect(doc.integer_slots).toEqual([{ slot: "Model.total", class: "u64" }]);
  });

  test("an unproven write into a declared msg arm refuses by slot path", async () => {
    const broken = SIDECAR_ENTRY.replace("n: Math.trunc(v)", "n: v * 0.5");
    const r = await buildCase("sidecar-refuse-arm", broken, sidecarProfile(DECLARED));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4022"]);
    expect(r.diagnostics[0]!.message).toContain("'Msg.count'");
    expect(r.diagnostics[0]!.message).toContain("wholeness failed");
  });

  test("an unproven declared helper return refuses by slot path", async () => {
    const broken = SIDECAR_ENTRY.replace("return i | 0;", "return i * 0.5;");
    const r = await buildCase("sidecar-refuse-helper", broken, sidecarProfile(DECLARED));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4022"]);
    expect(r.diagnostics[0]!.message).toContain("'helpers.clampIdx.return'");
  });

  test("a declared path resolving to no slot refuses at projection", async () => {
    const r = await buildCase("sidecar-refuse-nopath", SIDECAR_ENTRY, sidecarProfile([{ slot: "Msg.nope", class: "i64" }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4009"]);
    expect(r.diagnostics[0]!.message).toContain("'Msg.nope'");
    expect(r.diagnostics[0]!.message).toContain("no number slot");
  });

  test("a declared path naming a non-number slot refuses at projection", async () => {
    const r = await buildCase("sidecar-refuse-nonnum", SIDECAR_ENTRY, sidecarProfile([{ slot: "Model.label", class: "u64" }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.map((d) => d.code)).toEqual(["SC4009"]);
    expect(r.diagnostics[0]!.message).toContain("not a plain number slot");
  });

  test("a profile teaching rides an integer refusal as the attributed note", async () => {
    const broken = SIDECAR_ENTRY.replace("n: Math.trunc(v)", "n: v * 0.5");
    const r = await buildCase(
      "sidecar-refuse-teach",
      broken,
      sidecarProfile(DECLARED, {
        determinism: { teachings: { SC4022: "counters in this core are integral by contract; truncate before posting" } },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("SC4022");
    expect(r.diagnostics[0]!.note).toBe(
      "from the 'int-sidecar' profile: counters in this core are integral by contract; truncate before posting",
    );
  });
});
