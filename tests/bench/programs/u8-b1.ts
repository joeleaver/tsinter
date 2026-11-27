// U8 b1: typed copy of parsed records (U2b's typed arm), 4 reads per record
interface P { a: number; b: number; c: number; d: number }
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":' + (i + 1) + ',"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";
const xs = JSON.parse(text) as P[];
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]!; s += p.a + p.b + p.c + p.d; }
console.log(s);
