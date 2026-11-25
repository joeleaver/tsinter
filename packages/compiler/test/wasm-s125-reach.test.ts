/* S125-J (SEMANTICS.md S125 amendment (J), docs/design/s125-copy-family.md):
 * the width copies no program can observe, judged more precisely, and the
 * named arm failure at a site whose instance was tried.
 *
 *   M1: a read-only tuple (`[...] as const`) copied into a read-only array
 *       slot that nothing writes, lets go or compares by identity
 *       (paperclip's parseEnumFromEnv<DeploymentMode>(raw, DEPLOYMENT_MODES)
 *       while a `string[]` is written elsewhere);
 *   M2: a fresh literal nested in a call-argument literal, headed for a
 *       package's declared parameter type, judged by its own keys (S091:
 *       an optional field left undefined is not an own key);
 *   M0: an instance or dynamic arm that was tried at the site and did not
 *       lower names its first diagnostic. */
import { defineRows } from "./u3u4-rows.js";

const PJ = (n: string): string => `{"name":"${n}","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`;

/** A clack-shaped prompt package: select() prints its options as given and
 * keeps the last ones; lastLabels() reads the kept options back later. */
const CL: Record<string, string> = {
  "node_modules/cl/package.json": PJ("cl"),
  "node_modules/cl/index.js": `let kept = null;
export async function select(opts) { kept = opts.options; console.log(opts.message, opts.options); return opts.options[0].value; }
export function isCancel(v) { return typeof v === "symbol"; }
export function lastLabels() { return JSON.stringify(kept); }`,
  "node_modules/cl/index.d.ts": `type Primitive = Readonly<string | boolean | number>;
type Option<Value> = Value extends Primitive ? { value: Value; label?: string; hint?: string; disabled?: boolean } : { value: Value; label: string; hint?: string; disabled?: boolean };
interface CommonOptions { signal?: AbortSignal; withGuide?: boolean; }
interface SelectOptions<Value> extends CommonOptions { message: string; options: Option<Value>[]; initialValue?: Value; maxItems?: number; }
export declare const select: <Value>(opts: SelectOptions<Value>) => Promise<Value | symbol>;
export declare function isCancel(value: unknown): value is symbol;
export declare function lastLabels(): string;`,
};

/** A zod-shaped package: datetime() serializes the params it is given. */
const ZZ: Record<string, string> = {
  "node_modules/zz/package.json": PJ("zz"),
  "node_modules/zz/index.js": `export function datetime(p) { return "dt " + JSON.stringify(p); }`,
  "node_modules/zz/index.d.ts": `export interface DateTimeParams { offset?: boolean; local?: boolean; precision?: number | null; message?: string; }
export declare function datetime(params?: string | DateTimeParams): string;`,
};

const ENUM_HELPERS = `function parseEnumFromEnv<T extends string>(rawValue: string | undefined, allowedValues: readonly T[]): T | null {
  if (!rawValue) return null;
  return allowedValues.includes(rawValue as T) ? (rawValue as T) : null;
}
function parseEnumList<T extends string>(value: string, allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed);
  const values: T[] = [];
  for (const item of value.split(",")) {
    if (!allowedSet.has(item)) continue;
    if (!values.includes(item as T)) values.push(item as T);
  }
  return values;
}`;

defineRows("S125-J reach", [
  {
    id: "S125-J-01 (M1, paperclip's parseEnumFromEnv) an `as const` tuple into a `readonly T[]` parameter, with an explicit type argument, while `string[]` values are written elsewhere",
    entry: "main.ts",
    src: `export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];
${ENUM_HELPERS}
const mode = parseEnumFromEnv<DeploymentMode>(process.env.S125J_NOPE, DEPLOYMENT_MODES) ?? "local_trusted";
const picked = parseEnumFromEnv<DeploymentMode>("authenticated", DEPLOYMENT_MODES);
const names: string[] = ["x"];
names.push("y");
names[0] = "z";
for (const m of DEPLOYMENT_MODES) console.log(m.length);
console.log(mode, picked, parseEnumList("authenticated,zz,local_trusted", DEPLOYMENT_MODES), names, DEPLOYMENT_MODES.join("|"), DEPLOYMENT_MODES);`,
  },
  {
    id: "S125-J-02 (M1) a cast alias of the tuple that is then written refuses: the copy would miss the write",
    entry: "main.ts",
    src: `const MODES = ["local", "cloud"] as const;
function parseEnum<T extends string>(raw: string, allowed: readonly T[]): T | null { return allowed.includes(raw as T) ? (raw as T) : null; }
const w = MODES as unknown as string[];
w.push("third");
console.log(parseEnum<"local" | "cloud">("third", MODES), MODES.length);`,
    refused: /SC1090 .*S125/,
  },
  {
    id: "S125-J-03 (M1) a mutable tuple, written while the copy is held, refuses",
    entry: "main.ts",
    src: `const MODES: [string, string] = ["local", "cloud"];
function check(raw: string, allowed: readonly string[], during: () => void): boolean { during(); return allowed.includes(raw); }
console.log(check("third", MODES, () => { MODES[0] = "third"; }), MODES);`,
    refused: /SC1090 .*COPY.*S125/,
  },
  {
    id: "S125-J-04 (M1) `===` on the array type refuses: the copy is a different object",
    entry: "main.ts",
    src: `const MODES = ["local", "cloud"] as const;
function same(a: readonly string[], b: readonly string[]): boolean { return a === b; }
function parseEnum<T extends string>(raw: string, allowed: readonly T[]): T | null { return allowed.includes(raw as T) ? (raw as T) : null; }
console.log(same(MODES, MODES), parseEnum<"local" | "cloud">("cloud", MODES));`,
    refused: /SC1090 .*COPY.*S125/,
  },
  {
    id: "S125-J-05 (M2, paperclip's onboard select) a clack-shaped select whose options are fresh literals with `as const` values: the package prints them as Node does",
    entry: "main.ts", npmStatic: ["cl"], files: CL,
    src: `import * as p from "cl";
async function main(): Promise<void> {
  const label = "OpenAI";
  await p.select({
    message: "LLM provider",
    options: [
      { value: "claude" as const, label: "Claude (Anthropic)" },
      { value: "openai" as const, label, hint: "gpt" },
    ],
  });
  console.log(p.lastLabels());
}
void main();`,
  },
  {
    id: "S125-J-06 (M2, paperclip's z.iso.datetime({ offset: true })) a literal headed for a package's declared optional-field type: the unspelled optional fields are not own keys (S091)",
    entry: "main.ts", npmStatic: ["zz"], files: ZZ,
    src: `import { datetime } from "zz";
console.log(datetime({ offset: true }), datetime({ precision: 3 }), datetime({ offset: false }));`,
  },
  {
    id: "S125-J-07 (M2) a literal the program keeps a binding to, nested in a call-argument literal the callee keeps, and written later: not fresh, so the copy still refuses",
    entry: "main.ts",
    src: `type Opt = { value: string; label?: string; hint?: string };
let kept: Opt[] = [];
const show: (o: { message: string; options: Opt[] }) => void = (o) => { kept = o.options; };
const opt = { value: "a" as const, label: "A" };
show({ message: "m", options: [opt, { value: "b" as const, label: "B" }] });
opt.label = "Z";
console.log(JSON.stringify(kept));`,
    refused: /SC1090 .*COPY.*S125/,
  },
  {
    id: "S125-J-08 (M0) an instance that was tried at the site and did not lower names its first diagnostic",
    entry: "main.ts",
    src: `class P { n = 1; m = 2; }
function bump(o: { n: number }): string { o.n++; return JSON.stringify(o); }
const p = new P();
console.log(bump(p), p.n);`,
    refused: /the instance that shares the object \(S125 \(a\)\) was tried here and did not lower: SC1090 JSON\.stringify/,
  },
]);
