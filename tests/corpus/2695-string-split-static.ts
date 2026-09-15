// The STRING-separator split, static (no island): empty pieces at the
// ends and between adjacent separators, multi-byte and multi-char
// separators, the whole-string separator, the empty separator's
// per-code-unit split, and results flowing into intrinsic array ops.
const csv = "a,b,,c,";
const parts = csv.split(",");
console.log(parts.length, JSON.stringify(parts));
console.log("aXbXc".split("X").join("-"), "aa".split("a").length);
console.log(JSON.stringify("banana".split("an")), JSON.stringify("banana".split("na")));
console.log(JSON.stringify("abc".split("abc")), JSON.stringify("abc".split("abcd")));
console.log(JSON.stringify("".split(",")), "".split(",").length);
console.log(JSON.stringify("".split("")), "".split("").length);
console.log("abc".split("").join("|"), "abc".split("").length);
// Unicode: multi-byte separators and pieces, per-unit split of BMP text.
console.log("α😀β😀γ".split("😀").join("+"), "α😀β😀γ".split("😀").length);
console.log("café société".split("é").join("<>"));
console.log("你好世界".split("").join(" "), "你好世界".split("").length);
console.log(JSON.stringify("日本語テスト".split("語")));
// Chains stay static: split → map/filter/indexOf/includes.
const words = "one two  three".split(" ");
console.log(words.length, words.indexOf("three"), words.includes("two"));
const nums = "1,2,3,4".split(",").map((s) => parseInt(s, 10) * 2);
console.log(nums.join(","));
