// GH #252: a typed RegExp method over an `any` subject ToStrings it as
// Node does (undefined is "undefined", null "null", a number its digits)
// — it used to hand the matcher a string slot whose undefined was a null
// string, an unnamed trap.
const pick = (k: number): any => (process.argv.length > 99 ? "zz" : [undefined, null, 5, true, "und"][k]);
const u = pick(0);
const n = pick(1);
const five = pick(2);
const yes = pick(3);
const s = pick(4);
console.log(/a/g.test(u), /u/.test(u), /^undefined$/.test(u), /nul/.test(n), /^null$/.test(n));
console.log(/5/.test(five), /^5$/.test(five), /tr/.test(yes), /und/.test(s), /x/.test(u));
const g = /e/g;
console.log(g.test(u), g.lastIndex, g.test(u), g.lastIndex, g.test(u), g.lastIndex);
const y = /d/y;
y.lastIndex = 2;
console.log(y.test(u), y.lastIndex, y.test(u), y.lastIndex);
for (const v of [pick(0), pick(1), pick(2), pick(3), pick(4)]) console.log(/n/.test(v), /^\w+$/.test(v));
