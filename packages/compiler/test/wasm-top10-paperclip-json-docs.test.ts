/* paperclip's JSON documents (packages/shared: app-definitions.generated.ts
 * imports ~110 app-definition documents and casts them `as AppDefinition[]`;
 * self-serve-mcp-research.ts casts its manifest `as
 * SelfServeMcpResearchManifest`). A document holding an array of
 * differently-keyed objects types as a union of records, which has no
 * static representation: on the WasmGC lanes its default import binds the
 * dynamic value JSON.parse makes of its text — every key in the document's
 * order, one object shared by every importer — and its uses follow the
 * dynamic value's rules. Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("wasm-top10-paperclip-json-docs");
const doc = (o: unknown): string => JSON.stringify(o, null, 2);

const AGENTMAIL = {
  schemaVersion: 1, slug: "agentmail", name: "AgentMail", categories: ["communication"], featured: false,
  branding: { logoUrl: "/a.svg" },
  methods: [{ key: "email", auth: "api_key", ownershipModes: ["customer"], riskTier: "S3",
    credentialFields: [{ key: "apiKey", label: "Key", type: "password", required: true, secret: true }] }],
};
const GITHUB = {
  schemaVersion: 1, slug: "github", name: "GitHub", categories: ["developer", "ai"], featured: true,
  branding: { logoUrl: "/g.svg", darkLogoUrl: "/gd.svg" },
  methods: [
    { key: "managed", transport: "mcp_remote", auth: "oauth", ownershipModes: ["platform_shared"],
      defaults: { serverUrl: "https://x/", toolArgumentDefaults: { meta: { "ucp-agent": { profile: "p" } } } },
      riskTier: "S3", label: "Connect GitHub", grantKinds: ["user", "agent"] },
    { key: "mcp-key", transport: "mcp_remote", auth: "api_key", ownershipModes: ["customer"], riskTier: "S2",
      keyPlacement: { location: "header", name: "Authorization", prefix: null },
      tenantFields: [{ key: "t", label: "T", type: "checkbox", defaultValue: false }, { key: "u", label: "U", type: "text", defaultValue: "x" }] },
  ],
};
const HIDDEN = {
  schemaVersion: 1, slug: "coda", name: "Coda", categories: ["productivity"], branding: { logoUrl: "/c.svg" },
  urlPatterns: ["https://coda.io/*"],
  methods: [{ key: "dcr", auth: "oauth", ownershipModes: ["dcr"], riskTier: "S1" }, { key: "k", auth: "api_key", ownershipModes: ["customer"], riskTier: "S1", warnings: ["w"] }],
};
const MANIFEST = {
  schemaVersion: 1, verifiedAt: "2026-05-01",
  entries: [
    { slug: "neon", name: "Neon", wave: 1, status: "self_serve", docsUrl: "d", serverUrl: "s", authMode: "dcr", prerequisite: "p", riskTier: "S2", blocker: null, liveRead: "yes" },
    { slug: "acme", name: "Acme", wave: "blocked", status: "blocked", docsUrl: "d", serverUrl: "s", authMode: "public", prerequisite: "p", riskTier: "S4", blocker: "no api", evidenceLimit: "docs only" },
    { slug: "kernel", name: "Kernel", wave: 2, status: "self_serve", docsUrl: "d", serverUrl: "s", authMode: "api_key", prerequisite: "p", riskTier: "S3" },
  ],
};

const TYPES = [
  `export interface FieldDef { key: string; label: string; type: "text" | "password" | "checkbox"; required?: boolean; secret?: boolean; defaultValue?: string | boolean }`,
  `export interface ConnectionMethodDef {`,
  `  key: string; label?: string; transport?: string; auth: "oauth" | "api_key" | "none"; ownershipModes: ("customer" | "platform_shared" | "dcr")[];`,
  `  defaults?: { serverUrl?: string; discoveryUrl?: string | null; toolArgumentDefaults?: Record<string, unknown> };`,
  `  keyPlacement?: { location: "header" | "query"; name: string; prefix?: string | null };`,
  `  credentialFields?: FieldDef[]; tenantFields?: FieldDef[]; grantKinds?: string[]; warnings?: string[]; riskTier: "S1" | "S2" | "S3" | "S4";`,
  `}`,
  `export interface AppDefinition { schemaVersion: 1; slug: string; name: string; categories: string[]; featured?: boolean;`,
  `  branding: { logoUrl: string; darkLogoUrl?: string }; urlPatterns?: string[]; methods: ConnectionMethodDef[] }`,
  `export interface SelfServeMcpResearchEntry { slug: string; name: string; wave: 1 | 2 | 3 | 4 | "blocked"; status: "self_serve" | "blocked"; riskTier: string }`,
  `export interface SelfServeMcpResearchManifest { schemaVersion: 1; verifiedAt: string; entries: SelfServeMcpResearchEntry[] }`,
].join("\n");

const ROWS: Row[] = [
  {
    id: "PJS-01 app-definition documents cast `as AppDefinition[]`, filtered at module init (paperclip's app-definitions.ts)",
    files: {
      "defs/agentmail.json": doc(AGENTMAIL),
      "defs/github.json": doc(GITHUB),
      "defs/coda.json": doc(HIDDEN),
      "types.ts": TYPES,
      "generated.ts": [
        `import a0 from "./defs/agentmail.json" with { type: "json" };`,
        `import a1 from "./defs/github.json" with { type: "json" };`,
        `import a2 from "./defs/coda.json" with { type: "json" };`,
        `import type { AppDefinition } from "./types.ts";`,
        `export const APP_DEFINITIONS=[a0,a1,a2] as AppDefinition[];`,
      ].join("\n"),
      "main.ts": [
        `import { APP_DEFINITIONS } from "./generated.ts";`,
        `import type { AppDefinition, ConnectionMethodDef } from "./types.ts";`,
        `const CONNECTABLE_APP_SLUGS = new Set(["github", "agentmail", "coda"]);`,
        `export const CONNECTABLE_APP_DEFINITIONS = APP_DEFINITIONS.filter((app) => CONNECTABLE_APP_SLUGS.has(app.slug));`,
        `const HIDDEN = new Set(["coda"]);`,
        `export const APP_STORE_DEFINITIONS = CONNECTABLE_APP_DEFINITIONS.filter((app) => !HIDDEN.has(app.slug));`,
        `function get(slug: string): AppDefinition | null { return CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === slug) ?? null; }`,
        `function methods(app: AppDefinition): ConnectionMethodDef[] { return app.methods.filter((m) => m.ownershipModes.some((o) => o !== "platform_shared")); }`,
        `console.log(APP_DEFINITIONS.length, CONNECTABLE_APP_DEFINITIONS.length, APP_STORE_DEFINITIONS.map((a) => a.slug).join(","));`,
        `const gh = get("github")!;`,
        `console.log(gh.featured, gh.branding.darkLogoUrl ?? "none", get("coda")?.branding.darkLogoUrl ?? "none", get("nope"));`,
        `for (const m of gh.methods) console.log(m.key, m.label ?? "-", m.riskTier, m.keyPlacement?.prefix === null, m.defaults?.serverUrl ?? "-");`,
        `console.log(methods(gh).map((m) => m.key).join(","), (gh.methods[0].grantKinds ?? []).join("+"));`,
        `console.log(gh.methods[1].tenantFields?.map((f) => typeof f.defaultValue + ":" + String(f.defaultValue)).join(","));`,
        `const tad = gh.methods[0].defaults?.toolArgumentDefaults;`,
        `console.log(tad !== undefined && tad.meta !== undefined, JSON.stringify(tad ?? null));`,
        `const am = get("agentmail")!;`,
        `console.log(am.featured, am.methods[0].credentialFields?.[0].secret, "label" in am.methods[0], am.urlPatterns?.length ?? -1);`,
        `console.log(get("coda")!.urlPatterns!.join(" "), get("coda")!.methods[1].warnings?.length);`,
      ].join("\n"),
    },
  },
  {
    id: "PJS-02 a manifest with keys its type does not declare, cast `as Manifest` (paperclip's self-serve-mcp-research.ts)",
    files: {
      "m.json": doc(MANIFEST),
      "types.ts": TYPES,
      "research.ts": [
        `import manifest from "./m.json" with { type: "json" };`,
        `import type { SelfServeMcpResearchManifest } from "./types.ts";`,
        `export const SELF_SERVE_MCP_RESEARCH = manifest as SelfServeMcpResearchManifest;`,
        `export const SELF_SERVE_MCP_CANDIDATES = SELF_SERVE_MCP_RESEARCH.entries.filter((entry) => entry.status === "self_serve");`,
        `export const BLOCKED_MCP_PROVIDERS = SELF_SERVE_MCP_RESEARCH.entries.filter((entry) => entry.status === "blocked");`,
      ].join("\n"),
      "main.ts": [
        `import { BLOCKED_MCP_PROVIDERS, SELF_SERVE_MCP_CANDIDATES, SELF_SERVE_MCP_RESEARCH } from "./research.ts";`,
        `const SLUGS = new Set(["anthropic", ...SELF_SERVE_MCP_CANDIDATES.map((entry) => entry.slug), "monday"]);`,
        `console.log([...SLUGS].join(","), BLOCKED_MCP_PROVIDERS.length, SELF_SERVE_MCP_RESEARCH.verifiedAt);`,
        `console.log(SELF_SERVE_MCP_RESEARCH.entries.map((e) => String(e.wave)).join(","));`,
        `console.log(JSON.stringify(BLOCKED_MCP_PROVIDERS[0]));`,
        `console.log(Object.keys(SELF_SERVE_MCP_CANDIDATES[0]).join(","));`,
        `console.log(JSON.stringify(SELF_SERVE_MCP_RESEARCH).length);`,
      ].join("\n"),
    },
  },
  {
    id: "PJS-03 two importers of one document share its one object (a write through one is seen by the other)",
    files: {
      "m.json": doc(MANIFEST),
      "types.ts": TYPES,
      "x.ts": [
        `import doc from "./m.json" with { type: "json" };`,
        `import type { SelfServeMcpResearchManifest } from "./types.ts";`,
        `export const X = doc as SelfServeMcpResearchManifest;`,
        `X.entries.push({ slug: "late", name: "Late", wave: 3, status: "self_serve", riskTier: "S1" });`,
      ].join("\n"),
      "main.ts": [
        `import doc from "./m.json" with { type: "json" };`,
        `import { X } from "./x.ts";`,
        `import type { SelfServeMcpResearchManifest } from "./types.ts";`,
        `const M = doc as SelfServeMcpResearchManifest;`,
        `console.log(M === X, M.entries.length, M.entries.map((e) => e.slug).join(","));`,
        `console.log(JSON.stringify(M.entries[3]));`,
      ].join("\n"),
    },
  },
  {
    id: "PJS-04 the document read directly through its own JSON type (no cast)",
    files: {
      "m.json": doc(MANIFEST),
      "main.ts": [
        `import doc from "./m.json" with { type: "json" };`,
        `console.log(doc.entries.length, doc.entries[0].liveRead, doc.entries[1].evidenceLimit, doc.verifiedAt.toUpperCase());`,
        `console.log(Object.keys(doc.entries[1]).join(","));`,
        `for (const e of doc.entries) console.log(e.slug, e.blocker === null, e.blocker === undefined, typeof e.wave);`,
        `console.log(doc.entries.map((e) => e.slug).join("|"), doc.schemaVersion === 1, JSON.stringify(doc.entries[2]));`,
      ].join("\n"),
    },
  },
  {
    id: "PJS-05 the document's own numbers (-0, an out-of-range literal) and a re-exported binding (review)",
    files: {
      "d.json": `{ "z": -0, "big": 1e400, "n": null, "list": [{ "a": 1 }, { "b": "x", "c": [1, 2] }] }`,
      "mid.ts": [
        `import doc from "./d.json" with { type: "json" };`,
        `export { default as D } from "./d.json" with { type: "json" };`,
        `export default doc;`,
        `export { doc as E };`,
      ].join("\n"),
      "main.ts": [
        `import doc from "./d.json" with { type: "json" };`,
        `import M, { D, E } from "./mid.ts";`,
        `const z = doc.z as number, big = doc.big as number;`,
        `console.log(Object.is(z, -0), 1 / z, big, doc.n, JSON.stringify(doc.list));`,
        `console.log(M === doc, D === doc, E === doc, Object.keys(D.list[1]).join(","), JSON.stringify(E));`,
        `interface L { list: { a?: number; b?: string }[] }`,
        `const viaCast = D as L;`,
        `console.log(viaCast.list.length, viaCast.list[1].b, JSON.stringify(viaCast.list[1]));`,
      ].join("\n"),
    },
  },
  {
    id: "PJS-06 a single-shape document only ever cast (to two types, from two modules) is the one shared object",
    files: {
      "d.json": `{ "a": 1, "b": { "c": 2 }, "s": "x" }`,
      "x.ts": [
        `import doc from "./d.json" with { type: "json" };`,
        `export const N = doc as { a: number; b: { c: number } };`,
        `N.a = 5;`,
        `N.b.c = 6;`,
      ].join("\n"),
      "main.ts": [
        `import doc from "./d.json" with { type: "json" };`,
        `import { N } from "./x.ts";`,
        `const S = doc as { s: string; a: number };`,
        `console.log(S.a, S.s, JSON.stringify(S), JSON.stringify(N), Object.keys(S).join(","));`,
      ].join("\n"),
    },
  },
];

describe("paperclip JSON documents with no static representation (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("paperclip JSON documents with no static representation (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

const DROP: Row = {
  id: "PJS-R1 a document copied by `[d] as T[]` that holds a key T does not declare refuses by name (never a copy that drops it)",
  files: {
    "d.json": `{ "slug": "a", "methods": [{ "key": "k", "extra": 1 }, { "key": "j", "label": "L" }] }`,
    "main.ts": [
      `import d from "./d.json" with { type: "json" };`,
      `interface M { key: string; label?: string }`,
      `interface A { slug: string; methods: M[] }`,
      `const DEFS = [d] as A[];`,
      `console.log(JSON.stringify(DEFS[0]));`,
    ].join("\n"),
  },
};

const DROP_OPT: Row = {
  id: "PJS-R2 an undeclared key under an optional record field is checked too (review)",
  files: {
    "a1.json": `{ "a": 2, "o": { "p": 1, "x": 9 } }`,
    "main.ts": [
      `import a1 from "./a1.json" with { type: "json" };`,
      `interface T { a: number; o?: { p: number } | null }`,
      `const DEFS = [a1] as T[];`,
      `console.log(JSON.stringify(DEFS));`,
    ].join("\n"),
  },
};

const DROP_FILTER: Row = {
  id: "PJS-R3 the same document copied, then filtered (review t06)",
  files: {
    "a1.json": `{ "a": 2, "o": { "p": 1, "x": 9 } }`,
    "main.ts": [
      `import a1 from "./a1.json" with { type: "json" };`,
      `interface T { a: number; o?: { p: number } }`,
      `const DEFS = [a1] as T[];`,
      `const F = DEFS.filter((d) => d.a > 0);`,
      `console.log(JSON.stringify(F), F[0].o?.p);`,
    ].join("\n"),
  },
};
const DROP_UNDEF_ELEM: Row = {
  id: "PJS-R4 an element type that admits undefined is checked through its record arm (review t03)",
  files: {
    "a1.json": `{ "a": 2, "o": { "p": 1, "x": 9 } }`,
    "main.ts": [
      `import a1 from "./a1.json" with { type: "json" };`,
      `interface T { a: number; o?: { p: number } }`,
      `const DEFS = [a1] as (T | undefined)[];`,
      `console.log(DEFS[0]?.o?.p, DEFS.length);`,
    ].join("\n"),
  },
};

describe("paperclip JSON documents: copies that would drop a key refuse by name", () => {
  test("PJS-R3 (wasm)", async () => {
    await checkRefuses(scratch, DROP_FILTER, "which does not declare its key $.o.x", undefined, "wasm");
  }, 600_000);
  test("PJS-R4 (wasm)", async () => {
    await checkRefuses(scratch, DROP_UNDEF_ELEM, "which does not declare its key $.o.x", undefined, "wasm");
  }, 600_000);
  test("PJS-R2 (wasm)", async () => {
    await checkRefuses(scratch, DROP_OPT, "which does not declare its key $.o.x", undefined, "wasm");
  }, 600_000);
  test("PJS-R1 (wasm)", async () => {
    await checkRefuses(scratch, DROP, "which does not declare its key $.methods[0].extra", undefined, "wasm");
  }, 600_000);
  test("PJS-R1 (wasm-native)", async () => {
    await checkRefuses(scratch, DROP, "which does not declare its key $.methods[0].extra", undefined, "wasm-native");
  }, 600_000);
});
