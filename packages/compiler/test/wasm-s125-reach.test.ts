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
 *       lower names its first diagnostic.
 *
 * And (review of 59e69bd5) a write through a cast alias of the copy — the
 * slot's binding, a parameter, a returned alias, the tuple itself — while
 * the original's length is still read refuses by name instead of growing
 * the copy alone; a tuple into an optional array slot converts. */
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
    refused: /the instance that shares the object \(S125 \(a\)\) was tried here and did not lower: SC1090 JSON\.stringify.* \[line 2\]\)/,
  },
]);

/** The program under every cast-alias row: an `as const` tuple, and a
 * `string[]` written elsewhere (the by-type answer alone would refuse). */
const CM = `const MODES = ["a", "b"] as const;
type Mode = (typeof MODES)[number];
const names: string[] = ["x"];
names.push("y");
`;
const COPY = /SC1090 .*COPY.*S125/;

defineRows("S125-J cast-alias writes", [
  { id: "S125-J-09 a write through a cast of the read-only slot's binding refuses (Node: 3 3)", entry: "main.ts", refused: COPY,
    src: `const MODES = ["a", "b"] as const; const ro: readonly string[] = MODES; (ro as string[]).push("z"); console.log(ro.length, MODES.length);` },
  { id: "S125-J-10 a generic callee writing its parameter through `as T[]` refuses", entry: "main.ts", refused: COPY,
    src: CM + `function g<T extends string>(xs: readonly T[]): number { (xs as T[]).push("z" as T); return xs.length; }
console.log(g<Mode>(MODES), MODES.length);` },
  { id: "S125-J-11 a rest parameter written through a cast refuses", entry: "main.ts", refused: COPY,
    src: CM + `function g<T extends string>(...rest: (readonly T[])[]): number { (rest[0] as T[]).push("z" as T); return rest[0]!.length; }
console.log(g<Mode>(MODES), MODES.length);` },
  { id: "S125-J-12 a constructor parameter property written through a cast refuses", entry: "main.ts", refused: COPY,
    src: CM + `class C<T extends string> { constructor(readonly xs: readonly T[]) {} }
const c = new C<Mode>(MODES);
(c.xs as string[]).push("z");
console.log(c.xs.length, MODES.length);` },
  { id: "S125-J-13 a method writing its parameter through a cast refuses", entry: "main.ts", refused: COPY,
    src: CM + `class K { run<T extends string>(xs: readonly T[]): number { (xs as T[]).push("z" as T); return xs.length; } }
console.log(new K().run<Mode>(MODES), MODES.length);` },
  { id: "S125-J-14 an async function writing its parameter through a cast refuses", entry: "main.ts", refused: COPY,
    src: CM + `async function g<T extends string>(xs: readonly T[]): Promise<number> { await 0; (xs as T[]).push("z" as T); return xs.length; }
void g<Mode>(MODES).then((n) => console.log(n, MODES.length));` },
  { id: "S125-J-15 a callback writing what it is handed through a cast refuses", entry: "main.ts", refused: COPY,
    src: CM + `function g<T extends string>(xs: readonly T[], cb: (x: readonly T[]) => void): number { cb(xs); return xs.length; }
console.log(g<Mode>(MODES, (x) => { (x as string[]).push("z"); }), MODES.length);` },
  { id: "S125-J-16 a function called through a const alias, and an arrow const, writing through a cast refuse", entry: "main.ts", refused: COPY,
    src: CM + `function w(xs: readonly string[]): number { (xs as string[]).push("z"); return xs.length; }
const g = w;
const a = (xs: readonly string[]): number => { (xs as string[]).reverse(); return xs.length; };
console.log(g(MODES), a(MODES), MODES.length);` },
  { id: "S125-J-17 a write seven calls deep refuses", entry: "main.ts", refused: COPY,
    src: CM + `function f7<T extends string>(xs: readonly T[]): number { (xs as T[]).push("z" as T); return xs.length; }
function f6<T extends string>(xs: readonly T[]): number { return f7(xs); }
function f5<T extends string>(xs: readonly T[]): number { return f6(xs); }
function f4<T extends string>(xs: readonly T[]): number { return f5(xs); }
function f3<T extends string>(xs: readonly T[]): number { return f4(xs); }
function f2<T extends string>(xs: readonly T[]): number { return f3(xs); }
function f1<T extends string>(xs: readonly T[]): number { return f2(xs); }
console.log(f1<Mode>(MODES), MODES.length);` },
  { id: "S125-J-18 `satisfies` and then a cast, written, refuses", entry: "main.ts", refused: COPY,
    src: CM + `function g<T extends string>(xs: readonly T[]): number { ((xs satisfies readonly T[]) as T[]).push("z" as T); return xs.length; }
console.log(g<Mode>(MODES), MODES.length);` },
  { id: "S125-J-19 an optional parameter written through `xs! as T[]` refuses", entry: "main.ts", refused: COPY,
    src: CM + `function g<T extends string>(xs: readonly T[] | undefined): number { (xs! as T[]).push("z" as T); return xs!.length; }
console.log(g<Mode>(MODES), MODES.length);` },
  { id: "S125-J-20 a returned alias written through a cast refuses (Node: 3 3)", entry: "main.ts", refused: COPY,
    src: CM + `function keep<T extends string>(xs: readonly T[]): readonly T[] { return xs; }
const k = keep<Mode>(MODES);
(k as Mode[]).push("a");
(keep<Mode>(MODES) as Mode[]).push("b");
console.log(k.length, MODES.length);` },
  { id: "S125-J-21 the tuple itself written through `as unknown as string[]`, with no binding, refuses by name", entry: "main.ts", refused: COPY,
    src: `const MODES = ["a", "b"] as const; (MODES as unknown as string[]).push("z"); console.log(MODES.length);` },
  { id: "S125-J-23 a union of tuples cast to `string[]` and written refuses by name (no one array rebuilds both)", entry: "main.ts", refused: /SC1090 a '.*' value cast to 'string\[\]' \(a tuple arm is a fixed shape/,
    src: `const MODES = ["a", "b"] as const;
const OTHER = ["c"] as const;
const pick = process.argv.length > 0 ? MODES : OTHER;
(pick as unknown as string[]).push("z");
console.log(pick.length, MODES.length);` },
  { id: "S125-J-22 a tuple into an optional read-only array parameter converts and reads as Node does", entry: "main.ts",
    src: CM + `function g<T extends string>(xs: readonly T[] | undefined): number { return xs === undefined ? -1 : xs.length + xs.indexOf("b" as T); }
function h(xs?: readonly string[]): string { return xs?.join("+") ?? "none"; }
console.log(g<Mode>(MODES), g<Mode>(undefined), h(MODES), h(), MODES.length, names);` },
]);

/** (Review of 97207d74) A tuple's folded `.length` read through any
 * receiver form the fold admits — a namespace member, a module namespace
 * import, a static field, an object property, `this` — still observes the
 * original, so a write through a cast alias of its copy refuses (Node: 3). */
defineRows("S125-J folded length receivers", [
  { id: "S125-J-24 a namespace member's length after a write through a cast alias refuses", entry: "main.ts", refused: COPY,
    src: `namespace NS { export const T = ["a", "b"] as const; }
const ro: readonly string[] = NS.T;
(ro as string[]).push("z");
console.log(NS.T.length);` },
  { id: "S125-J-25 a module namespace import's length (`ns.T.length`) after a write through a cast alias refuses", entry: "main.ts", refused: COPY,
    files: { "modes.ts": `export const T = ["a", "b"] as const;` },
    src: `import * as ns from "./modes.ts";
const ro: readonly string[] = ns.T;
(ro as string[]).push("z");
console.log(ns.T.length);` },
  { id: "S125-J-26 a static class field's length after a write through a cast alias refuses", entry: "main.ts", refused: COPY,
    src: `class C { static readonly T = ["a", "b"] as const; }
const ro: readonly string[] = C.T;
(ro as string[]).push("z");
console.log(C.T.length);` },
  { id: "S125-J-27 an object property's length after a write through a cast alias refuses", entry: "main.ts", refused: COPY,
    src: `const h = { t: ["a", "b"] as const };
const ro: readonly string[] = h.t;
(ro as string[]).push("z");
console.log(h.t.length);` },
  { id: "S125-J-28 `this.t.length` after a write through a cast alias refuses", entry: "main.ts", refused: COPY,
    src: `class H { t = ["a", "b"] as const; run(): number { const ro: readonly string[] = this.t; (ro as string[]).push("z"); return this.t.length; } }
console.log(new H().run());` },
]);

/** (Review of 97207d74) A tuple cast to an array type outside a method
 * call: a read straight off the cast reads a copy dropped on the spot
 * (Node's output); a write through it is the judged width copy and refuses
 * while the tuple is still observed. */
defineRows("S125-J tuple casts", [
  { id: "S125-J-29 `.length`, an element and a read-only method read straight off a tuple cast to an array match Node", entry: "main.ts",
    src: CM + `const t: [number, number] = [1, 2];
const i = process.argv.length > 99 ? 0 : 1;
console.log((MODES as readonly string[]).length, (MODES as unknown as string[])[1], (t as unknown as number[])[i], (t as unknown as number[])[5]);
console.log((MODES as readonly string[]).includes("b"), MODES.length, t, names);` },
  { id: "S125-J-30 `.sort()` through `as unknown as string[]` refuses (the copy would be sorted alone)", entry: "main.ts", refused: COPY,
    src: `const T = ["b", "a"] as const;
(T as unknown as string[]).sort();
console.log(T[0], T.length);` },
  { id: "S125-J-31 an element written through `as unknown as number[]` refuses (Node: 9)", entry: "main.ts", refused: COPY,
    src: `const t: [number, number] = [1, 2];
(t as unknown as number[])[0] = 9;
console.log(t[0]);` },
  { id: "S125-J-32 an element incremented through a cast refuses by name (Node: 2; `++` of an element is refused for every array)", entry: "main.ts", refused: /SC1090 increment\/decrement of non-variables/,
    src: `const t: [number, number] = [1, 2];
(t as unknown as number[])[0]++;
console.log(t[0]);` },
]);

/** (Review of 97207d74) M0's note names where the blocking diagnostic was
 * reported relative to the refused site: another file by its path from the
 * site's directory (S125-J-08 has the same-file `[line N]`). */
defineRows("S125-J arm-failure place", [
  { id: "S125-J-33 (M0) a blocking diagnostic in another module is placed by its relative path", entry: "main.ts",
    files: { "util/bump.ts": `export function bump(o: { n: number }): string {
  o.n++; return JSON.stringify(o);
}` },
    src: `import { bump } from "./util/bump.ts";
class P { n = 1; m = 2; }
const p = new P();
console.log(bump(p), p.n);`,
    refused: /the instance that shares the object \(S125 \(a\)\) was tried here and did not lower: SC1090 JSON\.stringify.* \[util\/bump\.ts:2\]\)/ },
]);
