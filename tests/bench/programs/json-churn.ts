// String/JSON churn: stringify and parse arrays of records (the design study's b4).
interface Item {
  id: number;
  name: string;
  tags: string[];
  score: number;
  ok: boolean;
}
const items: Item[] = [];
for (let i = 0; i < 2000; i++) items.push({ id: i, name: "item-" + i, tags: ["t" + (i % 7), "u" + (i % 13)], score: i * 1.25, ok: i % 3 === 0 });
let bytes = 0;
let sum = 0;
for (let round = 0; round < 60; round++) {
  const text = JSON.stringify(items);
  bytes += text.length;
  const back = JSON.parse(text) as Item[];
  for (const it of back) sum += it.score + it.tags.length;
  const it0 = items[round % items.length]!;
  it0.name = it0.name + "x";
}
console.log(bytes, sum);
