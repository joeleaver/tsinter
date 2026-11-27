// U8 b2: the b1 loop on an any-held array, typed number leaves
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":' + (i + 1) + ',"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";
const xs: any = JSON.parse(text);
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b, c: number = p.c, d: number = p.d; s += a + b + c + d; }
console.log(s);
