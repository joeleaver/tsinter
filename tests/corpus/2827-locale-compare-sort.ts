// sort((a, b) => a.localeCompare(b)) — the idiom the root collation exists
// for (GH #87, SEMANTICS.md S120): mixed case, punctuation, digits and
// spaces order as Node's ICU orders them, and ties keep source order
// (stable sort). ASCII only, so every lane runs it (S120 (b)).
const words = [
  "banana", "Apple", "apple", "cherry", "Banana", "APPLE", "date", "Date",
  "apple pie", "apple-pie", "applepie", "apple_pie", "Apple Pie", "a", "A",
  "item10", "item9", "item1", "Item2", "x-ray", "X-Ray", "xray", "zebra",
  "Zebra", "_private", "-dash", ".dot", "123", "45", "#tag", "@user", "",
  "co-op", "coop", "Co-op", "naive", "Naive", "NAIVE", "resume", "Resume",
];
console.log(words.slice().sort((a, b) => a.localeCompare(b)).join("|"));
console.log(words.toSorted((a, b) => b.localeCompare(a)).join("|"));

// Sorting records by a string key, ties in source order.
interface Person {
  name: string;
  id: number;
}
const people: Person[] = [
  { name: "smith", id: 1 },
  { name: "Smith", id: 2 },
  { name: "adams", id: 3 },
  { name: "smith", id: 4 },
  { name: "Adams", id: 5 },
  { name: "O'Brien", id: 6 },
  { name: "obrien", id: 7 },
  { name: "Smith", id: 8 },
];
people.sort((a, b) => a.name.localeCompare(b.name));
console.log(people.map((p) => `${p.name}#${p.id}`).join(" "));

// A two-key comparator: last name, then first name.
const names: [string, string][] = [
  ["van Dyke", "dick"], ["Van Dyke", "Dick"], ["vandyke", "d"], ["MacDonald", "Ann"],
  ["Macdonald", "ann"], ["mac donald", "Ann"], ["MacDonald", "ann"],
];
names.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
console.log(names.map(([l, f]) => `${l},${f}`).join("; "));

// A Set of distinct values, ordered.
const tags = new Set(["b", "B", "a", "A", "b", "c-d", "c d", "cd"]);
console.log([...tags].sort((x, y) => x.localeCompare(y)).join(" "));
