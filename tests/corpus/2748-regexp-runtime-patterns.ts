// Patterns and flags known only when the program runs: built by
// `new RegExp(pattern, flags)` from computed strings, then used like any
// regex value — test, exec captures, replace, source and flags.

function rx(pattern: string, flags: string): RegExp {
  return new RegExp(pattern, flags);
}

// A word list compiled into patterns at run time.
const words = ["alpha", "Beta", "x.y", "a+b"];
for (const w of words) {
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = rx(`^${escaped}$`, "i");
  console.log(re.source, re.flags, re.test(w.toUpperCase()), re.test(`${w}!`));
}

// Flags chosen at run time.
const flagSets = ["", "i", "m", "s", "u", "is", "ms"];
for (const f of flagSets) {
  const re = rx("^a.b$", f);
  console.log(JSON.stringify(f), re.flags, re.test("a\nb"), re.test("A-B"));
}
for (const f of ["g", "y", "giy", "gms"]) console.log(JSON.stringify(f), rx("a", f).flags);

// Captures, alternation and quantifiers assembled from pieces.
const parts = ["\\d{4}", "\\d{2}", "\\d{2}"];
const date = rx(parts.map((p) => `(${p})`).join("-"), "");
const m = date.exec("released 2024-05-17 today");
if (m !== null) console.log(m[0], m[1], m[2], m[3]);
const units = ["px", "em", "rem"];
const size = rx(`^(\\d+(?:\\.\\d+)?)(${units.join("|")})$`, "");
for (const s of ["12px", "1.5rem", "3pt"]) {
  const mm = size.exec(s);
  console.log(s, mm === null ? "no match" : `${mm[1]} ${mm[2]}`);
}

// Case-insensitive classes and backreferences.
const cls = rx("[a-f]+\\d", "i");
console.log(cls.test("BEEF7"), cls.test("xyz7"));
const twice = rx("(\\w)\\1", "i");
console.log(twice.test("aA"), twice.test("ab"));

// Global replace with a run-time pattern.
const sep = ",";
console.log("a,b,,c".replace(rx(`${sep}+`, "g"), ";"));
console.log("Hello World".replace(rx("o", "g"), "0"));

// .source of a run-time pattern (the empty pattern, a slash in a class,
// an already-escaped slash).
for (const p of ["", "[/]", "\\/"]) {
  console.log(JSON.stringify(rx(p, "").source));
}
