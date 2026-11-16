/* GH #227: a hybrid record (declared fields AND an index signature) lists
 * its own keys in Node's insertion order on every own-key surface — the
 * index added keys first, then the declared fields and the added keys as
 * each was created. Compared with Node byte for byte on the wasm and
 * wasm-native lanes (u3u4-rows.ts). */
import { defineRows } from "./u3u4-rows.js";

defineRows("GH #227 hybrid key order", [
  {
    id: "HO-01 an added key spelled before a declared field in a literal: keys, entries, JSON, for-in and console.log",
    entry: "main.ts",
    src: `type R = { id: string; [k: string]: unknown };
const r: R = { name: "n", id: "a1" };
console.log(Object.keys(r), Object.entries(r), JSON.stringify(r));
for (const k in r) console.log(k);
console.log(r);
const s: R = { id: "s", tag: 1 };
console.log(Object.keys(s), JSON.stringify(s), s);`,
  },
  {
    id: "HO-02 an optional declared field gaining its key after added keys, by name and through a computed key; index keys first",
    entry: "main.ts",
    src: `type R = { id?: string; [k: string]: unknown };
const r: R = {};
r.x = 1;
r.id = "late";
r.z = 2;
r["7"] = 7;
console.log(Object.keys(r), JSON.stringify(r), r);
const k = ["i", "d"].join("");
const s: R = { a: 1 };
s[k] = "dyn";
s.b = 2;
console.log(Object.keys(s), JSON.stringify(s), s);
const t: R = { id: "early" };
t.x = 1;
t.id = "again";
console.log(Object.keys(t), t);`,
  },
  {
    id: "HO-03 a JSON source checked into a hybrid keeps the source's key order (a contained cast and a function's result)",
    entry: "main.ts",
    src: `type R = { id: string; [k: string]: unknown };
const r = JSON.parse('{"name":"n","id":"a1","z":3}') as R;
console.log(Object.keys(r), JSON.stringify(r), r);
const s = JSON.parse('{"id":"a1","z":3}') as R;
console.log(Object.keys(s), JSON.stringify(s), s);
function load(t: string): R { return JSON.parse(t) as R; }
const u = load('{"b":1,"id":"x"}');
u.c = 2;
console.log(Object.keys(u), JSON.stringify(u), u);`,
  },
  {
    id: "HO-04 explicit undefined in a literal is a key; an omitted optional field is not",
    entry: "main.ts",
    src: `type R = { id?: string; [k: string]: unknown };
const r: R = { name: "n", id: undefined };
console.log(Object.keys(r), r);
const q: R = { name: "n" };
q.more = 2;
console.log(Object.keys(q), q);
type S = { id: string | undefined; [k: string]: unknown };
const s: S = { name: "n", id: undefined };
console.log(Object.keys(s), s);`,
  },
  {
    id: "HO-05 a reordered hybrid seen through any and unknown, and copied by Object.assign into another hybrid",
    entry: "main.ts",
    src: `type R = { id: string; [k: string]: unknown };
const r: R = { name: "n", id: "a1" };
r.late = true;
const a: any = r;
console.log(Object.keys(a), JSON.stringify(a));
const u: unknown = r;
console.log(u);
const t: R = { id: "t" };
Object.assign(t, r);
console.log(Object.keys(t), t);`,
  },
  {
    id: "HO-06 an index added key (a literal key, a computed key, a literal spelling, a JSON capture) lists ahead of the declared fields",
    entry: "main.ts",
    src: `type R = { id: string; [k: string]: unknown };
const r: R = { id: "a" };
r.x = 1;
r["2"] = 2;
const k = String(5);
r[k] = 5;
console.log(Object.keys(r), JSON.stringify(r), r);
for (const key in r) console.log(key);
const s: R = { id: "s", 9: "nine" };
console.log(Object.keys(s), s);
const t = JSON.parse('{"id":"t","7":7,"w":1}') as R;
console.log(Object.keys(t), JSON.stringify(t), t);`,
  },
]);
