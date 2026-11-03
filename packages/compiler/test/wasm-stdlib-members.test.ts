/* Step 2B (round-3 survey, `stdlib:js`): the standard-library members
 * lowered in lower-stdlib-members.ts and their neighbours — string
 * startsWith/endsWith with a position, split with a limit, lastIndexOf with
 * a fromIndex, substr, concat, codePointAt, String.fromCodePoint; array
 * unshift, reverse, splice with items, fill, join(), new Array(n);
 * n.toString(radix); Number.parseInt/parseFloat; Number() of unknown values
 * and primitive unions; new Set(iterable) and Array.from(iterable[, f]);
 * Object.hasOwn over index signatures; for-of over tuple literals (Object.freeze
 * keeps its fence: #57). Where a member meets a width copy
 * (S125) the copy is exact or refused by name. An exact row equals Node (spawned at
 * test time) on the wasm and wasm-native lanes; a `fence` row is one where
 * Node answers and this tier stops by name at run time (SEMANTICS.md S119);
 * a `refuses` row is a form that stays a named compile refusal. The
 * helpers are wasm-undef-observers.test.ts's. GENERATED from probe bundles
 * checked against Node; edit the rows, not the expectations. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-stdlib-members-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function wasmRun(id: string, file: string, trap: boolean): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await (trap ? runWasmToTrap : runWasm)(res.binaryPath);
  return { stdout: String(r.stdout), stderr: String(r.stderr).split(file).join("<ROW>"), exitCode: trap ? 1 : r.exitCode };
}

async function nativeRun(id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  try {
    const p = run(res.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr.split(file).join("<ROW>"), exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr.split(file).join("<ROW>"), exitCode: err.code };
  }
}

interface Row {
  id: string;
  src: string;
  /** absent: the row equals Node */
  fence?: { stdout: string; stderr: RegExp };
}

const HOLE_PRINT_FENCE = /^tsinter: unsupported: printing \(util\.inspect\) over an array that may hold holes .*SEMANTICS\.md S119\) \[SC1090( at <ROW>:\d+)?\]\n$/;

const ROWS: Row[] = [
  { id: "s1-starts", src: "const s = \"hello world\";\nconsole.log(s.startsWith(\"world\", 6), s.startsWith(\"hello\", 1), s.startsWith(\"hello\", -5), s.startsWith(\"\", 99), s.startsWith(\"d\", 10.7), s.startsWith(\"h\", NaN));\nconsole.log(s.endsWith(\"hello\", 5), s.endsWith(\"world\", 99), s.endsWith(\"o\", 4.9), s.endsWith(\"\", -1), s.endsWith(\"h\", NaN), s.endsWith(\"d\", Infinity));\nconst opt: number | undefined = Math.random() > 2 ? 1 : undefined;\nconsole.log(s.startsWith(\"h\", opt), s.endsWith(\"d\", opt), s.startsWith(\"h\", undefined), s.endsWith(\"d\", undefined));\nconst xs: number[] = [];\nconsole.log(s.startsWith(\"h\", xs[3]), s.endsWith(\"d\", xs[3]));\nlet n = 0; const f = () => { n++; return n; };\nconsole.log(\"abc\".startsWith(String(f()), f()), n);" },
  { id: "s2-split", src: "const s = \"a,b,c,d\";\nconsole.log(s.split(\",\", 2), s.split(\",\", 0), s.split(\",\", -1).length, s.split(\",\", 2.9), s.split(\",\", NaN), s.split(\",\", Infinity), s.split(\",\", 4294967297));\nconsole.log(s.split(\"\", 3), \"\".split(\",\", 1), \"\".split(\"\", 5), s.split(\",\", undefined));\nconst xs: number[] = [];\nconsole.log(s.split(\",\", xs[1]));" },
  { id: "s3-lastindexof", src: "const s = \"abcabcabc\";\nconsole.log(s.lastIndexOf(\"b\", 3), s.lastIndexOf(\"b\", 4), s.lastIndexOf(\"b\", 0), s.lastIndexOf(\"a\", 0), s.lastIndexOf(\"c\", -5), s.lastIndexOf(\"abc\", 100), s.lastIndexOf(\"x\", 3));\nconsole.log(s.lastIndexOf(\"\", 4), s.lastIndexOf(\"\", 100), s.lastIndexOf(\"\", -1), s.lastIndexOf(\"b\", NaN), s.lastIndexOf(\"b\", 4.9), s.lastIndexOf(\"bc\", 1), s.lastIndexOf(\"bca\", 1), s.lastIndexOf(\"b\", undefined));\nconst xs: number[] = [];\nconsole.log(s.lastIndexOf(\"c\", xs[0]));" },
  { id: "s4-substr", src: "const s = \"abcdef\";\nconsole.log(s.substr(2, 3), s.substr(-2), s.substr(-10, 2), s.substr(1), s.substr(NaN, 2), s.substr(1, NaN), s.substr(1, -1), s.substr(10), s.substr(2, Infinity), s.substr(-Infinity, 1), s.substr(1.7, 2.2));\nconst xs: number[] = [];\nconsole.log(s.substr(xs[0], xs[1]), s.substr(2, undefined));" },
  { id: "s5-concat", src: "const s = \"a\";\nconst t: string[] = [];\nconsole.log(s.concat(\"b\", \"c\"), s.concat(), \"\".concat(\"x\"), s.concat(t[0]));" },
  { id: "s6-codepoint", src: "const s = \"a😀b\\ud800x\\udc00\";\nconsole.log(s.codePointAt(0), s.codePointAt(1), s.codePointAt(2), s.codePointAt(3), s.codePointAt(4), s.codePointAt(5), s.codePointAt(6), s.codePointAt(7), s.codePointAt(-1), s.codePointAt(NaN), s.codePointAt(1.9));\nconst cps: number[] = []; for (const ch of \"h😀é\") cps.push(ch.codePointAt(0)!);\nconsole.log(cps, \"😀\".codePointAt(0)?.toString());\nconst xs: number[] = []; console.log(\"z\".codePointAt(xs[0]));" },
  { id: "s7-fromcodepoint", src: "console.log(String.fromCodePoint(128512, 97, 0x10FFFF).length, String.fromCodePoint(), String.fromCodePoint(65, 66), String.fromCodePoint(-0));\nconst cps = [104, 105, 128075];\nconsole.log(String.fromCodePoint(...cps));\nfor (const v of [-1, 1.5, NaN, Infinity, 0x110000, -Infinity]) {\n  try { String.fromCodePoint(v); } catch (e) { console.log((e as Error).name, (e as Error).message, e instanceof RangeError); }\n}" },
  { id: "s8-fromcodepoint-uncaught", src: "console.log(String.fromCodePoint(65));" },
  { id: "a1-unshift", src: "const xs: string[] = [\"b\"];\nconsole.log(xs.unshift(\"a\"), xs.unshift(\"x\", \"y\"), xs, xs.unshift(), xs.length);\nconst ns = [3, 4]; ns.unshift(...ns); console.log(ns);\nconst e: number[] = []; console.log(e.unshift(1), e);\nconst u: (string | number)[] = [1]; u.unshift(\"s\", 2); console.log(u);\nclass P { constructor(public n: number) {} }\nconst ps = [new P(1)]; ps.unshift(new P(0)); console.log(ps.map((p) => p.n));" },
  { id: "a2-reverse", src: "const xs = [\"a\", \"b\", \"c\"]; const r = xs.reverse(); console.log(r, xs, r === xs);\nconst ns = [1, 2, 3, 4]; ns.reverse(); console.log(ns);\nconst e: number[] = []; console.log(e.reverse(), [7].reverse());\nconst os = [{ a: 1 }, { a: 2 }]; console.log(os.reverse());" },
  { id: "a3-splice", src: "const xs = [1, 2, 3, 4, 5];\nconsole.log(xs.splice(1, 2, 9, 8, 7), xs);\nconsole.log(xs.splice(-2, 1, 0), xs);\nconsole.log(xs.splice(100, 5, 6), xs);\nconsole.log(xs.splice(-100, 0, -1, -2), xs);\nconsole.log(xs.splice(2, NaN, 42), xs);\nconsole.log(xs.splice(1, Infinity, 5), xs);\nconst ss = [\"a\", \"b\"]; console.log(ss.splice(1, 0, ...ss), ss);" },
  { id: "a4-arraymisc", src: "const xs = [1, 2, 3];\nxs.reverse().unshift(0); console.log(xs);\nconst m = new Map<string, number[]>([[\"k\", [1]]]);\nm.get(\"k\")!.unshift(5); console.log(m.get(\"k\"));" },
  { id: "n1-parse", src: "console.log(Number.parseInt(\"42px\"), Number.parseInt(\"ff\", 16), Number.parseInt(\"0x1f\"), Number.parseInt(\"  -7.9\"), Number.parseFloat(\"3.5e2x\"), Number.parseFloat(\"x\"));\nconst xs: string[] = []; console.log(Number.parseInt(xs[0]), Number.parseFloat(xs[0]));" },
  { id: "r1-radix", src: "const vals = [0, -0, 1, -1, 255, -255, 3.5, -3.5, 0.1, 1 / 3, 2 ** 53, 2 ** 53 + 2, 1e21, 1.7976931348623157e308, 5e-324, 2.2250738585072014e-308, 123.456, -0.000001, NaN, Infinity, -Infinity, 0.5, 4294967295, 1e-7, 35.99999];\nconst radixes = [2, 3, 7, 8, 10, 16, 32, 36, 16.9];\nfor (const v of vals) console.log(radixes.map((r) => v.toString(r)).join(\" \"));" },
  { id: "r2-radix-random", src: "let seed = 12345;\nfunction rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }\nconst out: string[] = [];\nfor (let i = 0; i < 3000; i++) {\n  const mag = Math.floor(rnd() * 80) - 40;\n  const v = (rnd() - 0.5) * Math.pow(2, mag);\n  const r = 2 + Math.floor(rnd() * 35);\n  out.push(v.toString(r));\n}\nlet h = 0; for (const s of out) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000000007;\nconsole.log(out.length, h, out.slice(0, 20).join(\" \"));" },
  { id: "r3-radix-errors", src: "for (const r of [1, 37, 0, -1, NaN, Infinity, 1.9]) {\n  try { console.log((5).toString(r)); } catch (e) { console.log((e as Error).name, (e as Error).message, e instanceof RangeError); }\n}\nconst opt: number | undefined = Math.random() > 2 ? 16 : undefined;\nconsole.log((255).toString(opt), (255).toString(undefined), (255)[\"toString\"](2));\nconst xs: number[] = []; console.log((7).toString(xs[0]));\nconst n = 0xdeadbeef; console.log(n.toString(16).padStart(10, \"0\"), (-n).toString(36));" },
  { id: "r4-radix-receiver", src: "const ns: number[] = [];\ntry { console.log(ns[0].toString(16)); } catch (e) { console.log((e as Error).message); }\nlet k = 0; const f = () => { k++; return 16; };\nconsole.log((k + 10).toString(f()), k);" },
  { id: "i1-set-from", src: "const a = new Set([1, 2]); const b = new Set(a); b.add(3); console.log(a.size, b.size, [...b]);\nconst w = new Set(\"abca\"); console.log(w.size, [...w]);\nconst KINDS = [\"x\", \"y\", \"x\"] as const; const k = new Set<string>(KINDS); console.log([...k]);\nconst m = new Map([[\"a\", 1], [\"b\", 2]]); const v = new Set(m.keys()); console.log([...v]);\nconst vv = new Set(m.values()); console.log([...vv]);\nconst u8 = new Uint8Array([3, 1, 3]); console.log([...new Set(u8)]);\nconst lits: (\"p\" | \"q\")[] = [\"p\", \"q\", \"p\"]; const s2 = new Set<string>(lits); console.log([...s2]);\nconst ys: number[][] = []; console.log(new Set(ys[0]).size);" },
  { id: "i2-array-from", src: "const s = new Set([1, 2, 2]); console.log(Array.from(s));\nconst arr = [1, 2]; const c = Array.from(arr); c.push(3); console.log(arr, c);\nconsole.log(Array.from(\"a😀b\"), Array.from(new Set([\"q\"])));\nconst m = new Map([[\"a\", 1], [\"b\", 2]]); console.log(Array.from(m.keys()), Array.from(m.values()));\nconst t = [\"x\", \"y\"] as const; console.log(Array.from(t));\nconsole.log(Array.from(new Uint8Array([1, 2])));" },
  { id: "i3-array-from-map", src: "console.log(Array.from(\"abc\", (ch) => ch.toUpperCase()), Array.from(\"abc\", (ch, i) => ch + i));\nconst arr = [1, 2, 3]; console.log(Array.from(arr, (x) => x * 2), Array.from(arr, (x, i) => x + i));\nconsole.log(Array.from(new Set([1, 2, 2]), (x) => x * 10));\nconst live = [1, 2]; console.log(Array.from(live, (x) => { if (live.length < 4) live.push(x + 10); return x; }), live);\nconsole.log(Array.from([] as number[], (x) => x));" },
  { id: "i4-array-from-undef", src: "const xs: number[][] = [];\ntry { console.log(Array.from(xs[0])); } catch (e) { console.log((e as Error).message); }\nconst ss: string[] = [];\ntry { console.log(Array.from(ss[0])); } catch (e) { console.log((e as Error).message); }" },
  { id: "o1-hasown-index", src: "const o: Record<string, number> = { a: 1 };\no[\"b\"] = 2;\nconsole.log(Object.hasOwn(o, \"a\"), Object.hasOwn(o, \"b\"), Object.hasOwn(o, \"c\"), Object.hasOwn(o, \"toString\"), Object.hasOwn(o, \"constructor\"));\ndelete o[\"a\"]; console.log(Object.hasOwn(o, \"a\"));\ninterface H { name: string; opt?: number; [k: string]: string | number | undefined }\nconst h: H = { name: \"x\" }; h[\"extra\"] = 5;\nconsole.log(Object.hasOwn(h, \"name\"), Object.hasOwn(h, \"opt\"), Object.hasOwn(h, \"extra\"), Object.hasOwn(h, \"zz\"));\nconst n: Record<string, boolean> = { \"1\": true }; console.log(Object.hasOwn(n, 1), Object.hasOwn(n, 2));\nconst ks: string[] = []; console.log(Object.hasOwn(o, ks[0]));\no[\"undefined\"] = 3; console.log(Object.hasOwn(o, ks[0]));\nconst rs: Record<string, number>[] = [];\ntry { Object.hasOwn(rs[0], \"a\"); } catch (e) { console.log((e as Error).message); }\nconst r2 = { x: 1, y: \"s\" }; console.log(Object.hasOwn(r2, \"x\"), Object.hasOwn(r2, ks[0]));" },
  { id: "t1-forof-tuple", src: "for (const sig of [\"SIGINT\", \"SIGTERM\"] as const) console.log(sig);\nlet calls = 0;\nfunction pair(): [string, number] { calls++; return [\"a\", calls]; }\nfor (const x of pair()) console.log(x);\nconsole.log(calls);\nfor (const [k, v] of [[\"x\", 1], [\"y\", 2]] as const) console.log(k, v);\nfor (const n of [1, 2, 3] as const) { if (n === 2) continue; console.log(n); }" },
  { id: "na1-new-array", src: "const a = new Array<number>(3); console.log(a.length);\nfor (let i = 0; i < a.length; i++) a[i] = i * i;\nconsole.log(a, a.join(\"-\"));\nconst s: string[] = new Array(2); s[0] = \"x\"; s[1] = \"y\"; console.log(s);\nfor (const n of [-1, 1.5, NaN, 4294967296]) {\n  try { new Array<number>(n); } catch (e) { console.log((e as Error).name, (e as Error).message); }\n}\nconst z = new Array<boolean>(0); console.log(z, z.length);" },
  { id: "na2-fill", src: "console.log(new Array<number>(4).fill(7), new Array<string>(3).fill(\"q\"));\nconst xs = [1, 2, 3, 4, 5];\nconsole.log(xs.fill(0, 1, 3).join()); console.log(xs.fill(9, -2).join()); console.log(xs.fill(8, NaN, 1).join()); console.log(xs.fill(6, 10).join()); console.log(xs.fill(5, -10, -4).join(), [1, 2].fill(3, undefined, undefined));\nconst r = xs.fill(1); console.log(r === xs);\nconst os = new Array<{ k: number }>(2).fill({ k: 1 }); os[0].k = 5; console.log(os);\nconst u: number[] = []; console.log(xs.fill(4, u[0], u[1]));" },
  { id: "nb1-number-union", src: "const vals: (string | undefined)[] = [\"12\", \" 3.5 \", \"\", \"0x1f\", \"1e3\", \"abc\", undefined, \"-0\", \"Infinity\", \"  \", \"0b101\", \"1_0\"];\nconsole.log(vals.map((v) => Number(v)));\nconst mix: (number | string | boolean | null)[] = [1, \"2\", true, false, null, \"x\"];\nconsole.log(mix.map((v) => Number(v)));\nfunction f(v: unknown) { return Number(v); }\nconsole.log(f(\"7\"), f(undefined), f(null), f(true), f([5]), f({}), f(\"1,2\"), f([]), f([\"3\"]));\nconst j: { a: unknown; b: unknown } = { a: '4', b: [1, 2] };\nconsole.log(Number(j.a), Number(j.b));\nconst o: { n?: number | string } = {}; console.log(Number(o.n));" },
  { id: "w7-field", src: "const o = { list: [\"a\"], text: \"hello\" };\no.list.unshift(\"z\"); console.log(o.list, o.text.startsWith(\"l\", 2), o.text.codePointAt(1), o.text.substr(1, 2));" },
  { id: "w8-optional", src: "const m: { s?: string; a?: number[] } = { s: \"abc\" };\nconsole.log(m.s?.startsWith(\"b\", 1), m.s?.codePointAt(0), m.a?.reverse(), m.s?.split(\"\", 2));" },
  { id: "w11-union-recv", src: "const v: string | number[] = Math.random() > 2 ? \"ab\" : [1, 2];\nif (typeof v !== \"string\") console.log(v.reverse()); else console.log(v.concat(\"x\"));" },
  { id: "w13-holes-unshift", src: "const a: number[] = []; a[2] = 5; a.unshift(1); console.log(a.length, a[0], a[3]);" },
  { id: "w14-readonly-arr", src: "const ro: readonly string[] = [\"a\", \"b\"]; console.log(Array.from(ro), new Set(ro).size, ro.concat([\"c\"]));" },
  { id: "x5-width-readonly", src: "class P { constructor(public n: number) {} }\nconst ps = [new P(1), new P(2)];\nconst rs: { n: number }[] = Array.from(ps);\nconst qs: { n: number }[] = [];\nqs.unshift(new P(4));\nconsole.log(rs.map((r) => r.n), qs.reverse().map((q) => q.n));" },
  { id: "x7-same-shape-shares", src: "const o = { n: 1 };\nconst rs: { n: number }[] = [];\nrs.unshift(o); rs.splice(1, 0, o); rs.fill(o, 1);\no.n = 6;\nconsole.log(rs.map((r) => r.n), rs[0] === rs[1], Array.from(rs)[0] === o, rs.reverse()[0] === o);" },
  { id: "rv1-concat-undef-recv", src: "function f(s?: string) { return s!.concat(\"!\"); }\ntry { console.log(f()); } catch (e) { console.log(String(e)); }\nconst a = new Array<string>(1);\ntry { console.log(a[0]!.concat(\"x\")); } catch (e) { console.log(String(e)); }\ntry { console.log(a[0]!.codePointAt(0)); } catch (e) { console.log(String(e)); }\ntry { console.log(a[0]!.startsWith(\"u\", 1), a[0]!.split(\"n\", 1)); } catch (e) { console.log(String(e)); }\nconsole.log(f(\"ok\"));" },
  { id: "rv2-array-undef-recv", src: "const a = new Array<number[]>(1);\nconst x = a[0]!;\nfor (const f of [() => x.unshift(1), () => x.reverse(), () => x.splice(0, 0, 1), () => x.fill(0)]) {\n  try { console.log(f()); } catch (e) { console.log(String(e)); }\n}" },
  { id: "rv3-split-undef-sep", src: "function f(sep?: string, lim?: number) { return \"a,undefined,b\".split(sep!, lim); }\nconsole.log(f(\",\"), f(), f(undefined, 0), f(undefined, 1), f(\",\", 2));\nconst a = new Array<string>(1);\nconsole.log(\"aundefinedb\".split(a[0]!, 5), \"aundefinedb\".split(a[0]!));" },
  { id: "rv4-fromcodepoint-undef", src: "function f(c?: number) { return String.fromCodePoint(c!); }\ntry { console.log(f()); } catch (e) { console.log(String(e)); }\nconst a = new Array<number>(1);\ntry { console.log(String.fromCodePoint(65, a[0]!)); } catch (e) { console.log(String(e)); }\nconsole.log(f(66));" },
  { id: "rv5-iterable-undef-sources", src: "const ss = new Array<string>(1);\nconsole.log(new Set(ss[0]!).size);\ntry { console.log(Array.from(ss[0]!)); } catch (e) { console.log(String(e)); }\nconst ns = new Array<number[]>(1);\nconsole.log(new Set(ns[0]!).size);\ntry { console.log(Array.from(ns[0]!, (v) => v)); } catch (e) { console.log(String(e)); }" },
  { id: "rv6-tuple-undef-sources", src: "const a = new Array<[number, number]>(1);\ntry { console.log(Array.from(a[0]!)); } catch (e) { console.log(String(e)); }\nconsole.log(new Set(a[0]!).size);\ntry { for (const v of a[0]!) console.log(v); } catch (e) { console.log(String(e)); }\nfunction f(t?: [number, string]) { return Array.from(t!); }\ntry { console.log(f()); } catch (e) { console.log(String(e)); }\nconsole.log(f([1, \"x\"]));" },
  {
    id: "new-array-above-limit-fence",
    src: "console.log(new Array<number>(16777216).length);\ntry { new Array<number>(4294967296); } catch (e) { console.log(String(e)); }\nconsole.log(\"before\");\nconst big = new Array<number>(4294967295);\nconsole.log(big.length);",
    fence: { stdout: "16777216\nRangeError: Invalid array length\nbefore\n", stderr: /^tsinter: unsupported: new Array\(n\) with n above 16777216 \(this tier allocates every hole, where Node keeps the array sparse — SEMANTICS\.md S119\) \[SC1090( at <ROW>:\d+)?[^\]]*\]\n$/ },
  },
  {
    id: "new-array-holes-print-fence",
    src: "const a = new Array<number>(3); a[0] = 1;\nconsole.log(a.length);\nconsole.log(a);",
    fence: { stdout: "3\n", stderr: HOLE_PRINT_FENCE },
  },
];

/** Forms that stay compile refusals, each by name. */
const REFUSALS: { id: string; src: string; message: RegExp }[] = [
  { id: "weakmap", src: "class K {}\nconst wm = new WeakMap<K, number>();\nwm.set(new K(), 1);", message: /'new WeakMap' is part of the standard library types but has no scriptc lowering yet/ },
  { id: "array-from-set-mapper", src: "const s = new Set([1, 2]);\nconsole.log(Array.from(s, (x) => x * 2));", message: /'Array\.from with this argument shape'/ },
  { id: "array-from-generator", src: "function* g() { yield 1; }\nconsole.log(Array.from(g()));", message: /'Array\.from with this argument shape'/ },
  { id: "concat-spread", src: "const parts = [\"x\"];\nconsole.log(\"\".concat(...parts));", message: /'string\.concat'/ },
  { id: "define-property", src: "const o: Record<string, number> = {};\nObject.defineProperty(o, \"a\", { value: 1 });\nconsole.log(o);", message: /'Object\.defineProperty'/ },
  { id: "freeze-builtin-result", src: "const g = Object.freeze(Object.fromEntries([[\"a\", 1]]));\nconsole.log(g);", message: /'Object\.freeze of a possibly-aliased value'/ },
  { id: "freeze-aliased", src: "const xs = [1];\nconst f = Object.freeze(xs);\nconsole.log(f);", message: /'Object\.freeze of a possibly-aliased value'/ },
  { id: "codepointat-as-value", src: "const s = \"abc\";\nconst f = s.codePointAt;\nconsole.log(typeof f);", message: /'string\.codePointAt'/ },
  // GH #109 (S125): a width copy the new members make, observed by a write.
  { id: "x1-width-unshift-write", src: "class P { constructor(public n: number) {} }\nconst rs: { n: number }[] = [];\nconst p = new P(1);\nrs.unshift(p);\np.n = 9;\nconsole.log(rs[0]!.n);", message: /would hold a COPY where JavaScript shares the object.*SEMANTICS\.md S125/ },
  { id: "x2-width-from-write", src: "class P { constructor(public n: number) {} }\nconst ps = [new P(1), new P(2)];\nconst rs: { n: number }[] = Array.from(ps);\nrs[0]!.n = 5;\nconsole.log(ps[0]!.n);", message: /would hold a COPY where JavaScript shares the object.*SEMANTICS\.md S125/ },
  { id: "x3-width-fill-write", src: "class P { constructor(public n: number) {} }\nconst p = new P(1);\nconst rs = new Array<{ n: number }>(2).fill(p);\np.n = 7;\nconsole.log(rs[1]!.n);", message: /would hold a COPY where JavaScript shares the object.*SEMANTICS\.md S125/ },
  { id: "x4-width-splice-write", src: "class P { constructor(public n: number) {} }\nconst rs: { n: number }[] = [{ n: 0 }];\nconst p = new P(3);\nrs.splice(0, 0, p);\nrs[0]!.n = 8;\nconsole.log(p.n);", message: /would hold a COPY where JavaScript shares the object.*SEMANTICS\.md S125/ },
  { id: "x6-wider-record-unshift", src: "const wide = { n: 1, extra: \"x\" };\nconst rs: { n: number }[] = [];\nrs.unshift(wide);\nwide.n = 2;\nconsole.log(rs[0]!.n);", message: /would hold a COPY where JavaScript shares the object.*SEMANTICS\.md S125/ },
];

function expectRow(row: Row, got: Out, node: Out, trapText: string): void {
  if (row.fence === undefined) {
    expect(node.exitCode).toBe(0);
    expect(got).toEqual(node);
    return;
  }
  expect(node.exitCode).toBe(0);
  expect(got.stdout).toBe(row.fence.stdout);
  expect(got.exitCode).toBe(1);
  const stderr = trapText !== "" && got.stderr.endsWith(trapText) ? got.stderr.slice(0, -trapText.length) : got.stderr;
  expect(stderr).toMatch(row.fence.stderr);
}

describe("Step 2B: stdlib members (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, row.src + "\n");
    expectRow(row, await wasmRun(id, file, row.fence !== undefined), nodeRun(file), "");
  });
});

describe("Step 2B: stdlib members (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    expectRow(row, await nativeRun(id, file), nodeRun(file), "RuntimeError: unreachable\n");
  }, 600_000);
});

describe("Step 2B: forms that stay refused by name", () => {
  test.for(REFUSALS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `refuse-${id}.ts`);
    writeFileSync(file, row.src + "\n");
    const res = await compile(file, { outPath: join(scratch, `refuse-${id}.wasm`), outDir: scratch, backend: "wasm" });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(row.message);
  });
});
