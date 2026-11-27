// U8 b2any: the b2 loop with its arithmetic in the any world (a box per operator)
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":' + (i + 1) + ',"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";
const xs: any = JSON.parse(text);
let s: any = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; s = s + p.a + p.b + p.c + p.d; }
console.log(s);
