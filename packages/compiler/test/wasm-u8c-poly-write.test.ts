/* U8c, polymorphic and store caches, final-shape literals and interned
 * small-integer boxes (docs/design/u8-dynamic-speed.md §4, §8).
 *
 * The A rows are the hit paths, counted with SCRIPTC_WASM_IC_STATS: a read
 * site that sees 2 or 4 shapes misses once per shape and then hits; a fifth
 * shape makes it megamorphic (ic-ways.ts); a write of an existing key and
 * an append on a cached transition hit (ic-write.ts); an object literal
 * builds on its cached final shape (lit-shape.ts); small integers and
 * number literals written into objects allocate no box (box-intern.ts).
 * The B rows are the fallbacks, each Node-exact, in strict code (a module)
 * and in sloppy code (a script) where they differ: frozen, sealed and
 * non-extensible receivers, a read-only key, a getter and setter defined
 * over a hot key, a setter and a read-only key on the prototype of an
 * append, setPrototypeOf mid-loop, delete then re-add, nullish, primitive
 * receivers, a megamorphic store site, key order after cached
 * appends, a setter that writes through its own site, literals with a
 * getter, a nested literal and a throwing value, and -0, NaN and
 * fractions stored. (A literal with a duplicate key is refused at compile
 * time, SC0001; lit-shape.ts still leaves such a site unfilled.) Every row also runs shape-checked (u8-rows.ts): each cache hit,
 * store and literal re-verifies its object against the uncached machinery
 * and traps on a difference. */
import { defineU8Rows } from "./u8-rows.js";

/** Six records in two key orders. */
const POLY2 = `const parts: string[] = [];
for (let i = 0; i < 6; i++) parts.push(i % 2 === 0 ? '{"a":' + i + ',"b":' + (i * 2) + '}' : '{"b":' + (i * 2) + ',"a":' + i + '}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");`;

/** Eight records in four shapes (two orders, an extra key, a reversed order). */
const POLY4 = `const sh = ['{"a":#,"b":1}', '{"b":1,"a":#}', '{"a":#,"b":1,"e":0}', '{"e":0,"b":1,"a":#}'];
const parts: string[] = [];
for (let i = 0; i < 8; i++) parts.push(sh[i % 4]!.replace("#", String(i)));
const xs: any = JSON.parse("[" + parts.join(",") + "]");`;

/** Six records in six shapes, each with `a` and `v`. */
const POLY6 = `const parts: string[] = [];
for (let i = 0; i < 6; i++) parts.push('{"k' + i + '":0,"a":' + i + ',"v":' + (i * 3) + '}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");`;

defineU8Rows("U8c hit paths", [
  { id: "U8c-A01 a read site seeing two key orders misses once per order, then hits, with no box per round",
    perRound: 0, stats: { "ic-hits": 12, "ic-misses": 0 }, totals: { "ic-misses": 4, "ic-megas": 0 },
    src: `${POLY2}
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b; s += a * 10 + b; }
console.log(s);` },
  { id: "U8c-A02 a read site seeing four shapes misses once per shape, then hits",
    perRound: 0, stats: { "ic-hits": 16, "ic-misses": 0 }, totals: { "ic-misses": 8, "ic-megas": 0 },
    src: `${POLY4}
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b; s += a * 10 + b; }
console.log(s);` },
  { id: "U8c-A03 a fifth shape makes a read site megamorphic: its four ways keep hitting, the rest read uncached",
    stats: { "ic-hits": 8, "ic-misses": 4, "ic-megas": 0 }, totals: { "ic-misses": 12, "ic-megas": 2 },
    src: `${POLY6}
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, v: number = p.v; s += a + v; }
console.log(s, JSON.stringify(xs));` },
  { id: "U8c-A04 writes of existing keys hit in place, and small integers and literals stored allocate no box",
    perRound: 0, stats: { "set-hits": 24, "set-misses": 0 }, totals: { "set-misses": 8 },
    src: `${POLY2}
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; p.a = i; p.b = 1023; p.b = 2.5; p.b = r; }
console.log(JSON.stringify(xs));` },
  { id: "U8c-A05 appends on a cached transition hit and make no shape per round",
    stats: { "set-hits": 12, "set-misses": 0, shapes: 0 }, totals: { "set-misses": 3, shapes: 3 },
    src: `const out: any[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < 4; i++) { const o: any = JSON.parse("{}"); o.x = i; o.y = "s" + i; o.z = r; out.push(o); }
console.log(JSON.stringify(out), Object.keys(out[out.length - 1]).join());` },
  { id: "U8c-A06 a TypeScript literal builds on its final shape after its first build",
    stats: { "lit-hits": 4, shapes: 0 }, totals: { "lit-hits": 3, shapes: 4 },
    src: `const mk = (i: number): any => ({ x: i, y: i * 2.5, z: "k" + i });
const ls: any[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < 4; i++) ls.push(mk(i));
const q: any = ls[3];
q.w = 1;
console.log(JSON.stringify(ls), Object.keys(q).join(), q.x + q.y);` },
  { id: "U8c-A07 a JavaScript literal builds on its final shape (its nested literal is a typed record shared in)", js: true,
    stats: { "lit-hits": 3 }, totals: { "lit-hits": 2 },
    src: `const ls = JSON.parse("[]");
for (let r = 0; r < __R__; r++) for (let i = 0; i < 3; i++) ls.push({ id: i, tag: { name: "t" + i, n: r }, ok: true });
for (const k in ls[1]) console.log(k, JSON.stringify(ls[1][k]));
console.log(JSON.stringify(ls));` },
  { id: "U8c-A08 interned boxes: integers 0..1023 share boxes, other numbers (-0, 1024, fractions, NaN) stay exact",
    stats: { "dyn-allocs": "some" },
    src: `const o: any = JSON.parse('{"n":0}');
const vals: number[] = [];
for (let r = 0; r < __R__; r++) for (let i = 1020; i < 1028; i++) { o.n = i; vals.push(o.n); o.n = -0; vals.push(1 / o.n); o.n = i / 4; vals.push(o.n); o.n = 0 / 0; vals.push(o.n); }
console.log(vals.join(","), o.n !== o.n);` },
], { shapeCheck: true });

defineU8Rows("U8c fallbacks", [
  { id: "U8c-B01 freeze, seal and preventExtensions mid-loop at warm store sites, strict code",
    src: `export {};
${POLY2}
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  const p = xs[i];
  try { p.a = r * 10 + i; out.push("w" + i); } catch (e) { out.push((e as Error).message); }
  try { p.z = r; out.push("z" + i); } catch (e) { out.push((e as Error).message); }
  if (r === 0 && i === 2) { Object.freeze(xs[3]); Object.seal(xs[4]); Object.preventExtensions(xs[5]); }
}
console.log(out.join("|"), JSON.stringify(xs), Object.isFrozen(xs[3]), Object.isSealed(xs[4]));` },
  { id: "U8c-B02 freeze, seal and preventExtensions mid-loop at warm store sites, sloppy code",
    src: `${POLY2}
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  const p = xs[i];
  p.a = r * 10 + i;
  p.z = r;
  out.push(String(p.a) + ":" + String(p.z));
  if (r === 0 && i === 2) { Object.freeze(xs[3]); Object.seal(xs[4]); Object.preventExtensions(xs[5]); }
}
console.log(out.join("|"), JSON.stringify(xs));` },
  { id: "U8c-B03 defineProperty makes a hot key read-only, then a getter/setter, mid-loop",
    src: `export {};
${POLY2}
const log: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  try { xs[i].a = r + i; } catch (e) { log.push((e as Error).message); }
  log.push(String(xs[i].a));
  if (r === 0 && i === 1) Object.defineProperty(xs[2], "a", { value: 99, writable: false });
  if (r === 0 && i === 3) Object.defineProperty(xs[4], "a", { get() { return -1; }, set(v: number) { log.push("set " + v); }, enumerable: true });
}
console.log(log.join(","), JSON.stringify(xs));` },
  { id: "U8c-B04 an append site warm on plain objects meets receivers whose prototype has a setter or a read-only key",
    src: `export {};
const proto: any = {};
Object.defineProperty(proto, "x", { set(v: number) { log.push("setter " + v); }, get() { return "inherited"; } });
const ro: any = {};
Object.defineProperty(ro, "x", { value: "ro", writable: false });
const log: string[] = [];
const objs: any[] = [JSON.parse("{}"), JSON.parse("{}"), Object.create(proto), JSON.parse("{}"), Object.create(ro), Object.create(null)];
for (let r = 0; r < __R__; r++) for (let i = 0; i < objs.length; i++) {
  const o = r === 0 ? objs[i] : (i === 2 ? Object.create(proto) : i === 4 ? Object.create(ro) : JSON.parse("{}"));
  try { o.x = r * 10 + i; } catch (e) { log.push((e as Error).message); }
  const ks: string = Object.keys(o).join("");
  log.push(String(o.x) + "/" + ks);
}
console.log(log.join(","));` },
  { id: "U8c-B05 an append onto a prototype-setter receiver in sloppy code, and setPrototypeOf mid-loop",
    src: `const proto: any = {};
Object.defineProperty(proto, "x", { set(v: number) { log.push("setter " + v); } });
const ro: any = {};
Object.defineProperty(ro, "x", { value: "ro", writable: false });
const log: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < 6; i++) {
  const o: any = JSON.parse("{}");
  if (i === 2) Object.setPrototypeOf(o, proto);
  if (i === 4) Object.setPrototypeOf(o, ro);
  o.x = r * 10 + i;
  const ks: string = Object.keys(o).join("");
  log.push(String(o.x) + "/" + ks);
}
console.log(log.join(","));` },
  { id: "U8c-B06 delete then re-add at warm sites: the last key rolls back and re-appends, a middle key leaves the tree",
    stats: { "set-misses": "some" },
    src: `${POLY2}
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) {
  const p = xs[i];
  p.c = r;
  if (i % 3 === 0) delete p.c;
  if (i % 3 === 1) delete p.a;
  p.c = r + 100;
  p.a = i;
  const ks: string = Object.keys(p).join("");
  out.push(ks + "=" + JSON.stringify(p));
}
console.log(out.join("|"));` },
  { id: "U8c-B07 nullish and primitive receivers at a warm store site, strict code (a named key on a dynamic array is S016)",
    src: `export {};
const recv: any[] = [JSON.parse('{"a":1}'), JSON.parse('{"a":2}'), null, undefined, 5, "s", true];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < recv.length; i++) {
  try { recv[i].a = r; out.push("ok " + JSON.stringify(recv[i])); } catch (e) { out.push((e instanceof TypeError ? "TypeError: " : "other: ") + (e as Error).message); }
}
console.log(out.join("|"));` },
  { id: "U8c-B08 primitive receivers at a warm store site in sloppy code are ignored",
    src: `const recv: any[] = [JSON.parse('{"a":1}'), 5, "s", true, JSON.parse('{"a":2}')];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < recv.length; i++) { recv[i].a = r; out.push(String(recv[i].a)); }
try { const n: any = null; n.a = 1; } catch (e) { out.push((e as Error).message); }
console.log(out.join("|"));` },
  { id: "U8c-B09 a megamorphic store site: six shapes, existing keys and appends, every write lands",
    stats: { "ic-megas": 0 }, totals: { "ic-megas": 4 },
    src: `${POLY6}
for (let r = 0; r < __R__; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; p.a = r; p.v = p.v + 1; if (r === 0) p.w = i; }
console.log(JSON.stringify(xs));` },
  { id: "U8c-B10 key order after cached appends: integer-like keys, for-in, keys, stringify and printing",
    src: `const out: any[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < 3; i++) { const o: any = JSON.parse("{}"); o.b = i; o["2"] = "two"; o.a = r; o["1"] = "one"; out.push(o); }
const last = out[out.length - 1];
const ks: string[] = [];
for (const k in last) ks.push(k);
console.log(ks.join(), Object.keys(last).join(), JSON.stringify(last), Object.entries(last).length);
console.log(last);` },
  { id: "U8c-B11 a prototype setter whose own write fills another store site leaves the outer site unfilled",
    src: `export {};
const log: string[] = [];
function put(o: any, v: number): void { o.x = v; }
const proto: any = {};
Object.defineProperty(proto, "x", { set(v: number) { const q: any = JSON.parse("{}"); put(q, v); q.y = v + 1000; log.push("set " + JSON.stringify(q)); } });
for (let r = 0; r < __R__; r++) for (let i = 0; i < 4; i++) {
  const o: any = i === 0 ? Object.create(proto) : JSON.parse("{}");
  put(o, r * 10 + i);
  put(o, r * 10 + i + 1);
  log.push(JSON.stringify(o) + ":" + String(o.x));
}
console.log(log.join(","));` },
  { id: "U8c-B12 literals with a getter, a nested literal and a throwing value", js: true,
    src: `const out = [];
const boom = (i) => { if (i === 2) throw new Error("boom " + i); return i; };
for (let r = 0; r < __R__; r++) for (let i = 0; i < 3; i++) {
  const d = { a: i, b: { a: r, c: [i] } };
  const g = { v: i, get w() { return this.v * 2; } };
  let t = null;
  try { t = { p: i, q: boom(i), s: "x" }; } catch (e) { out.push(e.message); }
  out.push(JSON.stringify(d) + JSON.stringify(g) + g.w + JSON.stringify(t) + Object.keys(d).join(""));
}
console.log(out.join("|"));` },
  { id: "U8c-B13 values of every kind stored at a warm site, and a literal of mixed values",
    src: `const o: any = JSON.parse('{"v":0}');
const vals: any[] = [1, "s", null, undefined, true, [1, 2], { k: 1 }, () => 3, 1.5, -0, 2 ** 40];
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < vals.length; i++) { o.v = vals[i]; const m: any = { v: vals[i], i: i }; out.push(typeof o.v + ":" + typeof m.v + ":" + JSON.stringify(m)); }
console.log(out.join("|"), o.v === 2 ** 40);` },
  { id: "U8c-B14 a frozen literal and a literal written into, read back through warm sites",
    src: `export {};
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < 3; i++) {
  const o: any = { a: i, b: "x" };
  if (i === 1) Object.freeze(o);
  try { o.a = 7; o.c = 8; } catch (e) { out.push((e as Error).message); }
  out.push(JSON.stringify(o) + ":" + o.a + ":" + ("c" in o));
}
console.log(out.join("|"));` },
], { shapeCheck: true });
