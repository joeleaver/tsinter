/* U8a, loop plumbing on `any` (docs/design/u8-dynamic-speed.md §8): a
 * numeric key reads an island array without the S015 helper's string
 * round trip (lower-exprs.ts islandElementRead), and a relational or
 * arithmetic op with a typed-number or `length` operand runs in f64 with
 * an inline NUM test (loop-num.ts). The A rows are the fast path: their
 * loops allocate no box per round (or exactly the result boxes an `any`
 * result needs). The B rows are the fallbacks, each Node-exact: reads past the end
 * and appends (the wasm lane cannot make holes: SC1090),
 * an index getter on a plain object, non-index numeric keys, negative,
 * fractional, NaN and huge indices, typed arrays and array views, strings,
 * operands that are not numbers (strings, null, undefined, booleans,
 * objects with valueOf, BigInt), `length` on receivers that are not
 * arrays, evaluation order, and nullish receivers. Rows run on both lanes
 * (u8-rows.ts). */
import { defineU8Rows } from "./u8-rows.js";

const RECS = `const parts: string[] = [];
for (let i = 0; i < 6; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + '}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");`;

defineU8Rows("U8a fast path", [
  { id: "U8a-A01 `for (i < xs.length) xs[i]` over parsed records with typed leaves allocates no box per round", perRound: 0,
    src: `${RECS}
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b; s += a * 10 + b; }
console.log(s);` },
  { id: "U8a-A02 a hoisted typed bound (`const n: number = xs.length`) and `xs[i]` compared with null allocate no box per round", perRound: 0,
    src: `${RECS}
const n: number = xs.length;
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < n; i++) { const p = xs[i]; if (p === null) s--; else s++; }
console.log(n, s);` },
  { id: "U8a-A03 relational ops between a typed number and an element, in both operand orders, allocate no box per round", perRound: 0,
    src: `const ys: any = [3, -1, 2.5, 0, -0, NaN, Infinity, 7];
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  let c = 0;
  for (let i = 0; i < ys.length; i++) {
    if (ys[i] > 2) c++;
    if (ys[i] <= 0) c += 10;
    if (2 < ys[i]) c += 100;
    if (0 >= ys[i]) c += 1000;
  }
  out.push(String(c));
}
console.log(out.join(","));` },
  { id: "U8a-A04 arithmetic between a typed number and an element allocates only its result box: 4 per element, 32 per round", perRound: 32,
    src: `const ys: any = [3, -1, 2.5, 0, -0, NaN, Infinity, 7];
const out: number[] = [];
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < ys.length; i++) {
    const a: number = ys[i] * 2;
    const b: number = 1 - ys[i];
    const c: number = ys[i] / 0.5;
    const d: number = ys[i] % 2;
    out.push(a, b, c, d, Object.is(d, -0) ? 1 : 0);
  }
}
console.log(out.join(" "));` },
  { id: "U8a-A05 `i <= xs.length - 1` boxes only the `any` result of the subtraction: one per test, 7 per round over 6 records", perRound: 7,
    src: `${RECS}
let s = 0;
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i <= xs.length - 1; i++) s += i;
}
console.log(s);` },
]);

defineU8Rows("U8a fallbacks", [
  { id: "U8a-B01 reads past the end read undefined, and writes in range and at the end (an append) land as in Node", perRound: "some",
    src: `const xs: any = JSON.parse("[1, 2, 3]");
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < xs.length + 2; i++) out.push(String(xs[i]));
  for (let i = 0; i < xs.length; i++) xs[i] = xs[i] * 2;
  xs[xs.length] = r;
}
console.log(out.join(","), xs.length, JSON.stringify(xs));` },
  { id: "U8a-B02 an index getter on a plain object runs on every read, and its own `length` bounds the loop", perRound: "some",
    src: `let calls = 0;
const o: any = { length: 3 };
o[1] = "one";
Object.defineProperty(o, "0", { get() { calls++; return "g" + calls; } });
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < o.length; i++) out.push(String(o[i]));
console.log(out.join(","), calls);` },
  { id: "U8a-B03 non-index numeric keys (fractions, negatives, NaN, Infinity, -0, 1e21, 2^32-1, 2^32) read their ToString key on an object, and miss on an array", perRound: "some",
    src: `const o: any = { "1.5": "frac", "-1": "neg", "NaN": "nan", "Infinity": "inf", "0": "zero", "1e+21": "big", "4294967295": "max", "4294967296": "over" };
const arr: any = ["a0", "a1"];
const ks: number[] = [1.5, -1, NaN, Infinity, -0, 1e21, 4294967295, 4294967296, 0, 1, 2, -1.5, 1e300];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < ks.length; i++) { const k = ks[i]!; out.push(String(o[k]) + "/" + String(arr[k])); }
console.log(out.join(" "), arr.length, Object.keys(arr).join("|"));` },
  { id: "U8a-B04 typed arrays held as any: length, in-range and out-of-range, fractional and negative indices", perRound: "some",
    src: `const t: any = new Uint8Array([1, 2, 250]);
const f: any = new Int32Array([5, -7, 2147483647]);
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < t.length; i++) out.push(String(t[i] + 1));
  for (let i = 0; i < f.length; i++) out.push(String(f[i] * 2));
}
const ks: number[] = [-1, 1.5, 3, 7, NaN];
for (const k of ks) out.push(String(t[k]), String(f[k]));
console.log(out.join(","), t.length < 4, f.length >= 3);` },
  { id: "U8a-B05 an array view (a typed number[] held as any) keeps today's generic path: reads, `length`, and writes from either side", perRound: "some",
    src: `const a: number[] = [1, 2, 3];
const v: any = a;
const out: number[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < v.length; i++) { const x: number = v[i]; out.push(x); }
a.push(4);
v[0] = 9;
for (let i = 0; i < v.length; i++) v[i] = v[i] * 10 + i;
let n = 0;
for (let i = 0; i < v.length; i++) n += v[i] > 2 ? 1 : 0;
console.log(out.join(","), a.join(","), n, v.length - 1);` },
  { id: "U8a-B06 a string held as any: `length` and indexed code units, a surrogate pair included", perRound: "some",
    src: `const s: any = "h\\u00e9l\\ud83d\\ude00!";
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < s.length; i++) out.push(s[i].charCodeAt(0).toString(16));
console.log(out.join(" "), s.length, s[-1], s[1.5], s[99]);` },
  { id: "U8a-B07 operands that are not numbers (strings, null, undefined, booleans, an empty array, objects with valueOf and toString) compare and compute as in Node", perRound: "some",
    src: `const log: string[] = [];
const vals: any[] = ["10", "abc", "", " 3 ", null, undefined, true, false, [], [5], { valueOf() { log.push("v"); return 4; } }, { toString() { log.push("t"); return "2"; } }];
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let j = 0; j < vals.length; j++) {
    const v = vals[j];
    const i = 3;
    out.push(String(i < v) + String(v < i) + String(i >= v) + String(v >= i) + ":" + String(i + v) + "," + String(v - i) + "," + String(i * v) + "," + String(v / i) + "," + String(i % v));
  }
}
console.log(out.join(" "));
console.log(log.join(""));` },
  { id: "U8a-B08 BigInt operands: a relational op with a typed number answers, arithmetic mixing throws Node's TypeError", perRound: "some",
    src: `const vals: any[] = [2n, 5n, -1n];
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let j = 0; j < vals.length; j++) {
    const v = vals[j];
    out.push(String(3 < v) + String(v <= 2));
    try { out.push(String(v + 1)); } catch (e) { out.push(String(e instanceof TypeError) + ": " + (e as Error).message); }
  }
}
console.log(out.join(" | "));` },
  { id: "U8a-B09 `length` on receivers that are not arrays: a getter (called each test), an absent length, a function, a string, and a nullish receiver's TypeError", perRound: "some",
    src: `let calls = 0;
const g: any = { get length() { calls++; return 2; } };
const none: any = { a: 1 };
const fn: any = function (a: number, b: number) { return a + b; };
const str: any = "abcd";
let s = 0;
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < g.length; i++) s++;
  for (let i = 0; i < none.length; i++) s += 100;
  for (let i = 0; i < fn.length; i++) s += 10;
  for (let i = 0; i < str.length; i++) s += 1000;
}
console.log(s, calls, 1 < none.length, none.length - 1);
const z: any = null;
try { for (let i = 0; i < z.length; i++) s++; } catch (e) { console.log((e as Error).message); }
const u: any = undefined;
try { console.log(u.length + 1); } catch (e) { console.log((e as Error).message); }` },
  { id: "U8a-B10 operands evaluate left to right, then convert left to right (valueOf), as in Node", perRound: "some",
    src: `const log: string[] = [];
function L(n: number): number { log.push("L" + n); return n; }
const o: any = { valueOf() { log.push("v"); return 1; } };
const xs: any = [o, 5];
for (let r = 0; r < __R__; r++) {
  const a = L(0) < (log.push("R"), xs[0]);
  const b = (log.push("R2"), xs[0]) < L(2);
  const c = L(3) - xs.length;
  const d = (log.push("R3"), xs[0]) + L(4);
  log.push(String(a) + String(b) + c + d);
}
console.log(log.join(" "));` },
  { id: "U8a-B11 a nullish receiver at a warm numeric index site throws Node's TypeError", perRound: "some",
    src: `const recvs: any[] = [[7, 8], null, undefined, JSON.parse('{"0":"o"}')];
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let j = 0; j < recvs.length; j++) {
    const x = recvs[j];
    try { out.push(String(x[0])); } catch (e) { out.push((e as Error).message); }
  }
}
console.log(out.join(" | "));` },
  { id: "U8a-B12 negative, -0, fractional, NaN and huge indices on an island array take the generic read", perRound: "some",
    src: `const arr: any = [10, 20, 30];
const ks: number[] = [-1, -0, 0.5, NaN, 1e300, 2147483648, 4294967294, 2, 3];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < ks.length; i++) out.push(String(arr[ks[i]!]));
console.log(out.join(","));` },
]);
