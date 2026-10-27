// Function replacers compile since board #301 — except where Node's
// argument positions are not known at compile time: capture/offset
// parameters over a regex whose captures the compiler cannot see, and a
// rest-parameter replacer, and one that reads `arguments`.
function swap(re: RegExp, s: string): string {
  return s.replace(re, (m: string, a: string) => a);
}
const rest = "abc".replace(/b/, (...xs: string[]) => xs[0]!);
console.log(swap(/(a)/, "a"), rest);
function counts(m: string): string { return m + arguments.length; }
console.log("ab".replace(/a/, counts));
