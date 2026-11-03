// Step 2B: string and number members a tokenizer and a CSV reader reach
// for — positions, limits, code points, parsing. (n.toString(radix) and
// new Array(n) are WasmGC-lane lowerings, pinned in
// wasm-stdlib-members.test.ts: the corpus stays static for every analysis.)

// code points: astral characters stay whole
const text = "héllo 😀 wörld";
const points: number[] = [];
for (let i = 0; i < text.length; i++) {
  const cp = text.codePointAt(i)!;
  points.push(cp);
  if (cp > 0xffff) i++;
}
console.log(points.map((p) => "U+" + String(p).padStart(6, "0")).join(" "));
console.log(String.fromCodePoint(...points) === text, String.fromCodePoint(0x1f600, 0x21).length);
for (const bad of [-1, 0x110000, 3.5]) {
  try {
    String.fromCodePoint(bad);
  } catch (e) {
    console.log((e as Error).name + ": " + (e as Error).message);
  }
}

// a header line and a limited split
const csv = "name,age,city,extra\nAda,36,London,x";
const [header, row] = csv.split("\n");
console.log(header!.split(",", 3), row!.split(",", 0), row!.split(",", -1).length);

// positions
const path = "/usr/local/lib/node_modules";
console.log(path.startsWith("local", 5), path.endsWith("/usr", 4), path.lastIndexOf("/", 10), path.lastIndexOf("l", -3));
console.log(path.substr(-12, 4), path.substr(5), "a".concat("b", "c"), "x".concat());

// parsing through Number's statics
console.log(Number.parseInt("0x1F"), Number.parseInt("777", 8), Number.parseFloat("3.25rem"), Number.parseInt("  -42abc"));
const maybe: (string | undefined)[] = ["8", undefined, " 1e3 ", "nope"];
console.log(maybe.map((m) => Number(m)));
