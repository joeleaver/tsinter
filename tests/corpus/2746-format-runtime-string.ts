// Board #237: console.* and util.format with a RUNTIME string first
// argument and further arguments run Node's formatWithOptions scan at run
// time on every lane — %s %d %i %f %j %o %O %c %%, unknown sequences kept,
// a specifier with no argument left as written, extra arguments appended
// (strings raw, others inspected). A lone string argument is never
// formatted; literal format strings are formatted at compile time.
import * as util from "node:util";
function j(s: string): string { return [s].join(""); }
const obj = { a: 1, b: { c: [1, 2, { d: 3 }] }, s: "x" };
const arr = [1, "two", { three: 3 }];
const m = new Map<string, number>([["k", 1]]);
const sym = Symbol("tag");
let u: string | number = 5;
if (Math.random() > 2) u = "never";
const n0 = -0;
const s = j("a%%b");
console.log(s, 1);
console.log(s);
console.log(j("x%sy%d"), "Q", 5, "extra");
console.log("lit%%", 2);
console.log(j("%o|%O|%j|%i|%f|%c|%%"), 1, 2, 3, 4, 5, "css");
console.log(util.format(j("%o|%O|%j|%i|%f|%c|%%"), 1, 2, 3, 4, 5, "css"));
console.log("%f|%f|%i", "2.5e1x", 7, "08");
console.log(j("%s|%s|%s|%s"), obj, arr, m, sym);
console.log(j("%O|%O"), obj, arr);
console.log(j("%o|%o"), 5, "s");
console.log(j("%j|%j|%j"), obj, arr, "str");
console.log(j("%d|%d|%d|%d|%d"), 42, "17", true, n0, "x");
console.log(j("%i|%i|%i|%i"), 42.9, "0x1f", "-3.7e2", false);
console.log(j("%f|%f|%f"), 1.5, "3.25abc", "nope");
console.log(j("%d %i %f"), sym, sym, sym);
console.log(j("%s %s %j %j"), null, undefined, null, undefined);
console.log(j("%d %d %i %f"), null, undefined, null, undefined);
console.log(j("no specifiers"), 1, "two", obj);
console.log(j("%s"), "only", "extra1", 2, obj);
console.log(j("%s %s %s"), "one");
console.log(j("%s %s"), "one");
console.log(j("100%"), 1);
console.log(j("%x %y %"), 1);
console.log(j("%%s %%%s"), "A");
console.log(j("%c styled %c"), "color: red", "font: x", "after");
console.log(j("é%sü%d€"), "ß", 3);
console.log(j("%s"), u);
console.log(u, 1);
console.error(j("err %s=%d"), "code", 7);
console.warn(j("warn %j"), { w: true });
console.info(j("info %s"), [1, [2, [3, [4]]]]);
console.debug(j("debug %O"), [1, [2, [3, [4]]]]);
console.log(j("%s"), -0, n0);
console.log(util.format(j("%s:%d"), "a", 1, obj));
console.log(util.formatWithOptions({}, j("%s:%i"), "b", 2.5));
console.log(util.format(j("%s")));
console.log(util.format(j("%%")));
console.log(util.format(j("%%"), 1));
const f = (): number => 1;
console.log(j("fn"), f);
function viaAny(fmt: any, a: any, b: any): void {
  console.log(fmt, a, b);
}
viaAny("%s-%d", "dyn", 9);
viaAny(42, "%s", 1);
viaAny({ k: 1 }, [2], "x");
viaAny("%j|%i|%f", { k: [1] }, "12.5px");
let count = 0;
function next(): string { count++; return `v${count}`; }
console.log(j("%s %s"), next(), next(), next());
console.log(count);
// %d / %i / %f over checked-dynamic values: Number(arg) / ToString per
// the runtime kind, as Node's formatter takes them.
function v2(fmt: any, a: any): void { console.log(fmt, a); }
const vals: any = JSON.parse('[17, "17", " 0x1f ", "", "abc", true, false, null, {}, [], [5], [1, 2], {"n": 3}, -0, "-0", "1e3"]');
for (let i = 0; i < 16; i++) v2("%d|%i|%f", vals[i]);
v2("%d", undefined);
const jo: any = JSON.parse('{"a": 1, "n": "%d"}');
console.log(j("%d|%s"), jo.n, jo);
console.log("%d|%d", jo.n, jo.zz);
function lit(a: any): void { console.log("%d|%i|%f", a, a, a); }
lit("12px");
lit([3]);
lit(null);
v2("%i|%f|%d", [null, [2, undefined], "x"]);
v2("%i", [[[" 42"]]]);
v2("%f", {});
