// Board #301: a regex value's lastIndex is state on every lane — test/exec
// read and write it on a global or sticky regex, match on a global regex
// answers every match, matchAll starts at lastIndex, search and split leave
// it alone, a literal is a fresh object per evaluation; an exec/match result
// bound to a local reads .index/.input/.groups; split takes a regex held in
// a variable and a limit.
// lastIndex reads/writes and ToLength
const re = /a/g;
re.lastIndex = 2.7;
console.log(re.lastIndex, re.test("aaaa"), re.lastIndex);
re.lastIndex = -5;
console.log(re.test("aaaa"), re.lastIndex);
re.lastIndex = NaN;
console.log(re.lastIndex, re.test("aaaa"), re.lastIndex);
re.lastIndex = 99;
console.log(re.test("aaaa"), re.lastIndex);
re.lastIndex += 3;
console.log(re.lastIndex);
const nog = /a/;
nog.lastIndex = 7;
console.log(nog.test("a"), nog.lastIndex, nog.exec("ba")?.[0], nog.lastIndex);
// literal freshness
function count(s: string): number {
  const r = /x/g;
  let n = 0;
  while (r.test(s)) n++;
  return n;
}
console.log(count("xxx"), count("x"), count(""));
for (let i = 0; i < 3; i++) {
  const r = /b/y;
  console.log(i, r.test("b"), r.lastIndex);
}
console.log(/a/g.lastIndex, /a/g.test("a"), /a/y.global, /a/gimsy.flags);
const fl = /x/gimsy;
console.log(fl.global, fl.ignoreCase, fl.multiline, fl.dotAll, fl.unicode, fl.sticky, fl.hasIndices, fl.unicodeSets);
// exec loops with .index / .input / .groups
const words = /(?<w>\w+)/g;
let m: RegExpExecArray | null;
while ((m = words.exec("hi there  you")) !== null) {
  console.log(m[0], m.index, m.input.length, words.lastIndex, m.groups!.w);
}
const empt = /\b/g;
let e: RegExpExecArray | null;
const pos: number[] = [];
while ((e = empt.exec("ab cd")) !== null) {
  pos.push(e.index);
  if (e[0] === "") empt.lastIndex++;
}
console.log(pos);
const uem = /(?:)/gu;
let u: RegExpExecArray | null;
const upos: number[] = [];
while ((u = uem.exec("a😀b")) !== null) {
  upos.push(u.index);
  if (u[0] === "" && upos.length > 10) break;
}
console.log(upos);
const mm = "key=value".match(/(\w+)=(\w+)/);
if (mm) console.log(mm.index, mm.input, mm[1], mm[2]);
const sticky = /\d+/y;
const toks: string[] = [];
const src = "12 34";
sticky.lastIndex = 0;
let t: RegExpExecArray | null;
while ((t = sticky.exec(src)) !== null) { toks.push(`${t[0]}@${t.index}`); sticky.lastIndex++; }
console.log(toks, sticky.lastIndex);
// match g / search / split limit / matchAll from lastIndex
const g2 = /o/g;
g2.lastIndex = 5;
console.log("foo boo".match(g2), g2.lastIndex, "foo".search(g2), g2.lastIndex);
console.log("a,b,c,d".split(/,/, 2), "a,b,c".split(/(,)/, 4), "abc".split(/(?:)/, 0), "abc".split(/(?:)/, -1), "ab".split(/$/));
const ma = /a(\d)/g;
ma.lastIndex = 3;
console.log([..."a1 a2 a3".matchAll(ma)].map((x) => x[1]), ma.lastIndex);
for (const x of "a1 a2".matchAll(ma)) console.log(x[0], x.index);
console.log("Aaa".replace(/a/gy, "x"), "aaB".replace(/a/gy, "x"), "x".split(/x/y));
// split's two V8 paths under /u: the fast search splits inside a surrogate
// pair, the slow (spec) path — sticky, a limit or lastIndex that is not a
// non-negative Smi — does not
const SP = "\u{1F600}a\u{1F600}";
const BU = /\B/u;
console.log(SP.split(BU).length, SP.split(BU, 3).length, SP.split(BU, 2 ** 31).length, SP.split(BU, -1).length, SP.split(BU, 1.5).length);
BU.lastIndex = -1;
console.log(SP.split(BU).length, BU.lastIndex);
BU.lastIndex = 2.5;
console.log(SP.split(BU).length);
BU.lastIndex = 7;
console.log(SP.split(BU).length, SP.split(/\B/uy).length);
// optional-chain reads through the companion
const oc = /b(c)?/g;
let om: RegExpExecArray | null;
while ((om = oc.exec("abcab")) !== null) console.log(om?.index, om.input.length);
