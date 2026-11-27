// U8 w1: the w loop on a typed copy (w's typed reference)
interface P { a: number; b: number; c: number; d: number }
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":' + (i + 1) + ',"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";
const xs = JSON.parse(text) as P[];
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]!; p.a = r; p.b = i; p.c = r + i; p.d = 1; }
let s = 0;
for (let i = 0; i < xs.length; i++) { s += xs[i]!.c; }
console.log(s);
