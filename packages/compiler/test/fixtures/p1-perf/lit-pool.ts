// P1 item 1: pooled string literals. Equal literals share one array; no
// path may observe or mutate that sharing.
const xs: string[] = [];
for (let i = 0; i < 4; i++) xs.push("ab");
console.log(xs[0] === xs[1], xs.join(","), xs.indexOf("ab"), xs.includes("a" + "b"));
// a literal built into new strings, never written in place
let s = "hello";
for (let i = 0; i < 3; i++) s += "!";
console.log(s, "hello", "hello".length, s.length);
const up = "mixed Case".toUpperCase();
console.log(up, "mixed Case", "mixed Case".toLowerCase(), "mixed Case");
const parts = "a,b,,c".split(",");
parts[0] = "z";
console.log(parts, "a,b,,c", "a,b,,c".split(","));
console.log("abc".replace("b", "X"), "abc", "abcabc".replaceAll("b", ""), "abcabc");
console.log("  pad ".trim(), "  pad ", "x".padStart(4, "ab"), "x", "ab".repeat(3), "ab");
console.log([..."héllo"].reverse().join(""), "héllo", "héllo".split("").sort().join(""), "héllo");
console.log("x".concat("y", "z"), "x", "xyz".slice(1), "xyz".substring(0, 2), "xyz".at(-1), "xyz");
// lone surrogates and the empty string
const lone = "a\uD800b";
console.log(lone.length, lone.charCodeAt(1), lone === "a\uD800b", lone.isWellFormed(), lone.toWellFormed() === "a�b", lone);
console.log("" === "", "".length, ["", ""].join("|"), "" + "" === "");
// a literal from many functions, compared by content
function kind(n: number): string { return n > 0 ? "pos" : n < 0 ? "neg" : "zero"; }
const ks = [1, -1, 0, 2].map(kind);
console.log(ks, ks[0] === ks[3], ks[0] === "pos", ks.filter((k) => k === "pos").length);
// literals as Map / Set keys
const m = new Map<string, number>([["k", 1]]);
m.set("k", m.get("k")! + 1);
console.log(m.get("k"), [...m.keys()], new Set(["a", "a", "b"]).size);
// a literal in a hot loop with switch on string
let score = 0;
const tags = ["coin", "spin", "hazard", "coin"];
for (let r = 0; r < 1000; r++) {
  for (const t of tags) {
    switch (t) {
      case "coin": score += 1; break;
      case "hazard": score -= 2; break;
      default: score += 0;
    }
  }
}
console.log(score);
// template strings and JSON
const name = "world";
console.log(`hello ${name}`, `hello ${name}` === "hello world", JSON.stringify({ a: "lit", b: ["lit"] }), JSON.parse('"lit"') === "lit");
// object keys and string comparison
const o: Record<string, string> = { a: "x" };
o["a"] = o["a"] + "y";
console.log(o["a"], "x", "a" < "b", "b".localeCompare("a"), ["b", "a", "c"].sort());
