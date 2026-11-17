/* paperclip's shared record types and callbacks:
 * - `AgentAdapterType = (typeof AGENT_ADAPTER_TYPES)[number] | (string & {})`,
 *   the "any string, with these suggestions" idiom: `string & {}` holds
 *   exactly the strings, so the type is `string` (Agent, Agent[] and the
 *   `api.get<Agent>` promises compile).
 * - Callbacks whose parameters hold `unknown` leaves box into dynamic
 *   code: the `Object.entries(x).filter(([key]) => …)` entry tuple, and a
 *   zod-style `superRefine((value: { status?: string; extra?: unknown },
 *   ctx) => …)` over a package's dynamic implementation.
 * Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("wasm-top10-paperclip-open-string");
const pj = (o: unknown): string => JSON.stringify(o);

const ROWS: Row[] = [
  {
    id: "POS-01 a literal union widened by (string & {}) holds any string (paperclip's AgentAdapterType)",
    files: {
      "main.ts": [
        `const AGENT_ADAPTER_TYPES = ["process", "http", "claude_local"] as const;`,
        `type AgentAdapterType = (typeof AGENT_ADAPTER_TYPES)[number] | (string & {});`,
        `interface Agent { id: string; adapterType: AgentAdapterType; weight: number & {} }`,
        `function label(a: Agent): string {`,
        `  if (a.adapterType === "process") return "proc";`,
        `  return a.adapterType.toUpperCase() + ":" + a.adapterType.length;`,
        `}`,
        `const agents: Agent[] = [{ id: "1", adapterType: "process", weight: 2 }, { id: "2", adapterType: "custom_thing", weight: 3 }];`,
        `for (const a of agents) console.log(label(a), a.weight + 1, typeof a.adapterType);`,
        `const parsed = JSON.parse('{"id":"3","adapterType":"x","weight":1}') as Agent;`,
        `console.log(label(parsed), parsed.adapterType === "x", JSON.stringify(parsed));`,
        `async function get<T>(text: string): Promise<T | null> { return text ? (JSON.parse(text) as T) : null; }`,
        `async function main(): Promise<void> {`,
        `  const me = await get<Agent>('{"id":"9","adapterType":"http","weight":4}');`,
        `  const none = await get<Agent[]>("");`,
        `  console.log(me?.adapterType, me ? label(me) : "-", none ?? "none");`,
        `}`,
        `void main();`,
      ].join("\n"),
    },
  },
  {
    id: "POS-02 an Object.entries filter callback over a dynamic record (paperclip's assertSafeManagedEnvironment)",
    files: {
      "main.ts": [
        `function record(v: unknown): Record<string, unknown> {`,
        `  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};`,
        `}`,
        `const env = JSON.parse('{"config":{"packages":{"type":"x","pip":["a","b"],"npm":"c"}}}') as Record<string, unknown>;`,
        `const packages = record(record(env.config).packages);`,
        `const kept = Object.entries(packages).filter(([key]) => key !== "type");`,
        `console.log(kept.length, kept.map(([k]) => k).join(","));`,
      ].join("\n"),
    },
  },
  {
    id: "POS-03 a refine callback whose record parameter holds unknown, called by a package's dynamic implementation",
    npmStatic: ["pz"],
    files: {
      "package.json": pj({ type: "module" }),
      "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
      "node_modules/pz/package.json": pj({ name: "pz", version: "1.0.0", type: "module", types: "./index.d.mts", exports: { ".": { types: "./index.d.mts", default: "./index.mjs" } } }),
      "node_modules/pz/index.d.mts": [
        `export interface RefinementCtx { addIssue(issue: { message: string; path?: string[] }): void }`,
        `export declare function check(input: string, refine: (value: { status?: string; unblockDescriptor?: unknown }, ctx: RefinementCtx) => void): string[];`,
      ].join("\n"),
      "node_modules/pz/index.mjs": [
        `export function check(input, refine) {`,
        `  const issues = [];`,
        `  const ctx = { addIssue: (i) => { issues.push((i.path ?? []).join(".") + ": " + i.message); } };`,
        `  refine(JSON.parse(input), ctx);`,
        `  return issues;`,
        `}`,
      ].join("\n"),
      "main.ts": [
        `import { check, type RefinementCtx } from "pz";`,
        `function requireBlockedStatusForUnblockDescriptor(value: { status?: string; unblockDescriptor?: unknown }, ctx: RefinementCtx) {`,
        `  if (value.unblockDescriptor != null && value.status !== undefined && value.status !== "blocked") {`,
        `    ctx.addIssue({ message: "unblockDescriptor requires blocked status", path: ["unblockDescriptor"] });`,
        `  }`,
        `}`,
        `console.log(JSON.stringify(check('{"status":"open","unblockDescriptor":{"a":1}}', requireBlockedStatusForUnblockDescriptor)));`,
        `console.log(JSON.stringify(check('{"status":"blocked","unblockDescriptor":1}', requireBlockedStatusForUnblockDescriptor)));`,
        `console.log(JSON.stringify(check('{}', requireBlockedStatusForUnblockDescriptor)));`,
      ].join("\n"),
    },
  },
];

describe("paperclip open strings and unknown-leaf callbacks (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("paperclip open strings and unknown-leaf callbacks (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
