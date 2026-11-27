// U8 w: 4 dynamic writes per record into existing keys
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":' + (i + 1) + ',"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";
const xs: any = JSON.parse(text);
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; p.a = r; p.b = i; p.c = r + i; p.d = 1; }
let s = 0;
for (let i = 0; i < xs.length; i++) { const c: number = xs[i].c; s += c; }
console.log(s);
