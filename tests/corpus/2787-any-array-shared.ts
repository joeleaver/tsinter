// @dynamic
// `any[]` IS the island array (unit H, board #259/#268, SEMANTICS.md S014's
// unit-H amendment): every crossing between an `any[]` and `any` — typed
// parameters, defaults, object-literal members, property writes, nested
// arrays, records holding one, returns, promises — shares ONE array, so a
// push through either side is seen through the other and `===` holds, as
// in Node. Typed `number[]`/`string[]` values crossing into `any` are live
// views of the typed value (S115); island values leave into typed slots
// only when fresh.

// --- a typed any[] parameter (with a default) receiving an island array
function back(xs: any[] = []): any[] {
  xs.push("added");
  return xs;
}
const o: any = { p: [{ n: 1 }] };
const r = back(o.p);
const anyR: any = r;
anyR.push(9);
console.log(`param: ${o.p.length} ${r.length} ${anyR.length} ${anyR === o.p} ${r === o.p}`);
o.p.push(7);
console.log(`param after: ${r.length} ${anyR.length}`);
console.log(`default: ${back().length} ${back() === back()}`);

// --- `any[] | undefined` and empty arrays keep their identity
function id(xs: any[] | undefined): any[] {
  return xs === undefined ? [] : xs;
}
const e: any = { a: [], b: [] };
const x = id(e.a);
const y = id(e.b);
const h1: any = { x, y };
console.log(`empty: ${h1.x === h1.y} ${h1.x === e.a} ${h1.y === e.b} ${e.a === e.b}`);
const u1 = id(undefined);
const u2 = id(undefined);
console.log(`fresh: ${u1 === u2} ${u1 === u1}`);

// --- a static any[] into object-literal members and property writes
const a: any[] = [1, 2];
const b: any[] = a;
const c: any[] = a.concat();
const h2: any = {};
h2.a = a;
h2.b = b;
h2.c = c;
const lit: any = { a, both: [a, b] };
console.log(`members: ${h2.a === h2.b} ${h2.a === h2.c} ${lit.a === a} ${lit.both[1] === h2.a}`);
h2.a.push(3);
console.log(`members push: ${a.length} ${b.length} ${c.length} ${lit.a.length}`);
a.push(4);
console.log(`members push back: ${h2.a.length} ${h2.b.length} ${lit.both[0].length}`);

// --- a helper filling a module-level log through a typed parameter
const log: any[] = [];
function note(out: any[], line: string): void {
  out.push(line);
}
note(log, "one");
note(log, "two");
const holder: any = { log };
note(holder.log, "three");
console.log(`log: ${log.length} ${log.join("|")} ${holder.log === log}`);

// --- nested arrays: the inner arrays are shared too
const grid: any[][] = [[1], [2, 3]];
const g: any = grid;
g[0].push(5);
grid[1].push(4);
const row0: any[] = grid[0];
row0.push(6);
console.log(`grid: ${JSON.stringify(grid)} ${JSON.stringify(g)} ${g[0] === row0}`);

// --- a record holding an any[] is one island object
interface Bag {
  name: string;
  items: any[];
}
const items: any[] = [];
const bag: Bag = { name: "bag", items };
bag.items.push("p");
const asAny: any = bag;
asAny.items.push("q");
console.log(`record: ${items.length} ${bag.items.length} ${asAny === bag} ${bag.items === items}`);
function fill(target: Bag, v: string): void {
  target.items.push(v);
}
fill(asAny, "r");
console.log(`record param: ${items.join(",")}`);

// --- returns and identity round trips
function make(): any[] {
  return [1];
}
const m1 = make();
const box: any = { m1 };
const mBack: any[] = box.m1;
mBack.push(2);
console.log(`return: ${m1.length} ${mBack === m1} ${box.m1 === m1}`);

// --- for-of walks the live array; spread and Array.isArray see the island array
const live: any[] = [1, 2];
let steps = 0;
for (const v of live) {
  if (v === 1) live.push(3);
  steps++;
}
const spread: any[] = [...live, 4];
console.log(`live: ${steps} ${live.length} ${spread.length} ${Array.isArray(live)} ${spread === live}`);
console.log(live, spread);

// --- an evolving `any` array and its derived arrays
const fns = [];
fns.push(() => 1);
fns.push(() => 2);
const picked = fns.filter((f) => f() > 1);
const fnHolder: any = { fns };
fnHolder.fns.push(() => 3);
console.log(`evolving: ${fns.length} ${picked.length} ${fns.map((f) => f()).join(",")}`);

// --- typed arrays crossing: a view in, fresh values out
const nums: number[] = [3, 1, 2];
const viaAny: any = { nums };
const sortedBack: number[] = [...viaAny.nums].sort((p: number, q: number) => p - q);
const parsed: string[] = JSON.parse('["x","y"]');
parsed.push("z");
console.log(`typed: ${viaAny.nums.length} ${sortedBack.join(",")} ${parsed.join(",")} ${nums.join(",")}`);

// --- Promise.all over island values answers the island array
async function main(): Promise<void> {
  const shared: any[] = [1];
  const ps: any = { shared };
  const all = await Promise.all([Promise.resolve(ps.shared), Promise.resolve(shared)]);
  all[0].push(2);
  console.log(`promise: ${all.length} ${all[0] === all[1]} ${shared.length}`);
}
void main();
