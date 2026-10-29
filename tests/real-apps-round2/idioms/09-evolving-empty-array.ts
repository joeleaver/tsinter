// Queue #8 (2 apps, 10 sites / 34 errors): `const xs = []` in TypeScript (an evolving any[]) is typed number[];
// pushing records/strings refuses with misleading "expected 'number'" messages at every later use.
interface Move { from: number; to: number }
const legal = [];
legal.push({ from: 1, to: 2 } as Move);
const lines = [];
lines.push("diff --git a b");
console.log(legal.length, legal[0].to, lines.join("\n"));
