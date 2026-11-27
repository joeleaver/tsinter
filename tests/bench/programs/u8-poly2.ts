// U8 poly2: the b2 loop with one read site seeing 2 key orders
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push(i % 2 === 0 ? '{"a":' + i + ',"b":1,"c":2,"d":' + (i % 7) + '}' : '{"b":1,"a":' + i + ',"c":2,"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";
const xs: any = JSON.parse(text);
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b, c: number = p.c, d: number = p.d; s += a + b + c + d; }
console.log(s);
