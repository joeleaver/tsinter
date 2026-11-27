/* U8b, shapes and the single-shape read cache
 * (docs/design/u8-dynamic-speed.md §3, §4, §8): every plain dynamic object
 * carries a shape (shapes.ts), records parsed with one key sequence share
 * it, and a dynamic read `o.k` with a literal key checks the receiver's
 * shape against the one its site cached and reads the entry at the cached
 * index (ic-read.ts). The A rows are the hit path, counted with
 * SCRIPTC_WASM_IC_STATS: one miss per site per shape, then hits, and no box
 * per round. The B rows are the fallbacks, each Node-exact: delete of the
 * last and of a middle key, defineProperty (a getter, a read-only key, a
 * hidden key), freeze then a strict write, preventExtensions,
 * setPrototypeOf mid-loop, more shapes than one site holds, JSON duplicate
 * and `__proto__` keys, integer-like keys (printing, keys, for-in and
 * stringify order), a literal with a getter, exotic receivers (RegExp,
 * Error, URL, typed array, class instance, Map and WeakSet stand-ins,
 * primitives, arrays), nullish receivers and `?.`, a
 * getter that throws, more than 64 keys and a `%`-prefixed key. Every row
 * also runs shape-checked (u8-rows.ts): each hit re-verifies its answer
 * against the uncached read, so a stale hit traps instead of matching. */
import { defineU8Rows } from "./u8-rows.js";

const RECS = `const parts: string[] = [];
for (let i = 0; i < 6; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":"s' + i + '"}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");`;

defineU8Rows("U8b hit path", [
  { id: "U8b-A01 typed leaves read from parsed records hit after one miss per site, with no box per round",
    perRound: 0, stats: { "ic-hits": 12, "ic-misses": 0 }, totals: { "ic-misses": 2, shapes: 3 },
    src: `${RECS}
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b; s += a * 10 + b; }
console.log(s);` },
  { id: "U8b-A02 JSON.parse of 1,000 records with one key sequence makes 4 shapes",
    totals: { shapes: 4 },
    src: `const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":' + (i + 1) + ',"d":' + (i % 7) + '}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");
let s = 0;
for (let r = 0; r < __R__; r++) s += xs[r].a + xs[r].d;
console.log(s, xs.length, JSON.stringify(xs[999]));` },
  { id: "U8b-A03 an absent key misses on every read (no absent cache in U8b) while present keys hit",
    stats: { "ic-hits": 12, "ic-misses": 6 },
    src: `${RECS}
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; out.push(p.c + ":" + p.a + ":" + p.zz); }
console.log(out.join(","));` },
  { id: "U8b-A04 two literals with one key order share a shape, and a write of an existing key keeps it",
    stats: { "ic-hits": 2, "ic-misses": 0 }, totals: { shapes: 2 },
    src: `const o: any = { x: 1, y: 2 };
const q: any = { x: 3, y: 4 };
let s = 0;
for (let r = 0; r < __R__; r++) { const t: any = r % 2 === 0 ? o : q; const x: number = t.x; s += x; t.y = t.y + 1; }
console.log(s, JSON.stringify(o), JSON.stringify(q));` },
], { shapeCheck: true });

defineU8Rows("U8b fallbacks", [
  { id: "U8b-B01 delete of the last key (shape rolls back) and of a middle key (dictionary mode) mid-loop",
    stats: { "ic-misses": "some" },
    src: `${RECS}
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i];
    out.push(String(p.a) + String(p.c) + String(p.b));
    if (i === 2) delete p.c;
    if (i === 3) delete p.a;
  }
}
console.log(out.join(","), JSON.stringify(xs), Object.keys(xs[3]).join(), "a" in xs[3], "c" in xs[2]);` },
  { id: "U8b-B02 defineProperty turns a hot key into a getter, a read-only key and a hidden key mid-loop",
    src: `${RECS}
const out: string[] = [];
let calls = 0;
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i];
    out.push(String(p.a) + "/" + String(p.b));
    if (i === 1 && r === 0) Object.defineProperty(xs[4], "a", { get() { calls++; return 100; }, enumerable: true, configurable: true });
    if (i === 2 && r === 0) Object.defineProperty(xs[5], "b", { value: -1, writable: false });
    if (i === 3 && r === 0) Object.defineProperty(xs[3], "a", { value: 33, enumerable: false });
  }
}
console.log(out.join(","), calls, JSON.stringify(xs), Object.keys(xs[3]).join(), Object.keys(xs[5]).join());` },
  { id: "U8b-B03 freeze mid-loop, then a strict-mode write throws and reads still answer",
    src: `"use strict";
${RECS}
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i];
    out.push(String(p.a));
    if (i === 1) Object.freeze(xs[2]);
    if (i === 4) { try { xs[2].a = 99; out.push("wrote"); } catch (e) { out.push(e instanceof TypeError ? "TypeError" : "other"); } }
  }
}
console.log(out.join(","), JSON.stringify(xs[2]), Object.isFrozen(xs[2]));` },
  { id: "U8b-B04 setPrototypeOf mid-loop: an own key still answers, and after its delete the prototype's does",
    src: `${RECS}
const proto: any = { a: "PA", z: "PZ" };
const out: string[] = [];
for (let r = 0; r < __R__; r++) {
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i];
    out.push(String(p.a) + String(p.z));
    if (i === 2 && r === 0) Object.setPrototypeOf(xs[4], proto);
    if (i === 3 && r === 0) delete xs[4].a;
  }
}
console.log(out.join(","), JSON.stringify(xs[4]), "z" in xs[4]);` },
  { id: "U8b-B05 a site that sees more shapes than it holds misses on each change and answers every read",
    stats: { "ic-misses": "some" },
    src: `const ks = ["a", "b", "c", "d", "e", "f", "g"];
const objs: any[] = [];
for (let j = 0; j < ks.length; j++) { const o: any = {}; for (let k = 0; k <= j; k++) o[ks[(j + k) % ks.length]!] = j * 10 + k; o.v = j; objs.push(o); }
const ys: any = objs;
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < ys.length; i++) { const v: number = ys[i].v; s += v; s += ys[i].a ?? 0; }
console.log(s, JSON.stringify(ys));` },
  { id: "U8b-B06 JSON duplicate keys keep the first position with the last value, and a `__proto__` key is an own key",
    src: `const xs: any = JSON.parse('[{"a":1,"b":2,"a":3},{"b":4,"a":5},{"__proto__":{"q":1},"a":6},{"a":7,"__proto__":8}]');
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; out.push(String(p.a) + "/" + String(p.b) + "/" + String(p.q) + "/" + JSON.stringify(Object.keys(p))); }
console.log(out.join(" "), JSON.stringify(xs));` },
  { id: "U8b-B07 integer-like and string keys: reads, for-in, keys, stringify and printing keep Node's order",
    src: `const xs: any = JSON.parse('[{"b":1,"2":"two","a":3,"1":"one"},{"b":4,"a":5,"10":"ten","2":"tw"}]');
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  const p = xs[i];
  out.push(String(p.a) + String(p[2]) + String(p["1"]));
  const ks: string[] = [];
  for (const k in p) ks.push(k);
  out.push(ks.join("|"));
}
console.log(out.join(" "), JSON.stringify(xs), Object.keys(xs[1]).join());
console.log(xs[0]);` },
  { id: "U8b-B08 a literal with a getter runs the getter on every read", js: true,
    src: `let gets = 0;
const mk = (i) => ({ a: i, get b() { gets++; return i * 2; }, c: i + 1 });
const xs = [mk(1), mk(2), mk(3)];
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; s += p.a + p.b + p.c; }
console.log(s, gets, JSON.stringify(xs));` },
  { id: "U8b-B09 exotic receivers at one site: RegExp, Error, URL, typed array, class instance, primitives and an array",
    src: `class K { a = 1; b = "k"; }
const re: any = /x(y)/g;
const err: any = new Error("boom");
const u: any = new URL("https://ex.com:8080/p?q=1#h");
const ta: any = new Uint8Array([5, 6, 7]);
const k: any = new K();
const objs: any = [{ a: 1, message: "m", source: "s", host: "h", length: 3, size: 9, b: 2 }, re, err, u, ta, k, "str", 42, true, [1, 2]];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < objs.length; i++) {
  const o = objs[i];
  out.push([o.a, o.message, o.source, o.host, o.length, o.size, o.b, o.lastIndex, o.name].map((v) => String(v)).join("/"));
}
console.log(out.join(" "));` },
  { id: "U8b-B10 Map and WeakSet stand-ins beside plain objects at one site", js: true,
    src: `const m = new Map();
m.set("a", 1);
const ws = new WeakSet();
const objs = [{ size: 9, a: 2, has: 3, raw: 1 }, m, ws, { size: 8, a: 4, has: 5, raw: 2 }];
const out = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < objs.length; i++) { const o = objs[i]; out.push(String(o.size) + "/" + String(o.a) + "/" + typeof o.has + "/" + JSON.stringify(o.raw)); }
console.log(out.join(" "));` },
  { id: "U8b-B11 null and undefined receivers throw Node's TypeError, and `?.` short-circuits",
    src: `const xs: any = [{ a: 1 }, null, undefined, { a: 2 }, 0, ""];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  const p = xs[i];
  out.push(String(p?.a));
  try { out.push(String(p.a)); } catch (e) { out.push((e as Error).message); }
}
console.log(out.join(","));` },
  { id: "U8b-B12 a getter that throws at a site that also hits",
    src: `let n = 0;
const bad: any = { get a() { n++; if (n % 2 === 0) throw new Error("getter " + n); return n; } };
const xs: any = [{ a: 10 }, bad, { a: 20 }];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  try { out.push(String(xs[i].a)); } catch (e) { out.push((e as Error).message); }
}
console.log(out.join(","));` },
  { id: "U8b-B13 more than 64 keys and a `%`-prefixed key leave the shape tree (dictionary mode)",
    stats: { "ic-hits": 0 },
    src: `const ks: string[] = [];
for (let i = 0; i < 70; i++) ks.push("k" + i);
const xs: any = JSON.parse("[" + [0, 1].map((j) => "{" + ks.map((k, i) => JSON.stringify(k) + ":" + (i + j)).join(",") + "}").join(",") + "]");
const ys: any = JSON.parse('[{"%x":1,"y":2},{"%x":3,"y":4}]');
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < 2; i++) { const p = xs[i]; const q = ys[i]; s += p.k0 + p.k63 + p.k64 + p.k69 + q["%x"] + q.y; }
console.log(s, Object.keys(xs[1]).length, Object.keys(xs[0])[69], JSON.stringify(ys));` },
  { id: "U8b-B14 add-then-delete of a last key, delete-then-re-add, and preventExtensions mid-loop",
    src: `${RECS}
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  const p = xs[i];
  out.push(String(p.a) + String(p.c));
  if (i === 1) { p.extra = r; delete p.extra; }
  if (i === 2) { delete p.c; p.c = "back" + r; }
  if (i === 3) Object.preventExtensions(p);
}
console.log(out.join(","), JSON.stringify(xs), Object.keys(xs[2]).join());` },
  { id: "U8b-B15 objects built by assignment, a literal and Object.create(null) at one site",
    src: `const xs: any = [];
for (let i = 0; i < 4; i++) { const o: any = {}; o.a = i; o.b = i * 2; xs.push(o); }
xs.push({ a: 9, b: 8 });
xs.push(Object.create(null));
xs[5].a = 7;
const out: number[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const a: number = xs[i].a; out.push(a); }
console.log(out.join(","), JSON.stringify(xs));` },
  { id: "U8b-B16 a getter whose own cached read fills its site leaves the outer read's site unfilled",
    src: `const q: any = JSON.parse('{"x":5,"y":6}');
const o: any = { get g() { return q.y; } };
const objs: any = [o, q, o, q];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < objs.length; i++) out.push(String(objs[i].g));
console.log(out.join(","));` },
  { id: "U8b-B17 a site seeing 20 shapes fills its four ways, goes megamorphic, reads the rest uncached and keeps hitting its ways (U8c)",
    stats: { "ic-misses": 21, "ic-hits": 4, "ic-megas": 0 }, totals: { "ic-misses": 25, "ic-hits": 0, "ic-megas": 1 },
    src: `const recs: string[] = [];
for (let i = 0; i < 20; i++) recs.push('{"a":' + (i * 3) + ',"k' + i + '":' + i + '}');
const xs: any = JSON.parse("[" + recs.join(",") + "]");
const tail: any = JSON.parse('{"a":7,"k15":0}');
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length + 5; i++) { const p = i < xs.length ? xs[i] : tail; s += p.a; }
console.log(s);` },
  { id: "U8b-B18 a shape with more than 32 children: later siblings start in dictionary mode and read as in Node",
    src: `const recs: string[] = [];
for (let i = 0; i < 40; i++) recs.push('{"k' + i + '":' + i + ',"a":' + (i * 3) + '}');
const xs: any = JSON.parse("[" + recs.join(",") + "]");
let s = 0;
const ks: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { s += xs[i].a; if (r === 0) ks.push(Object.keys(xs[i]).join("")); }
xs[39].z = 1;
delete xs[38].a;
console.log(s, ks.join(","), JSON.stringify(xs.slice(36)));` },
], { shapeCheck: true });
