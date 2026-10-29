// String.prototype.localeCompare is Node's ICU root collation (GH #87,
// SEMANTICS.md S120), not code-unit order: case is a tertiary difference
// (a < A < b < B), punctuation and spaces sort before digits before
// letters, the ASCII controls other than TAB..CR are ignorable, and the
// answer is -1, 0 or 1. ASCII only: the c and llvm lanes collate ASCII
// (S120 (b)); the WasmGC lanes' full Unicode collation is pinned by
// packages/compiler/test/wasm-collation.test.ts.
const sign = (n: number): string => (n < 0 ? "<" : n > 0 ? ">" : "=");
const show = (a: string, b: string): string => `${JSON.stringify(a)} ${sign(a.localeCompare(b))} ${JSON.stringify(b)}`;

// Case: lowercase first at the tertiary level, after the letters decide.
console.log("a".localeCompare("B"), "B".localeCompare("a"), "a".localeCompare("A"), "A".localeCompare("a"));
console.log(show("apple", "Banana"), show("Apple", "apple"), show("APPLE", "Apple"), show("aB", "Ab"));
console.log(show("zeta", "Zeta"), show("Zeta", "zetas"), show("abc", "ABD"));

// Punctuation and spaces are not ignored (non-ignorable), and come first.
console.log(show("a b", "ab"), show("a-b", "ab"), show("a_b", "a-b"), show("a.b", "a,b"));
console.log(show(" ", "!"), show("!", "0"), show("9", "a"), show("~", "a"), show("$", "%"));
console.log(show("co-op", "coop"), show("re-sign", "resign"), show("e-mail", "email"));

// Digits are digits, not numbers (no numeric option).
console.log(show("item10", "item9"), show("10", "9"), show("1.5", "1,5"), show("007", "7"));

// Controls other than TAB..CR are completely ignorable; TAB..CR are whitespace.
console.log(show("a\u0001b", "ab"), show("\u0000", ""), show("a\u007fb", "ab"));
console.log(show("a\tb", "a b"), show("a\nb", "a\tb"), show("a\rb", "a\nb"));

// Empty strings, prefixes, equality.
console.log(show("", ""), show("", "a"), show("a", ""), show("abc", "abc"), show("ab", "abc"), show("ABC", "abc"));

// The locales argument Node resolves to the root collation, and undefined.
console.log("a".localeCompare("B", undefined), "a".localeCompare("B", "en"), "a".localeCompare("B", "en-US"));
console.log("b".localeCompare("A", undefined, undefined), "A".localeCompare("a", "en-US", undefined));

// Every printable ASCII character against its neighbours in code-unit order.
let line = "";
for (let c = 32; c < 126; c++) line += sign(String.fromCharCode(c).localeCompare(String.fromCharCode(c + 1)));
console.log(line);
