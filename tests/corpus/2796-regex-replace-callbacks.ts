// Board #301: function replacers (regex and string patterns, replace and
// replaceAll — the callback gets match, captures, offset, subject and the
// named groups), callbacks that run regexes themselves (the same object
// included), and string-pattern replace/replaceAll with templates.
// function replacers
console.log("a-b-c".replace(/-(\w)/g, (_, c) => c.toUpperCase()));
console.log("border-top-width".replace(/-([a-z])/g, (m: string, ch: string) => ch.toUpperCase()));
console.log("x1y22".replace(/(\d)(\d)?/g, (m: string, a: string, b?: string) => `<${a}|${b === undefined ? "U" : b}>`));
console.log("x1y22".replace(/(\d)(\d)?/g, (m: string, a: string, b: string | undefined, off: number, s: string) => `[${m},${a},${b},${off},${s.length}]`));
console.log("2024-01-02 and 2025-12-31".replace(/(?<y>\d+)-(?<m>\d+)-(?<d>\d+)/g,
  (m: string, y: string, mo: string, d: string, off: number, s: string, g: { [k: string]: string }) => `${g.d}/${g.m}/${g.y}@${off}`));
console.log("aaa".replace(/a/g, () => "b"));
console.log("hello".replace(/l/, (m) => m + m));
console.log("a.b.c".replaceAll(".", (m: string, off: number) => `(${off})`));
console.log("a.b.c".replace(".", (m, off, s) => `[${m}${off}${s}]`));
console.log("xyz".replace(/q/g, () => "Z"));
console.log("".replace(/(?:)/g, () => "E"));
console.log("ab".replace(/(?:)/g, (m: string, off: number) => `${off}`));
console.log("ab".replaceAll("", (m: string, off: number) => `${off}`));
// re-entrancy: the callback runs regexes itself, the same object included
const inner = /(\w)(\w)/g;
const outer = /\w+/g;
console.log("ab cd ef".replace(outer, (w: string) => {
  const t = w.replace(inner, (_x: string, p: string, q: string) => q + p);
  return `${t}:${outer.lastIndex}:${inner.lastIndex}:${outer.test("zz")}:${outer.lastIndex}`;
}), outer.lastIndex);
const same = /o/g;
console.log("foo boo".replace(same, (m: string, off: number) => `${off}${same.test("o")}${same.lastIndex}`), same.lastIndex);
// string patterns with templates
console.log("a.b.c".replace(".", "$&$&"), "a.b.c".replaceAll(".", "[$`|$']"), "x".replace("x", "$$1$1$<n>"));
console.log("ab".replaceAll("", "-"), "abc".replace("", "-"), "aaa".replaceAll("aa", "b"), "😀x😀".replaceAll("😀", "y"));
const pat: string = "o";
console.log("foo".replaceAll(pat, "0"), "foo".replace(pat, "0"), "foo".replaceAll(pat.repeat(2), (m: string) => m.toUpperCase()));
// unannotated captures: undefined where the group can fail to take part,
// a string where it always does; a parameter past the arguments; groups
// typed with undefined values
console.log("ab".replace(/(a)(z)?/, (m, a, b) => b ?? "dflt"));
console.log("ab".replace(/(a)(z)?/, (m, a, b) => `${a}|${b}`));
console.log("ab".replace(/(a)|(b)/g, (m, x, y) => `[${x}/${y}]`));
console.log("xay".replace(/(?:(a)|(b))+/, (m, p, q) => `${p},${q}`));
console.log("ab".replace(/(a)/, (m, a, off, s, extra) => `${extra}|${a.length}`));
console.log("2024-01".replace(/(?<y>\d+)-(?<m>\d+)(?<d>-\d+)?/,
  (m: string, y: string, mo: string, d: string | undefined, off: number, s: string, g: { [k: string]: string | undefined }) => `${g.y}/${g.m}/${g.d}/${d}`));
