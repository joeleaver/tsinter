const base = "The quick brown fox jumps over the lazy dog; 0123456789 é中😀 end.";
function show(label: string, x: string): void {
  console.log(label + " [" + x.length + "] " + JSON.stringify(x));
}
// views, views of views, all producers
let a = base.slice(4);
show("a", a);
let b = a.slice(6, 40);
show("b", b);
let c = b.substring(30, 2);
show("c", c);
show("trim", ("   " + base + "   ").slice(1).trim());
show("trimStart", ("\t\n " + base).slice(0).trimStart());
show("trimEnd", (base + " \n\t").slice(2).trimEnd());
let t = ("     padded text that is long enough     ").slice(1);
t = t.trim();
show("t", t);
// readers over views
for (let i = -1; i < 4; i++) console.log("cc", i, a.charCodeAt(i), a.charAt(i), a.charCodeAt(a.length - 1 + i));
console.log("idx", a.indexOf("fox"), a.indexOf("quick"), a.indexOf(""), a.indexOf("", 999), a.indexOf("o", 20), a.includes("lazy"), a.includes("The"));
console.log("sw", a.startsWith("quick"), a.startsWith("The"), b.startsWith(""), a.endsWith("end."), b.endsWith("jumps over the lazy dog;"), b.endsWith("x"));
// surrogate at the window edge
const emoji = "abcdefghijklmnop😀qrstuvwxyz0123456789";
let e1 = emoji.slice(17);
show("e1", e1);
console.log("e1cp", e1.charCodeAt(1), [...e1].length, e1.charCodeAt(0));
let e2 = emoji.slice(16);
console.log("e2", [...e2].length, e2.charCodeAt(0));
for (const ch of e1.slice(0, 5)) console.log("ch", ch.charCodeAt(0));
// regexes over views
let src = "  let x = 12 + foo(bar, 3);\nconst y = x * 2;\n".repeat(3);
let toks: string[] = [];
let s = src;
while (s.length > 0) {
  const m = /^(\s+|\w+|.)/.exec(s);
  if (m === null) break;
  if (m[0].trim() !== "") toks.push(m[0]);
  s = s.slice(m[0].length);
}
console.log(toks.join("|"));
const v = base.slice(10);
console.log("re", /^b/.test(v), /^T/.test(v), /\bfox\b/.test(v), JSON.stringify(/(?<=brown )fox/.exec(v)), /(?<!quick )brown/.test(v), /^brown/m.test(v));
console.log("re2", v.search(/fox/), v.search(/The/), v.match(/o/g)?.length, JSON.stringify(v.match(/(\w+) (\w+)/)));
const ve = /(\w+)\s(\w+)/.exec(v);
console.log("exec", JSON.stringify(ve));
const g = /o(\w)/g;
let mm: RegExpExecArray | null;
while ((mm = g.exec(v)) !== null) console.log("g", mm[0], mm[1], g.lastIndex);
const y = /\w+/y;
y.lastIndex = 2;
console.log("sticky", JSON.stringify(y.exec(v)), y.lastIndex);
console.log("wb", /^\w/.test(base.slice(3)), base.slice(3).search(/\b/), base.slice(4).search(/\B/));
console.log("uni", /^\udc00/.test(emoji.slice(17)), /^./u.exec(emoji.slice(17))?.[0].charCodeAt(0), /./gu.exec(emoji.slice(16))?.[0].length);
// split pieces, match pieces as views
const csv = "alpha-bravo-charlie-delta-echo,foxtrot-golf-hotel-india-juliet,kilo,lima-mike-november-oscar-papa";
const parts = csv.split(",");
for (const p of parts) show("part", p);
console.log(parts.map((p) => p.toUpperCase()).join("+"));
const rparts = csv.split(/,|-(?=k)/);
console.log(JSON.stringify(rparts));
const all = [...csv.matchAll(/(\w+)-(\w+)-(\w+)-(\w+)/g)];
console.log(all.length, all.map((r) => r[0] + "/" + r[2]).join(";"));
const gm = csv.match(/[a-z]+-[a-z]+-[a-z]+/g);
console.log(JSON.stringify(gm));
// equality, maps, sets by content
const k1 = base.slice(4, 30);
const k2 = ("xx" + base).slice(6, 32);
console.log("eq", k1 === k2, k1 < k2, k1 === "quick brown fox jumps ove", k1 === base.substring(4, 30));
const map = new Map<string, number>();
map.set(k1, 1);
console.log("map", map.get(k2), map.has(base.slice(4, 30)), map.get("quick brown fox jumps over"));
const set = new Set<string>([k1, k2, base.slice(4, 30)]);
console.log("set", set.size);
const obj: Record<string, number> = {};
obj[k1] = 5;
console.log("obj", obj[k2], JSON.stringify(obj));
// ropes of views, views of ropes
let r = base.slice(5) + base.slice(10, 30);
show("rope", r);
let rv = r.slice(3, 50);
show("rv", rv);
let acc = "";
for (let i = 0; i < 5; i++) acc += base.slice(i, i + 20);
show("acc", acc);
console.log(acc.slice(10).indexOf("brown"), acc.slice(10).charCodeAt(3));
// string methods that flatten views
show("upper", base.slice(4).toUpperCase());
show("rep", base.slice(4, 20).repeat(2));
show("pad", base.slice(4, 20).padStart(25, "*"));
show("rpl", base.slice(4).replace(/o/g, "0"));
show("rpl2", base.slice(4).replaceAll("o", "()"));
console.log("num", Number(("  12345678901234  ").slice(1)), parseInt(base.slice(45, 58)), parseFloat("x3.14159265358979".slice(1)));
console.log("json", JSON.stringify({ k: base.slice(4, 40), arr: [base.slice(1, 20), "z"] }), JSON.parse(JSON.stringify(base.slice(2, 40))));
console.log(`tmpl ${base.slice(4, 30)} ${base.slice(31)}`);
// class fields and closures holding views
class Lexer {
  src: string;
  constructor(s: string) { this.src = s; }
  next(): string {
    const m = /^\s*(\w+|.)/.exec(this.src);
    if (m === null) return "";
    this.src = this.src.slice(m[0].length);
    return m[1]!;
  }
}
const lx = new Lexer("alpha beta  gamma(delta, epsilon) + zeta_eta theta;");
const out: string[] = [];
for (let w = lx.next(); w !== ""; w = lx.next()) out.push(w);
console.log(out.join(","));
const keep = (x: string) => () => x.slice(2);
console.log(keep(base.slice(3))().slice(0, 20));
// empty, full and edge slices
console.log(JSON.stringify([base.slice(5, 5), base.slice(0), base.slice(-5), base.slice(-100, 3), base.substring(1000), base.slice(10, 5), base.slice(NaN, 15)]));
let shrink = "abcdefghijklmnopqrstuvwxyz0123456789";
let total = 0;
while (shrink.length > 0) { total += shrink.charCodeAt(0) * shrink.length; shrink = shrink.slice(1); }
console.log("shrink", total);
// views outliving their parents' bindings, under allocation pressure
function keepViews(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 40; i++) {
    const parent = ("block-" + i + "-").repeat(400);
    out.push(parent.slice(7, 40), parent.substring(100, 160).trim(), parent.split("-")[2] + "/" + parent.slice(-30));
  }
  return out;
}
const kept = keepViews();
let junk = 0;
for (let i = 0; i < 2000; i++) junk += ("garbage" + i).repeat(20).slice(3, 90).length;
let sig = 0;
for (const k of kept) sig = (sig * 31 + k.length * 7 + k.charCodeAt(k.length - 1)) % 1000003;
console.log("kept", kept.length, junk, sig, kept[5], kept[118]);
// a parameter read only through window readers (its window shadow), fed views
function scan(src: string, from: number): number {
  let k = 0;
  for (let i = from; i < src.length; i++) if (src.charCodeAt(i) === 45) k += i;
  return k + src.indexOf("-1") + (src.startsWith("block") ? 1 : 0) + src.slice(2, 30).length;
}
let rest = kept.join("|");
let acc2 = 0;
while (rest.length > 20) { acc2 += scan(rest, 3); rest = rest.slice(17); }
console.log("scan", acc2, rest);
