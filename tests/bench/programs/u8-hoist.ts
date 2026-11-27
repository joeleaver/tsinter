// U8 hoist: xs[i] on an any-held array with the bound hoisted (U8a's index cost)
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + '}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");
const n: number = xs.length;
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < n; i++) { const p = xs[i]; if (p === null) s++; }
console.log(s);
