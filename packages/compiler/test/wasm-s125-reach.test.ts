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
 * the copy alone; a tuple into an optional array slot converts.
 *
 * S125-K (amendment (K), the second defineRows below): the dynamic arm's
 * reach — a deferred `let`, conditional operands, `const` pattern names, a
 * module global from a package's call and a defaulted parameter hold the
 * dynamic value itself; the forms left out refuse by name. */
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

/** GH #274: a tuple's `.length` is its arity constant, but the receiver
 * is evaluated whenever that could be observed (tuple-length.ts): a getter
 * anywhere on the chain runs, once, in source order; a chain of plain data
 * reads still folds (S125-J's `tupleOf` read). */
defineRows("S125-J tuple length receivers", [
  { id: "S125-J-34 `.length` off a class getter runs the getter", entry: "main.ts",
    src: `class C { get t() { console.log("get"); return ["a", "b"] as const; } }
console.log(new C().t.length);
const c = new C();
console.log(c.t.length, c.t.length);` },
  { id: "S125-J-35 `.length` off an inherited getter and an overriding one runs the receiver's getter", entry: "main.ts",
    src: `class B { get t(): readonly [number, number] { console.log("B.get"); return [1, 2]; } }
class D extends B {}
class E extends B { override get t(): readonly [number, number] { console.log("E.get"); return [3, 4]; } }
console.log(new D().t.length);
const bs: B[] = [new B(), new E()];
for (const b of bs) console.log(b.t.length);` },
  { id: "S125-J-36 `.length` off a static getter refuses by name (static accessors have no lowering; Node: `static get`, 3)", entry: "main.ts",
    refused: /SC1090 the static member 't' of class 'S' \(static accessors/,
    src: `class S { static get t() { console.log("static get"); return ["x", "y", "z"] as const; } }
console.log(S.t.length);` },
  { id: "S125-J-37 `.length` off an object-literal getter runs it", entry: "main.ts",
    src: `let n = 0;
const o = { get t() { n++; console.log("lit get", n); return [1, 2] as const; } };
console.log(o.t.length);
console.log(o.t.length, n);` },
  { id: "S125-J-38 a getter in the middle of a chain (`a.g.t.length`) runs once", entry: "main.ts",
    src: `const a = { get g() { console.log("g"); return { t: ["p", "q"] as const }; } };
console.log(a.g.t.length);
class G { get g() { console.log("G.g"); return { t: [1, 2, 3] as const }; } }
const h = { inner: new G() };
console.log(h.inner.g.t.length);` },
  { id: "S125-J-39 plain data chains still fold and match Node", entry: "main.ts",
    src: `const T = ["a", "b"] as const;
namespace NS { export const U = [1, 2] as const; }
class H { t = [1, 2, 3] as const; static S = ["z"] as const; n = { t: [1] as const }; len(): number { return this.t.length + this.n.t.length; } }
const h = new H();
const o = { t: [1, 2] as const, in: { t: [1, 2, 3, 4] as const } };
console.log(T.length, NS.U.length, h.t.length, H.S.length, h.n.t.length, o.t.length, o.in.t.length, h.len(), (o).in!.t.length);` },
  { id: "S125-J-40 the receiver's side effect keeps its place in a larger expression", entry: "main.ts",
    src: `let n = 0;
class C { get t() { n++; console.log("get", n); return ["a", "b"] as const; } }
const c = new C();
function f(x: string): number { console.log("f", x); return 1; }
console.log(f("a") + c.t.length * 10 + f("b"), n);
function mk(): [string, number] { console.log("mk"); return ["z", 9]; }
console.log(mk().length + mk().length);
const ok = f("c") > 0 && c.t.length === 2;
console.log(ok, n);` },
  { id: "S125-J-41 `.length` of a module binding read before its declaration throws Node's ReferenceError", entry: "main.ts",
    src: `function peek(): string { try { return String(T.length); } catch (e) { return (e as Error).name + ": " + (e as Error).message; } }
console.log(peek());
const T = ["a", "b"] as const;
console.log(peek());` },
  { id: "S125-J-44 `.length` of a function-scope const read by an arrow before its declaration throws Node's ReferenceError", entry: "main.ts",
    src: `function f(): void {
  const g = (): string => { try { return String(T.length); } catch (e) { return (e as Error).name + ": " + (e as Error).message; } };
  console.log(g());
  const T = ["a", "b"] as const;
  console.log(g());
}
f();` },
  { id: "S125-J-45 `.length` of a block-scope const read before its declaration throws", entry: "main.ts",
    src: `{
  const g = (): string => { try { return String(T.length); } catch (e) { return (e as Error).name + ": " + (e as Error).message; } };
  console.log(g());
  const T = [1, 2, 3] as const;
  console.log(g());
}` },
  { id: "S125-J-46 `.length` read by a nested function declaration before the const's declaration throws", entry: "main.ts",
    src: `function f(): void {
  function g(): string { try { return String(T.length); } catch (e) { return (e as Error).name + ": " + (e as Error).message; } }
  console.log(g());
  const T = [1] as const;
  console.log(g());
}
f();` },
  { id: "S125-J-47 a chain rooted at a local still in its TDZ (`o.t.length` before `const o`) throws", entry: "main.ts",
    src: `function f(): void {
  const g = (): string => { try { return String(o.t.length); } catch (e) { return (e as Error).name + ": " + (e as Error).message; } };
  console.log(g());
  const o = { t: [1, 2, 3] as const };
  console.log(g());
}
f();` },
  { id: "S125-J-42 a getter satisfying an interface's data property refuses by name where it enters the record slot", entry: "main.ts",
    refused: /SC1090 a get\/set accessor satisfying the data property 't'/,
    src: `interface HasT { readonly t: readonly [string, string]; }
const viaLit: HasT = { get t() { console.log("iface lit get"); return ["a", "b"] as const; } };
console.log(viaLit.t.length);
class K implements HasT { get t() { console.log("K get"); return ["c", "d"] as const; } }
const k: HasT = new K();
console.log(k.t.length);` },
  { id: "S125-J-43 a computed key cast to a literal type off an `any` receiver refuses by name instead of folding the read away (Node: `k read`, 1)", entry: "main.ts",
    refused: /SC1090 computed property keys/,
    src: `const p: any = { get k() { console.log("k read"); return "a"; } };
const o = { [p.k as "a"]: 1 };
console.log(o.a);` },
]);

/* S125-K (SEMANTICS.md S125 amendment (K)): the dynamic arm's reach — five
 * more slots hold the dynamic value itself where S125 (c) refuses its copy:
 * a `let` assigned only by plain `=` statements, an operand of `?:`/`??`/
 * `||`/`&&` inside a contained slot, a name of a `const` destructuring
 * pattern, a module global initialized by a package's call, and a
 * defaulted parameter of a plain function. Each row prints identity,
 * writes through both sides, JSON and key order against Node; the forms
 * left out refuse by name. */

/** A zod/drizzle-shaped package whose results are the values it keeps
 * (lastCfg() reads the last one back). */
const ZK: Record<string, string> = {
  "node_modules/zk/package.json": PJ("zk"),
  "node_modules/zk/index.js": `let last = null;
export function parseCfg(v) { last = v; return v; }
export function lastCfg() { return last; }
class ZObj { constructor(shape) { this.shape = shape; } parse(v) { last = { ...v, parsed: true }; return last; } }
export function object(shape) { return new ZObj(shape); }
export function makeRows() { const r = JSON.parse('[{"n":1,"tags":["a"]},{"n":2,"tags":["x"]}]'); last = r; return r; }
export function selectP() { const r = JSON.parse('[{"n":1,"tags":["a"]},{"n":2,"tags":["x"]}]'); last = r; return Promise.resolve(r); }`,
  "node_modules/zk/index.d.ts": `export type Cfg = { a: number[]; name: string };
export declare function parseCfg(v: unknown): Cfg;
export declare function lastCfg(): any;
export interface ZObj<T> { parse(v: unknown): T }
export declare function object<T>(shape: T): ZObj<{ [K in keyof T]: string }>;
export declare function makeRows(): { n: number; tags: string[] }[];
export declare function selectP(): Promise<{ n: number; tags: string[] }[]>;`,
};

const READ_CONFIG = `import { parseCfg, lastCfg, type Cfg } from "zk";
function readConfig(t: string): Cfg | null { return parseCfg(JSON.parse(t)); }`;

defineRows("S125-K: the dynamic arm's reach", [
  { id: "S125-K-01 a deferred `let` assigned a package's result (r4) holds it: writes through either side, a closure's write, JSON and key order match Node", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `${READ_CONFIG}
function run(): void {
  let config: Cfg | null = null;
  try {
    config = readConfig('{"a":[1],"name":"n","extra":true}')!;
  } catch (e) { console.log("caught"); }
  const reset = (): void => { config = null; };
  config!.a.push(2);
  lastCfg().a.push(3);
  console.log(config, config === lastCfg(), JSON.stringify(config), Object.keys(config!));
  let other: Cfg | null | undefined;
  other = readConfig('{"name":"m","a":[]}');
  console.log(other, other === lastCfg());
  reset();
  console.log(config);
}
run();` },
  { id: "S125-K-02 a deferred `let` assigned a package's result on one path and a typed object on the other shares each", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
const local: Cfg = { a: [5], name: "local" };
function run(n: number): void {
  let cfg: Cfg;
  if (n > 0) cfg = parseCfg(JSON.parse('{"a":[1],"name":"p","extra":1}'));
  else cfg = local;
  cfg.a.push(n);
  const keep = (): Cfg => cfg;
  console.log(cfg, keep() === cfg, n > 0 ? cfg === lastCfg() : cfg === local, JSON.stringify(cfg), local);
}
run(1);
run(0);` },
  { id: "S125-K-03 `?:` arms (p3): a cast of an `unknown` member beside a fresh literal, and two package results, hold the value itself", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
function run(payload: Record<string, unknown>) {
  const args = Array.isArray(payload.commandArgs) ? (payload.commandArgs as string[]) : [];
  args.push("z");
  console.log(args, payload.commandArgs, args === payload.commandArgs);
  const m = typeof payload.message === "object" && payload.message !== null ? (payload.message as Record<string, unknown>) : {};
  m.k2 = 1;
  console.log(m, payload);
}
run(JSON.parse('{"commandArgs":["x","y"],"message":{"k":1}}'));
run({ commandArgs: 5 });
function pick(flag: boolean, t: string): Cfg {
  const c = flag ? parseCfg(JSON.parse(t)) : parseCfg({ a: [], name: "d" });
  c.a.push(7);
  return c;
}
const x = pick(true, '{"a":[1],"name":"n","z":0}');
console.log(x, x === lastCfg(), JSON.stringify(x));
const y = pick(false, "");
console.log(y, y === lastCfg());` },
  { id: "S125-K-04 `??`, `||` and `&&` operands of a contained slot (a binding, a plain function's result) hold the value itself", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
const raw: any = JSON.parse('{"list":[1,2]}');
const xs = (raw.list as number[] | undefined) ?? [];
xs.push(3);
const ys = (raw.none as number[] | undefined) ?? [];
ys.push(4);
const zs = (raw.list as number[]) || [];
const ws = raw.list && (raw.list as number[]);
console.log(xs, raw.list, ys, zs === raw.list, ws === raw.list);
function load(t: string | null): Cfg | null {
  return t === null ? null : parseCfg(JSON.parse(t));
}
const c = load('{"a":[1],"name":"n","q":true}') ?? { a: [], name: "fallback" };
c.a.push(2);
console.log(c, c === lastCfg(), load(null), JSON.stringify(c));` },
  { id: "S125-K-05 names of `const` array and object patterns over a package's rows (drizzle's `const [counts] = await db.select()`) are the rows themselves", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { makeRows, selectP, lastCfg } from "zk";
async function main(): Promise<void> {
  const [first] = await selectP();
  first.tags.push("b");
  console.log(first, lastCfg()[0], first === lastCfg()[0], JSON.stringify(first));
  const [a, b] = makeRows();
  b.tags.push("c");
  const { n, tags } = a;
  tags.push("t");
  const [{ tags: t0 }] = lastCfg() as { n: number; tags: string[] }[];
  console.log(a === lastCfg()[0], n, tags === a.tags, t0 === tags, b === lastCfg()[1], JSON.stringify(lastCfg()), Object.keys(a));
  lastCfg()[0].tags.push("w");
  console.log(tags, a);
}
main();` },
  { id: "S125-K-06 a module global initialized by a package's parse holds its result: identity, writes from its module and an importer, JSON and keys", entry: "main.ts",
    npmStatic: ["zk"], files: { ...ZK, "util/cfg.ts": `import { object } from "zk";
const policy = object({ mode: "" });
export const def = policy.parse({ mode: "x", extra: 2 });
export function bump(): void { def.mode = def.mode + "!"; }` },
    src: `import { def, bump } from "./util/cfg.ts";
import { lastCfg } from "zk";
bump();
console.log(def, def === lastCfg(), JSON.stringify(def), Object.keys(def));
def.mode = "y";
console.log(lastCfg());` },
  { id: "S125-K-07 a defaulted `opts = {}` (q1) binds a dynamic argument itself and picks its default on the dynamic undefined, with and without the argument", entry: "main.ts",
    src: `type Opts = { verbose?: boolean; tags?: string[] };
function cmd(options: Opts = {}, extra = 1): void {
  options.tags?.push("z");
  console.log(options, extra);
}
const o: any = JSON.parse('{"tags":["a"],"k":1}');
cmd(o);
console.log(o);
cmd();
cmd(undefined);
const dyn: any = undefined;
cmd(dyn, 2);` },
  { id: "S125-K-08 a `const` pattern's names are fresh per loop iteration: closures made in the loop see their own (`var`-hoisted before)", entry: "main.ts",
    src: `const fns: (() => number)[] = [];
for (const o of [{ a: 1 }, { a: 2 }, { a: 3 }]) {
  const { a } = o;
  fns.push(() => a);
}
console.log(fns.map((f) => f()));
const gs: (() => number)[] = [];
for (let i = 0; i < 3; i++) {
  const [b] = [i * 10];
  gs.push(() => b);
}
console.log(gs.map((f) => f()));
const raw: any = JSON.parse('[{"a":1},{"a":2}]');
const hs: (() => unknown)[] = [];
for (const r of raw) { const { a } = r; hs.push(() => a); }
console.log(hs.map((f) => f()));` },
  { id: "S125-K-13 a deferred `let` assigned a cast of an `unknown` value holds the value itself", entry: "main.ts",
    src: `type T = { a: number[]; name: string };
function run(src: string): void {
  let cfg: T | null = null;
  const u: unknown = JSON.parse(src);
  cfg = u as T;
  cfg.a.push(2);
  console.log(cfg, u === cfg, JSON.stringify(u), Object.keys(cfg));
}
run('{"a":[1],"name":"n","extra":true}');` },
  { id: "S125-K-09 a module-scope `let` assigned a package's result keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into 'null \| \{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `${READ_CONFIG}
let config: Cfg | null = null;
config = readConfig('{"a":[1],"name":"n","extra":true}');
config!.a.push(2);
console.log(config, config === lastCfg());` },
  { id: "S125-K-10 a `let` also written by a compound assignment (`??=`) keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into 'null \| \{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `${READ_CONFIG}
function run(): void {
  let config: Cfg | null = null;
  config ??= readConfig('{"a":[1],"name":"n","extra":true}');
  config!.a.push(2);
  console.log(config, lastCfg() === config);
}
run();` },
  { id: "S125-K-11 a `let` that is a for-of target keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `import { parseCfg, type Cfg } from "zk";
function run(): void {
  let cfg: Cfg | undefined;
  for (cfg of [parseCfg(JSON.parse('{"a":[1],"name":"p","extra":1}'))]) cfg.a.push(2);
  console.log(cfg);
}
run();` },
  { id: "S125-K-12 a `?:` whose other arm is a typed object keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
const fallback: Cfg = { a: [], name: "f" };
function pick(flag: boolean): Cfg {
  const c = flag ? parseCfg(JSON.parse('{"a":[1],"name":"n","z":0}')) : fallback;
  c.a.push(7);
  return c;
}
console.log(pick(true), lastCfg(), pick(false), fallback);` },
  // A spread's key-order snapshot belongs to the lowering that took it: the
  // same literal lowered again in a width instance on the dynamic arm (the
  // spread now dynamic) once read the typed instance's hidden local and
  // shape (paperclip's zod transform `{ ...rest, supportsLoginPty: … }`
  // crashed the compiler on a shape of an earlier pass).
  { id: "S125-K-14 a literal spread in a typed instance and in an instance on the dynamic arm keeps each instance's key order", entry: "main.ts",
    src: `interface Cfg { a?: number; list: string[] }
function f(c: Cfg): void {
  c.list.push("y");
  const out = { ...c, a: 2 };
  console.log(JSON.stringify(out), Object.keys(out).join(","));
}
f({ list: [] });
const raw: any = JSON.parse('{"list":["x"],"z":1}');
f(raw);
console.log(raw.list.length);` },
  { id: "S125-K-15 a rest element of a pattern over a parameter on the dynamic arm, spread into a returned literal, keeps its copy, refused by name", entry: "main.ts",
    refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: boolean \| undefined; n: string\[\]; z: number \| undefined \}': it would be a COPY/,
    src: `function canon(driver: { a?: boolean; b?: boolean; n: string[]; z?: number }) {
  driver.n.push("y");
  const { b, ...rest } = driver;
  return { ...rest, a: rest.a ?? b };
}
const raw: any = JSON.parse('{"z":4,"b":true,"n":["x"],"a":false}');
const out = canon(raw);
console.log(JSON.stringify(out), Object.keys(out).join(","), raw.n.length);
console.log(JSON.stringify(canon({ n: [], z: 1 })));` },  // A class instance never takes the arm (its view's members are found
  // before the arm rounds): each form keeps main's refusal by name.
  { id: "S125-K-16 a deferred `let` assigned a class instance with methods on one path keeps its typed slot, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction run(f: boolean): void {
  let c: Cfg;
  const m = new M();
  if (f) c = parseCfg(JSON.parse('{"a":[1],"name":"n"}')); else c = m;
  c.a.push(2);
  console.log(m.a.length, c.a.length);
}
run(false); run(true);` },
  { id: "S125-K-17 a deferred `let` initialized with a class instance with a getter keeps its typed slot, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC2002 record shapes must match exactly or width-coerce: expected '\{ a: number\[\]; name: string \}', got 'G'/,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction run(f: boolean): void {
  const g = new G();
  let c: Cfg = g;
  if (f) c = parseCfg(JSON.parse('{"a":[1],"name":"n"}'));
  c.a.push(2);
  console.log(g.a.length, c.name);
}
run(false); run(true);` },
  { id: "S125-K-18 a `?:` with a class instance arm keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction run(f: boolean): void {
  const c: Cfg = f ? parseCfg(JSON.parse('{"a":[1],"name":"n"}')) : new M();
  c.a.push(2);
  console.log(c.a.length);
}
run(false); run(true);` },
  { id: "S125-K-19 a defaulted parameter whose default is a class instance keeps its typed slot, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC2002 record shapes must match exactly or width-coerce: expected '\{ a: number\[\]; name: string \}', got 'G'/,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction use(c: Cfg = new G()): void {
  c.a.push(2);
  console.log(c.a.length, c.name);
}
use(parseCfg(JSON.parse('{"a":[1],"name":"n"}')));
use();` },
]);
