/* U8d, prototype inline caches (docs/design/u8-dynamic-speed.md §5, §8).
 *
 * The A rows are the hit paths, counted with SCRIPTC_WASM_IC_STATS: a read
 * of a member an ES5 constructor's prototype holds, of a key absent up
 * the whole chain, and of a member two links up an Object.create chain
 * hits once proved (proto-ic.ts, ic-read.ts chain ways); a constructor's
 * `this.k = v` appends on linked receivers hit (ic-write.ts); a site seeing
 * two constructors' instances holds a chain way for each.
 *
 * The B rows mutate the chain mid-loop, each Node-exact: a member's value
 * replaced on the prototype (the way stays, it names a place), a key added
 * to the prototype over an absent way, an own key shadowing a prototype
 * one, delete on the prototype, defineProperty on it (a getter, a read-only
 * key), setPrototypeOf on an instance and on the prototype itself, an
 * Object.create chain whose middle link gains a shadowing key, an object
 * that becomes a prototype after its own shape was cached, setters and
 * read-only keys appearing up the chain of an append (strict code throws,
 * sloppy code ignores), a prototype mutated every round past the refresh
 * budget, a getter that moves the chain while it is read, a getter up the
 * chain, prototypes that are not plain objects (a class instance, a
 * null-prototype object), freeze and preventExtensions of a prototype, a
 * hidden key added to a prototype over an absent read (then deleted and
 * re-added), a hidden read-only key up a sloppy append's chain, appends on
 * receivers that are themselves prototypes, and setPrototypeOf to null and
 * back over cached chain reads.
 * Every row also runs shape-checked (u8-rows.ts): each cache hit re-proves
 * its answer against the uncached read, and every shaped payload checked
 * must descend from its prototype's root (ic-check.ts). */
import { defineU8Rows } from "./u8-rows.js";

/** An ES5 constructor and eight instances. */
const ES5 = `function P(i) { this.a = i; this.b = i * 2; }
P.prototype.f = function () { return 1; };
P.prototype.v = 10;
const xs = [];
for (let i = 0; i < 8; i++) xs.push(new P(i));`;

defineU8Rows("U8d hit paths", [
  { id: "U8d-A01 prototype method reads on an ES5 constructor's instances hit once proved, with no box per round", js: true,
    perRound: 0, stats: { "ic-hits": 16, "ic-misses": 0, "proto-bumps": 0 },
    src: `${ES5}
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < 8; i++) { const p = xs[i]; if (p.f !== undefined) s++; s += p.v; }
console.log(s);` },
  { id: "U8d-A02 a key absent up the whole chain hits as undefined", js: true,
    perRound: 0, stats: { "ic-hits": 8, "ic-misses": 0 },
    src: `${ES5}
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < 8; i++) { const p = xs[i]; if (p.zz === undefined) s++; }
console.log(s);` },
  { id: "U8d-A03 a member two links up an Object.create chain hits",
    perRound: 0, stats: { "ic-hits": 8, "ic-misses": 0 },
    src: `const g: any = JSON.parse('{"deep":7}');
const m: any = Object.create(g);
const xs: any[] = [];
for (let i = 0; i < 8; i++) { const o: any = Object.create(m); o.i = i; xs.push(o); }
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < 8; i++) { const p = xs[i]; const d: number = p.deep; s += d; }
console.log(s);` },
  { id: "U8d-A04 a constructor's appends on linked receivers hit once proved", js: true,
    stats: { "set-hits": 16, "set-misses": 0 },
    src: `function P(i) { this.a = i; this.b = i * 2; }
P.prototype.f = 1;
const xs = [];
for (let r = 0; r < __R__; r++) for (let i = 0; i < 8; i++) xs.push(new P(i));
console.log(xs.length, JSON.stringify(xs[xs.length - 1]), xs[3].f);` },
  { id: "U8d-A05 a site seeing two constructors' instances holds a chain way for each", js: true,
    perRound: 0, stats: { "ic-hits": 8, "ic-misses": 0 },
    src: `function A(i) { this.i = i; }
A.prototype.k = 1;
function B(i) { this.i = i; }
B.prototype.k = 2;
const xs = [];
for (let i = 0; i < 8; i++) xs.push(i % 2 ? new A(i) : new B(i));
let s = 0;
for (let r = 0; r < __R__; r++) for (let i = 0; i < 8; i++) s += xs[i].k;
console.log(s);` },
], { shapeCheck: true });

/** A hot loop of 30 steps per round over the instances, `mut(t)` run at
 * the start of step t; prints what each step read. */
const hot = (read: string, mut: string): string => `const seen = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  ${mut}
  let row = "";
  for (let i = 0; i < xs.length; i++) { const p = xs[i]; row += String(${read}) + ","; }
  seen.push(row);
}
console.log(seen.join("\\n"));`;

defineU8Rows("U8d chain mutations", [
  { id: "U8d-B01 a prototype member's value replaced mid-loop reads the new value", js: true,
    src: `${ES5}
${hot("p.v", "if (t === 10) P.prototype.v = 11; if (t === 20) P.prototype.v = 'x';")}` },
  { id: "U8d-B02 a key added to the prototype over an absent way is seen", js: true,
    src: `${ES5}
${hot("p.zz", "if (t === 10) P.prototype.zz = 5; if (t === 20) P.prototype.zz = 6;")}` },
  { id: "U8d-B03 an own key shadowing a prototype member, then deleted, reads the right one", js: true,
    src: `${ES5}
${hot("p.v", "if (t === 10) xs[3].v = 99; if (t === 15) xs[5].v = undefined; if (t === 20) delete xs[3].v;")}` },
  { id: "U8d-B04 delete on the prototype mid-loop reads undefined, then a re-add reads again", js: true,
    src: `${ES5}
${hot("p.v", "if (t === 10) delete P.prototype.v; if (t === 20) P.prototype.v = 3;")}` },
  { id: "U8d-B05 defineProperty on the prototype: a getter over the cached member, then a data value again", js: true,
    src: `${ES5}
${hot("p.v", "if (t === 10) Object.defineProperty(P.prototype, 'v', { get() { return this.a * 100; }, configurable: true }); if (t === 20) Object.defineProperty(P.prototype, 'v', { value: 7, writable: true, configurable: true });")}` },
  { id: "U8d-B06 defineProperty of a read-only key on the prototype keeps the reads exact", js: true,
    src: `${ES5}
${hot("p.v + '/' + p.w", "if (t === 10) Object.defineProperty(P.prototype, 'w', { value: 4, writable: false }); if (t === 20) Object.defineProperty(P.prototype, 'v', { value: 8, writable: false });")}` },
  { id: "U8d-B07 setPrototypeOf on an instance and on the prototype itself mid-loop", js: true,
    src: `${ES5}
const Q = { v: 'q', zz: 'qz' };
const G = { zz: 'g' };
${hot("p.v + '/' + p.zz", "if (t === 10) Object.setPrototypeOf(xs[2], Q); if (t === 20) Object.setPrototypeOf(P.prototype, G); if (t === 25) Object.setPrototypeOf(xs[2], P.prototype);")}` },
  { id: "U8d-B08 an Object.create chain whose middle link gains, then loses, a shadowing key",
    src: `const g: any = JSON.parse('{"deep":7}');
const m: any = Object.create(g);
const xs: any[] = [];
for (let i = 0; i < 4; i++) { const o: any = Object.create(m); o.i = i; xs.push(o); }
const seen: string[] = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  if (t === 10) m.deep = 8;
  if (t === 15) g.deep = 9;
  if (t === 20) delete m.deep;
  let row = "";
  for (let i = 0; i < xs.length; i++) { const p = xs[i]; row += String(p.deep) + ","; }
  seen.push(row);
}
console.log(seen.join("\\n"));` },
  { id: "U8d-B09 an object becoming a prototype after its shape was cached", js: true,
    src: `const o = JSON.parse('{"a":1,"b":2}');
const seen = [];
let kids = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  seen.push(o.a + o.b);
  if (t === 5) kids.push(Object.create(o));
  if (t === 10) { o.a = 3; o.c = 4; }
  if (t === 15) delete o.b;
  if (t === 20) kids.push(Object.create(o));
  let row = "";
  for (let i = 0; i < kids.length; i++) { const k = kids[i]; row += k.a + "/" + k.b + "/" + k.c + ","; }
  seen.push(row);
}
console.log(seen.join("\\n"));` },
  { id: "U8d-B10 a setter and a read-only key appearing up an append's chain: sloppy code ignores the read-only write", js: true,
    src: `function P(i) { this.i = i; }
const log = [];
const out = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  if (t === 10) Object.defineProperty(P.prototype, 'x', { set(v) { log.push('set ' + v); }, configurable: true });
  if (t === 20) Object.defineProperty(P.prototype, 'x', { value: 'ro', writable: false, configurable: true });
  if (t === 25) delete P.prototype.x;
  const o = new P(t);
  o.x = t;
  out.push(JSON.stringify(o) + ':' + o.x);
}
console.log(out.join(" "), log.join());` },
  { id: "U8d-B11 a read-only key appearing up an append's chain: strict code throws",
    src: `const proto: any = JSON.parse("{}");
const out: string[] = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  if (t === 20) Object.defineProperty(proto, "x", { value: "ro", writable: false, configurable: true });
  if (t === 25) delete proto.x;
  const o: any = Object.create(proto);
  try { o.x = t; out.push(JSON.stringify(o)); } catch (e) { out.push(e instanceof TypeError ? "TypeError" : "other"); }
}
console.log(out.join(" "));` },
  { id: "U8d-B12 a prototype written every step, past the refresh budget, stays exact", js: true,
    stats: { "proto-bumps": "some" },
    src: `${ES5}
${hot("p.v + '/' + p.zz", "P.prototype['k' + t] = t; if (t % 3 === 0) delete P.prototype['k' + (t - 3)];")}` },
  { id: "U8d-B13 a getter up the chain that moves the chain while it is read", js: true,
    src: `function P(i) { this.i = i; }
let n = 0;
Object.defineProperty(P.prototype, 'g', { get() { n++; P.prototype['m' + n] = n; return this.i + n; }, configurable: true });
P.prototype.v = 1;
const xs = [];
for (let i = 0; i < 4; i++) xs.push(new P(i));
${hot("p.g + '/' + p.v + '/' + p.m3", "if (t === 12) P.prototype.v = 2;")}` },
  { id: "U8d-B14 prototypes that are not plain objects: a class instance, a null-prototype object and a chain over one",
    src: `class C { tag = "c"; length = 3; }
const c: any = new C();
const np: any = Object.create(null);
np.tag = "np";
const xs: any[] = [Object.create(c), Object.create(np), Object.create(Object.create(np))];
const seen: string[] = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  if (t === 10) { c.tag = "c2"; np.tag = "np2"; }
  if (t === 20) delete np.tag;
  if (t === 25) np.tag = "np3";
  let row = "";
  for (let i = 0; i < xs.length; i++) { const p = xs[i]; row += String(p.tag + "/" + p.length) + ","; }
  seen.push(row);
}
console.log(seen.join("\\n"));` },
  { id: "U8d-B15 freeze and preventExtensions of a prototype keep reads exact and refuse appends on it", js: true,
    src: `${ES5}
const out = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  if (t === 10) Object.preventExtensions(P.prototype);
  if (t === 20 && r === 0) Object.freeze(P.prototype);
  P.prototype['n' + t] = t;
  const o = new P(t);
  o.v = t;
  out.push(o.v + '/' + o.f + '/' + o.n5 + '/' + P.prototype.v);
}
console.log(out.join(" "));` },
  { id: "U8d-B16 an instance's own appends after its prototype is reassigned (F.prototype = another object)", js: true,
    src: `function P(i) { this.i = i; this.j = i + 1; }
P.prototype.k = 'a';
const out = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  if (t === 10) P.prototype = { k: 'b' };
  if (t === 20) P.prototype = Object.create(null);
  const o = new P(t);
  out.push(JSON.stringify(o) + o.k);
}
console.log(out.join(" "));` },
  { id: "U8d-B17 a hidden key added to the prototype over a cached absent read, deleted, then re-added", js: true,
    src: `${ES5}
${hot("p.zz", "if (t === 10) Object.defineProperty(P.prototype, 'zz', { value: 5, enumerable: false, configurable: true }); if (t === 15) delete P.prototype.zz; if (t === 20) Object.defineProperty(P.prototype, 'zz', { value: 6, enumerable: false, configurable: true });")}` },
  { id: "U8d-B18 a hidden read-only key appearing up the chain of a sloppy-mode append cache", js: true,
    stats: { "set-hits": "some" },
    src: `function P(i) { this.i = i; }
const out = [];
for (let r = 0; r < __R__; r++) for (let t = 0; t < 30; t++) {
  if (t === 10) Object.defineProperty(P.prototype, 'x', { value: 'ro', writable: false, enumerable: false, configurable: true });
  if (t === 20) delete P.prototype.x;
  const o = new P(t);
  o.x = t;
  out.push(JSON.stringify(o) + ':' + o.x + ':' + Object.keys(o).join('|'));
}
console.log(out.join(" "));` },
  { id: "U8d-B19 append-cache hits on receivers that are themselves prototypes of other objects", js: true,
    stats: { "set-hits": "some", "proto-bumps": "some" },
    src: `function P(i) { this.i = i; }
const out = [];
for (let r = 0; r < __R__; r++) {
  const protos = [];
  const kids = [];
  for (let i = 0; i < 4; i++) { const o = new P(i); protos.push(o); kids.push(Object.create(o)); }
  for (let t = 0; t < 30; t++) {
    if (t === 10) for (let i = 0; i < 4; i++) protos[i].y = t + i;
    if (t === 20) for (let i = 0; i < 4; i++) protos[i].z = 'z' + i;
    let row = "";
    for (let i = 0; i < 4; i++) { const k = kids[i]; row += k.i + "/" + k.y + "/" + k.z + ","; }
    out.push(row);
  }
}
console.log(out.join("\\n"));` },
  { id: "U8d-B20 setPrototypeOf to null and back, on the prototype and on an instance, over cached chain reads", js: true,
    src: `const G = { g: 'g' };
${ES5}
Object.setPrototypeOf(P.prototype, G);
${hot("p.g + '/' + p.v", "if (t === 10) Object.setPrototypeOf(P.prototype, null); if (t === 15) Object.setPrototypeOf(xs[1], null); if (t === 20) { Object.setPrototypeOf(P.prototype, G); Object.setPrototypeOf(xs[1], P.prototype); }")}` },
], { shapeCheck: true });
