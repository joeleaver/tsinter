// Strings and Map: build text, split, count words, join (the design study's b2).
const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
let text = "";
for (let i = 0; i < 200_000; i++) text += words[(i * 7) % words.length] + (i % 11 === 0 ? "\n" : " ");
const counts = new Map<string, number>();
for (let round = 0; round < 5; round++) {
  for (const line of text.split("\n")) {
    for (const w of line.split(" ")) {
      if (w.length === 0) continue;
      const k = w.toUpperCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
}
const keys = [...counts.keys()].sort();
console.log(keys.join(","), keys.map((k) => counts.get(k)).join(","), text.length);
